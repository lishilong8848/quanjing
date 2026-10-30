import { createHash } from 'node:crypto';
import type { AxiosInstance, AxiosResponse } from 'axios';
import { FeishuCardMirrorStore, type MirrorClaim, type MirrorUpdateOperation } from './mirror.store';
import { sanitizeReadonlyCard } from './readonly-card';
import type { CardCopyObserver, PrimaryCardDelivery } from './transport';

export interface CardCopyEngineOptions {
  store: FeishuCardMirrorStore;
  http: Pick<AxiosInstance, 'post' | 'patch' | 'delete'>;
  accessToken: () => Promise<string>;
  targetValid: () => boolean;
  diagnostic: (code: string) => void;
  now?: () => Date;
}
/** Independent outbox. No business gateway, approval handler or personnel writer is called here. */
export class FeishuCardCopyEngine implements CardCopyObserver {
  private running = false;
  private stopped = false;
  constructor(private readonly options: CardCopyEngineOptions) {}
  diagnostic(code: string): void { this.options.diagnostic(code); }
  private now(): Date { return this.options.now?.() || new Date(); }
  async delivered(event: PrimaryCardDelivery): Promise<void> {
    if (this.stopped || !this.options.targetValid()) { this.diagnostic('CARD_COPY_TARGET_UNAVAILABLE'); return; }
    const card = sanitizeReadonlyCard(event.card);
    // The displayed content identifies the logical card across original recipients.
    // Only cards without a business identity use a day boundary for recurring notices.
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(event.startedAt));
    const material = [event.source, card.entityKeys.length ? '' : day, card.entityKeys, card.title, card.fingerprint];
    const groupKey = createHash('sha256').update(JSON.stringify(material)).digest('hex');
    await this.options.store.enroll({ sourceMessageId: event.messageId, groupKey, card, sourceStartedAt: event.startedAt, now: this.now(),
      ...(event.recipientType === 'open_id' ? { originalRecipientOpenId: event.recipientId } : {}) });
  }
  reserveUpdate(messageId: string) { return this.options.store.reserveUpdate(messageId); }
  async cancelUpdate(operation: unknown): Promise<void> { if (isOperation(operation)) await this.options.store.cancelUpdate(operation); }
  async updated(messageId: string, card: Record<string, unknown>, operation?: unknown): Promise<void> {
    if (!isOperation(operation)) return;
    if (this.stopped || !this.options.targetValid()) { await this.options.store.cancelUpdate(operation); return; }
    await this.options.store.applyUpdate(messageId, operation, sanitizeReadonlyCard(card), this.now());
  }
  isCopyMessage(messageId: string): boolean { return this.options.store.isMirrorMessageId(messageId); }
  stop(): void { this.stopped = true; }
  async flush(limit = 4): Promise<void> {
    await this.flushGroup(limit);
  }
  /** One-off release notices may only dispatch their own newly enrolled source. */
  async flushSource(messageId: string, limit = 1): Promise<number> {
    try {
      const group = this.options.store.getBySource(messageId);
      if (!group) return 0;
      return await this.flushGroup(limit, group.key);
    } catch { this.diagnostic('CARD_COPY_OUTBOX_UNAVAILABLE'); return 0; }
  }
  private async flushGroup(limit: number, groupKey?: string): Promise<number> {
    if (this.running || this.stopped || !this.options.targetValid()) return 0;
    this.running = true;
    let attempted = 0;
    try {
      await this.options.store.recoverInterrupted(this.now());
      for (let index = 0; index < limit && !this.stopped; index++) {
        if (!this.options.targetValid()) break;
        const claim = await this.options.store.claimNext(this.now(), groupKey);
        if (!claim) break;
        await this.deliverClaim(claim);
        attempted++;
      }
    } catch { this.diagnostic('CARD_COPY_OUTBOX_UNAVAILABLE'); }
    finally { this.running = false; }
    return attempted;
  }
  private async deliverClaim(claim: MirrorClaim): Promise<void> {
    let dispatched = false;
    try {
      const token = await this.options.accessToken();
      if (this.stopped || !this.options.targetValid()) {
        await this.options.store.fail(claim, { unknown: false, errorCode: 'TARGET_UNAVAILABLE', retryAt: new Date(this.now().getTime() + 60_000) }, this.now()); return;
      }
      const config = { headers: { Authorization: `Bearer ${token}` }, timeout: 15_000, maxRedirects: 0 };
      const base = 'https://open.feishu.cn/open-apis/im/v1/messages';
      let response: AxiosResponse<any>;
      dispatched = true;
      if (claim.operation === 'create') response = await this.options.http.post(`${base}?receive_id_type=open_id`, {
        receive_id: claim.recipientOpenId, msg_type: 'interactive', content: JSON.stringify(claim.card), uuid: claim.uuid,
      }, config);
      else if (claim.operation === 'update') response = await this.options.http.patch(`${base}/${encodeURIComponent(claim.messageId)}`, { content: JSON.stringify(claim.card) }, config);
      else response = await this.options.http.delete(`${base}/${encodeURIComponent(claim.messageId)}`, config);
      if (response.status < 200 || response.status >= 300 || response.data?.code !== 0) {
        const transient = response.status === 429 || response.data?.code === 99991400;
        const unknown = response.status >= 500;
        await this.options.store.fail(claim, { unknown, errorCode: transient ? 'RATE_LIMITED' : unknown ? 'DELIVERY_UNKNOWN' : 'API_REJECTED',
          ...(transient || claim.operation !== 'create' && unknown ? { retryAt: new Date(this.now().getTime() + 60_000) } : {}) }, this.now());
        this.diagnostic(unknown ? 'CARD_COPY_DELIVERY_UNKNOWN' : 'CARD_COPY_API_REJECTED'); return;
      }
      const messageId = claim.operation === 'create' ? response.data?.data?.message_id : undefined;
      if (claim.operation === 'create' && (typeof messageId !== 'string' || !/^om_[A-Za-z0-9_-]+$/.test(messageId))) {
        await this.options.store.fail(claim, { unknown: true, errorCode: 'MISSING_RECEIPT' }, this.now()); this.diagnostic('CARD_COPY_DELIVERY_UNKNOWN'); return;
      }
      await this.options.store.complete(claim, messageId, this.now());
    } catch (failure) {
      const status = (failure as { response?: { status?: number } })?.response?.status;
      const rejected = typeof status === 'number' && status >= 400 && status < 500;
      const unknown = dispatched && !rejected;
      try { await this.options.store.fail(claim, { unknown, errorCode: !dispatched ? 'AUTH_UNAVAILABLE' : unknown ? 'DELIVERY_UNKNOWN' : 'HTTP_REJECTED',
        ...(!dispatched || status === 429 || claim.operation !== 'create' && unknown ? { retryAt: new Date(this.now().getTime() + 60_000) } : {}) }, this.now()); }
      catch { /* An interrupted durable claim stays in the ledger and recovers conservatively. */ }
      this.diagnostic(unknown ? 'CARD_COPY_DELIVERY_UNKNOWN' : 'CARD_COPY_DELIVERY_FAILED');
    }
  }
}
function isOperation(value: unknown): value is MirrorUpdateOperation {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<MirrorUpdateOperation>;
  return typeof item.sourceMessageId === 'string' && typeof item.operationId === 'string' && Number.isSafeInteger(item.sequence);
}
