import { ForbiddenException, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { assertFeishuBusinessIdentity } from '../../common/access/feishu-business-identity';
import { currentHotfixActivation } from '../../common/hotfix-runtime-activation';
import { hasBusinessPermissionSomewhere, personalPermissionPagePaths } from '../../../shared/business-permissions';
import { TodayOperationsAnomalyGateway } from './today-operations-anomaly.gateway';
import { TodayOperationsFollowUpCardStore } from './today-operations-follow-up-card.store';
import { parseFollowUpCardAction } from './today-operations-follow-up-card.callback';
import { buildFollowUpEditCard, buildFollowUpListCard, buildFollowUpProcessingCard, buildFollowUpResultCard, buildFollowUpNavigationErrorCard } from './today-operations-follow-up-card';
import type { FollowUpCardCommand, FollowUpCardSnapshot } from './today-operations-follow-up-card.types';

@Injectable()
export class TodayOperationsFollowUpCardService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TodayOperationsFollowUpCardService.name);
  private timer?: ReturnType<typeof setInterval>;
  private activeWork: Promise<void> | null = null;
  private readonly messageUpdates = new Map<string, Promise<void>>();
  private readonly navigation = new Map<string, object>();

  constructor(
    private readonly store: TodayOperationsFollowUpCardStore,
    private readonly gateway: TodayOperationsAnomalyGateway,
    private readonly configuration: AccessConfigurationService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => this.schedulePendingTasks(), 15_000);
    this.timer.unref();
    this.schedulePendingTasks();
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  isEnabled(): boolean { return process.env.NANTONG_DAILY_PATROL_ENABLED?.trim().toLowerCase() !== 'false'; }

  async prepare(recordIds: string[], identity: string): Promise<string> {
    const appId = process.env.FEISHU_APP_ID?.trim();
    if (!appId) throw new ServiceUnavailableException('飞书应用尚未配置');
    const ids = [...new Set(recordIds)].sort();
    if (ids.length > 1_000) throw new ServiceUnavailableException('本次异常记录过多，请分批处理');
    const records = [];
    for (let index = 0; index < ids.length; index += 2) {
      records.push(...await Promise.all(ids.slice(index, index + 2).map(id => this.gateway.getFollowUp(id))));
    }
    const id = createHash('sha256').update(JSON.stringify(['followup-card-v1', appId, identity, ids])).digest('hex').slice(0, 32);
    await this.store.prepareBatch(id, appId, records);
    return id;
  }

  bindMessage(batchId: string, messageId: string, summary: Record<string, unknown>): Promise<void> {
    return this.store.bindMessage(batchId, messageId, summary);
  }

  async handle(payload: unknown): Promise<{
    toast: { type: 'info'; content: string };
    card?: Record<string, unknown>;
  }> {
    const action = parseFollowUpCardAction(payload);
    const principal = this.actor(action.actorOpenId, action.kind === 'submit' ? 'update' : 'read');
    const snapshot = await this.store.getSnapshot(action.batchId, action.messageId);
    this.assertApp(snapshot);
    if (action.kind === 'view') {
      if (action.action === 'edit' && !snapshot.records[action.index]) throw new ForbiddenException('异常记录不在此卡片范围内');
      const view = action.action === 'edit' ? { kind: 'edit' as const, index: action.index }
        : action.action === 'list' ? { kind: 'list' as const, page: action.page } : { kind: 'summary' as const };
      await this.store.setView(action.batchId, action.messageId, view);
      const marker = {};
      this.navigation.set(action.messageId, marker);
      setImmediate(() => {
        void this.enqueueMessage(action.messageId, async () => {
          if (this.navigation.get(action.messageId) !== marker) return;
          if (action.action === 'edit') {
            const record = await this.gateway.getFollowUp(snapshot.records[action.index].record.recordId);
            await this.store.refreshRecord(action.batchId, action.messageId, record);
          }
          if (this.navigation.get(action.messageId) !== marker) return;
          this.actor(action.actorOpenId, 'read');
          const current = await this.store.getSnapshot(action.batchId, action.messageId);
          this.assertApp(current);
          await this.gateway.patchInteractiveCard(action.messageId, this.render(current, this.canUpdate(action.actorOpenId)));
        }).catch(async error => {
          this.logger.warn(`异常跟进卡片打开失败，可从原按钮重试：${safeError(error)}`);
          if (action.action !== 'edit') return;
          const index = action.index;
          await this.enqueueMessage(action.messageId, async () => {
            if (this.navigation.get(action.messageId) !== marker) return;
            this.actor(action.actorOpenId, 'read');
            const current = await this.store.getSnapshot(action.batchId, action.messageId);
            this.assertApp(current);
            if (current.message?.view.kind !== 'edit' || current.message.view.index !== index) return;
            const row = current.records[index];
            if (!row) return;
            const fallback = row.pendingCommandId || row.record.completed
              ? this.render(current, this.canUpdate(action.actorOpenId))
              : buildFollowUpNavigationErrorCard(action.batchId, row, index);
            await this.gateway.patchInteractiveCard(action.messageId, fallback);
          }).catch(fallbackError => this.logger.warn(`异常跟进打开失败提示未更新，可从原按钮重试：${safeError(fallbackError)}`));
        })
          .finally(() => { if (this.navigation.get(action.messageId) === marker) this.navigation.delete(action.messageId); });
      });
      return { toast: { type: 'info', content: action.action === 'edit' ? '正在打开填写卡片' : '正在更新卡片' } };
    }
    if (snapshot.message?.view.kind !== 'edit' || snapshot.message.view.index !== action.index) {
      throw new ConflictException('卡片页面已切换，请重新打开该记录后提交');
    }
    const claimed = await this.store.claim({
      ...action, actorName: principal.displayName || '平台账号',
    });
    this.schedulePendingTasks();
    if (claimed.snapshot.message?.view.kind !== 'edit' || claimed.snapshot.message.view.index !== action.index) {
      return { toast: { type: 'info', content: '该记录已受理，已保留当前卡片页面' } };
    }
    if (claimed.command.stage === 'conflict') {
      return { toast: { type: 'info', content: '记录已被更新，当前填写已保留；卡片同步完成后请重试' } };
    }
    const row = claimed.snapshot.records[action.index];
    const card = claimed.command.stage === 'written' ? this.render(claimed.snapshot, true)
      : claimed.command.stage === 'completed' ? buildFollowUpResultCard(action.batchId, row, action.index)
        : buildFollowUpProcessingCard(row.record, claimed.command.update);
    return { toast: { type: 'info', content: claimed.claimed ? '跟进已受理，正在同步' : '该记录已受理，请勿重复提交' }, card };
  }

  schedulePendingTasks(): void {
    setImmediate(() => {
      if (!currentHotfixActivation().isAcceptingNewWork()) return;
      void this.runPendingTasks().catch(error => this.logger.error(`异常跟进后台同步失败：${safeError(error)}`));
    });
  }

  runPendingTasks(): Promise<void> {
    if (this.activeWork) return this.activeWork;
    this.activeWork = this.processPending().finally(() => { this.activeWork = null; });
    return this.activeWork;
  }

  private async processPending(): Promise<void> {
    for (const command of await this.store.pendingCommands()) {
      try {
        if (command.stage === 'pending') {
          try {
            const result = await this.gateway.updateFollowUp(command.update, command.expected);
            await this.store.markWritten(command.id, result);
            command.stage = 'written';
          } catch (error) {
            if (!(error instanceof ConflictException)) throw error;
            const current = await this.gateway.getFollowUp(command.recordId);
            await this.store.markConflict(command.id, current, '记录已被更新，请核对后重新提交');
            command.stage = 'conflict';
          }
        }
        await this.patchCommandCopies(command);
        await this.store.complete(command.id);
      } catch (error) {
        await this.store.recordFailure(command.id, safeError(error));
        this.logger.warn(`异常跟进同步尚未完成，后台将继续重试：${safeError(error)}`);
        if (command.stage === 'pending') {
          await this.enqueueMessage(command.sourceMessageId, async () => {
            const current = await this.store.getSnapshot(command.batchId, command.sourceMessageId);
            const index = current.records.findIndex(row => row.record.recordId === command.recordId);
            if (current.message?.view.kind !== 'edit' || current.message.view.index !== index) return;
            const row = { ...current.records[index], record: { ...current.records[index].record, treatmentMeasure: command.update.treatmentMeasure } };
            await this.gateway.patchInteractiveCard(command.sourceMessageId,
              buildFollowUpResultCard(command.batchId, row, index, '暂未确认同步结果，本次填写已保留，后台将重试'));
          }).catch(patchError => this.logger.warn(`同步提示更新失败：${safeError(patchError)}`));
        }
      }
    }
  }

  private async patchCommandCopies(command: FollowUpCardCommand): Promise<void> {
    for (const target of await this.store.messagesForRecord(command.recordId)) {
      if (command.patchedMessageIds.includes(target.messageId)) continue;
      await this.enqueueMessage(target.messageId, async () => {
        let snapshot: FollowUpCardSnapshot;
        try { snapshot = await this.store.getSnapshot(target.snapshot.batch.id, target.messageId); }
        catch (error) { if (error instanceof ForbiddenException) return; throw error; }
        const view = snapshot.message!.view;
        const index = snapshot.records.findIndex(row => row.record.recordId === command.recordId);
        // A different record's unfinished form is left alone; its own revision still protects submission.
        if (view.kind === 'summary' || (view.kind === 'edit' && view.index !== index)) return;
        const row = { ...snapshot.records[index], pendingCommandId: undefined };
        const card = command.stage === 'conflict' && view.kind === 'edit'
          ? buildFollowUpEditCard(snapshot.batch.id, row, index, { draft: command.update, error: '记录已被更新，请核对后重新提交' })
          : view.kind === 'edit'
            ? buildFollowUpResultCard(snapshot.batch.id, row, index)
            : buildFollowUpListCard(snapshot.batch.id, snapshot.records.map((item, position) => position === index ? row : item), view.page, true);
        await this.gateway.patchInteractiveCard(target.messageId, card);
      });
      await this.store.markPatched(command.id, target.messageId);
    }
  }

  private render(snapshot: FollowUpCardSnapshot, canUpdate: boolean): Record<string, unknown> {
    const view = snapshot.message!.view;
    if (view.kind === 'summary') return snapshot.message!.summary;
    const commands = new Map((snapshot.pendingCommands || []).map(command => [command.id, command]));
    const rows = snapshot.records.map(row => {
      const command = commands.get(row.pendingCommandId || '');
      return command && (command.stage === 'written' || command.stage === 'conflict')
        ? { ...row, pendingCommandId: undefined } : row;
    });
    if (view.kind === 'list') return buildFollowUpListCard(snapshot.batch.id, rows, view.page, canUpdate);
    const row = rows[view.index];
    if (!row) throw new ForbiddenException('异常记录不在此卡片范围内');
    const command = commands.get(snapshot.records[view.index].pendingCommandId || '');
    if (row.pendingCommandId) return buildFollowUpProcessingCard(row.record, command?.update || row.record);
    const error = command?.stage === 'conflict' ? '记录已被更新，请核对后重新提交' : undefined;
    return row.record.completed || !canUpdate || command?.stage === 'written'
      ? buildFollowUpResultCard(snapshot.batch.id, row, view.index, error)
      : buildFollowUpEditCard(snapshot.batch.id, row, view.index, { ...(error ? { draft: command!.update, error } : {}) });
  }

  private actor(openId: string, action: 'read' | 'update') {
    assertFeishuBusinessIdentity(this.configuration, openId);
    const principal = this.configuration.feishuPrincipal(openId, process.env.FEISHU_APP_ID?.trim() || '');
    if (!principal) throw new ForbiddenException('当前飞书账号未配置异常跟进权限');
    const allowed = principal.effectiveAuthorization
      ? hasBusinessPermissionSomewhere(principal, { module: 'today_operations', action })
      : action === 'update' ? ['admin', 'editor'].includes(principal.role)
        : principal.role === 'admin' || personalPermissionPagePaths(principal,
          this.configuration.pagePermissions(principal.role, principal.accountId, principal.authorizationVersion).paths)
          .some(path => ['/monthly-schedule', '/today-operations-panorama'].includes(path));
    if (!allowed || (!principal.effectiveAuthorization && principal.role === 'guest')) throw new ForbiddenException('当前账号暂无异常跟进权限');
    return principal;
  }

  private canUpdate(openId: string): boolean {
    try { this.actor(openId, 'update'); return true; } catch { return false; }
  }

  private assertApp(snapshot: FollowUpCardSnapshot): void {
    if (snapshot.batch.appId !== process.env.FEISHU_APP_ID?.trim()) throw new ForbiddenException('卡片不属于当前飞书应用');
  }

  private enqueueMessage(messageId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.messageUpdates.get(messageId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.messageUpdates.set(messageId, current);
    return current.finally(() => { if (this.messageUpdates.get(messageId) === current) this.messageUpdates.delete(messageId); });
  }
}

function safeError(error: unknown): string {
  const value = error && typeof error === 'object' ? error as { message?: unknown; response?: { status?: unknown; data?: { code?: unknown; msg?: unknown } } } : {};
  const status = value.response?.status, code = value.response?.data?.code;
  const message = typeof value.response?.data?.msg === 'string' ? value.response.data.msg : typeof value.message === 'string' ? value.message : '同步失败';
  const details = message.slice(0, 2000).split(/(?:ErrorValue|request[_ ]?body|payload)\s*[:=]/iu)[0]
    .replace(/Bearer\s+[^\s,;"'}]+/giu, 'Bearer [已隐藏]')
    .replace(/((?:app[_-]?secret|access[_-]?token|tenant[_-]?access[_-]?token|verification[_-]?token|token|ticket|password|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/giu, '$1[已隐藏]')
    .replace(/(?:https?:\/\/|feishu:\/\/|lark:\/\/)[^\s<>]+/giu, '[链接已隐藏]')
    .replace(/[\r\n\t]/gu, ' ').trim();
  return [Number.isInteger(status) ? `HTTP ${status}` : '', /^\d{1,9}$/u.test(String(code ?? '')) ? `Feishu ${code}` : '', details].filter(Boolean).join(' · ').slice(0, 500);
}
