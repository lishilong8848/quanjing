import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { validRequestedPermissions, type PersonnelPermissionRequest } from '../../../shared/personnel-permission-request.interface';
import { createProcessLockOwner, normalizeProcessLockOwner, processLockOwnerMayBeAlive } from '../process-lock-owner';

export interface StoredPermissionRequest extends PersonnelPermissionRequest { applicantIdentity: string; }
export interface PermissionRequestAudit { requestId: string; actorId: string; action: 'create' | 'approve' | 'reject'; at: string; version: number; }
export interface PermissionRequestsState {
  schemaVersion: 1;
  revision: number;
  requests: Record<string, StoredPermissionRequest>;
  mutations: Record<string, { fingerprint: string; requestId: string }>;
  audit: PermissionRequestAudit[];
}
const EMPTY = (): PermissionRequestsState => ({ schemaVersion: 1, revision: 0, requests: {}, mutations: {}, audit: [] });
const stores = new Map<string, PersonnelPermissionRequestsStore>();
export function getPersonnelPermissionRequestsStore(): PersonnelPermissionRequestsStore {
  const configured = process.env.ACCESS_CONFIGURATION_FILE || join(process.cwd(), '.runtime', 'access-configuration.json');
  const path = process.env.PERSONNEL_PERMISSION_REQUESTS_FILE || join(dirname(configured), 'personnel-permission-requests.json');
  if (!isAbsolute(path)) throw new ServiceUnavailableException('权限申请台账路径必须为绝对路径');
  const normalized = resolve(path);
  if (normalized.toLowerCase() === resolve(configured).toLowerCase()) throw new ServiceUnavailableException('权限申请台账不能覆盖权限配置');
  let store = stores.get(normalized);
  if (!store) { store = new PersonnelPermissionRequestsStore(normalized); stores.set(normalized, store); }
  return store;
}

export class PersonnelPermissionRequestsStore {
  private queue: Promise<unknown> = Promise.resolve();
  private persisted = false;
  constructor(readonly filePath: string) {}

  read(): PermissionRequestsState {
    try {
      assertOrdinaryPath(this.filePath);
      if (!existsSync(this.filePath)) { if (this.persisted) throw new Error('missing'); return EMPTY(); }
      this.persisted = true;
      const stats = lstatSync(this.filePath);
      if (!stats.isFile() || stats.size > 8 * 1024 * 1024) throw new Error('size');
      const state: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!validState(state)) throw new Error('schema');
      return state;
    } catch { throw new ServiceUnavailableException('权限申请台账无效，已保留原文件，请联系管理员'); }
  }

  async mutate(change: (state: PermissionRequestsState) => StoredPermissionRequest): Promise<StoredPermissionRequest> {
    const operation = this.queue.then(() => {
      assertOrdinaryPath(this.filePath);
      mkdirSync(dirname(this.filePath), { recursive: true });
      const lockPath = `${this.filePath}.lock`;
      assertOrdinaryPath(lockPath);
      const owner = createProcessLockOwner(randomUUID());
      const lock = acquireLock(lockPath);
      const temp = `${this.filePath}.${owner.token}.tmp`;
      try {
        writeFileSync(lock, JSON.stringify(owner));
        const state = this.read();
        const before = JSON.stringify(state);
        const result = change(state);
        if (JSON.stringify(state) === before) return structuredClone(result);
        state.revision += 1;
        if (!validState(state)) throw new ServiceUnavailableException('权限申请校验失败，未保存');
        const bytes = Buffer.from(JSON.stringify(state));
        if (bytes.length > 8 * 1024 * 1024) throw new ServiceUnavailableException('权限申请台账容量已满，请联系管理员');
        assertOrdinaryPath(this.filePath);
        const fd = openSync(temp, 'wx', 0o600);
        try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temp, this.filePath);
        this.persisted = true;
        return structuredClone(result);
      } finally {
        if (existsSync(temp)) unlinkSync(temp);
        closeSync(lock);
        if (readLock(lockPath)?.token === owner.token) unlinkSync(lockPath);
      }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}

function acquireLock(path: string): number {
  try { return openSync(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = readLock(path);
    if (!owner || processLockOwnerMayBeAlive(owner, lstatSync(path).mtimeMs)) throw new ConflictException('权限申请正在保存，请稍后重试');
    const recovery = `${path}.recovery`;
    assertOrdinaryPath(recovery);
    let guard: number;
    try { guard = openSync(recovery, 'wx', 0o600); } catch { throw new ConflictException('权限申请台账锁正在恢复，请稍后重试'); }
    try {
      const current = readLock(path);
      if (!current || current.token !== owner.token || processLockOwnerMayBeAlive(current, lstatSync(path).mtimeMs)) throw new ConflictException('权限申请正在保存，请稍后重试');
      unlinkSync(path);
      return openSync(path, 'wx', 0o600);
    } finally { closeSync(guard); unlinkSync(recovery); }
  }
}
function readLock(path: string) {
  try { return normalizeProcessLockOwner(JSON.parse(readFileSync(path, 'utf8'))); } catch { return null; }
}
function assertOrdinaryPath(path: string): void {
  if (!isAbsolute(path) || path.slice(parse(path).root.length).includes(':')) throw new ServiceUnavailableException('权限申请台账路径无效');
  let cursor = resolve(path);
  const root = parse(cursor).root;
  while (cursor !== root) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new ServiceUnavailableException('权限申请台账路径不能包含链接');
    cursor = dirname(cursor);
  }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, max = 256): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value); }
function prose(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 500 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value); }
function timestamp(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)); }
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function validRequest(value: unknown): value is StoredPermissionRequest {
  if (!record(value) || !keys(value, ['id','version','accountId','applicantIdentity','applicantName','permissions','reason','status','createdAt','updatedAt','reviewerAccountId','reviewerName','comment','verifiedConfigurationRevision']) ||
    !text(value.id, 128) || !text(value.accountId) || !text(value.applicantIdentity, 512) || !text(value.applicantName, 100) ||
    !prose(value.reason) || !validRequestedPermissions(value.permissions) || !timestamp(value.createdAt) || !timestamp(value.updatedAt)) return false;
  if (value.status === 'pending') return value.version === 1 && value.reviewerAccountId === undefined && value.reviewerName === undefined && value.comment === undefined && value.verifiedConfigurationRevision === undefined;
  if (!['approved','rejected'].includes(String(value.status)) || value.version !== 2 || !text(value.reviewerAccountId) || !text(value.reviewerName, 100) ||
    (value.comment !== undefined && !prose(value.comment))) return false;
  return value.status === 'approved' ? Number.isSafeInteger(value.verifiedConfigurationRevision) && Number(value.verifiedConfigurationRevision) >= 0 : value.verifiedConfigurationRevision === undefined && prose(value.comment);
}
function validState(value: unknown): value is PermissionRequestsState {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'audit,mutations,requests,revision,schemaVersion' || value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !record(value.requests) || !record(value.mutations) || !Array.isArray(value.audit) ||
    Object.keys(value.requests).length > 10000 || Object.keys(value.mutations).length > 30000 || value.audit.length > 20000) return false;
  const requests = value.requests;
  return Object.entries(requests).every(([id, row]) => validRequest(row) && row.id === id) &&
    Object.entries(value.mutations).every(([id, item]) => /^[a-f0-9]{64}$/u.test(id) && record(item) && Object.keys(item).sort().join(',') === 'fingerprint,requestId' &&
      typeof item.fingerprint === 'string' && /^[a-f0-9]{64}$/u.test(item.fingerprint) && typeof item.requestId === 'string' && Object.hasOwn(requests, item.requestId)) &&
    value.audit.every(item => record(item) && Object.keys(item).sort().join(',') === 'action,actorId,at,requestId,version' && text(item.actorId) && timestamp(item.at) &&
      typeof item.requestId === 'string' && Object.hasOwn(requests, item.requestId) && ['create','approve','reject'].includes(String(item.action)) && (item.version === 1 || item.version === 2));
}
