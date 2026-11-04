import { ServiceUnavailableException } from '@nestjs/common';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createProcessLockOwner, normalizeProcessLockOwner, processLockOwnerMayBeAlive } from './process-lock-owner';

export const CALLBACK_FEEDBACK_KINDS = ['leave', 'overtime', 'purchase', 'inventory_outbound', 'threshold_adjustment', 'today_operations_followup', 'today_operations_anomaly'] as const;
export type CallbackFeedbackKind = typeof CALLBACK_FEEDBACK_KINDS[number];
export interface CallbackFeedbackJob {
  id: string; appId: string; openId: string; kind: CallbackFeedbackKind; uuid: string; sourceHash: string; actionHash: string;
  createdAt: number; attempts: number; nextAttemptAt: number;
  status: 'queued' | 'sending' | 'sent' | 'attention' | 'cancelled';
  firstAttemptAt?: number; messageId?: string;
}
export interface CallbackFeedbackState { version: 1; jobs: Record<string, CallbackFeedbackJob>; }

const hash = /^[a-f0-9]{64}$/u;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const ordinary = (file: string) => {
  if (!isAbsolute(file)) throw unavailable();
  for (let current = resolve(file); ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw unavailable();
    if (dirname(current) === current) return;
  }
};
function valid(state: CallbackFeedbackState): boolean {
  return !!state && state.version === 1 && Object.keys(state).sort().join(',') === 'jobs,version' &&
    !!state.jobs && typeof state.jobs === 'object' && !Array.isArray(state.jobs) && Object.keys(state.jobs).length <= 2_000 &&
    Object.entries(state.jobs).every(([id, job]) => !!job && hash.test(id) && job.id === id &&
      Object.keys(job).every(key => ['id', 'appId', 'openId', 'kind', 'uuid', 'sourceHash', 'actionHash', 'createdAt', 'attempts', 'nextAttemptAt', 'status', 'firstAttemptAt', 'messageId'].includes(key)) &&
      /^cli_[A-Za-z0-9_-]{1,120}$/u.test(job.appId) && /^ou_[A-Za-z0-9_-]{1,124}$/u.test(job.openId) &&
      CALLBACK_FEEDBACK_KINDS.includes(job.kind) && hash.test(job.sourceHash) && hash.test(job.actionHash) &&
      job.id === digest(JSON.stringify(['callback-late-failure-v1', job.appId, job.kind, job.sourceHash, job.openId, job.actionHash])) &&
      job.uuid === digest('callback-late-failure:' + job.id).slice(0, 40) &&
      Number.isSafeInteger(job.createdAt) && job.createdAt > 0 && Number.isSafeInteger(job.attempts) && job.attempts >= 0 && job.attempts <= 3 &&
      Number.isSafeInteger(job.nextAttemptAt) && job.nextAttemptAt >= 0 &&
      ['queued', 'sending', 'sent', 'attention', 'cancelled'].includes(job.status) &&
      (job.firstAttemptAt === undefined || Number.isSafeInteger(job.firstAttemptAt) && job.firstAttemptAt > 0) &&
      (job.messageId === undefined || /^om_[A-Za-z0-9_-]{1,256}$/u.test(job.messageId)) &&
      (job.status !== 'sending' || !!job.firstAttemptAt && job.attempts > 0) &&
      (job.status !== 'sent' || !!job.messageId && !!job.firstAttemptAt && job.attempts > 0));
}

/** Only failure-notification metadata is stored. It cannot execute or recover business actions. */
export class FeishuCardCallbackFeedbackStore {
  private persisted = false;
  constructor(readonly filePath: string) { ordinary(filePath); }
  read(): CallbackFeedbackState {
    try {
      ordinary(this.filePath);
      if (!existsSync(this.filePath)) { if (this.persisted) throw unavailable(); return { version: 1, jobs: {} }; }
      this.persisted = true;
      const stat = lstatSync(this.filePath);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw unavailable();
      const state = JSON.parse(readFileSync(this.filePath, 'utf8')) as CallbackFeedbackState;
      if (!valid(state)) throw unavailable();
      return state;
    } catch { throw unavailable(); }
  }
  update(change: (state: CallbackFeedbackState) => void): void {
    ordinary(this.filePath); mkdirSync(dirname(this.filePath), { recursive: true });
    const release = lock(this.filePath + '.lock');
    if (!release) throw unavailable();
    const temporary = this.filePath + '.' + randomUUID() + '.tmp';
    try {
      const state = this.read(); change(state);
      if (!valid(state)) throw unavailable();
      const bytes = Buffer.from(JSON.stringify(state));
      if (bytes.length > 2 * 1024 * 1024) throw unavailable();
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.filePath); this.persisted = true;
    } finally { if (existsSync(temporary)) unlinkSync(temporary); release(); }
  }
  async withDeliveryLock<T>(id: string, work: () => Promise<T>): Promise<T | undefined> {
    if (!hash.test(id)) throw unavailable();
    ordinary(this.filePath); mkdirSync(dirname(this.filePath), { recursive: true });
    const release = lock(`${this.filePath}.${id}.lock`);
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
function unavailable() { return new ServiceUnavailableException('卡片结果提示暂未登记，请在原卡片核对状态'); }
