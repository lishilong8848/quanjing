import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  canDeleteWeeklyTask,
  weeklyTargetsOverlap,
} from '../../../shared/weekly-job-locks';
import { validWeeklyDate } from '../../../shared/weekly-workspace.rules';
import type { WeeklyEngineDiagnostic } from './weekly.engine';
import type {
  GenerateWeeklyReport,
  SaveWeeklyMeeting,
  WeeklyJob,
  WeeklyMeetingEntry,
  PreparedActionEdit,
  EditMeetingAction,
  WeeklyAttachmentCommand,
} from '../../../shared/weekly-workspace.interface';

export interface WeeklyReceipt {
  engineDiagnostic?: WeeklyEngineDiagnostic;
  taskOperations?: Record<
    string,
    { actor: string; action: 'delete' | 'restore' }
  >;
  createdRowId?: string;
  sequence?: number;
  fingerprint: string;
  actor: string;
  job: WeeklyJob;
  command:
    | SaveWeeklyMeeting
    | GenerateWeeklyReport
    | PreparedActionEdit
    | EditMeetingAction
    | WeeklyAttachmentCommand;
  attachmentState?: {
    tokens: Record<string, string>;
    uploading?: string;
    expectedTokens?: string[];
  };
  before?: WeeklyMeetingEntry;
  preparedAction?: PreparedActionEdit;
  artifact?: {
    xml: string;
    professional: string;
    operations: string;
    title: string;
  };
}
interface Ledger {
  schema: 1;
  meetings: WeeklyMeetingEntry[];
  receipts: Record<string, WeeklyReceipt>;
}
export function canNotifyWeeklyReport(receipt: WeeklyReceipt): boolean {
  return (
    receipt.job.kind === 'generate' &&
    !(receipt.command as GenerateWeeklyReport).createOnly &&
    receipt.job.status === 'success' &&
    receipt.job.stage === 'done' &&
    /^https:\/\/vnet\.feishu\.cn\/docx\/[A-Za-z0-9]+$/.test(
      receipt.job.documentUrl || '',
    )
  );
}

// Locks are never taken over while their owner process is alive, even during slow external writes.
export function acquireWeeklyLock(path: string): (() => void) | null {
  const nonce = randomUUID();
  mkdirSync(dirname(path), { recursive: true });
  try {
    mkdirSync(path);
  } catch {
    try {
      const pid = Number(readFileSync(join(path, 'pid'), 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) return null;
      try {
        process.kill(pid, 0);
        return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return null;
      }
      if (existsSync(join(path, 'child-pid'))) {
        const childPid = Number(readFileSync(join(path, 'child-pid'), 'utf8'));
        if (!Number.isSafeInteger(childPid) || childPid < 1) return null;
        try {
          process.kill(childPid, 0);
          return null;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return null;
        }
      }
      if (Number(readFileSync(join(path, 'pid'), 'utf8')) !== pid) return null;
      unlinkSync(join(path, 'pid'));
      if (existsSync(join(path, 'child-pid')))
        unlinkSync(join(path, 'child-pid'));
      if (existsSync(join(path, 'nonce'))) unlinkSync(join(path, 'nonce'));
      rmdirSync(path);
      mkdirSync(path);
    } catch {
      return null;
    }
  }
  writeFileSync(join(path, 'pid'), String(process.pid), {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(join(path, 'nonce'), nonce, { flag: 'wx', mode: 0o600 });
  return () => {
    if (
      !existsSync(join(path, 'nonce')) ||
      readFileSync(join(path, 'nonce'), 'utf8') !== nonce
    )
      return;
    unlinkSync(join(path, 'pid'));
    if (existsSync(join(path, 'child-pid')))
      unlinkSync(join(path, 'child-pid'));
    unlinkSync(join(path, 'nonce'));
    rmdirSync(path);
  };
}

export class WeeklyStore {
  readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
  }
  private read(): Ledger {
    if (!existsSync(this.path))
      return { schema: 1, meetings: [], receipts: Object.create(null) };
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as Ledger;
      if (
        value.schema !== 1 ||
        !Array.isArray(value.meetings) ||
        !value.receipts ||
        typeof value.receipts !== 'object' ||
        Array.isArray(value.receipts)
      )
        throw new Error();
      for (const receipt of Object.values(value.receipts)) {
        if (
          !receipt?.job?.id ||
          !receipt.command ||
          !receipt.fingerprint ||
          ![
            'accepted',
            'running',
            'success',
            'error',
            'uncertain',
            'deleting',
            'deleted',
          ].includes(receipt.job.status)
        )
          throw new Error();
        if (
          ['deleting', 'deleted'].includes(receipt.job.status) &&
          (!receipt.job.deletion ||
            !['error', 'uncertain'].includes(
              receipt.job.deletion.previousStatus,
            ) ||
            receipt.job.deletion.status !==
              (receipt.job.status === 'deleting' ? 'checking' : 'success'))
        )
          throw new Error();
      }
      value.receipts = Object.assign(Object.create(null), value.receipts);
      return value;
    } catch {
      throw new ServiceUnavailableException(
        '周会台账读取失败，原数据已保留，请联系管理员',
      );
    }
  }
  private transaction<T>(action: (ledger: Ledger) => T): T {
    const release = acquireWeeklyLock(`${this.path}.lock`);
    if (!release)
      throw new ServiceUnavailableException('周会台账正在写入，请稍后重试');
    const temp = `${this.path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      const ledger = this.read();
      const result = action(ledger);
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(ledger));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, this.path);
      return result;
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temp)) unlinkSync(temp);
      release();
    }
  }
  list() {
    const data = this.read();
    return {
      meetings: data.meetings,
      jobs: Object.values(data.receipts)
        .map((r) => r.job)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 50),
    };
  }
  get(id: string): WeeklyReceipt {
    const result = this.read().receipts[id];
    if (!result) throw new NotFoundException('周会任务不存在');
    return result;
  }
  pending() {
    return Object.values(this.read().receipts).filter((r) =>
      ['accepted', 'running', 'deleting'].includes(r.job.status),
    );
  }
  notifications() {
    return Object.values(this.read().receipts).filter(
      (r) =>
        canNotifyWeeklyReport(r) &&
        r.job.notification &&
        ['pending', 'sending'].includes(r.job.notification.status),
    );
  }
  completeGeneration(id: string, job: Partial<WeeklyJob>, chatId: string) {
    return this.transaction((ledger) => {
      const receipt = ledger.receipts[id];
      if (!receipt) throw new NotFoundException('周会任务不存在');
      Object.assign(receipt.job, job, {
        status: 'success',
        stage: 'done',
        updatedAt: new Date().toISOString(),
      });
      const command = receipt.command as GenerateWeeklyReport;
      const uuid = createHash('sha256')
        .update(`report:${chatId}:${receipt.job.targetRecordId}`)
        .digest('hex')
        .slice(0, 32);
      if (
        !command.expectedDocumentUrl &&
        canNotifyWeeklyReport(receipt) &&
        !Object.values(ledger.receipts).some(
          (r) =>
            canNotifyWeeklyReport(r) &&
            r.job.targetRecordId === receipt.job.targetRecordId &&
            r.job.notification?.chatId === chatId,
        )
      ) {
        receipt.job.notification = {
          status: 'pending',
          chatId,
          uuid,
          link: receipt.job.documentUrl,
          attempts: 0,
          error: null,
        };
      }
      delete receipt.artifact;
      return receipt.job;
    });
  }
  actionReplay(command: EditMeetingAction, actor: string) {
    const existing = this.read().receipts[command.clientMutationId];
    if (!existing) return null;
    if (existing.job.kind !== 'action-edit')
      throw new ConflictException('提交编号已用于其他操作');
    return this.replay(
      'action-edit',
      { ...existing.command, ...command } as PreparedActionEdit,
      actor,
    );
  }
  actionOwners() {
    return Object.values(this.read().receipts)
      .filter((r) => r.job.kind === 'action-edit' && r.job.status === 'success')
      .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
      .map((r) => r.preparedAction || (r.command as PreparedActionEdit));
  }
  completedImages() {
    return Object.values(this.read().receipts)
      .filter(
        (receipt) =>
          receipt.job.kind === 'attachments' &&
          receipt.job.status === 'success',
      )
      .map((receipt) => receipt.command as WeeklyAttachmentCommand);
  }
  replay(
    kind: WeeklyJob['kind'],
    command: WeeklyReceipt['command'],
    actor: string,
  ): WeeklyJob | null {
    const existing = this.read().receipts[command.clientMutationId];
    if (!existing) return null;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ kind, command }))
      .digest('hex');
    if (existing.fingerprint !== fingerprint || existing.actor !== actor)
      throw new ConflictException('同一提交编号不能用于不同内容或账号');
    return existing.job;
  }
  accept(
    kind: WeeklyJob['kind'],
    command: WeeklyReceipt['command'],
    actor: string,
  ): WeeklyJob {
    if (!/^[A-Za-z0-9-]{8,100}$/.test(command.clientMutationId))
      throw new BadRequestException('提交编号无效');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ kind, command }))
      .digest('hex');
    return this.transaction((ledger) => {
      const existing = ledger.receipts[command.clientMutationId];
      if (
        Object.values(ledger.receipts).some((receipt) =>
          Object.prototype.hasOwnProperty.call(
            receipt.taskOperations || {},
            command.clientMutationId,
          ),
        )
      )
        throw new ConflictException('提交编号已用于任务删除或恢复');
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.actor !== actor)
          throw new ConflictException('同一提交编号不能用于不同内容或账号');
        return existing.job;
      }
      const targetRecordId =
        kind === 'meeting'
          ? (command as SaveWeeklyMeeting).meeting.targetRecordId
          : (command as GenerateWeeklyReport).targetRecordId;
      const conflict = Object.values(ledger.receipts).find(
        (r) =>
          weeklyTargetsOverlap(r.job, {
            kind,
            targetRecordId,
            endDate:
              kind === 'generate'
                ? (command as GenerateWeeklyReport).endDate
                : undefined,
          }) &&
          !(
            kind === 'action-edit' &&
            r.job.kind === 'action-edit' &&
            (r.command as EditMeetingAction).actionId !==
              (command as EditMeetingAction).actionId
          ) &&
          ['accepted', 'running', 'uncertain', 'deleting'].includes(
            r.job.status,
          ),
      );
      if (conflict)
        throw new ConflictException(
          conflict.job.status === 'uncertain'
            ? '该周报有结果待核对的任务，请先核对已有任务'
            : '该周报有未完成任务，请先处理',
        );
      const now = new Date().toISOString();
      const job: WeeklyJob = {
        id: command.clientMutationId,
        kind,
        targetRecordId,
        status: 'accepted',
        stage: 'queued',
        attempts: 0,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      let before: WeeklyMeetingEntry | undefined;
      if (kind === 'meeting') {
        const input = command as SaveWeeklyMeeting;
        before = ledger.meetings.find(
          (m) =>
            m.targetRecordId === targetRecordId &&
            m.kind === input.meeting.kind,
        );
        if ((before?.version || 0) !== input.expectedVersion)
          throw new ConflictException('会议已被修改，请重新打开核对');
        job.meeting = {
          ...input.meeting,
          todos:
            input.meeting.status !== 'held' && !input.todoOnly
              ? before?.todos || []
              : input.meeting.todos,
          id: before?.id || randomUUID(),
          version: (before?.version || 0) + 1,
          mutationId: job.id,
          updatedAt: now,
        };
      } else if (kind === 'attachments') {
        job.attachmentNames = (command as WeeklyAttachmentCommand).files.map(
          (file) => file.name,
        );
      } else if (kind === 'generate') {
        Object.assign(job, {
          startDate: (command as GenerateWeeklyReport).startDate,
          endDate: (command as GenerateWeeklyReport).endDate,
          createOnly: (command as GenerateWeeklyReport).createOnly,
        });
      }
      ledger.receipts[job.id] = {
        sequence: Object.keys(ledger.receipts).length + 1,
        fingerprint,
        command,
        actor,
        job,
        before,
      };
      return job;
    });
  }
  change(id: string, change: Partial<WeeklyReceipt>, job: Partial<WeeklyJob>) {
    return this.transaction((ledger) => {
      const receipt = ledger.receipts[id];
      if (!receipt) throw new NotFoundException('周会任务不存在');
      Object.assign(receipt, change);
      Object.assign(receipt.job, job, { updatedAt: new Date().toISOString() });
      if (receipt.job.status === 'success') delete receipt.artifact;
      if (receipt.job.status === 'success' && receipt.job.meeting) {
        ledger.meetings = ledger.meetings.filter(
          (m) => m.id !== receipt.job.meeting?.id,
        );
        ledger.meetings.push(receipt.job.meeting);
      }
      return receipt.job;
    });
  }
  private taskOperation(
    ledger: Ledger,
    id: string,
    mutationId: string,
    actor: string,
    action: 'delete' | 'restore',
  ) {
    if (
      typeof mutationId !== 'string' ||
      !/^[A-Za-z0-9-]{8,100}$/.test(mutationId)
    )
      throw new BadRequestException('提交编号无效');
    const receipt = ledger.receipts[id];
    if (!receipt) throw new NotFoundException('周会任务不存在');
    if (ledger.receipts[mutationId])
      throw new ConflictException('提交编号已用于其他操作');
    for (const other of Object.values(ledger.receipts)) {
      if (
        !Object.prototype.hasOwnProperty.call(
          other.taskOperations || {},
          mutationId,
        )
      )
        continue;
      const op = other.taskOperations![mutationId];
      if (other.job.id !== id || op.actor !== actor || op.action !== action)
        throw new ConflictException('同一提交编号不能用于不同任务、操作或账号');
      return true;
    }
    receipt.taskOperations = Object.assign(
      Object.create(null),
      receipt.taskOperations,
    );
    receipt.taskOperations![mutationId] = { actor, action };
    return false;
  }
  deleteTask(id: string, mutationId: string, actor: string): WeeklyJob {
    return this.transaction((ledger) => {
      if (this.taskOperation(ledger, id, mutationId, actor, 'delete'))
        return ledger.receipts[id].job;
      const receipt = ledger.receipts[id];
      const job = receipt.job;
      if (
        !canDeleteWeeklyTask(job) ||
        !validWeeklyDate(job.endDate) ||
        receipt.createdRowId
      )
        throw new ConflictException(
          '仅能删除未确认创建的失败或待核对条目任务；已创建条目须先核对',
        );
      const now = new Date().toISOString();
      job.deletion = {
        clientMutationId: mutationId,
        status: 'checking',
        previousStatus: job.status as 'error' | 'uncertain',
        requestedAt: now,
        error: null,
      };
      job.status = 'deleting';
      job.updatedAt = now;
      return job;
    });
  }
  finishTaskDeletion(id: string, error?: string): WeeklyJob {
    return this.transaction((ledger) => {
      const job = ledger.receipts[id]?.job;
      if (
        !job ||
        job.status !== 'deleting' ||
        job.deletion?.status !== 'checking'
      )
        throw new ConflictException('删除任务状态已变化，请核对');
      const now = new Date().toISOString();
      job.status = error ? job.deletion.previousStatus : 'deleted';
      job.deletion = {
        ...job.deletion,
        status: error ? 'error' : 'success',
        completedAt: now,
        error: error || null,
      };
      job.updatedAt = now;
      return job;
    });
  }
  restoreTask(id: string, mutationId: string, actor: string): WeeklyJob {
    return this.transaction((ledger) => {
      if (this.taskOperation(ledger, id, mutationId, actor, 'restore'))
        return ledger.receipts[id].job;
      const receipt = ledger.receipts[id];
      const job = receipt.job;
      if (job.status !== 'deleted' || !job.deletion)
        throw new ConflictException('只能恢复已删除任务');
      if (
        Object.values(ledger.receipts).some(
          (other) =>
            other.job.id !== id &&
            other.job.status !== 'deleted' &&
            weeklyTargetsOverlap(other.job, job) &&
            (other.sequence || 0) > (receipt.sequence || 0),
        )
      )
        throw new ConflictException('该日期已有新任务，不能恢复旧任务');
      job.status = job.deletion.previousStatus;
      job.deletion = { ...job.deletion, status: 'restored' };
      job.updatedAt = new Date().toISOString();
      return job;
    });
  }
  retry(id: string, actor: string) {
    const receipt = this.get(id);
    if (receipt.actor !== actor)
      throw new ConflictException('请使用提交该任务的账号重试');
    if (receipt.job.status !== 'error')
      throw new ConflictException('该任务不能自动重试');
    if (
      Object.values(this.read().receipts).some(
        (other) =>
          other.job.id !== id &&
          other.job.status !== 'deleted' &&
          weeklyTargetsOverlap(other.job, receipt.job) &&
          (other.sequence !== undefined && receipt.sequence !== undefined
            ? other.sequence > receipt.sequence
            : other.job.createdAt >= receipt.job.createdAt),
      )
    )
      throw new ConflictException('该任务已有后续提交，请核对最新记录');
    return this.change(id, {}, { status: 'accepted', error: null });
  }
}
