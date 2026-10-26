import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
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
import { dirname, resolve } from 'node:path';
import {
  createProcessLockOwner,
  normalizeProcessLockOwner,
  processLockOwnerMayBeAlive,
} from '../../common/process-lock-owner';
import type {
  ThresholdAdjustment,
  ThresholdApprovalRole,
} from '../../../shared/threshold-adjustment.interface';

export interface ThresholdMessageReceipt {
  openId: string;
  messageId: string;
  uuid: string;
  kind: 'approval' | 'approval_result' | 'confirmation' | 'result';
  patchedRevision: number;
  round?: number;
}
export interface ThresholdAdjustmentEntry {
  adjustment: ThresholdAdjustment;
  fingerprint: string;
  actorId: string;
  cloudRecordId?: string;
  cloudRevision: number;
  messages: ThresholdMessageReceipt[];
  lease?: { owner: string; until: number };
  attempts: number;
  nextAttemptAt?: number;
}
interface Ledger {
  schema: 1;
  entries: Record<string, ThresholdAdjustmentEntry>;
}
const clone = <T>(value: T): T => structuredClone(value);
export const adjustmentFingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ThresholdAdjustmentStore {
  readonly path: string;
  private persisted = false;
  constructor(path: string) {
    this.path = resolve(path);
  }
  list() {
    return Object.values(this.read().entries).map(clone);
  }
  get(id: string) {
    return clone(this.read().entries[id]);
  }
  reserve(entry: ThresholdAdjustmentEntry) {
    return this.transaction((ledger) => {
      const previous = Object.values(ledger.entries).find(
        (e) =>
          e.adjustment.clientMutationId === entry.adjustment.clientMutationId,
      );
      if (previous) {
        if (
          previous.fingerprint !== entry.fingerprint ||
          previous.actorId !== entry.actorId
        )
          throw new ConflictException('提交标识已用于其他申请');
        return clone(previous);
      }
      if (
        Object.values(ledger.entries).some(
          (e) =>
            e.adjustment.before.id === entry.adjustment.before.id &&
            !['completed', 'rejected', 'conflict'].includes(e.adjustment.state),
        )
      )
        throw new ConflictException('该阈值已有未完成申请');
      ledger.entries[entry.adjustment.id] = clone(entry);
      return clone(entry);
    });
  }
  change(id: string, change: (entry: ThresholdAdjustmentEntry) => void) {
    return this.transaction((ledger) => {
      const entry = ledger.entries[id];
      if (!entry) throw new BadRequestException('阈值调整申请不存在');
      change(entry);
      return clone(entry);
    });
  }
  decide(input: {
    id: string;
    role: ThresholdApprovalRole;
    actorOpenId: string;
    messageId: string;
    eventId: string;
    action: 'approve' | 'reject';
    reason?: string;
  }) {
    let claimed = false;
    const entry = this.change(input.id, (entry) => {
      const a = entry.adjustment;
      const stage = a.stages.find((s) => s.role === input.role);
      if (
        !stage ||
        stage.approver.openId !== input.actorOpenId ||
        !entry.messages.some(
          (m) =>
            m.kind === 'approval' &&
            m.openId === input.actorOpenId &&
            m.messageId === input.messageId,
        )
      )
        throw new ForbiddenException('当前人员或消息无此审批权限');
      const reason = input.reason?.trim() || '';
      if (input.action === 'reject' && (!reason || reason.length > 500))
        throw new BadRequestException('请填写1–500字驳回原因');
      if (
        !['approve', 'reject'].includes(input.action) ||
        (input.action === 'approve' && reason)
      )
        throw new BadRequestException('审批动作无效');
      if (stage.decision || !['pending', 'routing'].includes(a.state)) return;
      if (!/^ws_threshold_[a-f0-9]{64}$/.test(input.eventId))
        throw new BadRequestException('审批事件无效');
      stage.decision = {
        action: input.action,
        actor: clone(stage.approver),
        at: new Date().toISOString(),
        eventId: input.eventId,
        messageId: input.messageId,
        reason,
      };
      a.state =
        input.action === 'reject'
          ? 'rejected'
          : a.stages.every((s) => s.decision?.action === 'approve')
            ? 'approved'
            : 'pending';
      a.revision++;
      a.syncState = 'pending';
      a.error = undefined;
      entry.nextAttemptAt = undefined;
      entry.attempts = 0;
      claimed = true;
    });
    return { entry, claimed };
  }
  recover(entry: ThresholdAdjustmentEntry) {
    assertEntry(entry.adjustment?.id, entry);
    return this.transaction((ledger) => {
      const previous = ledger.entries[entry.adjustment.id];
      if (!previous)
        ledger.entries[entry.adjustment.id] = {
          ...clone(entry),
          lease: undefined,
        };
      else if (
        previous.fingerprint !== entry.fingerprint ||
        previous.actorId !== entry.actorId ||
        (previous.adjustment.revision === entry.adjustment.revision &&
          adjustmentFingerprint(previous.adjustment) !==
            adjustmentFingerprint(entry.adjustment))
      )
        throw new ConflictException('阈值审批恢复证据冲突');
      else if (entry.adjustment.revision > previous.adjustment.revision)
        ledger.entries[entry.adjustment.id] = {
          ...clone(entry),
          lease: undefined,
        };
    });
  }
  confirm(input: {
    id: string;
    actorOpenId: string;
    messageId: string;
    eventId: string;
    completed: boolean;
  }) {
    let claimed = false;
    const entry = this.change(input.id, (e) => {
      const a = e.adjustment,
        execution = a.execution;
      const receipt = e.messages.find(
        (m) =>
          m.messageId === input.messageId &&
          m.kind === 'confirmation' &&
          m.openId === input.actorOpenId,
      );
      if (a.engineer.openId !== input.actorOpenId || !receipt || !execution)
        throw new ForbiddenException('当前人员或消息无调整确认权限');
      if (
        execution.replies.some((r) => r.messageId === input.messageId) ||
        a.state !== 'awaiting_completion' ||
        receipt.round !== execution.round
      )
        return;
      if (Date.parse(a.plannedAt) > Date.now())
        throw new ConflictException('尚未到预计调整时间');
      if (
        !/^ws_threshold_[a-f0-9]{64}$/.test(input.eventId) ||
        typeof input.completed !== 'boolean'
      )
        throw new BadRequestException('工程师确认事件无效');
      execution.replies.push({
        eventId: input.eventId,
        messageId: input.messageId,
        actor: clone(a.engineer),
        at: new Date().toISOString(),
        completed: input.completed,
      });
      if (input.completed) a.state = 'confirmed';
      else {
        execution.round++;
        execution.nextReminderAt = new Date(
          Date.now() + 86400000,
        ).toISOString();
      }
      a.revision++;
      a.syncState = 'pending';
      a.error = undefined;
      e.nextAttemptAt = undefined;
      e.attempts = 0;
      claimed = true;
    });
    return { entry, claimed };
  }
  claim(id: string, owner: string) {
    let claimed = false;
    this.change(id, (e) => {
      if (
        (!e.lease || e.lease.until < Date.now()) &&
        (!e.nextAttemptAt || e.nextAttemptAt <= Date.now())
      ) {
        e.lease = { owner, until: Date.now() + 180000 };
        claimed = true;
      }
    });
    return claimed;
  }
  private read(): Ledger {
    try {
      this.assertPath(this.path);
      if (!existsSync(this.path)) {
        if (this.persisted) throw new Error('missing');
        return { schema: 1, entries: Object.create(null) };
      }
      this.persisted = true;
      if (lstatSync(this.path).size > 24 * 1024 * 1024) throw new Error('size');
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as Ledger;
      if (value.schema !== 1 || !value.entries || Array.isArray(value.entries))
        throw new Error('schema');
      for (const [id, e] of Object.entries(value.entries)) {
        assertEntry(id, e);
      }
      value.entries = Object.assign(Object.create(null), value.entries);
      return value;
    } catch {
      throw new ServiceUnavailableException('阈值审批台账无效，原数据已保留');
    }
  }
  private transaction<T>(change: (ledger: Ledger) => T): T {
    this.assertPath(this.path);
    mkdirSync(dirname(this.path), { recursive: true });
    const lock = this.path + '.lock',
      owner = createProcessLockOwner(randomUUID());
    let fd: number;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      this.assertPath(lock);
      const existing = normalizeProcessLockOwner(
        JSON.parse(readFileSync(lock, 'utf8')),
      );
      if (
        !existing ||
        processLockOwnerMayBeAlive(existing, lstatSync(lock).mtimeMs)
      )
        throw new ConflictException('审批台账正在处理，请重试');
      const guard = lock + '.recovery';
      let recovery: number;
      try {
        recovery = openSync(guard, 'wx', 0o600);
      } catch {
        throw new ConflictException('审批台账正在恢复');
      }
      try {
        if (JSON.parse(readFileSync(lock, 'utf8')).token !== existing.token)
          throw new ConflictException('审批锁已变化');
        unlinkSync(lock);
        fd = openSync(lock, 'wx', 0o600);
      } finally {
        closeSync(recovery);
        unlinkSync(guard);
      }
    }
    const temp = this.path + '.' + owner.token + '.tmp';
    try {
      writeFileSync(fd, JSON.stringify(owner));
      fsyncSync(fd);
      const ledger = this.read(),
        result = change(ledger);
      for (const [id, entry] of Object.entries(ledger.entries))
        assertEntry(id, entry);
      const bytes = Buffer.from(JSON.stringify(ledger));
      if (bytes.length > 24 * 1024 * 1024)
        throw new ServiceUnavailableException('审批台账容量已满');
      const target = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(target, bytes);
        fsyncSync(target);
      } finally {
        closeSync(target);
      }
      renameSync(temp, this.path);
      this.persisted = true;
      return result;
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
      closeSync(fd);
      if (
        existsSync(lock) &&
        JSON.parse(readFileSync(lock, 'utf8')).token === owner.token
      )
        unlinkSync(lock);
    }
  }
  private assertPath(path: string) {
    if (path.slice(2).includes(':'))
      throw new ServiceUnavailableException('审批台账路径无效');
    for (let current = path; ; current = dirname(current)) {
      if (existsSync(current) && lstatSync(current).isSymbolicLink())
        throw new ServiceUnavailableException('审批台账不能使用链接路径');
      if (dirname(current) === current) break;
    }
  }
}
function assertEntry(id: string, e: ThresholdAdjustmentEntry) {
  const a = e?.adjustment,
    person = (p: unknown) =>
      !!p &&
      typeof p === 'object' &&
      /^ou_[A-Za-z0-9_-]+$/.test((p as { openId: string }).openId) &&
      typeof (p as { name: string }).name === 'string';
  if (
    !a ||
    a.id !== id ||
    !/^ta-[a-f0-9-]{36}$/.test(id) ||
    !Number.isSafeInteger(a.revision) ||
    a.revision < 1 ||
    a.policyVersion !== 'threshold-dual-approval-v1' ||
    ![
      'routing',
      'pending',
      'approved',
      'awaiting_completion',
      'confirmed',
      'applying',
      'completed',
      'rejected',
      'conflict',
    ].includes(a.state) ||
    !['pending', 'success', 'error'].includes(a.syncState) ||
    !person(a.applicant) ||
    !person(a.engineer) ||
    !Array.isArray(a.managers) ||
    !a.managers.every(person) ||
    !a.before?.id ||
    typeof a.before.value !== 'string' ||
    typeof a.value !== 'string' ||
    typeof a.reason !== 'string' ||
    !Number.isFinite(Date.parse(a.plannedAt)) ||
    !/^threshold-[A-Za-z0-9_-]{8,140}$/.test(a.clientMutationId) ||
    !/^[a-f0-9]{64}$/.test(e.fingerprint) ||
    typeof e.actorId !== 'string' ||
    !e.actorId ||
    !Array.isArray(a.stages) ||
    a.stages.length !== 2 ||
    !a.stages.some((s) => s.role === 'building') ||
    !a.stages.some((s) => s.role === 'professional') ||
    !Array.isArray(e.messages) ||
    !Number.isSafeInteger(e.cloudRevision) ||
    e.cloudRevision < 0 ||
    !Number.isSafeInteger(e.attempts) ||
    e.attempts < 0
  )
    throw new ServiceUnavailableException('阈值审批恢复数据无效');
  for (const s of a.stages)
    if (
      !person(s.approver) ||
      (s.decision &&
        (s.decision.actor.openId !== s.approver.openId ||
          !['approve', 'reject'].includes(s.decision.action) ||
          !Number.isFinite(Date.parse(s.decision.at)) ||
          !/^ws_threshold_[a-f0-9]{64}$/.test(s.decision.eventId)))
    )
      throw new ServiceUnavailableException('阈值审批决议无效');
  if (
    [
      'approved',
      'awaiting_completion',
      'confirmed',
      'applying',
      'completed',
    ].includes(a.state) &&
    !a.stages.every((s) => s.decision?.action === 'approve')
  )
    throw new ServiceUnavailableException('阈值审批缺少双审批证据');
  if (
    a.execution &&
    (!Number.isSafeInteger(a.execution.round) ||
      a.execution.round < 1 ||
      !Number.isFinite(Date.parse(a.execution.nextReminderAt)) ||
      !Array.isArray(a.execution.replies) ||
      !a.execution.replies.every(
        (r) =>
          r.actor.openId === a.engineer.openId &&
          typeof r.completed === 'boolean' &&
          Number.isFinite(Date.parse(r.at)),
      ))
  )
    throw new ServiceUnavailableException('工程师确认回执无效');
  if (
    ['confirmed', 'applying', 'completed'].includes(a.state) &&
    !a.execution?.replies.some((r) => r.completed)
  )
    throw new ServiceUnavailableException('阈值调整缺少完成确认');
  if (
    e.messages.some(
      (m) =>
        !person({ openId: m.openId, name: '' }) ||
        !m.messageId ||
        !['approval', 'approval_result', 'confirmation', 'result'].includes(
          m.kind,
        ) ||
        !Number.isSafeInteger(m.patchedRevision) ||
        m.patchedRevision < 1,
    )
  )
    throw new ServiceUnavailableException('阈值审批消息回执无效');
}
