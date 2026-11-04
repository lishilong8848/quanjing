import { HttpService } from '@nestjs/axios';
import { HttpException, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { AccessConfigurationService } from './access/access-configuration.service';
import { originalCardMessageId, observedCardPost } from './feishu-card-copy/transport';
import { cancelHotfixInitialization, runHotfixInitialization } from './hotfix-runtime-activation';
import { CALLBACK_FEEDBACK_KINDS, FeishuCardCallbackFeedbackStore, type CallbackFeedbackJob, type CallbackFeedbackKind } from './feishu-card-callback-feedback.store';

const API = 'https://open.feishu.cn/open-apis';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const labels: Record<CallbackFeedbackKind, string> = { leave: '请休假', overtime: '加班', purchase: '采购', inventory_outbound: '出库',
  threshold_adjustment: '阈值审批', today_operations_followup: '异常跟进', today_operations_anomaly: '今日航图异常' };
function enabled(): boolean {
  const profile = process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE?.trim().toLowerCase();
  return process.env.NODE_ENV === 'production' && !/^(?:1|true|on|yes)$/iu.test(process.env.NANTONG_HOTFIX_SMOKE_MODE || '') &&
    (profile === 'production' || !profile && /^(?:1|true|on|yes)$/iu.test(process.env.FEISHU_CARD_ACTION_CONSUMER_ENABLED || ''));
}

export function callbackFailureIdentity(identity: unknown, kind: string, appId: string): Omit<CallbackFeedbackJob, 'status' | 'createdAt' | 'attempts' | 'nextAttemptAt'> | undefined {
  if (!CALLBACK_FEEDBACK_KINDS.includes(kind as CallbackFeedbackKind) || !/^cli_[A-Za-z0-9_-]{1,120}$/u.test(appId) || !record(identity)) return;
  const event = record(identity.event) ? identity.event : identity;
  const actor = record(event.operator) ? event.operator.open_id : undefined;
  const openId = actor || event.actorOpenId || event.operatorOpenId;
  const messageId = originalCardMessageId(identity);
  if (typeof openId !== 'string' || !/^ou_[A-Za-z0-9_-]{1,124}$/u.test(openId) || !messageId) return;
  let material: string;
  try {
    const excluded = new Set(['eventId', 'event_id', 'token', 'updateToken', 'update_token', 'header', 'schema', 'event_type', 'create_time']);
    material = JSON.stringify(record(event.action) ? event.action : event, (key, value: unknown) => {
      if (excluded.has(key)) return undefined;
      return record(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value;
    });
    if (!material || Buffer.byteLength(material) > 128 * 1024) return;
  } catch { return; }
  const sourceHash = hash(messageId), actionHash = hash(material);
  const id = hash(JSON.stringify(['callback-late-failure-v1', appId, kind, sourceHash, openId, actionHash]));
  return { id, appId, openId, kind: kind as CallbackFeedbackKind, sourceHash, actionHash, uuid: hash('callback-late-failure:' + id).slice(0, 40) };
}

/** A separate read-only error hint, never an approval result or a replay of the failed action. */
@Injectable()
export class FeishuCardCallbackFeedbackService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeishuCardCallbackFeedbackService.name);
  private store?: FeishuCardCallbackFeedbackStore;
  private timer?: NodeJS.Timeout;
  private wakeTimer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = true;
  private token?: { appId: string; value: string; expiresAt: number };
  private tokenRequest?: { appId: string; promise: Promise<string> };
  private lastDiagnostic = 0;
  constructor(private readonly http: HttpService, private readonly configuration: AccessConfigurationService) {}

  async onModuleInit(): Promise<void> {
    if (!enabled()) return;
    const config = process.env.ACCESS_CONFIGURATION_FILE || join(process.cwd(), '.runtime', 'access-configuration.json');
    try { this.store = new FeishuCardCallbackFeedbackStore(join(dirname(config), 'feishu-card-callback-feedback.json')); this.store.read(); }
    catch { this.store = undefined; this.diagnostic(); return; }
    await runHotfixInitialization(this, () => {
      this.stopped = false;
      this.timer = setInterval(() => this.wake(), 30_000); this.timer.unref?.(); this.wake();
    });
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true; if (this.timer) clearInterval(this.timer); if (this.wakeTimer) clearTimeout(this.wakeTimer);
    await cancelHotfixInitialization(this); await this.active; this.token = undefined; this.tokenRequest = undefined;
  }
  async enqueueLateFailure(identity: unknown, kind: string, error: unknown): Promise<void> {
    if (!enabled() || this.stopped || !this.store) return;
    if (error instanceof HttpException && [400, 401, 403].includes(error.getStatus())) return;
    const job = callbackFailureIdentity(identity, kind, process.env.FEISHU_APP_ID?.trim() || '');
    if (!job || !this.eligible(job)) return;
    this.store.update(state => {
      if (state.jobs[job.id]) return;
      if (Object.keys(state.jobs).length >= 2_000) throw new Error('CALLBACK_FEEDBACK_CAPACITY');
      state.jobs[job.id] = { ...job, status: 'queued', createdAt: Date.now(), nextAttemptAt: 0, attempts: 0 };
    });
    this.wake();
  }
  private eligible(job: Pick<CallbackFeedbackJob, 'appId' | 'openId'>): boolean {
    try {
      if (job.appId !== process.env.FEISHU_APP_ID?.trim()) return false;
      const identityHash = hash(`${job.appId}\0${job.openId}`);
      const accounts = this.configuration.snapshot().accounts.filter(account => account.kind === 'feishu' && account.appId === job.appId && account.identityHash === identityHash);
      return accounts.length === 1 && this.configuration.isCurrentReadonlyCardRecipient({ appId: job.appId, identityHash, name: accounts[0].name });
    } catch { return false; }
  }
  private wake(): void {
    if (this.stopped || !enabled() || !this.store || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => { this.wakeTimer = undefined; void this.flush(); }, 0); this.wakeTimer.unref?.();
  }
  flush(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.flushPending().finally(() => { this.active = undefined; });
    return this.active;
  }
  private async flushPending(): Promise<void> {
    if (this.stopped || !enabled() || !this.store) return;
    try {
      let work = 0;
      for (const row of Object.values(this.store.read().jobs)) {
        if (this.stopped || work >= 10) break;
        if (!['queued', 'sending'].includes(row.status) || row.nextAttemptAt > Date.now()) continue;
        work++;
        await this.store.withDeliveryLock(row.id, () => this.deliver(row.id));
      }
    } catch { this.diagnostic(); }
  }
  private async deliver(id: string): Promise<void> {
    const store = this.store!, job = store.read().jobs[id];
    if (!job || !['queued', 'sending'].includes(job.status) || job.nextAttemptAt > Date.now() || this.stopped || !enabled()) return;
    const update = (change: (row: CallbackFeedbackJob) => void) => store.update(state => { const row = state.jobs[id]; if (row) change(row); });
    if (!this.eligible(job)) { update(row => { row.status = 'cancelled'; }); return; }
    // Reuse the exact UUID inside a deliberately short deduplication window only.
    if (job.attempts >= 3 || job.firstAttemptAt && Date.now() - job.firstAttemptAt > 5 * 60_000) {
      update(row => { row.status = 'attention'; }); this.diagnostic(); return;
    }
    try {
      const token = await this.accessToken(job.appId);
      if (this.stopped || !enabled() || !this.eligible(job)) return;
      update(row => { row.status = 'sending'; row.firstAttemptAt ??= Date.now(); row.attempts++; });
      const response = await observedCardPost(this.http.axiosRef, 'card-callback-feedback', API + '/im/v1/messages', {
        receive_id: job.openId, msg_type: 'interactive', uuid: job.uuid,
        content: JSON.stringify({ schema: '2.0', config: { update_multi: true }, header: { template: 'orange', title: { tag: 'plain_text', content: '卡片操作待核对' } },
          body: { elements: [{ tag: 'markdown', content: `${labels[job.kind]}操作未获得完整处理结果。请返回原卡片查看最新状态；如仍未处理，可重试原操作。已受理的业务请勿重复提交。` }] } }),
      }, { params: { receive_id_type: 'open_id' }, headers: { Authorization: `Bearer ${token}` }, timeout: 8_000, maxRedirects: 0 });
      const messageId = response.data?.data?.message_id;
      if (response.status < 200 || response.status >= 300 || response.data?.code !== 0 || typeof messageId !== 'string' || !/^om_[A-Za-z0-9_-]{1,256}$/u.test(messageId)) throw new Error('CALLBACK_FEEDBACK_RECEIPT_UNKNOWN');
      update(row => { row.status = 'sent'; row.messageId = messageId; row.nextAttemptAt = 0; });
    } catch {
      update(row => { row.nextAttemptAt = Date.now() + 30_000; }); this.diagnostic();
    }
  }
  private async accessToken(appId: string): Promise<string> {
    if (this.token?.appId === appId && this.token.expiresAt > Date.now()) return this.token.value;
    if (this.tokenRequest?.appId === appId) return this.tokenRequest.promise;
    const secret = process.env.FEISHU_APP_SECRET?.trim(); if (!secret) throw new Error('CALLBACK_FEEDBACK_AUTH_UNAVAILABLE');
    const request = { appId, promise: Promise.resolve('') };
    request.promise = (async () => {
      const response = await this.http.axiosRef.post(API + '/auth/v3/tenant_access_token/internal', { app_id: appId, app_secret: secret }, { timeout: 8_000, maxRedirects: 0 });
      if (response.data?.code !== 0 || typeof response.data?.tenant_access_token !== 'string') throw new Error('CALLBACK_FEEDBACK_AUTH_UNAVAILABLE');
      if (this.stopped || !enabled() || appId !== process.env.FEISHU_APP_ID?.trim()) throw new Error('CALLBACK_FEEDBACK_AUTH_STOPPED');
      const expire = Number(response.data.expire), lifetime = Number.isFinite(expire) ? Math.max(0, Math.min(300, expire - 30)) : 300;
      this.token = { appId, value: response.data.tenant_access_token, expiresAt: Date.now() + lifetime * 1000 };
      return this.token.value;
    })().finally(() => { if (this.tokenRequest === request) this.tokenRequest = undefined; });
    this.tokenRequest = request; return request.promise;
  }
  private diagnostic(): void {
    if (Date.now() - this.lastDiagnostic < 60_000) return;
    this.lastDiagnostic = Date.now(); this.logger.warn('卡片结果提示待同步，请在原卡片核对；不会重新执行原业务操作');
  }
}
