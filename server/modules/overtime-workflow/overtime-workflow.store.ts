import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { readEnv } from '../../common/config/external-services.config';
import { assertOvertimeApplicationCoverage } from '../../common/access/personnel-handover.coverage';
import type {
  OvertimeApplicationSnapshot,
  OvertimeApprovalCardAction,
  OvertimeRoutePerson,
  OvertimeWorkflowPhase,
} from './overtime-workflow.types';

export const OVERTIME_WORKFLOW_LEDGER_PATH = Symbol(
  'OVERTIME_WORKFLOW_LEDGER_PATH',
);
export const OVERTIME_WORKFLOW_LEGACY_LEDGER_PATH = Symbol(
  'OVERTIME_WORKFLOW_LEGACY_LEDGER_PATH',
);

const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,124}$/u;
const MAX_ERROR_LENGTH = 500;
const DEFAULT_LEASE_MS = 60_000;
const MAX_LEASE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const BASE_RETRY_MS = 2_000;
const MAX_RETRY_MS = 30 * 60 * 1_000;
const MAX_TASKS = 5_000;
const TERMINAL_TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_APPLICATIONS = 5_000;
const MAX_ACTIONS = 5_000;
const MAX_CONFIRMATIONS = 5_000;

const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b((?:tenant[_-]?access[_-]?token|access[_-]?token|verification[_-]?token|encrypt[_-]?key|app[_-]?secret|password|secret|token)\s*[:=]\s*)([^\s,;}&]+)/giu;

export type OvertimeWorkflowQueueStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed';

export type OvertimeWorkflowTaskKind =
  | 'route_application'
  | 'deliver_approval_cards'
  | 'apply_approval'
  | 'notify_managers'
  | 'deliver_confirmation'
  | 'apply_confirmation'
  | 'sync_confirmation_handover'
  | 'sync_approval_handover';
// Handover effects are persisted independently from approval decisions.
export interface OvertimeApprovalHandoverInput {
  recordId: string;
  mutationId: string;
  dutyRecordId: string;
  sourceOpenId: string;
  sourcePersonRecordId: string;
  expectedRevision: number;
  target: OvertimeRoutePerson & { personRecordId: string };
}
export interface OvertimeApprovalHandoverReceipt {
  status: 'accepted' | 'already_completed';
  generation: number;
  taskBusinessKey: string | null;
}

export interface OvertimeWorkflowMessageDelivery {
  recipientOpenId: string;
  messageId: string;
  businessKey: string;
}

export interface OvertimeWorkflowMessageIntent {
  recipientOpenId: string;
  businessKey: string;
  messageUuid: string;
  createdAt: string;
}

export interface OvertimeWorkflowCardPatchEntry {
  messageId: string;
  patchedAt: string;
}

export interface OvertimeWorkflowApplicationEntry {
  key: string;
  recordId: string;
  clientMutationId: string;
  fingerprint: string;
  snapshot: OvertimeApplicationSnapshot;
  phase: OvertimeWorkflowPhase;
  approvers: OvertimeRoutePerson[];
  managerRecipients: OvertimeRoutePerson[];
  // Absent on legacy applications; resolve once before their next result notice.
  professionalRecipients?: OvertimeRoutePerson[];
  approvalCards: OvertimeWorkflowMessageDelivery[];
  approvalCardPatches: OvertimeWorkflowCardPatchEntry[];
  managerNoticeCards: OvertimeWorkflowMessageDelivery[];
  confirmationCards: OvertimeWorkflowMessageDelivery[];
  confirmationResultIntents: OvertimeWorkflowMessageIntent[];
  confirmationResultCards: OvertimeWorkflowMessageDelivery[];
  sourceDeletedCardPatches: OvertimeWorkflowCardPatchEntry[];
  actualApproverOpenId: string;
  actualApproverName: string;
  confirmationResponsible?: { openId: string; name: string; personRecordId: string; generation: number };
  approvedAt: string;
  rejectedAt: string;
  confirmedAt: string;
  sourceDeletedAt: string;
  revision: number;
  approvalGeneration?: number;
  createdAt: string;
  updatedAt: string;
  lastError: string;
}

export type OvertimeWorkflowApplicationPatch = Partial<
  Pick<
    OvertimeWorkflowApplicationEntry,
    | 'snapshot'
    | 'phase'
    | 'approvers'
    | 'managerRecipients'
    | 'professionalRecipients'
    | 'approvalCards'
    | 'managerNoticeCards'
    | 'confirmationCards'
    | 'confirmationResultIntents'
    | 'confirmationResultCards'
    | 'actualApproverOpenId'
    | 'actualApproverName'
    | 'approvedAt'
    | 'rejectedAt'
    | 'confirmedAt'
    | 'lastError'
  >
>;

export interface OvertimeWorkflowTaskEntry {
  key: string;
  businessKey: string;
  recordId: string;
  kind: OvertimeWorkflowTaskKind;
  payload: Record<string, unknown>;
  messageUuid: string;
  status: OvertimeWorkflowQueueStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  leaseUntil: string;
  claimToken: string;
  completedAt: string;
  lastError: string;
}

export interface OvertimeWorkflowApprovalActionEntry {
  key: string;
  eventId: string;
  recordId: string;
  action: OvertimeApprovalCardAction;
  actorOpenId: string;
  actorName: string;
  messageId: string;
  createdAt: string;
}

export type OvertimeConfirmationDisposition = '调休' | '加班费' | '费用结算';

export interface OvertimeConfirmationDraft {
  actualStartAt: string;
  actualEndAt?: string;
  actualHours: number;
  disposition: OvertimeConfirmationDisposition | null;
}

export interface OvertimeWorkflowConfirmationEntry {
  key: string;
  mutationId: string;
  recordId: string;
  actorOpenId: string;
  fingerprint: string;
  draft: OvertimeConfirmationDraft;
  createdAt: string;
}

export interface OvertimeWorkflowAcceptApplicationInput {
  clientMutationId: string;
  snapshot: OvertimeApplicationSnapshot;
}

export interface OvertimeWorkflowRecoverConfirmationInput {
  snapshot: OvertimeApplicationSnapshot;
  actualApprover: OvertimeRoutePerson;
  managerRecipients: OvertimeRoutePerson[];
  approvedAt: string;
}

export interface OvertimeWorkflowApprovalActionInput {
  eventId: string;
  recordId: string;
  action: OvertimeApprovalCardAction;
  actorOpenId: string;
  messageId: string;
}

export interface OvertimeWorkflowConfirmationInput {
  mutationId: string;
  recordId: string;
  actorOpenId: string;
  confirmationGeneration?: number;
  draft: OvertimeConfirmationDraft;
}

interface OvertimeWorkflowLedger {
  version: 1;
  applications: OvertimeWorkflowApplicationEntry[];
  tasks: OvertimeWorkflowTaskEntry[];
  approvalActions: OvertimeWorkflowApprovalActionEntry[];
  confirmations: OvertimeWorkflowConfirmationEntry[];
}

@Injectable()
export class OvertimeWorkflowStore {
  private readonly ledgerPath: string;
  private readonly legacyLedgerPath: string;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(
    @Optional() @Inject(OVERTIME_WORKFLOW_LEDGER_PATH) ledgerPath?: string,
    @Optional()
    @Inject(OVERTIME_WORKFLOW_LEGACY_LEDGER_PATH)
    legacyLedgerPath?: string,
  ) {
    this.ledgerPath = resolve(
      ledgerPath ||
        readEnv('OVERTIME_WORKFLOW_LEDGER_PATH') ||
        'data/overtime-workflow/ledger.json',
    );
    this.legacyLedgerPath = resolve(
      legacyLedgerPath || 'data/overtime-workflow/ledger.json',
    );
  }

  async onModuleInit(now: Date | number = new Date()): Promise<void> {
    return runHotfixInitialization(this, async () => {
      await this.enqueue(async () => {
        const ledger = await this.read();
        const resolvedNow = resolveNow(now);
        const timestamp = resolvedNow.toISOString();
        let changed = false;
        ledger.tasks = ledger.tasks.map((task) => {
          if (task.status !== 'processing') return task;
          changed = true;
          return {
            ...task,
            status: 'pending',
            updatedAt: timestamp,
            nextAttemptAt: timestamp,
            leaseUntil: '',
            claimToken: '',
          };
        });
        const taskCount = ledger.tasks.length;
        pruneExpiredTerminalTasks(ledger, resolvedNow);
        changed ||= taskCount !== ledger.tasks.length;
        if (changed) await this.write(ledger);
      });
    });
  }

  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
  }

  async acceptApplication(
    input: OvertimeWorkflowAcceptApplicationInput,
    now: Date | number = new Date(),
  ): Promise<{ created: boolean; entry: OvertimeWorkflowApplicationEntry }> {
    return this.enqueue(async () => {
      const normalized = normalizeApplicationInput(input);
      const fingerprint = fingerprintOf(normalized);
      const ledger = await this.read();
      const existing = ledger.applications.find(
        (entry) =>
          entry.recordId === normalized.snapshot.recordId ||
          entry.clientMutationId === normalized.clientMutationId,
      );
      if (existing) {
        if (
          existing.recordId !== normalized.snapshot.recordId ||
          existing.clientMutationId !== normalized.clientMutationId ||
          existing.fingerprint !== fingerprint
        ) {
          throw new ConflictException('加班工作流申请幂等键与已有内容冲突');
        }
        return { created: false, entry: clone(existing) };
      }
      if (ledger.applications.length >= MAX_APPLICATIONS) {
        throw new ConflictException('加班工作流本地账本已满');
      }
      const timestamp = resolveNow(now).toISOString();
      const entry: OvertimeWorkflowApplicationEntry = {
        key: `application:${normalized.snapshot.recordId}`,
        recordId: normalized.snapshot.recordId,
        clientMutationId: normalized.clientMutationId,
        fingerprint,
        snapshot: normalized.snapshot,
        phase: 'pending_approval',
        approvers: [],
        managerRecipients: [],
        approvalCards: [],
        approvalCardPatches: [],
        managerNoticeCards: [],
        confirmationCards: [],
        confirmationResultIntents: [],
        confirmationResultCards: [],
        sourceDeletedCardPatches: [],
        actualApproverOpenId: '',
        actualApproverName: '',
        approvedAt: '',
        rejectedAt: '',
        confirmedAt: '',
        sourceDeletedAt: '',
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastError: '',
      };
      ledger.applications.push(entry);
      enqueueTaskInLedger(
        ledger,
        {
          businessKey: `overtime:${entry.recordId}:route`,
          recordId: entry.recordId,
          kind: 'route_application',
          payload: {},
        },
        resolveNow(now),
      );
      await this.write(ledger);
      return { created: true, entry: clone(entry) };
    });
  }

  async recoverAwaitingConfirmationApplication(
    input: OvertimeWorkflowRecoverConfirmationInput,
    now: Date | number = new Date(),
  ): Promise<{ created: boolean; entry: OvertimeWorkflowApplicationEntry }> {
    return this.enqueue(async () => {
      const normalized = normalizeApplicationInput({
        clientMutationId: `base-recovery:${input?.snapshot?.recordId || ''}`,
        snapshot: input?.snapshot,
      });
      const [actualApprover] = normalizePeople([input?.actualApprover]);
      if (!actualApprover?.openId) {
        throw new BadRequestException('加班确认审批人无效');
      }
      const managerRecipients = normalizePeople(input?.managerRecipients || []);
      const approvedAt = requireDateTime(input?.approvedAt);
      const ledger = await this.read();
      const existing = ledger.applications.find(
        (entry) => entry.recordId === normalized.snapshot.recordId,
      );
      if (existing) {
        if (
          existing.actualApproverOpenId &&
          existing.actualApproverOpenId !== actualApprover.openId
        ) {
          throw new ConflictException('恢复的加班审批人与已有工作流记录不一致');
        }
        return { created: false, entry: clone(existing) };
      }
      if (ledger.applications.length >= MAX_APPLICATIONS) {
        throw new ConflictException('加班工作流本地账本已满');
      }
      const timestamp = resolveNow(now).toISOString();
      const entry: OvertimeWorkflowApplicationEntry = {
        key: `application:${normalized.snapshot.recordId}`,
        recordId: normalized.snapshot.recordId,
        clientMutationId: normalized.clientMutationId,
        fingerprint: fingerprintOf(normalized),
        snapshot: normalized.snapshot,
        phase: 'awaiting_confirmation',
        approvers: [actualApprover],
        managerRecipients,
        approvalCards: [],
        approvalCardPatches: [],
        managerNoticeCards: [],
        confirmationCards: [],
        confirmationResultIntents: [],
        confirmationResultCards: [],
        sourceDeletedCardPatches: [],
        actualApproverOpenId: actualApprover.openId,
        actualApproverName: actualApprover.name,
        approvedAt,
        rejectedAt: '',
        confirmedAt: '',
        sourceDeletedAt: '',
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastError: '',
      };
      ledger.applications.push(entry);
      await this.write(ledger);
      return { created: true, entry: clone(entry) };
    });
  }

  async getApplication(
    recordId: string,
  ): Promise<OvertimeWorkflowApplicationEntry | null> {
    const normalized = requireRecordId(recordId);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const entry = ledger.applications.find(
        (candidate) => candidate.recordId === normalized,
      );
      if (entry) return clone(entry);
      return this.recoverLegacyApplication(ledger, normalized);
    });
  }

  async listApplications(): Promise<OvertimeWorkflowApplicationEntry[]> {
    return this.enqueue(async () => clone((await this.read()).applications));
  }

  async acceptApprovalHandover(input: OvertimeApprovalHandoverInput, notificationsManaged?: () => boolean): Promise<OvertimeApprovalHandoverReceipt> {
    const recordId = requireRecordId(input?.recordId), mutationId = clean(input?.mutationId);
    const native = (value: unknown) => { if (typeof value !== 'string' || !/^rec[A-Za-z0-9_]+$/u.test(value)) throw new BadRequestException('岗位交接人员或职责身份无效'); return value; };
    const sourceOpenId = requireOpenId(input?.sourceOpenId), sourcePersonRecordId = native(input?.sourcePersonRecordId), dutyRecordId = native(input?.dutyRecordId);
    const [person] = normalizePeople([input?.target]);
    const target = { ...person, personRecordId: native(input?.target?.personRecordId) }, expectedRevision = input?.expectedRevision;
    if (!person?.openId || sourceOpenId === person.openId || sourcePersonRecordId === target.personRecordId || !/^handover-[a-f0-9]{64}$/u.test(mutationId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new BadRequestException('加班审批交接请求无效');
    const fingerprint = fingerprintOf({recordId,mutationId,dutyRecordId,sourceOpenId,sourcePersonRecordId,target,expectedRevision});
    return this.enqueue(async () => {
      const ledger = await this.read(), application = ledger.applications.find(entry => entry.recordId === recordId);
      if (!application) throw new NotFoundException('加班工作流申请不存在');
      const businessKey = `overtime:${recordId}:${mutationId}`, prior = ledger.tasks.find(task => task.businessKey === businessKey);
      if (prior) {
        if (prior.kind !== 'sync_approval_handover' || prior.payload.fingerprint !== fingerprint) throw new ConflictException('重复交接请求内容不一致');
        return {status:'accepted',generation:Number(prior.payload.targetGeneration),taskBusinessKey:businessKey};
      }
      if (ledger.approvalActions.some(action => action.recordId === recordId) || ['awaiting_confirmation','confirmed','rejected'].includes(application.phase)) return {status:'already_completed',generation:application.approvalGeneration ?? 1,taskBusinessKey:null};
      if (application.phase !== 'approval_pending' || application.revision !== expectedRevision || !application.approvers.some(actor => actor.openId === sourceOpenId)) throw new ConflictException('加班审批阶段已变化，请更新交接清单');
      assertOvertimeApplicationCoverage(sourceOpenId,application,ledger.tasks,notificationsManaged?.() === true);
      if (application.snapshot.applicantOpenId === target.openId) throw new ConflictException('接任人不能审批自己的申请');
      if (ledger.tasks.some(task => task.recordId === recordId && task.kind === 'sync_approval_handover' && task.payload.patchOnly !== true && task.status !== 'completed')) throw new ConflictException('上一交接尚未同步完成，请先恢复原交接');
      const sourceGeneration = application.approvalGeneration ?? 1, targetGeneration = sourceGeneration + 1, oldCards = clone(application.approvalCards);
      application.approvers = normalizePeople(application.approvers.map(actor => actor.openId === sourceOpenId ? target : actor));
      application.approvalCards = []; application.approvalCardPatches = [];
      application.approvalGeneration = targetGeneration; application.revision++; application.updatedAt = new Date().toISOString(); application.lastError = '';
      enqueueTaskInLedger(ledger,{businessKey,recordId,kind:'sync_approval_handover',payload:{mutationId,dutyRecordId,fingerprint,sourceOpenId,sourcePersonRecordId,target,sourceGeneration,targetGeneration,oldCards}},new Date());
      await this.write(ledger);
      return {status:'accepted',generation:targetGeneration,taskBusinessKey:businessKey};
    });
  }

  async acceptConfirmationHandover(input: OvertimeApprovalHandoverInput, notificationsManaged?: () => boolean): Promise<OvertimeApprovalHandoverReceipt> {
    const recordId = requireRecordId(input?.recordId), mutationId = clean(input?.mutationId);
    const native = (value: unknown): string => {
      if (typeof value !== 'string' || !/^rec[A-Za-z0-9_]+$/u.test(value)) throw new BadRequestException('岗位交接人员或职责身份无效');
      return value;
    };
    const sourceOpenId = requireOpenId(input?.sourceOpenId), sourcePersonRecordId = native(input?.sourcePersonRecordId), dutyRecordId = native(input?.dutyRecordId);
    const [person] = normalizePeople([input?.target]);
    const target = { ...person, personRecordId: native(input?.target?.personRecordId) }, expectedRevision = input?.expectedRevision;
    if (!person?.openId || sourceOpenId === person.openId || sourcePersonRecordId === target.personRecordId || !/^handover-[a-f0-9]{64}$/u.test(mutationId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new BadRequestException('加班确认交接请求无效');
    const fingerprint = fingerprintOf({ recordId, mutationId, dutyRecordId, sourceOpenId, sourcePersonRecordId, target, expectedRevision });
    return this.enqueue(async () => {
      const ledger = await this.read(), application = ledger.applications.find(entry => entry.recordId === recordId);
      if (!application) throw new NotFoundException('加班工作流申请不存在');
      const businessKey = `overtime:${recordId}:confirmation:${mutationId}`, prior = ledger.tasks.find(task => task.businessKey === businessKey);
      if (prior) {
        if (prior.kind !== 'sync_confirmation_handover' || prior.payload.fingerprint !== fingerprint) throw new ConflictException('重复确认交接请求内容不一致');
        return { status: 'accepted', generation: Number(prior.payload.targetGeneration), taskBusinessKey: businessKey };
      }
      const sourceGeneration = overtimeConfirmationGeneration(application);
      if (ledger.confirmations.some(entry => entry.recordId === recordId) || application.phase === 'confirmed') return { status: 'already_completed', generation: sourceGeneration, taskBusinessKey: null };
      if (application.phase !== 'awaiting_confirmation' || application.revision !== expectedRevision || overtimeConfirmationOwner(application) !== sourceOpenId || (application.confirmationResponsible && application.confirmationResponsible.personRecordId !== sourcePersonRecordId)) throw new ConflictException('加班确认阶段已变化，请更新交接清单');
      assertOvertimeApplicationCoverage(sourceOpenId,application,ledger.tasks,notificationsManaged?.() === true);
      if (!application.snapshot.applicantOpenId || application.snapshot.applicantOpenId === target.openId) throw new ConflictException('申请人身份缺失或接任人不能确认自己的申请');
      if (ledger.tasks.some(task => task.recordId === recordId && task.kind === 'sync_confirmation_handover' && task.payload.patchOnly !== true && task.status !== 'completed')) throw new ConflictException('上一确认交接尚未同步完成');
      if (ledger.tasks.some(task => task.recordId === recordId && task.kind === 'deliver_confirmation' && task.attempts > 0 && task.status !== 'completed')) throw new ConflictException('原确认卡片投递结果尚未明确，请先恢复原投递');
      const targetGeneration = sourceGeneration + 1;
      if (!Number.isSafeInteger(targetGeneration)) throw new ConflictException('加班确认代际已达上限');
      const oldCards = clone(application.confirmationCards);
      enqueueTaskInLedger(ledger, { businessKey, recordId, kind: 'sync_confirmation_handover', payload: { mutationId, dutyRecordId, fingerprint, sourceOpenId, sourcePersonRecordId, target, sourceGeneration, targetGeneration, oldCards } }, new Date());
      application.confirmationResponsible = { openId: target.openId, name: target.name, personRecordId: target.personRecordId, generation: targetGeneration };
      application.confirmationCards = [];
      application.revision++; application.updatedAt = new Date().toISOString(); application.lastError = '';
      await this.write(ledger);
      return { status: 'accepted', generation: targetGeneration, taskBusinessKey: businessKey };
    });
  }

  async recordConfirmationCardDelivery(recordIdValue: string, deliveryValue: OvertimeWorkflowMessageDelivery, generation: number): Promise<void> {
    const recordId = requireRecordId(recordIdValue), [delivery] = normalizeDeliveries([deliveryValue]);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new BadRequestException('加班确认代际无效');
    await this.enqueue(async () => {
      const ledger = await this.read(), application = ledger.applications.find(entry => entry.recordId === recordId);
      if (!application) throw new NotFoundException('加班工作流申请不存在');
      if (overtimeConfirmationGeneration(application) !== generation) {
        const transfer = ledger.tasks.find(task => task.recordId === recordId && task.kind === 'sync_confirmation_handover' && task.payload.patchOnly !== true && task.payload.sourceGeneration === generation);
        if (!transfer) throw new ConflictException('旧确认代际缺少可恢复交接任务');
        const businessKey = `overtime:${recordId}:confirmation-late:${createHash('sha256').update(delivery.messageId).digest('hex')}`;
        const prior = ledger.tasks.find(task => task.businessKey === businessKey);
        if (prior) { if (JSON.stringify(prior.payload.oldCards) !== JSON.stringify([delivery])) throw new ConflictException('旧确认卡片回执冲突'); return; }
        enqueueTaskInLedger(ledger, { businessKey, recordId, kind: 'sync_confirmation_handover', payload: { ...transfer.payload, oldCards: [delivery], patchOnly: true } }, new Date());
      } else {
        if (overtimeConfirmationOwner(application) !== delivery.recipientOpenId) throw new ForbiddenException('确认卡片接收人与当前负责人不匹配');
        const prior = application.confirmationCards.find(card => card.businessKey === delivery.businessKey);
        if (prior) { if (JSON.stringify(prior) !== JSON.stringify(delivery)) throw new ConflictException('确认卡片投递回执冲突'); return; }
        application.confirmationCards.push(delivery); application.revision++; application.updatedAt = new Date().toISOString();
      }
      await this.write(ledger);
    });
  }

  async recordApprovalCardDelivery(recordIdValue: string, deliveryValue: OvertimeWorkflowMessageDelivery, generation: number): Promise<void> {
    const recordId = requireRecordId(recordIdValue), [delivery] = normalizeDeliveries([deliveryValue]);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new BadRequestException('加班审批代际无效');
    await this.enqueue(async () => {
      const ledger = await this.read(), application = ledger.applications.find(entry => entry.recordId === recordId);
      if (!application) throw new NotFoundException('加班工作流申请不存在');
      if ((application.approvalGeneration ?? 1) !== generation) {
        const transfer = ledger.tasks.find(task => task.recordId === recordId && task.kind === 'sync_approval_handover' && task.payload.patchOnly !== true && task.payload.sourceGeneration === generation);
        if (!transfer) throw new ConflictException('旧审批代际缺少可恢复交接任务');
        const businessKey = `overtime:${recordId}:handover-late:${createHash('sha256').update(delivery.messageId).digest('hex')}`;
        const prior = ledger.tasks.find(task => task.businessKey === businessKey);
        if (prior) { if (JSON.stringify(prior.payload.oldCards) !== JSON.stringify([delivery])) throw new ConflictException('旧卡片补终态回执冲突'); return; }
        enqueueTaskInLedger(ledger,{businessKey,recordId,kind:'sync_approval_handover',payload:{...transfer.payload,oldCards:[delivery],patchOnly:true}},new Date());
      } else {
        if (!application.approvers.some(actor => actor.openId === delivery.recipientOpenId)) throw new ForbiddenException('审批卡片接收人与当前审批人不匹配');
        const existing = application.approvalCards.find(card => card.businessKey === delivery.businessKey);
        if (existing) { if (JSON.stringify(existing) !== JSON.stringify(delivery)) throw new ConflictException('审批卡片投递回执冲突'); return; }
        application.approvalCards.push(delivery); application.revision++; application.updatedAt = new Date().toISOString();
      }
      await this.write(ledger);
    });
  }

  async recordApprovalHandoverCardPatch(key: string, claimToken: string, messageIdValue: string): Promise<OvertimeWorkflowTaskEntry> {
    const messageId = requireMessageId(messageIdValue);
    const updated = await this.updateClaimedTask(key,claimToken,task => {
      const cards = task.payload.oldCards as OvertimeWorkflowMessageDelivery[];
      if (!['sync_approval_handover', 'sync_confirmation_handover'].includes(task.kind) || !Array.isArray(cards) || !cards.some(card => card.messageId === messageId)) throw new ConflictException('交接旧卡片与任务不匹配');
      const previous = task.payload.patchedMessageIds;
      if (previous !== undefined && (!Array.isArray(previous) || !previous.every(id => typeof id === 'string' && /^om_[A-Za-z0-9_-]+$/u.test(id)))) throw new BadRequestException('交接旧卡片回执无效');
      return {...task,payload:{...task.payload,patchedMessageIds:[...new Set([...(previous as string[] || []),messageId])]},updatedAt:new Date().toISOString()};
    });
    if (!updated) throw new ConflictException('交接任务处理权已变化');
    return updated;
  }

  async patchApplication(
    recordId: string,
    patch: OvertimeWorkflowApplicationPatch,
    options: { expectedRevision?: number; now?: Date | number } = {},
  ): Promise<OvertimeWorkflowApplicationEntry> {
    const normalizedRecordId = requireRecordId(recordId);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const index = ledger.applications.findIndex(
        (entry) => entry.recordId === normalizedRecordId,
      );
      if (index < 0) throw new NotFoundException('加班工作流申请不存在');
      const current = ledger.applications[index];
      if (
        options.expectedRevision !== undefined &&
        options.expectedRevision !== current.revision
      ) {
        throw new ConflictException('加班工作流申请已被更新，请重新读取');
      }
      const normalizedPatch = normalizeApplicationPatch(patch);
      const updated: OvertimeWorkflowApplicationEntry = {
        ...current,
        ...normalizedPatch,
        revision: current.revision + 1,
        updatedAt: resolveNow(options.now ?? new Date()).toISOString(),
      };
      ledger.applications[index] = updated;
      await this.write(ledger);
      return clone(updated);
    });
  }

  async markApprovalCardPatched(
    recordId: string,
    messageId: string,
    now: Date | number = new Date(),
  ): Promise<OvertimeWorkflowApplicationEntry> {
    const normalizedRecordId = requireRecordId(recordId);
    const normalizedMessageId = requireMessageId(messageId);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const application = ledger.applications.find(
        (entry) => entry.recordId === normalizedRecordId,
      );
      if (!application) throw new NotFoundException('加班工作流申请不存在');
      if (
        !application.approvalCards.some(
          (entry) => entry.messageId === normalizedMessageId,
        )
      ) {
        throw new BadRequestException('审批卡终态更新与已投递卡片不匹配');
      }
      if (
        application.approvalCardPatches.some(
          (entry) => entry.messageId === normalizedMessageId,
        )
      ) {
        return clone(application);
      }
      const timestamp = resolveNow(now).toISOString();
      application.approvalCardPatches.push({
        messageId: normalizedMessageId,
        patchedAt: timestamp,
      });
      application.revision += 1;
      application.updatedAt = timestamp;
      await this.write(ledger);
      return clone(application);
    });
  }

  async markSourceDeleted(
    recordId: string,
    now: Date | number = new Date(),
  ): Promise<OvertimeWorkflowApplicationEntry> {
    const normalizedRecordId = requireRecordId(recordId);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const application = ledger.applications.find(
        (entry) => entry.recordId === normalizedRecordId,
      );
      if (!application) throw new NotFoundException('加班工作流申请不存在');
      const timestamp = resolveNow(now).toISOString();
      let changed = false;
      if (application.phase !== 'source_deleted') {
        application.phase = 'source_deleted';
        application.sourceDeletedAt = timestamp;
        application.lastError = '底表记录已删除，工作流已终止';
        application.revision += 1;
        application.updatedAt = timestamp;
        changed = true;
      }
      for (const task of ledger.tasks) {
        if (
          task.recordId !== normalizedRecordId ||
          (task.status !== 'pending' && task.status !== 'processing')
        ) {
          continue;
        }
        task.status = 'completed';
        task.updatedAt = timestamp;
        task.completedAt = timestamp;
        task.leaseUntil = '';
        task.claimToken = '';
        task.lastError = '底表记录已删除，任务已终止';
        changed = true;
      }
      if (changed) await this.write(ledger);
      return clone(application);
    });
  }

  async markSourceDeletedCardPatched(
    recordId: string,
    messageId: string,
    now: Date | number = new Date(),
  ): Promise<OvertimeWorkflowApplicationEntry> {
    const normalizedRecordId = requireRecordId(recordId);
    const normalizedMessageId = requireMessageId(messageId);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const application = ledger.applications.find(
        (entry) => entry.recordId === normalizedRecordId,
      );
      if (!application) throw new NotFoundException('加班工作流申请不存在');
      if (application.phase !== 'source_deleted') {
        throw new ConflictException('加班工作流申请尚未撤销');
      }
      const deliveredMessageIds = new Set(
        allApplicationDeliveries(application).map((entry) => entry.messageId),
      );
      if (!deliveredMessageIds.has(normalizedMessageId)) {
        throw new BadRequestException('撤销卡终态更新与已投递卡片不匹配');
      }
      if (
        application.sourceDeletedCardPatches.some(
          (entry) => entry.messageId === normalizedMessageId,
        )
      ) {
        return clone(application);
      }
      const timestamp = resolveNow(now).toISOString();
      application.sourceDeletedCardPatches.push({
        messageId: normalizedMessageId,
        patchedAt: timestamp,
      });
      application.revision += 1;
      application.updatedAt = timestamp;
      await this.write(ledger);
      return clone(application);
    });
  }

  async enqueueTask(
    input: {
      businessKey: string;
      recordId: string;
      kind: OvertimeWorkflowTaskKind;
      payload?: Record<string, unknown>;
      availableAt?: Date | number | string;
    },
    now: Date | number = new Date(),
  ): Promise<{ created: boolean; task: OvertimeWorkflowTaskEntry }> {
    return this.enqueue(async () => {
      const ledger = await this.read();
      const timestamp = resolveNow(now);
      const pruned = pruneExpiredTerminalTasks(ledger, timestamp);
      const result = enqueueTaskInLedger(ledger, input, timestamp);
      if (result.created || pruned > 0) await this.write(ledger);
      return { created: result.created, task: clone(result.task) };
    });
  }

  async takeNextTask(
    now: Date | number = new Date(),
    leaseMs = DEFAULT_LEASE_MS,
  ): Promise<OvertimeWorkflowTaskEntry | null> {
    return this.enqueue(async () => {
      const timestamp = resolveNow(now);
      const ledger = await this.read();
      const index = ledger.tasks.findIndex((entry) =>
        isTaskAvailable(entry, timestamp),
      );
      if (index < 0) return null;
      const current = ledger.tasks[index];
      const updated: OvertimeWorkflowTaskEntry = {
        ...current,
        status: 'processing',
        attempts: Math.min(current.attempts + 1, 1_000_000),
        updatedAt: timestamp.toISOString(),
        leaseUntil: new Date(
          timestamp.getTime() + normalizeLeaseMs(leaseMs),
        ).toISOString(),
        claimToken: randomUUID(),
      };
      ledger.tasks[index] = updated;
      await this.write(ledger);
      return clone(updated);
    });
  }

  async completeTask(
    key: string,
    claimToken: string,
    now: Date | number = new Date(),
  ): Promise<OvertimeWorkflowTaskEntry | null> {
    return this.updateClaimedTask(key, claimToken, (entry) => {
      const timestamp = resolveNow(now).toISOString();
      return {
        ...entry,
        status: 'completed',
        updatedAt: timestamp,
        completedAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        lastError: '',
      };
    });
  }

  async rescheduleTask(
    key: string,
    claimToken: string,
    error: unknown,
    now: Date | number = new Date(),
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  ): Promise<OvertimeWorkflowTaskEntry | null> {
    return this.updateClaimedTask(key, claimToken, (entry) => {
      const timestamp = resolveNow(now);
      const terminal = entry.attempts >= Math.max(1, maxAttempts);
      const retryDelay = Math.min(
        BASE_RETRY_MS * 2 ** Math.max(0, entry.attempts - 1),
        MAX_RETRY_MS,
      );
      return {
        ...entry,
        status: terminal ? 'failed' : 'pending',
        updatedAt: timestamp.toISOString(),
        nextAttemptAt: terminal
          ? entry.nextAttemptAt
          : new Date(timestamp.getTime() + retryDelay).toISOString(),
        leaseUntil: '',
        claimToken: '',
        completedAt: terminal ? timestamp.toISOString() : '',
        lastError: sanitizeError(error),
      };
    });
  }

  async failTask(
    key: string,
    claimToken: string,
    error: unknown,
    now: Date | number = new Date(),
  ): Promise<OvertimeWorkflowTaskEntry | null> {
    return this.updateClaimedTask(key, claimToken, (entry) => {
      const timestamp = resolveNow(now).toISOString();
      return {
        ...entry,
        status: 'failed',
        updatedAt: timestamp,
        completedAt: timestamp,
        leaseUntil: '',
        claimToken: '',
        lastError: sanitizeError(error),
      };
    });
  }

  async getTask(key: string): Promise<OvertimeWorkflowTaskEntry | null> {
    const normalized = clean(key);
    return this.enqueue(async () => {
      const entry = (await this.read()).tasks.find(
        (candidate) => candidate.key === normalized,
      );
      return entry ? clone(entry) : null;
    });
  }

  async retryFailedTasks(keys: readonly string[], authorize: () => void): Promise<void> {
    if (!Array.isArray(keys) || keys.length > 1000 || new Set(keys).size !== keys.length || keys.some(key => typeof key !== 'string' || !key || key.length > 1000)) throw new BadRequestException('加班恢复任务范围无效');
    await this.enqueue(async () => {
      const ledger = await this.read(), tasks = keys.map(key => ledger.tasks.find(task => task.key === key));
      if (tasks.some(task => !task)) throw new ConflictException('原加班任务已变化');
      authorize(); let changed = false;
      for (const task of tasks) {
        if (!task || task.status !== 'failed' && !(task.status === 'pending' && task.lastError)) continue;
        task.status = 'pending'; task.nextAttemptAt = new Date().toISOString(); task.completedAt = ''; task.lastError = ''; task.claimToken = ''; task.leaseUntil = ''; changed = true;
      }
      if (changed) await this.write(ledger);
    });
  }

  async listTasks(): Promise<OvertimeWorkflowTaskEntry[]> {
    return this.enqueue(async () => clone((await this.read()).tasks));
  }
  async personnelHandoverSnapshot(): Promise<{applications:OvertimeWorkflowApplicationEntry[];tasks:OvertimeWorkflowTaskEntry[]}> {
    return this.enqueue(async()=>{const ledger=await this.read();return clone({applications:ledger.applications,tasks:ledger.tasks});});
  }

  async claimApprovalAction(
    input: OvertimeWorkflowApprovalActionInput,
    now: Date | number = new Date(),
    isCurrentActor?: (application: OvertimeWorkflowApplicationEntry, actorOpenId: string) => boolean,
  ): Promise<{
    claimed: boolean;
    entry: OvertimeWorkflowApprovalActionEntry;
  }> {
    return this.enqueue(async () => {
      const normalized = normalizeApprovalAction(input);
      const ledger = await this.read();
      const application = ledger.applications.find(
        (entry) => entry.recordId === normalized.recordId,
      );
      if (!application) throw new NotFoundException('加班工作流申请不存在');

      const eventReplay = ledger.approvalActions.find(
        (entry) => entry.eventId === normalized.eventId,
      );
      if (eventReplay) {
        if (
          fingerprintOf(eventReplay) !==
          fingerprintOf({ ...eventReplay, ...normalized })
        ) {
          throw new ConflictException('加班审批回调事件与已有内容冲突');
        }
        return { claimed: false, entry: clone(eventReplay) };
      }
      if (
        !constantTimeIncludes(
          normalized.actorOpenId,
          application.approvers.map((entry) => entry.openId),
        )
      ) {
        throw new ForbiddenException('当前人员不是该加班申请的审批人');
      }
      const deliveredCard = application.approvalCards.some(
        (delivery) =>
          constantTimeEqual(delivery.recipientOpenId, normalized.actorOpenId) &&
          constantTimeEqual(delivery.messageId, normalized.messageId),
      );
      if (!deliveredCard) {
        throw new ForbiddenException('审批动作与已投递的加班审批卡不匹配');
      }
      const existing = ledger.approvalActions.find(
        (entry) => entry.recordId === normalized.recordId,
      );
      if (existing) return { claimed: false, entry: clone(existing) };
      if (application.phase !== 'approval_pending') {
        throw new ConflictException('当前加班申请不在待审批状态');
      }
      if (isCurrentActor && isCurrentActor(clone(application), normalized.actorOpenId) !== true) throw new ForbiddenException('岗位负责人已变化，请打开最新审批入口');
      if (ledger.approvalActions.length >= MAX_ACTIONS) {
        throw new ConflictException('加班审批动作账本已满');
      }

      const approver = application.approvers.find(
        (entry) => entry.openId === normalized.actorOpenId,
      );
      const entry: OvertimeWorkflowApprovalActionEntry = {
        key: `approval:${normalized.recordId}`,
        ...normalized,
        actorName: approver?.name || '',
        createdAt: resolveNow(now).toISOString(),
      };
      ledger.approvalActions.push(entry);
      application.actualApproverOpenId = entry.actorOpenId;
      application.actualApproverName = entry.actorName;
      application.revision += 1;
      application.updatedAt = entry.createdAt;
      enqueueTaskInLedger(
        ledger,
        {
          businessKey: `overtime:${entry.recordId}:approval`,
          recordId: entry.recordId,
          kind: 'apply_approval',
          payload: { approvalActionKey: entry.key },
        },
        resolveNow(now),
      );
      await this.write(ledger);
      return { claimed: true, entry: clone(entry) };
    });
  }

  async getApprovalAction(
    recordId: string,
  ): Promise<OvertimeWorkflowApprovalActionEntry | null> {
    const normalized = requireRecordId(recordId);
    return this.enqueue(async () => {
      const entry = (await this.read()).approvalActions.find(
        (candidate) => candidate.recordId === normalized,
      );
      return entry ? clone(entry) : null;
    });
  }

  async claimConfirmationSubmission(
    input: OvertimeWorkflowConfirmationInput,
    now: Date | number = new Date(),
    isCurrentActor?: (application: OvertimeWorkflowApplicationEntry, actorOpenId: string) => boolean,
  ): Promise<{
    claimed: boolean;
    entry: OvertimeWorkflowConfirmationEntry;
  }> {
    return this.enqueue(async () => {
      const normalized = normalizeConfirmationInput(input);
      const fingerprint = fingerprintOf(normalized);
      const ledger = await this.read();
      const application = ledger.applications.find(
        (entry) => entry.recordId === normalized.recordId,
      );
      if (!application) throw new NotFoundException('加班工作流申请不存在');
      if (
        overtimeConfirmationOwner(application) &&
        !constantTimeEqual(
          normalized.actorOpenId,
          overtimeConfirmationOwner(application),
        )
      ) {
        throw new ForbiddenException('当前人员无权确认该加班信息');
      }
      if (!Number.isSafeInteger(input.confirmationGeneration ?? 1) || (input.confirmationGeneration ?? 1) !== overtimeConfirmationGeneration(application)) throw new ForbiddenException('加班确认入口已失效，请打开最新卡片');
      const replay = ledger.confirmations.find(
        (entry) => entry.mutationId === normalized.mutationId,
      );
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          throw new ConflictException('加班确认幂等键与已有草稿冲突');
        }
        return { claimed: false, entry: clone(replay) };
      }
      if (application.phase !== 'awaiting_confirmation') {
        throw new ConflictException('当前加班申请不在待确认状态');
      }
      const existing = ledger.confirmations.find(
        (entry) => entry.recordId === normalized.recordId,
      );
      if (existing) {
        throw new ConflictException('该加班记录的确认信息已受理');
      }
      if (isCurrentActor && isCurrentActor(clone(application), normalized.actorOpenId) !== true) throw new ForbiddenException('岗位负责人已变化，请打开最新确认入口');
      if (ledger.confirmations.length >= MAX_CONFIRMATIONS) {
        throw new ConflictException('加班确认账本已满');
      }
      const entry: OvertimeWorkflowConfirmationEntry = {
        key: `confirmation:${normalized.recordId}`,
        ...normalized,
        fingerprint,
        createdAt: resolveNow(now).toISOString(),
      };
      ledger.confirmations.push(entry);
      enqueueTaskInLedger(
        ledger,
        {
          businessKey: `overtime:${entry.recordId}:confirmation`,
          recordId: entry.recordId,
          kind: 'apply_confirmation',
          payload: { confirmationKey: entry.key },
        },
        resolveNow(now),
      );
      await this.write(ledger);
      return { claimed: true, entry: clone(entry) };
    });
  }

  async getConfirmation(
    recordId: string,
  ): Promise<OvertimeWorkflowConfirmationEntry | null> {
    const normalized = requireRecordId(recordId);
    return this.enqueue(async () => {
      const entry = (await this.read()).confirmations.find(
        (candidate) => candidate.recordId === normalized,
      );
      return entry ? clone(entry) : null;
    });
  }

  async listConfirmations(): Promise<OvertimeWorkflowConfirmationEntry[]> {
    return this.enqueue(async () => clone((await this.read()).confirmations));
  }

  async enqueueDailyConfirmationReminder(
    recordId: string,
    recipientOpenId: string,
    now: Date | number = new Date(),
  ): Promise<{ created: boolean; task: OvertimeWorkflowTaskEntry }> {
    const normalizedRecordId = requireRecordId(recordId);
    const normalizedRecipient = requireOpenId(recipientOpenId);
    const timestamp = resolveNow(now);
    const shanghaiDate = formatShanghaiDate(timestamp);
    const application = await this.getApplication(normalizedRecordId);
    const generation = application ? overtimeConfirmationGeneration(application) : 1;
    if (application && overtimeConfirmationOwner(application) !== normalizedRecipient) throw new ForbiddenException('确认提醒接收人与当前负责人不匹配');
    return this.enqueueTask(
      {
        businessKey: `overtime-confirm:${normalizedRecordId}:${shanghaiDate}${generation > 1 ? `:v${generation}` : ''}`,
        recordId: normalizedRecordId,
        kind: 'deliver_confirmation',
        payload: {
          recipientOpenId: normalizedRecipient,
          shanghaiDate,
          ...(generation > 1 ? { confirmationGeneration: generation } : {}),
        },
      },
      timestamp,
    );
  }

  async enqueueInitialConfirmationReminder(
    recordId: string,
    recipientOpenId: string,
    plannedEndAt: Date | number | string,
    now: Date | number = new Date(),
  ): Promise<{ created: boolean; task: OvertimeWorkflowTaskEntry }> {
    const normalizedRecordId = requireRecordId(recordId);
    const normalizedRecipient = requireOpenId(recipientOpenId);
    const availableAt = resolveNow(plannedEndAt);
    return this.enqueueTask(
      {
        businessKey: initialOvertimeConfirmationBusinessKey(normalizedRecordId),
        recordId: normalizedRecordId,
        kind: 'deliver_confirmation',
        payload: {
          recipientOpenId: normalizedRecipient,
          reminderKind: 'initial',
        },
        availableAt,
      },
      now,
    );
  }

  private async updateClaimedTask(
    key: string,
    claimToken: string,
    updater: (entry: OvertimeWorkflowTaskEntry) => OvertimeWorkflowTaskEntry,
  ): Promise<OvertimeWorkflowTaskEntry | null> {
    const normalizedKey = clean(key);
    const normalizedToken = clean(claimToken);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const index = ledger.tasks.findIndex(
        (entry) => entry.key === normalizedKey,
      );
      const current = index >= 0 ? ledger.tasks[index] : null;
      if (
        !current ||
        current.status !== 'processing' ||
        !normalizedToken ||
        current.claimToken !== normalizedToken
      ) {
        return null;
      }
      const updated = updater(current);
      ledger.tasks[index] = updated;
      await this.write(ledger);
      return clone(updated);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = () => operation();
    const result = this.operation.then(run, run);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async read(): Promise<OvertimeWorkflowLedger> {
    return this.readFrom(this.ledgerPath);
  }

  private async readFrom(path: string): Promise<OvertimeWorkflowLedger> {
    try {
      const parsed = JSON.parse(
        await readFile(path, 'utf8'),
      ) as Partial<OvertimeWorkflowLedger>;
      return {
        version: 1,
        applications: Array.isArray(parsed.applications)
          ? parsed.applications
              .filter(isApplicationEntry)
              .map(normalizePersistedApplicationEntry)
          : [],
        tasks: Array.isArray(parsed.tasks)
          ? uniqueBy(
              parsed.tasks.filter(isTaskEntry),
              (entry) => entry.businessKey,
            )
          : [],
        approvalActions: Array.isArray(parsed.approvalActions)
          ? uniqueBy(
              parsed.approvalActions.filter(isApprovalActionEntry),
              (entry) => entry.recordId,
            ).slice(-MAX_ACTIONS)
          : [],
        confirmations: Array.isArray(parsed.confirmations)
          ? uniqueBy(
              parsed.confirmations.filter(isConfirmationEntry),
              (entry) => entry.recordId,
            ).slice(-MAX_CONFIRMATIONS)
          : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return emptyLedger();
      throw error;
    }
  }

  private async recoverLegacyApplication(
    ledger: OvertimeWorkflowLedger,
    recordId: string,
  ): Promise<OvertimeWorkflowApplicationEntry | null> {
    if (this.legacyLedgerPath === this.ledgerPath) return null;
    const legacy = await this.readFrom(this.legacyLedgerPath);
    const application = legacy.applications.find(
      (candidate) => candidate.recordId === recordId,
    );
    if (!application) return null;
    if (
      ledger.applications.some(
        (candidate) =>
          candidate.clientMutationId === application.clientMutationId,
      )
    ) {
      throw new ConflictException('旧加班工作流账本与当前账本申请幂等键冲突');
    }
    if (ledger.applications.length >= MAX_APPLICATIONS) {
      throw new ConflictException('加班工作流本地账本已满');
    }

    ledger.applications.push(application);
    ledger.tasks = uniqueBy(
      [
        ...legacy.tasks.filter((entry) => entry.recordId === recordId),
        ...ledger.tasks,
      ],
      (entry) => entry.businessKey,
    );
    ledger.approvalActions = uniqueBy(
      [
        ...legacy.approvalActions.filter(
          (entry) => entry.recordId === recordId,
        ),
        ...ledger.approvalActions,
      ],
      (entry) => entry.recordId,
    ).slice(-MAX_ACTIONS);
    ledger.confirmations = uniqueBy(
      [
        ...legacy.confirmations.filter((entry) => entry.recordId === recordId),
        ...ledger.confirmations,
      ],
      (entry) => entry.recordId,
    ).slice(-MAX_CONFIRMATIONS);
    if (ledger.tasks.length > MAX_TASKS) {
      pruneExpiredTerminalTasks(ledger, new Date());
    }
    if (ledger.tasks.length > MAX_TASKS) {
      throw new ConflictException('恢复旧加班工作流记录后任务账本超出容量');
    }
    await this.write(ledger);
    return clone(application);
  }

  private async write(ledger: OvertimeWorkflowLedger): Promise<void> {
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    const temporaryPath = `${this.ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(ledger, null, 2)}\n`,
        'utf8',
      );
      await rename(temporaryPath, this.ledgerPath);
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}

export function stableOvertimeMessageUuid(businessKey: string): string {
  const normalized = clean(businessKey);
  if (!normalized || normalized.length > 500) {
    throw new BadRequestException('加班消息业务幂等键无效');
  }
  return `ow_${createHash('sha256').update(normalized).digest('hex').slice(0, 40)}`;
}

export function initialOvertimeConfirmationBusinessKey(
  recordId: string,
): string {
  return `overtime-confirm:${requireRecordId(recordId)}:initial`;
}

export function overtimeConfirmationOwner(application: OvertimeWorkflowApplicationEntry): string {
  return application.confirmationResponsible?.openId ?? application.actualApproverOpenId;
}

export function overtimeConfirmationGeneration(application: OvertimeWorkflowApplicationEntry): number {
  return application.confirmationResponsible?.generation ?? 1;
}

function enqueueTaskInLedger(
  ledger: OvertimeWorkflowLedger,
  input: {
    businessKey: string;
    recordId: string;
    kind: OvertimeWorkflowTaskKind;
    payload?: Record<string, unknown>;
    availableAt?: Date | number | string;
  },
  now: Date,
): { created: boolean; task: OvertimeWorkflowTaskEntry } {
  const businessKey = clean(input.businessKey);
  const recordId = requireRecordId(input.recordId);
  if (!businessKey || businessKey.length > 500) {
    throw new BadRequestException('加班工作流任务业务键无效');
  }
  const existing = ledger.tasks.find(
    (entry) => entry.businessKey === businessKey,
  );
  if (existing) return { created: false, task: existing };
  pruneExpiredTerminalTasks(ledger, now);
  if (ledger.tasks.length >= MAX_TASKS) {
    throw new ConflictException('加班工作流任务队列已满');
  }
  const timestamp = now.toISOString();
  const nextAttemptAt =
    input.availableAt !== undefined
      ? resolveNow(input.availableAt).toISOString()
      : timestamp;
  const task: OvertimeWorkflowTaskEntry = {
    key: `task:${createHash('sha256').update(businessKey).digest('hex').slice(0, 40)}`,
    businessKey,
    recordId,
    kind: input.kind,
    payload: cloneJsonObject(input.payload || {}),
    messageUuid: stableOvertimeMessageUuid(businessKey),
    status: 'pending',
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    nextAttemptAt,
    leaseUntil: '',
    claimToken: '',
    completedAt: '',
    lastError: '',
  };
  ledger.tasks.push(task);
  return { created: true, task };
}

function normalizeApplicationInput(
  input: OvertimeWorkflowAcceptApplicationInput,
): OvertimeWorkflowAcceptApplicationInput {
  const clientMutationId = clean(input?.clientMutationId);
  if (!clientMutationId || clientMutationId.length > 128) {
    throw new BadRequestException('加班申请 clientMutationId 无效');
  }
  const snapshot = input?.snapshot;
  if (!snapshot) throw new BadRequestException('加班申请快照缺失');
  const plannedHours = Number(snapshot.plannedHours);
  if (!Number.isFinite(plannedHours) || plannedHours <= 0) {
    throw new BadRequestException('加班申请工时无效');
  }
  return {
    clientMutationId,
    snapshot: {
      recordId: requireRecordId(snapshot.recordId),
      applicantName: boundedText(snapshot.applicantName, 200),
      applicantOpenId: snapshot.applicantOpenId
        ? requireOpenId(snapshot.applicantOpenId)
        : '',
      building: boundedText(snapshot.building, 100),
      position: boundedText(snapshot.position, 200),
      plannedStartAt: requireDateTime(snapshot.plannedStartAt),
      plannedEndAt: requireDateTime(snapshot.plannedEndAt),
      plannedHours,
      reason: boundedText(snapshot.reason, 2_000),
    },
  };
}

function normalizeApplicationPatch(
  patch: OvertimeWorkflowApplicationPatch,
): OvertimeWorkflowApplicationPatch {
  const result: OvertimeWorkflowApplicationPatch = {};
  if (patch.snapshot !== undefined) {
    result.snapshot = normalizeSnapshot(patch.snapshot);
  }
  if (patch.phase !== undefined) result.phase = requirePhase(patch.phase);
  if (patch.approvers !== undefined)
    result.approvers = normalizePeople(patch.approvers);
  if (patch.managerRecipients !== undefined)
    result.managerRecipients = normalizePeople(patch.managerRecipients);
  if (patch.professionalRecipients !== undefined)
    result.professionalRecipients = normalizePeople(
      patch.professionalRecipients,
    );
  if (patch.approvalCards !== undefined)
    result.approvalCards = normalizeDeliveries(patch.approvalCards);
  if (patch.managerNoticeCards !== undefined)
    result.managerNoticeCards = normalizeDeliveries(patch.managerNoticeCards);
  if (patch.confirmationCards !== undefined)
    result.confirmationCards = normalizeDeliveries(patch.confirmationCards);
  if (patch.confirmationResultIntents !== undefined)
    result.confirmationResultIntents = normalizeMessageIntents(
      patch.confirmationResultIntents,
    );
  if (patch.confirmationResultCards !== undefined)
    result.confirmationResultCards = normalizeDeliveries(
      patch.confirmationResultCards,
    );
  if (patch.actualApproverOpenId !== undefined)
    result.actualApproverOpenId = patch.actualApproverOpenId
      ? requireOpenId(patch.actualApproverOpenId)
      : '';
  if (patch.actualApproverName !== undefined)
    result.actualApproverName = boundedText(patch.actualApproverName, 200);
  if (patch.approvedAt !== undefined)
    result.approvedAt = patch.approvedAt
      ? requireDateTime(patch.approvedAt)
      : '';
  if (patch.rejectedAt !== undefined)
    result.rejectedAt = patch.rejectedAt
      ? requireDateTime(patch.rejectedAt)
      : '';
  if (patch.confirmedAt !== undefined)
    result.confirmedAt = patch.confirmedAt
      ? requireDateTime(patch.confirmedAt)
      : '';
  if (patch.lastError !== undefined)
    result.lastError = sanitizeError(patch.lastError);
  return result;
}

function normalizeSnapshot(
  snapshot: OvertimeApplicationSnapshot,
): OvertimeApplicationSnapshot {
  const plannedHours = Number(snapshot?.plannedHours);
  if (!Number.isFinite(plannedHours) || plannedHours <= 0) {
    throw new BadRequestException('加班申请工时无效');
  }
  return {
    recordId: requireRecordId(snapshot?.recordId),
    applicantName: boundedText(snapshot?.applicantName, 200),
    applicantOpenId: snapshot?.applicantOpenId
      ? requireOpenId(snapshot.applicantOpenId)
      : '',
    building: boundedText(snapshot?.building, 100),
    position: boundedText(snapshot?.position, 200),
    plannedStartAt: requireDateTime(snapshot?.plannedStartAt),
    plannedEndAt: requireDateTime(snapshot?.plannedEndAt),
    plannedHours,
    reason: boundedText(snapshot?.reason, 2_000),
  };
}

function pruneExpiredTerminalTasks(
  ledger: OvertimeWorkflowLedger,
  now: Date,
): number {
  const threshold = now.getTime() - TERMINAL_TASK_RETENTION_MS;
  const before = ledger.tasks.length;
  ledger.tasks = ledger.tasks.filter((task) => {
    if (task.status !== 'completed' && task.status !== 'failed') return true;
    const terminalAt = Date.parse(task.completedAt || task.updatedAt);
    return !Number.isFinite(terminalAt) || terminalAt >= threshold;
  });
  return before - ledger.tasks.length;
}

function normalizeApprovalAction(
  input: OvertimeWorkflowApprovalActionInput,
): Omit<
  OvertimeWorkflowApprovalActionEntry,
  'key' | 'actorName' | 'createdAt'
> {
  const eventId = boundedText(input?.eventId, 128);
  const messageId = boundedText(input?.messageId, 256);
  if (!eventId || !/^om_[A-Za-z0-9_-]+$/u.test(messageId)) {
    throw new BadRequestException('加班审批事件参数无效');
  }
  if (input.action !== 'approve' && input.action !== 'reject') {
    throw new BadRequestException('加班审批动作无效');
  }
  return {
    eventId,
    recordId: requireRecordId(input.recordId),
    action: input.action,
    actorOpenId: requireOpenId(input.actorOpenId),
    messageId,
  };
}

function normalizeConfirmationInput(
  input: OvertimeWorkflowConfirmationInput,
): Omit<
  OvertimeWorkflowConfirmationEntry,
  'key' | 'fingerprint' | 'createdAt'
> {
  const mutationId = boundedText(input?.mutationId, 128);
  if (!mutationId) throw new BadRequestException('加班确认 mutationId 无效');
  const rawActualHours = input?.draft?.actualHours;
  const actualHours =
    typeof rawActualHours === 'number' ? rawActualHours : Number.NaN;
  if (!Number.isInteger(actualHours) || actualHours < 0 || actualHours > 72) {
    throw new BadRequestException('实际加班工时必须是 0 至 72 的整数');
  }
  const disposition = input?.draft?.disposition ?? null;
  if (actualHours === 0) {
    if (input?.draft?.disposition !== null) {
      throw new BadRequestException('0 工时无需选择加班工时处置方式');
    }
  } else if (
    disposition !== '调休' &&
    disposition !== '加班费' &&
    disposition !== '费用结算'
  ) {
    throw new BadRequestException('请选择加班工时处置方式');
  }
  return {
    mutationId,
    recordId: requireRecordId(input.recordId),
    actorOpenId: requireOpenId(input.actorOpenId),
    draft: {
      actualStartAt: requireDateTime(input.draft.actualStartAt),
      ...(input.draft.actualEndAt !== undefined
        ? { actualEndAt: requireDateTime(input.draft.actualEndAt) }
        : {}),
      actualHours,
      disposition,
    },
  };
}

function normalizePeople(value: OvertimeRoutePerson[]): OvertimeRoutePerson[] {
  if (!Array.isArray(value)) throw new BadRequestException('加班审批人员无效');
  const byOpenId = new Map<string, OvertimeRoutePerson>();
  for (const item of value) {
    const openId = requireOpenId(item?.openId);
    byOpenId.set(openId, {
      name: boundedText(item?.name, 200),
      openId,
      position: boundedText(item?.position, 200),
      buildings: Array.isArray(item?.buildings)
        ? item.buildings.map((entry) => boundedText(entry, 100)).filter(Boolean)
        : [],
    });
  }
  return [...byOpenId.values()];
}

function normalizeDeliveries(
  value: OvertimeWorkflowMessageDelivery[],
): OvertimeWorkflowMessageDelivery[] {
  if (!Array.isArray(value)) throw new BadRequestException('加班消息记录无效');
  return uniqueBy(
    value.map((entry) => ({
      recipientOpenId: requireOpenId(entry.recipientOpenId),
      messageId: /^om_[A-Za-z0-9_-]+$/u.test(clean(entry.messageId))
        ? clean(entry.messageId)
        : (() => {
            throw new BadRequestException('加班消息标识无效');
          })(),
      businessKey: requireBusinessKey(entry.businessKey),
    })),
    (entry) => entry.businessKey,
  );
}

function normalizeApprovalCardPatches(
  value: OvertimeWorkflowCardPatchEntry[],
  approvalCards: OvertimeWorkflowMessageDelivery[],
): OvertimeWorkflowCardPatchEntry[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException('加班审批卡 patch 记录无效');
  }
  const deliveredMessageIds = new Set(
    normalizeDeliveries(approvalCards).map((entry) => entry.messageId),
  );
  const seen = new Set<string>();
  return value.map((entry) => {
    const messageId = requireMessageId(entry?.messageId);
    if (seen.has(messageId)) {
      throw new BadRequestException('加班审批卡 patch 记录包含重复消息');
    }
    if (!deliveredMessageIds.has(messageId)) {
      throw new BadRequestException('加班审批卡 patch 记录引用未投递消息');
    }
    seen.add(messageId);
    return {
      messageId,
      patchedAt: requireDateTime(entry?.patchedAt),
    };
  });
}

function normalizeSourceDeletedCardPatches(
  value: OvertimeWorkflowCardPatchEntry[],
  deliveredCards: OvertimeWorkflowMessageDelivery[],
): OvertimeWorkflowCardPatchEntry[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException('加班撤销卡 patch 记录无效');
  }
  const deliveredMessageIds = new Set(
    normalizeDeliveries(deliveredCards).map((entry) => entry.messageId),
  );
  const seen = new Set<string>();
  return value.map((entry) => {
    const messageId = requireMessageId(entry?.messageId);
    if (seen.has(messageId)) {
      throw new BadRequestException('加班撤销卡 patch 记录包含重复消息');
    }
    if (!deliveredMessageIds.has(messageId)) {
      throw new BadRequestException('加班撤销卡 patch 记录引用未投递消息');
    }
    seen.add(messageId);
    return {
      messageId,
      patchedAt: requireDateTime(entry?.patchedAt),
    };
  });
}

function allApplicationDeliveries(
  application: OvertimeWorkflowApplicationEntry,
): OvertimeWorkflowMessageDelivery[] {
  return [
    application.approvalCards,
    application.managerNoticeCards,
    application.confirmationCards,
    application.confirmationResultCards,
  ].flatMap((entries) => (Array.isArray(entries) ? entries : []));
}

function normalizeMessageIntents(
  value: OvertimeWorkflowMessageIntent[],
): OvertimeWorkflowMessageIntent[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException('加班确认结果消息 intent 记录无效');
  }
  return uniqueBy(
    value.map((entry) => {
      const businessKey = requireBusinessKey(entry.businessKey);
      const messageUuid = clean(entry.messageUuid);
      if (messageUuid !== stableOvertimeMessageUuid(businessKey)) {
        throw new BadRequestException('加班确认结果消息 intent UUID 无效');
      }
      return {
        recipientOpenId: requireOpenId(entry.recipientOpenId),
        businessKey,
        messageUuid,
        createdAt: requireDateTime(entry.createdAt),
      };
    }),
    (entry) => entry.businessKey,
  );
}

function isTaskAvailable(entry: OvertimeWorkflowTaskEntry, now: Date): boolean {
  if (entry.status === 'pending')
    return Date.parse(entry.nextAttemptAt) <= now.getTime();
  if (entry.status === 'processing')
    return !entry.leaseUntil || Date.parse(entry.leaseUntil) <= now.getTime();
  return false;
}

function normalizeLeaseMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new BadRequestException('加班任务租约无效');
  return Math.min(Math.floor(value), MAX_LEASE_MS);
}

function formatShanghaiDate(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function emptyLedger(): OvertimeWorkflowLedger {
  return {
    version: 1,
    applications: [],
    tasks: [],
    approvalActions: [],
    confirmations: [],
  };
}

function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sanitizeError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? '');
  return message
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, '$1 [redacted]')
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, '$1[redacted]')
    .trim()
    .slice(0, MAX_ERROR_LENGTH);
}

function constantTimeIncludes(value: string, candidates: string[]): boolean {
  let matched = 0;
  for (const candidate of candidates)
    matched |= constantTimeEqual(value, candidate) ? 1 : 0;
  return matched === 1;
}

function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(left).digest(),
    createHash('sha256').update(right).digest(),
  );
}

function resolveNow(value: Date | number | string): Date {
  const result = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(result.getTime()))
    throw new BadRequestException('加班工作流时间无效');
  return result;
}

function requireRecordId(value: unknown): string {
  const normalized = clean(value);
  if (!RECORD_ID_PATTERN.test(normalized))
    throw new BadRequestException('加班记录标识无效');
  return normalized;
}

function requireOpenId(value: unknown): string {
  const normalized = clean(value);
  if (!OPEN_ID_PATTERN.test(normalized))
    throw new BadRequestException('飞书人员 open_id 无效');
  return normalized;
}

function requireMessageId(value: unknown): string {
  const normalized = clean(value);
  if (!/^om_[A-Za-z0-9_-]+$/u.test(normalized)) {
    throw new BadRequestException('加班消息标识无效');
  }
  return normalized;
}

function requireBusinessKey(value: unknown): string {
  const normalized = boundedText(value, 500);
  if (!normalized) throw new BadRequestException('加班消息业务幂等键无效');
  return normalized;
}

function requireDateTime(value: unknown): string {
  const normalized = clean(value);
  if (!normalized || !Number.isFinite(Date.parse(normalized)))
    throw new BadRequestException('加班日期时间无效');
  return normalized;
}

function requirePhase(value: unknown): OvertimeWorkflowPhase {
  if (
    ![
      'pending_approval',
      'approval_pending',
      'approved',
      'rejected',
      'awaiting_confirmation',
      'confirmed',
      'source_deleted',
    ].includes(value as string)
  ) {
    throw new BadRequestException('加班工作流状态无效');
  }
  return value as OvertimeWorkflowPhase;
}

function boundedText(value: unknown, maxLength: number): string {
  const normalized = clean(value)
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ');
  if (Array.from(normalized).length > maxLength)
    throw new BadRequestException('加班工作流文本过长');
  return normalized;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneJsonObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  try {
    const cloned = clone(value);
    if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned))
      throw new Error('invalid');
    return cloned;
  } catch {
    throw new BadRequestException('加班工作流任务载荷必须可序列化');
  }
}

function uniqueBy<T>(items: T[], key: (entry: T) => string): T[] {
  const result = new Map<string, T>();
  items.forEach((entry) => result.set(key(entry), entry));
  return [...result.values()];
}

function isApplicationEntry(
  value: unknown,
): value is OvertimeWorkflowApplicationEntry {
  const entry = value as OvertimeWorkflowApplicationEntry;
  return Boolean(
    entry &&
    RECORD_ID_PATTERN.test(clean(entry.recordId)) &&
    entry.snapshot &&
    Number.isInteger(entry.revision),
  );
}

function normalizePersistedApplicationEntry(
  entry: OvertimeWorkflowApplicationEntry,
): OvertimeWorkflowApplicationEntry {
  if (entry.approvalGeneration !== undefined && (!Number.isSafeInteger(entry.approvalGeneration) || entry.approvalGeneration < 1)) throw new BadRequestException('加班审批代际账本无效');
  if (entry.confirmationResponsible !== undefined) {
    const owner = entry.confirmationResponsible;
    if (!owner || !OPEN_ID_PATTERN.test(owner.openId) || !/^rec[A-Za-z0-9_]+$/u.test(owner.personRecordId) || typeof owner.name !== 'string' || !owner.name.trim() || owner.name.length > 200 || !Number.isSafeInteger(owner.generation) || owner.generation < 2) throw new BadRequestException('加班确认负责人账本无效');
  }
  return {
    ...entry,
    ...(entry.professionalRecipients !== undefined
      ? {
          professionalRecipients: normalizePersistedOptionalArray(
            entry,
            'professionalRecipients',
            normalizePeople,
          ),
        }
      : {}),
    approvalCardPatches: normalizePersistedApprovalCardPatches(entry),
    confirmationResultIntents: normalizePersistedOptionalArray(
      entry,
      'confirmationResultIntents',
      normalizeMessageIntents,
    ),
    confirmationResultCards: normalizePersistedOptionalArray(
      entry,
      'confirmationResultCards',
      normalizeDeliveries,
    ),
    sourceDeletedAt: entry.sourceDeletedAt
      ? requireDateTime(entry.sourceDeletedAt)
      : '',
    sourceDeletedCardPatches: normalizePersistedSourceDeletedCardPatches(entry),
  };
}

function normalizePersistedApprovalCardPatches(
  entry: OvertimeWorkflowApplicationEntry,
): OvertimeWorkflowCardPatchEntry[] {
  const field = 'approvalCardPatches';
  if (!Object.prototype.hasOwnProperty.call(entry, field)) return [];
  const value = entry.approvalCardPatches as unknown;
  if (!Array.isArray(value)) {
    throw new BadRequestException(`加班工作流账本 ${field} 无效`);
  }
  try {
    return normalizeApprovalCardPatches(value, entry.approvalCards);
  } catch (error) {
    throw new BadRequestException(
      `加班工作流账本 ${field} 无效：${sanitizeError(error)}`,
    );
  }
}

function normalizePersistedSourceDeletedCardPatches(
  entry: OvertimeWorkflowApplicationEntry,
): OvertimeWorkflowCardPatchEntry[] {
  const field = 'sourceDeletedCardPatches';
  if (!Object.prototype.hasOwnProperty.call(entry, field)) return [];
  const value = entry.sourceDeletedCardPatches as unknown;
  if (!Array.isArray(value)) {
    throw new BadRequestException(`加班工作流账本 ${field} 无效`);
  }
  try {
    return normalizeSourceDeletedCardPatches(
      value,
      allApplicationDeliveries(entry),
    );
  } catch (error) {
    throw new BadRequestException(
      `加班工作流账本 ${field} 无效：${sanitizeError(error)}`,
    );
  }
}

function normalizePersistedOptionalArray<T>(
  entry: OvertimeWorkflowApplicationEntry,
  field:
    | 'confirmationResultIntents'
    | 'confirmationResultCards'
    | 'professionalRecipients',
  normalize: (value: T[]) => T[],
): T[] {
  if (!Object.prototype.hasOwnProperty.call(entry, field)) return [];
  const value = entry[field] as unknown;
  if (!Array.isArray(value)) {
    throw new BadRequestException(`加班工作流账本 ${field} 无效`);
  }
  try {
    return normalize(value as T[]);
  } catch (error) {
    throw new BadRequestException(
      `加班工作流账本 ${field} 无效：${sanitizeError(error)}`,
    );
  }
}

function isMessageDeliveryEntry(
  value: unknown,
): value is OvertimeWorkflowMessageDelivery {
  const delivery = value as OvertimeWorkflowMessageDelivery;
  return Boolean(
    delivery &&
    OPEN_ID_PATTERN.test(clean(delivery.recipientOpenId)) &&
    clean(delivery.messageId) &&
    clean(delivery.businessKey),
  );
}

function isTaskEntry(value: unknown): value is OvertimeWorkflowTaskEntry {
  const entry = value as OvertimeWorkflowTaskEntry;
  return Boolean(
    entry &&
    clean(entry.businessKey) &&
    RECORD_ID_PATTERN.test(clean(entry.recordId)) &&
    ['pending', 'processing', 'completed', 'failed'].includes(entry.status),
  );
}

function isApprovalActionEntry(
  value: unknown,
): value is OvertimeWorkflowApprovalActionEntry {
  const entry = value as OvertimeWorkflowApprovalActionEntry;
  return Boolean(
    entry &&
    RECORD_ID_PATTERN.test(clean(entry.recordId)) &&
    clean(entry.eventId),
  );
}

function isConfirmationEntry(
  value: unknown,
): value is OvertimeWorkflowConfirmationEntry {
  const entry = value as OvertimeWorkflowConfirmationEntry;
  return Boolean(
    entry &&
    RECORD_ID_PATTERN.test(clean(entry.recordId)) &&
    clean(entry.mutationId) &&
    entry.draft,
  );
}
