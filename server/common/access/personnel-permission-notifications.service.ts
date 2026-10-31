import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, ServiceUnavailableException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { ManagedAccount } from '../../../shared/access-configuration.interface';
import { AccessConfigurationService } from './access-configuration.service';
import { AccessConfigurationDirectory } from './access-configuration.directory';
import { getPersonnelPermissionRequestsStore, type StoredPermissionRequest } from './personnel-permission-requests.store';
import { permissionApplicantIdentity, type VerifiedPermissionGrantReceipt } from './personnel-permission-grant';
import { PersonnelPermissionNotificationStore, type PermissionNotificationJob, type PermissionNotificationDelivery } from './personnel-permission-notification.store';
import { permissionRequestNotificationCard, permissionRequestReviewUrl } from './personnel-permission-notification.card';
import { observedCardPatch, observedCardPost } from '../feishu-card-copy/transport';
import { cancelHotfixInitialization, runHotfixInitialization } from '../hotfix-runtime-activation';

const API = 'https://open.feishu.cn/open-apis';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const enabled = () => process.env.NODE_ENV === 'production' && !/^(?:1|true|on|yes)$/iu.test(process.env.NANTONG_HOTFIX_SMOKE_MODE || '');

@Injectable()
export class PersonnelPermissionNotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PersonnelPermissionNotificationsService.name);
  private store?: PersonnelPermissionNotificationStore;
  private timer?: NodeJS.Timeout;
  private wakeTimer?: NodeJS.Timeout;
  private running = false;
  private stopped = true;
  private token?: { value: string; appId: string; expiresAt: number };
  private lastDiagnostic = 0;
  constructor(private readonly http: HttpService, private readonly configuration: AccessConfigurationService,
    private readonly directory: AccessConfigurationDirectory) {}

  async onModuleInit(): Promise<void> {
    if (!enabled()) return;
    const configurationFile = process.env.ACCESS_CONFIGURATION_FILE || join(process.cwd(), '.runtime', 'access-configuration.json');
    try {
      this.store = new PersonnelPermissionNotificationStore(join(dirname(configurationFile), 'personnel-permission-notifications.json'));
      this.store.read();
    } catch { this.store = undefined; this.diagnostic(); return; }
    await runHotfixInitialization(this, () => {
      this.stopped = false;
      this.timer = setInterval(() => this.wake(), 30_000); this.timer.unref?.();
      this.wake();
    });
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true; if (this.timer) clearInterval(this.timer); if (this.wakeTimer) clearTimeout(this.wakeTimer);
    await cancelHotfixInitialization(this); this.token = undefined;
  }
  async enqueue(request: StoredPermissionRequest): Promise<void> {
    if (!enabled()) return;
    if (this.stopped || !this.store) throw new ServiceUnavailableException('管理员通知暂未登记，请保留申请并重试');
    if (request.status !== 'pending') { this.wake(); return; }
    const appId = process.env.FEISHU_APP_ID?.trim() || '';
    const recipients = this.configuration.snapshot().accounts.filter(account => this.isAdministrator(account, appId) &&
      account.id !== request.accountId && permissionApplicantIdentity(account, appId) !== request.applicantIdentity);
    if (!recipients.length) throw new ServiceUnavailableException('未找到可接收通知的飞书管理员，申请已保留，请联系管理员核对');
    this.store.update(state => {
      if (state.jobs[request.id]) return;
      state.jobs[request.id] = { requestId: request.id, appId, createdAt: Date.now(),
        recipientAccountIds: recipients.map(account => account.id), recipientsResolved: false, deliveries: [] };
    });
    this.wake();
  }
  wake(): void {
    if (this.stopped || !enabled() || !this.store || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => { this.wakeTimer = undefined; void this.flush(); }, 0); this.wakeTimer.unref?.();
  }
  private isAdministrator(account: ManagedAccount | undefined, appId: string): account is ManagedAccount {
    return !!account && account.kind === 'feishu' && account.appId === appId && account.role === 'admin' && account.enabled &&
      !account.deleted && !account.reactivationRequired && !account.permissionsRevoked && account.personnelActive !== false &&
      this.configuration.currentPrincipal(account.id, account.version)?.role === 'admin';
  }
  private async resolveRecipients(job: PermissionNotificationJob): Promise<void> {
    if (job.recipientsResolved || !this.store || (job.nextResolveAt || 0) > Date.now()) return;
    let accounts = this.configuration.snapshot().accounts.filter(account => job.recipientAccountIds.includes(account.id) && this.isAdministrator(account, job.appId));
    if (!accounts.length) { this.store.update(state => { const current = state.jobs[job.requestId]; if (current) current.recipientsResolved = true; }); return; }
    if (accounts.some(account => !account.openId)) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        const directory = await Promise.race([this.directory.read(), new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('DIRECTORY_WAIT_TIMEOUT')), 50_000);
        })]);
        if (directory.appId !== job.appId || !directory.personnelComplete) throw new Error('DIRECTORY_INCOMPLETE');
        accounts = accounts.map(account => {
          const matches = directory.people.filter(person => digest(`${job.appId}\0${person.openId}`) === account.identityHash);
          return !account.openId && matches.length === 1 ? { ...account, openId: matches[0].openId } : account;
        });
      } catch { this.diagnostic(); } finally { if (timeout) clearTimeout(timeout); }
    }
    const resolved = accounts.filter(account => account.openId && /^ou_[A-Za-z0-9_-]+$/u.test(account.openId) && digest(`${job.appId}\0${account.openId}`) === account.identityHash);
    const recipients = [...new Map(resolved.map(account => [account.openId!, account])).values()];
    this.store.update(state => {
      const current = state.jobs[job.requestId]; if (!current || current.recipientsResolved) return;
      const existing = new Set(current.deliveries.map(row => row.openId));
      current.deliveries.push(...recipients.filter(account => !existing.has(account.openId!)).map(account => ({ accountId: account.id, openId: account.openId!,
        uuid: digest(`permission-request\0${job.appId}\0${job.requestId}\0${account.openId}`).slice(0, 40),
        attempts: 0, nextAttemptAt: 0, status: 'queued' as const })));
      current.recipientsResolved = resolved.length === accounts.length;
      current.nextResolveAt = current.recipientsResolved ? 0 : Date.now() + 60_000;
    });
  }
  /** Background work has no permission-grant capability. Only registered notification jobs are processed. */
  async flush(): Promise<void> {
    if (this.running || this.stopped || !enabled() || !this.store) return;
    this.running = true;
    try {
      const appId = process.env.FEISHU_APP_ID?.trim() || '';
      const snapshot = this.store.read();
      if (!Object.keys(snapshot.jobs).length) return;
      const requests = getPersonnelPermissionRequestsStore().read().requests;
      const receipts = this.configuration.permissionRequestGrantReceipts(Object.values(snapshot.jobs)
        .map(job => requests[job.requestId]).filter(request => request?.status === 'pending'));
      let work = 0;
      for (const initial of Object.values(snapshot.jobs)) {
        if (this.stopped || work >= 20) break;
        if (initial.appId !== appId) continue;
        try {
          let job = initial;
          if (!job.recipientsResolved && (job.nextResolveAt || 0) <= Date.now()) {
            work++; await this.resolveRecipients(job); job = this.store.read().jobs[initial.requestId];
          }
          const raw = requests[job.requestId]; if (!raw) continue;
          const request = this.currentRequest(raw, receipts);
          for (const entry of job.deliveries) {
            if (this.stopped || work >= 20) break;
            if (!request || ['attention','cancelled'].includes(entry.status) || entry.nextAttemptAt > Date.now() || entry.syncedVersion === request.version) continue;
            work++;
            await this.store.withDeliveryLock(job.requestId, entry.uuid, () => this.deliver(job.requestId, entry.uuid));
          }
        } catch { this.diagnostic(); }
      }
    } catch { this.diagnostic(); }
    finally { this.running = false; }
  }
  private currentRequest(request: StoredPermissionRequest, receipts?: ReadonlyMap<string, VerifiedPermissionGrantReceipt>): StoredPermissionRequest {
    if (request.status !== 'pending') return request;
    const receipt = receipts ? receipts.get(request.id) : this.configuration.permissionRequestGrantReceipt(request);
    if (!receipt) return request;
    // A committed grant is final even when the request-file response/write was interrupted.
    return { ...request, status: 'approved', version: request.version + 1, reviewerAccountId: receipt.reviewerAccountId,
      reviewerName: receipt.reviewerName, updatedAt: receipt.reviewedAt, verifiedConfigurationRevision: receipt.configurationRevision,
      ...(receipt.comment ? { comment: receipt.comment } : {}) };
  }
  private async deliver(requestId: string, uuid: string): Promise<void> {
    const store = this.store!;
    const job = store.read().jobs[requestId], entry = job?.deliveries.find(row => row.uuid === uuid);
    const raw = getPersonnelPermissionRequestsStore().read().requests[requestId];
    const request = raw ? this.currentRequest(raw) : undefined;
    if (!entry || !request || this.stopped || ['attention','cancelled'].includes(entry.status) || entry.nextAttemptAt > Date.now() || entry.syncedVersion === request.version) return;
    const update = (fn: (value: PermissionNotificationDelivery) => void) => store.update(state => { const value = state.jobs[requestId]?.deliveries.find(row => row.uuid === uuid); if (value) fn(value); });
    const administrator = () => {
      const account = this.configuration.snapshot().accounts.find(row => row.id === entry.accountId);
      return this.isAdministrator(account, job.appId) && account.identityHash === digest(`${job.appId}\0${entry.openId}`);
    };
    if (!administrator()) { update(value => { value.status = 'cancelled'; value.errorCode = 'ADMINISTRATOR_NO_LONGER_ELIGIBLE'; }); return; }
    // Feishu UUID deduplication is limited to one hour. Never blindly replay unknown sends after that window.
    if (!entry.messageId && entry.firstAttemptAt && (Date.now() - entry.firstAttemptAt > 5 * 60_000 || entry.attempts >= 3)) {
      update(value => { value.status = 'attention'; value.errorCode = 'SEND_RESULT_REQUIRES_REVIEW'; }); this.diagnostic(); return;
    }
    try {
      const token = await this.accessToken(job.appId);
      if (this.stopped || !enabled() || process.env.FEISHU_APP_ID?.trim() !== job.appId || !administrator()) return;
      const latestRaw = getPersonnelPermissionRequestsStore().read().requests[requestId];
      if (!latestRaw) return;
      const latest = this.currentRequest(latestRaw);
      const card = permissionRequestNotificationCard(latest, permissionRequestReviewUrl(requestId));
      const headers = { Authorization: `Bearer ${token}` };
      if (!entry.messageId) {
        const sendCard = entry.pendingCard || card, sendVersion = entry.pendingVersion || latest.version;
        update(value => { value.status = 'sending'; value.firstAttemptAt ??= Date.now(); value.attempts++;
          value.pendingCard = sendCard; value.pendingVersion = sendVersion; });
        const response = await observedCardPost(this.http.axiosRef, 'permission-request', API + '/im/v1/messages',
          { receive_id: entry.openId, msg_type: 'interactive', content: JSON.stringify(sendCard), uuid },
          { headers, params: { receive_id_type: 'open_id' }, timeout: 8000, maxRedirects: 0 });
        const messageId = response.data?.data?.message_id;
        if (response.data?.code !== 0 || typeof messageId !== 'string' || !/^om_[A-Za-z0-9_-]+$/u.test(messageId)) throw new Error('SEND_NOT_CONFIRMED');
        update(value => { value.messageId = messageId; value.status = 'sent'; value.syncedVersion = sendVersion; value.nextAttemptAt = 0;
          delete value.errorCode; delete value.pendingCard; delete value.pendingVersion; });
      } else {
        const response = await observedCardPatch(this.http.axiosRef, 'permission-request', API + '/im/v1/messages/' + entry.messageId,
          { content: JSON.stringify(card) }, { headers, timeout: 8000, maxRedirects: 0 });
        if (response.data?.code !== 0) throw new Error('UPDATE_NOT_CONFIRMED');
        update(value => { value.status = 'sent'; value.syncedVersion = latest.version; value.nextAttemptAt = 0; delete value.errorCode; });
      }
    } catch {
      update(value => { value.nextAttemptAt = Date.now() + 30_000; value.errorCode = value.messageId ? 'CARD_UPDATE_PENDING' : 'CARD_SEND_PENDING'; });
      this.diagnostic();
    }
  }
  private async accessToken(appId: string): Promise<string> {
    if (this.token?.appId === appId && this.token.expiresAt > Date.now()) return this.token.value;
    const secret = process.env.FEISHU_APP_SECRET?.trim(); if (!secret) throw new Error('PERMISSION_NOTIFICATION_AUTH_UNAVAILABLE');
    const response = await this.http.axiosRef.post(API + '/auth/v3/tenant_access_token/internal', { app_id: appId, app_secret: secret }, { timeout: 8000, maxRedirects: 0 });
    if (response.data?.code !== 0 || typeof response.data?.tenant_access_token !== 'string') throw new Error('PERMISSION_NOTIFICATION_AUTH_UNAVAILABLE');
    const expires = Number(response.data.expire);
    const lifetime = Number.isFinite(expires) ? Math.max(0, Math.min(300, expires - 30)) : 300;
    this.token = { appId, value: response.data.tenant_access_token, expiresAt: Date.now() + lifetime * 1000 };
    return this.token.value;
  }
  private diagnostic(): void {
    if (Date.now() - this.lastDiagnostic < 60_000) return;
    this.lastDiagnostic = Date.now(); this.logger.warn('管理员权限申请卡片待同步，请在平台权限申请中核对；申请和授权记录保持不变');
  }
}
