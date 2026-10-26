import { validRolePageRules, type RolePageRules } from '../../../shared/page-access';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { CardRoleRule, ConfigurationAudit, ManagedAccount, PersonnelSyncStatus } from '../../../shared/access-configuration.interface';
import { createProcessLockOwner, normalizeProcessLockOwner, processLockOwnerMayBeAlive } from '../process-lock-owner';
import { ID_PATTERN, ruleKey, validAccount, validCardRule } from './access-configuration.validation';
import { validAccessPasswordHash } from './access-password';
import { validPersonnelPermissionArchives } from './personnel-permission-archive';
import type { PersonnelPermissionArchive } from '../../../shared/personnel-handover.interface';
import type { PersonnelDutyAssignment } from '../../../shared/personnel-duty-routing';
import { validPersonnelDutyAssignments } from './personnel-duty-routing';
import { validPersonnelSource } from './personnel-source.policy';
import type { PersonnelSourceState } from '../../../shared/personnel-source.interface';
import type { PersonnelBaselineState } from '../../../shared/personnel-baseline.interface';
import { validPersonnelBaselines } from './personnel-baseline.policy';
import { samePersonnelRoute } from './personnel-source.policy';

export interface StoredAccount extends ManagedAccount { passwordHash?: string; personnelSuspended?: boolean; }
export interface PersonnelEmploymentState { appId: string; snapshotAt: number; inactive: Record<string, boolean>; }
export interface ConfigurationState {
  personnelBaseline?: PersonnelBaselineState;
  personnelSource?: PersonnelSourceState;
  personnelDutyAssignments?: Record<string, PersonnelDutyAssignment>;
  schemaVersion: 1;
  revision: number;
  legacySessionsRevoked: boolean;
  accounts: Record<string, StoredAccount>;
  cardRules: Record<string, CardRoleRule>;
  audit: ConfigurationAudit[];
  mutations: Record<string, { fingerprint: string; revision: number }>;
  personnelSync?: PersonnelSyncStatus;
  rolePageRules?: RolePageRules;
  professionalDefaultsAppId?: string;
  personnelPermissionArchives?: Record<string, PersonnelPermissionArchive>;
  personnelEmployment?: PersonnelEmploymentState;
}
const empty = (): ConfigurationState => ({ schemaVersion: 1, revision: 0, legacySessionsRevoked: false, accounts: {}, cardRules: {}, audit: [], mutations: {} });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const stores = new Map<string, AccessConfigurationStore>();
export function getAccessConfigurationStore(): AccessConfigurationStore {
  const file = process.env.ACCESS_CONFIGURATION_FILE || join(process.cwd(), '.runtime', 'access-configuration.json');
  if (!isAbsolute(file)) throw new ServiceUnavailableException('权限配置路径必须为绝对路径');
  const path = resolve(file);
  let store = stores.get(path);
  if (!store) { store = new AccessConfigurationStore(path); stores.set(path, store); }
  return store;
}
export class AccessConfigurationStore {
  private cache: { digest: string; state: ConfigurationState } | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private persisted = false;
  constructor(readonly filePath: string) {}

  read(): ConfigurationState {
    try {
      assertOrdinaryPath(this.filePath);
      if (!existsSync(this.filePath)) { if (this.persisted) throw new Error('missing'); return empty(); }
      this.persisted = true;
      const stats = lstatSync(this.filePath);
      if (!stats.isFile() || stats.size > 8 * 1024 * 1024) throw new Error('file');
      const bytes = readFileSync(this.filePath);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (this.cache?.digest === digest) return clone(this.cache.state);
      const state: unknown = JSON.parse(bytes.toString('utf8'));
      if (!validState(state)) throw new Error('schema');
      this.cache = { digest, state };
      return clone(state);
    } catch { throw new ServiceUnavailableException('权限配置文件无效，已停止使用配置授权，请联系管理员'); }
  }

  async mutate(expected: number, mutationId: string, fingerprint: string, change: (state: ConfigurationState) => void | Promise<void>): Promise<ConfigurationState> {
    const operation = this.queue.then(async () => {
      assertOrdinaryPath(this.filePath);
      mkdirSync(dirname(this.filePath), { recursive: true });
      const lockPath = this.filePath + '.lock';
      assertOrdinaryPath(lockPath);
      const owner = createProcessLockOwner(randomUUID());
      let lock: number;
      try { lock = openSync(lockPath, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const current = readLockOwner(lockPath);
        if (!current || processLockOwnerMayBeAlive(current, lstatSync(lockPath).mtimeMs)) throw new ConflictException('配置正在保存，请稍后重试');
        // A recovery guard prevents two writers from taking over a dead owner's lock.
        const recovery = lockPath + '.recovery';
        assertOrdinaryPath(recovery);
        let guard: number;
        try { guard = openSync(recovery, 'wx', 0o600); } catch { throw new ConflictException('配置锁正在恢复，请稍后重试'); }
        try {
          const again = readLockOwner(lockPath);
          if (!again || again.token !== current.token || processLockOwnerMayBeAlive(again, lstatSync(lockPath).mtimeMs)) throw new ConflictException('配置正在保存，请稍后重试');
          unlinkSync(lockPath);
          lock = openSync(lockPath, 'wx', 0o600);
        } finally { closeSync(guard); unlinkSync(recovery); }
      }
      const temp = `${this.filePath}.${owner.token}.tmp`;
      try {
        writeFileSync(lock, JSON.stringify(owner));
        const state = this.read();
        const previous = state.mutations[mutationId];
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new ConflictException('重复请求内容不一致，请重新提交');
          return state;
        }
        if (expected !== state.revision) throw new ConflictException('配置已更新，请刷新当前记录后重试，草稿已保留');
        await change(state);
        state.revision += 1;
        state.mutations[mutationId] = { fingerprint, revision: state.revision };
        state.audit = state.audit.slice(-500);
        if (!validState(state)) throw new ServiceUnavailableException('权限配置校验失败，未保存');
        const encoded = Buffer.from(JSON.stringify(state));
        if (encoded.length > 8 * 1024 * 1024) throw new ServiceUnavailableException('权限配置容量已满，未保存，请联系管理员');
        assertOrdinaryPath(this.filePath);
        const fd = openSync(temp, 'wx', 0o600);
        try { writeFileSync(fd, encoded); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temp, this.filePath);
        this.persisted = true;
        this.cache = undefined;
        return clone(state);
      } finally {
        if (existsSync(temp)) unlinkSync(temp);
        closeSync(lock);
        const current = readLockOwner(lockPath);
        if (current?.token === owner.token || lstatSync(lockPath).size === 0) unlinkSync(lockPath);
      }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validState(value: unknown): value is ConfigurationState {
  if (record(value) && value.personnelBaseline !== undefined && !validPersonnelBaselines(value.personnelBaseline)) return false;
  if (record(value) && value.personnelSource !== undefined && !validPersonnelSource(value.personnelSource)) return false;
  if (record(value) && value.personnelDutyAssignments !== undefined && (!validPersonnelDutyAssignments(value.personnelDutyAssignments) || Object.values(value.personnelDutyAssignments).some(rule=>!!rule.baselineConfirmationId))) return false;
  if (record(value) && value.personnelSource !== undefined) {
    const source=value.personnelSource as PersonnelSourceState, baseline=value.personnelBaseline as PersonnelBaselineState | undefined;
    for(const route of Object.values(source.routes))if(route.baselineConfirmationId){
      const proof=baseline?.confirmations[route.baselineConfirmationId], row=proof?.rows[route.dutyRecordId];
      if(!proof||!row||(['appId','appToken','tableId','dutyTableId','kind'] as const).some(key=>proof.source[key]!==source.source[key])||!samePersonnelRoute(route,{...row,baselineConfirmationId:proof.id}))return false;
    }
  }
  if (record(value) && value.personnelEmployment !== undefined) {
    const status=value.personnelEmployment;
    if (!record(status) || Object.keys(status).some(key=>!['appId','snapshotAt','inactive'].includes(key)) || typeof status.appId !== 'string' || !/^cli_[A-Za-z0-9_-]+$/u.test(status.appId) ||
      !Number.isSafeInteger(status.snapshotAt) || Number(status.snapshotAt) < 0 || !record(status.inactive) || Object.keys(status.inactive).length > 20_000 ||
      !Object.entries(status.inactive).every(([id,flag])=>/^(?:feishu|local-external)-[a-f0-9]{64}$/u.test(id) && typeof flag === 'boolean')) return false;
  }
  if (record(value) && value.personnelPermissionArchives !== undefined && (!validPersonnelPermissionArchives(value.personnelPermissionArchives) ||
    Object.values(value.personnelPermissionArchives).some(archive=>archive.configurationRevision > Number(value.revision)))) return false;
  if (record(value) && value.rolePageRules !== undefined && !validRolePageRules(value.rolePageRules)) return false;
  if (record(value) && value.professionalDefaultsAppId !== undefined && typeof value.professionalDefaultsAppId !== 'string') return false;
  if (record(value) && value.personnelSync !== undefined) {
    const status = value.personnelSync;
    if (!record(status) || !['idle','syncing','success','error'].includes(String(status.status)) ||
      ['lastAttemptAt','lastSuccessAt','error','warning'].some(key => status[key] !== undefined && typeof status[key] !== 'string') ||
      (status.changed !== undefined && (!Number.isSafeInteger(status.changed) || Number(status.changed) < 0)) ||
      (status.attempts !== undefined && (!Number.isSafeInteger(status.attempts) || Number(status.attempts) < 1 || Number(status.attempts) > 3)) ||
      (status.attemptDay !== undefined && (typeof status.attemptDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(status.attemptDay))) ||
      ((status.attemptDay === undefined) !== (status.attempts === undefined)) ||
      (status.nextAttemptAt !== undefined && (typeof status.nextAttemptAt !== 'string' || !Number.isFinite(Date.parse(status.nextAttemptAt))))) return false;
  }
  if (!record(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || typeof value.legacySessionsRevoked !== 'boolean' ||
    !record(value.accounts) || !record(value.cardRules) || !record(value.mutations) || !Array.isArray(value.audit) || value.audit.length > 500) return false;
  if (!Object.entries(value.accounts).every(([id, account]) => record(account) && account.id === id && validAccount(account as unknown as ManagedAccount) &&
    (account.personnelSuspended === undefined || (typeof account.personnelSuspended === 'boolean' && (!account.personnelSuspended || account.enabled === false))) &&
    (account.passwordHash === undefined || (account.kind === 'local' && validAccessPasswordHash(account.passwordHash))))) return false;
  if (!Object.entries(value.cardRules).every(([key, rule]) => record(rule) && validCardRule(rule as unknown as CardRoleRule) && key === ruleKey(String(rule.code), rule.building as string | null))) return false;
  return Object.entries(value.mutations).every(([id, item]) => ID_PATTERN.test(id) && record(item) && typeof item.fingerprint === 'string' && Number.isSafeInteger(item.revision) && Number(item.revision) > 0 && Number(item.revision) <= Number(value.revision)) &&
    value.audit.every(item => record(item) && ['id','at','actorId','actorName','target','action','before','after'].every(key => typeof item[key] === 'string'));
}
function readLockOwner(file: string) {
  try { return normalizeProcessLockOwner(JSON.parse(readFileSync(file, 'utf8'))); }
  catch { return null; }
}
function assertOrdinaryPath(file: string): void {
  if (!isAbsolute(file) || file.slice(parse(file).root.length).includes(':')) throw new ServiceUnavailableException('权限配置路径无效');
  let current = resolve(file);
  for (;;) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new ServiceUnavailableException('权限配置路径不能使用链接');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
