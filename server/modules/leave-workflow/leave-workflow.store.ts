import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { readEnv } from '../../common/config/external-services.config';
import { resolveLeaveWorkflowLedgerPath } from '../../common/feishu/leave-local-projection';
import { assertLeaveApplicationCoverage } from '../../common/access/personnel-handover.coverage';
import {assertFutureManagerRoles,assertFutureManagerTasks,leavePlanHash} from './leave-future-manager-handover';
import { fixedLeaveNotificationIds, originalLeaveNotificationRoleRecipients } from './leave-workflow.rules';
import { originalPostSignature } from './leave-two-level-substitution';
import { parseShanghaiLocalDateTime } from '../../../shared/leave-request-impact';
import type {
  LeaveRequestShiftGroup,
  LeaveScheduleKind,
} from '../../../shared/leave-request-impact';
import type {
  LeaveApprovalPlan,
  LeaveRoutePerson,
  LeaveShiftCandidateSet,
  LeaveShiftSubstituteAssignment,
  LeaveOriginalPostBackfill,
  LeaveSubstituteCandidate,
} from './leave-workflow.types';

export const LEAVE_WORKFLOW_LEDGER_PATH = Symbol('LEAVE_WORKFLOW_LEDGER_PATH');
export const LEAVE_WORKFLOW_LEGACY_LEDGER_PATH = Symbol(
  'LEAVE_WORKFLOW_LEGACY_LEDGER_PATH',
);

const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,124}$/u;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,252}$/u;
const MAX_APPLICATIONS = 5_000;
const MAX_TASKS = 10_000;
const MAX_ACTIONS = 10_000;
const DEFAULT_LEASE_MS = 60_000;
const BASE_RETRY_MS = 2_000;
const MAX_RETRY_MS = 30 * 60 * 1_000;
const MAX_ERROR_LENGTH = 500;
const NORMALIZATION_CACHE_ENTRIES = 256;
const NORMALIZATION_CACHE_CHARACTERS = 16 * 1024 * 1024;
const LEDGER_READ_CACHE_BYTES = 16 * 1024 * 1024;
const PRIMARY_TASK_BURST = 4;

export type LeaveWorkflowStatus =
  | 'accepted'
  | 'supervisor_pending'
  | 'manager_pending'
  | 'approved_syncing'
  | 'approved'
  | 'rejected_syncing'
  | 'rejected'
  | 'routing_failed'
  | 'sync_error';

export type LeaveWorkflowTaskKind =
  | 'route_application'
  | 'repair_station_chief_route'
  | 'deliver_stage_cards'
  | 'sync_leave_shift_details'
  | 'apply_stage_action'
  | 'sync_stage_action_cards'
  | 'deliver_result_cards'
  | 'deliver_substitute_adjustment_cards'
  | 'deliver_substitute_update_notifications'
  | 'deliver_stage_substitute_change_notifications'
  | 'sync_approved_leave_schedule'
  | 'apply_substitute_update'
  | 'sync_personnel_handover'
  | 'verify_future_manager_handover';

export type LeaveWorkflowTaskStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed';

export interface LeaveWorkflowSnapshot {
  applicantName: string;
  applicantOpenId: string;
  applicantPersonRecordId: string;
  applicantNotificationOpenIds: string[];
  building: string;
  position: string;
  leaveType: string;
  startAt: string;
  endAt: string;
  leaveHours: number;
  approvalDayCount: number;
  reason: string;
  screenshotImageKeys?: string[];
  screenshotStatus?: 'ready' | 'missing' | 'unavailable';
  substituteName?: string;
  substituteOpenId?: string;
  substitutePersonRecordId?: string;
  substituteRequired?: boolean;
  substituteDecisionRequired?: boolean;
  substituteDecisionMade?: boolean;
  substituteCandidates?: LeaveSubstituteCandidate[];
  substituteRevision?: number;
  substituteUpdatedByOpenId?: string;
  substituteUpdatedByName?: string;
  substituteUpdatedAt?: string;
  shiftGroups?: LeaveRequestShiftGroup[];
  candidateSets?: LeaveShiftCandidateSet[];
  shiftAssignments?: LeaveShiftSubstituteAssignment[];
  assignmentRevision?: number;
}

export interface LeaveWorkflowMessageDelivery {
  recipientOpenId: string;
  messageId: string;
  businessKey: string;
}

export interface LeaveWorkflowStage {
  key: 'supervisor' | 'manager';
  version: number;
  approverOpenIds: string[];
}
export interface LeavePersonnelHandoverInput {
  recordId: string;
  mutationId: string;
  dutyRecordId: string;
  expectedStage: LeaveWorkflowStage;
  sourceOpenId: string;
  target: LeaveRoutePerson;
}
export interface LeavePersonnelHandoverReceipt {
  status: 'accepted' | 'already_completed';
  stage: LeaveWorkflowStage | null;
  taskBusinessKey: string | null;
}
export interface LeaveFutureManagerHandoverInput {
  recordId:string;mutationId:string;dutyRecordId:string;sourceOpenId:string;sourcePersonRecordId:string;
  expectedRevision:number;expectedCurrentStage:LeaveWorkflowStage;expectedPlanHash:string;target:LeaveRoutePerson;
}
export interface LeaveFutureManagerHandoverReceipt {status:'accepted'|'already_completed';revision:number;taskBusinessKey:string|null;stage?:LeaveWorkflowStage;}

export interface LeaveWorkflowApplicationEntry {
  key: string;
  recordId: string;
  clientMutationId: string;
  snapshot: LeaveWorkflowSnapshot;
  status: LeaveWorkflowStatus;
  approvalPlan: LeaveApprovalPlan | null;
  currentStage: LeaveWorkflowStage | null;
  stageCards: LeaveWorkflowMessageDelivery[];
  terminalCardMessageIds: string[];
  resultCards: LeaveWorkflowMessageDelivery[];
  substituteAdjustmentCards: LeaveWorkflowMessageDelivery[];
  resultRecipients: LeaveRoutePerson[];
  resolvedAction: 'approve' | 'reject' | null;
  resolvedByOpenId: string;
  resolvedByName: string;
  resolvedAt: string;
  rejectionReason: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastError: string;
}

export interface LeaveWorkflowActionEntry {
  key: string;
  eventId: string;
  recordId: string;
  stageKey: 'supervisor' | 'manager';
  stageVersion: number;
  actorOpenId: string;
  actorName: string;
  action: 'approve' | 'reject';
  substituteRequired: boolean;
  messageId: string;
  previousSubstituteOpenId: string;
  previousSubstitutePersonRecordId: string;
  previousSubstituteName: string;
  substituteOpenId: string;
  substitutePersonRecordId: string;
  substituteName: string;
  previousShiftAssignments: LeaveShiftSubstituteAssignment[];
  shiftAssignments: LeaveShiftSubstituteAssignment[];
  rejectionReason: string;
  createdAt: string;
}

export interface LeaveWorkflowSubstituteUpdateEntry {
  key: string;
  eventId: string;
  recordId: string;
  expectedRevision: number;
  revision: number;
  actorOpenId: string;
  actorName: string;
  messageId: string;
  previousSubstituteOpenId: string;
  previousSubstitutePersonRecordId: string;
  previousSubstituteName: string;
  substituteOpenId: string;
  substitutePersonRecordId: string;
  substituteName: string;
  previousShiftAssignments: LeaveShiftSubstituteAssignment[];
  shiftAssignments: LeaveShiftSubstituteAssignment[];
  changedShiftKeys: string[];
  createdAt: string;
}

export interface LeaveWorkflowTaskEntry {
  key: string;
  businessKey: string;
  recordId: string;
  kind: LeaveWorkflowTaskKind;
  payload: Record<string, unknown>;
  status: LeaveWorkflowTaskStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  leaseUntil: string;
  claimToken: string;
  completedAt: string;
  lastError: string;
}

interface Ledger {
  version: 4;
  applications: LeaveWorkflowApplicationEntry[];
  actions: LeaveWorkflowActionEntry[];
  substituteUpdates: LeaveWorkflowSubstituteUpdateEntry[];
  tasks: LeaveWorkflowTaskEntry[];
}

@Injectable()
export class LeaveWorkflowStore {
  private readonly logger = new Logger(LeaveWorkflowStore.name);
  private readonly ledgerPath: string;
  private readonly legacyLedgerPath: string;
  private readonly operations: Array<() => Promise<void>> = [];
  private readonly cardOperations: Array<() => Promise<void>> = [];
  private drainingOperations = false;
  private cardOperationBurst = 0;
  private readonly normalizedApplications = new Map<string, { source: string; value: LeaveWorkflowApplicationEntry }>();
  private normalizationCacheCharacters = 0;
  private ledgerReadCache: { path: string; source: Buffer; parsed: Partial<Ledger> } | null = null;
  private readonly serializedApplications = new WeakMap<LeaveWorkflowApplicationEntry, string>();
  private primaryTaskBurst = 0;

  constructor(
    @Optional() @Inject(LEAVE_WORKFLOW_LEDGER_PATH) ledgerPath?: string,
    @Optional()
    @Inject(LEAVE_WORKFLOW_LEGACY_LEDGER_PATH)
    legacyLedgerPath?: string,
  ) {
    this.ledgerPath = resolveLeaveWorkflowLedgerPath(ledgerPath);
    this.legacyLedgerPath = resolve(
      legacyLedgerPath || 'data/leave-workflow/ledger.json',
    );
  }

  async onModuleInit(now: Date | number = new Date()): Promise<void> {
    return runHotfixInitialization(this, async () => {
      await this.enqueue(async () => {
        await this.mergeLegacyLedger();
        const ledger = await this.read();
        const timestamp = asDate(now).toISOString();
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
        const applications = new Map(ledger.applications.map((entry) => [entry.recordId, entry]));
        for (const action of ledger.actions) {
          const application = applications.get(action.recordId);
          const prefix = `leave:${action.recordId}:stage:${action.stageKey}:${action.stageVersion}:`;
          if (!application?.stageCards.some((card) => card.businessKey.startsWith(prefix))) continue;
          const previousCount = ledger.tasks.length;
          enqueueStageActionCards(ledger, action, true);
          if (ledger.tasks.length !== previousCount) changed = true;
        }
        if (changed) await this.write(ledger);
      });
    });
  }

  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
  }

  async acceptApplication(input: {
    clientMutationId: string;
    recordId: string;
    snapshot: LeaveWorkflowSnapshot;
  }): Promise<{ created: boolean; entry: LeaveWorkflowApplicationEntry }> {
    return this.enqueue(async () => {
      const normalized = normalizeApplicationInput(input);
      const ledger = await this.read();
      const existing = ledger.applications.find(
        (entry) =>
          entry.recordId === normalized.recordId ||
          entry.clientMutationId === normalized.clientMutationId,
      );
      if (existing) {
        if (
          existing.recordId !== normalized.recordId ||
          existing.clientMutationId !== normalized.clientMutationId
        ) {
          throw new ConflictException('请休假请求幂等键与正式记录不一致');
        }
        return { created: false, entry: clone(existing) };
      }
      if (ledger.applications.length >= MAX_APPLICATIONS) {
        throw new ConflictException('请休假工作流本地台账已满');
      }
      const timestamp = new Date().toISOString();
      const entry: LeaveWorkflowApplicationEntry = {
        key: `leave:${normalized.recordId}`,
        recordId: normalized.recordId,
        clientMutationId: normalized.clientMutationId,
        snapshot: normalized.snapshot,
        status: 'accepted',
        approvalPlan: null,
        currentStage: null,
        stageCards: [],
        terminalCardMessageIds: [],
        resultCards: [],
        substituteAdjustmentCards: [],
        resultRecipients: [],
        resolvedAction: null,
        resolvedByOpenId: '',
        resolvedByName: '',
        resolvedAt: '',
        rejectionReason: '',
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastError: '',
      };
      ledger.applications.push(entry);
      enqueueTask(ledger, {
        businessKey: `leave:${entry.recordId}:route`,
        recordId: entry.recordId,
        kind: 'route_application',
      });
      await this.write(ledger);
      return { created: true, entry: clone(entry) };
    });
  }

  async getApplication(
    recordId: string,
  ): Promise<LeaveWorkflowApplicationEntry | null> {
    const normalizedRecordId = requireRecordId(recordId);
    return this.enqueue(async () => {
      const entry = (await this.readPath(this.ledgerPath, normalizedRecordId)).ledger.applications.find(
        (candidate) => candidate.recordId === normalizedRecordId,
      );
      return entry ? clone(entry) : null;
    });
  }

  async listApplications(): Promise<LeaveWorkflowApplicationEntry[]> {
    return this.enqueue(async () => clone((await this.read()).applications), false);
  }
  async acceptPersonnelHandover(input: LeavePersonnelHandoverInput, notificationsManaged?: () => boolean): Promise<LeavePersonnelHandoverReceipt> {
    const recordId=requireRecordId(input?.recordId),expectedStage=normalizeStage(input?.expectedStage);
    const mutationId=requireText(input?.mutationId,'岗位交接业务键无效',160),dutyRecordId=requireRecordId(input?.dutyRecordId),sourceOpenId=requireOpenId(input?.sourceOpenId);
    if (!/^handover-[a-f0-9]{64}$/u.test(mutationId)) throw new BadRequestException('岗位交接业务键无效');
    if (!input?.target || !Array.isArray(input.target.buildings)) throw new BadRequestException('岗位交接人员或范围无效');
    const target:LeaveRoutePerson={ personRecordId:requireRecordId(input.target.personRecordId),openId:requireOpenId(input.target.openId),name:requireText(input.target.name,'接任人姓名无效',100),position:String(input.target.position || '').trim(),buildings:[...input.target.buildings] };
    if (target.openId === sourceOpenId || !expectedStage.approverOpenIds.includes(sourceOpenId) || target.buildings.length > 7 ||
      !target.buildings.every(building=>typeof building === 'string' && building.length > 0 && building.length <= 100) || /[\u0000-\u001f\u007f]/u.test(target.name) || target.position.length > 100) throw new BadRequestException('岗位交接人员或范围无效');
    const fingerprint=createHash('sha256').update(JSON.stringify({recordId,mutationId,dutyRecordId,sourceOpenId,expectedStage:{...expectedStage,approverOpenIds:[...expectedStage.approverOpenIds].sort()},target:{...target,buildings:[...target.buildings].sort()}})).digest('hex');
    const businessKey=`leave:${recordId}:${mutationId}`;
    return this.enqueue<LeavePersonnelHandoverReceipt>(async()=>{
      const ledger=await this.read(),entry=findApplication(ledger,recordId),prior=ledger.tasks.find(task=>task.businessKey === businessKey);
      if (prior) {
        if (prior.kind !== 'sync_personnel_handover' || prior.payload.fingerprint !== fingerprint || !Number.isSafeInteger(prior.payload.targetStageVersion)) throw new ConflictException('重复交接请求内容不一致');
        return {status:'accepted',stage:{key:expectedStage.key,version:Number(prior.payload.targetStageVersion),approverOpenIds:[...new Set(expectedStage.approverOpenIds.map(id=>id === sourceOpenId ? target.openId : id))]},taskBusinessKey:businessKey};
      }
      if (entry.resolvedAction !== null || ['approved','rejected','approved_syncing','rejected_syncing'].includes(entry.status) ||
        ledger.actions.some(action=>action.recordId === recordId && action.stageKey === expectedStage.key && action.stageVersion === expectedStage.version)) return {status:'already_completed',stage:clone(entry.currentStage),taskBusinessKey:null};
      if (!entry.currentStage || !sameStage(entry.currentStage,expectedStage) || entry.status !== `${expectedStage.key}_pending`) throw new ConflictException('审批阶段已变化，请更新交接清单');
      const managedNotifications = notificationsManaged?.() === true;
      assertLeaveApplicationCoverage(sourceOpenId,entry,ledger.tasks,false,managedNotifications);
      if (ledger.tasks.some(task=>task.recordId === recordId && ['sync_personnel_handover','verify_future_manager_handover'].includes(task.kind) && task.payload.patchOnly !== true && task.status !== 'completed')) throw new ConflictException('上一交接尚未同步完成，请先恢复原交接');
      if (entry.snapshot.applicantOpenId === target.openId || (entry.snapshot.applicantPersonRecordId && entry.snapshot.applicantPersonRecordId === target.personRecordId)) throw new ConflictException('接任人不能审批自己的申请，请另行指定审批人');
      if (!entry.approvalPlan || !entry.approvalPlan.stages.some(stage=>stage.key === expectedStage.key && stage.approvers.some(person=>person.openId === sourceOpenId))) throw new ConflictException('审批路由与交接岗位不一致');
      const stage=normalizeStage({...expectedStage,version:expectedStage.version+1,approverOpenIds:expectedStage.approverOpenIds.map(id=>id === sourceOpenId ? target.openId : id)});
      const approvalPlan=clone(entry.approvalPlan);
      if (managedNotifications && !approvalPlan.notificationPlan.managerRecipients) approvalPlan.notificationPlan.managerRecipients=originalLeaveNotificationRoleRecipients(entry,'manager');
      approvalPlan.stages=approvalPlan.stages.map(current=>current.key === expectedStage.key ? {...current,approvers:uniquePeople(current.approvers.map(person=>person.openId === sourceOpenId ? target : person))} : current);
      const replaceRecipients=(people:LeaveRoutePerson[])=>uniquePeople(people.map(person=>person.openId === sourceOpenId ? target : person));
      approvalPlan.notificationPlan.finalResultRecipients=replaceRecipients(approvalPlan.notificationPlan.finalResultRecipients);
      if (expectedStage.key === 'manager' && approvalPlan.notificationPlan.managerRecipients) approvalPlan.notificationPlan.managerRecipients=replaceRecipients(approvalPlan.notificationPlan.managerRecipients);
      const updated=touch(entry,{currentStage:stage,approvalPlan,resultRecipients:replaceRecipients(entry.resultRecipients),lastError:''},new Date());
      replaceApplication(ledger,updated);
      enqueueTask(ledger,{recordId,businessKey,kind:'sync_personnel_handover',payload:{mutationId,dutyRecordId,fingerprint,sourceOpenId,target,sourceStageKey:expectedStage.key,sourceStageVersion:expectedStage.version,sourceApproverOpenIds:expectedStage.approverOpenIds,targetStageVersion:stage.version}});
      await this.write(ledger);
      return {status:'accepted',stage:clone(stage),taskBusinessKey:businessKey};
    });
  }
  async acceptFutureManagerHandover(input:LeaveFutureManagerHandoverInput,notificationsManaged?:()=>boolean):Promise<LeaveFutureManagerHandoverReceipt>{
    const recordId=requireRecordId(input?.recordId),mutationId=requireText(input?.mutationId,'交接业务键无效',160),dutyRecordId=requireRecordId(input?.dutyRecordId),sourceOpenId=requireOpenId(input?.sourceOpenId),sourcePersonRecordId=requireRecordId(input?.sourcePersonRecordId),expectedCurrentStage=normalizeStage(input?.expectedCurrentStage);
    if(!/^handover-[a-f0-9]{64}$/.test(mutationId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||expectedCurrentStage.key!=='supervisor'||!/^[a-f0-9]{64}$/.test(input.expectedPlanHash)||!input.target||!Array.isArray(input.target.buildings))throw new BadRequestException('未来经理交接基线无效');
    const target:LeaveRoutePerson={personRecordId:requireRecordId(input.target.personRecordId),openId:requireOpenId(input.target.openId),name:requireText(input.target.name,'接任人姓名无效',100),position:String(input.target.position||'').trim(),buildings:[...input.target.buildings]};
    if(target.openId===sourceOpenId||target.personRecordId===sourcePersonRecordId||target.buildings.length>7||target.buildings.some(value=>typeof value!=='string'||!value.length||value.length>100)||target.position.length>100||/[\u0000-\u001f\u007f]/u.test(target.name))throw new BadRequestException('未来经理交接人员无效');
    const request={recordId,mutationId,dutyRecordId,sourceOpenId,sourcePersonRecordId,expectedRevision:input.expectedRevision,expectedCurrentStage,expectedPlanHash:input.expectedPlanHash,target};
    const fingerprint=createHash('sha256').update(JSON.stringify(request)).digest('hex'),businessKey=`leave:${recordId}:${mutationId}`;
    return this.enqueue(async()=>{
      const ledger=await this.read(),entry=findApplication(ledger,recordId),prior=ledger.tasks.find(task=>task.businessKey===businessKey);
      if(prior){
        if(!['verify_future_manager_handover','sync_personnel_handover'].includes(prior.kind)||prior.payload.futureManager!==true||prior.payload.futureFingerprint!==fingerprint||!Number.isSafeInteger(prior.payload.targetRevision))throw new ConflictException('重复未来交接请求内容不一致');
        const stage=prior.kind==='sync_personnel_handover'?normalizeStage({key:'manager',version:Number(prior.payload.targetStageVersion),approverOpenIds:(prior.payload.sourceApproverOpenIds as string[]).map(id=>id===sourceOpenId?target.openId:id)}):undefined;
        return {status:'accepted',revision:Number(prior.payload.targetRevision),taskBusinessKey:businessKey,...(stage?{stage}:{})};
      }
      if(leavePlanHash(entry.approvalPlan)!==input.expectedPlanHash)throw new ConflictException('未来经理审批计划已变化，请重新核对');
      const managedRoles=notificationsManaged?.()===true;
      assertFutureManagerRoles(sourceOpenId,entry,managedRoles);
      const source=entry.approvalPlan!.stages[1].approvers.find(person=>person.openId===sourceOpenId)!;
      if(source.personRecordId&&source.personRecordId!==sourcePersonRecordId)throw new ConflictException('原经理稳定人员身份不一致');
      if(entry.snapshot.applicantOpenId===target.openId||entry.snapshot.applicantPersonRecordId===target.personRecordId)throw new ConflictException('接任人不能审批自己的申请');
      const supervisorAction=ledger.actions.find(action=>action.recordId===recordId&&action.stageKey==='supervisor'&&action.stageVersion===expectedCurrentStage.version);
      const managerAction=ledger.actions.find(action=>action.recordId===recordId&&action.stageKey==='manager'&&action.stageVersion===expectedCurrentStage.version+1);
      if(['approved','rejected','rejected_syncing'].includes(entry.status)||managerAction||supervisorAction?.action==='reject')return {status:'already_completed',revision:entry.revision,taskBusinessKey:null,...(managerAction?{stage:{key:'manager' as const,version:managerAction.stageVersion,approverOpenIds:entry.approvalPlan!.stages[1].approvers.map(person=>person.openId)}}:supervisorAction?.action==='reject'?{stage:expectedCurrentStage}:{})};
      const promoted=entry.status==='manager_pending'&&entry.currentStage?.key==='manager'&&entry.currentStage.version===expectedCurrentStage.version+1&&supervisorAction?.action==='approve';
      if(!promoted&&supervisorAction)throw new ConflictException('原主管审批正在同步，请待阶段更新后重试原交接');
      if(!promoted&&(entry.revision!==input.expectedRevision||entry.status!=='supervisor_pending'||!entry.currentStage||!sameStage(entry.currentStage,expectedCurrentStage)))throw new ConflictException('原审批版本已变化，请重新核对未来交接');
      if(promoted&&(entry.revision<input.expectedRevision||JSON.stringify([...entry.currentStage!.approverOpenIds].sort())!==JSON.stringify(entry.approvalPlan!.stages[1].approvers.map(person=>person.openId).sort())))throw new ConflictException('经理阶段与原计划不一致');
      if(promoted&&ledger.actions.some(action=>action.recordId===recordId&&action.stageKey==='manager'&&action.stageVersion===entry.currentStage!.version))return {status:'already_completed',revision:entry.revision,taskBusinessKey:null};
      assertFutureManagerTasks(recordId,ledger.tasks,promoted?entry.currentStage!.version:undefined);
      const approvalPlan=clone(entry.approvalPlan!),replace=(people:LeaveRoutePerson[])=>[...new Map(people.map(person=>person.openId===sourceOpenId||person.openId===target.openId?target:person).map(person=>[person.openId,clone(person)] as const)).values()];
      const retainSource=managedRoles&&(approvalPlan.stages[0].approvers.some(person=>person.openId===sourceOpenId)||fixedLeaveNotificationIds(entry).has(sourceOpenId)||approvalPlan.notificationPlan.professionalRecipients.some(person=>person.openId===sourceOpenId));
      const replaceAggregate=(people:LeaveRoutePerson[])=>uniquePeople([...replace(people),...(retainSource?people.filter(person=>person.openId===sourceOpenId):[])]);
      if(managedRoles&&!approvalPlan.notificationPlan.managerRecipients)approvalPlan.notificationPlan.managerRecipients=originalLeaveNotificationRoleRecipients(entry,'manager');
      approvalPlan.stages[1]={...approvalPlan.stages[1],approvers:replace(approvalPlan.stages[1].approvers)};approvalPlan.notificationPlan.finalResultRecipients=replaceAggregate(approvalPlan.notificationPlan.finalResultRecipients);
      if (approvalPlan.notificationPlan.managerRecipients) approvalPlan.notificationPlan.managerRecipients=replace(approvalPlan.notificationPlan.managerRecipients);
      const stage=promoted?normalizeStage({...entry.currentStage!,version:entry.currentStage!.version+1,approverOpenIds:entry.currentStage!.approverOpenIds.map(id=>id===sourceOpenId?target.openId:id)}):undefined;
      const updated=touch(entry,{approvalPlan,resultRecipients:replaceAggregate(entry.resultRecipients),...(stage?{currentStage:stage}:{}),lastError:''},new Date());replaceApplication(ledger,updated);
      enqueueTask(ledger,{recordId,businessKey,kind:promoted?'sync_personnel_handover':'verify_future_manager_handover',payload:{futureManager:true,futureFingerprint:fingerprint,futureInput:request,targetRevision:updated.revision,targetPlanHash:leavePlanHash(approvalPlan),mutationId,dutyRecordId,sourceOpenId,target,...(stage?{fingerprint,sourceStageKey:'manager',sourceStageVersion:entry.currentStage!.version,sourceApproverOpenIds:entry.currentStage!.approverOpenIds,targetStageVersion:stage.version}:{})}});
      await this.write(ledger);return {status:'accepted',revision:updated.revision,taskBusinessKey:businessKey,...(stage?{stage:clone(stage)}:{})};
    });
  }
  async getFutureManagerHandover(recordId:string,mutationId:string):Promise<LeaveWorkflowTaskEntry|null>{
    const id=requireRecordId(recordId),key=requireText(mutationId,'未来经理交接业务键无效',160);if(!/^handover-[a-f0-9]{64}$/.test(key))throw new BadRequestException('未来经理交接业务键无效');
    return this.enqueue(async()=>clone((await this.read()).tasks.find(task=>task.recordId===id&&task.businessKey===`leave:${id}:${key}`&&['verify_future_manager_handover','sync_personnel_handover'].includes(task.kind)&&task.payload.futureManager===true)||null));
  }
  async getPersonnelHandover(recordId:string,mutationId:string):Promise<LeaveWorkflowTaskEntry|null> {
    const id=requireRecordId(recordId),key=requireText(mutationId,'岗位交接业务键无效',160);
    if (!/^handover-[a-f0-9]{64}$/u.test(key)) throw new BadRequestException('岗位交接业务键无效');
    return this.enqueue(async()=>clone((await this.read()).tasks.find(task=>task.recordId === id && task.businessKey === `leave:${id}:${key}` && task.kind === 'sync_personnel_handover') || null));
  }

  async patchApplication(
    recordId: string,
    patch: Partial<
      Pick<
        LeaveWorkflowApplicationEntry,
        | 'snapshot'
        | 'status'
        | 'approvalPlan'
        | 'currentStage'
        | 'stageCards'
        | 'terminalCardMessageIds'
        | 'resultCards'
        | 'substituteAdjustmentCards'
        | 'resultRecipients'
        | 'resolvedAction'
        | 'resolvedByOpenId'
        | 'resolvedByName'
        | 'resolvedAt'
        | 'lastError'
      >
    >,
    now: Date | number = new Date(),
  ): Promise<LeaveWorkflowApplicationEntry> {
    const normalizedRecordId = requireRecordId(recordId);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const entry = findApplication(ledger, normalizedRecordId);
      const updated: LeaveWorkflowApplicationEntry = {
        ...entry,
        ...clone(patch),
        revision: entry.revision + 1,
        updatedAt: asDate(now).toISOString(),
      };
      replaceApplication(ledger, updated);
      await this.write(ledger);
      return clone(updated);
    });
  }

  async setApprovalPlan(
    recordId: string,
    input: {
      snapshot: LeaveWorkflowSnapshot;
      approvalPlan: LeaveApprovalPlan;
      resultRecipients: LeaveRoutePerson[];
    },
    now: Date | number = new Date(),
  ): Promise<LeaveWorkflowApplicationEntry> {
    return this.patchApplication(
      recordId,
      {
        snapshot: normalizeSnapshot(input.snapshot),
        approvalPlan: clone(input.approvalPlan),
        resultRecipients: uniquePeople(input.resultRecipients),
        status: 'accepted',
        lastError: '',
      },
      now,
    );
  }

  async setPendingStage(
    recordId: string,
    stage: LeaveWorkflowStage,
    now: Date | number = new Date(),
  ): Promise<LeaveWorkflowApplicationEntry> {
    const normalizedRecordId = requireRecordId(recordId);
    const normalizedStage = normalizeStage(stage);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const entry = findApplication(ledger, normalizedRecordId);
      const updated: LeaveWorkflowApplicationEntry = {
        ...entry,
        currentStage: normalizedStage,
        status:
          normalizedStage.key === 'manager'
            ? 'manager_pending'
            : 'supervisor_pending',
        resolvedAction: null,
        resolvedByOpenId: '',
        resolvedByName: '',
        resolvedAt: '',
        lastError: '',
        revision: entry.revision + 1,
        updatedAt: asDate(now).toISOString(),
      };
      replaceApplication(ledger, updated);
      enqueueTask(ledger, {
        businessKey: `leave:${normalizedRecordId}:deliver:${normalizedStage.key}:${normalizedStage.version}`,
        recordId: normalizedRecordId,
        kind: 'deliver_stage_cards',
        payload: {
          stageKey: normalizedStage.key,
          stageVersion: normalizedStage.version,
        },
      });
      await this.write(ledger);
      return clone(updated);
    });
  }

  async schedulePendingStageReroute(input: {
    recordId: string;
    expectedStage: LeaveWorkflowStage;
    businessKey: string;
  }): Promise<{ scheduled: boolean; entry: LeaveWorkflowApplicationEntry }> {
    const recordId = requireRecordId(input.recordId);
    const expectedStage = normalizeStage(input.expectedStage);
    const businessKey = requireText(
      input.businessKey,
      '请休假改路由任务业务键无效',
      256,
    );
    return this.enqueue(async () => {
      const ledger = await this.read();
      const entry = findApplication(ledger, recordId);
      const alreadyQueued = ledger.tasks.some(
        (task) => task.businessKey === businessKey,
      );
      if (
        alreadyQueued ||
        entry.resolvedAction !== null ||
        (entry.status !== 'supervisor_pending' &&
          entry.status !== 'manager_pending') ||
        !entry.currentStage ||
        !sameStage(entry.currentStage, expectedStage)
      ) {
        return { scheduled: false, entry: clone(entry) };
      }
      const updated = touch(
        entry,
        {
          status: 'routing_failed',
          currentStage: null,
          lastError: '审批路由更正中',
        },
        new Date(),
      );
      replaceApplication(ledger, updated);
      enqueueTask(ledger, {
        businessKey,
        recordId,
        kind: 'repair_station_chief_route',
        payload: {
          sourceStageKey: expectedStage.key,
          sourceStageVersion: expectedStage.version,
          sourceApproverOpenIds: expectedStage.approverOpenIds,
        },
      });
      await this.write(ledger);
      return { scheduled: true, entry: clone(updated) };
    });
  }

  async completePendingStageReroute(
    recordId: string,
    input: {
      approvalPlan: LeaveApprovalPlan;
      resultRecipients: LeaveRoutePerson[];
      stage: LeaveWorkflowStage;
    },
    now: Date | number = new Date(),
  ): Promise<LeaveWorkflowApplicationEntry> {
    const normalizedRecordId = requireRecordId(recordId);
    const stage = normalizeStage(input.stage);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const entry = findApplication(ledger, normalizedRecordId);
      if (
        entry.currentStage &&
        sameStage(entry.currentStage, stage) &&
        entry.status ===
          (stage.key === 'manager' ? 'manager_pending' : 'supervisor_pending')
      ) {
        return clone(entry);
      }
      if (
        entry.status !== 'routing_failed' ||
        entry.currentStage !== null ||
        entry.resolvedAction !== null
      ) {
        throw new ConflictException('请休假改路由状态已变化，已停止覆盖');
      }
      const updated = touch(
        entry,
        {
          approvalPlan: clone(input.approvalPlan),
          resultRecipients: uniquePeople(input.resultRecipients),
          currentStage: stage,
          status:
            stage.key === 'manager' ? 'manager_pending' : 'supervisor_pending',
          lastError: '',
        },
        now,
      );
      replaceApplication(ledger, updated);
      enqueueTask(ledger, {
        businessKey: `leave:${normalizedRecordId}:deliver:${stage.key}:${stage.version}`,
        recordId: normalizedRecordId,
        kind: 'deliver_stage_cards',
        payload: { stageKey: stage.key, stageVersion: stage.version },
      });
      await this.write(ledger);
      return clone(updated);
    });
  }

  async recordStageCardDelivery(
    recordId: string,
    delivery: LeaveWorkflowMessageDelivery,
    now: Date | number = new Date(),
  ): Promise<LeaveWorkflowApplicationEntry> {
    const normalizedRecordId = requireRecordId(recordId);
    const normalizedDelivery = normalizeDelivery(delivery);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const entry = findApplication(ledger, normalizedRecordId);
      if (
        entry.stageCards.some(
          (item) => item.businessKey === normalizedDelivery.businessKey,
        )
      ) {
        return clone(entry);
      }
      const updated = touch(
        entry,
        {
          stageCards: [...entry.stageCards, normalizedDelivery],
        },
        now,
      );
      replaceApplication(ledger, updated);
      const handover=ledger.tasks.find(task=>task.recordId === normalizedRecordId && task.kind === 'sync_personnel_handover' && task.payload.patchOnly !== true &&
        normalizedDelivery.businessKey.startsWith(`leave:${normalizedRecordId}:stage:${task.payload.sourceStageKey}:${task.payload.sourceStageVersion}:`));
      if (handover) enqueueTask(ledger,{recordId:normalizedRecordId,businessKey:`leave:${normalizedRecordId}:handover-late:${createHash('sha256').update(normalizedDelivery.messageId).digest('hex')}`,kind:'sync_personnel_handover',payload:{...handover.payload,patchOnly:true}});
      await this.write(ledger);
      return clone(updated);
    });
  }

  async recordResultCardDelivery(
    recordId: string,
    delivery: LeaveWorkflowMessageDelivery,
    now: Date | number = new Date(),
  ): Promise<LeaveWorkflowApplicationEntry> {
    const normalizedRecordId = requireRecordId(recordId);
    const normalizedDelivery = normalizeDelivery(delivery);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const entry = findApplication(ledger, normalizedRecordId);
      if (
        entry.resultCards.some(
          (item) => item.businessKey === normalizedDelivery.businessKey,
        )
      ) {
        return clone(entry);
      }
      const updated = touch(
        entry,
        {
          resultCards: [...entry.resultCards, normalizedDelivery],
        },
        now,
      );
      replaceApplication(ledger, updated);
      await this.write(ledger);
      return clone(updated);
    });
  }

  async recordSubstituteAdjustmentCardDelivery(
    recordId: string,
    delivery: LeaveWorkflowMessageDelivery,
    now: Date | number = new Date(),
  ): Promise<LeaveWorkflowApplicationEntry> {
    const normalizedRecordId = requireRecordId(recordId);
    const normalizedDelivery = normalizeDelivery(delivery);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const entry = findApplication(ledger, normalizedRecordId);
      if (
        entry.substituteAdjustmentCards.some(
          (item) => item.businessKey === normalizedDelivery.businessKey,
        )
      ) {
        return clone(entry);
      }
      const updated = touch(
        entry,
        {
          substituteAdjustmentCards: [
            ...entry.substituteAdjustmentCards,
            normalizedDelivery,
          ],
        },
        now,
      );
      replaceApplication(ledger, updated);
      await this.write(ledger);
      return clone(updated);
    });
  }

  async markTerminalCardPatched(
    recordId: string,
    messageId: string,
    now: Date | number = new Date(),
  ): Promise<LeaveWorkflowApplicationEntry> {
    const normalizedRecordId = requireRecordId(recordId);
    const normalizedMessageId = requireMessageId(messageId);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const entry = findApplication(ledger, normalizedRecordId);
      if (entry.terminalCardMessageIds.includes(normalizedMessageId))
        return clone(entry);
      const updated = touch(
        entry,
        {
          terminalCardMessageIds: [
            ...entry.terminalCardMessageIds,
            normalizedMessageId,
          ],
        },
        now,
      );
      replaceApplication(ledger, updated);
      await this.write(ledger);
      return clone(updated);
    });
  }

  async claimStageAction(
    input: {
      eventId: string;
      recordId: string;
      stageKey: 'supervisor' | 'manager';
      stageVersion: number;
      actorOpenId: string;
      actorName?: string;
      action: 'approve' | 'reject';
      messageId?: string;
      substituteRequired?: boolean;
      substitutePersonRecordId?: string;
      shiftAssignments?: LeaveShiftSubstituteAssignment[];
      rejectionReason?: string;
    },
    now: Date | number = new Date(),
    isCurrentActor?: (application: LeaveWorkflowApplicationEntry, actorOpenId: string) => boolean,
  ): Promise<{
    accepted: boolean;
    reason: 'accepted' | 'already_processed' | 'invalid_actor' | 'stale_stage';
    entry: LeaveWorkflowApplicationEntry;
    action: LeaveWorkflowActionEntry | null;
  }> {
    const normalized = normalizeActionInput(input);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const application = findApplication(ledger, normalized.recordId);
      const replay = ledger.actions.find(
        (item) => item.eventId === normalized.eventId,
      );
      if (replay) {
        return {
          accepted: false,
          reason: 'already_processed',
          entry: clone(application),
          action: clone(replay),
        };
      }
      const stage = application.currentStage;
      const stageResolved = ledger.actions.find(
        (item) =>
          item.recordId === normalized.recordId &&
          item.stageKey === normalized.stageKey &&
          item.stageVersion === normalized.stageVersion,
      );
      if (
        stageResolved ||
        application.status === 'approved' ||
        application.status === 'rejected'
      ) {
        return {
          accepted: false,
          reason: 'already_processed',
          entry: clone(application),
          action: stageResolved ? clone(stageResolved) : null,
        };
      }
      if (
        !stage ||
        stage.key !== normalized.stageKey ||
        stage.version !== normalized.stageVersion
      ) {
        return {
          accepted: false,
          reason: 'stale_stage',
          entry: clone(application),
          action: null,
        };
      }
      if (isCurrentActor && isCurrentActor(clone(application), normalized.actorOpenId) !== true) throw new ForbiddenException('岗位负责人已变化，请打开最新审批入口');
      if (!stage.approverOpenIds.includes(normalized.actorOpenId)) {
        return {
          accepted: false,
          reason: 'invalid_actor',
          entry: clone(application),
          action: null,
        };
      }
      if (
        application.stageCards.length > 0 &&
        !application.stageCards.some(
          (item) =>
            item.recipientOpenId === normalized.actorOpenId &&
            item.messageId === normalized.messageId,
        )
      ) {
        throw new ForbiddenException('请休假审批动作与已投递卡片不匹配');
      }
      if (ledger.actions.length >= MAX_ACTIONS)
        throw new ConflictException('请休假审批动作台账已满');
      const timestamp = asDate(now).toISOString();
      const substituteRequired = resolveActionSubstituteRequired(
        application,
        normalized,
      );
      const shiftAssignments = resolveActionShiftAssignments(
        application,
        normalized,
        timestamp,
        substituteRequired,
      );
      const substitute = shiftAssignments.length
        ? null
        : resolveActionSubstitute(application, normalized, substituteRequired);
      if (normalized.action === 'approve') {
        assertTwoLevelApplicantIdentity(application, shiftAssignments);
        assertAssignmentsAvailable(ledger.applications, application.recordId, shiftAssignments);
      }
      const assignmentRecipients = shiftAssignmentsToPeople(shiftAssignments);
      const action: LeaveWorkflowActionEntry = {
        key: `leave-action:${normalized.recordId}:${normalized.stageKey}:${normalized.stageVersion}`,
        ...normalized,
        actorName: normalized.actorName || application.approvalPlan?.stages
          .find((item) => item.key === normalized.stageKey)?.approvers
          .find((person) => person.openId === normalized.actorOpenId)?.name || '',
        substituteRequired,
        previousSubstituteOpenId: application.snapshot.substituteOpenId || '',
        previousSubstitutePersonRecordId:
          application.snapshot.substitutePersonRecordId || '',
        previousSubstituteName: application.snapshot.substituteName || '',
        substituteOpenId: substitute?.openId || '',
        substitutePersonRecordId: substitute?.personRecordId || '',
        substituteName: substitute?.name || '',
        previousShiftAssignments: [
          ...(application.snapshot.shiftAssignments || []),
        ],
        shiftAssignments,
        rejectionReason: normalized.rejectionReason,
        createdAt: timestamp,
      };
      ledger.actions.push(action);
      const updated: LeaveWorkflowApplicationEntry = {
        ...application,
        snapshot: {
          ...application.snapshot,
          substituteDecisionMade:
            application.snapshot.substituteDecisionRequired &&
            normalized.action === 'approve'
              ? true
              : Boolean(application.snapshot.substituteDecisionMade),
          substituteRequired:
            normalized.action === 'approve'
              ? substituteRequired
              : Boolean(application.snapshot.substituteRequired),
          ...(normalized.action === 'approve' && !substituteRequired
            ? {
                substituteOpenId: undefined,
                substitutePersonRecordId: undefined,
                substituteName: undefined,
              }
            : substitute
              ? {
                  substituteOpenId: substitute.openId,
                  substitutePersonRecordId: substitute.personRecordId,
                  substituteName: substitute.name,
                }
              : {}),
          shiftAssignments,
          assignmentRevision: application.snapshot.assignmentRevision || 0,
        },
        resultRecipients: uniquePeople([
          ...application.resultRecipients,
          ...(substitute ? [substitute] : []),
          ...assignmentRecipients,
        ]),
        currentStage: null,
        status:
          normalized.action === 'approve'
            ? 'approved_syncing'
            : 'rejected_syncing',
        resolvedAction: normalized.action,
        resolvedByOpenId: normalized.actorOpenId,
        resolvedByName: action.actorName,
        resolvedAt: timestamp,
        rejectionReason: normalized.rejectionReason,
        revision: application.revision + 1,
        updatedAt: timestamp,
        lastError: '',
      };
      replaceApplication(ledger, updated);
      enqueueStageActionCards(ledger, action);
      enqueueTask(ledger, {
        businessKey: `leave:${normalized.recordId}:apply:${normalized.stageKey}:${normalized.stageVersion}`,
        recordId: normalized.recordId,
        kind: 'apply_stage_action',
        payload: {
          stageKey: normalized.stageKey,
          stageVersion: normalized.stageVersion,
        },
      });
      await this.write(ledger);
      return {
        accepted: true,
        reason: 'accepted',
        entry: clone(updated),
        action: clone(action),
      };
    });
  }

  async getStageAction(
    recordId: string,
    stageKey: 'supervisor' | 'manager',
    stageVersion: number,
  ): Promise<LeaveWorkflowActionEntry | null> {
    const normalizedRecordId = requireRecordId(recordId);
    return this.enqueue(async () => {
      const action = (await this.read()).actions.find(
        (item) =>
          item.recordId === normalizedRecordId &&
          item.stageKey === stageKey &&
          item.stageVersion === stageVersion,
      );
      return action ? clone(action) : null;
    });
  }

  async claimSubstituteUpdate(
    input: {
      eventId: string;
      recordId: string;
      expectedRevision: number;
      actorOpenId: string;
      actorName?: string;
      messageId?: string;
      substitutePersonRecordId?: string;
      shiftAssignments?: LeaveShiftSubstituteAssignment[];
    },
    now: Date | number = new Date(),
    isCurrentActor?: (application: LeaveWorkflowApplicationEntry, actorOpenId: string) => boolean,
  ): Promise<{
    accepted: boolean;
    reason:
      | 'accepted'
      | 'already_processed'
      | 'invalid_actor'
      | 'stale_revision';
    entry: LeaveWorkflowApplicationEntry;
    update: LeaveWorkflowSubstituteUpdateEntry | null;
  }> {
    const normalized = normalizeSubstituteUpdateInput(input);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const application = findApplication(ledger, normalized.recordId);
      const replay = ledger.substituteUpdates.find(
        (item) => item.eventId === normalized.eventId,
      );
      if (replay) {
        return {
          accepted: false,
          reason: 'already_processed',
          entry: clone(application),
          update: clone(replay),
        };
      }
      const currentRevision =
        application.snapshot.assignmentRevision ??
        application.snapshot.substituteRevision ??
        0;
      if (
        application.status !== 'approved' ||
        !application.snapshot.substituteRequired ||
        normalized.expectedRevision !== currentRevision
      ) {
        return {
          accepted: false,
          reason: 'stale_revision',
          entry: clone(application),
          update: null,
        };
      }
      const approverOpenIds = new Set(
        (application.approvalPlan?.stages || []).flatMap((stage) =>
          stage.approvers.map((person) => person.openId),
        ),
      );
      if (isCurrentActor ? isCurrentActor(clone(application), normalized.actorOpenId) !== true : !approverOpenIds.has(normalized.actorOpenId)) {
        return {
          accepted: false,
          reason: 'invalid_actor',
          entry: clone(application),
          update: null,
        };
      }
      if (
        normalized.messageId &&
        application.substituteAdjustmentCards.length > 0 &&
        !application.substituteAdjustmentCards.some(
          (item) =>
            item.recipientOpenId === normalized.actorOpenId &&
            item.messageId === normalized.messageId &&
            !application.terminalCardMessageIds.includes(item.messageId) &&
            item.businessKey.includes(`:${normalized.expectedRevision}:`),
        )
      ) {
        throw new ForbiddenException('替班调整动作与已投递卡片不匹配');
      }
      if (ledger.substituteUpdates.length >= MAX_ACTIONS) {
        throw new ConflictException('替班调整动作台账已满');
      }
      const timestamp = asDate(now).toISOString();
      const revision = currentRevision + 1;
      const previousShiftAssignments = [
        ...(application.snapshot.shiftAssignments || []),
      ];
      const shiftAssignments = (application.snapshot.shiftGroups || []).length
        ? resolveCompleteShiftAssignments(
            application.snapshot,
            normalized.shiftAssignments,
            normalized.actorOpenId,
            normalized.actorName,
            timestamp,
          )
        : [];
      const substitute = shiftAssignments.length
        ? null
        : (application.snapshot.substituteCandidates || []).find(
            (candidate) =>
              candidate.personRecordId === normalized.substitutePersonRecordId,
          );
      assertTwoLevelApplicantIdentity(application, shiftAssignments);
      assertAssignmentsAvailable(ledger.applications, application.recordId, shiftAssignments);
      if (!shiftAssignments.length && !substitute) {
        throw new BadRequestException('所选替班人员不在当前可用人员清单中');
      }
      const changedShiftKeys = findChangedShiftKeys(
        previousShiftAssignments,
        shiftAssignments,
      );
      const update: LeaveWorkflowSubstituteUpdateEntry = {
        key: `leave-substitute-update:${normalized.recordId}:${revision}`,
        ...normalized,
        revision,
        previousSubstituteOpenId: application.snapshot.substituteOpenId || '',
        previousSubstitutePersonRecordId:
          application.snapshot.substitutePersonRecordId || '',
        previousSubstituteName: application.snapshot.substituteName || '',
        substituteOpenId: substitute?.openId || '',
        substitutePersonRecordId: substitute?.personRecordId || '',
        substituteName: substitute?.name || '',
        previousShiftAssignments,
        shiftAssignments,
        changedShiftKeys,
        createdAt: timestamp,
      };
      ledger.substituteUpdates.push(update);
      const updated: LeaveWorkflowApplicationEntry = {
        ...application,
        snapshot: {
          ...application.snapshot,
          ...(substitute
            ? {
                substituteOpenId: substitute.openId,
                substitutePersonRecordId: substitute.personRecordId,
                substituteName: substitute.name,
              }
            : {}),
          substituteRevision: revision,
          shiftAssignments,
          assignmentRevision: revision,
          substituteUpdatedByOpenId: normalized.actorOpenId,
          substituteUpdatedByName: normalized.actorName,
          substituteUpdatedAt: timestamp,
        },
        resultRecipients: uniquePeople([
          ...application.resultRecipients,
          ...(substitute?.openId ? [substitute] : []),
          ...shiftAssignmentsToPeople(shiftAssignments),
        ]),
        revision: application.revision + 1,
        updatedAt: timestamp,
        lastError: '',
      };
      replaceApplication(ledger, updated);
      enqueueTask(ledger, {
        businessKey: `leave:${normalized.recordId}:substitute-update:${revision}`,
        recordId: normalized.recordId,
        kind: 'apply_substitute_update',
        payload: { revision },
      });
      await this.write(ledger);
      return {
        accepted: true,
        reason: 'accepted',
        entry: clone(updated),
        update: clone(update),
      };
    });
  }

  async getSubstituteUpdate(
    recordId: string,
    revision: number,
  ): Promise<LeaveWorkflowSubstituteUpdateEntry | null> {
    const normalizedRecordId = requireRecordId(recordId);
    return this.enqueue(async () => {
      const update = (await this.read()).substituteUpdates.find(
        (item) =>
          item.recordId === normalizedRecordId && item.revision === revision,
      );
      return update ? clone(update) : null;
    });
  }

  async getOriginalPostBackfillHistory(recordId: string): Promise<LeaveShiftSubstituteAssignment[]> {
    const id = requireRecordId(recordId);
    return this.enqueue(async () => {
      const ledger = await this.read();
      const application = findApplication(ledger, id);
      const assignments = [
        ...(application.snapshot.shiftAssignments || []),
        ...ledger.actions.filter((action) => action.recordId === id && action.action === 'approve').flatMap((action) => [...action.previousShiftAssignments, ...action.shiftAssignments]),
        ...ledger.substituteUpdates.filter((update) => update.recordId === id).flatMap((update) => [...update.previousShiftAssignments, ...update.shiftAssignments]),
      ];
      const history = new Map<string, LeaveShiftSubstituteAssignment>();
      for (const assignment of assignments) if (assignment.originalPostBackfills?.length) history.set(JSON.stringify([assignment.shiftKey, assignment.substitutePersonRecordId, assignment.originalPostBackfills]), assignment);
      return clone([...history.values()]);
    });
  }

  async takeNextTask(
    now: Date | number = new Date(),
    leaseMs = DEFAULT_LEASE_MS,
  ): Promise<LeaveWorkflowTaskEntry | null> {
    return this.enqueue(async () => {
      const ledger = await this.read();
      const timestamp = asDate(now);
      for (const task of ledger.tasks) {
        if (
          task.status === 'processing' &&
          task.leaseUntil &&
          Date.parse(task.leaseUntil) <= timestamp.getTime()
        ) {
          task.status = 'pending';
          task.updatedAt = timestamp.toISOString();
          task.nextAttemptAt = timestamp.toISOString();
          task.leaseUntil = '';
          task.claimToken = '';
          task.lastError =
            task.lastError || 'Previous task lease expired and was recovered.';
        }
      }
      let index = -1;
      let secondaryIndex = -1;
      for (let candidate = 0; candidate < ledger.tasks.length; candidate += 1) {
        const task = ledger.tasks[candidate];
        if (task.status !== 'pending' || Date.parse(task.nextAttemptAt) > timestamp.getTime()) continue;
        const current = ledger.tasks[index];
        if (!current || taskPriority(task) < taskPriority(current) ||
            (taskPriority(task) === taskPriority(current) && task.attempts < current.attempts)) index = candidate;
        const secondary = ledger.tasks[secondaryIndex];
        if (taskPriority(task) > 0 && (!secondary || taskPriority(task) < taskPriority(secondary) ||
            (taskPriority(task) === taskPriority(secondary) && task.attempts < secondary.attempts))) secondaryIndex = candidate;
      }
      if (index < 0) return null;
      if (taskPriority(ledger.tasks[index]) === 0 && this.primaryTaskBurst >= PRIMARY_TASK_BURST && secondaryIndex >= 0) index = secondaryIndex;
      const current = ledger.tasks[index];
      const task: LeaveWorkflowTaskEntry = {
        ...current,
        status: 'processing',
        attempts: current.attempts + 1,
        updatedAt: timestamp.toISOString(),
        leaseUntil: new Date(
          timestamp.getTime() + Math.max(1_000, leaseMs),
        ).toISOString(),
        claimToken: randomUUID(),
      };
      ledger.tasks[index] = task;
      await this.write(ledger);
      if (taskPriority(current) > 0) this.primaryTaskBurst = 0;
      else if (taskPriority(current) === 0) this.primaryTaskBurst = Math.min(PRIMARY_TASK_BURST, this.primaryTaskBurst + 1);
      return clone(task);
    }, false);
  }

  async recordStageActionCardPatched(key: string, claimToken: string, messageId: string): Promise<void> {
    const normalized = requireMessageId(messageId);
    await this.updateClaimedTask(key, claimToken, (task) => {
      if (task.kind !== 'sync_stage_action_cards') throw new BadRequestException('审批卡片同步任务类型无效');
      const patched = Array.isArray(task.payload.patchedMessageIds) ? task.payload.patchedMessageIds.filter((id): id is string => typeof id === 'string') : [];
      return { ...task, payload: { ...task.payload, patchedMessageIds: [...new Set([...patched, normalized])] } };
    });
  }

  async enqueueTask(input: {
    businessKey: string;
    recordId: string;
    kind: LeaveWorkflowTaskKind;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.read();
      enqueueTask(ledger, input);
      await this.write(ledger);
    }, false);
  }

  async completeTask(
    key: string,
    claimToken: string,
    now: Date | number = new Date(),
  ): Promise<void> {
    await this.updateClaimedTask(key, claimToken, (task) => ({
      ...task,
      status: 'completed',
      updatedAt: asDate(now).toISOString(),
      completedAt: asDate(now).toISOString(),
      leaseUntil: '',
      claimToken: '',
      lastError: '',
    }));
  }

  async rescheduleTask(
    key: string,
    claimToken: string,
    error: unknown,
    now: Date | number = new Date(),
    maxAttempts = Number.POSITIVE_INFINITY,
  ): Promise<void> {
    await this.updateClaimedTask(key, claimToken, (task) => {
      const timestamp = asDate(now);
      const terminal = task.attempts >= maxAttempts;
      const delay = Math.min(
        BASE_RETRY_MS * 2 ** Math.max(0, task.attempts - 1),
        task.kind === 'route_application' || task.kind === 'deliver_stage_cards' ? 30_000 : MAX_RETRY_MS,
      );
      return {
        ...task,
        status: terminal ? 'failed' : 'pending',
        updatedAt: timestamp.toISOString(),
        completedAt: terminal ? timestamp.toISOString() : '',
        nextAttemptAt: terminal
          ? task.nextAttemptAt
          : new Date(timestamp.getTime() + delay).toISOString(),
        leaseUntil: '',
        claimToken: '',
        lastError: sanitizeError(error),
      };
    });
  }

  async retryFailedTasks(keys: readonly string[], authorize: () => void): Promise<void> {
    if (!Array.isArray(keys) || keys.length > 1000 || new Set(keys).size !== keys.length || keys.some(key => typeof key !== 'string' || !key || key.length > 1000)) throw new BadRequestException('请休假恢复任务范围无效');
    await this.enqueue(async () => {
      const ledger = await this.read(), tasks = keys.map(key => ledger.tasks.find(task => task.key === key));
      if (tasks.some(task => !task)) throw new ConflictException('原请休假任务已变化');
      authorize(); let changed = false;
      for (const task of tasks) {
        if (!task || task.status !== 'failed' && !(task.status === 'pending' && task.lastError)) continue;
        task.status = 'pending'; task.nextAttemptAt = new Date().toISOString(); task.completedAt = ''; task.lastError = ''; task.claimToken = ''; task.leaseUntil = ''; changed = true;
      }
      if (changed) await this.write(ledger);
    });
  }

  async listTasks(): Promise<LeaveWorkflowTaskEntry[]> {
    return this.enqueue(async () => clone((await this.read()).tasks), false);
  }
  async personnelHandoverSnapshot(): Promise<{applications:LeaveWorkflowApplicationEntry[];tasks:LeaveWorkflowTaskEntry[]}> {
    return this.enqueue(async()=>{const ledger=await this.read();return clone({applications:ledger.applications,tasks:ledger.tasks});});
  }

  async wakePendingTasks(now: Date | number = new Date()): Promise<number> {
    return this.enqueue(async () => {
      const ledger = await this.read();
      const timestamp = asDate(now);
      let awakened = 0;
      for (const task of ledger.tasks) {
        if (task.status !== 'pending') continue;
        const nextAttemptAt = Date.parse(task.nextAttemptAt);
        if (
          Number.isFinite(nextAttemptAt) &&
          nextAttemptAt <= timestamp.getTime()
        ) {
          continue;
        }
        task.nextAttemptAt = timestamp.toISOString();
        task.updatedAt = timestamp.toISOString();
        awakened += 1;
      }
      if (awakened > 0) await this.write(ledger);
      return awakened;
    }, false);
  }

  private async updateClaimedTask(
    key: string,
    claimToken: string,
    update: (task: LeaveWorkflowTaskEntry) => LeaveWorkflowTaskEntry,
  ): Promise<void> {
    return this.enqueue(async () => {
      const ledger = await this.read();
      const index = ledger.tasks.findIndex(
        (task) =>
          task.key === key &&
          task.status === 'processing' &&
          task.claimToken === claimToken,
      );
      if (index < 0) return;
      ledger.tasks[index] = update(ledger.tasks[index]);
      await this.write(ledger);
    }, false);
  }

  private enqueue<T>(operation: () => Promise<T>, cardAction = true): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queue = cardAction ? this.cardOperations : this.operations;
      queue.push(async () => {
        try { resolve(await operation()); }
        catch (error) { reject(error); }
      });
      if (!this.drainingOperations) void this.drainOperations();
    });
  }

  private async drainOperations(): Promise<void> {
    this.drainingOperations = true;
    try {
      while (this.cardOperations.length || this.operations.length) {
        // Business mutations stay FIFO; only queued outbox bookkeeping yields to card work.
        const card = this.cardOperations.length > 0 &&
          (this.operations.length === 0 || this.cardOperationBurst < 4);
        this.cardOperationBurst = card ? this.cardOperationBurst + 1 : 0;
        await (card ? this.cardOperations : this.operations).shift()!();
        if (card) await yieldToEventLoop();
      }
    } finally {
      this.cardOperationBurst = 0;
      this.drainingOperations = false;
    }
  }

  private async read(): Promise<Ledger> {
    return (await this.readPath(this.ledgerPath)).ledger;
  }

  private async readPath(
    ledgerPath: string,
    applicationRecordId?: string,
  ): Promise<{ exists: boolean; ledger: Ledger }> {
    try {
      const source = await readFile(ledgerPath);
      const cached = this.ledgerReadCache;
      const persisted = cached?.path === ledgerPath && cached.source.equals(source)
        ? cached.parsed
        : JSON.parse(source.toString('utf8')) as Partial<Ledger>;
      this.rememberLedgerRead(ledgerPath, source, persisted);
      // Applications are immutable; task leases must remain private to this operation.
      const parsed = { ...persisted, tasks: clone(persisted.tasks || []) };
      // Single-record reads need not normalize every historical candidate list.
      // Mutations still read and validate the complete ledger before committing.
      if (applicationRecordId && Array.isArray(parsed.applications)) {
        parsed.applications = parsed.applications.filter(
          entry => isApplication(entry) && entry.recordId === applicationRecordId,
        );
      }
      return {
        exists: true,
        ledger: normalizeLedger(parsed, value => this.normalizeApplicationForRead(value)),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return {
          exists: false,
          ledger: emptyLedger(),
        };
      throw error;
    }
  }

  private normalizeApplicationForRead(value: LeaveWorkflowApplicationEntry): LeaveWorkflowApplicationEntry {
    // 比较完整输入而非mtime；每次读取仍可见外部修改，缓存不持有可变业务对象。
    if (!value.createdAt || !value.updatedAt) return normalizeApplication(value);
    const cached = this.normalizedApplications.get(value.recordId);
    if (cached?.value === value) return value;
    const source = JSON.stringify(value);
    if (cached?.source === source) return cached.value;
    const normalized = normalizeApplication(value);
    if (cached) {
      this.normalizedApplications.delete(value.recordId);
      this.normalizationCacheCharacters -= cached.source.length;
    }
    // 满额时保留已有热项，避免整表顺序读取导致LRU逐条抖动；公开方法仍返回独立副本。
    if (this.normalizedApplications.size < NORMALIZATION_CACHE_ENTRIES &&
        this.normalizationCacheCharacters + source.length <= NORMALIZATION_CACHE_CHARACTERS) {
      freezeApplicationRead(normalized);
      this.normalizedApplications.set(value.recordId, { source, value: normalized });
      this.normalizationCacheCharacters += source.length;
    }
    return normalized;
  }

  private rememberLedgerRead(path: string, source: Buffer, parsed: Partial<Ledger>): void {
    if (source.byteLength > LEDGER_READ_CACHE_BYTES) {
      this.ledgerReadCache = null;
      return;
    }
    freezeApplicationRead(parsed);
    this.ledgerReadCache = { path, source, parsed };
  }

  private async mergeLegacyLedger(): Promise<void> {
    if (this.legacyLedgerPath === this.ledgerPath) return;
    const legacy = await this.readPath(this.legacyLedgerPath);
    if (!legacy.exists || isEmptyLedger(legacy.ledger)) return;
    const primary = await this.readPath(this.ledgerPath);
    const merged = mergeLedgers(primary.ledger, legacy.ledger);
    if (JSON.stringify(merged) === JSON.stringify(primary.ledger)) return;
    await this.write(merged);
    this.logger.log(
      `Merged legacy leave workflow ledger into persistent state: ${merged.applications.length} application(s)`,
    );
  }

  private async write(ledger: Ledger): Promise<void> {
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    const temporaryPath = `${this.ledgerPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    try {
      // Reuse only immutable application JSON; mutable bookkeeping is encoded afresh.
      const { applications, ...fields } = ledger;
      const encodedApplications = applications.map(application => {
        const cached = this.serializedApplications.get(application);
        if (cached !== undefined) return cached;
        const encoded = JSON.stringify(application);
        if (Object.isFrozen(application)) this.serializedApplications.set(application, encoded);
        return encoded;
      });
      const source = Buffer.from(`{"applications":[${encodedApplications.join(',')}],${JSON.stringify(fields).slice(1)}`);
      await writeFile(temporaryPath, source, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rename(temporaryPath, this.ledgerPath);
          break;
        } catch (error) {
          if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
          await new Promise(resolveDelay => setTimeout(resolveDelay, 25 * 2 ** attempt));
        }
      }
      // Publish a snapshot only after the atomic replacement succeeds.
      this.rememberLedgerRead(this.ledgerPath, source, ledger);
    } catch (error) {
      try { await rm(temporaryPath, { force: true }); }
      catch (cleanupError) { this.logger.warn(`请休假台账临时文件清理失败：${sanitizeError(cleanupError)}`); }
      throw error;
    }
  }
}

function enqueueStageActionCards(ledger: Ledger, action: LeaveWorkflowActionEntry, recovery = false): void {
  enqueueTask(ledger, {
    businessKey: `leave:${action.recordId}:stage-action-cards:${action.stageKey}:${action.stageVersion}`,
    recordId: action.recordId,
    kind: 'sync_stage_action_cards',
    payload: { stageKey: action.stageKey, stageVersion: action.stageVersion, ...(recovery ? { recovery: true } : {}) },
  });
}

function freezeApplicationRead(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeApplicationRead(child);
}

function taskPriority(task: LeaveWorkflowTaskEntry): number {
  const kind = task.kind;
  if (kind === 'sync_stage_action_cards') return task.payload.recovery === true ? 2 : -1;
  if (kind === 'deliver_result_cards') return 0;
  return ['route_application', 'deliver_stage_cards', 'apply_stage_action', 'repair_station_chief_route', 'sync_personnel_handover'].includes(kind) ? 0 : 1;
}

function emptyLedger(): Ledger {
  return {
    version: 4,
    applications: [],
    actions: [],
    substituteUpdates: [],
    tasks: [],
  };
}

function normalizeLedger(parsed: Partial<Ledger>, normalizeEntry = normalizeApplication): Ledger {
  return {
    version: 4,
    applications: Array.isArray(parsed.applications)
      ? parsed.applications.filter(isApplication).map(normalizeEntry)
      : [],
    actions: Array.isArray(parsed.actions)
      ? parsed.actions.filter(isAction).map(normalizeAction)
      : [],
    substituteUpdates: Array.isArray(parsed.substituteUpdates)
      ? parsed.substituteUpdates
          .filter(isSubstituteUpdate)
          .map(normalizeSubstituteUpdate)
      : [],
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks.filter(isTask) : [],
  };
}

function isEmptyLedger(ledger: Ledger): boolean {
  return (
    ledger.applications.length === 0 &&
    ledger.actions.length === 0 &&
    ledger.substituteUpdates.length === 0 &&
    ledger.tasks.length === 0
  );
}

function mergeLedgers(primary: Ledger, legacy: Ledger): Ledger {
  const applications = new Map(
    primary.applications.map((entry) => [entry.recordId, entry] as const),
  );
  for (const legacyEntry of legacy.applications) {
    const current = applications.get(legacyEntry.recordId);
    applications.set(
      legacyEntry.recordId,
      current ? mergeApplications(current, legacyEntry) : legacyEntry,
    );
  }
  const merged: Ledger = {
    version: 4,
    applications: [...applications.values()],
    actions: mergeUniqueEntries(primary.actions, legacy.actions, (entry) =>
      entry.eventId ? `event:${entry.eventId}` : `key:${entry.key}`,
    ),
    substituteUpdates: mergeUniqueEntries(
      primary.substituteUpdates,
      legacy.substituteUpdates,
      (entry) =>
        entry.eventId ? `event:${entry.eventId}` : `key:${entry.key}`,
    ),
    tasks: mergeTasks(primary.tasks, legacy.tasks),
  };
  if (merged.applications.length > MAX_APPLICATIONS)
    throw new ConflictException(
      'Legacy leave workflow merge exceeds application limit',
    );
  if (merged.actions.length > MAX_ACTIONS)
    throw new ConflictException(
      'Legacy leave workflow merge exceeds action limit',
    );
  if (merged.tasks.length > MAX_TASKS)
    throw new ConflictException(
      'Legacy leave workflow merge exceeds task limit',
    );
  return merged;
}

function mergeApplications(
  primary: LeaveWorkflowApplicationEntry,
  legacy: LeaveWorkflowApplicationEntry,
): LeaveWorkflowApplicationEntry {
  const base = chooseAuthoritativeApplication(primary, legacy);
  const merged = normalizeApplication({
    ...base,
    stageCards: uniqueDeliveries([...primary.stageCards, ...legacy.stageCards]),
    terminalCardMessageIds: [
      ...new Set([
        ...primary.terminalCardMessageIds,
        ...legacy.terminalCardMessageIds,
      ]),
    ],
    resultCards: uniqueDeliveries([
      ...primary.resultCards,
      ...legacy.resultCards,
    ]),
    substituteAdjustmentCards: uniqueDeliveries([
      ...primary.substituteAdjustmentCards,
      ...legacy.substituteAdjustmentCards,
    ]),
    resultRecipients: uniquePeople([
      ...primary.resultRecipients,
      ...legacy.resultRecipients,
    ]),
    createdAt: earliestTimestamp(primary.createdAt, legacy.createdAt),
    updatedAt: latestTimestamp(primary.updatedAt, legacy.updatedAt),
    revision: Math.max(primary.revision, legacy.revision),
  });
  const changed = JSON.stringify(merged) !== JSON.stringify(primary);
  return changed
    ? { ...merged, revision: Math.max(primary.revision, legacy.revision) + 1 }
    : merged;
}

function chooseAuthoritativeApplication(
  primary: LeaveWorkflowApplicationEntry,
  legacy: LeaveWorkflowApplicationEntry,
): LeaveWorkflowApplicationEntry {
  const primaryRank = applicationStatusRank(primary.status);
  const legacyRank = applicationStatusRank(legacy.status);
  if (primaryRank !== legacyRank)
    return primaryRank > legacyRank ? primary : legacy;
  if (primary.revision !== legacy.revision)
    return primary.revision > legacy.revision ? primary : legacy;
  return timestampValue(primary.updatedAt) >= timestampValue(legacy.updatedAt)
    ? primary
    : legacy;
}

function applicationStatusRank(status: LeaveWorkflowStatus): number {
  switch (status) {
    case 'approved':
    case 'rejected':
      return 6;
    case 'approved_syncing':
    case 'rejected_syncing':
      return 5;
    case 'manager_pending':
      return 4;
    case 'supervisor_pending':
      return 3;
    case 'accepted':
      return 2;
    case 'routing_failed':
    case 'sync_error':
      return 1;
  }
}

function uniqueDeliveries(
  deliveries: LeaveWorkflowMessageDelivery[],
): LeaveWorkflowMessageDelivery[] {
  return mergeUniqueEntries(deliveries, [], (entry) => entry.messageId);
}

function mergeUniqueEntries<T>(
  primary: T[],
  legacy: T[],
  keyOf: (entry: T) => string,
): T[] {
  const entries = new Map(
    primary.map((entry) => [keyOf(entry), entry] as const),
  );
  for (const entry of legacy) {
    const key = keyOf(entry);
    if (!entries.has(key)) entries.set(key, entry);
  }
  return [...entries.values()];
}

function mergeTasks(
  primary: LeaveWorkflowTaskEntry[],
  legacy: LeaveWorkflowTaskEntry[],
): LeaveWorkflowTaskEntry[] {
  const tasks = new Map(
    primary.map((entry) => [entry.businessKey, entry] as const),
  );
  for (const legacyEntry of legacy) {
    const current = tasks.get(legacyEntry.businessKey);
    if (!current || shouldPreferTask(legacyEntry, current)) {
      tasks.set(legacyEntry.businessKey, legacyEntry);
    }
  }
  return [...tasks.values()];
}

function shouldPreferTask(
  candidate: LeaveWorkflowTaskEntry,
  current: LeaveWorkflowTaskEntry,
): boolean {
  if (candidate.status === 'completed' && current.status !== 'completed')
    return true;
  if (current.status === 'completed' && candidate.status !== 'completed')
    return false;
  return (
    timestampValue(candidate.updatedAt) > timestampValue(current.updatedAt)
  );
}

function earliestTimestamp(left: string, right: string): string {
  return timestampValue(left) <= timestampValue(right) ? left : right;
}

function latestTimestamp(left: string, right: string): string {
  return timestampValue(left) >= timestampValue(right) ? left : right;
}

function timestampValue(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function enqueueTask(
  ledger: Ledger,
  input: {
    businessKey: string;
    recordId: string;
    kind: LeaveWorkflowTaskKind;
    payload?: Record<string, unknown>;
  },
): void {
  if (ledger.tasks.some((task) => task.businessKey === input.businessKey))
    return;
  if (ledger.tasks.length >= MAX_TASKS)
    throw new ConflictException('请休假工作流后台任务台账已满');
  const timestamp = new Date().toISOString();
  ledger.tasks.push({
    key: `leave-task:${randomUUID()}`,
    businessKey: requireText(input.businessKey, '请休假任务业务键无效', 256),
    recordId: requireRecordId(input.recordId),
    kind: input.kind,
    payload: clone(input.payload || {}),
    status: 'pending',
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    nextAttemptAt: timestamp,
    leaseUntil: '',
    claimToken: '',
    completedAt: '',
    lastError: '',
  });
}

function findApplication(
  ledger: Ledger,
  recordId: string,
): LeaveWorkflowApplicationEntry {
  const entry = ledger.applications.find(
    (candidate) => candidate.recordId === recordId,
  );
  if (!entry) throw new NotFoundException('未找到请休假工作流记录');
  return entry;
}

function replaceApplication(
  ledger: Ledger,
  entry: LeaveWorkflowApplicationEntry,
): void {
  const index = ledger.applications.findIndex(
    (candidate) => candidate.recordId === entry.recordId,
  );
  if (index < 0) throw new NotFoundException('未找到请休假工作流记录');
  ledger.applications[index] = entry;
}

function touch(
  entry: LeaveWorkflowApplicationEntry,
  patch: Partial<LeaveWorkflowApplicationEntry>,
  now: Date | number,
): LeaveWorkflowApplicationEntry {
  return {
    ...entry,
    ...patch,
    revision: entry.revision + 1,
    updatedAt: asDate(now).toISOString(),
  };
}

function normalizeApplicationInput(input: {
  clientMutationId: string;
  recordId: string;
  snapshot: LeaveWorkflowSnapshot;
}) {
  return {
    clientMutationId: requireText(
      input.clientMutationId,
      '请求唯一ID无效',
      128,
    ),
    recordId: requireRecordId(input.recordId),
    snapshot: normalizeSnapshot(input.snapshot),
  };
}

function normalizeSnapshot(
  snapshot: LeaveWorkflowSnapshot,
): LeaveWorkflowSnapshot {
  const startAt = requireText(snapshot?.startAt, '请休假开始时间无效', 64);
  const endAt = requireText(snapshot?.endAt, '请休假结束时间无效', 64);
  if (
    !Number.isFinite(Date.parse(startAt)) ||
    !Number.isFinite(Date.parse(endAt)) ||
    Date.parse(endAt) < Date.parse(startAt)
  ) {
    throw new BadRequestException('请休假结束时间不能早于开始时间');
  }
  return {
    applicantName: requireText(snapshot?.applicantName, '请休假人员无效', 100),
    applicantOpenId: optionalOpenId(snapshot?.applicantOpenId),
    applicantPersonRecordId: optionalRecordId(
      snapshot?.applicantPersonRecordId,
    ),
    applicantNotificationOpenIds: [
      ...new Set(
        (snapshot?.applicantNotificationOpenIds || [])
          .map(optionalOpenId)
          .filter(Boolean),
      ),
    ],
    building: String(snapshot?.building || '').trim(),
    position: String(snapshot?.position || '').trim(),
    leaveType: requireText(snapshot?.leaveType, '休假类型无效', 100),
    startAt,
    endAt,
    leaveHours: nonNegativeNumber(snapshot?.leaveHours, '休假工时无效'),
    approvalDayCount: nonNegativeNumber(
      snapshot?.approvalDayCount,
      '请休假审批天数无效',
    ),
    reason: String(snapshot?.reason || '')
      .trim()
      .slice(0, 2_000),
    screenshotImageKeys: [
      ...new Set(
        (snapshot?.screenshotImageKeys || [])
          .map((value) => String(value || '').trim())
          .filter((value) => /^img_[A-Za-z0-9_-]{1,300}$/u.test(value)),
      ),
    ].slice(0, 3),
    screenshotStatus:
      snapshot?.screenshotStatus === 'ready' ||
      snapshot?.screenshotStatus === 'missing' ||
      snapshot?.screenshotStatus === 'unavailable'
        ? snapshot.screenshotStatus
        : undefined,
    substituteName: String(snapshot?.substituteName || '').trim() || undefined,
    substituteOpenId: optionalOpenId(snapshot?.substituteOpenId),
    substitutePersonRecordId: optionalRecordId(
      snapshot?.substitutePersonRecordId,
    ),
    substituteRequired: Boolean(snapshot?.substituteRequired),
    substituteDecisionRequired: Boolean(snapshot?.substituteDecisionRequired),
    substituteDecisionMade: Boolean(snapshot?.substituteDecisionMade),
    substituteCandidates: uniqueSubstituteCandidates(
      snapshot?.substituteCandidates || [],
    ),
    substituteRevision:
      Number.isSafeInteger(snapshot?.substituteRevision) &&
      Number(snapshot.substituteRevision) >= 0
        ? Number(snapshot.substituteRevision)
        : 0,
    substituteUpdatedByOpenId: optionalOpenId(
      snapshot?.substituteUpdatedByOpenId,
    ),
    substituteUpdatedByName:
      String(snapshot?.substituteUpdatedByName || '').trim() || undefined,
    substituteUpdatedAt:
      String(snapshot?.substituteUpdatedAt || '').trim() || undefined,
    shiftGroups: normalizeShiftGroups(snapshot?.shiftGroups || []),
    candidateSets: normalizeCandidateSets(snapshot?.candidateSets || []),
    shiftAssignments: normalizeShiftAssignments(
      snapshot?.shiftAssignments || [],
    ),
    assignmentRevision:
      Number.isSafeInteger(snapshot?.assignmentRevision) &&
      Number(snapshot.assignmentRevision) >= 0
        ? Number(snapshot.assignmentRevision)
        : 0,
  };
}

function normalizeShiftGroups(
  groups: LeaveRequestShiftGroup[],
): LeaveRequestShiftGroup[] {
  const validKinds = new Set<LeaveScheduleKind>([
    'white',
    'night',
    'long_white',
    'station_110_white',
    'station_110_night',
  ]);
  const normalized = groups.map((group) => {
    if (!validKinds.has(group?.kind)) {
      throw new BadRequestException('实际班次类型无效');
    }
    return {
      shiftKey: requireText(group?.shiftKey, '实际班次标识无效', 160),
      scheduleDate: requireText(group?.scheduleDate, '实际班次日期无效', 10),
      startAt: requireText(group?.startAt, '实际班次开始时间无效', 32),
      endAt: requireText(group?.endAt, '实际班次结束时间无效', 32),
      kind: group.kind,
      shift: requireText(group?.shift, '实际班次名称无效', 100),
      buildings: uniqueText(group?.buildings || []),
      teams: uniqueText(group?.teams || []),
      scheduleRecordIds: [
        ...new Set((group?.scheduleRecordIds || []).map(requireRecordId)),
      ].sort(),
      leaveHours: nonNegativeNumber(group?.leaveHours, '实际班次请假工时无效'),
    };
  });
  if (
    new Set(normalized.map((group) => group.shiftKey)).size !==
    normalized.length
  ) {
    throw new BadRequestException('实际班次标识重复');
  }
  return normalized.sort((left, right) =>
    left.startAt.localeCompare(right.startAt),
  );
}

function uniqueText(values: string[]): string[] {
  return [
    ...new Set(
      values.map((value) => String(value || '').trim()).filter(Boolean),
    ),
  ].sort();
}

function normalizeCandidateSets(
  sets: LeaveShiftCandidateSet[],
): LeaveShiftCandidateSet[] {
  const result = new Map<string, LeaveShiftCandidateSet>();
  for (const set of sets || []) {
    const shiftKey = requireText(set?.shiftKey, '实际班次候选标识无效', 160);
    if (result.has(shiftKey)) {
      throw new BadRequestException('实际班次候选标识重复');
    }
    result.set(shiftKey, {
      shiftKey,
      candidates: uniqueSubstituteCandidates(set?.candidates || []),
      ...(set.twoLevelCandidates ? { twoLevelCandidates: set.twoLevelCandidates.map((choice) => {
        const [person] = uniqueSubstituteCandidates([choice.person]);
        if (!person?.openId || !person.name) throw new BadRequestException('原岗替班人员无效');
        return { person, originalGroups: normalizeShiftGroups(choice.originalGroups || []), backfillCandidates: uniqueSubstituteCandidates(choice.backfillCandidates || []) };
      }) } : {}),
    });
  }
  return [...result.values()];
}

function normalizeShiftAssignments(
  assignments: LeaveShiftSubstituteAssignment[],
): LeaveShiftSubstituteAssignment[] {
  const result = new Map<string, LeaveShiftSubstituteAssignment>();
  for (const assignment of assignments || []) {
    const shiftKey = requireText(
      assignment?.shiftKey,
      '替班安排班次标识无效',
      160,
    );
    if (result.has(shiftKey)) {
      throw new BadRequestException('同一班次只能保存一名替班人员');
    }
    result.set(shiftKey, {
      shiftKey,
      substitutePersonRecordId: requireRecordId(
        assignment?.substitutePersonRecordId,
      ),
      scheduleRecordIds: [
        ...new Set((assignment?.scheduleRecordIds || []).map(requireRecordId)),
      ].sort(),
      scheduleDate: requireText(
        assignment?.scheduleDate,
        '替班安排日期无效',
        10,
      ),
      startAt: requireText(assignment?.startAt, '替班安排开始时间无效', 32),
      endAt: requireText(assignment?.endAt, '替班安排结束时间无效', 32),
      shift: requireText(assignment?.shift, '替班安排班次无效', 100),
      buildings: uniqueText(assignment?.buildings || []),
      teams: uniqueText(assignment?.teams || []),
      substituteName: requireText(
        assignment?.substituteName,
        '替班人员姓名无效',
        100,
      ),
      substituteOpenId: requireOpenId(assignment?.substituteOpenId),
      updatedByOpenId: requireOpenId(assignment?.updatedByOpenId),
      updatedByName: String(assignment?.updatedByName || '')
        .trim()
        .slice(0, 100),
      updatedAt: requireText(assignment?.updatedAt, '替班安排更新时间无效', 64),
      ...normalizeOriginalPostBackfills(assignment),
    });
  }
  return [...result.values()];
}

function normalizeStage(stage: LeaveWorkflowStage): LeaveWorkflowStage {
  if (stage?.key !== 'supervisor' && stage?.key !== 'manager')
    throw new BadRequestException('请休假审批阶段无效');
  if (!Number.isSafeInteger(stage.version) || stage.version < 1)
    throw new BadRequestException('请休假审批阶段版本无效');
  const approverOpenIds = [
    ...new Set(
      (stage.approverOpenIds || []).map(optionalOpenId).filter(Boolean),
    ),
  ];
  if (!approverOpenIds.length)
    throw new BadRequestException('当前审批阶段缺少审批人');
  return { key: stage.key, version: stage.version, approverOpenIds };
}

function sameStage(
  left: LeaveWorkflowStage,
  right: LeaveWorkflowStage,
): boolean {
  return (
    left.key === right.key &&
    left.version === right.version &&
    [...left.approverOpenIds].sort().join('\n') ===
      [...right.approverOpenIds].sort().join('\n')
  );
}

function normalizeActionInput(input: {
  eventId: string;
  recordId: string;
  stageKey: 'supervisor' | 'manager';
  stageVersion: number;
  actorOpenId: string;
  actorName?: string;
  action: 'approve' | 'reject';
  messageId?: string;
  substituteRequired?: boolean;
  substitutePersonRecordId?: string;
  shiftAssignments?: LeaveShiftSubstituteAssignment[];
  rejectionReason?: string;
}) {
  if (input.stageKey !== 'supervisor' && input.stageKey !== 'manager')
    throw new BadRequestException('请休假审批阶段无效');
  if (!Number.isSafeInteger(input.stageVersion) || input.stageVersion < 1)
    throw new BadRequestException('请休假审批阶段版本无效');
  if (input.action !== 'approve' && input.action !== 'reject')
    throw new BadRequestException('请休假审批动作无效');
  const rejectionReason = String(input.rejectionReason || '').trim();
  if (
    input.action === 'reject' &&
    (rejectionReason.length < 2 || rejectionReason.length > 500)
  ) {
    throw new BadRequestException('请填写驳回原因（2–500 字）');
  }
  return {
    eventId: requireText(input.eventId, '请休假审批事件无效', 160),
    recordId: requireRecordId(input.recordId),
    stageKey: input.stageKey,
    stageVersion: input.stageVersion,
    actorOpenId: requireOpenId(input.actorOpenId),
    actorName: String(input.actorName || '')
      .trim()
      .slice(0, 100),
    action: input.action,
    messageId: input.messageId ? requireMessageId(input.messageId) : '',
    substituteRequired:
      typeof input.substituteRequired === 'boolean'
        ? input.substituteRequired
        : undefined,
    substitutePersonRecordId: optionalRecordId(input.substitutePersonRecordId),
    shiftAssignments: normalizeShiftAssignments(input.shiftAssignments || []),
    rejectionReason: input.action === 'reject' ? rejectionReason : '',
  };
}

function normalizeSubstituteUpdateInput(input: {
  eventId: string;
  recordId: string;
  expectedRevision: number;
  actorOpenId: string;
  actorName?: string;
  messageId?: string;
  substitutePersonRecordId?: string;
  shiftAssignments?: LeaveShiftSubstituteAssignment[];
}) {
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    throw new BadRequestException('替班调整版本无效');
  }
  return {
    eventId: requireText(input.eventId, '替班调整事件无效', 160),
    recordId: requireRecordId(input.recordId),
    expectedRevision: input.expectedRevision,
    actorOpenId: requireOpenId(input.actorOpenId),
    actorName: String(input.actorName || '')
      .trim()
      .slice(0, 100),
    messageId: input.messageId ? requireMessageId(input.messageId) : '',
    substitutePersonRecordId: optionalRecordId(input.substitutePersonRecordId),
    shiftAssignments: normalizeShiftAssignments(input.shiftAssignments || []),
  };
}

function resolveActionSubstitute(
  application: LeaveWorkflowApplicationEntry,
  action: ReturnType<typeof normalizeActionInput>,
  substituteRequired: boolean,
): LeaveRoutePerson | null {
  if (action.action !== 'approve' || !substituteRequired) {
    return null;
  }
  if (action.substitutePersonRecordId) {
    const candidate = (application.snapshot.substituteCandidates || []).find(
      (person) => person.personRecordId === action.substitutePersonRecordId,
    );
    if (!candidate) {
      throw new BadRequestException('所选替班人员不在当前可用人员清单中');
    }
    return candidate;
  }
  if (application.snapshot.substitutePersonRecordId) {
    const current = (application.snapshot.substituteCandidates || []).find(
      (person) =>
        person.personRecordId === application.snapshot.substitutePersonRecordId,
    );
    if (current) return current;
  }
  throw new BadRequestException('请选择替班人员');
}

function resolveActionShiftAssignments(
  application: LeaveWorkflowApplicationEntry,
  action: ReturnType<typeof normalizeActionInput>,
  timestamp: string,
  substituteRequired: boolean,
): LeaveShiftSubstituteAssignment[] {
  const groups = application.snapshot.shiftGroups || [];
  const current = application.snapshot.shiftAssignments || [];
  if (!groups.length) return [];
  if (action.action !== 'approve') {
    return [...current];
  }
  if (!substituteRequired) return [];
  if (!action.shiftAssignments.length && current.length === groups.length) {
    return [...current];
  }
  return resolveCompleteShiftAssignments(
    application.snapshot,
    action.shiftAssignments,
    action.actorOpenId,
    action.actorName,
    timestamp,
  );
}

function resolveActionSubstituteRequired(
  application: LeaveWorkflowApplicationEntry,
  action: ReturnType<typeof normalizeActionInput>,
): boolean {
  const current = Boolean(application.snapshot.substituteRequired);
  if (action.action !== 'approve') return current;
  const undecided =
    application.snapshot.substituteDecisionRequired === true &&
    application.snapshot.substituteDecisionMade !== true;
  if (undecided) {
    if (typeof action.substituteRequired !== 'boolean') {
      throw new BadRequestException('请选择是否需要替班');
    }
    return action.substituteRequired;
  }
  if (
    typeof action.substituteRequired === 'boolean' &&
    action.substituteRequired !== current
  ) {
    throw new BadRequestException('当前请假替班规则不允许修改');
  }
  return current;
}

function resolveCompleteShiftAssignments(
  snapshot: LeaveWorkflowSnapshot,
  requested: LeaveShiftSubstituteAssignment[],
  actorOpenId: string,
  actorName: string,
  timestamp: string,
): LeaveShiftSubstituteAssignment[] {
  const groups = snapshot.shiftGroups || [];
  if (requested.length !== groups.length) {
    throw new BadRequestException('请为每个班次选择替班人员');
  }
  const requestedByShiftKey = new Map(
    requested.map((assignment) => [assignment.shiftKey, assignment] as const),
  );
  if (requestedByShiftKey.size !== requested.length) {
    throw new BadRequestException('同一班次只能保存一名替班人员');
  }
  return groups.map((group) => {
    const source = requestedByShiftKey.get(group.shiftKey);
    if (!source) {
      throw new BadRequestException('请为每个班次选择替班人员');
    }
    const substitute = {
      personRecordId: source.substitutePersonRecordId,
      name: source.substituteName,
      openId: source.substituteOpenId,
    };
    const originalChoice = snapshot.candidateSets?.find((set) => set.shiftKey === group.shiftKey)?.twoLevelCandidates?.find((choice) => choice.person.personRecordId === substitute.personRecordId);
    if (originalChoice?.originalGroups.length && !source.originalPostBackfills?.length) {
      throw new BadRequestException('在岗替班必须同时安排原岗补位人员');
    }
    return {
      shiftKey: group.shiftKey,
      substitutePersonRecordId: requireRecordId(substitute.personRecordId),
      scheduleRecordIds: [...group.scheduleRecordIds],
      scheduleDate: group.scheduleDate,
      startAt: group.startAt,
      endAt: group.endAt,
      shift: group.shift,
      buildings: [...group.buildings],
      teams: [...group.teams],
      substituteName: requireText(substitute.name, '替班人员姓名无效', 100),
      substituteOpenId: requireOpenId(substitute.openId),
      updatedByOpenId: requireOpenId(actorOpenId),
      updatedByName: String(actorName || '')
        .trim()
        .slice(0, 100),
      updatedAt: timestamp,
      ...normalizeOriginalPostBackfills(source),
    };
  });
}

function shiftAssignmentsToPeople(
  assignments: LeaveShiftSubstituteAssignment[],
): LeaveRoutePerson[] {
  return assignments.flatMap((assignment) => [{
    personRecordId: assignment.substitutePersonRecordId,
    name: assignment.substituteName,
    openId: assignment.substituteOpenId,
    position: '',
    buildings: [...assignment.buildings],
  }, ...(assignment.originalPostBackfills || []).map((backup) => ({
    personRecordId: backup.substitutePersonRecordId,
    name: backup.substituteName,
    openId: backup.substituteOpenId,
    position: '',
    buildings: [...backup.group.buildings],
  }))]);
}

function findChangedShiftKeys(
  previous: LeaveShiftSubstituteAssignment[],
  current: LeaveShiftSubstituteAssignment[],
): string[] {
  const previousByShiftKey = new Map(
    previous.map((assignment) => [assignment.shiftKey, assignment] as const),
  );
  return current
    .filter(
      (assignment) =>
        previousByShiftKey.get(assignment.shiftKey)
          ?.substitutePersonRecordId !== assignment.substitutePersonRecordId ||
        JSON.stringify(previousByShiftKey.get(assignment.shiftKey)?.originalPostBackfills || []) !== JSON.stringify(assignment.originalPostBackfills || []),
    )
    .map((assignment) => assignment.shiftKey);
}

function normalizeOriginalPostBackfills(assignment: LeaveShiftSubstituteAssignment): Partial<LeaveShiftSubstituteAssignment> {
  const rows = assignment.originalPostBackfills || [];
  if (!Array.isArray(rows) || rows.length > 64) throw new BadRequestException('原岗补位数量无效');
  if (!rows.length) {
    if (assignment.backfillPersonRecordId || assignment.originalPostSignature) throw new BadRequestException('原岗补位安排不完整');
    return {};
  }
  const groups = normalizeShiftGroups(rows.map((row) => row.group));
  const groupByKey = new Map(groups.map((group) => [group.shiftKey, group]));
  const backups: LeaveOriginalPostBackfill[] = rows.map((row) => {
    const group = groupByKey.get(row.group.shiftKey)!;
    const start = parseShanghaiLocalDateTime(group.startAt);
    const end = parseShanghaiLocalDateTime(group.endAt);
    if (!start || !end || end.epochMs <= start.epochMs || group.shiftKey !== `${group.startAt}__${group.endAt}` || !group.scheduleRecordIds.length) throw new BadRequestException('原岗补位班次无效');
    const personRecordId = requireRecordId(row.substitutePersonRecordId);
    const openId = requireOpenId(row.substituteOpenId);
    if (personRecordId === assignment.substitutePersonRecordId || openId === assignment.substituteOpenId) throw new BadRequestException('原岗补位不能选择同一替班人员');
    return { group, substitutePersonRecordId: personRecordId, substituteName: requireText(row.substituteName, '原岗补位姓名无效', 100), substituteOpenId: openId };
  });
  const backfillPersonRecordId = requireRecordId(assignment.backfillPersonRecordId);
  if (backups.some((row) => row.substitutePersonRecordId !== backfillPersonRecordId) || assignment.originalPostSignature !== originalPostSignature(groups)) throw new BadRequestException('原岗补位安排已变化，请重新核对');
  return { originalPostBackfills: backups, backfillPersonRecordId, originalPostSignature: assignment.originalPostSignature };
}

function assertTwoLevelApplicantIdentity(application: LeaveWorkflowApplicationEntry, assignments: LeaveShiftSubstituteAssignment[]): void {
  if (!assignments.some(assignment => assignment.originalPostBackfills?.length)) return;
  if (!RECORD_ID_PATTERN.test(application.snapshot.applicantPersonRecordId || '') || !OPEN_ID_PATTERN.test(application.snapshot.applicantOpenId || '') || !application.clientMutationId) throw new BadRequestException('申请人稳定身份不完整，请重新核对后提交两级替班');
}

function assertAssignmentsAvailable(applications: LeaveWorkflowApplicationEntry[], recordId: string, requested: LeaveShiftSubstituteAssignment[]): void {
  const posts = (assignments: LeaveShiftSubstituteAssignment[]) => assignments.flatMap((row) => [
    { personRecordId: row.substitutePersonRecordId, openId: row.substituteOpenId, startAt: row.startAt, endAt: row.endAt },
    ...(row.originalPostBackfills || []).map((backup) => ({ personRecordId: backup.substitutePersonRecordId, openId: backup.substituteOpenId, startAt: backup.group.startAt, endAt: backup.group.endAt })),
  ]);
  const occupied = applications.filter((entry) => entry.recordId !== recordId && entry.resolvedAction !== 'reject' && entry.status !== 'rejected' && entry.status !== 'rejected_syncing').flatMap((entry) => posts(entry.snapshot.shiftAssignments || []));
  for (const post of posts(requested)) {
    const start = parseShanghaiLocalDateTime(post.startAt)?.epochMs;
    const end = parseShanghaiLocalDateTime(post.endAt)?.epochMs;
    if (start === undefined || end === undefined) throw new BadRequestException('替班安排时间无效');
    if (occupied.some((other) => {
      if (post.openId !== other.openId && post.personRecordId !== other.personRecordId) return false;
      const otherStart = parseShanghaiLocalDateTime(other.startAt)?.epochMs;
      const otherEnd = parseShanghaiLocalDateTime(other.endAt)?.epochMs;
      return otherStart === undefined || otherEnd === undefined || Math.min(end, otherEnd) >= Math.max(start, otherStart);
    })) throw new ConflictException('替班或原岗补位人员已被其他请假安排占用，请重新选择');
  }
}

function uniqueSubstituteCandidates(
  people: LeaveSubstituteCandidate[],
): LeaveSubstituteCandidate[] {
  const result = new Map<string, LeaveSubstituteCandidate>();
  for (const person of people || []) {
    const personRecordId = optionalRecordId(person?.personRecordId);
    if (!personRecordId || result.has(personRecordId)) continue;
    result.set(personRecordId, {
      personRecordId,
      name: String(person.name || '').trim(),
      openId: optionalOpenId(person.openId),
      position: String(person.position || '').trim(),
      buildings: Array.isArray(person.buildings)
        ? [
            ...new Set(
              person.buildings
                .map(String)
                .map((item) => item.trim())
                .filter(Boolean),
            ),
          ]
        : [],
    });
  }
  return [...result.values()];
}

function normalizeDelivery(
  delivery: LeaveWorkflowMessageDelivery,
): LeaveWorkflowMessageDelivery {
  return {
    recipientOpenId: requireOpenId(delivery?.recipientOpenId),
    messageId: requireMessageId(delivery?.messageId),
    businessKey: requireText(
      delivery?.businessKey,
      '请休假卡片业务键无效',
      256,
    ),
  };
}

function uniquePeople(people: LeaveRoutePerson[]): LeaveRoutePerson[] {
  const result = new Map<string, LeaveRoutePerson>();
  for (const person of people || []) {
    const openId = optionalOpenId(person?.openId);
    if (!openId || result.has(openId)) continue;
    result.set(openId, {
      name: String(person.name || '').trim(),
      openId,
      position: String(person.position || '').trim(),
      buildings: Array.isArray(person.buildings)
        ? [
            ...new Set(
              person.buildings
                .map((item) => String(item).trim())
                .filter(Boolean),
            ),
          ]
        : [],
    });
  }
  return [...result.values()];
}

function requireRecordId(value: unknown): string {
  const result = String(value || '').trim();
  if (!RECORD_ID_PATTERN.test(result))
    throw new BadRequestException('请休假记录标识无效');
  return result;
}

function optionalRecordId(value: unknown): string {
  const result = String(value || '').trim();
  if (!result) return '';
  return requireRecordId(result);
}

function requireOpenId(value: unknown): string {
  const result = String(value || '').trim();
  if (!OPEN_ID_PATTERN.test(result))
    throw new BadRequestException('飞书人员标识无效');
  return result;
}

function optionalOpenId(value: unknown): string {
  const result = String(value || '').trim();
  if (!result) return '';
  return requireOpenId(result);
}

function requireMessageId(value: unknown): string {
  const result = String(value || '').trim();
  if (!MESSAGE_ID_PATTERN.test(result))
    throw new BadRequestException('飞书卡片消息标识无效');
  return result;
}

function requireText(
  value: unknown,
  message: string,
  maxLength: number,
): string {
  const result = String(value || '').trim();
  if (!result || result.length > maxLength)
    throw new BadRequestException(message);
  return result;
}

function nonNegativeNumber(value: unknown, message: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0)
    throw new BadRequestException(message);
  return Number(result.toFixed(2));
}

function asDate(value: Date | number): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new BadRequestException('工作流时间无效');
  return date;
}

function sanitizeError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error || 'unknown error');
  return message
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, '$1 [redacted]')
    .replace(/\b(secret|token|password)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/[\r\n\t]/gu, ' ')
    .slice(0, MAX_ERROR_LENGTH);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isApplication(value: unknown): value is LeaveWorkflowApplicationEntry {
  return Boolean(
    value &&
    typeof value === 'object' &&
    RECORD_ID_PATTERN.test(
      String((value as LeaveWorkflowApplicationEntry).recordId || ''),
    ),
  );
}

function isAction(value: unknown): value is LeaveWorkflowActionEntry {
  return Boolean(
    value &&
    typeof value === 'object' &&
    RECORD_ID_PATTERN.test(
      String((value as LeaveWorkflowActionEntry).recordId || ''),
    ),
  );
}

function isSubstituteUpdate(
  value: unknown,
): value is LeaveWorkflowSubstituteUpdateEntry {
  return Boolean(
    value &&
    typeof value === 'object' &&
    RECORD_ID_PATTERN.test(
      String((value as LeaveWorkflowSubstituteUpdateEntry).recordId || ''),
    ),
  );
}

function isTask(value: unknown): value is LeaveWorkflowTaskEntry {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as LeaveWorkflowTaskEntry).businessKey === 'string',
  );
}

function normalizeAction(
  value: LeaveWorkflowActionEntry,
): LeaveWorkflowActionEntry {
  return {
    ...value,
    previousSubstituteOpenId: safeOptionalOpenId(
      value.previousSubstituteOpenId,
    ),
    previousSubstitutePersonRecordId: safeOptionalRecordId(
      value.previousSubstitutePersonRecordId,
    ),
    previousSubstituteName: String(value.previousSubstituteName || '').trim(),
    substituteOpenId: safeOptionalOpenId(value.substituteOpenId),
    substitutePersonRecordId: safeOptionalRecordId(
      value.substitutePersonRecordId,
    ),
    substituteName: String(value.substituteName || '').trim(),
    previousShiftAssignments: normalizeShiftAssignments(
      value.previousShiftAssignments || [],
    ),
    shiftAssignments: normalizeShiftAssignments(value.shiftAssignments || []),
    rejectionReason: String(value.rejectionReason || '')
      .trim()
      .slice(0, 500),
  };
}

function normalizeSubstituteUpdate(
  value: LeaveWorkflowSubstituteUpdateEntry,
): LeaveWorkflowSubstituteUpdateEntry {
  return {
    ...value,
    expectedRevision:
      Number.isSafeInteger(value.expectedRevision) &&
      value.expectedRevision >= 0
        ? value.expectedRevision
        : 0,
    revision:
      Number.isSafeInteger(value.revision) && value.revision > 0
        ? value.revision
        : 1,
    actorOpenId: optionalOpenId(value.actorOpenId),
    actorName: String(value.actorName || '').trim(),
    messageId: value.messageId ? requireMessageId(value.messageId) : '',
    previousSubstituteOpenId: safeOptionalOpenId(
      value.previousSubstituteOpenId,
    ),
    previousSubstitutePersonRecordId: safeOptionalRecordId(
      value.previousSubstitutePersonRecordId,
    ),
    previousSubstituteName: String(value.previousSubstituteName || '').trim(),
    substituteOpenId: safeOptionalOpenId(value.substituteOpenId),
    substitutePersonRecordId: safeOptionalRecordId(
      value.substitutePersonRecordId,
    ),
    substituteName: String(value.substituteName || '').trim(),
    previousShiftAssignments: normalizeShiftAssignments(
      value.previousShiftAssignments || [],
    ),
    shiftAssignments: normalizeShiftAssignments(value.shiftAssignments || []),
    changedShiftKeys: uniqueText(value.changedShiftKeys || []),
    createdAt: String(value.createdAt || new Date().toISOString()),
  };
}

function normalizeApplication(
  value: LeaveWorkflowApplicationEntry,
): LeaveWorkflowApplicationEntry {
  const now = new Date().toISOString();
  return {
    ...value,
    snapshot: normalizeSnapshot(value.snapshot),
    approvalPlan: value.approvalPlan || null,
    currentStage: value.currentStage
      ? normalizeStage(value.currentStage)
      : null,
    stageCards: Array.isArray(value.stageCards)
      ? value.stageCards.filter((item) => {
          try {
            normalizeDelivery(item);
            return true;
          } catch {
            return false;
          }
        })
      : [],
    terminalCardMessageIds: Array.isArray(value.terminalCardMessageIds)
      ? value.terminalCardMessageIds.filter((item) =>
          MESSAGE_ID_PATTERN.test(item),
        )
      : [],
    resultCards: Array.isArray(value.resultCards)
      ? value.resultCards.filter((item) => {
          try {
            normalizeDelivery(item);
            return true;
          } catch {
            return false;
          }
        })
      : [],
    substituteAdjustmentCards: Array.isArray(value.substituteAdjustmentCards)
      ? value.substituteAdjustmentCards.filter((item) => {
          try {
            normalizeDelivery(item);
            return true;
          } catch {
            return false;
          }
        })
      : [],
    resultRecipients: uniquePeople(value.resultRecipients || []),
    resolvedAction:
      value.resolvedAction === 'approve' || value.resolvedAction === 'reject'
        ? value.resolvedAction
        : null,
    resolvedByOpenId: optionalOpenId(value.resolvedByOpenId),
    resolvedByName: String(value.resolvedByName || '').trim(),
    resolvedAt: String(value.resolvedAt || '').trim(),
    rejectionReason: String(value.rejectionReason || '')
      .trim()
      .slice(0, 500),
    revision:
      Number.isSafeInteger(value.revision) && value.revision > 0
        ? value.revision
        : 1,
    createdAt: String(value.createdAt || now),
    updatedAt: String(value.updatedAt || now),
    lastError: String(value.lastError || '').slice(0, MAX_ERROR_LENGTH),
  };
}

function safeOptionalOpenId(value: unknown): string {
  try {
    return optionalOpenId(value);
  } catch {
    return '';
  }
}

function safeOptionalRecordId(value: unknown): string {
  try {
    return optionalRecordId(value);
  } catch {
    return '';
  }
}
