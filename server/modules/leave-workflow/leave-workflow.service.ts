import {leavePlanHash} from './leave-future-manager-handover';
import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { feishuIdentityFingerprint } from '../../common/access/feishu-access-approved-grants';
import {
  extractDateTimeIso,
  extractDisplayText,
  extractDisplayValues,
} from '../../common/feishu/bitable-direct-read';
import type { ActivePersonnelDirectory } from '../bitable-sync/active-personnel-directory';
import { BitableSyncService } from '../bitable-sync/bitable-sync.service';
import {
  calculateLeaveRequestImpact,
  calculateLeaveRequestSubstituteRule,
  createLeaveRequestShiftGroups,
  isLeaveSubstituteStaffBlocked,
  containsExactPersonName,
  type LeaveRequestImpactSchedule,
  type LeaveRequestShiftGroup,
} from '../../../shared/leave-request-impact';
import {
  buildLeaveApprovalCard,
  buildLeaveProgressCard,
  buildLeaveRejectionPromptCard,
  buildLeaveSubstituteAdjustmentCard,
  buildLeaveSubstituteAdjustmentTerminalCard,
  buildLeaveSubstituteChangeNotificationCard,
  buildLeaveTerminalCard,
  type LeaveCardContext,
} from './leave-workflow.card';
import { LeaveWorkflowGateway } from './leave-workflow.gateway';
import { LeaveWorkflowDetailGateway } from './leave-workflow.detail-gateway';
import { originalPostSignature } from './leave-two-level-substitution';
import {
  buildLeaveShiftCandidateSets,
  buildLeaveApprovalPlan,
  resolveCurrentLeaveNotificationRecipients,
  resolveCurrentLeaveAdjustmentApprovers,
  fixedLeaveNotificationIds,
  requiresLongWhiteSubstituteDecision,
  requiresMandatoryLongWhiteSubstitute,
  requiresSupervisorSubstitute,
  validateLeaveShiftAssignmentPlan,
} from './leave-workflow.rules';
import {
  LeaveWorkflowStore,
  type LeaveWorkflowActionEntry,
  type LeaveWorkflowApplicationEntry,
  type LeaveWorkflowSnapshot,
  type LeaveWorkflowSubstituteUpdateEntry,
  type LeaveWorkflowTaskEntry,
} from './leave-workflow.store';
import type {
  LeaveApprovalPlan,
  LeaveApprovalRoutingInput,
  LeaveOrganizationRecord,
  LeaveRoutePerson,
  LeaveShiftAssignmentSelection,
  LeaveShiftCandidateSet,
  LeaveShiftSubstituteAssignment,
  LeaveSubstituteCandidate,
} from './leave-workflow.types';

const MAX_TASKS_PER_RUN = 25;
const POLICY_VERSION = '2026-08-18-v2';
const MANAGER_POSITIONS = new Set(['设施运维经理', '设施运维副经理']);

type SubstituteChangeDetails = Pick<
  LeaveWorkflowSubstituteUpdateEntry,
  | 'previousSubstituteOpenId'
  | 'previousSubstitutePersonRecordId'
  | 'previousSubstituteName'
  | 'substituteOpenId'
  | 'substitutePersonRecordId'
  | 'substituteName'
  | 'actorName'
> &
  Pick<
    LeaveWorkflowSubstituteUpdateEntry,
    'previousShiftAssignments' | 'shiftAssignments'
  >;

export interface LeaveWorkflowAcceptApplicationsInput {
  clientMutationId: string;
  recordIds: string[];
  leaveStaffName: string;
  startAt: string;
  endAt: string;
  leaveType: string;
  leaveHours: number;
  approvalDayCount: number;
  shiftGroups?: LeaveRequestShiftGroup[];
  reason: string;
  substituteName?: string;
}

export interface LeaveApprovalActionAcceptanceInput {
  eventId: string;
  recordId: string;
  stageKey: 'supervisor' | 'manager';
  stageVersion: number;
  actorOpenId: string;
  actorName?: string;
  action: 'approve' | 'reject';
  messageId: string;
  substituteRequired?: boolean;
  substitutePersonRecordId?: string;
  shiftSelections?: LeaveShiftAssignmentSelection[];
  rejectionReason?: string;
}

export interface LeaveSubstituteUpdateAcceptanceInput {
  eventId: string;
  recordId: string;
  expectedRevision: number;
  actorOpenId: string;
  actorName?: string;
  messageId: string;
  substitutePersonRecordId?: string;
  shiftSelections?: LeaveShiftAssignmentSelection[];
}

export interface LeaveCardViewInput {
  recordId: string;
  stageKey: 'supervisor' | 'manager';
  stageVersion: number;
  actorOpenId: string;
  messageId?: string;
  shiftSelections?: LeaveShiftAssignmentSelection[];
  substituteRequired?: boolean;
  view:
    | 'rejection'
    | 'approval'
    | 'substitute_review'
    | 'substitute_required'
    | 'substitute_not_required';
}

export interface LeaveAdjustmentViewInput {
  recordId: string;
  actorOpenId: string;
  messageId: string;
  expectedRevision: number;
  view: 'review' | 'selection';
  shiftSelections?: LeaveShiftAssignmentSelection[];
}

export interface LeaveWorkflowRecoveryResult {
  requestedCodes: string[];
  matchedCodes: string[];
  missingCodes: string[];
  created: number;
  existing: number;
}

@Injectable()
export class LeaveWorkflowService {
  private readonly logger = new Logger(LeaveWorkflowService.name);
  private readonly substituteSyncRuns = new Map<string, Promise<void>>();
  private taskWakeHandler: (() => void) | null = null;

  constructor(
    private readonly store: LeaveWorkflowStore,
    private readonly gateway: LeaveWorkflowGateway,
    private readonly bitableSyncService: BitableSyncService,
    @Optional()
    private readonly detailGateway?: LeaveWorkflowDetailGateway,
    @Inject(AccessConfigurationService)
    private readonly accessConfiguration?: AccessConfigurationService,
  ) {}

  isEnabled(): boolean {
    return readBooleanEnv('LEAVE_WORKFLOW_PROGRAM_ENABLED', true);
  }

  setTaskWakeHandler(handler: (() => void) | null): void {
    this.taskWakeHandler = handler;
  }

  async recoverConfiguredApplications(): Promise<LeaveWorkflowRecoveryResult> {
    await this.store.wakePendingTasks();
    await this.recoverMisroutedStationChiefApplications();
    return this.recoverApplicationsByLeaveCodes(
      readCsvEnv('LEAVE_WORKFLOW_STARTUP_RECOVERY_CODES'),
    );
  }

  async recoverMisroutedStationChiefApplications(): Promise<{
    scheduled: number;
  }> {
    this.assertEnabled();
    const applications = await this.store.listApplications();
    let scheduled = 0;
    for (const application of applications) {
      const stage = application.currentStage;
      if (
        !is110StationChiefSnapshot(application.snapshot) ||
        application.status !== 'manager_pending' ||
        stage?.key !== 'manager' ||
        application.resolvedAction !== null
      ) {
        continue;
      }
      const result = await this.store.schedulePendingStageReroute({
        recordId: application.recordId,
        expectedStage: stage,
        businessKey: `leave:${application.recordId}:repair:110-station-chief:v1`,
      });
      if (result.scheduled) scheduled += 1;
    }
    return { scheduled };
  }

  async recoverApplicationsByLeaveCodes(
    codes: string[],
  ): Promise<LeaveWorkflowRecoveryResult> {
    this.assertEnabled();
    const requestedCodes = uniqueLeaveCodes(codes);
    if (requestedCodes.length === 0) {
      return {
        requestedCodes,
        matchedCodes: [],
        missingCodes: [],
        created: 0,
        existing: 0,
      };
    }

    const records = await this.gateway.findLeaveRecordsByCodes(requestedCodes);
    const matchedCodes: string[] = [];
    const missingCodes: string[] = [];
    let created = 0;
    let existing = 0;

    for (const code of requestedCodes) {
      const matches = records.filter(
        (record) => firstFieldText(record.fields, ['休假编号']) === code,
      );
      if (matches.length === 0) {
        missingCodes.push(code);
        continue;
      }
      if (matches.length > 1) {
        throw new ServiceUnavailableException(
          `休假编号 ${code} 命中多条记录，已停止自动恢复`,
        );
      }

      const record = matches[0];
      const workflowStatus = firstFieldText(record.fields, ['请假工作流状态']);
      if (isTerminalRecoveryStatus(workflowStatus)) {
        matchedCodes.push(code);
        existing += 1;
        continue;
      }
      const requestUniqueId = requireText(
        firstFieldText(record.fields, ['请求唯一ID']),
        `休假编号 ${code} 缺少请求唯一ID，无法安全恢复`,
        128,
      );
      const startAt = firstFieldDateTime(record.fields, ['休假开始时间']);
      const endAt = firstFieldDateTime(record.fields, ['休假结束时间']);
      const acceptance = await this.acceptApplications({
        clientMutationId: requestUniqueId,
        recordIds: [record.recordId],
        leaveStaffName: firstFieldText(record.fields, [
          '休假人员姓名（程序）',
          '休假人员',
          '请休假人员',
        ]),
        startAt,
        endAt,
        leaveType: firstFieldText(record.fields, ['休假类型']),
        leaveHours: firstNumber(
          record.fields,
          ['休假工时数（最低4h）', '休假工时数'],
          0,
        ),
        approvalDayCount: firstNumber(
          record.fields,
          ['休假天数'],
          calendarDayCount(startAt, endAt),
        ),
        reason: firstFieldText(record.fields, ['请假原因']),
        substituteName:
          firstFieldText(record.fields, ['替班人员（填姓名）', '替班人员']) ||
          undefined,
      });
      matchedCodes.push(code);
      created += acceptance.created;
      existing += acceptance.created === 0 ? 1 : 0;
    }

    return {
      requestedCodes,
      matchedCodes,
      missingCodes,
      created,
      existing,
    };
  }

  async acceptApplications(
    input: LeaveWorkflowAcceptApplicationsInput,
  ): Promise<{ accepted: true; created: number; recordIds: string[] }> {
    this.assertEnabled();
    const clientMutationId = requireText(
      input.clientMutationId,
      '请休假 clientMutationId 无效',
      128,
    );
    const recordIds = uniqueRecordIds(input.recordIds);
    if (recordIds.length === 0) {
      throw new BadRequestException(
        '请休假正式记录尚未建立，无法受理审批工作流',
      );
    }
    const snapshot = normalizeAcceptanceSnapshot(input);
    let created = 0;
    for (const recordId of recordIds) {
      const result = await this.store.acceptApplication({
        clientMutationId: `${clientMutationId}:${recordId}`,
        recordId,
        snapshot,
      });
      if (result.created) created += 1;
    }
    this.taskWakeHandler?.();
    return { accepted: true, created, recordIds };
  }

  async acceptApprovalAction(
    input: LeaveApprovalActionAcceptanceInput,
  ): Promise<{ claimed: boolean; card: Record<string, unknown> }> {
    const startedAt = Date.now();
    this.assertEnabled();
    if (!this.canActorContinue(input.actorOpenId)) {
      const previous = await this.store.getStageAction(input.recordId, input.stageKey, input.stageVersion);
      if (!previous) throw new BadRequestException('当前人员不可办理');
      const application = await this.requireApplication(input.recordId);
      return { claimed: false, card: this.stageActionCard(application, previous, input.stageKey, input.stageVersion) };
    }
    let shiftAssignments: LeaveShiftSubstituteAssignment[] | undefined;
    if (input.action === 'approve') {
      const current = await this.requireApplication(input.recordId);
      const stage = current.currentStage;
      if (stage?.key === input.stageKey && stage.version === input.stageVersion && current.status === `${stage.key}_pending`) {
        const substituteRequired =
          current.snapshot.substituteDecisionRequired &&
          !current.snapshot.substituteDecisionMade
            ? input.substituteRequired === true
            : current.snapshot.substituteRequired === true;
        if (substituteRequired && (current.snapshot.shiftGroups || []).length) {
          const candidateSets = await this.refreshCandidateSets(current, input.shiftSelections || []);
          shiftAssignments = this.resolveSubmittedShiftAssignments(
            current,
            input.shiftSelections || [],
            candidateSets,
            input.actorOpenId,
            input.actorName || '',
            false,
          );
        } else if (!substituteRequired) {
          shiftAssignments = [];
        }
      }
    }
    const actionInput = {
      ...input,
      shiftAssignments,
    };
    const commitStartedAt = Date.now();
    const result = typeof this.accessConfiguration?.currentDutyRoutePeople === 'function'
      ? await this.store.claimStageAction(actionInput,new Date(),(application,actorOpenId)=>{
        if(!this.canActorContinue(actorOpenId)||!application.currentStage)return false;
        const discipline=application.approvalPlan?.discipline,specialty=discipline?({electrical:'电气',hvac:'暖通',weak_current:'弱电',fire:'消防'} as const)[discipline]:undefined;
        const members=application.currentStage.key==='manager'&&application.approvalPlan?.approvalClass==='manager'?null:this.accessConfiguration!.currentDutyRoutePeople(application.currentStage.key==='manager'?'leave_manager':'leave_supervisor',{building:application.snapshot.building,...(specialty?{specialty}:{})});
        return members===null||members.some(person=>person.openId===actorOpenId);
      })
      : await this.store.claimStageAction(actionInput);
    const card = this.stageActionCard(result.entry, result.action, input.stageKey, input.stageVersion);
    const finishedAt = Date.now();
    const timing = `请休假受理耗时 record=${result.entry.recordId} prepareMs=${Math.max(0, commitStartedAt - startedAt)} commitMs=${Math.max(0, finishedAt - commitStartedAt)} totalMs=${Math.max(0, finishedAt - startedAt)} claimed=${result.accepted}`;
    if (finishedAt - startedAt >= 1000) this.logger.warn(timing);
    else this.logger.log(timing);
    return { claimed: result.accepted, card };
  }

  private stageActionCard(
    application: LeaveWorkflowApplicationEntry,
    action: LeaveWorkflowActionEntry | null,
    stageKey: 'supervisor' | 'manager',
    stageVersion: number,
  ): Record<string, unknown> {
    const rejected = application.status === 'rejected' || application.status === 'rejected_syncing';
    const approved = application.status === 'approved';
    const final = rejected || approved;
    const actorOpenId = final ? application.resolvedByOpenId || action?.actorOpenId : action?.actorOpenId;
    const actorName = (final ? application.resolvedByName : action?.actorName) ||
      application.approvalPlan?.stages.flatMap((stage) => stage.approvers).find((person) => person.openId === actorOpenId)?.name || '审批人';
    return buildLeaveTerminalCard({
      ...toCardContext(application, stageKey, stageVersion),
      outcome: rejected ? 'rejected' : approved ? 'approved' : action ? 'stage_approved' : 'rerouted',
      actorName,
      rejectionReason: rejected ? application.rejectionReason : action?.rejectionReason,
      message: rejected
        ? application.status === 'rejected_syncing' ? '已驳回，结果同步中' : '请休假申请已驳回'
        : approved ? '请休假申请已通过'
        : action ? application.status === 'approved_syncing' ? '审批已受理，结果同步中' : '本阶段已通过，等待后续审批'
        : '审批阶段已更新，请使用最新审批卡片办理',
    });
  }

  async patchApprovalCardView(input: LeaveCardViewInput, card: Record<string, unknown>): Promise<void> {
    if (!input.messageId) throw new BadRequestException('缺少审批卡片消息');
    const before = await this.approvalCardViewState(input);
    await this.gateway.patchInteractiveCard(input.messageId, before.terminalCard || card);
    const after = await this.approvalCardViewState(input);
    if (!before.terminalCard && after.terminalCard) {
      await this.gateway.patchInteractiveCard(input.messageId, after.terminalCard);
    }
  }

  private async approvalCardViewState(input: LeaveCardViewInput): Promise<{
    application: LeaveWorkflowApplicationEntry;
    terminalCard?: Record<string, unknown>;
  }> {
    this.assertEnabled();
    if (!this.canActorContinue(input.actorOpenId)) throw new BadRequestException('当前人员不可办理');
    const application = await this.requireApplication(input.recordId);
    const delivery = input.messageId
      ? application.stageCards.find((item) => item.messageId === input.messageId && item.recipientOpenId === input.actorOpenId)
      : undefined;
    if (input.messageId && !delivery) throw new BadRequestException('审批消息与已投递卡片不匹配');
    const deliveredStageMatches = delivery?.businessKey === `leave:${application.recordId}:stage:${input.stageKey}:${input.stageVersion}:${input.actorOpenId}`;
    if (input.messageId && !deliveredStageMatches) throw new BadRequestException('审批消息与卡片阶段不匹配');
    const stage = application.currentStage;
    if (stage?.key === input.stageKey && stage.version === input.stageVersion &&
      stage.approverOpenIds.includes(input.actorOpenId) && application.status === `${stage.key}_pending`) {
      return { application };
    }
    // 旧卡只允许恢复其已投递阶段的只读状态，不能借旧消息打开其他阶段。
    if (!deliveredStageMatches) {
      throw new BadRequestException('该请休假审批卡片阶段无效或无处理权限');
    }
    const action = await this.store.getStageAction(application.recordId, input.stageKey, input.stageVersion);
    return {
      application,
      terminalCard: this.stageActionCard(application, action, input.stageKey, input.stageVersion),
    };
  }

  private prepareSubstitutionReview(application: LeaveWorkflowApplicationEntry, submitted: LeaveShiftAssignmentSelection[], candidateSets: LeaveShiftCandidateSet[]): LeaveShiftAssignmentSelection[] {
    const selected = new Map<string, LeaveShiftAssignmentSelection>((application.snapshot.shiftAssignments || []).map((row) => [row.shiftKey, { shiftKey: row.shiftKey, substitutePersonRecordId: row.substitutePersonRecordId, backfillPersonRecordId: row.backfillPersonRecordId, originalPostSignature: row.originalPostSignature }]));
    const keys = new Set((application.snapshot.shiftGroups || []).map((group) => group.shiftKey));
    const seen = new Set<string>();
    for (const selection of submitted) {
      if (!keys.has(selection.shiftKey) || seen.has(selection.shiftKey)) throw new BadRequestException('替班核对包含无效或重复班次');
      seen.add(selection.shiftKey);
      const previous = selected.get(selection.shiftKey);
      selected.set(selection.shiftKey, previous?.substitutePersonRecordId === selection.substitutePersonRecordId ? { ...previous, ...selection } : { ...selection });
    }
    return (application.snapshot.shiftGroups || []).map((group) => {
      const selection = selected.get(group.shiftKey);
      const choice = candidateSets.find((set) => set.shiftKey === group.shiftKey)?.twoLevelCandidates?.find((row) => row.person.personRecordId === selection?.substitutePersonRecordId);
      if (!selection || !choice) throw new BadRequestException('请为每个班次选择当前可用的替班人员');
      const result: LeaveShiftAssignmentSelection = { shiftKey: group.shiftKey, substitutePersonRecordId: choice.person.personRecordId };
      if (choice.originalGroups.length) {
        result.originalPostSignature = originalPostSignature(choice.originalGroups);
        if (selection.originalPostSignature === result.originalPostSignature && choice.backfillCandidates.some((person) => person.personRecordId === selection.backfillPersonRecordId)) result.backfillPersonRecordId = selection.backfillPersonRecordId;
      }
      return result;
    });
  }

  private async requireAdjustmentView(input: LeaveAdjustmentViewInput): Promise<LeaveWorkflowApplicationEntry> {
    this.assertEnabled();
    const application = await this.requireApplication(input.recordId);
    if (!this.canActorContinue(input.actorOpenId) || application.status !== 'approved' || (application.snapshot.assignmentRevision || 0) !== input.expectedRevision || !this.currentAdjustmentApprovers(application).some((person) => person.openId === input.actorOpenId) || !application.substituteAdjustmentCards.some((delivery) => delivery.recipientOpenId === input.actorOpenId && delivery.messageId === input.messageId && delivery.businessKey.includes(`:${input.expectedRevision}:`) && !application.terminalCardMessageIds.includes(delivery.messageId))) throw new BadRequestException('该替班调整卡片已失效或无处理权限');
    return application;
  }

  async assertSubstituteAdjustmentNoChange(input: Omit<LeaveAdjustmentViewInput, 'view' | 'shiftSelections'>): Promise<void> {
    await this.requireAdjustmentView({ ...input, view: 'selection' });
  }

  async renderSubstituteAdjustmentCardView(input: LeaveAdjustmentViewInput): Promise<Record<string, unknown>> {
    const application = await this.requireAdjustmentView(input);
    const candidateSets = await this.refreshCandidateSets(application);
    return buildLeaveSubstituteAdjustmentCard({ ...toCardContext(application, 'manager', 1), candidateSets, ...(input.view === 'review' ? { substitutionReview: this.prepareSubstitutionReview(application, input.shiftSelections || [], candidateSets) } : {}) }, input.expectedRevision, true);
  }

  async patchSubstituteAdjustmentCardView(input: LeaveAdjustmentViewInput, card: Record<string, unknown>): Promise<void> {
    await this.requireAdjustmentView(input);
    await this.gateway.patchInteractiveCard(input.messageId, card);
    const after = await this.requireApplication(input.recordId);
    if (after.status !== 'approved' || (after.snapshot.assignmentRevision || 0) !== input.expectedRevision) await this.gateway.patchInteractiveCard(input.messageId, buildLeaveSubstituteAdjustmentTerminalCard(toCardContext(after, 'manager', 1), after.snapshot.substituteUpdatedByName || '审批人'));
  }

  async acceptSubstituteUpdateAction(
    input: LeaveSubstituteUpdateAcceptanceInput,
  ): Promise<{ claimed: boolean; card: Record<string, unknown> }> {
    this.assertEnabled();
    if (!this.canActorContinue(input.actorOpenId)) {
      const previous = await this.store.getSubstituteUpdate(input.recordId, input.expectedRevision + 1);
      if (!previous || previous.eventId !== input.eventId || previous.actorOpenId !== input.actorOpenId) throw new BadRequestException('当前人员不可办理');
      const application = await this.requireApplication(input.recordId);
      return { claimed: false, card: buildLeaveSubstituteAdjustmentTerminalCard(toCardContext(application, 'manager', 1), previous.actorName || '审批人') };
    }
    const current = await this.requireApplication(input.recordId);
    let shiftAssignments: LeaveShiftSubstituteAssignment[] | undefined;
    if ((current.snapshot.shiftGroups || []).length) {
      const candidateSets = hasCompleteCandidateSets(current.snapshot)
        ? current.snapshot.candidateSets || []
        : await this.refreshCandidateSets(current);
      shiftAssignments = this.resolveSubmittedShiftAssignments(
        current,
        input.shiftSelections || [],
        candidateSets,
        input.actorOpenId,
        input.actorName || '',
        true,
      );
    }
    const updateInput = {
      ...input,
      shiftAssignments,
    };
    const result = typeof this.accessConfiguration?.currentDutyRoutePeople === 'function'
      ? await this.store.claimSubstituteUpdate(updateInput, new Date(), (application, actorOpenId) => this.currentAdjustmentApprovers(application).some(person => person.openId === actorOpenId))
      : await this.store.claimSubstituteUpdate(updateInput);
    const application = result.entry;
    if (result.reason === 'invalid_actor') return { claimed: false, card: buildLeaveTerminalCard({ ...toCardContext(application, 'manager', 1), outcome: 'rerouted', actorName: '岗位交接', message: '岗位权限已更新，请使用现任人员的新卡片办理' }) };
    return {
      claimed: result.accepted,
      card: buildLeaveSubstituteAdjustmentTerminalCard(
        toCardContext(application, 'manager', 1),
        result.update?.actorName || input.actorName || '审批人',
      ),
    };
  }

  async renderApprovalCardView(
    input: LeaveCardViewInput,
  ): Promise<Record<string, unknown>> {
    const { application, terminalCard } = await this.approvalCardViewState(input);
    if (terminalCard) return terminalCard;
    const context = toCardContext(
      application,
      input.stageKey,
      input.stageVersion,
    );
    if (input.view === 'substitute_review') {
      if (!input.messageId) throw new BadRequestException('缺少审批卡片消息');
      const candidateSets = hasCompleteCandidateSets(application.snapshot) &&
        application.snapshot.candidateSets!.every((set) => Array.isArray(set.twoLevelCandidates) && set.twoLevelCandidates.length > 0)
        ? application.snapshot.candidateSets!
        : await this.refreshCandidateSets(application);
      return buildLeaveApprovalCard({ ...context, candidateSets, substitutionReview: this.prepareSubstitutionReview(application, input.shiftSelections || [], candidateSets), ...(context.substituteDecisionRequired ? { substituteRequiredChoice: true } : {}) });
    }
    if (input.view === 'rejection') {
      return buildLeaveRejectionPromptCard(context);
    }
    if (
      (input.view === 'substitute_required' ||
        input.view === 'substitute_not_required') &&
      !context.substituteDecisionRequired
    ) {
      throw new BadRequestException('该请休假申请不支持选择是否需要替班');
    }
    return buildLeaveApprovalCard({
      ...context,
      ...(input.view === 'substitute_required'
        ? { substituteRequiredChoice: true }
        : input.view === 'substitute_not_required'
          ? { substituteRequiredChoice: false }
          : {}),
    });
  }

  private buildCurrentApprovalPlan(input: LeaveApprovalRoutingInput): LeaveApprovalPlan {
    return buildLeaveApprovalPlan({ ...input, resolveDuty: (kind, fallback, target) => {
      const resolver = this.accessConfiguration?.currentDutyRoutePeople;
      return typeof resolver === 'function' ? resolver.call(this.accessConfiguration, kind, target) ?? fallback() : fallback();
    } });
  }

  private currentNotificationRecipients(application: LeaveWorkflowApplicationEntry): LeaveRoutePerson[] {
    const people = resolveCurrentLeaveNotificationRecipients(application, (kind, target) => {
      const resolver = this.accessConfiguration?.currentDutyRoutePeople;
      return typeof resolver === 'function' ? resolver.call(this.accessConfiguration, kind, target) : null;
    });
    const fixed = fixedLeaveNotificationIds(application);
    return typeof this.accessConfiguration?.currentDutyRoutePeople === 'function' ? people.filter(person => fixed.has(person.openId) || this.canActorContinue(person.openId)) : people;
  }

  private currentAdjustmentApprovers(application: LeaveWorkflowApplicationEntry): LeaveRoutePerson[] {
    const people = resolveCurrentLeaveAdjustmentApprovers(application, (kind, target) => {
      const resolver = this.accessConfiguration?.currentDutyRoutePeople;
      return typeof resolver === 'function' ? resolver.call(this.accessConfiguration, kind, target) : null;
    });
    return typeof this.accessConfiguration?.currentDutyRoutePeople === 'function' ? people.filter(person => this.canActorContinue(person.openId)) : people;
  }

  private canActorContinue(openId: string): boolean {
    const appId = process.env.FEISHU_APP_ID?.trim();
    if (!appId || !this.accessConfiguration) throw new ServiceUnavailableException('人员权限状态未就绪');
    if (!openId) throw new BadRequestException('当前人员不可办理');
    if (typeof this.accessConfiguration.canUseFeishuBusinessIdentity !== 'function') throw new ServiceUnavailableException('人员权限状态未就绪');
    return this.accessConfiguration.canUseFeishuBusinessIdentity(`feishu-${feishuIdentityFingerprint(appId, openId)}`, appId);
  }

  async runPendingTasks(
    now: Date | number = new Date(),
    limit = MAX_TASKS_PER_RUN,
  ): Promise<{ processed: number; failed: number }> {
    this.assertEnabled();
    const initialTimestamp = asDate(now);
    const maximum = Math.max(1, Math.min(100, Math.floor(limit)));
    let processed = 0;
    let failed = 0;
    for (let index = 0; index < maximum; index += 1) {
      const timestamp = index === 0 ? initialTimestamp : new Date();
      const taskStartedAt = Date.now();
      const task = await this.store.takeNextTask(timestamp);
      if (!task) break;
      try {
        await this.processTask(task, timestamp);
        await this.store.completeTask(task.key, task.claimToken,
          new Date(timestamp.getTime() + Math.max(0, Date.now() - taskStartedAt)));
        processed += 1;
      } catch (error) {
        failed += 1;
        if (task.kind !== 'sync_leave_shift_details' && task.kind !== 'verify_future_manager_handover' && task.kind !== 'sync_stage_action_cards') {
          await this.recordTaskFailure(task, error, timestamp);
        }
        await this.store.rescheduleTask(
          task.key,
          task.claimToken,
          error,
          new Date(timestamp.getTime() + Math.max(0, Date.now() - taskStartedAt)),
        );
        this.logger.warn(
          `请休假工作流任务 ${task.kind}/${task.recordId} 失败，将按幂等键重试`,
        );
      }
    }
    return { processed, failed };
  }

  private async processTask(
    task: LeaveWorkflowTaskEntry,
    now: Date,
  ): Promise<void> {
    switch (task.kind) {
      case 'verify_future_manager_handover': {
        const original=await this.store.getFutureManagerHandover(task.recordId,String(task.payload.mutationId||'')),application=await this.requireApplication(task.recordId);
        const target=task.payload.target as {openId?:string;personRecordId?:string}|undefined;
        if(!original||original.key!==task.key||original.payload.futureFingerprint!==task.payload.futureFingerprint||typeof task.payload.targetPlanHash!=='string'||leavePlanHash(application.approvalPlan)!==task.payload.targetPlanHash||!target?.openId||!target.personRecordId||!application.approvalPlan?.stages.find(stage=>stage.key==='manager')?.approvers.some(person=>person.openId===target.openId&&person.personRecordId===target.personRecordId)||!this.canActorContinue(target.openId))throw new BadRequestException('未来经理交接计划或接任身份已变化，请核对原交接');
        return;
      }
      case 'route_application':
        await this.routeApplication(task, now);
        return;
      case 'repair_station_chief_route':
        await this.repairStationChiefRoute(task, now);
        return;
      case 'sync_personnel_handover':
        await this.syncPersonnelHandover(task, now);
        return;
      case 'deliver_stage_cards':
        await this.deliverStageCards(task);
        return;
      case 'apply_stage_action':
        await this.applyStageAction(task, now);
        return;
      case 'sync_stage_action_cards':
        await this.syncStageActionCards(task, now);
        return;
      case 'deliver_result_cards':
        await this.deliverResultCards(task, now);
        return;
      case 'deliver_substitute_adjustment_cards':
        await this.deliverSubstituteAdjustmentCards(task);
        return;
      case 'deliver_substitute_update_notifications':
        await this.deliverSubstituteUpdateNotifications(task);
        return;
      case 'deliver_stage_substitute_change_notifications':
        await this.deliverStageSubstituteChangeNotifications(task);
        return;
      case 'sync_leave_shift_details':
      case 'sync_approved_leave_schedule':
      case 'apply_substitute_update': {
        // 主表、明细和排班可能来自不同 worker，同一请假记录必须按序写入。
        const previous = this.substituteSyncRuns.get(task.recordId) || Promise.resolve();
        const pending = previous.catch(() => undefined).then(() => {
          if (task.kind === 'sync_leave_shift_details') return this.syncLeaveShiftDetails(task);
          if (task.kind === 'sync_approved_leave_schedule') return this.syncApprovedLeaveSchedule(task);
          return this.applySubstituteUpdate(task, now);
        });
        this.substituteSyncRuns.set(task.recordId, pending);
        try {
          await pending;
        } finally {
          if (this.substituteSyncRuns.get(task.recordId) === pending) this.substituteSyncRuns.delete(task.recordId);
        }
        return;
      }
      default:
        throw new BadRequestException('未知的请休假工作流后台任务');
    }
  }

  private async syncPersonnelHandover(task: LeaveWorkflowTaskEntry, now: Date): Promise<void> {
    const payload = task.payload;
    const sourceKey = payload.sourceStageKey;
    const sourceVersion = payload.sourceStageVersion;
    const targetVersion = payload.targetStageVersion;
    const target = payload.target as Record<string, unknown> | undefined;
    const sourceIds = payload.sourceApproverOpenIds;
    if ((sourceKey !== 'supervisor' && sourceKey !== 'manager') ||
      typeof sourceVersion !== 'number' || !Number.isSafeInteger(sourceVersion) || sourceVersion < 1 ||
      typeof targetVersion !== 'number' || !Number.isSafeInteger(targetVersion) || targetVersion !== sourceVersion + 1 ||
      typeof payload.mutationId !== 'string' || !/^handover-[a-f0-9]{64}$/u.test(payload.mutationId) ||
      typeof payload.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(payload.fingerprint) ||
      typeof payload.dutyRecordId !== 'string' || !/^rec[A-Za-z0-9_]+$/u.test(payload.dutyRecordId) ||
      typeof payload.sourceOpenId !== 'string' || !/^ou_[A-Za-z0-9_-]{1,124}$/u.test(payload.sourceOpenId) ||
      !Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 100 || !sourceIds.includes(payload.sourceOpenId) ||
      !sourceIds.every(id => typeof id === 'string' && /^ou_[A-Za-z0-9_-]{1,124}$/u.test(id)) ||
      !target || typeof target !== 'object' || Array.isArray(target) ||
      typeof target.personRecordId !== 'string' || !/^rec[A-Za-z0-9_]+$/u.test(target.personRecordId) ||
      typeof target.openId !== 'string' || !/^ou_[A-Za-z0-9_-]{1,124}$/u.test(target.openId) ||
      (payload.patchOnly !== undefined && payload.patchOnly !== true)) throw new BadRequestException('岗位交接任务无效');
    const application = await this.requireApplication(task.recordId);
    await this.patchStageCardsForStage(application, sourceKey, sourceVersion, buildLeaveTerminalCard({
      ...toCardContext(application, sourceKey, sourceVersion), outcome: 'rerouted',
      actorName: '管理员', message: '审批已转交接任负责人，原卡片不可操作',
    }), now);
    if (payload.patchOnly === true) return;
    const current = await this.requireApplication(task.recordId);
    const stage = current.currentStage;
    if (!stage || stage.key !== sourceKey || stage.version !== targetVersion || current.status !== `${sourceKey}_pending`) return;
    const expectedIds = [...new Set(sourceIds.map(id => id === payload.sourceOpenId ? target.openId as string : id))].sort();
    if (JSON.stringify([...stage.approverOpenIds].sort()) !== JSON.stringify(expectedIds)) throw new BadRequestException('岗位交接审批人已变化');
    if (!this.canActorContinue(target.openId)) throw new BadRequestException('接任人员的业务权限已收回，请核对交接');
    const status = sourceKey === 'supervisor' ? '待主管审批' : '待经理审批';
    await this.gateway.updateLeaveRecord(current.recordId, {
      请假工作流状态: status, 请假当前审批人: stage.approverOpenIds.map(id => ({ id })), 请假工作流错误: '',
    });
    const record = await this.gateway.readLeaveRecord(current.recordId);
    const people = record.fields.请假当前审批人;
    if (!Array.isArray(people) || !people.every(person => person && typeof person === 'object' && typeof person.id === 'string' && /^ou_[A-Za-z0-9_-]{1,124}$/u.test(person.id)) ||
      JSON.stringify([...new Set(people.map(person => person.id))].sort()) !== JSON.stringify([...stage.approverOpenIds].sort()) ||
      extractDisplayText(record.fields.请假工作流状态, '').trim() !== status) throw new ServiceUnavailableException('岗位交接审批人回读校验未通过');
    await this.store.enqueueTask({ recordId: current.recordId, businessKey: `leave:${current.recordId}:deliver:${stage.key}:${stage.version}`,
      kind: 'deliver_stage_cards', payload: { stageKey: stage.key, stageVersion: stage.version } });
  }

  private async routeApplication(
    task: LeaveWorkflowTaskEntry,
    now: Date,
  ): Promise<void> {
    const application = await this.requireApplication(task.recordId);
    if (
      application.status !== 'accepted' &&
      application.status !== 'routing_failed' &&
      application.status !== 'sync_error'
    ) {
      return;
    }
    try {
      const [record, organizationRecords, directory] = await Promise.all([
        this.gateway.readLeaveRecord(application.recordId),
        this.gateway.fetchOrganizationRoutingRecords(),
        this.bitableSyncService.getCachedActivePersonnelDirectory(),
      ]);
      const snapshot = await this.hydrateMissingShiftGroups(
        enrichSnapshot(application.snapshot, record.fields, directory),
      );
      const mergedOrganization = mergeOrganizationRecords(
        organizationRecords,
        directory,
      );
      const applicant = resolveApplicant(
        snapshot,
        directory,
        mergedOrganization,
      );
      const routingRecords = applyRecordSupervisorRouting(
        mergedOrganization,
        applicant,
        record.fields,
        directory,
      );
      const approvalPlan = this.buildCurrentApprovalPlan({
        applicant,
        organizationRecords: routingRecords,
        approvalDayCount: snapshot.approvalDayCount,
        managerEscalationApprovers: readManagerEscalationApprovers(directory),
      });
      const firstStage = approvalPlan.stages[0];
      if (!firstStage)
        throw new BadRequestException('请休假审批路由缺少首个阶段');
      const longWhiteDecisionCandidate = requiresLongWhiteSubstituteDecision(
        snapshot.shiftGroups || [],
      );
      const substituteRequired =
        requiresSupervisorSubstitute(applicant) &&
        (!longWhiteDecisionCandidate ||
          requiresMandatoryLongWhiteSubstitute(applicant));
      const substituteDecisionRequired =
        longWhiteDecisionCandidate && !substituteRequired;
      const substituteChoiceAvailable =
        substituteRequired || substituteDecisionRequired;
      const candidateSets =
        substituteChoiceAvailable && (snapshot.shiftGroups || []).length
          ? await this.resolveShiftCandidateSets(snapshot, applicant, directory)
          : [];
      const substituteCandidates = substituteChoiceAvailable
        ? candidateSets.length
          ? uniqueSubstituteCandidates(
              candidateSets.flatMap((set) => set.candidates),
            )
          : await this.resolveSubstituteCandidates(
              snapshot,
              applicant,
              directory,
            )
        : [];
      const screenshotEvidence = await this.prepareScreenshotEvidence(
        application.recordId,
        record.fields,
        application.snapshot,
      );
      const routedSnapshot: LeaveWorkflowSnapshot = {
        ...snapshot,
        ...screenshotEvidence,
        substituteName: undefined,
        substituteOpenId: undefined,
        substitutePersonRecordId: undefined,
        substituteRequired,
        substituteDecisionRequired,
        substituteDecisionMade: false,
        substituteCandidates,
        candidateSets,
        shiftAssignments: [],
        assignmentRevision: 0,
        applicantNotificationOpenIds: resolveApplicantNotificationOpenIds(
          snapshot,
          applicant,
          directory,
        ),
      };
      const substituteRecipients = resolveSubstituteRecipients(
        routedSnapshot,
        directory,
      );
      const resultRecipients = uniquePeople([
        ...approvalPlan.notificationPlan.finalResultRecipients,
        ...substituteRecipients,
        ...resolvePeopleByOpenIds(
          routedSnapshot.applicantNotificationOpenIds,
          directory,
        ),
      ]);
      assertNotificationAccountsCannotApprove(routedSnapshot, firstStage);

      await this.store.setApprovalPlan(
        application.recordId,
        { snapshot: routedSnapshot, approvalPlan, resultRecipients },
        now,
      );
      await this.gateway.updateLeaveRecord(application.recordId, {
        审批来源: '程序卡片',
        请假工作流状态:
          firstStage.key === 'manager' ? '待经理审批' : '待主管审批',
        请假当前审批人: firstStage.approvers.map((person) => ({
          id: person.openId,
        })),
        请假实际审批人: [],
        请假审批策略版本: readPolicyVersion(),
        请假工作流错误: '',
      });
      await this.assertBitableState(application.recordId, {
        审批来源: '程序卡片',
      });
      await this.store.setPendingStage(
        application.recordId,
        {
          key: firstStage.key,
          version: 1,
          approverOpenIds: firstStage.approvers.map((person) => person.openId),
        },
        now,
      );
      await this.enqueueLeaveShiftDetailSync(
        application.recordId,
        routedSnapshot,
      );
    } catch (error) {
      await this.store.patchApplication(
        application.recordId,
        {
          status: 'routing_failed',
          lastError: safeError(error),
        },
        now,
      );
      throw error;
    }
  }

  private async repairStationChiefRoute(
    task: LeaveWorkflowTaskEntry,
    now: Date,
  ): Promise<void> {
    let application = await this.requireApplication(task.recordId);
    if (!is110StationChiefSnapshot(application.snapshot)) return;
    const sourceStageKey = task.payload.sourceStageKey;
    const sourceStageVersion = Number(task.payload.sourceStageVersion);
    if (
      sourceStageKey !== 'manager' ||
      !Number.isSafeInteger(sourceStageVersion) ||
      sourceStageVersion < 1
    ) {
      throw new BadRequestException('110站站长请休假改路由任务来源阶段无效');
    }
    if (
      application.status === 'supervisor_pending' &&
      application.currentStage?.key === 'supervisor' &&
      application.currentStage.version === sourceStageVersion + 1
    ) {
      return;
    }
    if (
      application.status !== 'routing_failed' ||
      application.currentStage !== null ||
      application.resolvedAction !== null
    ) {
      return;
    }

    let approvalPlan: LeaveApprovalPlan;
    let resultRecipients: LeaveRoutePerson[];
    try {
      const [record, organizationRecords, directory] = await Promise.all([
        this.gateway.readLeaveRecord(application.recordId),
        this.gateway.fetchOrganizationRoutingRecords(),
        this.bitableSyncService.getCachedActivePersonnelDirectory(),
      ]);
      const mergedOrganization = mergeOrganizationRecords(
        organizationRecords,
        directory,
      );
      const applicant = resolveApplicant(
        application.snapshot,
        directory,
        mergedOrganization,
      );
      approvalPlan = this.buildCurrentApprovalPlan({
        applicant,
        organizationRecords: applyRecordSupervisorRouting(
          mergedOrganization,
          applicant,
          record.fields,
          directory,
        ),
        approvalDayCount: application.snapshot.approvalDayCount,
        managerEscalationApprovers: readManagerEscalationApprovers(directory),
      });
      const firstStage = approvalPlan.stages[0];
      if (!firstStage || firstStage.key !== 'supervisor') {
        throw new ServiceUnavailableException(
          '110站站长请休假改路由未生成主管审批阶段',
        );
      }
      assertNotificationAccountsCannotApprove(application.snapshot, firstStage);
      resultRecipients = uniquePeople([
        ...approvalPlan.notificationPlan.finalResultRecipients,
        ...resolveSubstituteRecipients(application.snapshot, directory),
        ...resolvePeopleByOpenIds(
          application.snapshot.applicantNotificationOpenIds,
          directory,
        ),
      ]);
    } catch (error) {
      await this.patchStageCardsForStage(
        application,
        sourceStageKey,
        sourceStageVersion,
        buildLeaveTerminalCard({
          ...toCardContext(application, sourceStageKey, sourceStageVersion),
          outcome: 'routing_invalidated',
          actorName: '系统路由修复',
          message: '审批路由配置异常，原卡片已失效，请等待系统重试',
        }),
        now,
      );
      await this.gateway.updateLeaveRecord(application.recordId, {
        请假工作流状态: '待路由',
        请假当前审批人: [],
        请假工作流错误: safeError(error),
      });
      throw error;
    }

    await this.patchStageCardsForStage(
      application,
      sourceStageKey,
      sourceStageVersion,
      buildLeaveTerminalCard({
        ...toCardContext(application, sourceStageKey, sourceStageVersion),
        outcome: 'rerouted',
        actorName: '系统路由修复',
        message: '审批已转交正确负责人，原卡片不可操作',
      }),
      now,
    );
    application = await this.requireApplication(application.recordId);
    const firstStage = approvalPlan.stages[0];
    const nextStageVersion = sourceStageVersion + 1;
    await this.gateway.updateLeaveRecord(application.recordId, {
      审批来源: '程序卡片',
      请假工作流状态: '待主管审批',
      请假当前审批人: firstStage.approvers.map((person) => ({
        id: person.openId,
      })),
      请假实际审批人: [],
      请假审批策略版本: readPolicyVersion(),
      请假工作流错误: '',
    });
    await this.assertBitableState(application.recordId, {
      请假工作流状态: '待主管审批',
    });
    await this.store.completePendingStageReroute(application.recordId, {
      approvalPlan,
      resultRecipients,
      stage: {
        key: 'supervisor',
        version: nextStageVersion,
        approverOpenIds: firstStage.approvers.map((person) => person.openId),
      },
    });
  }

  private async prepareScreenshotEvidence(
    recordId: string,
    fields: Record<string, unknown>,
    currentSnapshot: LeaveWorkflowSnapshot,
  ): Promise<
    Pick<LeaveWorkflowSnapshot, 'screenshotImageKeys' | 'screenshotStatus'>
  > {
    if (
      currentSnapshot.screenshotStatus === 'ready' &&
      (currentSnapshot.screenshotImageKeys || []).length > 0
    ) {
      return {
        screenshotImageKeys: currentSnapshot.screenshotImageKeys,
        screenshotStatus: 'ready',
      };
    }
    if (
      typeof this.gateway.prepareLeaveApprovalScreenshotImages !== 'function'
    ) {
      return { screenshotImageKeys: [], screenshotStatus: 'missing' };
    }
    try {
      const imageKeys =
        await this.gateway.prepareLeaveApprovalScreenshotImages(fields);
      return {
        screenshotImageKeys: imageKeys,
        screenshotStatus: imageKeys.length > 0 ? 'ready' : 'missing',
      };
    } catch (error) {
      this.logger.warn(
        `请休假流程截图暂不可预览，继续发送审批卡：record=${recordId}, error=${safeError(error)}`,
      );
      return { screenshotImageKeys: [], screenshotStatus: 'unavailable' };
    }
  }

  private async resolveSubstituteCandidates(
    snapshot: LeaveWorkflowSnapshot,
    applicant: LeaveRoutePerson,
    directory: ActivePersonnelDirectory,
  ): Promise<LeaveSubstituteCandidate[]> {
    const { startDate, endDate } = adjacentDateRange(
      snapshot.startAt,
      snapshot.endAt,
    );
    const schedules =
      await this.bitableSyncService.getCachedLeaveRequestImpactSchedules(
        startDate,
        endDate,
      );
    const rule = calculateLeaveRequestSubstituteRule(
      schedules,
      {
        leaveStaffName: snapshot.applicantName,
        startAt: toShanghaiWallClock(snapshot.startAt),
        endAt: toShanghaiWallClock(snapshot.endAt),
      },
      { forceRequiresSubstitute: true },
    );
    if (!rule.requiresSubstitute) {
      throw new ServiceUnavailableException(
        '本地排班缓存未命中请假班次，暂不能生成替班人员清单',
      );
    }
    const candidates = uniqueSubstituteCandidates(
      selectablePersonnel(directory)
        .filter(
          (person) =>
            person.recordId !== applicant.personRecordId &&
            !isLeaveSubstituteStaffBlocked(rule, person.name),
        )
        .map((person) => ({
          personRecordId: person.recordId,
          name: person.name,
          openId: person.openId,
          position: person.position,
          buildings: normalizeDirectoryBuildings(person.buildings),
        })),
    );
    if (!candidates.length) {
      throw new ServiceUnavailableException('当前没有符合排班约束的替班人员');
    }
    return candidates;
  }

  private async resolveShiftCandidateSets(
    snapshot: LeaveWorkflowSnapshot,
    applicant: LeaveRoutePerson,
    directory: ActivePersonnelDirectory,
    selections?: LeaveShiftAssignmentSelection[],
  ): Promise<LeaveShiftCandidateSet[]> {
    const groups = snapshot.shiftGroups || [];
    if (!groups.length) return [];
    const { startDate, endDate } = adjacentDateRange(
      snapshot.startAt,
      snapshot.endAt,
    );
    const cachedSchedules =
      await this.bitableSyncService.getCachedLeaveRequestImpactSchedules(
        startDate,
        endDate,
      );
    const schedules = restoreOwnShiftCoverage(snapshot, cachedSchedules);
    const currentGroups = createLeaveRequestShiftGroups(
      calculateLeaveRequestImpact(schedules, {
        leaveStaffName: snapshot.applicantName,
        startAt: toShanghaiWallClock(snapshot.startAt),
        endAt: toShanghaiWallClock(snapshot.endAt),
      }).affectedSchedules,
    );
    if (shiftGroupSignature(currentGroups) !== shiftGroupSignature(groups)) {
      throw new ServiceUnavailableException(
        '当前排班已变化，请刷新请假申请后重新审批',
      );
    }
    const selectablePeople = uniqueSubstituteCandidates(
      selectablePersonnel(directory)
        .filter((person) => person.recordId !== applicant.personRecordId)
        .map((person) => ({
          personRecordId: person.recordId,
          name: person.name,
          openId: person.openId,
          position: person.position,
          buildings: normalizeDirectoryBuildings(person.buildings),
        })),
    );
    const candidateSets = buildLeaveShiftCandidateSets({
      groups,
      schedules,
      applicant,
      selectablePeople,
      allowOnDutySubstitution: true,
      selections,
    });
    const unavailable = candidateSets.find((set) => !set.candidates.length);
    if (unavailable) {
      if (selections) throw new BadRequestException('所选替班或补位人员当前不可用，请重新核对替班安排');
      throw new ServiceUnavailableException(
        `班次 ${unavailable.shiftKey} 当前没有符合排班约束的替班人员`,
      );
    }
    return candidateSets;
  }

  private async hydrateMissingShiftGroups(
    snapshot: LeaveWorkflowSnapshot,
  ): Promise<LeaveWorkflowSnapshot> {
    if ((snapshot.shiftGroups || []).length > 0) return snapshot;
    const readSchedules = (
      this.bitableSyncService as Partial<BitableSyncService>
    ).getCachedLeaveRequestImpactSchedules;
    if (typeof readSchedules !== 'function') return snapshot;
    const { startDate, endDate } = adjacentDateRange(
      snapshot.startAt,
      snapshot.endAt,
    );
    const schedules = await readSchedules.call(
      this.bitableSyncService,
      startDate,
      endDate,
    );
    const shiftGroups = createLeaveRequestShiftGroups(
      calculateLeaveRequestImpact(schedules, {
        leaveStaffName: snapshot.applicantName,
        startAt: toShanghaiWallClock(snapshot.startAt),
        endAt: toShanghaiWallClock(snapshot.endAt),
      }).affectedSchedules,
    );
    return shiftGroups.length > 0 ? { ...snapshot, shiftGroups } : snapshot;
  }

  private async refreshCandidateSets(
    application: LeaveWorkflowApplicationEntry,
    submitted?: LeaveShiftAssignmentSelection[],
  ): Promise<LeaveShiftCandidateSet[]> {
    const selections = submitted ? new Map<string, LeaveShiftAssignmentSelection>([
      ...(application.snapshot.shiftAssignments || []).map((row) => [row.shiftKey, row] as const),
      ...submitted.map((row) => [row.shiftKey, row] as const),
    ]) : undefined;
    if (selections && (application.snapshot.shiftGroups || []).some((group) => !selections.get(group.shiftKey)?.substitutePersonRecordId)) {
      throw new BadRequestException('请为每个班次选择替班人员');
    }
    const directory =
      await this.bitableSyncService.getCachedActivePersonnelDirectory();
    let snapshot = application.snapshot;
    if (application.status === 'approved' && typeof this.store.getOriginalPostBackfillHistory === 'function') {
      const history = await this.store.getOriginalPostBackfillHistory(application.recordId);
      const current = snapshot.shiftAssignments || [];
      const activeOriginalIds = new Set(current.flatMap((row) => (row.originalPostBackfills || []).flatMap((backup) => backup.group.scheduleRecordIds)));
      const historical = history.map((row) => ({ ...row, scheduleRecordIds: [], originalPostBackfills: (row.originalPostBackfills || []).map((backup) => ({ ...backup, group: { ...backup.group, scheduleRecordIds: backup.group.scheduleRecordIds.filter((id) => !activeOriginalIds.has(id)) } })).filter((backup) => backup.group.scheduleRecordIds.length) }));
      snapshot = { ...snapshot, shiftAssignments: [...historical, ...current] };
    }
    return this.resolveShiftCandidateSets(
      snapshot,
      {
        personRecordId: snapshot.applicantPersonRecordId,
        name: snapshot.applicantName,
        openId: snapshot.applicantOpenId,
        position: snapshot.position,
        buildings: snapshot.building ? [snapshot.building] : [],
      },
      directory,
      selections ? [...selections.values()] : undefined,
    );
  }

  private resolveSubmittedShiftAssignments(
    application: LeaveWorkflowApplicationEntry,
    submitted: LeaveShiftAssignmentSelection[],
    candidateSets: LeaveShiftCandidateSet[],
    actorOpenId: string,
    actorName: string,
    rejectUnchanged: boolean,
  ): LeaveShiftSubstituteAssignment[] {
    const current = application.snapshot.shiftAssignments || [];
    const selections = new Map(
      current.map(
        (assignment) =>
          [
            assignment.shiftKey,
            {
              shiftKey: assignment.shiftKey,
              substitutePersonRecordId: assignment.substitutePersonRecordId,
              ...(assignment.backfillPersonRecordId ? { backfillPersonRecordId: assignment.backfillPersonRecordId, originalPostSignature: assignment.originalPostSignature } : {}),
            },
          ] as const,
      ),
    );
    for (const selection of submitted) {
      selections.set(selection.shiftKey, selection);
    }
    const result = validateLeaveShiftAssignmentPlan({
      groups: application.snapshot.shiftGroups || [],
      selections: [...selections.values()],
      candidateSets,
      actorOpenId,
      actorName,
      changedAt: new Date().toISOString(),
    });
    if (result.valid === false) {
      throw new BadRequestException(result.message);
    }
    if (
      rejectUnchanged &&
      shiftAssignmentSignature(result.assignments) ===
        shiftAssignmentSignature(current)
    ) {
      throw new BadRequestException('替班安排没有变化');
    }
    return result.assignments;
  }

  private async deliverStageCards(task: LeaveWorkflowTaskEntry): Promise<void> {
    const application = await this.requireApplication(task.recordId);
    const stageKey = task.payload.stageKey;
    const stageVersion = Number(task.payload.stageVersion);
    const stage = application.currentStage;
    if (
      !stage ||
      stage.key !== stageKey ||
      stage.version !== stageVersion ||
      (application.status !== 'supervisor_pending' &&
        application.status !== 'manager_pending')
    ) {
      return;
    }
    for (const openId of stage.approverOpenIds) {
      const businessKey = `leave:${application.recordId}:stage:${stage.key}:${stage.version}:${openId}`;
      if (
        application.stageCards.some((card) => card.businessKey === businessKey)
      )
        continue;
      if (!this.canActorContinue(openId)) {
        throw new BadRequestException('审批人员业务权限已收回，请核对岗位交接');
      }
      const messageId = await this.gateway.sendInteractiveCard(
        openId,
        buildLeaveApprovalCard(
          toCardContext(application, stage.key, stage.version),
        ),
        businessKey,
      );
      await this.store.recordStageCardDelivery(application.recordId, {
        recipientOpenId: openId,
        messageId,
        businessKey,
      });
    }
    for (const openId of application.snapshot.applicantNotificationOpenIds) {
      const businessKey = `leave:${application.recordId}:progress:${stage.key}:${stage.version}:${openId}`;
      if (
        application.resultCards.some((card) => card.businessKey === businessKey)
      )
        continue;
      const messageId = await this.gateway.sendInteractiveCard(
        openId,
        buildLeaveProgressCard(
          toCardContext(application, stage.key, stage.version),
        ),
        businessKey,
      );
      await this.store.recordResultCardDelivery(application.recordId, {
        recipientOpenId: openId,
        messageId,
        businessKey,
      });
    }
  }

  private async syncLeaveShiftDetails(
    task: LeaveWorkflowTaskEntry,
  ): Promise<void> {
    if (!this.detailGateway) return;
    const revision = Number(task.payload.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new BadRequestException('替班明细同步任务版本无效');
    }
    const application = await this.requireApplication(task.recordId);
    if (revision !== (application.snapshot.assignmentRevision ?? application.snapshot.substituteRevision ?? 0)) return;
    const groups = application.snapshot.shiftGroups || [];
    if (!groups.length) return;
    await this.detailGateway.ensurePendingRows(application.recordId, groups);
    const assignments = application.snapshot.shiftAssignments || [];
    if (!assignments.length) return;
    await this.detailGateway.upsertCurrentAssignments(
      application.recordId,
      revision,
      assignments,
    );
  }

  private async enqueueLeaveShiftDetailSync(
    recordId: string,
    snapshot: LeaveWorkflowSnapshot,
  ): Promise<void> {
    if (!this.detailGateway || !(snapshot.shiftGroups || []).length) return;
    const assignments = snapshot.shiftAssignments || [];
    const revision = snapshot.assignmentRevision || 0;
    await this.store.enqueueTask({
      businessKey: `leave:${recordId}:shift-details:${assignments.length ? 'active' : 'pending'}:${revision}`,
      recordId,
      kind: 'sync_leave_shift_details',
      payload: { revision },
    });
  }

  private async applyStageAction(
    task: LeaveWorkflowTaskEntry,
    now: Date,
  ): Promise<void> {
    const stageKey = task.payload.stageKey;
    const stageVersion = Number(task.payload.stageVersion);
    if (stageKey !== 'supervisor' && stageKey !== 'manager') {
      throw new BadRequestException('请休假审批任务阶段无效');
    }
    const application = await this.requireApplication(task.recordId);
    const action = await this.store.getStageAction(
      application.recordId,
      stageKey,
      stageVersion,
    );
    if (!action) throw new BadRequestException('请休假审批动作不存在');
    const plan = application.approvalPlan;
    if (!plan) throw new BadRequestException('请休假审批路由尚未生成');

    if (action.action === 'reject') {
      await this.gateway.updateLeaveRecord(
        application.recordId,
        rejectedFields(action),
      );
      await this.assertBitableState(application.recordId, {
        请假工作流状态: '已驳回',
        请假驳回原因: action.rejectionReason,
      });
      await this.store.patchApplication(
        application.recordId,
        {
          status: 'rejected',
          lastError: '',
        },
        now,
      );
      await this.store.enqueueTask({
        businessKey: `leave:${application.recordId}:result:rejected`,
        recordId: application.recordId,
        kind: 'deliver_result_cards',
      });
      return;
    }

    const stageIndex = plan.stages.findIndex((stage) => stage.key === stageKey);
    const nextStage = stageIndex >= 0 ? plan.stages[stageIndex + 1] : undefined;
    if (nextStage) {
      const nextVersion = stageVersion + 1;
      await this.gateway.updateLeaveRecord(application.recordId, {
        请假工作流状态:
          nextStage.key === 'manager' ? '待经理审批' : '待主管审批',
        请假当前审批人: nextStage.approvers.map((person) => ({
          id: person.openId,
        })),
        请假实际审批人: [{ id: action.actorOpenId }],
        请假审批时间: Date.parse(action.createdAt),
        请假工作流错误: '',
        ...substituteFields(action),
      });
      await this.assertBitableState(application.recordId, {
        请假工作流状态:
          nextStage.key === 'manager' ? '待经理审批' : '待主管审批',
        ...substituteFields(action),
      });
      await this.store.setPendingStage(
        application.recordId,
        {
          key: nextStage.key,
          version: nextVersion,
          approverOpenIds: nextStage.approvers.map((person) => person.openId),
        },
        now,
      );
      await this.patchStageCards(
        application,
        buildLeaveTerminalCard({
          ...toCardContext(application, stageKey, stageVersion),
          outcome: 'stage_approved',
          actorName: action.actorName || '审批人',
          message: '本阶段已通过，等待后续审批',
        }),
        now,
      );
      await this.enqueueStageSubstituteChangeNotifications(action);
      await this.enqueueLeaveShiftDetailSync(
        application.recordId,
        application.snapshot,
      );
      return;
    }

    await this.gateway.updateLeaveRecord(application.recordId, {
      ...approvedFields(action),
      ...substituteFields(action),
    });
    await this.assertBitableState(application.recordId, {
      请假工作流状态: '已审批',
      ...substituteFields(action),
    });
    await this.store.patchApplication(
      application.recordId,
      {
        status: 'approved',
        lastError: '',
      },
      now,
    );
    await this.enqueueApprovedLeaveScheduleSync(
      application.recordId,
      application.snapshot.assignmentRevision ??
        application.snapshot.substituteRevision ??
        0,
    );
    await this.enqueueLeaveShiftDetailSync(
      application.recordId,
      application.snapshot,
    );
    await this.store.enqueueTask({
      businessKey: `leave:${application.recordId}:result:approved`,
      recordId: application.recordId,
      kind: 'deliver_result_cards',
    });
    await this.enqueueStageSubstituteChangeNotifications(action);
    if (application.snapshot.substituteRequired) {
      await this.enqueueSubstituteAdjustmentCards(
        application.recordId,
        application.snapshot.assignmentRevision ??
          application.snapshot.substituteRevision ??
          0,
      );
    }
  }

  private async enqueueApprovedLeaveScheduleSync(
    recordId: string,
    revision: number,
  ): Promise<void> {
    await this.store.enqueueTask({
      businessKey: `leave:${recordId}:schedule-sync:${revision}`,
      recordId,
      kind: 'sync_approved_leave_schedule',
      payload: { revision },
    });
  }

  private async syncApprovedLeaveSchedule(
    task: LeaveWorkflowTaskEntry,
  ): Promise<void> {
    const revision = Number(task.payload.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new BadRequestException('请休假排班同步任务版本无效');
    }
    const application = await this.requireApplication(task.recordId);
    const currentRevision =
      application.snapshot.assignmentRevision ??
      application.snapshot.substituteRevision ??
      0;
    if (application.status !== 'approved' || revision !== currentRevision) {
      return;
    }
    const assignments = application.snapshot.shiftAssignments || [];
    const history = typeof this.store.getOriginalPostBackfillHistory === 'function' ? await this.store.getOriginalPostBackfillHistory(application.recordId) : [];
    const activeIds = new Set(assignments.flatMap((row) => [...row.scheduleRecordIds, ...(row.originalPostBackfills || []).flatMap((backup) => backup.group.scheduleRecordIds)]));
    const releasedOriginalPosts = [...new Map(history.flatMap((row) => (row.originalPostBackfills || []).flatMap((backup) => {
      const scheduleRecordIds = backup.group.scheduleRecordIds.filter((id) => !activeIds.has(id));
      return scheduleRecordIds.length ? [{ scheduleRecordIds, previousPrimaryName: row.substituteName, previousBackupName: backup.substituteName }] : [];
    })).map((row) => [JSON.stringify(row), row])).values()];
    if (assignments.some((assignment) => assignment.originalPostBackfills?.length) || releasedOriginalPosts.length) {
      if (!this.detailGateway) throw new ServiceUnavailableException('原岗补位明细同步尚未就绪');
      await this.detailGateway.upsertCurrentAssignments(application.recordId, revision, assignments);
    }
    await this.bitableSyncService.syncApprovedLeaveScheduleSnapshot(
      assignments.map((assignment) => ({
        shiftKey: assignment.shiftKey,
        scheduleRecordIds: assignment.scheduleRecordIds,
        substituteName: assignment.substituteName,
        ...(assignment.originalPostBackfills?.length ? { originalPostBackfills: assignment.originalPostBackfills } : {}),
      })),
      {
        applicantName: application.snapshot.applicantName,
        startAt: application.snapshot.startAt,
        endAt: application.snapshot.endAt,
        ...(releasedOriginalPosts.length ? { releasedOriginalPosts } : {}),
        ...(application.snapshot.substituteName
          ? { substituteName: application.snapshot.substituteName }
          : {}),
      },
    );
  }

  private async enqueueSubstituteAdjustmentCards(
    recordId: string,
    revision: number,
  ): Promise<void> {
    await this.store.enqueueTask({
      businessKey: `leave:${recordId}:substitute-adjustment:${revision}:deliver`,
      recordId,
      kind: 'deliver_substitute_adjustment_cards',
      payload: { revision },
    });
  }

  private async deliverSubstituteAdjustmentCards(
    task: LeaveWorkflowTaskEntry,
  ): Promise<void> {
    let application = await this.requireApplication(task.recordId);
    const revision = Number(task.payload.revision);
    if (
      application.status !== 'approved' ||
      !application.snapshot.substituteRequired ||
      revision !==
        (application.snapshot.assignmentRevision ??
          application.snapshot.substituteRevision ??
          0)
    ) {
      return;
    }
    const mutationId = task.payload.handoverMutationId;
    if (mutationId !== undefined && (typeof mutationId !== 'string' || !/^handover-[a-f0-9]{64}$/.test(mutationId))) throw new BadRequestException('替班岗位交接任务无效');
    for (let count = 0; count < 200; count++) {
      const approvers = this.currentAdjustmentApprovers(application), currentIds = new Set(approvers.map(person => person.openId));
      for (const delivery of application.substituteAdjustmentCards) {
        if (!delivery.businessKey.includes(`:substitute-adjustment:${revision}:`) || currentIds.has(delivery.recipientOpenId) || application.terminalCardMessageIds.includes(delivery.messageId)) continue;
        await this.gateway.patchInteractiveCard(delivery.messageId, buildLeaveTerminalCard({ ...toCardContext(application, 'manager', 1), outcome: 'rerouted', actorName: '岗位交接', message: '岗位权限已更新，请使用现任人员的新卡片办理' }));
        application = await this.store.markTerminalCardPatched(application.recordId, delivery.messageId);
      }
      const person = approvers.find(candidate => !application.substituteAdjustmentCards.some(delivery => delivery.recipientOpenId === candidate.openId && delivery.businessKey.includes(`:substitute-adjustment:${revision}:`) && !application.terminalCardMessageIds.includes(delivery.messageId)));
      if (!person) break;
      if (count === 199) throw new ServiceUnavailableException('替班调整岗位持续变化，请稍后恢复原任务');
      const openId = person.openId;
      const businessKey = mutationId ? `leave:substitute-adjustment:${revision}:role:${createHash('sha256').update(JSON.stringify([application.recordId, revision, openId, mutationId])).digest('hex')}`
        : `leave:${application.recordId}:substitute-adjustment:${revision}:${openId}`;
      if (
        application.substituteAdjustmentCards.some(
          (delivery) => delivery.businessKey === businessKey,
        )
      ) {
        continue;
      }
      const messageId = await this.gateway.sendInteractiveCard(
        openId,
        buildLeaveSubstituteAdjustmentCard(
          toCardContext(application, 'manager', 1),
          revision,
        ),
        businessKey,
      );
      await this.store.recordSubstituteAdjustmentCardDelivery(
        application.recordId,
        { recipientOpenId: openId, messageId, businessKey },
      );
      application = await this.requireApplication(application.recordId);
    }
  }

  private async applySubstituteUpdate(
    task: LeaveWorkflowTaskEntry,
    now: Date,
  ): Promise<void> {
    const revision = Number(task.payload.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new BadRequestException('替班调整任务版本无效');
    }
    let application = await this.requireApplication(task.recordId);
    const update = await this.store.getSubstituteUpdate(
      application.recordId,
      revision,
    );
    if (!update) throw new BadRequestException('替班调整动作不存在');
    if (application.status !== 'approved' || revision !== (
      application.snapshot.assignmentRevision ?? application.snapshot.substituteRevision ?? 0
    )) return;
    await this.gateway.updateLeaveRecord(application.recordId, {
      '是否需要替班（替班打√）': true,
      '替班人员（填姓名）': update.shiftAssignments.length
        ? buildShiftSubstituteNames(update.shiftAssignments)
        : update.substituteName,
      ...(update.shiftAssignments.length
        ? { 替班安排: buildShiftAssignmentSummary(update.shiftAssignments) }
        : {}),
      替班调整版本: update.revision,
      替班调整人: [{ id: update.actorOpenId }],
      替班调整时间: Date.parse(update.createdAt),
      请假工作流错误: '',
    });
    await this.assertBitableState(application.recordId, {
      '替班人员（填姓名）': update.shiftAssignments.length
        ? buildShiftSubstituteNames(update.shiftAssignments)
        : update.substituteName,
      替班调整版本: String(update.revision),
    });
    application = await this.requireApplication(application.recordId);
    if (application.status !== 'approved' || revision !== (
      application.snapshot.assignmentRevision ?? application.snapshot.substituteRevision ?? 0
    )) return;
    await this.enqueueLeaveShiftDetailSync(
      application.recordId,
      application.snapshot,
    );
    if (update.shiftAssignments.length || update.substituteName) {
      await this.enqueueApprovedLeaveScheduleSync(
        application.recordId,
        update.revision,
      );
    }
    const terminalCard = buildLeaveSubstituteAdjustmentTerminalCard(
      toCardContext(application, 'manager', 1),
      update.actorName || '审批人',
    );
    const failures: string[] = [];
    for (const delivery of application.substituteAdjustmentCards.filter(
      (item) =>
        item.businessKey.includes(
          `:substitute-adjustment:${update.expectedRevision}:`,
        ),
    )) {
      try {
        await this.gateway.patchInteractiveCard(
          delivery.messageId,
          terminalCard,
        );
      } catch {
        failures.push(delivery.messageId);
      }
    }
    if (failures.length > 0) {
      throw new ServiceUnavailableException(
        `替班调整卡片终态更新未完成：${failures.join('、')}`,
      );
    }
    await this.enqueueSubstituteAdjustmentCards(
      application.recordId,
      update.revision,
    );
    await this.store.enqueueTask({
      businessKey: `leave:${application.recordId}:substitute-update:${update.revision}:notify`,
      recordId: application.recordId,
      kind: 'deliver_substitute_update_notifications',
      payload: { revision: update.revision },
    });
    await this.gateway.updateLeaveRecord(application.recordId, {
      请假工作流错误: '',
    });
  }

  private async deliverSubstituteUpdateNotifications(
    task: LeaveWorkflowTaskEntry,
  ): Promise<void> {
    const revision = Number(task.payload.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new BadRequestException('替班变更通知版本无效');
    }
    let application = await this.requireApplication(task.recordId);
    if (application.status !== 'approved') return;
    const update = await this.store.getSubstituteUpdate(
      application.recordId,
      revision,
    );
    if (!update) throw new BadRequestException('替班变更通知缺少调整记录');
    await this.deliverSubstituteChangeNotifications(
      application,
      update,
      `leave:${application.recordId}:substitute-update:${revision}:notify`,
    );
  }

  private async enqueueStageSubstituteChangeNotifications(
    action: LeaveWorkflowActionEntry,
  ): Promise<void> {
    if (!hasSubstituteChange(action)) return;
    await this.store.enqueueTask({
      businessKey: `leave:${action.recordId}:stage-substitute-change:${action.stageKey}:${action.stageVersion}:notify`,
      recordId: action.recordId,
      kind: 'deliver_stage_substitute_change_notifications',
      payload: {
        stageKey: action.stageKey,
        stageVersion: action.stageVersion,
      },
    });
  }

  private async deliverStageSubstituteChangeNotifications(
    task: LeaveWorkflowTaskEntry,
  ): Promise<void> {
    const stageKey = task.payload.stageKey;
    const stageVersion = Number(task.payload.stageVersion);
    if (
      (stageKey !== 'supervisor' && stageKey !== 'manager') ||
      !Number.isSafeInteger(stageVersion) ||
      stageVersion < 1
    ) {
      throw new BadRequestException('审批阶段替班变更通知参数无效');
    }
    const application = await this.requireApplication(task.recordId);
    const action = await this.store.getStageAction(
      application.recordId,
      stageKey,
      stageVersion,
    );
    if (!action || !hasSubstituteChange(action)) return;
    await this.deliverSubstituteChangeNotifications(
      application,
      action,
      `leave:${application.recordId}:stage-substitute-change:${stageKey}:${stageVersion}:notify`,
    );
  }

  private async deliverSubstituteChangeNotifications(
    initialApplication: LeaveWorkflowApplicationEntry,
    change: SubstituteChangeDetails,
    businessPrefix: string,
  ): Promise<void> {
    let application = initialApplication;
    const directory =
      await this.bitableSyncService.getCachedActivePersonnelDirectory();
    const failures: string[] = [];
    const attempted = new Set<string>();
    for (let count = 0; count < 200; count++) {
      const recipient = resolveSubstituteUpdateNotificationRecipients(application, change, directory, this.currentNotificationRecipients(application))
        .find(person => !attempted.has(person.openId) && !application.resultCards.some(delivery => delivery.businessKey === `${businessPrefix}:${person.openId}`));
      if (!recipient) break;
      if (count === 199) throw new ServiceUnavailableException('替班通知岗位持续变化，请稍后恢复原通知任务');
      attempted.add(recipient.openId);
      const businessKey = `${businessPrefix}:${recipient.openId}`;
      if (
        application.resultCards.some(
          (delivery) => delivery.businessKey === businessKey,
        )
      ) {
        continue;
      }
      try {
        const messageId = await this.gateway.sendInteractiveCard(
          recipient.openId,
          buildLeaveSubstituteChangeNotificationCard(
            toCardContext(application, 'manager', 1),
            {
              audience: recipient.audience,
              previousSubstituteName: change.previousSubstituteName,
              substituteName: change.substituteName,
              actorName: change.actorName,
              shiftChangeSummary: buildShiftChangeSummary(change),
            },
          ),
          businessKey,
        );
        await this.store.recordResultCardDelivery(application.recordId, {
          recipientOpenId: recipient.openId,
          messageId,
          businessKey,
        });
        application = await this.requireApplication(application.recordId);
      } catch (error) {
        failures.push(`${recipient.openId}:${safeError(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new ServiceUnavailableException(
        `替班变更通知部分失败：${failures.join('；')}`,
      );
    }
  }

  private async deliverResultCards(
    task: LeaveWorkflowTaskEntry,
    now: Date,
  ): Promise<void> {
    let application = await this.requireApplication(task.recordId);
    const rejected = application.status === 'rejected';
    const approved = application.status === 'approved';
    if (!approved && !rejected) return;
    const card = this.stageActionCard(application, null, 'manager', 1);
    await this.patchStageCards(application, card, now);
    application = await this.requireApplication(application.recordId);
    const covered = new Set(
      application.stageCards.map((item) => item.recipientOpenId),
    );
    for (let count = 0; count < 200; count++) {
      const recipient = this.currentNotificationRecipients(application).find(person => !covered.has(person.openId) && !application.resultCards.some(delivery => delivery.businessKey === `leave:${application.recordId}:result:${person.openId}`));
      if (!recipient) break;
      if (count === 199) throw new ServiceUnavailableException('请休假通知岗位持续变化，请稍后恢复原通知任务');
      const businessKey = `leave:${application.recordId}:result:${recipient.openId}`;
      if (
        application.resultCards.some((item) => item.businessKey === businessKey)
      )
        continue;
      const messageId = await this.gateway.sendInteractiveCard(
        recipient.openId,
        card,
        businessKey,
      );
      await this.store.recordResultCardDelivery(
        application.recordId,
        {
          recipientOpenId: recipient.openId,
          messageId,
          businessKey,
        },
        now,
      );
      application = await this.requireApplication(application.recordId);
    }
    await this.gateway.updateLeaveRecord(application.recordId, {
      请假工作流错误: '',
    });
  }

  private async syncStageActionCards(task: LeaveWorkflowTaskEntry, now: Date): Promise<void> {
    const stageKey = task.payload.stageKey;
    const stageVersion = Number(task.payload.stageVersion);
    if ((stageKey !== 'supervisor' && stageKey !== 'manager') || !Number.isSafeInteger(stageVersion) || stageVersion < 1) {
      throw new BadRequestException('请休假审批卡片同步阶段无效');
    }
    const action = await this.store.getStageAction(task.recordId, stageKey, stageVersion);
    if (!action) throw new BadRequestException('请休假审批动作不存在');
    const application = await this.requireApplication(task.recordId);
    const prefix = `leave:${application.recordId}:stage:${stageKey}:${stageVersion}:`;
    const patched = new Set(Array.isArray(task.payload.patchedMessageIds) ? task.payload.patchedMessageIds : []);
    const failures: string[] = [];
    for (const delivery of application.stageCards) {
      if (!delivery.businessKey.startsWith(prefix) || patched.has(delivery.messageId)) continue;
      try {
        const before = await this.requireApplication(task.recordId);
        await this.gateway.patchInteractiveCard(delivery.messageId, this.stageActionCard(before, action, stageKey, stageVersion));
        const after = await this.requireApplication(task.recordId);
        if (after.revision !== before.revision || after.status !== before.status) {
          await this.gateway.patchInteractiveCard(delivery.messageId, this.stageActionCard(after, action, stageKey, stageVersion));
        }
        await this.store.markTerminalCardPatched(task.recordId, delivery.messageId, now);
        await this.store.recordStageActionCardPatched(task.key, task.claimToken, delivery.messageId);
        patched.add(delivery.messageId);
      } catch (error) {
        failures.push(`${delivery.messageId}: ${safeError(error)}`);
      }
    }
    if (failures.length) throw new ServiceUnavailableException(`请休假审批卡片状态同步未完成：${failures.join('；')}`);
  }

  private async patchStageCards(
    application: LeaveWorkflowApplicationEntry,
    card: Record<string, unknown>,
    now: Date,
  ): Promise<void> {
    const failures: string[] = [];
    for (const delivery of application.stageCards) {
      try {
        await this.gateway.patchInteractiveCard(delivery.messageId, card);
        await this.store.markTerminalCardPatched(
          application.recordId,
          delivery.messageId,
          now,
        );
      } catch (error) {
        failures.push(`${delivery.messageId}: ${safeError(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new ServiceUnavailableException(
        `请休假审批卡片终态更新未完成：${failures.join('、')}`,
      );
    }
  }

  private async patchStageCardsForStage(
    application: LeaveWorkflowApplicationEntry,
    stageKey: 'supervisor' | 'manager',
    stageVersion: number,
    card: Record<string, unknown>,
    now: Date,
  ): Promise<void> {
    const terminalIds = new Set(application.terminalCardMessageIds);
    const businessKeyPrefix = `leave:${application.recordId}:stage:${stageKey}:${stageVersion}:`;
    const failures: string[] = [];
    for (const delivery of application.stageCards) {
      if (
        terminalIds.has(delivery.messageId) ||
        !delivery.businessKey.startsWith(businessKeyPrefix)
      ) {
        continue;
      }
      try {
        await this.gateway.patchInteractiveCard(delivery.messageId, card);
        await this.store.markTerminalCardPatched(
          application.recordId,
          delivery.messageId,
          now,
        );
      } catch (error) {
        failures.push(`${delivery.messageId}: ${safeError(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new ServiceUnavailableException(
        `请休假错误审批卡终态更新未完成：${failures.join('、')}`,
      );
    }
  }

  private async assertBitableState(
    recordId: string,
    expected: Record<string, string | boolean>,
  ): Promise<void> {
    const record = await this.gateway.readLeaveRecord(recordId);
    for (const [field, value] of Object.entries(expected)) {
      const actual = extractDisplayValues(record.fields[field])
        .join(' ')
        .replace(/\s+/gu, '')
        .trim();
      const normalizedExpected = String(value).replace(/\s+/gu, '');
      if (actual !== normalizedExpected) {
        throw new ServiceUnavailableException(
          `请休假多维字段“${field}”回读校验未通过`,
        );
      }
    }
  }

  private async recordTaskFailure(
    task: LeaveWorkflowTaskEntry,
    error: unknown,
    now: Date,
  ): Promise<void> {
    const message = safeError(error);
    try {
      await this.store.patchApplication(
        task.recordId,
        {
          lastError: message,
        },
        now,
      );
    } catch (patchError) {
      this.logger.warn(
        `请休假工作流失败台账写入失败：${safeError(patchError)}`,
      );
    }
    try {
      await this.gateway.updateLeaveRecord(task.recordId, {
        请假工作流错误: message,
      });
    } catch (patchError) {
      this.logger.warn(
        `请休假工作流错误回填多维失败：${safeError(patchError)}`,
      );
    }
  }

  private async requireApplication(
    recordId: string,
  ): Promise<LeaveWorkflowApplicationEntry> {
    const entry = await this.store.getApplication(recordId);
    if (!entry) throw new BadRequestException('未找到请休假工作流记录');
    return entry;
  }

  private assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException('请休假程序审批工作流未启用');
    }
  }
}

function hasCompleteCandidateSets(snapshot: LeaveWorkflowSnapshot): boolean {
  const groups = snapshot.shiftGroups || [];
  const sets = snapshot.candidateSets || [];
  if (!groups.length || sets.length !== groups.length) return false;
  const keys = new Set(sets.map((set) => set.shiftKey));
  return groups.every((group) => keys.has(group.shiftKey));
}

function normalizeAcceptanceSnapshot(
  input: LeaveWorkflowAcceptApplicationsInput,
): LeaveWorkflowSnapshot {
  const startAt = requireDateTime(input.startAt, '请休假开始时间无效');
  const endAt = requireDateTime(input.endAt, '请休假结束时间无效');
  if (Date.parse(endAt) < Date.parse(startAt)) {
    throw new BadRequestException('请休假结束时间不能早于开始时间');
  }
  return {
    applicantName: requireText(input.leaveStaffName, '请休假人员无效', 100),
    applicantOpenId: '',
    applicantPersonRecordId: '',
    applicantNotificationOpenIds: [],
    building: '',
    position: '',
    leaveType: requireText(input.leaveType, '休假类型无效', 100),
    startAt,
    endAt,
    leaveHours: nonNegativeNumber(input.leaveHours, '休假工时无效'),
    approvalDayCount: nonNegativeNumber(
      input.approvalDayCount,
      '请休假审批天数无效',
    ),
    reason: String(input.reason || '')
      .trim()
      .slice(0, 2_000),
    substituteName: undefined,
    substituteOpenId: undefined,
    substitutePersonRecordId: undefined,
    substituteRequired: false,
    substituteCandidates: [],
    shiftGroups: input.shiftGroups || [],
  };
}

function enrichSnapshot(
  initial: LeaveWorkflowSnapshot,
  fields: Record<string, unknown>,
  directory: ActivePersonnelDirectory,
): LeaveWorkflowSnapshot {
  const applicantName =
    firstFieldText(fields, [
      '休假人员姓名（程序）',
      '休假人员',
      '请休假人员',
    ]) || initial.applicantName;
  const matchedPeople = selectablePersonnel(directory).filter(
    (person) => normalizeName(person.name) === normalizeName(applicantName),
  );
  if (matchedPeople.length !== 1) {
    throw new BadRequestException('请休假人员无法从本地人员目录唯一匹配');
  }
  const startAt =
    firstFieldDateTime(fields, ['休假开始时间']) || initial.startAt;
  const endAt = firstFieldDateTime(fields, ['休假结束时间']) || initial.endAt;
  const leaveHours = firstNumber(
    fields,
    ['休假工时数（最低4h）', '休假工时数'],
    initial.leaveHours,
  );
  const approvalDayCount = firstNumber(
    fields,
    ['休假天数'],
    initial.approvalDayCount,
  );
  const building =
    normalizeLeaveBuilding(matchedPeople[0].buildings[0]) ||
    normalizeLeaveBuilding(
      firstFieldText(fields, ['机楼', '所属楼栋', '楼栋']),
    ) ||
    normalizeLeaveBuilding(initial.building);
  return {
    ...initial,
    applicantName: matchedPeople[0].name,
    applicantOpenId: matchedPeople[0].openId,
    applicantPersonRecordId: matchedPeople[0].recordId,
    building,
    position: matchedPeople[0].position || initial.position,
    startAt: requireDateTime(startAt, '请休假开始时间无效'),
    endAt: requireDateTime(endAt, '请休假结束时间无效'),
    leaveHours: nonNegativeNumber(leaveHours, '休假工时无效'),
    approvalDayCount: nonNegativeNumber(approvalDayCount, '请休假审批天数无效'),
    substituteName:
      firstFieldText(fields, [
        '替班人员（填姓名）',
        '替班人员（请假表）',
        '替班人员',
        '替班人',
      ]) || initial.substituteName,
  };
}

function resolveApplicant(
  snapshot: LeaveWorkflowSnapshot,
  directory: ActivePersonnelDirectory,
  records: LeaveOrganizationRecord[],
): LeaveRoutePerson {
  const person = directory.personnel.find(
    (candidate) => candidate.openId === snapshot.applicantOpenId,
  );
  const selectable = selectablePersonnel(directory).find(
    (candidate) => candidate.recordId === snapshot.applicantPersonRecordId,
  );
  const resolved = selectable || person;
  if (!resolved)
    throw new BadRequestException('请休假申请人不在本地在职人员目录中');
  const organization = records.find(
    (record) =>
      record.personRecordId === resolved.recordId ||
      (resolved.openId && record.openId === resolved.openId),
  );
  return {
    personRecordId: resolved.recordId,
    name: resolved.name,
    openId: resolved.openId,
    position: resolved.position || organization?.position || '',
    buildings: resolved.buildings.length
      ? normalizeDirectoryBuildings(resolved.buildings)
      : organization?.buildings || [],
  };
}

function mergeOrganizationRecords(
  source: LeaveOrganizationRecord[],
  directory: ActivePersonnelDirectory,
): LeaveOrganizationRecord[] {
  const result = new Map<string, LeaveOrganizationRecord>();
  for (const item of source) {
    if (!item.openId) continue;
    result.set(`open:${item.openId}`, {
      ...item,
      buildings: [...new Set(item.buildings || [])],
      supervisorNames: [...new Set(item.supervisorNames || [])],
    });
  }
  for (const person of selectablePersonnel(directory)) {
    const openKey = person.openId ? `open:${person.openId}` : '';
    const current = openKey ? result.get(openKey) : undefined;
    const value: LeaveOrganizationRecord = {
      personRecordId: person.recordId,
      name: person.name || current?.name || '',
      openId: person.openId,
      position: person.position || current?.position || '',
      buildings: person.buildings.length
        ? normalizeDirectoryBuildings(person.buildings)
        : current?.buildings || [],
      supervisorNames: [...person.supervisorNames],
    };
    if (openKey) result.delete(openKey);
    result.set(`record:${person.recordId}`, value);
  }
  return [...result.values()];
}

function readManagerEscalationApprovers(
  directory: ActivePersonnelDirectory,
): LeaveRoutePerson[] {
  const openIds = String(
    process.env.LEAVE_WORKFLOW_MANAGER_ESCALATION_APPROVER_OPEN_IDS || '',
  )
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^ou_[A-Za-z0-9_-]{1,124}$/u.test(item));
  return uniquePeople(
    directory.personnel
      .filter((person) => openIds.includes(person.openId))
      .map((person) => ({
        name: person.name,
        openId: person.openId,
        position: person.position,
        buildings: normalizeDirectoryBuildings(person.buildings),
      })),
  );
}

function resolveSubstituteRecipients(
  snapshot: LeaveWorkflowSnapshot,
  directory: ActivePersonnelDirectory,
): LeaveRoutePerson[] {
  if (!snapshot.substituteName) return [];
  return uniquePeople(
    directory.personnel
      .filter(
        (person) =>
          normalizeName(person.name) === normalizeName(snapshot.substituteName),
      )
      .map((person) => ({
        name: person.name,
        openId: person.openId,
        position: person.position,
        buildings: normalizeDirectoryBuildings(person.buildings),
      })),
  );
}

function resolveSubstituteUpdateNotificationRecipients(
  application: LeaveWorkflowApplicationEntry,
  update: SubstituteChangeDetails,
  directory: ActivePersonnelDirectory,
  stakeholders?: LeaveRoutePerson[],
): Array<{
  openId: string;
  audience: 'previous_substitute' | 'new_substitute' | 'stakeholder';
}> {
  const recipients = new Map<
    string,
    'previous_substitute' | 'new_substitute' | 'stakeholder'
  >();
  const add = (
    openId: string,
    audience: 'previous_substitute' | 'new_substitute' | 'stakeholder',
  ) => {
    const normalized = String(openId || '').trim();
    if (!/^ou_[A-Za-z0-9_-]{1,124}$/u.test(normalized)) return;
    if (!recipients.has(normalized)) recipients.set(normalized, audience);
  };

  add(update.previousSubstituteOpenId, 'previous_substitute');
  add(update.substituteOpenId, 'new_substitute');
  const previousByShiftKey = new Map(
    update.previousShiftAssignments.map(
      (assignment) => [assignment.shiftKey, assignment] as const,
    ),
  );
  const currentByShiftKey = new Map(
    update.shiftAssignments.map(
      (assignment) => [assignment.shiftKey, assignment] as const,
    ),
  );
  const currentPeople = new Set(update.shiftAssignments.flatMap((assignment) => [assignment.substituteOpenId, ...(assignment.originalPostBackfills || []).map((backup) => backup.substituteOpenId)]));
  for (const shiftKey of new Set([
    ...previousByShiftKey.keys(),
    ...currentByShiftKey.keys(),
  ])) {
    const previous = previousByShiftKey.get(shiftKey);
    const current = currentByShiftKey.get(shiftKey);
    if (previous?.substitutePersonRecordId !== current?.substitutePersonRecordId) {
      if (previous && !currentPeople.has(previous.substituteOpenId)) add(previous.substituteOpenId, 'previous_substitute');
      if (current) add(current.substituteOpenId, 'new_substitute');
    }
    const originalKey = (backup: NonNullable<LeaveShiftSubstituteAssignment['originalPostBackfills']>[number]) => JSON.stringify([backup.group.shiftKey, [...backup.group.scheduleRecordIds].sort()]);
    const previousBackups = new Map((previous?.originalPostBackfills || []).map((backup) => [originalKey(backup), backup]));
    const currentBackups = new Map((current?.originalPostBackfills || []).map((backup) => [originalKey(backup), backup]));
    for (const key of new Set([...previousBackups.keys(), ...currentBackups.keys()])) {
      const oldBackup = previousBackups.get(key), newBackup = currentBackups.get(key);
      if (oldBackup?.substitutePersonRecordId === newBackup?.substitutePersonRecordId) continue;
      if (oldBackup && !currentPeople.has(oldBackup.substituteOpenId)) add(oldBackup.substituteOpenId, 'previous_substitute');
      if (newBackup) add(newBackup.substituteOpenId, 'new_substitute');
    }
  }

  if (
    normalizeLeaveBuilding(application.snapshot.building) === '110站' &&
    update.previousShiftAssignments.length === 0 &&
    update.shiftAssignments.length === 0 &&
    (!update.previousSubstituteOpenId || !update.substituteOpenId)
  ) {
    for (const openId of resolveShared110DutyAccountOpenIds(directory)) {
      add(
        openId,
        update.previousSubstituteOpenId
          ? 'new_substitute'
          : 'previous_substitute',
      );
    }
  }

  add(application.snapshot.applicantOpenId, 'stakeholder');
  for (const openId of application.snapshot.applicantNotificationOpenIds) {
    add(openId, 'stakeholder');
  }
  for (const stage of stakeholders ? [] : application.approvalPlan?.stages || []) {
    for (const approver of stage.approvers) {
      add(approver.openId, 'stakeholder');
    }
  }
  for (const recipient of stakeholders ?? application.resultRecipients) {
    add(recipient.openId, 'stakeholder');
  }

  return [...recipients].map(([openId, audience]) => ({ openId, audience }));
}

function hasSubstituteChange(change: SubstituteChangeDetails): boolean {
  if (
    shiftAssignmentSignature(change.previousShiftAssignments) !==
    shiftAssignmentSignature(change.shiftAssignments)
  ) {
    return (
      change.previousShiftAssignments.length > 0 ||
      change.shiftAssignments.length > 0
    );
  }
  const previousRecordId = String(
    change.previousSubstitutePersonRecordId || '',
  ).trim();
  const substituteRecordId = String(
    change.substitutePersonRecordId || '',
  ).trim();
  if (!previousRecordId || !substituteRecordId) return false;
  return previousRecordId !== substituteRecordId;
}

function buildShiftChangeSummary(change: SubstituteChangeDetails): string {
  const previousByShiftKey = new Map(
    change.previousShiftAssignments.map(
      (assignment) => [assignment.shiftKey, assignment] as const,
    ),
  );
  return change.shiftAssignments
    .sort((left, right) => left.shiftKey.localeCompare(right.shiftKey))
    .flatMap((assignment) => {
      const previous = previousByShiftKey.get(assignment.shiftKey);
      const lines = previous?.substitutePersonRecordId !== assignment.substitutePersonRecordId ? [`${assignment.scheduleDate} ${assignment.shift}：${
        previous?.substituteName || '未安排'
      } → ${assignment.substituteName}`] : [];
      const key = (backup: NonNullable<LeaveShiftSubstituteAssignment['originalPostBackfills']>[number]) => JSON.stringify([backup.group.shiftKey, [...backup.group.scheduleRecordIds].sort()]);
      const oldBackups = new Map((previous?.originalPostBackfills || []).map((backup) => [key(backup), backup]));
      const newBackups = new Map((assignment.originalPostBackfills || []).map((backup) => [key(backup), backup]));
      for (const postKey of new Set([...oldBackups.keys(), ...newBackups.keys()])) {
        const oldBackup = oldBackups.get(postKey), newBackup = newBackups.get(postKey);
        if (oldBackup?.substitutePersonRecordId === newBackup?.substitutePersonRecordId) continue;
        const post = (newBackup || oldBackup)!.group;
        lines.push(`原岗补位 ${post.buildings.join('、')} ${post.scheduleDate} ${post.shift}：${oldBackup?.substituteName || '未安排'} → ${newBackup?.substituteName || '已恢复原岗'}`);
      }
      return lines;
    })
    .join('\n');
}

function resolveShared110DutyAccountOpenIds(
  directory: ActivePersonnelDirectory,
): string[] {
  return [
    ...new Set(
      selectablePersonnel(directory)
        .filter(
          (person) =>
            normalizeName(person.name) ===
            normalizeName('南通基地-110kV变电站值班'),
        )
        .map((person) => person.openId)
        .filter(Boolean),
    ),
  ];
}

function selectablePersonnel(directory: ActivePersonnelDirectory) {
  return directory.selectablePersonnel || directory.personnel;
}

function uniqueSubstituteCandidates(
  candidates: LeaveSubstituteCandidate[],
): LeaveSubstituteCandidate[] {
  const result = new Map<string, LeaveSubstituteCandidate>();
  for (const candidate of candidates) {
    const personRecordId = String(candidate.personRecordId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,100}$/u.test(personRecordId)) continue;
    if (!result.has(personRecordId)) {
      result.set(personRecordId, { ...candidate, personRecordId });
    }
  }
  return [...result.values()];
}

function resolveApplicantNotificationOpenIds(
  snapshot: LeaveWorkflowSnapshot,
  applicant: LeaveRoutePerson,
  directory: ActivePersonnelDirectory,
): string[] {
  if (applicant.openId) return [];
  if (normalizeLeaveBuilding(snapshot.building) !== '110站') return [];
  const sharedOpenIds = [
    ...new Set(
      selectablePersonnel(directory)
        .filter(
          (person) =>
            normalizeName(person.name) ===
            normalizeName('南通基地-110kV变电站值班'),
        )
        .map((person) => person.openId)
        .filter(Boolean),
    ),
  ];
  return sharedOpenIds.length === 1 ? sharedOpenIds : [];
}

function applyRecordSupervisorRouting(
  records: LeaveOrganizationRecord[],
  applicant: LeaveRoutePerson,
  fields: Record<string, unknown>,
  directory: ActivePersonnelDirectory,
): LeaveOrganizationRecord[] {
  const rawSupervisor = firstFieldText(fields, ['主管', '对应主管']);
  if (!rawSupervisor) return records;
  const normalizedRaw = normalizeName(rawSupervisor);
  const supervisorNames = [
    ...new Set(
      directory.personnel
        .filter(
          (person) =>
            Boolean(person.openId) &&
            normalizedRaw.includes(normalizeName(person.name)),
        )
        .map((person) => person.name),
    ),
  ];
  if (supervisorNames.length === 0) return records;
  let matched = false;
  const updated = records.map((record) => {
    const sameApplicant =
      (applicant.personRecordId &&
        record.personRecordId === applicant.personRecordId) ||
      (applicant.openId && record.openId === applicant.openId) ||
      normalizeName(record.name) === normalizeName(applicant.name);
    if (!sameApplicant) return record;
    matched = true;
    return { ...record, supervisorNames };
  });
  return matched ? updated : [...updated, { ...applicant, supervisorNames }];
}

function resolvePeopleByOpenIds(
  openIds: string[],
  directory: ActivePersonnelDirectory,
): LeaveRoutePerson[] {
  const wanted = new Set(openIds);
  return uniquePeople(
    directory.personnel
      .filter((person) => wanted.has(person.openId))
      .map((person) => ({
        personRecordId: person.recordId,
        name: person.name,
        openId: person.openId,
        position: person.position,
        buildings: normalizeDirectoryBuildings(person.buildings),
      })),
  );
}

function normalizeDirectoryBuildings(values: string[]): string[] {
  return [
    ...new Set(
      (values || [])
        .map((building) => normalizeLeaveBuilding(building))
        .filter(Boolean),
    ),
  ];
}

function assertNotificationAccountsCannotApprove(
  snapshot: LeaveWorkflowSnapshot,
  stage: { approvers: LeaveRoutePerson[] },
): void {
  const notificationOpenIds = new Set(
    snapshot.applicantNotificationOpenIds || [],
  );
  if (
    stage.approvers.some((approver) => notificationOpenIds.has(approver.openId))
  ) {
    throw new BadRequestException('110值班共享通知账号不能作为请休假审批人');
  }
}

function toCardContext(
  application: LeaveWorkflowApplicationEntry,
  stageKey: 'supervisor' | 'manager',
  stageVersion: number,
): LeaveCardContext {
  return {
    recordId: application.recordId,
    applicationKey: application.key,
    stageKey,
    stageVersion,
    applicantName: application.snapshot.applicantName,
    building: normalizeLeaveBuilding(application.snapshot.building),
    position: application.snapshot.position,
    leaveType: application.snapshot.leaveType,
    startAt: application.snapshot.startAt,
    endAt: application.snapshot.endAt,
    leaveHours: application.snapshot.leaveHours,
    approvalDayCount: application.snapshot.approvalDayCount,
    reason: application.snapshot.reason,
    screenshotImageKeys: application.snapshot.screenshotImageKeys,
    screenshotStatus: application.snapshot.screenshotStatus,
    substituteName: application.snapshot.substituteName,
    substituteRequired: application.snapshot.substituteRequired,
    substituteDecisionRequired:
      application.snapshot.substituteDecisionRequired === true &&
      application.snapshot.substituteDecisionMade !== true,
    substituteCandidates: application.snapshot.substituteCandidates,
    shiftGroups: application.snapshot.shiftGroups,
    candidateSets: application.snapshot.candidateSets,
    shiftAssignments: application.snapshot.shiftAssignments,
    assignmentRevision: application.snapshot.assignmentRevision,
  };
}

function substituteFields(
  action: LeaveWorkflowActionEntry,
): Record<string, string | boolean> {
  if (action.shiftAssignments.length) {
    return {
      '是否需要替班（替班打√）': true,
      '替班人员（填姓名）': buildShiftSubstituteNames(action.shiftAssignments),
      替班安排: buildShiftAssignmentSummary(action.shiftAssignments),
    };
  }
  return action.substituteName
    ? {
        '是否需要替班（替班打√）': true,
        '替班人员（填姓名）': action.substituteName,
      }
    : {
        '是否需要替班（替班打√）': false,
        '替班人员（填姓名）': '',
        替班安排: '',
      };
}

function restoreOwnShiftCoverage(snapshot: LeaveWorkflowSnapshot, schedules: LeaveRequestImpactSchedule[]): LeaveRequestImpactSchedule[] {
  const rows = schedules.map((row) => ({ ...row, dutyStaffActual: [...row.dutyStaffActual] }));
  const moves = new Map<string, Array<{ removed: string; restored: string }>>();
  const add = (ids: string[], removed: string, restored: string) => {
    for (const id of ids) {
      const list = moves.get(id) || [];
      if (!list.some((move) => move.removed === removed && move.restored === restored)) list.push({ removed, restored });
      moves.set(id, list);
    }
  };
  for (const assignment of snapshot.shiftAssignments || []) {
    add(assignment.scheduleRecordIds, assignment.substituteName, snapshot.applicantName);
    for (const backup of assignment.originalPostBackfills || []) add(backup.group.scheduleRecordIds, backup.substituteName, assignment.substituteName);
  }
  for (const [recordId, sourceMoves] of moves) {
    const row = rows.find((item) => item.recordId === recordId);
    if (!row) throw new ServiceUnavailableException('原岗排班已变化，请重新核对');
    const pending = [...sourceMoves];
    while (pending.length) {
      const index = pending.findIndex((move) => row.dutyStaffActual.some((name) => containsExactPersonName(name, move.removed) || containsExactPersonName(name, move.restored)));
      if (index < 0) throw new ServiceUnavailableException('原岗人员已变化，请重新核对');
      const [move] = pending.splice(index, 1);
      const removedPresent = row.dutyStaffActual.some((name) => containsExactPersonName(name, move.removed));
      const restoredPresent = row.dutyStaffActual.some((name) => containsExactPersonName(name, move.restored));
      if (removedPresent && restoredPresent) throw new ServiceUnavailableException('原岗人员重复，请重新核对');
      if (removedPresent) row.dutyStaffActual = [
        ...row.dutyStaffActual.flatMap((name) => !containsExactPersonName(name, move.removed) ? [name] : normalizeName(name) === normalizeName(move.removed) ? [] : name.split(/[\s、,，;；/]+/u).filter((part) => normalizeName(part) !== normalizeName(move.removed))),
        move.restored,
      ];
    }
  }
  return rows;
}

export function buildShiftAssignmentSummary(
  assignments: LeaveShiftSubstituteAssignment[],
): string {
  return [...assignments]
    .sort((left, right) => left.shiftKey.localeCompare(right.shiftKey))
    .map(
      (item) =>
        `${item.scheduleDate} ${item.shift} ${item.startAt.slice(11)}–${item.endAt.slice(11)}：${item.substituteName}${(item.originalPostBackfills || []).map((backup) => `\n原岗补位 ${backup.group.buildings.join('、')} ${backup.group.scheduleDate} ${backup.group.shift} ${backup.group.startAt.slice(11)}–${backup.group.endAt.slice(11)}：${backup.substituteName}`).join('')}`,
    )
    .join('\n');
}

function buildShiftSubstituteNames(
  assignments: LeaveShiftSubstituteAssignment[],
): string {
  return [
    ...new Set(
      [...assignments]
        .sort((left, right) => left.shiftKey.localeCompare(right.shiftKey))
        .map((assignment) => assignment.substituteName)
        .filter(Boolean),
    ),
  ].join('、');
}

function shiftGroupSignature(groups: LeaveRequestShiftGroup[]): string {
  return JSON.stringify(
    [...groups]
      .sort((left, right) => left.shiftKey.localeCompare(right.shiftKey))
      .map((group) => ({
        shiftKey: group.shiftKey,
        scheduleRecordIds: [...group.scheduleRecordIds].sort(),
      })),
  );
}

function shiftAssignmentSignature(
  assignments: LeaveShiftSubstituteAssignment[],
): string {
  return JSON.stringify(
    [...assignments]
      .sort((left, right) => left.shiftKey.localeCompare(right.shiftKey))
      .map((assignment) => ({
        shiftKey: assignment.shiftKey,
        substitutePersonRecordId: assignment.substitutePersonRecordId,
        originalPostBackfills: assignment.originalPostBackfills || [],
      })),
  );
}

function approvedFields(
  action: LeaveWorkflowActionEntry,
): Record<string, unknown> {
  return {
    审批来源: '程序卡片',
    请假工作流状态: '已审批',
    请假当前审批人: [],
    请假实际审批人: [{ id: action.actorOpenId }],
    请假审批时间: Date.parse(action.createdAt),
    请假审批策略版本: readPolicyVersion(),
    请假工作流错误: '',
  };
}

function rejectedFields(
  action: LeaveWorkflowActionEntry,
): Record<string, unknown> {
  return {
    审批来源: '程序卡片',
    请假工作流状态: '已驳回',
    请假当前审批人: [],
    请假实际审批人: [{ id: action.actorOpenId }],
    请假审批时间: Date.parse(action.createdAt),
    请假审批策略版本: readPolicyVersion(),
    请假驳回原因: action.rejectionReason,
    请假工作流错误: '',
  };
}

function firstFieldText(
  fields: Record<string, unknown>,
  names: string[],
): string {
  for (const name of names) {
    const result = extractDisplayText(fields[name], ' ').trim();
    if (result) return result;
  }
  return '';
}

function normalizeLeaveBuilding(value: unknown): string {
  const normalized = String(value || '')
    .replace(/\s+/gu, '')
    .toUpperCase();
  const building = /^(A|B|C|D|E|H)(?:楼)?$/u.exec(normalized);
  if (building) return `${building[1]}楼`;
  return /^110(?:站)?$/u.test(normalized) ? '110站' : '';
}

function is110StationChiefSnapshot(snapshot: LeaveWorkflowSnapshot): boolean {
  return (
    normalizeLeaveBuilding(snapshot.building) === '110站' &&
    normalizeName(snapshot.position).replace(/\s+/gu, '') === '110站站长'
  );
}

function firstFieldDateTime(
  fields: Record<string, unknown>,
  names: string[],
): string {
  for (const name of names) {
    const result = extractDateTimeIso(fields[name]);
    if (result) return result;
  }
  return '';
}

function firstNumber(
  fields: Record<string, unknown>,
  names: string[],
  fallback: number,
): number {
  for (const name of names) {
    const values = extractDisplayValues(fields[name]);
    const value = Number(values[0]);
    if (Number.isFinite(value)) return value;
    if (typeof fields[name] === 'number' && Number.isFinite(fields[name])) {
      return fields[name] as number;
    }
  }
  return fallback;
}

function uniqueRecordIds(values: string[]): string[] {
  return [
    ...new Set(
      (values || [])
        .map((value) => String(value || '').trim())
        .filter((value) => /^[A-Za-z0-9_-]{1,100}$/u.test(value)),
    ),
  ];
}

function uniquePeople(people: LeaveRoutePerson[]): LeaveRoutePerson[] {
  const result = new Map<string, LeaveRoutePerson>();
  for (const person of people || []) {
    const openId = String(person?.openId || '').trim();
    if (!/^ou_[A-Za-z0-9_-]{1,124}$/u.test(openId) || result.has(openId))
      continue;
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

function readPolicyVersion(): string {
  return (
    String(process.env.LEAVE_WORKFLOW_POLICY_VERSION || POLICY_VERSION)
      .trim()
      .slice(0, 100) || POLICY_VERSION
  );
}

function readBooleanEnv(name: string, defaultValue = false): boolean {
  const value = String(process.env[name] || '').trim();
  if (!value) return defaultValue;
  if (/^(0|false|no|off)$/iu.test(value)) return false;
  return /^(1|true|yes|on)$/iu.test(value);
}

function readCsvEnv(name: string): string[] {
  return String(process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function uniqueLeaveCodes(values: string[]): string[] {
  return [
    ...new Set(
      (values || [])
        .map((value) => String(value || '').trim())
        .filter((value) => value.length > 0 && value.length <= 100),
    ),
  ].slice(0, 20);
}

function calendarDayCount(startAt: string, endAt: string): number {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
  return Math.max(1, Math.floor((end - start) / 86_400_000) + 1);
}

function isTerminalRecoveryStatus(value: string): boolean {
  return /^(?:已审批|已驳回|审批结束|已完成)$/u.test(
    String(value || '').trim(),
  );
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

function requireDateTime(value: unknown, message: string): string {
  const result = String(value || '').trim();
  if (!result || !Number.isFinite(Date.parse(result)))
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
  const result = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(result.getTime()))
    throw new BadRequestException('请休假工作流时间无效');
  return result;
}

function adjacentDateRange(
  startAt: string,
  endAt: string,
): { startDate: string; endDate: string } {
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new BadRequestException('请休假时间无效');
  }
  start.setUTCDate(start.getUTCDate() - 1);
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function toShanghaiWallClock(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new BadRequestException('请休假时间无效');
  }
  return new Date(timestamp + 8 * 60 * 60 * 1_000).toISOString().slice(0, 16);
}

function normalizeName(value: string): string {
  return String(value || '')
    .replace(/\s+/gu, '')
    .trim();
}

function safeError(error: unknown): string {
  const text =
    error instanceof Error ? error.message : String(error || 'unknown error');
  return text
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, '$1 [redacted]')
    .replace(/\b(secret|token|password)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/[\r\n\t]/gu, ' ')
    .slice(0, 500);
}
