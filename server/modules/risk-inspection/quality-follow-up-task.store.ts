import { businessPermissionScopeKey, isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import { buildingScopeKey } from '../../../shared/building-access';
import { ConflictException, Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AccessPrincipal } from '../../../shared/access-control.interface';

export type QualityFollowUpTaskStatus = 'pending' | 'running' | 'success' | 'error';
export const RISK_QUALITY_FOLLOW_UP_LEDGER_PATH = 'RISK_QUALITY_FOLLOW_UP_LEDGER_PATH';

export interface QualityFollowUpTask {
  id: string;
  recordId: string;
  clientMutationId: string;
  supplemental: string;
  expectedSupplemental: string;
  principal: AccessPrincipal;
  status: QualityFollowUpTaskStatus;
  attempts: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  nextRetryAt: string | null;
}

interface QualityFollowUpLedger {
  version: 1;
  tasks: QualityFollowUpTask[];
}

@Injectable()
export class QualityFollowUpTaskStore {
  private readonly path: string;

  constructor(@Optional() @Inject(RISK_QUALITY_FOLLOW_UP_LEDGER_PATH) path?: string) {
    this.path = resolve(
      path || process.env.RISK_QUALITY_FOLLOW_UP_LEDGER_PATH ||
        '.runtime/risk-quality-follow-up-ledger.json',
    );
  }

  create(input: Pick<QualityFollowUpTask,
    'recordId' | 'clientMutationId' | 'supplemental' | 'expectedSupplemental' | 'principal'>): QualityFollowUpTask {
    return this.withLock((ledger) => {
      const existing = ledger.tasks.find((task) =>
        task.recordId === input.recordId && task.clientMutationId === input.clientMutationId,
      );
      if (existing) {
        if (existing.supplemental !== input.supplemental ||
          existing.expectedSupplemental !== input.expectedSupplemental ||
          existing.principal.role !== input.principal.role ||
          existing.principal.purchaseBuilding !== input.principal.purchaseBuilding || buildingScopeKey(existing.principal) !== buildingScopeKey(input.principal) ||
          (isProfessionalBusinessPrincipal(input.principal) && (businessPermissionScopeKey(existing.principal) !== businessPermissionScopeKey(input.principal)))) {
          throw new ConflictException('本次问题跟进标识已用于其他内容');
        }
        return { task: existing, changed: false };
      }
      if (ledger.tasks.some((task) => task.recordId === input.recordId &&
        (task.status === 'pending' || task.status === 'running'))) {
        throw new ConflictException('该问题已有跟进正在同步');
      }
      const now = new Date().toISOString();
      const task: QualityFollowUpTask = {
        ...input,
        principal: { ...input.principal },
        id: `quality-follow-up-${randomUUID()}`,
        status: 'pending',
        attempts: 0,
        message: '问题跟进已受理，正在同步',
        createdAt: now,
        updatedAt: now,
        nextRetryAt: null,
      };
      ledger.tasks.push(task);
      if (ledger.tasks.length > 1000) {
        const terminal = ledger.tasks
          .filter((item) => item.status === 'success' || item.status === 'error')
          .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
        const removable = new Set(terminal.slice(0, ledger.tasks.length - 1000).map((item) => item.id));
        ledger.tasks = ledger.tasks.filter((item) => !removable.has(item.id));
      }
      if (ledger.tasks.length > 1000) throw new ServiceUnavailableException('问题跟进任务容量已满');
      return { task, changed: true };
    });
  }

  get(id: string): QualityFollowUpTask | null {
    return this.read().tasks.find((task) => task.id === id) || null;
  }

  listReady(now = Date.now()): QualityFollowUpTask[] {
    return this.read().tasks.filter((task) =>
      (task.status === 'pending' && (!task.nextRetryAt || Date.parse(task.nextRetryAt) <= now)) ||
      (task.status === 'running' && Date.parse(task.updatedAt) + 120_000 <= now),
    );
  }

  update(id: string, updater: (task: QualityFollowUpTask) => QualityFollowUpTask): QualityFollowUpTask {
    return this.withLock((ledger) => {
      const index = ledger.tasks.findIndex((task) => task.id === id);
      if (index < 0) throw new ServiceUnavailableException('问题跟进任务不存在');
      const next = updater({ ...ledger.tasks[index], principal: { ...ledger.tasks[index].principal } });
      ledger.tasks[index] = { ...next, updatedAt: new Date().toISOString() };
      return { task: ledger.tasks[index], changed: true };
    });
  }

  private read(): QualityFollowUpLedger {
    if (!existsSync(this.path)) return { version: 1, tasks: [] };
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as QualityFollowUpLedger;
      if (value.version !== 1 || !Array.isArray(value.tasks)) throw new Error('invalid ledger');
      return value;
    } catch {
      throw new ServiceUnavailableException('问题跟进同步台账无法读取');
    }
  }

  private withLock(
    change: (ledger: QualityFollowUpLedger) => { task: QualityFollowUpTask; changed: boolean },
  ): QualityFollowUpTask {
    mkdirSync(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    let descriptor: number;
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 120_000) {
          rmSync(lockPath);
          descriptor = openSync(lockPath, 'wx', 0o600);
        } else {
          throw new ServiceUnavailableException('问题跟进正在写入，请稍后重试');
        }
      } catch (retryError) {
        if (retryError instanceof ServiceUnavailableException) throw retryError;
        throw new ServiceUnavailableException('问题跟进同步台账暂不可用');
      }
    }
    try {
      const ledger = this.read();
      const result = change(ledger);
      if (result.changed) {
        const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporary, JSON.stringify(ledger), { mode: 0o600 });
          renameSync(temporary, this.path);
        } finally {
          rmSync(temporary, { force: true });
        }
      }
      return { ...result.task, principal: { ...result.task.principal } };
    } finally {
      closeSync(descriptor);
      rmSync(lockPath, { force: true });
    }
  }
}
