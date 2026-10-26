import { BadRequestException, ForbiddenException, HttpException, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { AccessRole } from '../../../shared/access-control.interface';
import type { AlarmReviewPerson, AlarmReviewTask } from '../../../shared/today-operations-alarm-review.interface';
import { AlarmReviewGateway } from './alarm-review.gateway';
import { AlarmReviewStore } from './alarm-review.store';
import { normalizeAlarmReviewRequest, reviewVersion } from './alarm-review.rules';
import { BitableSyncService } from './bitable-sync.service';
import { TodayOperationsAlarmService } from './today-operations-alarm.service';

@Injectable()
export class AlarmReviewService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlarmReviewService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private stopped = false;
  constructor(private readonly store: AlarmReviewStore, private readonly gateway: AlarmReviewGateway,
    private readonly people: BitableSyncService, private readonly alarms: TodayOperationsAlarmService) {}
  onModuleInit(): void {
    this.timer = setInterval(() => { void this.processReady().catch(() => this.logger.warn('人工复核后台任务未完成，账本保留，等待恢复')); }, 3000);
    this.timer.unref();
  }
  onModuleDestroy(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); }
  async candidates(role: AccessRole): Promise<AlarmReviewPerson[]> {
    this.authorize(role);
    const directory = await this.people.getCachedActivePersonnelDirectory();
    return directory.personnel.map(({ recordId, name, position, buildings }) => ({ recordId, name, position, buildings }));
  }
  async submit(input: unknown, role: AccessRole, principal: string): Promise<AlarmReviewTask> {
    this.authorize(role, principal);
    const request = normalizeAlarmReviewRequest(input);
    const directory = await this.people.getCachedActivePersonnelDirectory();
    const person = directory.personnel.find((entry) => entry.recordId === request.responsibleRecordId && entry.openId);
    if (!person) throw new BadRequestException('请选择可关联飞书身份的在职示例人员019');
    return this.store.create(request, person.name, person.openId, principal);
  }
  status(id: string, role: AccessRole, principal: string): AlarmReviewTask {
    this.authorize(role, principal); return this.store.get(id, principal);
  }
  retry(id: string, role: AccessRole, principal: string): AlarmReviewTask {
    this.authorize(role, principal); return this.store.retry(id, principal);
  }
  recover(clientMutationId: string, role: AccessRole, principal: string): AlarmReviewTask | null {
    this.authorize(role, principal);
    if (!/^alarm-review-[A-Za-z0-9_-]{8,100}$/.test(clientMutationId)) throw new BadRequestException('复核提交标识无效');
    return this.store.findByMutation(clientMutationId, principal);
  }
  async processReady(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (const task of this.store.listReady()) {
        if (this.stopped) break;
        const lease = this.store.claim(task.id);
        if (!lease) continue;
        try {
          let userId = '';
          let preparationError: string | null = null;
          try {
            await this.gateway.preflight();
            userId = await this.gateway.resolveResponsibleUserId(task.userId);
          } catch (error) { preparationError = safeError(error); }
          for (const item of task.items) {
            if (item.state === 'success' || item.state === 'error') continue;
            if (this.stopped) break;
            try {
              if (preparationError) throw new BadRequestException(preparationError);
              const fields = await this.gateway.syncRecord(item.recordId, task.outcome, userId, task.request.expectedVersions?.[item.recordId] || 'unreviewed', task.customReply);
              this.store.finishItem(task.id, lease, item.recordId, null, { outcome: task.outcome, ...(task.customReply ? { customReply: task.customReply } : {}), responsibleName: task.responsibleName, version: reviewVersion(fields) });
              this.alarms.patchHumanReview(item.recordId, fields);
            } catch (error) { this.store.finishItem(task.id, lease, item.recordId, safeError(error)); }
          }
        } finally { this.store.release(task.id, lease); }
      }
    } finally { this.busy = false; }
  }
  private authorize(role: AccessRole, principal?: string): void {
    if (!['admin', 'editor'].includes(role) || principal === '') throw new ForbiddenException('当前登录身份没有异常复核权限');
  }
}
function safeError(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    const message = typeof response === 'string' ? response : (response as { message?: unknown }).message;
    if (typeof message === 'string' && message.length < 200) return message;
  }
  return '复核同步未确认，请稍后核对并重试；未更改原告警处理信息';
}
