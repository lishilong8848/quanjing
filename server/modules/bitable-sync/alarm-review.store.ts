import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AlarmHumanReview, AlarmReviewRequest, AlarmReviewTask } from '../../../shared/today-operations-alarm-review.interface';
import { createProcessLockOwner, normalizeProcessLockOwner, processLockOwnerMayBeAlive, type ProcessLockOwner } from '../../common/process-lock-owner';

export const ALARM_REVIEW_LEDGER_PATH = 'ALARM_REVIEW_LEDGER_PATH';
export interface StoredAlarmReviewTask extends AlarmReviewTask {
  userId: string;
  principal: string;
  request: AlarmReviewRequest;
  lease: ProcessLockOwner | null;
}
interface Ledger { version: 1; tasks: StoredAlarmReviewTask[] }

@Injectable()
export class AlarmReviewStore {
  private readonly path: string;
  constructor(@Optional() @Inject(ALARM_REVIEW_LEDGER_PATH) path?: string) {
    this.path = resolve(path || process.env.ALARM_REVIEW_LEDGER_PATH || '.runtime/alarm-human-review-ledger.json');
  }
  create(request: AlarmReviewRequest, responsibleName: string, userId: string, principal: string): AlarmReviewTask {
    return this.change((ledger) => {
      const existing = ledger.tasks.find((task) => task.clientMutationId === request.clientMutationId);
      if (existing) {
        if (existing.principal !== principal || JSON.stringify(existing.request) !== JSON.stringify(request)) throw new ConflictException('提交标识已用于其他复核内容');
        return publicTask(existing);
      }
      if (ledger.tasks.some((task) => task.items.some((item) => request.recordIds.includes(item.recordId) && (item.state === 'pending' || item.state === 'syncing')))) {
        throw new ConflictException('部分告警已有未完成复核，请先处理原任务');
      }
      if (ledger.tasks.length >= 5000) throw new ServiceUnavailableException('复核任务账本已满，请联系管理员归档');
      const now = new Date().toISOString();
      const task: StoredAlarmReviewTask = {
        id: `alarm-review-task-${randomUUID()}`, clientMutationId: request.clientMutationId,
        outcome: request.outcome, responsibleRecordId: request.responsibleRecordId, responsibleName,
        ...(request.customReply ? { customReply: request.customReply } : {}),
        items: request.recordIds.map((recordId) => ({ recordId, state: 'pending', message: '' })),
        createdAt: now, updatedAt: now, request, userId, principal, lease: null,
      };
      ledger.tasks.push(task);
      return publicTask(task);
    });
  }
  get(id: string, principal: string): AlarmReviewTask {
    const task = this.find(this.read(), id);
    this.authorize(task, principal);
    return publicTask(task);
  }
  findByMutation(clientMutationId: string, principal: string): AlarmReviewTask | null {
    const task = this.read().tasks.find((entry) => entry.clientMutationId === clientMutationId);
    if (!task) return null;
    this.authorize(task, principal);
    return publicTask(task);
  }
  listReady(): StoredAlarmReviewTask[] {
    return this.read().tasks.filter((task) => task.items.some((item) => item.state === 'pending' || item.state === 'syncing'));
  }
  claim(id: string): string | null {
    return this.change((ledger) => {
      const task = this.find(ledger, id);
      if (task.lease && processLockOwnerMayBeAlive(task.lease, Date.parse(task.updatedAt))) return null;
      if (!task.items.some((item) => item.state === 'pending' || item.state === 'syncing')) return null;
      const token = randomUUID();
      task.lease = createProcessLockOwner(token);
      task.items.forEach((item) => { if (item.state === 'pending' || item.state === 'syncing') item.state = 'syncing'; });
      task.updatedAt = new Date().toISOString();
      return token;
    });
  }
  finishItem(id: string, lease: string, recordId: string, error: string | null, review?: AlarmHumanReview): void {
    this.change((ledger) => {
      const task = this.find(ledger, id);
      if (task.lease?.token !== lease) throw new ConflictException('复核任务执行权已变更');
      const item = task.items.find((candidate) => candidate.recordId === recordId);
      if (!item) throw new NotFoundException('复核条目不存在');
      item.state = error ? 'error' : 'success';
      item.message = error || '';
      if (!error && review) item.review = review;
      task.updatedAt = new Date().toISOString();
    });
  }
  release(id: string, lease: string): void {
    this.change((ledger) => {
      const task = this.find(ledger, id);
      if (task.lease?.token === lease) task.lease = null;
    });
  }
  retry(id: string, principal: string): AlarmReviewTask {
    return this.change((ledger) => {
      const task = this.find(ledger, id);
      this.authorize(task, principal);
      if (task.lease) throw new ConflictException('复核仍在同步，请稍后核对');
      const failedIds = task.items.filter((item) => item.state === 'error').map((item) => item.recordId);
      if (ledger.tasks.some((other) => other.id !== id && other.items.some((item) => failedIds.includes(item.recordId) && (item.state === 'pending' || item.state === 'syncing')))) throw new ConflictException('部分告警已有新的复核正在同步');
      task.items.forEach((item) => { if (item.state === 'error') { item.state = 'pending'; item.message = ''; } });
      task.updatedAt = new Date().toISOString();
      return publicTask(task);
    });
  }
  private authorize(task: StoredAlarmReviewTask, principal: string): void {
    if (!principal || task.principal !== principal) throw new ForbiddenException('不能读取其他登录会话的复核任务');
  }
  private find(ledger: Ledger, id: string): StoredAlarmReviewTask {
    const task = ledger.tasks.find((candidate) => candidate.id === id);
    if (!task) throw new NotFoundException('复核任务不存在');
    return task;
  }
  private read(): Ledger {
    if (!existsSync(this.path)) return { version: 1, tasks: [] };
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as Ledger;
      if (value.version !== 1 || !Array.isArray(value.tasks) || value.tasks.some((task) =>
        typeof task.id !== 'string' || typeof task.principal !== 'string' || !task.request ||
        !Array.isArray(task.items) || task.items.some((item) => !['pending', 'syncing', 'success', 'error'].includes(item.state)))) throw new Error();
      return value;
    } catch { throw new ServiceUnavailableException('复核任务账本无法读取，请联系管理员；未重置历史数据'); }
  }
  private change<T>(action: (ledger: Ledger) => T): T {
    mkdirSync(dirname(this.path), { recursive: true });
    const lock = `${this.path}.lock`;
    if (existsSync(lock)) {
      let owner: ProcessLockOwner | null = null;
      try { owner = normalizeProcessLockOwner(JSON.parse(readFileSync(lock, 'utf8'))); } catch { /* 未识别的锁不可接管 */ }
      if (!owner || processLockOwnerMayBeAlive(owner, statSync(lock).mtimeMs)) throw new ServiceUnavailableException('复核账本正在使用，请使用同一提交标识重试');
      rmSync(lock);
    }
    let fd: number;
    try { fd = openSync(lock, 'wx', 0o600); } catch { throw new ServiceUnavailableException('复核账本正在使用，请使用同一提交标识重试'); }
    const token = randomUUID();
    const temp = `${this.path}.${token}.tmp`;
    try {
      writeFileSync(fd, JSON.stringify(createProcessLockOwner(token)));
      fsyncSync(fd);
      const ledger = this.read();
      const result = action(ledger);
      const tempFd = openSync(temp, 'wx', 0o600);
      try { writeFileSync(tempFd, JSON.stringify(ledger)); fsyncSync(tempFd); } finally { closeSync(tempFd); }
      renameSync(temp, this.path);
      return result;
    } finally {
      closeSync(fd);
      rmSync(temp, { force: true });
      rmSync(lock, { force: true });
    }
  }
}
function publicTask(task: StoredAlarmReviewTask): AlarmReviewTask {
  const { id, clientMutationId, outcome, customReply, responsibleRecordId, responsibleName, items, createdAt, updatedAt } = task;
  return { id, clientMutationId, outcome, ...(customReply ? { customReply } : {}), responsibleRecordId, responsibleName, items: items.map((item) => ({ ...item })), createdAt, updatedAt };
}
