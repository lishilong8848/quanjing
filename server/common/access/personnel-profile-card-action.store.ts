import { ServiceUnavailableException } from '@nestjs/common';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createProcessLockOwner,
  normalizeProcessLockOwner,
  processLockOwnerMayBeAlive,
} from '../process-lock-owner';
export interface ProfileCardActionJob {
  id: string;
  appId: string;
  requestId: string;
  expectedVersion: number;
  decision: 'approve' | 'reject';
  reason?: string;
  actorAccountId: string;
  actorVersion: number;
  operatorOpenId: string;
  messageId: string;
  mutationId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  error?: string;
  cardRefreshPending?: boolean;
}
interface State {
  version: 1;
  tasks: Record<string, ProfileCardActionJob>;
}
const ordinary = (file: string) => {
  if (!isAbsolute(file)) throw unavailable();
  for (let current = resolve(file); ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw unavailable();
    if (dirname(current) === current) return;
  }
};
function valid(s: State) {
  return (
    s &&
    s.version === 1 &&
    s.tasks &&
    typeof s.tasks === 'object' &&
    !Array.isArray(s.tasks) &&
    Object.keys(s).sort().join(',') === 'tasks,version' &&
    Object.keys(s.tasks).length <= 10000 &&
    Object.entries(s.tasks).every(
      ([id, t]) =>
        t &&
        id === t.id &&
        /^[a-f0-9]{64}$/.test(id) &&
        /^cli_[A-Za-z0-9_-]+$/.test(t.appId) &&
        /^[a-f0-9-]{36}$/.test(t.requestId) &&
        Number.isSafeInteger(t.expectedVersion) &&
        t.expectedVersion > 0 &&
        ['approve', 'reject'].includes(t.decision) &&
        (t.decision === 'reject'
          ? typeof t.reason === 'string' &&
            !!t.reason.trim() &&
            t.reason.length <= 1000
          : t.reason === undefined) &&
        typeof t.actorAccountId === 'string' &&
        t.actorAccountId.length < 256 &&
        Number.isSafeInteger(t.actorVersion) &&
        t.actorVersion > 0 &&
        /^ou_[A-Za-z0-9_-]+$/.test(t.operatorOpenId) &&
        /^om_[A-Za-z0-9_-]+$/.test(t.messageId) &&
        t.mutationId === id &&
        ['queued', 'running', 'completed', 'failed'].includes(t.status) &&
        Number.isSafeInteger(t.attempts) &&
        t.attempts >= 0 &&
        Number.isSafeInteger(t.nextAttemptAt) &&
        Number.isSafeInteger(t.createdAt) &&
        (t.cardRefreshPending === undefined ||
          typeof t.cardRefreshPending === 'boolean') &&
        (!t.error || (typeof t.error === 'string' && t.error.length <= 300)),
    )
  );
}
export class PersonnelProfileCardActionStore {
  private persisted = false;
  constructor(readonly filePath: string) {
    ordinary(filePath);
  }
  read(): State {
    try {
      ordinary(this.filePath);
      if (!existsSync(this.filePath)) {
        if (this.persisted) throw unavailable();
        return { version: 1, tasks: {} };
      }
      this.persisted = true;
      const stat = lstatSync(this.filePath);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024)
        throw unavailable();
      const state = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!valid(state)) throw unavailable();
      return state;
    } catch {
      throw unavailable();
    }
  }
  update<T>(fn: (s: State) => T): T {
    ordinary(this.filePath);
    mkdirSync(dirname(this.filePath), { recursive: true });
    const release = lock(this.filePath + '.lock');
    if (!release) throw unavailable();
    const temp = this.filePath + '.' + randomUUID() + '.tmp';
    try {
      const state = this.read(),
        result = fn(state);
      if (!valid(state)) throw unavailable();
      const bytes = Buffer.from(JSON.stringify(state));
      if (bytes.length > 8 * 1024 * 1024) throw unavailable();
      const fd = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.filePath);
      this.persisted = true;
      return structuredClone(result);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
      release();
    }
  }
  async withTask(id: string, run: () => Promise<void>) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw unavailable();
    const release = lock(this.filePath + '.' + id + '.lock');
    if (!release) return;
    try {
      await run();
    } finally {
      release();
    }
  }
}
function lock(file: string): (() => void) | undefined {
  ordinary(file);
  const owner = createProcessLockOwner(randomUUID());
  let fd: number;
  const readOwner = () => {
    try {
      return normalizeProcessLockOwner(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return undefined;
    }
  };
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable();
    const previous = readOwner();
    if (
      !previous ||
      processLockOwnerMayBeAlive(previous, lstatSync(file).mtimeMs)
    )
      return undefined;
    const recovery = file + '.recovery';
    ordinary(recovery);
    let guard: number;
    try {
      guard = openSync(recovery, 'wx', 0o600);
    } catch {
      return undefined;
    }
    try {
      const again = readOwner();
      if (
        !again ||
        again.token !== previous.token ||
        processLockOwnerMayBeAlive(again, lstatSync(file).mtimeMs)
      )
        return undefined;
      unlinkSync(file);
      fd = openSync(file, 'wx', 0o600);
    } finally {
      closeSync(guard);
      unlinkSync(recovery);
    }
  }
  try {
    writeFileSync(fd, JSON.stringify(owner));
    fsyncSync(fd);
  } catch {
    closeSync(fd);
    unlinkSync(file);
    throw unavailable();
  }
  return () => {
    closeSync(fd);
    if (readOwner()?.token === owner.token) unlinkSync(file);
  };
}
function unavailable() {
  return new ServiceUnavailableException('资料变更通知记录暂不可用');
}
