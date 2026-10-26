import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  OvertimeRequestCreateRequest,
  OvertimeRequestCreateResponse,
} from '@shared/api.interface';
import {
  addOvertimePayableHours,
  calculateOvertimePayableHours,
} from '@shared/overtime-request-impact';
import type {
  ActivePersonnelDirectory,
  ActivePersonnelDirectoryEntry,
} from '../bitable-sync/active-personnel-directory';
import { BitableSyncService } from '../bitable-sync/bitable-sync.service';
import { readEnv } from '../../common/config/external-services.config';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { feishuIdentityFingerprint } from '../../common/access/feishu-access-approved-grants';
import {
  buildOvertimeApprovalCard,
  buildOvertimeApprovalResolvedCard,
  buildOvertimeApprovalHandoverCard,
  buildOvertimeConfirmationCard,
  buildOvertimeConfirmationHandoverCard,
  buildOvertimeConfirmationResolvedCard,
  buildOvertimeSourceDeletedCard,
} from './overtime-workflow.card';
import { OvertimeWorkflowGateway } from './overtime-workflow.gateway';
import {
  resolveOvertimeApprovalRoute,
  overtimeApprovalDuty,
  resolveOvertimeProfessionalRecipients,
  resolveCurrentOvertimeNotificationRecipients,
} from './overtime-workflow.rules';
import {
  initialOvertimeConfirmationBusinessKey,
  overtimeConfirmationOwner,
  overtimeConfirmationGeneration,
  OvertimeWorkflowStore,
  stableOvertimeMessageUuid,
  type OvertimeConfirmationDisposition,
  type OvertimeWorkflowApplicationEntry,
  type OvertimeWorkflowMessageDelivery,
  type OvertimeWorkflowMessageIntent,
  type OvertimeWorkflowTaskEntry,
} from './overtime-workflow.store';
import type {
  OvertimeApplicationSnapshot,
  OvertimeOrganizationRecord,
  OvertimeRoutePerson,
} from './overtime-workflow.types';

const MAX_TASKS_PER_RUN = 25;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const FEISHU_MESSAGE_DEDUPE_WINDOW_MS = HOUR_MS;
// Covers the 10 s tenant-token request and 15 s message request, plus 5 s drift.
const FEISHU_MESSAGE_SEND_SAFETY_MARGIN_MS = 30_000;
const FEISHU_MESSAGE_SAFE_RETRY_AGE_MS =
  FEISHU_MESSAGE_DEDUPE_WINDOW_MS - FEISHU_MESSAGE_SEND_SAFETY_MARGIN_MS;
const MANAGER_POSITIONS = new Set(['设施运维经理', '设施运维副经理']);
const CONTINUOUS_RETRY = Number.POSITIVE_INFINITY;

export type OvertimeConfirmationDispositionApi =
  | 'compensatory_leave'
  | 'overtime_pay';

export interface OvertimeConfirmationDetail {
  recordId: string;
  staffName: string;
  building: string;
  position: string;
  plannedStartAt: string;
  plannedEndAt: string;
  plannedHours: number;
  actualStartAt: string | null;
  actualEndAt: string | null;
  actualHours: number | null;
  disposition: OvertimeConfirmationDispositionApi | null;
}

export interface OvertimeConfirmationSubmission {
  recordId: string;
  ticket: string;
  mutationId: string;
  actualStartAt: string;
  actualEndAt?: string;
  actualHours: number;
  disposition: OvertimeConfirmationDispositionApi | null;
}

export interface OvertimeApprovalActionAcceptanceInput {
  eventId: string;
  recordId: string;
  action: 'approve' | 'reject';
  actorOpenId: string;
  actorName?: string;
  messageId: string;
}

@Injectable()
export class OvertimeWorkflowService {
  private readonly logger = new Logger(OvertimeWorkflowService.name);
  private readonly refreshedPendingConfirmationCardRecords = new Set<string>();

  constructor(
    private readonly store: OvertimeWorkflowStore,
    private readonly gateway: OvertimeWorkflowGateway,
    private readonly bitableSyncService: BitableSyncService,
    @Inject(AccessConfigurationService)
    private readonly accessConfiguration?: AccessConfigurationService,
  ) {}

  isEnabled(): boolean {
    return isOvertimeWorkflowEnabled();
  }

  async refreshPendingConfirmationCards(): Promise<{
    refreshed: number;
    failed: number;
  }> {
    this.assertEnabled();
    const applications = await this.store.listApplications();
    let refreshed = 0;
    let failed = 0;

    for (const application of applications) {
      if (application.phase === 'source_deleted') {
        const result = await this.refreshSourceDeletedCards(application);
        refreshed += result.refreshed;
        failed += result.failed;
        continue;
      }
      if (
        application.phase !== 'awaiting_confirmation' ||
        !application.actualApproverOpenId ||
        this.refreshedPendingConfirmationCardRecords.has(application.recordId)
      ) {
        continue;
      }

      try {
        const retired = await this.retireIfSourceMissing(
          application.recordId,
          new Date(),
        );
        if (retired) {
          const result = await this.refreshSourceDeletedCards(retired);
          refreshed += result.refreshed;
          failed += result.failed;
          continue;
        }
      } catch (error) {
        failed += Math.max(1, application.confirmationCards.length);
        this.logger.warn(
          `待确认加班源记录校验失败 ${application.recordId}: ${safeWorkflowError(error)}`,
        );
        continue;
      }

      const messageIds = unique(
        application.confirmationCards.map((entry) => entry.messageId),
      );
      if (messageIds.length === 0) {
        this.refreshedPendingConfirmationCardRecords.add(application.recordId);
        continue;
      }

      let card: Record<string, unknown>;
      try {
        const ticket = this.gateway.issueConfirmationTicket({
          recordId: application.recordId,
          approverOpenId: overtimeConfirmationOwner(application),
          ...(overtimeConfirmationGeneration(application) > 1 ? { confirmationGeneration: overtimeConfirmationGeneration(application) } : {}),
        });
        const confirmationUrl = this.gateway.buildConfirmationUrl(
          application.recordId,
          ticket,
        );
        card = buildOvertimeConfirmationCard(
          application.snapshot,
          confirmationUrl,
        );
      } catch (error) {
        failed += messageIds.length;
        this.logger.warn(
          `待确认加班卡片换链失败 ${application.recordId}: ${safeWorkflowError(error)}`,
        );
        continue;
      }

      let applicationFailed = false;
      for (const messageId of messageIds) {
        try {
          await this.gateway.patchInteractiveCard(messageId, card);
          refreshed += 1;
        } catch (error) {
          applicationFailed = true;
          failed += 1;
          this.logger.warn(
            `待确认加班卡片换链失败 ${application.recordId}/${messageId}: ${safeWorkflowError(error)}`,
          );
        }
      }
      if (!applicationFailed) {
        this.refreshedPendingConfirmationCardRecords.add(application.recordId);
      }
    }

    return { refreshed, failed };
  }

  async acceptApplication(input: {
    request: OvertimeRequestCreateRequest;
    result: OvertimeRequestCreateResponse;
  }): Promise<{ created: boolean }> {
    this.assertEnabled();
    const snapshot = mapAcceptanceToSnapshot(input);
    const clientMutationId = requireText(
      input.result?.clientMutationId || input.request?.clientMutationId,
      '加班申请 clientMutationId 无效',
      128,
    );
    const accepted = await this.store.acceptApplication({
      clientMutationId,
      snapshot,
    });
    return { created: accepted.created };
  }

  async acceptApprovalAction(
    input: OvertimeApprovalActionAcceptanceInput,
  ): Promise<{ claimed: boolean; card: Record<string, unknown> }> {
    this.assertEnabled();
    if (!this.canActorContinue(input.actorOpenId) && !(await this.store.getApprovalAction(input.recordId))) {
      throw new ForbiddenException('当前人员不可办理');
    }
    const claim = typeof this.accessConfiguration?.currentDutyRoutePeople === 'function'
      ? await this.store.claimApprovalAction(input,new Date(),(application,actorOpenId)=>this.currentDutyAllows(application,actorOpenId))
      : await this.store.claimApprovalAction(input);
    const application = await this.requireApplication(input.recordId);
    return {
      claimed: claim.claimed,
      card: buildOvertimeApprovalResolvedCard(application.snapshot, {
        action: claim.entry.action,
        actorName: claim.entry.actorName || application.actualApproverName,
        resolvedAt: formatShanghaiDisplay(new Date(claim.entry.createdAt)),
      }),
    };
  }

  async runPendingTasks(
    now: Date | number = new Date(),
    limit = MAX_TASKS_PER_RUN,
  ): Promise<{ processed: number; failed: number }> {
    this.assertEnabled();
    const timestamp = resolveDate(now, '加班工作流执行时间无效');
    const normalizedLimit = Math.max(1, Math.min(Math.floor(limit), 100));
    let processed = 0;
    let failed = 0;
    for (let index = 0; index < normalizedLimit; index += 1) {
      const task = await this.store.takeNextTask(timestamp);
      if (!task) break;
      try {
        await this.processTask(task, timestamp);
        await this.store.completeTask(task.key, task.claimToken, timestamp);
        processed += 1;
      } catch (error) {
        failed += 1;
        await this.recordTaskFailure(task, error, timestamp);
        await this.store.rescheduleTask(
          task.key,
          task.claimToken,
          error,
          timestamp,
          CONTINUOUS_RETRY,
        );
        this.logger.warn(
          `加班工作流任务 ${task.kind}/${task.recordId} 执行失败，将按幂等键重试`,
        );
      }
    }
    return { processed, failed };
  }

  async enqueueDueConfirmationReminders(
    now: Date | number = new Date(),
  ): Promise<number> {
    this.assertEnabled();
    const timestamp = resolveDate(now, '加班确认扫描时间无效');
    const applications = await this.store.listApplications();
    let created = 0;
    for (const application of applications) {
      if (
        application.phase !== 'awaiting_confirmation' ||
        !overtimeConfirmationOwner(application)
      ) {
        continue;
      }
      const plannedEnd = resolveDate(
        application.snapshot.plannedEndAt,
        '加班计划结束时间无效',
      );
      const initialBusinessKey = overtimeConfirmationGeneration(application) > 1 ? `overtime:${application.recordId}:confirmation:initial:v${overtimeConfirmationGeneration(application)}` : initialOvertimeConfirmationBusinessKey(
        application.recordId,
      );
      if (
        plannedEnd.getTime() > timestamp.getTime() ||
        formatShanghaiCalendarDate(timestamp) <=
          formatShanghaiCalendarDate(plannedEnd) ||
        !application.confirmationCards.some(
          (entry) => entry.businessKey === initialBusinessKey,
        )
      ) {
        continue;
      }
      if (await this.retireIfSourceMissing(application.recordId, timestamp)) {
        continue;
      }
      const result = await this.store.enqueueDailyConfirmationReminder(
        application.recordId,
        overtimeConfirmationOwner(application),
        timestamp,
      );
      if (result.created) created += 1;
    }
    return created;
  }

  async getConfirmationDetail(
    recordId: string,
    ticket: string,
  ): Promise<OvertimeConfirmationDetail> {
    this.assertEnabled();
    const application = await this.requireConfirmationApplication(
      recordId,
      ticket,
    );
    const confirmation = await this.store.getConfirmation(application.recordId);
    const actualStart = confirmation
      ? resolveDate(confirmation.draft.actualStartAt, '实际加班开始时间无效')
      : null;
    const actualHours = confirmation?.draft.actualHours ?? null;
    return {
      recordId: application.recordId,
      staffName: application.snapshot.applicantName,
      building: application.snapshot.building,
      position: application.snapshot.position,
      plannedStartAt: application.snapshot.plannedStartAt,
      plannedEndAt: application.snapshot.plannedEndAt,
      plannedHours: application.snapshot.plannedHours,
      actualStartAt: actualStart ? formatShanghaiDateTime(actualStart) : null,
      actualEndAt:
        actualStart && confirmation
          ? formatShanghaiDateTime(
              resolveOvertimeActualEnd(
                actualStart,
                confirmation.draft.actualHours,
                confirmation.draft.actualEndAt,
              ),
            )
          : null,
      actualHours,
      disposition: confirmation
        ? mapDispositionToApi(confirmation.draft.disposition)
        : null,
    };
  }

  async submitConfirmation(input: OvertimeConfirmationSubmission): Promise<{
    accepted: true;
    recordId: string;
    mutationId: string;
    syncStatus: 'pending';
    actualStartAt: string;
    actualEndAt: string;
    actualHours: number;
    disposition: OvertimeConfirmationDispositionApi | null;
  }> {
    this.assertEnabled();
    const application = await this.requireConfirmationApplication(
      input.recordId,
      input.ticket,
      { allowConfirmedReplay: true },
    );
    const actualStart = requireWholeHour(input.actualStartAt);
    const actualHours = requireIntegerHours(input.actualHours);
    const actualEnd = resolveOvertimeActualEnd(
      actualStart,
      actualHours,
      input.actualEndAt,
    );
    const disposition = requireConfirmationDisposition(
      actualHours,
      input.disposition,
    );
    const mutationId = requireText(
      input.mutationId,
      '加班确认 mutationId 无效',
      128,
    );
    const normalizedStart = formatShanghaiDateTime(actualStart);
    const normalizedEnd = formatShanghaiDateTime(actualEnd);
    const confirmationOwner = overtimeConfirmationOwner(application);
    if (!this.canActorContinue(confirmationOwner)) {
      const existing = await this.store.getConfirmation(application.recordId);
      if (!existing || existing.actorOpenId !== confirmationOwner || existing.mutationId !== mutationId ||
          existing.draft.actualStartAt !== normalizedStart || existing.draft.actualHours !== actualHours ||
          existing.draft.disposition !== (disposition ? mapDispositionToBitable(disposition) : null) ||
          existing.draft.actualEndAt !== (input.actualEndAt !== undefined ? normalizedEnd : undefined)) {
        throw new ForbiddenException('当前人员不可办理');
      }
    }
    const confirmationInput = {
      mutationId,
      recordId: application.recordId,
      actorOpenId: confirmationOwner,
      ...(overtimeConfirmationGeneration(application) > 1 ? { confirmationGeneration: overtimeConfirmationGeneration(application) } : {}),
      draft: {
        actualStartAt: normalizedStart,
        ...(input.actualEndAt !== undefined
          ? { actualEndAt: normalizedEnd }
          : {}),
        actualHours,
        disposition: disposition ? mapDispositionToBitable(disposition) : null,
      },
    };
    if(typeof this.accessConfiguration?.currentDutyRoutePeople === 'function') await this.store.claimConfirmationSubmission(confirmationInput,new Date(),(current,actorOpenId)=>this.currentDutyAllows(current,actorOpenId));
    else await this.store.claimConfirmationSubmission(confirmationInput);
    return {
      accepted: true,
      recordId: application.recordId,
      mutationId,
      syncStatus: 'pending',
      actualStartAt: normalizedStart,
      actualEndAt: normalizedEnd,
      actualHours,
      disposition,
    };
  }

  private async processTask(
    task: OvertimeWorkflowTaskEntry,
    now: Date,
  ): Promise<void> {
    const application = await this.requireApplication(task.recordId);
    if (application.phase === 'source_deleted') return;
    if (await this.retireIfSourceMissing(task.recordId, now)) return;
    switch (task.kind) {
      case 'route_application':
        await this.routeApplication(task, now);
        return;
      case 'deliver_approval_cards':
        await this.deliverApprovalCards(task, now);
        return;
      case 'apply_approval':
        await this.applyApproval(task, now);
        return;
      case 'notify_managers':
        await this.syncApprovalResults(task, now);
        return;
      case 'deliver_confirmation':
        await this.deliverConfirmation(task, now);
        return;
      case 'apply_confirmation':
        await this.applyConfirmation(task, now);
        return;
      case 'sync_approval_handover':
        await this.syncApprovalHandover(task, now);
        return;
      case 'sync_confirmation_handover':
        await this.syncConfirmationHandover(task, now);
        return;
      default:
        throw new BadRequestException('未知的加班工作流后台任务');
    }
  }

  private async routeApplication(
    task: OvertimeWorkflowTaskEntry,
    now: Date,
  ): Promise<void> {
    const application = await this.requireApplication(task.recordId);
    if (application.phase !== 'pending_approval') return;
    await this.gateway.updateOvertimeRecord(application.recordId, {
      加班工作流状态: '待路由',
      加班工作流错误: '',
    });
    const [organizationRecords, directory] = await Promise.all([
      this.gateway.fetchOrganizationRoutingRecords(),
      this.bitableSyncService.getCachedActivePersonnelDirectory(),
    ]);
    const merged = completeOrganizationRecords(organizationRecords, directory);
    const applicant = resolveApplicant(application.snapshot, directory);
    const route = resolveOvertimeApprovalRoute({
      applicant,
      organizationRecords: merged,
      resolveDuty: (kind, fallback, target) => this.currentDutyPeople(kind, target) ?? fallback(),
    });
    const specialty = ['电气', '暖通', '弱电', '消防', 'EHS'].find(value => applicant.position.includes(value));
    const managerRecipients = (this.currentDutyPeople('overtime_manager', { building: applicant.buildings, ...(specialty ? { specialty } : {}) }) ?? resolveManagers(directory, merged)).filter(
      (entry) => entry.openId !== applicant.openId,
    );
    if (!managerRecipients.length) {
      throw new BadRequestException(
        '未找到可知会的机房经理，无法生成加班审批路由',
      );
    }
    const enrichedSnapshot: OvertimeApplicationSnapshot = {
      ...application.snapshot,
      applicantName: applicant.name,
      applicantOpenId: applicant.openId,
      building: applicant.buildings[0] || application.snapshot.building,
      position: applicant.position || application.snapshot.position,
    };
    await this.store.patchApplication(application.recordId, {
      snapshot: enrichedSnapshot,
      approvers: route.approvers,
      managerRecipients,
      professionalRecipients: resolveOvertimeProfessionalRecipients(
        applicant,
        merged,
        (kind, fallback, target) => this.currentDutyPeople(kind, target) ?? fallback(),
      ),
      lastError: '',
    });
    await this.gateway.updateOvertimeRecord(application.recordId, {
      加班工作流状态: '待审批',
      加班工作流错误: '',
    });
    await this.store.enqueueTask(
      {
        businessKey: `overtime:${application.recordId}:deliver-approval`,
        recordId: application.recordId,
        kind: 'deliver_approval_cards',
        payload: { routeKind: route.kind },
      },
      now,
    );
  }

  private currentDutyPeople(kind: 'overtime_supervisor' | 'overtime_manager' | 'professional_supervisor', target: { building: string[]; specialty?: string }) {
    const resolver = this.accessConfiguration?.currentDutyRoutePeople;
    return typeof resolver === 'function' ? resolver.call(this.accessConfiguration, kind, target) : null;
  }

  private currentNotificationRecipients(application: OvertimeWorkflowApplicationEntry, approved = true): OvertimeRoutePerson[] {
    const people = resolveCurrentOvertimeNotificationRecipients(application, (kind, target) => this.currentDutyPeople(kind, target), approved);
    return typeof this.accessConfiguration?.currentDutyRoutePeople === 'function' ? people.filter(person => person.openId === application.snapshot.applicantOpenId || this.canActorContinue(person.openId)) : people;
  }

  private currentDutyAllows(application: OvertimeWorkflowApplicationEntry, actorOpenId: string): boolean {
    if(!this.canActorContinue(actorOpenId))return false;
    const duty=overtimeApprovalDuty({position:application.snapshot.position,buildings:[application.snapshot.building]});
    const members=this.currentDutyPeople(duty.kind,duty.target);
    return members===null||members.some(person=>person.openId===actorOpenId);
  }

  private async deliverApprovalCards(
    task: OvertimeWorkflowTaskEntry,
    _now: Date,
  ): Promise<void> {
    let application = await this.requireApplication(task.recordId);
    const generation = application.approvalGeneration ?? 1;
    if (Number(task.payload.approvalGeneration ?? 1) !== generation) return;
    if (generation > 1) {
      const transfer = (await this.store.listTasks()).find(entry => entry.recordId === application.recordId && entry.kind === 'sync_approval_handover' && entry.payload.patchOnly !== true && entry.payload.targetGeneration === generation);
      if (!transfer || transfer.status !== 'completed') throw new ServiceUnavailableException('原审批卡片尚未完成交接，请稍后重试');
    }
    if (
      application.phase === 'rejected' ||
      application.phase === 'confirmed' ||
      application.phase === 'awaiting_confirmation'
    ) {
      return;
    }
    if (!application.approvers.length) {
      throw new BadRequestException('加班申请审批路由尚未生成');
    }
    await this.gateway.updateOvertimeRecord(application.recordId, {
      加班流程进展: '申请中',
      加班工作流状态: '待审批',
      加班工作流错误: '',
    });
    for (const approver of application.approvers) {
      const businessKey = `overtime:${application.recordId}:approval:${generation === 1 ? '' : `v${generation}:`}${approver.openId}`;
      if (
        application.approvalCards.some(
          (entry) => entry.businessKey === businessKey,
        )
      ) {
        continue;
      }
      const messageId = await this.gateway.sendInteractiveCard(
        approver.openId,
        buildOvertimeApprovalCard(application.snapshot),
        businessKey,
      );
      await this.store.recordApprovalCardDelivery(application.recordId, {
        recipientOpenId: approver.openId,
        messageId,
        businessKey,
      },generation);
      application = await this.requireApplication(task.recordId);
      if ((application.approvalGeneration ?? 1) !== generation) return;
    }
    await this.store.patchApplication(application.recordId, {
      phase: 'approval_pending',
      lastError: '',
    },{expectedRevision:application.revision});
  }

  private async syncApprovalHandover(task: OvertimeWorkflowTaskEntry, now: Date): Promise<void> {
    const payload = task.payload, sourceGeneration = Number(payload.sourceGeneration), targetGeneration = Number(payload.targetGeneration);
    const target = payload.target as Record<string,unknown> | undefined;
    const cards = payload.oldCards as OvertimeWorkflowMessageDelivery[];
    if (!Number.isSafeInteger(sourceGeneration) || sourceGeneration < 1 || targetGeneration !== sourceGeneration+1 ||
        typeof payload.mutationId !== 'string' || !/^handover-[a-f0-9]{64}$/u.test(payload.mutationId) ||
        typeof payload.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(payload.fingerprint) ||
        !target || typeof target.openId !== 'string' || !/^ou_[A-Za-z0-9_-]+$/u.test(target.openId) ||
        typeof target.personRecordId !== 'string' || !/^rec[A-Za-z0-9_]+$/u.test(target.personRecordId) ||
        !Array.isArray(cards) || cards.length > 100 || !cards.every(card => card && /^om_[A-Za-z0-9_-]+$/u.test(card.messageId) && /^ou_[A-Za-z0-9_-]+$/u.test(card.recipientOpenId)) ||
        (payload.patchOnly !== undefined && payload.patchOnly !== true)) throw new BadRequestException('加班审批交接任务无效');
    const patched = payload.patchedMessageIds;
    if (patched !== undefined && (!Array.isArray(patched) || !patched.every(id => typeof id === 'string' && cards.some(card => card.messageId === id)))) throw new BadRequestException('加班交接回执无效');
    const application = await this.requireApplication(task.recordId), terminal = buildOvertimeApprovalHandoverCard(application.snapshot);
    let currentTask = task;
    for (const card of cards) {
      if ((currentTask.payload.patchedMessageIds as string[] | undefined)?.includes(card.messageId)) continue;
      await this.gateway.patchInteractiveCard(card.messageId,terminal);
      currentTask = await this.store.recordApprovalHandoverCardPatch(task.key,task.claimToken,card.messageId);
    }
    if (payload.patchOnly === true) return;
    const current = await this.requireApplication(task.recordId);
    if ((current.approvalGeneration ?? 1) !== targetGeneration || current.phase !== 'approval_pending' || await this.store.getApprovalAction(task.recordId)) return;
    if (!current.approvers.some(person => person.openId === target.openId) || !this.canActorContinue(target.openId)) throw new ForbiddenException('接任人员业务权限已收回或审批路由已变化');
    await this.store.enqueueTask({businessKey:`overtime:${task.recordId}:deliver-approval:v${targetGeneration}`,recordId:task.recordId,kind:'deliver_approval_cards',payload:{approvalGeneration:targetGeneration}},now);
  }

  private async syncConfirmationHandover(task: OvertimeWorkflowTaskEntry, now: Date): Promise<void> {
    const payload = task.payload, sourceGeneration = Number(payload.sourceGeneration), targetGeneration = Number(payload.targetGeneration);
    const target = payload.target as Record<string, unknown> | undefined, cards = payload.oldCards as OvertimeWorkflowMessageDelivery[];
    if (!Number.isSafeInteger(sourceGeneration) || sourceGeneration < 1 || targetGeneration !== sourceGeneration + 1 ||
        typeof payload.mutationId !== 'string' || !/^handover-[a-f0-9]{64}$/u.test(payload.mutationId) ||
        typeof payload.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(payload.fingerprint) ||
        !target || typeof target.openId !== 'string' || !/^ou_[A-Za-z0-9_-]+$/u.test(target.openId) ||
        typeof target.personRecordId !== 'string' || !/^rec[A-Za-z0-9_]+$/u.test(target.personRecordId) ||
        !Array.isArray(cards) || cards.length > 100 || !cards.every(card => card && /^om_[A-Za-z0-9_-]+$/u.test(card.messageId) && /^ou_[A-Za-z0-9_-]+$/u.test(card.recipientOpenId)) ||
        (payload.patchOnly !== undefined && payload.patchOnly !== true)) throw new BadRequestException('加班确认交接任务无效');
    const patched = payload.patchedMessageIds;
    if (patched !== undefined && (!Array.isArray(patched) || !patched.every(id => typeof id === 'string' && cards.some(card => card.messageId === id)))) throw new BadRequestException('加班确认交接回执无效');
    const application = await this.requireApplication(task.recordId), terminal = buildOvertimeConfirmationHandoverCard(application.snapshot);
    let currentTask = task;
    for (const card of cards) {
      if ((currentTask.payload.patchedMessageIds as string[] | undefined)?.includes(card.messageId)) continue;
      await this.gateway.patchInteractiveCard(card.messageId, terminal);
      currentTask = await this.store.recordApprovalHandoverCardPatch(task.key, task.claimToken, card.messageId);
    }
    if (payload.patchOnly === true) return;
    const current = await this.requireApplication(task.recordId);
    if (overtimeConfirmationGeneration(current) !== targetGeneration || current.phase !== 'awaiting_confirmation' || await this.store.getConfirmation(task.recordId)) return;
    if (overtimeConfirmationOwner(current) !== target.openId || current.confirmationResponsible?.personRecordId !== target.personRecordId || !this.canActorContinue(target.openId)) throw new ForbiddenException('接任人员确认权限已收回或确认责任已变化');
    await this.store.enqueueTask({ businessKey: `overtime:${task.recordId}:confirmation:initial:v${targetGeneration}`, recordId: task.recordId, kind: 'deliver_confirmation', payload: { confirmationGeneration: targetGeneration, recipientOpenId: target.openId }, availableAt: current.snapshot.plannedEndAt }, now);
  }

  private async applyApproval(
    task: OvertimeWorkflowTaskEntry,
    now: Date,
  ): Promise<void> {
    const application = await this.requireApplication(task.recordId);
    const action = await this.store.getApprovalAction(application.recordId);
    if (!action) throw new BadRequestException('加班审批动作不存在');
    const approved = action.action === 'approve';
    await this.gateway.updateOvertimeRecord(
      application.recordId,
      approved
        ? {
            加班审批: '同意',
            加班流程进展: '已审批',
            加班工作流状态: '已审批',
            加班审批人: [{ id: action.actorOpenId }],
            加班审批时间: Date.parse(action.createdAt),
            加班工作流错误: '',
          }
        : {
            加班审批: '驳回',
            加班流程进展: '申请中',
            加班工作流状态: '已驳回',
            加班审批人: [{ id: action.actorOpenId }],
            加班审批时间: Date.parse(action.createdAt),
            加班工作流错误: '',
          },
    );

    await this.store.patchApplication(
      application.recordId,
      approved
        ? {
            phase: 'awaiting_confirmation',
            actualApproverOpenId: action.actorOpenId,
            actualApproverName: action.actorName,
            approvedAt: action.createdAt,
            lastError: '',
          }
        : {
            phase: 'rejected',
            actualApproverOpenId: action.actorOpenId,
            actualApproverName: action.actorName,
            rejectedAt: action.createdAt,
            lastError: '',
          },
    );
    await this.store.enqueueTask(
      {
        businessKey: `overtime:${application.recordId}:notify-managers`,
        recordId: application.recordId,
        kind: 'notify_managers',
        payload: {},
      },
      now,
    );
    if (approved) {
      await this.store.enqueueInitialConfirmationReminder(
        application.recordId,
        action.actorOpenId,
        application.snapshot.plannedEndAt,
        now,
      );
    }
  }

  private async syncApprovalResults(
    task: OvertimeWorkflowTaskEntry,
    now: Date,
  ): Promise<void> {
    let application = await this.requireApplication(task.recordId);
    const approved =
      application.phase === 'awaiting_confirmation' ||
      application.phase === 'confirmed';
    const rejected = application.phase === 'rejected';
    if (!approved && !rejected) {
      return;
    }
    if (approved && !application.managerRecipients.length) {
      throw new BadRequestException('加班申请缺少机房经理知会对象');
    }
    if (approved)
      application = await this.ensureProfessionalRecipients(application);

    const action = await this.store.getApprovalAction(application.recordId);
    const resolvedAction = action?.action || (approved ? 'approve' : 'reject');
    const resolvedActorName =
      action?.actorName || application.actualApproverName || '审批人';
    const resolvedAt =
      action?.createdAt ||
      application.approvedAt ||
      application.rejectedAt ||
      application.updatedAt;
    const terminalCard = buildOvertimeApprovalResolvedCard(
      application.snapshot,
      {
        action: resolvedAction,
        actorName: resolvedActorName,
        resolvedAt: formatShanghaiDisplay(new Date(resolvedAt)),
      },
    );

    const patchResult = await this.patchPendingApprovalCards(
      application,
      terminalCard,
      now,
    );
    application = patchResult.application;
    const cardUpdateFailures = patchResult.failures;

    const resultRecipients = () => this.currentNotificationRecipients(application, approved);
    const existingApprovalRecipients = new Set(
      application.approvalCards.map((entry) => entry.recipientOpenId),
    );
    for (let count = 0; count < 200; count++) {
      const recipient = resultRecipients().find(person => !existingApprovalRecipients.has(person.openId) && !application.managerNoticeCards.some(delivery => delivery.recipientOpenId === person.openId));
      if (!recipient) break;
      if (count === 199) throw new ServiceUnavailableException('加班结果通知岗位持续变化，请稍后恢复原任务');
      const businessKey = `overtime:${application.recordId}:approval-result:${recipient.openId}`;
      if (
        application.managerNoticeCards.some(
          (entry) =>
            entry.businessKey === businessKey ||
            entry.recipientOpenId === recipient.openId,
        )
      ) {
        continue;
      }
      const messageId = await this.gateway.sendInteractiveCard(
        recipient.openId,
        terminalCard,
        businessKey,
      );
      application = await this.appendDelivery(
        application,
        'managerNoticeCards',
        { recipientOpenId: recipient.openId, messageId, businessKey },
      );
    }

    const coveredRecipientIds = new Set(
      [...application.approvalCards, ...application.managerNoticeCards].map(
        (entry) => entry.recipientOpenId,
      ),
    );
    const uncoveredRecipient = resultRecipients().find(
      (entry) => !coveredRecipientIds.has(entry.openId),
    );
    if (uncoveredRecipient) {
      throw new ServiceUnavailableException(
        `审批结果接收人 ${uncoveredRecipient.name || uncoveredRecipient.openId} 尚未完成通知`,
      );
    }
    if (approved) {
      await this.gateway.updateOvertimeRecord(application.recordId, {
        加班经理知会时间: now.getTime(),
        加班工作流错误: '',
      });
    }
    await this.store.patchApplication(application.recordId, { lastError: '' });
    if (cardUpdateFailures.length) {
      throw new ServiceUnavailableException(
        `审批卡片终态更新未全部完成：${cardUpdateFailures.join('；')}`,
      );
    }
  }

  private async ensureProfessionalRecipients(
    application: OvertimeWorkflowApplicationEntry,
  ): Promise<OvertimeWorkflowApplicationEntry> {
    if (application.professionalRecipients !== undefined) return application;
    const directory =
      await this.bitableSyncService.getCachedActivePersonnelDirectory();
    return this.store.patchApplication(application.recordId, {
      professionalRecipients: resolveOvertimeProfessionalRecipients(
        snapshotApplicant(application.snapshot),
        directory.personnel.map(activePersonToOrganizationRecord),
      ),
    });
  }

  private async deliverConfirmation(
    task: OvertimeWorkflowTaskEntry,
    now: Date,
  ): Promise<void> {
    let application = await this.requireApplication(task.recordId);
    if (application.phase !== 'awaiting_confirmation') return;
    const generation = overtimeConfirmationGeneration(application), owner = overtimeConfirmationOwner(application);
    if (Number(task.payload.confirmationGeneration ?? 1) !== generation) return;
    if (generation > 1) {
      const transfer = (await this.store.listTasks()).find(entry => entry.recordId === task.recordId && entry.kind === 'sync_confirmation_handover' && entry.payload.patchOnly !== true && entry.payload.targetGeneration === generation);
      if (!transfer || transfer.status !== 'completed') throw new ServiceUnavailableException('原确认卡片尚未完成交接');
    }
    if (!owner) {
      throw new BadRequestException('加班确认审批人缺失');
    }
    if (!this.canActorContinue(owner)) throw new ForbiddenException('当前人员不可办理');
    await this.gateway.updateOvertimeRecord(application.recordId, {
      加班工作流状态: '待确认',
      加班确认最后提醒时间: now.getTime(),
      加班工作流错误: '',
    });
    if (
      !application.confirmationCards.some(
        (entry) => entry.businessKey === task.businessKey,
      )
    ) {
      const ticket = this.gateway.issueConfirmationTicket({
        recordId: application.recordId,
        approverOpenId: owner,
        ...(generation > 1 ? { confirmationGeneration: generation } : {}),
      });
      const confirmationUrl = this.gateway.buildConfirmationUrl(
        application.recordId,
        ticket,
      );
      const messageId = await this.gateway.sendInteractiveCard(
        owner,
        buildOvertimeConfirmationCard(application.snapshot, confirmationUrl),
        task.businessKey,
      );
      await this.store.recordConfirmationCardDelivery(
        application.recordId,
        {
          recipientOpenId: owner,
          messageId,
          businessKey: task.businessKey,
        },
        generation,
      );
    }
    await this.store.patchApplication(application.recordId, { lastError: '' });
  }

  private async retireIfSourceMissing(
    recordId: string,
    now: Date,
  ): Promise<OvertimeWorkflowApplicationEntry | null> {
    const source = await this.gateway.readOvertimeRecordIfExists(recordId);
    if (source) return null;
    this.refreshedPendingConfirmationCardRecords.delete(recordId);
    return this.store.markSourceDeleted(recordId, now);
  }

  private async refreshSourceDeletedCards(
    application: OvertimeWorkflowApplicationEntry,
  ): Promise<{ refreshed: number; failed: number }> {
    const patched = new Set(
      application.sourceDeletedCardPatches.map((entry) => entry.messageId),
    );
    const messageIds = unique(
      [
        ...application.approvalCards,
        ...application.managerNoticeCards,
        ...application.confirmationCards,
        ...application.confirmationResultCards,
      ]
        .map((entry) => entry.messageId)
        .filter((messageId) => !patched.has(messageId)),
    );
    if (messageIds.length === 0) return { refreshed: 0, failed: 0 };
    const card = buildOvertimeSourceDeletedCard(application.snapshot);
    let refreshed = 0;
    let failed = 0;
    for (const messageId of messageIds) {
      try {
        await this.gateway.patchInteractiveCard(messageId, card);
        await this.store.markSourceDeletedCardPatched(
          application.recordId,
          messageId,
        );
        refreshed += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `已删除加班卡片终态更新失败 ${application.recordId}/${messageId}: ${safeWorkflowError(error)}`,
        );
      }
    }
    return { refreshed, failed };
  }

  private async applyConfirmation(
    task: OvertimeWorkflowTaskEntry,
    now: Date,
  ): Promise<void> {
    let application = await this.requireApplication(task.recordId);
    application = await this.ensureProfessionalRecipients(application);
    const confirmation = await this.store.getConfirmation(application.recordId);
    if (!confirmation) throw new BadRequestException('加班确认提交不存在');
    const actualStart = requireWholeHour(confirmation.draft.actualStartAt);
    const actualHours = requireIntegerHours(confirmation.draft.actualHours);
    const actualEnd = resolveOvertimeActualEnd(
      actualStart,
      actualHours,
      confirmation.draft.actualEndAt,
    );
    const disposition = requireBitableConfirmationDisposition(
      actualHours,
      confirmation.draft.disposition,
    );
    if (application.phase !== 'confirmed') {
      await this.gateway.updateOvertimeRecord(application.recordId, {
        实际加班开始时间: actualStart.getTime(),
        实际加班结束时间: actualEnd.getTime(),
        实际加班时长: actualHours,
        确认加班工时: actualHours,
        加班工时处置: disposition,
        加班确认: '确认',
        加班流程进展: '已确认',
        加班工作流状态: '已确认',
        加班确认人: [{ id: confirmation.actorOpenId }],
        加班确认时间: now.getTime(),
        加班工作流错误: '',
      });
      application = await this.store.patchApplication(application.recordId, {
        phase: 'confirmed',
        confirmedAt: now.toISOString(),
        lastError: '',
      });
    }
    const confirmedAt = application.confirmedAt || confirmation.createdAt;
    const confirmedBy =
      application.approvers.find(
        (entry) => entry.openId === confirmation.actorOpenId,
      )?.name ||
      (application.confirmationResponsible?.openId === confirmation.actorOpenId ? application.confirmationResponsible.name : '') ||
      application.actualApproverName ||
      '确认人';
    const terminalCard = buildOvertimeConfirmationResolvedCard(
      application.snapshot,
      {
        actualStartAt: formatShanghaiDisplay(actualStart),
        actualEndAt: formatShanghaiDisplay(actualEnd),
        actualHours,
        disposition: disposition === '费用结算' ? '加班费' : disposition,
        confirmedAt: formatShanghaiDisplay(new Date(confirmedAt)),
        confirmedBy,
      },
    );
    const cardUpdateFailures: string[] = [];
    for (const delivery of application.confirmationCards) {
      try {
        await this.gateway.patchInteractiveCard(
          delivery.messageId,
          terminalCard,
        );
      } catch (error) {
        cardUpdateFailures.push(
          `${delivery.messageId}: ${safeWorkflowError(error)}`,
        );
      }
    }

    const resultRecipients = () => {
      const current = this.currentNotificationRecipients(application);
      const original = [snapshotApplicant(application.snapshot), ...application.approvers, ...application.managerRecipients, ...(application.professionalRecipients || [])];
      const accepted = application.confirmationResultIntents.filter(intent => intent.businessKey === `overtime:${application.recordId}:confirmation-result:${intent.recipientOpenId}` &&
        !application.confirmationResultCards.some(delivery => delivery.businessKey === intent.businessKey)).map(intent => original.find(person => person.openId === intent.recipientOpenId) ??
          { openId: intent.recipientOpenId, name: '原通知接收人', position: '', buildings: [application.snapshot.building] });
      return dedupeRoutePeople([...current, ...accepted]);
    };
    const existingConfirmationRecipients = new Set(
      application.confirmationCards.map((entry) => entry.recipientOpenId),
    );
    for (let count = 0; count < 200; count++) {
      const recipient = resultRecipients().find(person => !existingConfirmationRecipients.has(person.openId) && !application.confirmationResultCards.some(delivery => delivery.recipientOpenId === person.openId));
      if (!recipient) break;
      if (count === 199) throw new ServiceUnavailableException('加班确认通知岗位持续变化，请稍后恢复原任务');
      const businessKey = `overtime:${application.recordId}:confirmation-result:${recipient.openId}`;
      if (
        application.confirmationResultCards.some(
          (entry) =>
            entry.businessKey === businessKey ||
            entry.recipientOpenId === recipient.openId,
        )
      ) {
        continue;
      }
      const intentResult = await this.ensureConfirmationResultIntent(
        application,
        recipient.openId,
        businessKey,
        now,
      );
      application = intentResult.application;
      const sendCheckAtMs = Math.max(now.getTime(), Date.now());
      const intentAgeMs =
        sendCheckAtMs - Date.parse(intentResult.intent.createdAt);
      if (
        !Number.isFinite(intentAgeMs) ||
        intentAgeMs < 0 ||
        intentAgeMs >= FEISHU_MESSAGE_SAFE_RETRY_AGE_MS
      ) {
        throw new ServiceUnavailableException(
          `加班确认结果通知 ${recipient.name || recipient.openId} 超过飞书一小时幂等重试窗口或不足 30 秒安全余量，请人工核对消息送达状态`,
        );
      }
      const messageId = await this.gateway.sendInteractiveCard(
        recipient.openId,
        terminalCard,
        businessKey,
      );
      application = await this.appendDelivery(
        application,
        'confirmationResultCards',
        { recipientOpenId: recipient.openId, messageId, businessKey },
      );
    }

    const coveredRecipientIds = new Set(
      [
        ...application.confirmationCards,
        ...application.confirmationResultCards,
      ].map((entry) => entry.recipientOpenId),
    );
    const uncoveredRecipient = resultRecipients().find(
      (entry) => !coveredRecipientIds.has(entry.openId),
    );
    if (uncoveredRecipient) {
      throw new ServiceUnavailableException(
        `加班确认结果接收人 ${uncoveredRecipient.name || uncoveredRecipient.openId} 尚未完成通知`,
      );
    }
    if (cardUpdateFailures.length) {
      throw new ServiceUnavailableException(
        `加班确认卡片终态更新未全部完成：${cardUpdateFailures.join('；')}`,
      );
    }
    await this.gateway.updateOvertimeRecord(application.recordId, {
      加班工作流错误: '',
    });
    await this.store.patchApplication(application.recordId, { lastError: '' });
  }

  private async patchPendingApprovalCards(
    initialApplication: OvertimeWorkflowApplicationEntry,
    card: Record<string, unknown>,
    now: Date,
  ): Promise<{
    application: OvertimeWorkflowApplicationEntry;
    failures: string[];
  }> {
    let application = initialApplication;
    const completedMessageIds = new Set(
      application.approvalCardPatches.map((entry) => entry.messageId),
    );
    const failures: string[] = [];
    for (const messageId of unique(
      application.approvalCards.map((entry) => entry.messageId),
    )) {
      if (completedMessageIds.has(messageId)) continue;
      try {
        await this.gateway.patchInteractiveCard(messageId, card);
        application = await this.store.markApprovalCardPatched(
          application.recordId,
          messageId,
          now,
        );
        completedMessageIds.add(messageId);
      } catch (error) {
        failures.push(`${messageId}: ${safeWorkflowError(error)}`);
      }
    }
    return { application, failures };
  }

  private async appendDelivery(
    application: OvertimeWorkflowApplicationEntry,
    field:
      | 'approvalCards'
      | 'managerNoticeCards'
      | 'confirmationCards'
      | 'confirmationResultCards',
    delivery: OvertimeWorkflowMessageDelivery,
  ): Promise<OvertimeWorkflowApplicationEntry> {
    const existing = application[field];
    if (existing.some((entry) => entry.businessKey === delivery.businessKey)) {
      return application;
    }
    return this.store.patchApplication(application.recordId, {
      [field]: [...existing, delivery],
    });
  }

  private async ensureConfirmationResultIntent(
    application: OvertimeWorkflowApplicationEntry,
    recipientOpenId: string,
    businessKey: string,
    now: Date,
  ): Promise<{
    application: OvertimeWorkflowApplicationEntry;
    intent: OvertimeWorkflowMessageIntent;
  }> {
    const existing = application.confirmationResultIntents.find(
      (entry) => entry.businessKey === businessKey,
    );
    if (existing) {
      if (existing.recipientOpenId !== recipientOpenId) {
        throw new ServiceUnavailableException(
          '加班确认结果通知 intent 与接收人不一致，请人工核对',
        );
      }
      return { application, intent: existing };
    }
    const intent: OvertimeWorkflowMessageIntent = {
      recipientOpenId,
      businessKey,
      messageUuid: stableOvertimeMessageUuid(businessKey),
      createdAt: now.toISOString(),
    };
    const updated = await this.store.patchApplication(application.recordId, {
      confirmationResultIntents: [
        ...application.confirmationResultIntents,
        intent,
      ],
    });
    return { application: updated, intent };
  }

  private async requireApplication(
    recordId: string,
  ): Promise<OvertimeWorkflowApplicationEntry> {
    const application = await this.store.getApplication(recordId);
    if (!application) throw new NotFoundException('加班工作流申请不存在');
    return application;
  }

  private async requireConfirmationApplication(
    recordId: string,
    ticket: string,
    options: { allowConfirmedReplay?: boolean } = {},
  ): Promise<OvertimeWorkflowApplicationEntry> {
    const authorization = this.gateway.verifyConfirmationTicket(
      requireText(ticket, '加班确认令牌缺失', 2_048),
      recordId,
    );
    if (!this.canActorContinue(authorization.approverOpenId)) {
      const existing = options.allowConfirmedReplay ? await this.store.getConfirmation(recordId) : null;
      if (!existing || existing.actorOpenId !== authorization.approverOpenId) throw new ForbiddenException('当前人员不可办理');
    }
    const application =
      (await this.store.getApplication(recordId)) ||
      (await this.recoverConfirmationApplication(
        recordId,
        authorization.approverOpenId,
      ));
    if (
      application.phase !== 'awaiting_confirmation' &&
      !(options.allowConfirmedReplay && application.phase === 'confirmed')
    ) {
      throw new ForbiddenException('当前加班申请不在待确认状态');
    }
    if (Date.parse(application.snapshot.plannedEndAt) > Date.now()) {
      throw new ForbiddenException('加班结束后才能确认实际加班信息');
    }
    if (
      !overtimeConfirmationOwner(application) ||
      authorization.approverOpenId !== overtimeConfirmationOwner(application) ||
      (authorization.confirmationGeneration ?? 1) !== overtimeConfirmationGeneration(application)
    ) {
      throw new ForbiddenException('当前确认令牌无权访问该加班记录');
    }
    return application;
  }

  private canActorContinue(openId: string): boolean {
    const appId = process.env.FEISHU_APP_ID?.trim();
    if (!appId || !this.accessConfiguration || typeof this.accessConfiguration.canUseFeishuBusinessIdentity !== 'function') {
      throw new ServiceUnavailableException('人员权限状态未就绪');
    }
    if (!openId) throw new ForbiddenException('当前人员不可办理');
    return this.accessConfiguration.canUseFeishuBusinessIdentity(`feishu-${feishuIdentityFingerprint(appId, openId)}`, appId);
  }

  private async recoverConfirmationApplication(
    recordId: string,
    authorizedApproverOpenId: string,
  ): Promise<OvertimeWorkflowApplicationEntry> {
    const record = await this.gateway.readOvertimeRecord(recordId);
    if (record.recordId !== recordId) {
      throw new ForbiddenException('加班确认记录标识不一致');
    }
    const fields = record.fields;
    const approval = extractSimpleText(fields['加班审批']);
    const progress = extractSimpleText(fields['加班流程进展']);
    const workflowStatus = extractSimpleText(fields['加班工作流状态']);
    const confirmation = extractSimpleText(fields['加班确认']);
    if (
      approval !== '同意' ||
      progress !== '已审批' ||
      !['已审批', '待确认'].includes(workflowStatus) ||
      confirmation === '确认'
    ) {
      throw new ForbiddenException('当前加班申请不在待确认状态');
    }

    const approvers = extractBitablePeople(fields['加班审批人']);
    const approvedBy = approvers.find(
      (entry) => entry.openId === authorizedApproverOpenId,
    );
    if (!approvedBy || approvers.length !== 1) {
      throw new ForbiddenException('当前确认令牌无权访问该加班记录');
    }
    const approvedAt = readBitableDate(fields['加班审批时间']);
    const plannedStart = readBitableDate(fields['加班开始时间']);
    const plannedEnd = readBitableDate(fields['加班结束时间']);
    const plannedHours = readPositiveNumber(fields['加班时长']);
    const applicantUsers = extractBitablePeople(fields['加班人员']);
    const applicantName =
      extractSimpleText(fields['加班人员姓名']) ||
      applicantUsers[0]?.name ||
      '';
    const applicantOpenId = applicantUsers[0]?.openId || '';
    const reason = extractSimpleText(fields['加班原因']);
    if (
      !approvedAt ||
      !plannedStart ||
      !plannedEnd ||
      !plannedHours ||
      !applicantName ||
      !applicantOpenId ||
      !reason ||
      applicantUsers.length !== 1
    ) {
      throw new ServiceUnavailableException(
        '加班确认记录字段不完整，请稍后重试或联系管理员',
      );
    }

    const directory =
      await this.bitableSyncService.getCachedActivePersonnelDirectory();
    const applicant = resolveApplicant(
      {
        recordId,
        applicantName,
        applicantOpenId,
        building: '',
        position: '',
        plannedStartAt: formatShanghaiDateTime(plannedStart),
        plannedEndAt: formatShanghaiDateTime(plannedEnd),
        plannedHours,
        reason,
      },
      directory,
    );
    if (!applicant.openId) {
      throw new ServiceUnavailableException(
        '加班申请人员资料不完整，请稍后重试或联系管理员',
      );
    }
    const directoryApprover = directory.personnel.find(
      (entry) => entry.openId === approvedBy.openId,
    );
    const actualApprover: OvertimeRoutePerson = directoryApprover
      ? {
          name: directoryApprover.name,
          openId: directoryApprover.openId,
          position: directoryApprover.position,
          buildings: directoryApprover.buildings.map(normalizeBuilding),
        }
      : approvedBy;
    const recovered = await this.store.recoverAwaitingConfirmationApplication({
      snapshot: {
        recordId,
        applicantName: applicant.name,
        applicantOpenId: applicant.openId,
        building: applicant.buildings[0] || '',
        position: applicant.position,
        plannedStartAt: formatShanghaiDateTime(plannedStart),
        plannedEndAt: formatShanghaiDateTime(plannedEnd),
        plannedHours,
        reason,
      },
      actualApprover,
      managerRecipients: resolveManagers(directory, []),
      approvedAt: approvedAt.toISOString(),
    });
    return recovered.entry;
  }

  private assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException('加班审批程序工作流未启用');
    }
  }

  private async recordTaskFailure(
    task: OvertimeWorkflowTaskEntry,
    error: unknown,
    now: Date,
  ): Promise<void> {
    const message = safeWorkflowError(error);
    await this.store
      .patchApplication(task.recordId, { lastError: message }, { now })
      .catch(() => undefined);
    await this.gateway
      .updateOvertimeRecord(task.recordId, {
        加班工作流错误: message,
      })
      .catch(() => undefined);
  }
}

export function isOvertimeWorkflowEnabled(): boolean {
  const value = readEnv('OVERTIME_WORKFLOW_PROGRAM_ENABLED').toLowerCase();
  return !['false', '0', 'off', 'no'].includes(value);
}

function mapAcceptanceToSnapshot(input: {
  request: OvertimeRequestCreateRequest;
  result: OvertimeRequestCreateResponse;
}): OvertimeApplicationSnapshot {
  if (!input?.request || !input?.result) {
    throw new BadRequestException('加班申请工作流接入参数缺失');
  }
  const request = input.request;
  const result = input.result;
  const payableHours = Number(result.impact.payableHours);
  if (!Number.isFinite(payableHours) || payableHours <= 0) {
    throw new BadRequestException('加班申请工时无效');
  }
  const conflict = firstObject(result.impact.conflictingSchedules);
  return {
    recordId: requireText(result.recordId, '加班记录标识无效', 100),
    applicantName: requireText(request.staffName, '加班申请人姓名无效', 200),
    applicantOpenId: '',
    building: optionalText(conflict?.building, 100),
    position: '',
    plannedStartAt: requireDateText(request.startAt, '加班开始时间无效'),
    plannedEndAt: requireDateText(request.endAt, '加班结束时间无效'),
    plannedHours: payableHours,
    reason: requireText(request.reason, '加班原因无效', 2_000),
  };
}

function completeOrganizationRecords(
  organization: OvertimeOrganizationRecord[],
  directory: ActivePersonnelDirectory,
): OvertimeOrganizationRecord[] {
  const result: OvertimeOrganizationRecord[] = organization.map((entry) => ({
    ...entry,
    buildings: [...entry.buildings],
    supervisorNames: [...(entry.supervisorNames || [])],
  }));
  for (const person of directory.personnel) {
    result.push(activePersonToOrganizationRecord(person));
  }
  return mergeOrganizationRecords(result);
}

function mergeOrganizationRecords(
  records: OvertimeOrganizationRecord[],
): OvertimeOrganizationRecord[] {
  const result = new Map<string, OvertimeOrganizationRecord>();
  for (const record of records) {
    const key = record.openId
      ? `id:${record.openId}`
      : `name:${normalizeName(record.name)}:${record.position}:${record.buildings.join(',')}`;
    const previous = result.get(key);
    result.set(key, {
      name: previous?.name || record.name,
      openId: previous?.openId || record.openId,
      position: previous?.position || record.position,
      buildings: unique([...(previous?.buildings || []), ...record.buildings]),
      supervisorNames: unique([
        ...(previous?.supervisorNames || []),
        ...(record.supervisorNames || []),
      ]),
    });
  }
  return [...result.values()];
}

function activePersonToOrganizationRecord(
  person: ActivePersonnelDirectoryEntry,
): OvertimeOrganizationRecord {
  return {
    name: person.name,
    openId: person.openId,
    position: person.position,
    buildings: person.buildings.map(normalizeBuilding),
    supervisorNames: [],
  };
}

function resolveApplicant(
  snapshot: OvertimeApplicationSnapshot,
  directory: ActivePersonnelDirectory,
): OvertimeRoutePerson {
  const byId = snapshot.applicantOpenId
    ? directory.personnel.find(
        (entry) => entry.openId === snapshot.applicantOpenId,
      )
    : undefined;
  const byName = directory.personnel.filter(
    (entry) =>
      normalizeName(entry.name) === normalizeName(snapshot.applicantName),
  );
  const person = byId || (byName.length === 1 ? byName[0] : undefined);
  return person
    ? {
        name: person.name,
        openId: person.openId,
        position: person.position || snapshot.position,
        buildings: person.buildings.map(normalizeBuilding),
      }
    : {
        name: snapshot.applicantName,
        openId: snapshot.applicantOpenId,
        position: snapshot.position,
        buildings: snapshot.building
          ? [normalizeBuilding(snapshot.building)]
          : [],
      };
}

function resolveManagers(
  directory: ActivePersonnelDirectory,
  merged: OvertimeOrganizationRecord[],
): OvertimeRoutePerson[] {
  const source = directory.managers.length
    ? directory.managers.map(activePersonToOrganizationRecord)
    : merged.filter((entry) =>
        MANAGER_POSITIONS.has(entry.position.replace(/\s+/gu, '')),
      );
  const result = new Map<string, OvertimeRoutePerson>();
  for (const entry of source) {
    if (!entry.openId) continue;
    result.set(entry.openId, {
      name: entry.name,
      openId: entry.openId,
      position: entry.position,
      buildings: [...entry.buildings],
    });
  }
  return [...result.values()];
}

function snapshotApplicant(
  snapshot: OvertimeApplicationSnapshot,
): OvertimeRoutePerson {
  return {
    name: snapshot.applicantName,
    openId: snapshot.applicantOpenId,
    position: snapshot.position,
    buildings: snapshot.building ? [snapshot.building] : [],
  };
}

function dedupeRoutePeople(
  people: OvertimeRoutePerson[],
): OvertimeRoutePerson[] {
  const result = new Map<string, OvertimeRoutePerson>();
  for (const person of people) {
    if (!person.openId || result.has(person.openId)) continue;
    result.set(person.openId, person);
  }
  return [...result.values()];
}

function requireWholeHour(value: unknown, label = '实际加班开始时间'): Date {
  const date = resolveDate(value, `${label}无效`);
  const shanghai = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  if (
    shanghai.getUTCMinutes() !== 0 ||
    shanghai.getUTCSeconds() !== 0 ||
    shanghai.getUTCMilliseconds() !== 0
  ) {
    throw new BadRequestException(`${label}必须选择整点`);
  }
  return date;
}

function requireIntegerHours(value: unknown): number {
  const hours = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isInteger(hours) || hours < 0 || hours > 72) {
    throw new BadRequestException('实际加班工时必须是 0 至 72 的整数');
  }
  return hours;
}

function resolveOvertimeActualEnd(
  start: Date,
  hours: number,
  selectedEnd?: string,
): Date {
  if (selectedEnd !== undefined) {
    const end = requireWholeHour(selectedEnd, '实际加班结束时间');
    const duration = end.getTime() - start.getTime();
    if (
      duration < 0 ||
      duration > 72 * 2 * HOUR_MS ||
      (hours === 0 && duration !== 0)
    ) {
      throw new BadRequestException(
        '实际加班结束时间无效，取消加班时结束时间须等于开始时间',
      );
    }
    if (
      calculateOvertimePayableHours(start.getTime(), end.getTime()) !== hours
    ) {
      throw new BadRequestException('实际加班结束时间与工时不一致');
    }
    return end;
  }
  const endEpochMs = addOvertimePayableHours(start.getTime(), hours);
  if (endEpochMs === null) {
    throw new BadRequestException('实际加班结束时间计算失败');
  }
  return new Date(endEpochMs);
}

function requireConfirmationDisposition(
  hours: number,
  value: unknown,
): OvertimeConfirmationDispositionApi | null {
  if (hours === 0) {
    if (value !== null) {
      throw new BadRequestException('0 工时无需选择加班工时处置方式');
    }
    return null;
  }
  return requireApiDisposition(value);
}

function requireApiDisposition(
  value: unknown,
): OvertimeConfirmationDispositionApi {
  if (value !== 'compensatory_leave' && value !== 'overtime_pay') {
    throw new BadRequestException('请选择加班工时处置方式');
  }
  return value;
}

function mapDispositionToBitable(
  value: OvertimeConfirmationDispositionApi,
): OvertimeConfirmationDisposition {
  return value === 'compensatory_leave' ? '调休' : '费用结算';
}

function normalizeBitableDisposition(
  value: OvertimeConfirmationDisposition,
): '调休' | '费用结算' {
  return value === '调休' ? '调休' : '费用结算';
}

function requireBitableConfirmationDisposition(
  hours: number,
  value: OvertimeConfirmationDisposition | null,
): '调休' | '费用结算' | null {
  if (hours === 0) {
    if (value !== null) {
      throw new BadRequestException('0 工时无需选择加班工时处置方式');
    }
    return null;
  }
  if (value === null) {
    throw new BadRequestException('请选择加班工时处置方式');
  }
  return normalizeBitableDisposition(value);
}

function mapDispositionToApi(
  value: unknown,
): OvertimeConfirmationDispositionApi | null {
  const text = extractSimpleText(value);
  if (text === '调休') return 'compensatory_leave';
  if (text === '费用结算' || text === '加班费') return 'overtime_pay';
  return null;
}

function readBitableDate(value: unknown): Date | null {
  const raw = Array.isArray(value) && value.length === 1 ? value[0] : value;
  const timestamp =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d+$/u.test(raw)
        ? Number(raw)
        : typeof raw === 'string'
          ? Date.parse(raw)
          : Number.NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function readPositiveNumber(value: unknown): number | null {
  const raw = Array.isArray(value) && value.length === 1 ? value[0] : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function extractSimpleText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map(extractSimpleText).filter(Boolean).join('、');
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return extractSimpleText(
      object.text || object.name || object.value || object.option,
    );
  }
  return '';
}

function extractBitablePeople(value: unknown): OvertimeRoutePerson[] {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? (value as Record<string, unknown>).users
      : [];
  if (!Array.isArray(source)) return [];
  const result = new Map<string, OvertimeRoutePerson>();
  for (const item of source) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const object = item as Record<string, unknown>;
    const openId = extractSimpleText(
      object.id || object.open_id || object.user_id || object.userId,
    );
    if (!openId || result.has(openId)) continue;
    result.set(openId, {
      name: extractSimpleText(object.name || object.en_name || object.enName),
      openId,
      position: '',
      buildings: [],
    });
  }
  return [...result.values()];
}

function formatShanghaiDateTime(value: Date): string {
  const shifted = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
  const part = (number: number, length = 2) =>
    String(number).padStart(length, '0');
  return `${part(shifted.getUTCFullYear(), 4)}-${part(shifted.getUTCMonth() + 1)}-${part(shifted.getUTCDate())}T${part(shifted.getUTCHours())}:${part(shifted.getUTCMinutes())}:${part(shifted.getUTCSeconds())}.${part(shifted.getUTCMilliseconds(), 3)}+08:00`;
}

function formatShanghaiCalendarDate(value: Date): string {
  return formatShanghaiDateTime(value).slice(0, 10);
}

function formatShanghaiDisplay(value: Date): string {
  return formatShanghaiDateTime(value)
    .replace('T', ' ')
    .replace(/:\d{2}\.\d{3}\+08:00$/u, '');
}

function resolveDate(value: unknown, message: string): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value as any);
  if (!Number.isFinite(date.getTime())) throw new BadRequestException(message);
  return date;
}

function requireDateText(value: unknown, message: string): string {
  const text = requireText(value, message, 100);
  resolveDate(text, message);
  return text;
}

function requireText(
  value: unknown,
  message: string,
  maxLength: number,
): string {
  const text = optionalText(value, maxLength);
  if (!text) throw new BadRequestException(message);
  return text;
}

function optionalText(value: unknown, maxLength: number): string {
  const text =
    typeof value === 'string'
      ? value
          .normalize('NFC')
          .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
          .trim()
      : '';
  if (Array.from(text).length > maxLength) {
    throw new BadRequestException('加班工作流文本过长');
  }
  return text;
}

function firstObject(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
  );
}

function normalizeName(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function normalizeBuilding(value: string): string {
  const text = String(value || '')
    .toUpperCase()
    .replace(/\s+/gu, '');
  if (text === '110' || text.includes('110站')) return '110站';
  const match = text.match(/^([ABCDEH])(?:楼|栋)?$/u);
  return match ? `${match[1]}楼` : text;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function safeWorkflowError(error: unknown): string {
  return (
    error instanceof Error ? error.message : String(error || '后台同步失败')
  )
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, '$1 [redacted]')
    .replace(
      /\b(secret|token|password|encrypt[_-]?key|app[_-]?secret)\s*[:=]\s*[^\s,;]+/giu,
      '$1=[redacted]',
    )
    .trim()
    .slice(0, 500);
}
