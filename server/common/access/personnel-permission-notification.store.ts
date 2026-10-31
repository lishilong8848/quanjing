import { ServiceUnavailableException } from '@nestjs/common';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProcessLockOwner, normalizeProcessLockOwner, processLockOwnerMayBeAlive } from '../process-lock-owner';

export interface PermissionNotificationDelivery {
  accountId: string; openId: string; uuid: string; attempts: number; nextAttemptAt: number;
  status: 'queued' | 'sending' | 'sent' | 'attention' | 'cancelled';
  firstAttemptAt?: number; messageId?: string; syncedVersion?: number; errorCode?: string;
  pendingCard?: Record<string, unknown>; pendingVersion?: number;
}
export interface PermissionNotificationJob {
  requestId: string; appId: string; createdAt: number; recipientAccountIds: string[];
  recipientsResolved: boolean; deliveries: PermissionNotificationDelivery[];
  nextResolveAt?: number;
}
interface NotificationState { version: 1; jobs: Record<string, PermissionNotificationJob>; }
const uuid = /^[a-f0-9-]{36}$/u;
const ordinary = (file: string) => {
  if (!isAbsolute(file)) throw unavailable();
  for (let current = resolve(file); ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw unavailable();
    if (dirname(current) === current) return;
  }
};
function valid(state: NotificationState): boolean {
  return !!state && state.version === 1 && !!state.jobs && typeof state.jobs === 'object' && !Array.isArray(state.jobs) &&
    Object.keys(state).sort().join(',') === 'jobs,version' && Object.keys(state.jobs).length <= 10000 &&
    Object.entries(state.jobs).every(([id, job]) => uuid.test(id) && job.requestId === id && /^cli_[A-Za-z0-9_-]+$/u.test(job.appId) &&
      Number.isSafeInteger(job.createdAt) && job.createdAt > 0 && Array.isArray(job.recipientAccountIds) && job.recipientAccountIds.length <= 100 &&
      job.recipientAccountIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256) &&
      new Set(job.recipientAccountIds).size === job.recipientAccountIds.length && typeof job.recipientsResolved === 'boolean' &&
      (job.nextResolveAt === undefined || Number.isSafeInteger(job.nextResolveAt) && job.nextResolveAt >= 0) &&
      Array.isArray(job.deliveries) && job.deliveries.length <= 100 &&
      new Set(job.deliveries.map(row => row.openId)).size === job.deliveries.length && job.deliveries.every(row =>
        typeof row.accountId === 'string' && job.recipientAccountIds.includes(row.accountId) && /^ou_[A-Za-z0-9_-]+$/u.test(row.openId) && /^[a-f0-9]{40}$/u.test(row.uuid) &&
        job.deliveries.filter(item => item.uuid === row.uuid).length === 1 &&
        Number.isSafeInteger(row.attempts) && row.attempts >= 0 && Number.isSafeInteger(row.nextAttemptAt) && row.nextAttemptAt >= 0 &&
        ['queued', 'sending', 'sent', 'attention', 'cancelled'].includes(row.status) &&
        (row.firstAttemptAt === undefined || Number.isSafeInteger(row.firstAttemptAt) && row.firstAttemptAt > 0) &&
        (row.messageId === undefined || /^om_[A-Za-z0-9_-]+$/u.test(row.messageId)) &&
        (row.syncedVersion === undefined || Number.isSafeInteger(row.syncedVersion) && row.syncedVersion > 0) &&
        (row.status !== 'sent' || !!row.messageId && !!row.syncedVersion) &&
        (row.status !== 'sending' || row.firstAttemptAt !== undefined) &&
        ((row.pendingCard === undefined && row.pendingVersion === undefined) ||
          !!row.pendingCard && typeof row.pendingCard === 'object' && !Array.isArray(row.pendingCard) &&
          Buffer.byteLength(JSON.stringify(row.pendingCard)) <= 28 * 1024 && Number.isSafeInteger(row.pendingVersion) && row.pendingVersion! > 0) &&
        (row.errorCode === undefined || /^[A-Z_]{1,80}$/u.test(row.errorCode))));
}

/** Only explicitly enqueued requests are delivered; never scans historical requests to create jobs. */
export class PersonnelPermissionNotificationStore {
  private persisted = false;
  constructor(readonly filePath: string) { ordinary(filePath); }
  read(): NotificationState {
    try {
      ordinary(this.filePath);
      if (!existsSync(this.filePath)) { if (this.persisted) throw unavailable(); return { version: 1, jobs: {} }; }
      this.persisted = true;
      const stat = lstatSync(this.filePath);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw unavailable();
      const state = JSON.parse(readFileSync(this.filePath, 'utf8')) as NotificationState;
      if (!valid(state)) throw unavailable();
      this.persisted = true;
      return state;
    } catch { throw unavailable(); }
  }
  update(change: (state: NotificationState) => void): void {
    ordinary(this.filePath); mkdirSync(dirname(this.filePath), { recursive: true });
    const release = lock(this.filePath + '.lock');
    if (!release) throw unavailable();
    const temporary = this.filePath + '.' + randomUUID() + '.tmp';
    try {
      const state = this.read(); change(state);
      if (!valid(state)) throw unavailable();
      const bytes = Buffer.from(JSON.stringify(state));
      if (bytes.length > 8 * 1024 * 1024) throw unavailable();
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.filePath);
      this.persisted = true;
    } finally { if (existsSync(temporary)) unlinkSync(temporary); release(); }
  }
  async withDeliveryLock<T>(requestId: string, deliveryUuid: string, work: () => Promise<T>): Promise<T | undefined> {
    if (!uuid.test(requestId) || !/^[a-f0-9]{40}$/u.test(deliveryUuid)) throw unavailable();
    ordinary(this.filePath); mkdirSync(dirname(this.filePath), { recursive: true });
    const release = lock(`${this.filePath}.${requestId}.${deliveryUuid}.lock`);
    if (!release) return undefined;
    try { return await work(); } finally { release(); }
  }
}
function lock(file: string): (() => void) | undefined {
  ordinary(file); const owner = createProcessLockOwner(randomUUID()); let fd: number;
  const readOwner = () => { try { return normalizeProcessLockOwner(JSON.parse(readFileSync(file, 'utf8'))); } catch { return undefined; } };
  try { fd = openSync(file, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable();
    const previous = readOwner();
    if (!previous || processLockOwnerMayBeAlive(previous, lstatSync(file).mtimeMs)) return undefined;
    const recovery = file + '.recovery'; ordinary(recovery); let guard: number;
    try { guard = openSync(recovery, 'wx', 0o600); } catch { return undefined; }
    try {
      const again = readOwner();
      if (!again || again.token !== previous.token || processLockOwnerMayBeAlive(again, lstatSync(file).mtimeMs)) return undefined;
      unlinkSync(file); fd = openSync(file, 'wx', 0o600);
    } finally { closeSync(guard); unlinkSync(recovery); }
  }
  try { writeFileSync(fd, JSON.stringify(owner)); fsyncSync(fd); }
  catch { closeSync(fd); unlinkSync(file); throw unavailable(); }
  return () => { closeSync(fd); if (readOwner()?.token === owner.token) unlinkSync(file); };
}
function unavailable() { return new ServiceUnavailableException('管理员通知暂未登记，请保留申请并重试'); }
