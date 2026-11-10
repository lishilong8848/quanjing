import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { WarehouseBuilding } from '../../../shared/inventory-management.interface';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { readEnv } from '../../common/config/external-services.config';
import { readPublicApplicationUrl } from '../../common/config/public-application-url';
import { currentHotfixActivation } from '../../common/hotfix-runtime-activation';
import { createProcessLockOwner, processLockOwnerMayBeAlive } from '../../common/process-lock-owner';
import { InventoryOutboundApprovalGateway } from '../inventory-outbound-approval/inventory-outbound-approval.gateway';
import { InventoryWarehouseRoleDirectory } from '../inventory-outbound-approval/inventory-warehouse-role-directory';
import {
  buildStocktakeReminderCard, hasOutstandingStocktake, OPEN_ID, STOCKTAKE_RECIPIENT_SOURCE, stocktakeReminderWeek,
  type StocktakeReminderBatch, type StocktakeReminderDelivery,
} from './inventory-stocktake-reminder.model';
import { stocktakeBuildings, stocktakeGenerationDueAt, stocktakeMonth } from './inventory-stocktake.rules';
import { InventoryStocktakeStore, type StocktakeLedger } from './inventory-stocktake.store';

const RETRY_MS = 5 * 60_000;
// Feishu deduplicates the same UUID for one hour. Keep a margin for in-flight requests.
const SAFE_SEND_RETRY_MS = 50 * 60_000;
const INITIAL = 'initial';
const findBatch = (state: StocktakeLedger, month: string, building: WarehouseBuilding, period: string) =>
  state.reminderBatches?.find(row => row.month === month && row.building === building && row.period === period);
const awaitingDelivery = (batch: StocktakeReminderBatch, row: StocktakeReminderDelivery) =>
  batch.routedOpenIds?.includes(row.openId) && !row.messageId && !row.needsReview;
const hasPending = (batch?: StocktakeReminderBatch) => batch?.routingSource !== STOCKTAKE_RECIPIENT_SOURCE ||
  !batch.routingComplete || batch.deliveries.some(row => awaitingDelivery(batch, row));
const mayRetry = (batch: StocktakeReminderBatch | undefined, now: number) => batch?.routingSource !== STOCKTAKE_RECIPIENT_SOURCE ||
  (batch.retryRoutingAt <= now && (!batch.routingComplete || batch.deliveries.some(row =>
    awaitingDelivery(batch, row) && row.retryAt <= now)));

export const STOCKTAKE_REMINDER_RUNTIME = Symbol('STOCKTAKE_REMINDER_RUNTIME');
interface ReminderRuntime {
  now(): number;
  enabled(): boolean;
  appId(): string;
  publicBaseUrl(): string;
}
const runtime: ReminderRuntime = {
  now: Date.now,
  enabled: () => process.env.NODE_ENV === 'production' && !/^(?:1|true|on|yes)$/iu.test(process.env.NANTONG_HOTFIX_SMOKE_MODE || '') &&
    currentHotfixActivation().isAcceptingNewWork(),
  appId: () => readEnv('FEISHU_APP_ID'),
  publicBaseUrl: () => readPublicApplicationUrl(['FEISHU_PUBLIC_BASE_URL', 'APP_PUBLIC_URL']),
};

@Injectable()
export class InventoryStocktakeReminderService {
  private readonly logger = new Logger(InventoryStocktakeReminderService.name);
  private running: Promise<void> | null = null;

  constructor(
    private readonly store: InventoryStocktakeStore,
    private readonly directory: InventoryWarehouseRoleDirectory,
    private readonly access: AccessConfigurationService,
    private readonly sender: InventoryOutboundApprovalGateway,
    @Optional() @Inject(STOCKTAKE_REMINDER_RUNTIME) private readonly options: ReminderRuntime = runtime,
  ) {}

  runPending(month: string): Promise<void> {
    if (this.running) return this.running;
    if (!this.options.enabled()) return Promise.resolve();
    const now = this.options.now();
    if (month !== stocktakeMonth(new Date(now)) || now < stocktakeGenerationDueAt(month).getTime()) return Promise.resolve();
    this.running = this.drain(month, now).finally(() => { this.running = null; });
    return this.running;
  }

  private async drain(month: string, now: number): Promise<void> {
    const state = this.store.read();
    const week = stocktakeReminderWeek(now, month);
    const due = state.sheets.flatMap(sheet => {
      if (sheet.month !== month || !hasOutstandingStocktake(sheet)) return [];
      const initial = findBatch(state, month, sheet.building, INITIAL);
      const period = hasPending(initial) ? INITIAL :
        week && !initial?.deliveries.some(row => initial.routedOpenIds?.includes(row.openId) &&
          Math.max(row.firstAttemptAt, row.sentAt ?? 0) >= week.startsAt) ? week.period : null;
      return period && mayRetry(findBatch(state, month, sheet.building, period), now) ? [{ building: sheet.building, period }] : [];
    });
    if (!due.length) return;

    let baseUrl: URL;
    try {
      baseUrl = new URL(this.options.publicBaseUrl());
      if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error();
    } catch {
      for (const entry of due) this.block(month, entry.building, entry.period, 'public-url-invalid');
      return;
    }

    // Parallel lookups coalesce onto the directory's single fresh source read.
    const lookups = await Promise.allSettled(due.map(entry => this.directory.resolveApprovers(entry.building, true)));
    for (const [index, entry] of due.entries()) {
      if (!this.options.enabled()) return;
      const lookup = lookups[index];
      if (lookup.status === 'rejected') {
        this.block(month, entry.building, entry.period, 'recipients-unavailable');
        continue;
      }
      await this.deliver(month, entry.building, entry.period, lookup.value.map(row => row.openId), baseUrl);
    }
  }

  private async deliver(month: string, building: WarehouseBuilding, period: string, ids: string[], baseUrl: URL): Promise<void> {
    const appId = this.options.appId();
    const eligible = new Set<string>();
    for (const openId of new Set(ids.filter(id => OPEN_ID.test(id)))) {
      if (!this.options.enabled()) return;
      const principal = this.access.feishuPrincipal(openId, appId);
      if (!principal || !stocktakeBuildingsOrEmpty(principal).includes(building)) continue;
      eligible.add(openId);
      const claimed = this.claim(month, building, period, openId, appId, principal, baseUrl);
      if (!claimed) continue;
      let messageId: string;
      try {
        messageId = await this.sender.sendInteractiveCard(openId, claimed.card, claimed.uuid, `stocktake:${month}:${building}:${period}`);
      } catch {
        this.settle(month, building, period, openId, claimed.token, null);
        continue;
      }
      this.settle(month, building, period, openId, claimed.token, messageId);
    }
    if (!eligible.size) {
      this.block(month, building, period, 'no-authorized-recipient');
      return;
    }
    this.store.update(state => {
      const sheet = state.sheets.find(row => row.month === month && row.building === building);
      if (!sheet || !hasOutstandingStocktake(sheet)) return false;
      const batch = getOrCreateBatch(state, month, building, period);
      batch.routingComplete = true;
      batch.routedOpenIds = [...eligible].sort();
      batch.routingError = null;
      batch.retryRoutingAt = 0;
      for (const row of batch.deliveries) {
        if (eligible.has(row.openId) || row.messageId || row.needsReview || activeOwner(row)) continue;
        row.owner = null;
        row.needsReview = true;
      }
      return true;
    });
  }

  private claim(month: string, building: WarehouseBuilding, period: string, openId: string, appId: string, principal: NonNullable<ReturnType<AccessConfigurationService['feishuPrincipal']>>, baseUrl: URL) {
    const now = this.options.now();
    const previous = findBatch(this.store.read(), month, building, period)?.deliveries.find(row => row.openId === openId);
    if (previous?.messageId || previous?.needsReview || (previous && (previous.retryAt > now || activeOwner(previous)))) return null;

    return this.store.update(state => {
      const sheet = state.sheets.find(row => row.month === month && row.building === building);
      if (!sheet || month !== stocktakeMonth(new Date(now))) return null;
      const card = buildStocktakeReminderCard(sheet, period, principal, baseUrl);
      if (!card) return null;
      const payloadSha256 = createHash('sha256').update(JSON.stringify([appId, card])).digest('hex');
      const batch = getOrCreateBatch(state, month, building, period);
      const row = batch.deliveries.find(row => row.openId === openId);
      if (row?.messageId || row?.needsReview || (row && (row.retryAt > now || activeOwner(row)))) return null;
      if (row && (row.payloadSha256 !== payloadSha256 || now - row.firstAttemptAt >= SAFE_SEND_RETRY_MS)) {
        row.owner = null;
        row.needsReview = true;
        this.logger.warn(`${month} ${building}盘点卡投递结果待核对，已停止自动重发`);
        return null;
      }
      batch.routingError = null;
      batch.retryRoutingAt = 0;
      const token = randomUUID();
      const claimed = row ?? { openId, uuid: randomUUID(), payloadSha256, firstAttemptAt: now, retryAt: 0, owner: null, messageId: null, sentAt: null, needsReview: false };
      claimed.owner = createProcessLockOwner(token, new Date(now));
      claimed.retryAt = now + RETRY_MS;
      if (!row) batch.deliveries.push(claimed);
      return { card, uuid: claimed.uuid, token };
    });
  }

  private settle(month: string, building: WarehouseBuilding, period: string, openId: string, token: string, messageId: string | null): void {
    this.store.update(state => {
      const row = findBatch(state, month, building, period)?.deliveries.find(row => row.openId === openId);
      if (row?.owner?.token !== token) throw new Error('盘点卡投递所有权已变化');
      row.owner = null;
      if (messageId) {
        row.messageId = messageId;
        row.sentAt = this.options.now();
      }
      return true;
    });
  }

  private block(month: string, building: WarehouseBuilding, period: string, error: NonNullable<StocktakeReminderBatch['routingError']>): void {
    const changed = this.store.update(state => {
      const batch = getOrCreateBatch(state, month, building, period);
      const changed = batch.routingError !== error;
      batch.routingError = error;
      batch.retryRoutingAt = this.options.now() + RETRY_MS;
      return changed;
    });
    if (changed) this.logger.warn(`${month} ${building}盘点卡暂未发送：${error}`);
  }
}

function activeOwner(row: StocktakeReminderDelivery): boolean {
  return Boolean(row.owner && processLockOwnerMayBeAlive(row.owner, Date.parse(row.owner.acquiredAt || '') || row.firstAttemptAt));
}

function getOrCreateBatch(state: StocktakeLedger, month: string, building: WarehouseBuilding, period: string): StocktakeReminderBatch {
  const existing = findBatch(state, month, building, period);
  if (existing) {
    if (existing.routingSource !== STOCKTAKE_RECIPIENT_SOURCE) {
      // Re-evaluate the old route without losing any known or uncertain delivery.
      existing.routingSource = STOCKTAKE_RECIPIENT_SOURCE;
      existing.routedOpenIds = [];
      existing.routingComplete = false;
    }
    return existing;
  }
  const created: StocktakeReminderBatch = { month, building, period, routingError: null, routingComplete: false,
    routingSource: STOCKTAKE_RECIPIENT_SOURCE, routedOpenIds: [], retryRoutingAt: 0, deliveries: [] };
  (state.reminderBatches ??= []).push(created);
  return created;
}

function stocktakeBuildingsOrEmpty(principal: NonNullable<ReturnType<AccessConfigurationService['feishuPrincipal']>>): WarehouseBuilding[] {
  try { return stocktakeBuildings(principal); } catch { return []; }
}
