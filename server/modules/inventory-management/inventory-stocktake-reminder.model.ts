import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { createBusinessPermissionEvaluator } from '../../../shared/business-permissions';
import { WAREHOUSE_BUILDINGS, type WarehouseBuilding } from '../../../shared/inventory-management.interface';
import type { StocktakeSheet } from '../../../shared/inventory-stocktake.interface';
import { normalizeProcessLockOwner, type ProcessLockOwner } from '../../common/process-lock-owner';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
export const OPEN_ID = /^ou_[A-Za-z0-9_-]{1,124}$/u;
export const STOCKTAKE_RECIPIENT_SOURCE = 'warehouse_responsible';

export interface StocktakeReminderDelivery {
  openId: string;
  uuid: string;
  payloadSha256: string;
  firstAttemptAt: number;
  retryAt: number;
  owner: ProcessLockOwner | null;
  messageId: string | null;
  sentAt: number | null;
  needsReview: boolean;
}

export interface StocktakeReminderBatch {
  month: string;
  building: WarehouseBuilding;
  period: string;
  routingError: 'recipients-unavailable' | 'no-authorized-recipient' | 'public-url-invalid' | null;
  routingComplete: boolean;
  routingSource?: typeof STOCKTAKE_RECIPIENT_SOURCE;
  routedOpenIds?: string[];
  retryRoutingAt: number;
  deliveries: StocktakeReminderDelivery[];
}

export function validStocktakeReminders(batches: StocktakeReminderBatch[]): boolean {
  return Array.isArray(batches) && batches.every(batch => batch &&
    MONTH.test(batch.month) && WAREHOUSE_BUILDINGS.includes(batch.building) &&
    (batch.period === 'initial' || weeklyDate(batch.period, batch.month)) &&
    [null, 'recipients-unavailable', 'no-authorized-recipient', 'public-url-invalid'].includes(batch.routingError) &&
    typeof batch.routingComplete === 'boolean' && validTime(batch.retryRoutingAt) &&
    (batch.routingSource === undefined ? batch.routedOpenIds === undefined :
      batch.routingSource === STOCKTAKE_RECIPIENT_SOURCE && Array.isArray(batch.routedOpenIds) &&
      batch.routedOpenIds.every(id => typeof id === 'string' && OPEN_ID.test(id)) &&
      new Set(batch.routedOpenIds).size === batch.routedOpenIds.length &&
      (!batch.routingComplete || batch.routedOpenIds.length > 0)) &&
    Array.isArray(batch.deliveries) &&
    batch.deliveries.every(row => row && OPEN_ID.test(row.openId) &&
      /^[a-f0-9-]{36}$/.test(row.uuid) && /^[a-f0-9]{64}$/.test(row.payloadSha256) &&
      validTime(row.firstAttemptAt) && validTime(row.retryAt) &&
      typeof row.needsReview === 'boolean' && (row.owner === null || Boolean(normalizeProcessLockOwner(row.owner))) &&
      (row.messageId === null ? row.sentAt === null : /^om_[A-Za-z0-9_-]+$/.test(row.messageId) && validTime(row.sentAt)) &&
      (!row.owner || (!row.messageId && !row.needsReview)) && !(row.messageId && row.needsReview)) &&
    new Set(batch.deliveries.map(row => row.openId)).size === batch.deliveries.length) &&
    new Set(batches.map(batch => `${batch.month}:${batch.building}:${batch.period}`)).size === batches.length;
}

function validTime(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function weeklyDate(value: string, month: string): boolean {
  if (!value.startsWith(`${month}-`) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return date.getUTCDay() === 1 && date.toISOString().slice(0, 10) === value;
}

export function stocktakeReminderWeek(now: number, month: string): { period: string; startsAt: number } | null {
  const local = new Date(now + SHANGHAI_OFFSET_MS);
  const weekday = (local.getUTCDay() + 6) % 7;
  const monday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - weekday * DAY_MS;
  const period = new Date(monday).toISOString().slice(0, 10);
  const startsAt = monday - SHANGHAI_OFFSET_MS;
  return period.startsWith(`${month}-`) && now >= startsAt + 9 * 60 * 60_000 ? { period, startsAt } : null;
}

export function hasOutstandingStocktake(sheet: StocktakeSheet): boolean {
  return Boolean(sheet.review && (sheet.status !== 'completed' || sheet.review.status !== 'completed'));
}

export function buildStocktakeReminderCard(sheet: StocktakeSheet, period: string, principal: AccessPrincipal, baseUrl: URL): Record<string, unknown> | null {
  const review = sheet.review;
  if (!review || !hasOutstandingStocktake(sheet)) return null;
  const decide = createBusinessPermissionEvaluator(principal);
  const canRead = (line: StocktakeSheet['lines'][number]) => decide({ module: 'stocktake', action: 'read', building: sheet.building, specialty: line.inventory.specialty }).allowed;
  const sampleLines = sheet.lines.filter(canRead);
  const reviewLines = review.lines.filter(canRead);
  if (!sampleLines.length && !reviewLines.length && (sheet.lines.length || review.lines.length)) return null;
  const initial = period === 'initial';
  const samplePending = sampleLines.filter(line => line.status !== 'confirmed').length;
  const reviewPending = reviewLines.filter(line => line.status !== 'confirmed').length;
  const sampleOpen = sheet.status !== 'completed' && (sampleLines.length > 0 || !sheet.lines.length);
  const reviewOpen = review.status !== 'completed' && (reviewLines.length > 0 || !review.lines.length);
  if (!initial && !sampleOpen && !reviewOpen) return null;
  const scope = samplePending || (!reviewPending && sampleOpen) || !reviewLines.length ? 'sample' : 'review';
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/inventory-management`;
  url.search = new URLSearchParams({ view: 'stocktake', action: 'execute', scope, month: sheet.month, building: sheet.building }).toString();
  const [year, month] = sheet.month.split('-').map(Number);
  const deadline = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const fields = [
    `楼栋：${sheet.building}`,
    `盘点月份：${sheet.month}`,
    `盘点数量：重点抽盘 ${sampleLines.length} 项 / 库存核盘 ${reviewLines.length} 项`,
    ...(initial ? [] : [`未确认：重点抽盘 ${samplePending} 项 / 库存核盘 ${reviewPending} 项`]),
    `截止日期：${deadline}`,
  ];
  return {
    config: { wide_screen_mode: true },
    header: { template: initial ? 'blue' : 'orange', title: { tag: 'plain_text', content: initial ? '月度库存盘点任务' : '月度库存盘点提醒' } },
    elements: [
      ...fields.map(content => ({ tag: 'div', text: { tag: 'plain_text', content } })),
      { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '前往库存盘点' }, type: 'primary', url: url.toString() }] },
    ],
  };
}
