import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { PERSONNEL_ARCHIVE_CORRECTION_FIELDS, type PersonnelArchiveCorrection } from '../../../shared/personnel-archive-correction.interface';
import type { PersonnelRequestCapacity } from '../../../shared/personnel-permission-request.interface';
import { createProcessLockOwner, normalizeProcessLockOwner, processLockOwnerMayBeAlive } from '../process-lock-owner';

export interface StoredArchiveCorrection extends PersonnelArchiveCorrection { applicantIdentity: string; }
export interface ArchiveCorrectionsState {
  schemaVersion: 1; revision: number;
  requests: Record<string, StoredArchiveCorrection>;
  mutations: Record<string, { fingerprint: string; requestId: string }>;
  audit: { requestId: string; actorId: string; action: 'create' | 'cancel' | 'resolve' | 'reject'; at: string; version: number }[];
}
const empty = (): ArchiveCorrectionsState => ({ schemaVersion: 1, revision: 0, requests: {}, mutations: {}, audit: [] });
const stores = new Map<string, PersonnelArchiveCorrectionsStore>();
export function getPersonnelArchiveCorrectionsStore(): PersonnelArchiveCorrectionsStore {
  const configuration = process.env.ACCESS_CONFIGURATION_FILE || join(process.cwd(), '.runtime', 'access-configuration.json');
  const selected = process.env.PERSONNEL_ARCHIVE_CORRECTIONS_FILE || join(dirname(configuration), 'personnel-archive-corrections.json');
  if (!isAbsolute(selected)) throw unavailable();
  const path = resolve(selected);
  const protectedPaths = [configuration, process.env.PERSONNEL_SECURITY_FILE || join(dirname(configuration), 'personnel-security.json'),
    process.env.PERSONNEL_PERMISSION_REQUESTS_FILE || join(dirname(configuration), 'personnel-permission-requests.json')];
  if (protectedPaths.some(value => resolve(value).toLowerCase() === path.toLowerCase())) throw unavailable();
  let store = stores.get(path);
  if (!store) { store = new PersonnelArchiveCorrectionsStore(path); stores.set(path, store); }
  return store;
}

/** Feedback only; deliberately independent of authorization, credentials and personnel source writes. */
export class PersonnelArchiveCorrectionsStore {
  private queue: Promise<unknown> = Promise.resolve();
  private persisted = false;
  constructor(readonly filePath: string) {}
  read(): ArchiveCorrectionsState {
    try {
      ordinary(this.filePath);
      if (!existsSync(this.filePath)) { if (this.persisted) throw new Error('missing'); return empty(); }
      this.persisted = true;
      const stat = lstatSync(this.filePath);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('size');
      const state: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!validState(state)) throw new Error('schema');
      return state;
    } catch { throw unavailable(); }
  }
  capacity(state = this.read()): PersonnelRequestCapacity {
    const value = { level: 'normal' as PersonnelRequestCapacity['level'], bytes: Buffer.byteLength(JSON.stringify(state)), maxBytes: 8 * 1024 * 1024,
      requests: Object.keys(state.requests).length, maxRequests: 10000, mutations: Object.keys(state.mutations).length, maxMutations: 30000,
      auditEntries: state.audit.length, maxAuditEntries: 20000 };
    const ratio = Math.max(value.bytes/value.maxBytes, value.requests/value.maxRequests, value.mutations/value.maxMutations, value.auditEntries/value.maxAuditEntries);
    value.level = ratio >= 1 ? 'full' : ratio >= .8 ? 'warning' : 'normal'; return value;
  }
  async mutate(change: (state: ArchiveCorrectionsState) => StoredArchiveCorrection): Promise<StoredArchiveCorrection> {
    const operation = this.queue.then(() => {
      ordinary(this.filePath); mkdirSync(dirname(this.filePath), { recursive: true });
      const release = acquire(`${this.filePath}.lock`), temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        const state = this.read(), before = JSON.stringify(state), result = change(state);
        if (JSON.stringify(state) === before) return structuredClone(result);
        state.revision++;
        if (!validState(state)) throw unavailable();
        const bytes = Buffer.from(JSON.stringify(state));
        if (bytes.length > 8 * 1024 * 1024) throw new ServiceUnavailableException('资料纠错台账容量已满，请联系管理员，原记录已保留');
        ordinary(this.filePath);
        const fd = openSync(temporary, 'wx', 0o600);
        try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temporary, this.filePath); this.persisted = true;
        return structuredClone(result);
      } finally { if (existsSync(temporary)) unlinkSync(temporary); release(); }
    });
    this.queue = operation.catch(() => undefined); return operation;
  }
}
function ordinary(path: string): void {
  if (!isAbsolute(path) || path.slice(parse(path).root.length).includes(':')) throw unavailable();
  let cursor = resolve(path);
  while (true) { if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw unavailable(); const parent = dirname(cursor); if (parent === cursor) return; cursor = parent; }
}
function owner(path: string) { try { return normalizeProcessLockOwner(JSON.parse(readFileSync(path, 'utf8'))); } catch { return null; } }
function acquire(path: string): () => void {
  ordinary(path); const currentOwner = createProcessLockOwner(randomUUID()); let fd: number;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable();
    const previous = owner(path);
    if (!previous || processLockOwnerMayBeAlive(previous, lstatSync(path).mtimeMs)) throw new ConflictException('资料纠错正在保存，请保留原请求重试');
    const recovery = `${path}.recovery`; ordinary(recovery); let guard: number;
    try { guard = openSync(recovery, 'wx', 0o600); } catch { throw new ConflictException('资料纠错台账正在恢复，请稍后重试'); }
    try {
      const latest = owner(path);
      if (!latest || latest.token !== previous.token || processLockOwnerMayBeAlive(latest, lstatSync(path).mtimeMs)) throw unavailable();
      unlinkSync(path); fd = openSync(path, 'wx', 0o600);
    } finally { closeSync(guard); unlinkSync(recovery); }
  }
  try { writeFileSync(fd, JSON.stringify(currentOwner)); fsyncSync(fd); } catch { closeSync(fd); unlinkSync(path); throw unavailable(); }
  return () => { closeSync(fd); if (owner(path)?.token === currentOwner.token) unlinkSync(path); };
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v);
const prose = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 1000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v);
const timestamp = (v: unknown) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));
function validRow(v: unknown): v is StoredArchiveCorrection {
  if (!record(v) || Object.keys(v).some(key => !['id','version','accountId','applicantIdentity','applicantName','fields','description','status','createdAt','updatedAt','reviewerAccountId','reviewerName','comment'].includes(key)) ||
    !text(v.id, 128) || !text(v.accountId) || !text(v.applicantIdentity, 512) || !text(v.applicantName, 100) || !prose(v.description) ||
    !timestamp(v.createdAt) || !timestamp(v.updatedAt) || !Number.isSafeInteger(v.version) || Number(v.version) < 1 ||
    !Array.isArray(v.fields) || !v.fields.length || v.fields.length > PERSONNEL_ARCHIVE_CORRECTION_FIELDS.length || new Set(v.fields).size !== v.fields.length ||
    !v.fields.every(field => PERSONNEL_ARCHIVE_CORRECTION_FIELDS.includes(field))) return false;
  if (v.status === 'pending' || v.status === 'cancelled') return (v.status === 'pending' ? v.version === 1 : v.version === 2) && v.reviewerAccountId === undefined && v.reviewerName === undefined && v.comment === undefined;
  return ['resolved','rejected'].includes(String(v.status)) && v.version === 2 && text(v.reviewerAccountId) && text(v.reviewerName,100) && prose(v.comment);
}
function validState(v: unknown): v is ArchiveCorrectionsState {
  if (!record(v) || Object.keys(v).sort().join(',') !== 'audit,mutations,requests,revision,schemaVersion' || v.schemaVersion !== 1 ||
    !Number.isSafeInteger(v.revision) || Number(v.revision) < 0 || !record(v.requests) || !record(v.mutations) || !Array.isArray(v.audit) ||
    Object.keys(v.requests).length > 10000 || Object.keys(v.mutations).length > 30000 || v.audit.length > 20000) return false;
  const rows = v.requests;
  return Object.entries(rows).every(([key,row]) => validRow(row) && key === row.id) &&
    Object.entries(v.mutations).every(([key,item]) => /^[a-f0-9]{64}$/.test(key) && record(item) && Object.keys(item).sort().join(',') === 'fingerprint,requestId' &&
      typeof item.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(item.fingerprint) && typeof item.requestId === 'string' && Object.hasOwn(rows,item.requestId)) &&
    v.audit.every(item => record(item) && Object.keys(item).sort().join(',') === 'action,actorId,at,requestId,version' && text(item.actorId) && timestamp(item.at) &&
      typeof item.requestId === 'string' && Object.hasOwn(rows,item.requestId) && ['create','cancel','resolve','reject'].includes(String(item.action)) && Number.isSafeInteger(item.version) && [1,2].includes(Number(item.version)));
}
function unavailable() { return new ServiceUnavailableException('资料纠错台账暂不可用，原记录已保留，请联系管理员'); }
