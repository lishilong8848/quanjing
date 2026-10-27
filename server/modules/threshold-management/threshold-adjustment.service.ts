import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { assertProfessionalRecordScope, filterProfessionalRecords } from '../../common/access/professional-record-scope';
import { canManageProfessionalRecord } from '../../../shared/professional-access';
import type {
  ThresholdAdjustmentInput,
  ThresholdAdjustmentContext,
  ThresholdPerson,
} from '../../../shared/threshold-adjustment.interface';
import { thresholdContentFingerprint } from '../../../shared/threshold-bitable';
import { feishuIdentityFingerprint } from '../../common/access/feishu-access-approved-grants';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { assertFeishuBusinessIdentity } from '../../common/access/feishu-business-identity';
import { getFeishuAuthPayload } from '../../common/config/external-services.config';
import { InventoryOutboundApprovalGateway } from '../inventory-outbound-approval/inventory-outbound-approval.gateway';
import { ThresholdStore } from './threshold.store';
import { ThresholdSyncService } from './threshold-sync.service';
import { ThresholdAdjustmentGateway } from './threshold-adjustment.gateway';
import {
  ThresholdAdjustmentStore,
  adjustmentFingerprint,
  type ThresholdAdjustmentEntry,
} from './threshold-adjustment.store';
import {
  parseThresholdAdjustmentAction,
  thresholdAdjustmentCard,
} from './threshold-adjustment.card';

@Injectable()
export class ThresholdAdjustmentService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ThresholdAdjustmentService.name);
  readonly ledger: ThresholdAdjustmentStore;
  private timer?: NodeJS.Timeout;
  private draining?: Promise<void>;
  private running = false;
  private stopped = false;
  private recovered = false;
  private recoveryError = '';
  private recoveryRetryAt = 0;
  private owner = randomUUID();
  constructor(
    private readonly records: ThresholdStore,
    private readonly sync: ThresholdSyncService,
    private readonly gateway: ThresholdAdjustmentGateway,
    private readonly messages: InventoryOutboundApprovalGateway,
    @Inject(AccessConfigurationService)
    private readonly accessConfiguration?: AccessConfigurationService,
  ) {
    this.ledger = new ThresholdAdjustmentStore(
      process.env.THRESHOLD_APPROVAL_LEDGER_PATH ||
        join(
          dirname(
            process.env.THRESHOLD_LEDGER_PATH ||
              '.runtime/threshold-management/records.json',
          ),
          'adjustments.json',
        ),
    );
  }
  isEnabled() {
    try {
      getFeishuAuthPayload();
      return true;
    } catch {
      return false;
    }
  }
  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      this.timer = setInterval(() => this.kick(), 5000);
      this.timer.unref();
      this.kick();
    });
  }
  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.draining;
  }
  kick() {
    if (this.running || this.stopped) return;
    this.draining = this.runPending();
    void this.draining.catch((error) =>
      this.logger.warn(
        error instanceof Error ? error.message : '阈值审批同步失败',
      ),
    );
  }
  async context(
    principal: AccessPrincipal,
  ): Promise<ThresholdAdjustmentContext> {
    const context = this.gateway.peekContext();
    if (!context) {
      void this.gateway.readContext().catch((error) => {
        this.recoveryError = error.message;
      });
      return {
        engineers: [],
        roles: [],
        error: this.recoveryError || '人员目录准备中，请重试',
      };
    }
    return {
      ...context,
      engineers: filterProfessionalRecords(principal, context.engineers, engineer => engineer.profession),
      applicant: resolveApplicant(context, principal),
      ...(this.recoveryError ? { error: this.recoveryError } : {}),
    };
  }
  list(principal: AccessPrincipal) {
    const context = this.gateway.peekContext(),
      applicant = context ? resolveApplicant(context, principal) : undefined;
    return this.ledger
      .list()
      .filter(
        (e) =>
          (principal.role === 'admin' || isProfessionalBusinessPrincipal(principal)) ||
          e.actorId === principal.accountId ||
          e.adjustment.stages.some(
            (s) => s.approver.openId === applicant?.openId,
          ),
      )
      .filter(e => !isProfessionalBusinessPrincipal(principal) || canManageProfessionalRecord(principal, e.adjustment.before.profession, e.adjustment.before.building, { module: 'thresholds', action: 'read' }))
      .map((e) => e.adjustment);
  }
  submit(input: ThresholdAdjustmentInput, principal: AccessPrincipal) {
    if (
      !input ||
      !/^threshold-[A-Za-z0-9_-]{8,140}$/.test(input.clientMutationId || '') ||
      typeof input.value !== 'string' ||
      input.value.length > 4000 ||
      typeof input.reason !== 'string' ||
      !input.reason.trim() ||
      input.reason.trim().length > 2000 ||
      !Number.isFinite(Date.parse(input.plannedAt))
    )
      throw new BadRequestException('申请标识、新阈值、预计调整时间或原因无效');
    const existing = this.ledger
      .list()
      .find((e) => e.adjustment.clientMutationId === input.clientMutationId);
    const fingerprint = adjustmentFingerprint({
      input,
      actorId: principal.accountId,
    });
    if (existing) {
      if (
        existing.actorId !== principal.accountId ||
        existing.fingerprint !== fingerprint
      )
        throw new ConflictException('重复申请内容不一致');
      return existing.adjustment;
    }
    if (Date.parse(input.plannedAt) < Date.now() - 60000)
      throw new BadRequestException('预计调整时间不能早于当前时间');
    if (!this.recovered)
      throw new ConflictException(
        this.recoveryError || '审批服务准备中，请稍后重试',
      );
    const before = this.records
      .list()
      .records.find((r) => r.id === input.thresholdId);
    assertProfessionalRecordScope(principal, before?.profession, before?.building);
    if (
      !before ||
      before.version !== input.expectedVersion ||
      thresholdContentFingerprint(before) !== input.expectedContent
    )
      throw new ConflictException('原阈值已变化，请刷新后重新申请');
    if (before.value === input.value)
      throw new BadRequestException('新阈值与原阈值相同');
    const context = this.gateway.peekContext();
    if (!context)
      throw new ConflictException('人员目录已过期，正在刷新，请重试');
    const applicant = resolveApplicant(context, principal);
    const engineerId =
      (principal.role === 'admin' || isProfessionalBusinessPrincipal(principal)) ? input.engineerOpenId : applicant?.openId;
    const engineer = context.engineers.find(
      (e) =>
        e.openId === engineerId &&
        e.profession === before.profession &&
        e.buildings.includes(before.building),
    );
    if (!applicant)
      throw new ForbiddenException(
        '请使用本人飞书账号登录后提交，申请人身份未确认',
      );
    if (
      !engineer ||
      (principal.role !== 'admin' && !isProfessionalBusinessPrincipal(principal) &&
        input.engineerOpenId &&
        input.engineerOpenId !== applicant.openId)
    )
      throw new ForbiddenException(
        '请选择该楼栋、该专业的工程师；代提交仅限管理员',
      );
    const building = uniquePerson(
      context.roles.filter(
        (r) =>
          ['设施运维主管', 'H楼值班主管'].includes(r.position) &&
          r.buildings.includes(before.building),
      ),
      '楼长',
    );
    const professional = uniquePerson(
      context.roles.filter(
        (r) =>
          [
            `${before.profession}主管`,
            `${before.profession}专业主管`,
            `${before.profession}主管工程师`,
          ].includes(r.position) && r.professions.includes(before.profession),
      ),
      '专业主管',
    );
    if ([building.openId, professional.openId].includes(applicant.openId))
      throw new ForbiddenException('申请人不能审批本人的阈值调整');
    const managers = [
      ...new Map(
        context.roles
          .filter((r) =>
            ['设施运维经理', '设施运维副经理'].includes(r.position),
          )
          .map((p) => [p.openId, { openId: p.openId, name: p.name }]),
      ).values(),
    ];
    if (!managers.length) throw new ConflictException('未配置机房经理知会人员');
    const adjustment = {
      id: `ta-${randomUUID()}`,
      revision: 1,
      policyVersion: 'threshold-dual-approval-v1' as const,
      clientMutationId: input.clientMutationId,
      applicant,
      engineer: { openId: engineer.openId, name: engineer.name },
      before,
      value: input.value,
      reason: input.reason.trim(),
      plannedAt: new Date(input.plannedAt).toISOString(),
      submittedAt: new Date().toISOString(),
      state: 'routing' as const,
      stages: [
        { role: 'building' as const, approver: building },
        { role: 'professional' as const, approver: professional },
      ],
      managers,
      syncState: 'pending' as const,
    };
    const entry = this.ledger.reserve({
      adjustment,
      fingerprint,
      actorId: principal.accountId!,
      cloudRevision: 0,
      messages: [],
      attempts: 0,
    });
    this.kick();
    return entry.adjustment;
  }
  retry(id: string, principal: AccessPrincipal) {
    const entry = this.ledger.get(id);
    assertProfessionalRecordScope(principal, entry?.adjustment.before.profession, entry?.adjustment.before.building);
    if (
      !entry ||
      (entry.actorId !== principal.accountId && principal.role !== 'admin')
    )
      throw new ForbiddenException('无权重试此申请');
    if (entry.adjustment.state === 'applying') {
      try {
        this.records.retrySync(`approved-${id}`, `threshold-approval:${id}`);
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
      }
      this.sync.kick();
    }
    const next = this.ledger.change(id, (e) => {
      e.nextAttemptAt = undefined;
      e.attempts = 0;
      e.adjustment.error = undefined;
      e.adjustment.syncState = 'pending';
      e.adjustment.revision++;
    });
    this.kick();
    return next.adjustment;
  }
  async handleCardAction(payload: unknown) {
    let input: ReturnType<typeof parseThresholdAdjustmentAction>;
    try {
      input = parseThresholdAdjustmentAction(payload);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : '卡片回调无效',
      );
    }
    assertFeishuBusinessIdentity(this.accessConfiguration, input.actorOpenId);
    const entry = this.ledger.get(input.id);
    const eventId = `ws_threshold_${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
    if (input.role === 'engineer') {
      const result = this.ledger.confirm({
        ...input,
        eventId,
        completed: input.action === 'complete',
      });
      this.kick();
      return {
        claimed: result.claimed,
        card: thresholdAdjustmentCard(
          result.entry.adjustment,
          input.actorOpenId,
        ),
      };
    }
    if (
      !entry ||
      !entry.adjustment.stages.some(
        (s) => s.role === input.role && s.approver.openId === input.actorOpenId,
      ) ||
      !entry.messages.some(
        (m) =>
          m.kind === 'approval' &&
          m.openId === input.actorOpenId &&
          m.messageId === input.messageId,
      )
    )
      throw new ForbiddenException('人员、审批阶段或消息不匹配');
    if (['open_reject', 'return'].includes(input.action)) {
      const stage = entry.adjustment.stages.find((s) => s.role === input.role)!;
      const prompt =
        ['routing', 'pending'].includes(entry.adjustment.state) &&
        !stage.decision &&
        input.action === 'open_reject'
          ? input.role
          : undefined;
      const card = thresholdAdjustmentCard(
        entry.adjustment,
        input.actorOpenId,
        prompt,
      );
      try {
        await this.messages.patchInteractiveCard(input.messageId, card);
      } catch {
        this.ledger.change(input.id, (e) => {
          e.adjustment.error = '驳回表单切换失败，请重新点击';
          e.adjustment.revision++;
          e.adjustment.syncState = 'error';
        });
        throw new ConflictException('表单切换失败，请重新点击');
      }
      return {
        claimed: false,
        toast: prompt ? '请填写驳回原因' : '已返回审批',
      };
    }
    const result = this.ledger.decide({
      ...input,
      role: input.role,
      eventId,
      action: input.action as 'approve' | 'reject',
    });
    this.kick();
    return {
      claimed: result.claimed,
      card: thresholdAdjustmentCard(result.entry.adjustment, input.actorOpenId),
    };
  }
  async runPending() {
    if (this.running || this.stopped || !this.isEnabled()) return;
    this.running = true;
    try {
      if (!this.recovered) {
        if (Date.now() < this.recoveryRetryAt) return;
        try {
          await this.gateway.readContext();
          for (const entry of await this.gateway.recover())
            this.ledger.recover(entry);
          this.recovered = true;
          this.recoveryError = '';
        } catch {
          this.recoveryError =
            '审批服务初始化失败，请检查飞书人员目录和申请表权限';
          this.recoveryRetryAt = Date.now() + 60000;
          return;
        }
      }
      for (const entry of this.ledger.list()) {
        if (this.stopped) break;
        if (
          entry.adjustment.syncState === 'success' &&
          ['pending', 'completed', 'rejected', 'conflict'].includes(
            entry.adjustment.state,
          )
        )
          continue;
        if (
          entry.adjustment.state === 'awaiting_completion' &&
          entry.adjustment.syncState === 'success' &&
          (Date.parse(entry.adjustment.execution!.nextReminderAt) >
            Date.now() ||
            entry.messages.some(
              (m) =>
                m.kind === 'confirmation' &&
                m.round === entry.adjustment.execution!.round,
            ))
        )
          continue;
        if (
          entry.attempts >= 6 ||
          !this.ledger.claim(entry.adjustment.id, this.owner)
        )
          continue;
        try {
          await this.process(entry.adjustment.id);
          this.ledger.change(entry.adjustment.id, (e) => {
            if (e.lease?.owner === this.owner) e.lease = undefined;
            e.attempts = 0;
            e.nextAttemptAt = undefined;
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : '阈值审批同步失败';
          this.ledger.change(entry.adjustment.id, (e) => {
            e.attempts++;
            e.nextAttemptAt =
              Date.now() + Math.min(60000, 2000 * 2 ** e.attempts);
            e.adjustment.error = message;
            e.adjustment.syncState = 'error';
            e.adjustment.revision++;
          });
          // The local outbox remains authoritative even when the error receipt cannot reach Feishu.
          try {
            await this.syncBase(entry.adjustment.id);
          } catch {
            this.logger.warn('阈值审批错误回执暂未同步，已保留重试任务');
          } finally {
            this.ledger.change(entry.adjustment.id, (e) => {
              if (e.lease?.owner === this.owner) e.lease = undefined;
            });
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
  private async process(id: string) {
    this.ledger.change(id, (e) => {
      if (e.adjustment.error && e.adjustment.state !== 'conflict') {
        e.adjustment.error = undefined;
        e.adjustment.revision++;
      }
    });
    await this.syncBase(id);
    let entry = this.ledger.get(id)!;
    if (['routing', 'pending'].includes(entry.adjustment.state)) {
      for (const person of [
        ...new Map(
          entry.adjustment.stages.map((s) => [s.approver.openId, s.approver]),
        ).values(),
      ]) {
        entry = this.ledger.get(id)!;
        if (!['routing', 'pending'].includes(entry.adjustment.state)) break;
        if (
          entry.messages.some(
            (m) => m.kind === 'approval' && m.openId === person.openId,
          )
        )
          continue;
        const uuid = messageUuid(id, 'approval', person.openId);
        this.maintainClaim(id);
        const messageId = await this.messages.sendInteractiveCard(
          person.openId,
          thresholdAdjustmentCard(entry.adjustment, person.openId),
          uuid,
        );
        this.ledger.change(id, (e) => {
          e.messages.push({
            openId: person.openId,
            messageId,
            uuid,
            kind: 'approval',
            patchedRevision: entry.adjustment.revision,
          });
          e.adjustment.revision++;
        });
        await this.syncBase(id);
      }
      this.ledger.change(id, (e) => {
        if (e.adjustment.state === 'routing') {
          e.adjustment.state = 'pending';
          e.adjustment.revision++;
        }
      });
    }
    entry = this.ledger.get(id)!;
    if (entry.adjustment.state === 'approved')
      this.ledger.change(id, (e) => {
        e.adjustment.state = 'awaiting_completion';
        e.adjustment.execution = {
          round: 1,
          nextReminderAt: e.adjustment.plannedAt,
          replies: [],
        };
        e.adjustment.revision++;
      });
    entry = this.ledger.get(id)!;
    if (entry.adjustment.state === 'awaiting_completion') {
      const a = entry.adjustment;
      for (const person of [
        ...new Map(
          [a.applicant, ...a.managers].map((p) => [p.openId, p]),
        ).values(),
      ]) {
        if (
          this.ledger
            .get(id)!
            .messages.some(
              (m) =>
                (m.kind === 'approval' && m.openId === person.openId) ||
                (m.kind === 'approval_result' && m.openId === person.openId),
            )
        )
          continue;
        this.maintainClaim(id);
        const uuid = messageUuid(id, 'approval-result', person.openId),
          messageId = await this.messages.sendInteractiveCard(
            person.openId,
            thresholdAdjustmentCard(a, person.openId),
            uuid,
          );
        this.ledger.change(id, (e) => {
          e.messages.push({
            openId: person.openId,
            messageId,
            uuid,
            kind: 'approval_result',
            patchedRevision: a.revision,
          });
        });
      }
      if (
        Date.parse(a.execution!.nextReminderAt) <= Date.now() &&
        !entry.messages.some(
          (m) => m.kind === 'confirmation' && m.round === a.execution!.round,
        )
      ) {
        const uuid = messageUuid(
          id,
          `confirmation-${a.execution!.round}`,
          a.engineer.openId,
        );
        this.maintainClaim(id);
        const messageId = await this.messages.sendInteractiveCard(
          a.engineer.openId,
          thresholdAdjustmentCard(a, a.engineer.openId, undefined, true),
          uuid,
        );
        this.ledger.change(id, (e) => {
          e.messages.push({
            openId: a.engineer.openId,
            messageId,
            uuid,
            kind: 'confirmation',
            round: a.execution!.round,
            patchedRevision: a.revision,
          });
        });
      }
    }
    entry = this.ledger.get(id)!;
    if (['confirmed', 'applying'].includes(entry.adjustment.state)) {
      if (
        !entry.adjustment.stages.every((s) => s.decision?.action === 'approve')
      )
        throw new ConflictException('缺少双审批决议，禁止更新阈值');
      const a = entry.adjustment;
      if (!entry.adjustment.execution?.replies.some((r) => r.completed))
        throw new ConflictException('缺少工程师完成确认，禁止更新阈值');
      this.ledger.change(id, (e) => {
        if (e.adjustment.state === 'confirmed') {
          e.adjustment.state = 'applying';
          e.adjustment.revision++;
        }
      });
      try {
        const result = this.records.mutate(
          {
            operation: 'update',
            clientMutationId: `approved-${id}`,
            id: a.before.id,
            expectedVersion: a.before.version,
            expectedContent: thresholdContentFingerprint(a.before),
            record: { ...a.before, value: a.value },
          },
          `threshold-approval:${id}`,
        );
        this.sync.kick();
        const sync = this.records.syncResults([result.clientMutationId])[0]
          ?.sync;
        if (sync?.state === 'error')
          throw new Error(sync.error || '设备参数多维表同步失败');
        if (sync?.state === 'cancelled')
          throw new ConflictException('设备参数同步已取消');
        if (sync && sync.state !== 'success') return;
        this.ledger.change(id, (e) => {
          e.adjustment.appliedRecord = result.record!;
          e.adjustment.state = 'completed';
          e.adjustment.error = undefined;
          e.adjustment.revision++;
        });
      } catch (error) {
        if (!(error instanceof ConflictException)) throw error;
        this.ledger.change(id, (e) => {
          e.adjustment.state = 'conflict';
          e.adjustment.error = '阈值在审批期间已变化，本申请未生效，请重新申请';
          e.adjustment.revision++;
        });
      }
    }
    entry = this.ledger.get(id)!;
    for (const receipt of entry.messages.filter(
      (m) => m.patchedRevision < entry.adjustment.revision,
    )) {
      const current = this.ledger.get(id)!;
      const confirmationEnabled =
        receipt.kind === 'confirmation' &&
        receipt.round === current.adjustment.execution?.round &&
        !current.adjustment.execution.replies.some(
          (r) => r.messageId === receipt.messageId,
        );
      this.maintainClaim(id);
      await this.messages.patchInteractiveCard(
        receipt.messageId,
        thresholdAdjustmentCard(
          current.adjustment,
          receipt.openId,
          undefined,
          confirmationEnabled,
        ),
      );
      this.ledger.change(id, (e) => {
        const message = e.messages.find(
          (m) => m.messageId === receipt.messageId,
        )!;
        message.patchedRevision = current.adjustment.revision;
      });
    }
    entry = this.ledger.get(id)!;
    if (
      ['completed', 'rejected', 'conflict'].includes(entry.adjustment.state)
    ) {
      const a = entry.adjustment;
      const recipients = [
        a.applicant,
        a.engineer,
        ...a.stages.map((s) => s.approver),
        ...(a.state === 'completed' ? a.managers : []),
      ];
      for (const person of [
        ...new Map(recipients.map((p) => [p.openId, p])).values(),
      ]) {
        if (
          this.ledger.get(id)!.messages.some((m) => m.openId === person.openId)
        )
          continue;
        this.maintainClaim(id);
        const uuid = messageUuid(id, 'result', person.openId),
          messageId = await this.messages.sendInteractiveCard(
            person.openId,
            thresholdAdjustmentCard(a, person.openId),
            uuid,
          );
        this.ledger.change(id, (e) => {
          e.messages.push({
            openId: person.openId,
            messageId,
            uuid,
            kind: 'result',
            patchedRevision: a.revision,
          });
        });
      }
    }
    this.ledger.change(id, (e) => {
      if (e.adjustment.syncState !== 'success') {
        e.adjustment.syncState = 'success';
        e.adjustment.revision++;
      }
      if (e.adjustment.state !== 'conflict') e.adjustment.error = undefined;
    });
    await this.syncBase(id, true);
  }
  private async syncBase(id: string, force = false) {
    this.maintainClaim(id);
    const entry = this.ledger.get(id)!;
    if (!force && entry.cloudRevision === entry.adjustment.revision) return;
    const recordId = await this.gateway.sync(entry);
    this.ledger.change(id, (e) => {
      e.cloudRecordId = recordId;
      e.cloudRevision = entry.adjustment.revision;
    });
  }
  private maintainClaim(id: string) {
    if (this.stopped)
      throw new ConflictException('审批服务正在关闭，待办已保留');
    this.ledger.change(id, (e) => {
      if (e.lease?.owner !== this.owner)
        throw new ConflictException('审批同步任务已由其他进程接管');
      e.lease.until = Date.now() + 180000;
    });
  }
}
function resolveApplicant(
  context: ThresholdAdjustmentContext,
  principal: AccessPrincipal,
): ThresholdPerson | undefined {
  const appId = getFeishuAuthPayload().app_id;
  const person = context.roles.find(
    (p) =>
      principal.accountId ===
      `feishu-${feishuIdentityFingerprint(appId, p.openId)}`,
  );
  return person ? { openId: person.openId, name: person.name } : undefined;
}
function uniquePerson(
  people: ThresholdPerson[],
  role: string,
): ThresholdPerson {
  const distinct = [
    ...new Map(
      people.map((p) => [p.openId, { openId: p.openId, name: p.name }]),
    ).values(),
  ];
  if (distinct.length !== 1)
    throw new ConflictException(`${role}人员配置缺失或不唯一，请核对组织架构`);
  return distinct[0];
}
function messageUuid(id: string, kind: string, openId: string) {
  const h = createHash('sha256')
    .update(`${id}:${kind}:${openId}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
