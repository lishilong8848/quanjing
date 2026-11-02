import type { CardCopyObserver, PrimaryCardDelivery } from './transport';

/** Isolate recipient failures while keeping each update reservation attached to its own ledger. */
export class FeishuCardCopyFanout implements CardCopyObserver {
  private readonly reservations = new WeakMap<object, Array<{ observer: CardCopyObserver; operation: unknown }>>();
  constructor(private readonly observers: readonly CardCopyObserver[], private readonly report: (code: string) => void) {}
  diagnostic(code: string): void { try { this.report(code); } catch { /* Diagnostics cannot interrupt another recipient. */ } }
  private async each(action: (observer: CardCopyObserver) => Promise<unknown>): Promise<void> {
    await Promise.all(this.observers.map(async observer => {
      try { await action(observer); } catch { this.diagnostic('CARD_COPY_RECIPIENT_OPERATION_FAILED'); }
    }));
  }
  async delivered(event: PrimaryCardDelivery): Promise<void> { await this.each(observer => observer.delivered(event)); }
  async reserveUpdate(messageId: string): Promise<unknown> {
    const rows: Array<{ observer: CardCopyObserver; operation: unknown }> = [];
    await this.each(async observer => { const operation = await observer.reserveUpdate(messageId); if (operation) rows.push({ observer, operation }); });
    if (!rows.length) return undefined;
    const token = {}; this.reservations.set(token, rows); return token;
  }
  async cancelUpdate(token: unknown): Promise<void> { await this.finish(token, (observer, operation) => observer.cancelUpdate?.(operation)); }
  async updated(messageId: string, card: Record<string, unknown>, token?: unknown): Promise<void> {
    await this.finish(token, async (observer, operation) => {
      try { await observer.updated(messageId, card, operation); }
      catch { await observer.cancelUpdate?.(operation); throw new Error('CARD_COPY_RECIPIENT_UPDATE_FAILED'); }
    });
  }
  private async finish(token: unknown, action: (observer: CardCopyObserver, operation: unknown) => Promise<unknown> | undefined): Promise<void> {
    if (!token || typeof token !== 'object') return;
    const rows = this.reservations.get(token); if (!rows) return;
    this.reservations.delete(token);
    await Promise.all(rows.map(async ({ observer, operation }) => {
      try { await action(observer, operation); } catch { this.diagnostic('CARD_COPY_RECIPIENT_UPDATE_FAILED'); }
    }));
  }
  isCopyMessage(messageId: string): boolean {
    for (const observer of this.observers) {
      try { if (observer.isCopyMessage(messageId)) return true; } catch { this.diagnostic('CARD_COPY_RECIPIENT_LOOKUP_FAILED'); }
    }
    return false;
  }
}
