import { ConflictException, Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createProcessLockOwner, normalizeProcessLockOwner, processLockOwnerMayBeAlive } from '../process-lock-owner';
import { parsePersonnelPasswordHash } from './personnel-password';

export const PERSONNEL_SECURITY_FILE = 'PERSONNEL_SECURITY_FILE';
export interface PersonnelPasswordIntent {
  accountId: string;
  mutationId: string;
  kind: 'change' | 'reset';
  requestFingerprint: string;
  expectedLocalHashFingerprint: string;
  previousSourceFingerprint: string;
  newHash: string;
  status: 'prepared' | 'written' | 'completed' | 'conflict';
  createdAt: number;
}
export interface PersonnelSecurityState {
  version: 1;
  revision: number;
  accounts: Record<string, { requiresPasswordChange: boolean; updatedAt: number }>;
  intents: Record<string, PersonnelPasswordIntent>;
}
export const personnelFingerprint = (value: string): string => createHash('sha256').update(value).digest('hex');
const empty = (): PersonnelSecurityState => ({ version: 1, revision: 0, accounts: {}, intents: {} });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const accountId = (value: unknown): value is string => typeof value === 'string' && /^local-external-[a-f0-9]{64}$/.test(value);
const mutationId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Separate from authorization configuration: corruption fails closed and never drops security state. */
@Injectable()
export class PersonnelSecurityStore {
  readonly filePath: string;
  private persisted = false;
  private cache?: { digest: string; state: PersonnelSecurityState };
  private queues = new Map<string, Promise<unknown>>();

  constructor(@Optional() @Inject(PERSONNEL_SECURITY_FILE) filePath?: string) {
    const configuration = process.env.ACCESS_CONFIGURATION_FILE || join(process.cwd(), '.runtime', 'access-configuration.json');
    const selected = filePath || process.env.PERSONNEL_SECURITY_FILE || join(dirname(configuration), 'personnel-security.json');
    if (!isAbsolute(selected)) throw unavailable();
    this.filePath = resolve(selected);
  }

  read(): PersonnelSecurityState {
    try {
      ordinaryPath(this.filePath);
      if (!existsSync(this.filePath)) {
        if (this.persisted) throw new Error('missing');
        return empty();
      }
      this.persisted = true;
      const stat = lstatSync(this.filePath);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('file');
      const bytes = readFileSync(this.filePath), hash = personnelFingerprint(bytes.toString('utf8'));
      if (this.cache?.digest === hash) return clone(this.cache.state);
      const state: unknown = JSON.parse(bytes.toString('utf8'));
      if (!validState(state)) throw new Error('schema');
      this.cache = { digest: hash, state };
      return clone(state);
    } catch { throw unavailable(); }
  }

  update(change: (state: PersonnelSecurityState) => void): void {
    ordinaryPath(this.filePath);
    mkdirSync(dirname(this.filePath), { recursive: true });
    const release = acquireLock(this.filePath + '.lock');
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      const state = this.read();
      change(state);
      state.revision++;
      if (!validState(state)) throw unavailable();
      const encoded = Buffer.from(JSON.stringify(state));
      if (encoded.length > 16 * 1024 * 1024) throw new ServiceUnavailableException('密码安全记录容量已满，请联系管理员，现有记录已保留');
      const handle = openSync(temp, 'wx', 0o600);
      try { writeFileSync(handle, encoded); fsyncSync(handle); } finally { closeSync(handle); }
      renameSync(temp, this.filePath);
      this.persisted = true;
      this.cache = undefined;
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
      release();
    }
  }

  async withAccountLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (!accountId(id)) throw unavailable();
    const previous = this.queues.get(id) || Promise.resolve();
    const result = previous.catch(() => undefined).then(async () => {
      ordinaryPath(this.filePath);
      mkdirSync(dirname(this.filePath), { recursive: true });
      const release = acquireLock(`${this.filePath}.account-${personnelFingerprint(id)}.lock`);
      try { return await work(); } finally { release(); }
    });
    this.queues.set(id, result);
    try { return await result; } finally { if (this.queues.get(id) === result) this.queues.delete(id); }
  }
}

function validState(value: unknown): value is PersonnelSecurityState {
  if (!plain(value) || !exactKeys(value, ['version', 'revision', 'accounts', 'intents']) || value.version !== 1 ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !plain(value.accounts) || !plain(value.intents)) return false;
  return Object.entries(value.accounts).every(([id, item]) => accountId(id) && plain(item) && exactKeys(item, ['requiresPasswordChange', 'updatedAt']) &&
    typeof item.requiresPasswordChange === 'boolean' && Number.isSafeInteger(item.updatedAt) && Number(item.updatedAt) > 0) &&
    Object.entries(value.intents).every(([key, item]) => digest(key) && plain(item) && exactKeys(item, [
      'accountId', 'mutationId', 'kind', 'requestFingerprint', 'expectedLocalHashFingerprint', 'previousSourceFingerprint', 'newHash', 'status', 'createdAt',
    ]) && accountId(item.accountId) && mutationId(item.mutationId) && ['change', 'reset'].includes(String(item.kind)) &&
      digest(item.requestFingerprint) && digest(item.expectedLocalHashFingerprint) && digest(item.previousSourceFingerprint) &&
      parsePersonnelPasswordHash(item.newHash) !== null && ['prepared', 'written', 'completed', 'conflict'].includes(String(item.status)) &&
      Number.isSafeInteger(item.createdAt) && Number(item.createdAt) > 0 && key === personnelFingerprint(`${item.accountId}\0${item.mutationId}`));
}
function ordinaryPath(path: string): void {
  let current = resolve(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw unavailable();
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function acquireLock(path: string): () => void {
  ordinaryPath(path);
  const owner = createProcessLockOwner(randomUUID());
  let handle: number;
  try { handle = openSync(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable();
    let current;
    try { current = normalizeProcessLockOwner(JSON.parse(readFileSync(path, 'utf8'))); } catch { throw unavailable(); }
    if (!current || processLockOwnerMayBeAlive(current, lstatSync(path).mtimeMs)) throw new ConflictException('密码正在处理，请稍后使用原请求重试');
    const recoveryPath = path + '.recovery';
    ordinaryPath(recoveryPath);
    let recovery: number;
    try { recovery = openSync(recoveryPath, 'wx', 0o600); } catch { throw new ConflictException('密码安全状态正在恢复，请稍后重试'); }
    try {
      const again = normalizeProcessLockOwner(JSON.parse(readFileSync(path, 'utf8')));
      if (!again || again.token !== current.token || processLockOwnerMayBeAlive(again, lstatSync(path).mtimeMs)) throw unavailable();
      unlinkSync(path);
      handle = openSync(path, 'wx', 0o600);
    } finally { closeSync(recovery); unlinkSync(recoveryPath); }
  }
  try { writeFileSync(handle, JSON.stringify(owner)); fsyncSync(handle); }
  catch { closeSync(handle); unlinkSync(path); throw unavailable(); }
  return () => { closeSync(handle); unlinkSync(path); };
}
function unavailable() { return new ServiceUnavailableException('密码安全状态暂不可用，请联系管理员'); }
