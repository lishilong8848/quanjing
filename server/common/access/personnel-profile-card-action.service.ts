import type { ProfileChangeStatus } from '../../../shared/personnel-profile-change.interface';
import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  ServiceUnavailableException,
  HttpException,
  Logger,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { AccessConfigurationService } from './access-configuration.service';
import { PersonnelProfileChangesService } from './personnel-profile-changes.service';
import { PersonnelProfileChangesStore } from './personnel-profile-changes.store';
import { PersonnelProfileNotificationsService } from './personnel-profile-notifications.service';
import { PersonnelProfileNotificationStore } from './personnel-profile-notification.store';
import {
  PersonnelProfileCardActionStore,
  type ProfileCardActionJob,
} from './personnel-profile-card-action.store';
import { FeishuCardCallbackFeedbackService } from '../feishu-card-callback-feedback.service';
import { assertFeishuBusinessIdentity } from './feishu-business-identity';
import {
  runHotfixInitialization,
  cancelHotfixInitialization,
} from '../hotfix-runtime-activation';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const enabled = () =>
  process.env.NODE_ENV === 'production' &&
  !/^(1|true|yes|on)$/i.test(process.env.NANTONG_HOTFIX_SMOKE_MODE || '');
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function statusCard(status: ProfileChangeStatus | 'processing') {
  const labels: Record<ProfileChangeStatus | 'processing', string> = {
    pending: '待审核',
    processing: '审核已受理，正在核对资料',
    approved: '已批准，等待资料同步',
    uploading: '照片同步中',
    writing: '资料同步中',
    completed: '资料已更新',
    rejected: '已驳回',
    cancelled: '已撤回',
    conflict: '资料已变化，请在平台核对',
    reconciliation: '处理结果待核对',
  };
  return {
    type: 'raw' as const,
    data: {
      config: { update_multi: true },
      header: {
        template:
          status === 'completed'
            ? 'green'
            : status === 'processing'
              ? 'blue'
              : 'grey',
        title: {
          tag: 'plain_text',
          content: '个人资料变更 · ' + labels[status],
        },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'plain_text',
            content:
              status === 'processing'
                ? '审核操作已受理，请勿重复操作。最终处理结果将同步到此卡片。'
                : labels[status],
          },
        },
      ],
    },
  };
}
export function parseProfileReviewCard(payload: unknown) {
  if (
    !object(payload) ||
    (payload.event_type !== undefined &&
      payload.event_type !== 'card.action.trigger') ||
    !object(payload.action) ||
    !object(payload.action.value) ||
    !object(payload.operator) ||
    !object(payload.context)
  )
    throw new BadRequestException('资料审批卡片格式无效');
  const value = payload.action.value;
  if (
    Object.keys(value).sort().join(',') !==
      ['workflowType', 'action', 'requestId', 'expectedVersion', 'decision']
        .sort()
        .join(',') ||
    value.workflowType !== 'profile_change' ||
    value.action !== 'profile_change_review' ||
    typeof value.requestId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.requestId) ||
    !Number.isSafeInteger(value.expectedVersion) ||
    Number(value.expectedVersion) < 1 ||
    typeof value.decision !== 'string' ||
    !['approve', 'reject'].includes(value.decision)
  )
    throw new BadRequestException('资料审批按钮已失效，请刷新');
  const openId = payload.operator.open_id,
    messageId = payload.context.open_message_id;
  if (
    typeof openId !== 'string' ||
    !/^ou_[A-Za-z0-9_-]+$/.test(openId) ||
    typeof messageId !== 'string' ||
    !/^om_[A-Za-z0-9_-]+$/.test(messageId)
  )
    throw new ForbiddenException('原卡片或操作人身份无法核对');
  let reason: string | undefined;
  if (value.decision === 'reject') {
    const form = payload.action.form_value;
    if (
      !object(form) ||
      Object.keys(form).some((key) => key !== 'rejection_reason') ||
      typeof form.rejection_reason !== 'string' ||
      !form.rejection_reason.trim() ||
      form.rejection_reason.trim().length > 1000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(
        form.rejection_reason,
      )
    )
      throw new BadRequestException('请填写1至1000字的驳回原因');
    reason = form.rejection_reason.trim();
  } else if (payload.action.form_value !== undefined)
    throw new BadRequestException('同意操作不能携带驳回表单');
  return {
    reason,
    requestId: value.requestId,
    expectedVersion: Number(value.expectedVersion),
    decision: value.decision as 'approve' | 'reject',
    openId,
    messageId,
  };
}
@Injectable()
export class PersonnelProfileCardActionService {
  private store?: PersonnelProfileCardActionStore;
  private deliveryStore?: PersonnelProfileNotificationStore;
  private active = false;
  private timer?: NodeJS.Timeout;
  private wakeTimer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private logger = new Logger(PersonnelProfileCardActionService.name);
  constructor(
    private readonly configuration: AccessConfigurationService,
    private readonly changes: PersonnelProfileChangesService,
    private readonly requests: PersonnelProfileChangesStore,
    private readonly notifications: PersonnelProfileNotificationsService,
    private readonly feedback: FeishuCardCallbackFeedbackService,
  ) {}
  isEnabled() {
    return enabled();
  }
  async onModuleInit() {
    if (!enabled()) return;
    const base = dirname(
      resolve(
        process.env.ACCESS_CONFIGURATION_FILE ||
          join(process.cwd(), '.runtime', 'access-configuration.json'),
      ),
    );
    try {
      this.store = new PersonnelProfileCardActionStore(
        join(base, 'personnel-profile-card-actions.json'),
      );
      this.deliveryStore = new PersonnelProfileNotificationStore(
        join(base, 'personnel-profile-notifications.json'),
      );
      this.store.read();
    } catch {
      this.logger.warn('资料卡片审批任务暂不可读，请在平台核对');
      return;
    }
    await runHotfixInitialization(this, () => {
      this.active = true;
      this.timer = setInterval(() => this.wake(), 30000);
      this.timer.unref();
      this.wake();
    });
  }
  async onModuleDestroy() {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    await cancelHotfixInitialization(this);
    if (this.running) await this.running;
  }
  private principal(openId: string, appId: string) {
    assertFeishuBusinessIdentity(this.configuration, openId);
    const candidates = this.configuration
      .snapshot()
      .accounts.filter(
        (a) =>
          a.kind === 'feishu' &&
          a.appId === appId &&
          a.identityHash === hash(`${appId}\0${openId}`) &&
          a.role === 'admin' &&
          a.enabled &&
          !a.deleted &&
          !a.reactivationRequired &&
          !a.permissionsRevoked &&
          a.personnelActive !== false,
      );
    if (candidates.length !== 1)
      throw new ForbiddenException('仅当前系统管理员可以审核');
    const account = candidates[0];
    const principal = this.configuration.currentPrincipal(
      account.id,
      account.version,
    );
    if (!principal || principal.role !== 'admin' || principal.impersonation)
      throw new ForbiddenException('管理员权限已变化');
    return principal;
  }
  private original(
    requestId: string,
    messageId: string,
    accountId: string,
    openId: string,
    appId: string,
    decision?: string,
  ) {
    const job = this.deliveryStore!.read().jobs[requestId];
    const delivery = job?.deliveries.find(
      (d) =>
        d.messageId === messageId &&
        d.accountId === accountId &&
        d.openId === openId &&
        d.status !== 'cancelled',
    );
    if (job?.appId !== appId || !delivery)
      throw new ForbiddenException(
        '只能从本人收到的原审批卡办理，只读副本不可操作',
      );
    if (
      decision === 'approve' &&
      (delivery as { approveAvailable?: boolean }).approveAvailable !== true
    )
      throw new ForbiddenException('卡片资料预览尚未完整，请在平台核对后审批');
  }
  handle(payload: unknown) {
    if (!this.active || !enabled() || !this.store || !this.deliveryStore)
      throw new ServiceUnavailableException('资料审批服务尚未就绪，请稍后重试');
    const action = parseProfileReviewCard(payload),
      appId = process.env.FEISHU_APP_ID?.trim() || '';
    const principal = this.principal(action.openId, appId);
    this.original(
      action.requestId,
      action.messageId,
      principal.accountId!,
      action.openId,
      appId,
      action.decision,
    );
    const state = this.changes.assertCardReview(principal, action.requestId);
    if (state.status !== 'pending') {
      this.notifications.wake();
      return {
        toast: {
          type: 'info' as const,
          content: '该申请已处理，请查看卡片最新状态',
        },
        card: statusCard(state.status),
      };
    }
    if (state.version !== action.expectedVersion)
      throw new ConflictException('申请已变化，请从最新卡片或平台审核');
    const id = hash(
      JSON.stringify([
        'profile-card-review',
        appId,
        action.requestId,
        action.expectedVersion,
        action.decision,
        principal.accountId,
        action.reason || '',
      ]),
    );
    this.store.update((s) => {
      const previous = s.tasks[id];
      const competing = Object.values(s.tasks).find(
        (t) =>
          t.id !== id &&
          t.requestId === action.requestId &&
          t.expectedVersion === action.expectedVersion &&
          ['queued', 'running', 'completed'].includes(t.status),
      );
      if (competing)
        throw new ConflictException('该申请已有审核操作正在处理，请勿重复选择');
      if (previous) {
        if (previous.status === 'failed') {
          previous.status = 'queued';
          previous.nextAttemptAt = 0;
          previous.actorVersion = principal.authorizationVersion!;
        }
        return;
      }
      s.tasks[id] = {
        id,
        appId,
        requestId: action.requestId,
        expectedVersion: action.expectedVersion,
        decision: action.decision,
        ...(action.reason ? { reason: action.reason } : {}),
        actorAccountId: principal.accountId!,
        actorVersion: principal.authorizationVersion!,
        operatorOpenId: action.openId,
        messageId: action.messageId,
        mutationId: id,
        status: 'queued',
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: Date.now(),
      };
    });
    this.wake();
    return {
      toast: {
        type: 'info' as const,
        content: '审核操作已受理，正在核对资料，请勿重复点击',
      },
      card: statusCard('processing'),
    };
  }
  private wake() {
    if (!this.active || !enabled() || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      void this.flush();
    }, 0);
    this.wakeTimer.unref();
  }
  flush(): Promise<void> {
    if (this.running) return this.running;
    if (!this.active || !enabled() || !this.store) return Promise.resolve();
    const task = this.drain()
      .catch(() => this.logger.warn('资料卡片审批任务待恢复'))
      .finally(() => {
        if (this.running === task) this.running = undefined;
      });
    this.running = task;
    return task;
  }
  private async drain() {
    for (const job of Object.values(this.store!.read().tasks)
      .filter(
        (j) =>
          (['queued', 'running'].includes(j.status) ||
            j.cardRefreshPending === true) &&
          j.nextAttemptAt <= Date.now(),
      )
      .slice(0, 20)) {
      if (!this.active) return;
      await this.store!.withTask(job.id, () => this.execute(job.id));
    }
  }
  private syncOriginal(job: ProfileCardActionJob) {
    try {
      this.deliveryStore!.update((state) => {
        const delivery = state.jobs[job.requestId]?.deliveries.find(
          (d) =>
            d.messageId === job.messageId &&
            d.accountId === job.actorAccountId &&
            d.openId === job.operatorOpenId,
        );
        if (
          !delivery ||
          delivery.status === 'cancelled' ||
          delivery.status === 'attention'
        )
          return;
        delivery.status = 'queued';
        delete delivery.syncedVersion;
        delivery.nextAttemptAt = 0;
      });
      this.store!.update((state) => {
        delete state.tasks[job.id].cardRefreshPending;
      });
      this.notifications.wake();
    } catch {
      this.logger.warn('资料审批结果已保留，原卡片待同步');
    }
  }
  private async execute(id: string) {
    const job = this.store!.read().tasks[id];
    if (!job || !this.active) return;
    if (!['queued', 'running'].includes(job.status)) {
      if (job.cardRefreshPending) this.syncOriginal(job);
      return;
    }
    const input = {
      requestId: job.requestId,
      expectedVersion: job.expectedVersion,
      clientMutationId: job.mutationId,
      decision: job.decision,
      comment:
        job.decision === 'approve' ? '飞书卡片同意整单资料修改' : job.reason!,
    };
    this.store!.update((state) => {
      state.tasks[id].status = 'running';
      state.tasks[id].attempts++;
    });
    try {
      if (this.changes.hasCardReviewReceipt(job.actorAccountId, input)) {
        this.store!.update((state) => {
          state.tasks[id].status = 'completed';
          state.tasks[id].cardRefreshPending = true;
          delete state.tasks[id].error;
        });
        this.syncOriginal(job);
        return;
      }
      if (job.appId !== process.env.FEISHU_APP_ID?.trim())
        throw new ForbiddenException('应用身份已变化');
      const principal = this.principal(job.operatorOpenId, job.appId);
      if (
        principal.accountId !== job.actorAccountId ||
        principal.authorizationVersion !== job.actorVersion
      )
        throw new ForbiddenException('管理员权限已变化');
      this.original(
        job.requestId,
        job.messageId,
        job.actorAccountId,
        job.operatorOpenId,
        job.appId,
        job.decision,
      );
      this.changes.assertCardReview(principal, job.requestId);
      await this.changes.review(principal, input);
      this.store!.update((s) => {
        s.tasks[id].status = 'completed';
        s.tasks[id].cardRefreshPending = true;
        delete s.tasks[id].error;
      });
      this.syncOriginal(job);
    } catch (error) {
      const transient =
        !(error instanceof HttpException) ||
        error.getStatus() >= 500 ||
        error.getStatus() === 429;
      const attempts = this.store!.read().tasks[id].attempts;
      this.store!.update((s) => {
        const target = s.tasks[id];
        target.status = transient && attempts < 3 ? 'queued' : 'failed';
        if (target.status === 'failed') target.cardRefreshPending = true;
        target.nextAttemptAt = Date.now() + 30000;
        target.error =
          error instanceof HttpException && error.getStatus() < 500
            ? error.message.slice(0, 200)
            : '审核结果待核对，请在平台资料变更审批中查看';
      });
      if (!transient || attempts >= 3) {
        this.syncOriginal(job);
        await this.feedback.enqueueLateFailure(
          {
            operator: { open_id: job.operatorOpenId },
            context: { open_message_id: job.messageId },
            action: {
              value: {
                workflowType: 'profile_change',
                action: 'profile_change_review',
                requestId: job.requestId,
                expectedVersion: job.expectedVersion,
                decision: job.decision,
              },
            },
          },
          'profile_change',
          error instanceof HttpException &&
            [400, 401, 403].includes(error.getStatus())
            ? new ConflictException('资料审核未完成，请在平台核对或联系管理员')
            : error,
        );
        this.notifications.wake();
      }
    }
  }
}
