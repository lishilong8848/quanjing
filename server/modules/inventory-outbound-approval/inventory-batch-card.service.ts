import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { InventoryOutboundApprovalGateway } from './inventory-outbound-approval.gateway';
import type { InventoryNotificationBatchKind } from './inventory-batch-notification-id';

export const INVENTORY_BATCH_CARD_LEDGER_PATH = Symbol('INVENTORY_BATCH_CARD_LEDGER_PATH');

export interface InventoryBatchCardItem {
  id: string;
  name: string;
  sku: string;
  specification: string;
  quantity: number;
  unit: string;
  building: string;
  location: string;
  status: string;
  approvalVersion?: number;
}

interface BatchCardEntry {
  key: string;
  kind: InventoryNotificationBatchKind;
  batchId: string;
  recipientOpenId: string;
  deliveryUuid: string;
  items: InventoryBatchCardItem[];
  revision: number;
  sentRevision: number;
  messageId?: string;
  inFlight?: { kind: 'send' | 'patch'; at: number; revision: number };
}

const MAX_ITEMS = 50;
const IN_FLIGHT_TIMEOUT_MS = 120_000;

@Injectable()
export class InventoryBatchCardService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InventoryBatchCardService.name);
  private readonly ledgerPath: string;
  private readonly lockPath: string;
  private readonly localFlights = new Map<string, Promise<string>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly gateway: InventoryOutboundApprovalGateway,
    @Optional() @Inject(INVENTORY_BATCH_CARD_LEDGER_PATH) ledgerPath?: string,
  ) {
    this.ledgerPath = resolve(ledgerPath || join(process.cwd(), '.runtime', 'inventory-batch-cards.json'));
    this.lockPath = `${this.ledgerPath}.lock`;
  }

  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      this.timer = setInterval(() => void this.flushPending(), 5_000);
      this.timer.unref?.();
      void this.flushPending();
    });
  }

  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async upsert(
    kind: InventoryNotificationBatchKind,
    batchId: string,
    recipientOpenId: string,
    item: InventoryBatchCardItem,
  ): Promise<string> {
    if (!/^[a-f0-9]{32}$/u.test(batchId) || !/^ou_[A-Za-z0-9_-]{1,124}$/u.test(recipientOpenId)) {
      throw new Error('批量通知标识或收件人无效');
    }
    const normalized = normalizeItem(item);
    const key = `${kind}:${batchId}:${recipientOpenId}`;
    const existing = await this.withLock(async () => {
      const entries = await this.read();
      let entry = entries.find((candidate) => candidate.key === key);
      if (!entry) {
        entry = {
          key, kind, batchId, recipientOpenId, deliveryUuid: randomUUID(),
          items: [], revision: 0, sentRevision: 0,
        };
        entries.push(entry);
      }
      const prior = entry.items.find((candidate) => candidate.id === normalized.id);
      if (prior) {
        if (normalized.status === '审批失效' && normalized.approvalVersion && prior.approvalVersion &&
          prior.approvalVersion > normalized.approvalVersion && sameBatchItemBusinessIdentity(prior, normalized)) return entry.messageId;
        const { status: oldStatus, ...oldIdentity } = prior;
        const { status: newStatus, ...newIdentity } = normalized;
        if (JSON.stringify(oldIdentity) !== JSON.stringify(newIdentity)) {
          if (oldStatus !== '审批失效' || !prior.approvalVersion || !normalized.approvalVersion || normalized.approvalVersion <= prior.approvalVersion) {
            throw new Error('同一批量通知明细与已持久化内容冲突');
          }
          entry.items.splice(entry.items.indexOf(prior), 1, normalized);
          entry.revision += 1;
          await this.write(entries);
        } else if (oldStatus !== newStatus) {
          if (oldStatus === '已出库' || oldStatus === '已驳回' || oldStatus === '审批失效') {
            if (newStatus !== '待审批' && newStatus !== '同步中') throw new Error('批量通知终态与已持久化内容冲突');
          } else if (newStatus !== '待审批') {
            prior.status = newStatus;
            entry.revision += 1;
            await this.write(entries);
          }
        }
      }
      if (!prior) {
        if (entry.items.length >= MAX_ITEMS) throw new Error('批量通知明细超过上限');
        entry.items.push(normalized);
        entry.revision += 1;
        await this.write(entries);
      }
      return entry.messageId;
    });
    if (existing) {
      void this.flushKey(key).catch((error) => this.logger.warn(`批量通知更新待重试：${safeError(error)}`));
      return existing;
    }
    return this.flushKey(key);
  }

  async upsertConfirmed(kind: InventoryNotificationBatchKind, batchId: string, recipientOpenId: string, item: InventoryBatchCardItem): Promise<string> {
    const normalized = normalizeItem(item);
    await this.upsert(kind, batchId, recipientOpenId, normalized);
    const key = `${kind}:${batchId}:${recipientOpenId}`;
    await this.flushKey(key);
    return this.withLock(async () => {
      const entry = (await this.read()).find(candidate => candidate.key === key);
      const current = entry?.items.find(candidate => candidate.id === normalized.id);
      const newerVersion = normalized.status === '审批失效' && normalized.approvalVersion && current?.approvalVersion && current.approvalVersion > normalized.approvalVersion;
      if (!entry?.messageId || entry.inFlight || entry.sentRevision < entry.revision || !current ||
        !sameBatchItemBusinessIdentity(current, normalized) || (!newerVersion && (current.status !== normalized.status || current.approvalVersion !== normalized.approvalVersion))) {
        throw new ServiceUnavailableException('批量审批卡的当前版本尚未确认，可安全重试');
      }
      return entry.messageId;
    });
  }

  async render(kind: InventoryNotificationBatchKind, batchId: string, recipientOpenId: string): Promise<Record<string, unknown>> {
    return this.withLock(async () => {
      const entry = (await this.read()).find((candidate) => candidate.key === `${kind}:${batchId}:${recipientOpenId}`);
      if (!entry) throw new Error('批量通知卡片不存在');
      return buildBatchCard(entry);
    });
  }

  async flushPending(): Promise<void> {
    try {
      const keys = await this.withLock(async () => (await this.read())
        .filter((entry) => entry.revision > entry.sentRevision)
        .map((entry) => entry.key));
      await Promise.all(keys.map((key) => this.flushKey(key).catch((error) => {
        this.logger.warn(`批量通知投递待重试：${safeError(error)}`);
      })));
    } catch (error) {
      this.logger.error(`批量通知恢复扫描失败：${safeError(error)}`);
    }
  }

  private flushKey(key: string): Promise<string> {
    const existing = this.localFlights.get(key);
    if (existing) return existing;
    const flight = this.flushKeyOnce(key).finally(() => {
      if (this.localFlights.get(key) === flight) this.localFlights.delete(key);
    });
    this.localFlights.set(key, flight);
    return flight;
  }

  private async flushKeyOnce(key: string): Promise<string> {
    const claim = await this.withLock(async () => {
      const entries = await this.read();
      const entry = entries.find((candidate) => candidate.key === key);
      if (!entry) throw new Error('批量通知任务不存在');
      if (entry.revision <= entry.sentRevision && entry.messageId) return { state: 'done' as const, messageId: entry.messageId };
      if (entry.inFlight && Date.now() - entry.inFlight.at < IN_FLIGHT_TIMEOUT_MS) {
        return { state: 'busy' as const, messageId: entry.messageId };
      }
      const operation = entry.messageId ? 'patch' as const : 'send' as const;
      entry.inFlight = { kind: operation, at: Date.now(), revision: entry.revision };
      await this.write(entries);
      return { state: 'claimed' as const, operation, entry: structuredClone(entry) };
    });
    if (claim.state === 'done') return claim.messageId;
    if (claim.state === 'busy') {
      if (claim.messageId) return claim.messageId;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      return this.flushKeyOnce(key);
    }
    const { entry, operation } = claim;
    let messageId = entry.messageId;
    try {
      const card = buildBatchCard(entry);
      if (operation === 'send') {
        messageId = await this.gateway.sendInteractiveCard(entry.recipientOpenId, card, entry.deliveryUuid);
      } else {
        await this.gateway.patchInteractiveCard(messageId!, card);
      }
      const needsUpdate = await this.withLock(async () => {
        const entries = await this.read();
        const current = entries.find((candidate) => candidate.key === key);
        if (!current) throw new Error('批量通知任务已丢失');
        if (current.deliveryUuid !== entry.deliveryUuid) throw new Error('批量通知幂等键冲突');
        current.messageId = messageId;
        current.sentRevision = Math.max(current.sentRevision, entry.inFlight!.revision);
        delete current.inFlight;
        await this.write(entries);
        return current.revision > current.sentRevision;
      });
      if (needsUpdate) return this.flushKeyOnce(key);
      return messageId!;
    } catch (error) {
      await this.withLock(async () => {
        const entries = await this.read();
        const current = entries.find((candidate) => candidate.key === key);
        if (current?.inFlight?.at === entry.inFlight?.at) {
          delete current.inFlight;
          await this.write(entries);
        }
      });
      throw error;
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const handle = await open(this.lockPath, 'wx');
        try { return await operation(); }
        finally { await handle.close(); await unlink(this.lockPath).catch(() => undefined); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const age = await stat(this.lockPath).then((value) => Date.now() - value.mtimeMs).catch(() => 0);
        if (age > 30_000) await unlink(this.lockPath).catch(() => undefined);
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
    }
    throw new ServiceUnavailableException('批量通知账本暂时繁忙');
  }

  private async read(): Promise<BatchCardEntry[]> {
    const raw = await readFile(this.ledgerPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '[]';
      throw error;
    });
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('批量通知账本损坏');
    return parsed as BatchCardEntry[];
  }

  private async write(entries: BatchCardEntry[]): Promise<void> {
    const temporary = `${this.ledgerPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(entries), { encoding: 'utf8', flag: 'wx' });
    try { await rename(temporary, this.ledgerPath); }
    catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
}

function sameBatchItemBusinessIdentity(left: InventoryBatchCardItem, right: InventoryBatchCardItem): boolean {
  const { status: _leftStatus, approvalVersion: _leftVersion, ...leftIdentity } = left;
  const { status: _rightStatus, approvalVersion: _rightVersion, ...rightIdentity } = right;
  return JSON.stringify(leftIdentity) === JSON.stringify(rightIdentity);
}

function normalizeItem(item: InventoryBatchCardItem): InventoryBatchCardItem {
  if (!item || !/^[A-Za-z0-9_-]{1,100}$/u.test(item.id) || !Number.isFinite(item.quantity) || item.quantity <= 0) {
    throw new Error('批量通知明细无效');
  }
  const text = (value: string, limit: number) => String(value || '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').trim().slice(0, limit);
  if (item.approvalVersion !== undefined && (!Number.isSafeInteger(item.approvalVersion) || item.approvalVersion < 1)) {
    throw new Error('批量审批版本无效');
  }
  return { id: item.id, name: text(item.name, 100), sku: text(item.sku, 80), specification: text(item.specification, 120), quantity: item.quantity, unit: text(item.unit, 20), building: text(item.building, 40), location: text(item.location, 120), status: text(item.status, 40), ...(item.approvalVersion === undefined ? {} : { approvalVersion: item.approvalVersion }) };
}

function buildBatchCard(entry: BatchCardEntry): Record<string, unknown> {
  const hasPending = entry.kind === 'outbound' && entry.items.some((item) => item.status === '待审批');
  const title = entry.kind === 'inbound' ? '批量入库完成' : hasPending ? '批量出库待审批' : '批量出库结果';
  const escape = (value: string) => value.replace(/[\\`*_\[\]<>]/gu, '\\$&');
  const visible = entry.kind === 'outbound' && hasPending
    ? entry.items.filter((item) => item.status === '待审批').slice(0, 12)
    : entry.items.slice(0, 12);
  const visibleIds = new Set(visible.map((item) => item.id));
  const elements = visible.flatMap((item) => {
    const index = entry.items.indexOf(item);
    const detail = {
      tag: 'markdown',
      content: `${index + 1}. **${escape((item.name || item.sku).slice(0, 50))}** · ${escape(item.sku.slice(0, 40))} · ${item.quantity} ${escape(item.unit)} · ${escape(item.status)}\n型号：${escape(item.specification.slice(0, 60) || '-')}；楼栋 / 库位：${escape(item.building.slice(0, 30))} / ${escape(item.location.slice(0, 60) || '-')}`,
    };
    if (entry.kind !== 'outbound' || item.status !== '待审批' || !item.approvalVersion) return [detail];
    const button = (label: string, type: string, action: string) => ({
      tag: 'button', type, text: { tag: 'plain_text', content: label },
      behaviors: [{ type: 'callback', value: {
        workflowType: 'inventory_outbound', action,
        recordId: item.id, version: item.approvalVersion,
      } }],
    });
    return [detail, { tag: 'column_set', columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [button('同意', 'primary_filled', 'approve')] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [button('驳回', 'danger', 'open_reject')] },
    ] }];
  });
  const remaining = entry.items.filter((item) => !visibleIds.has(item.id));
  if (remaining.length) {
    elements.push({ tag: 'markdown', content: `其余 ${remaining.length} 项：\n${remaining.map((item) => {
      const index = entry.items.indexOf(item);
      return `${index + 1}. ${escape((item.name || item.sku).slice(0, 24))} · ${escape(item.sku.slice(0, 24))} · ${item.quantity} ${escape(item.unit.slice(0, 10))} · ${escape(item.status)}`;
    }).join('\n')}${hasPending ? '\n处理当前待审批项目后，后续项目会在本卡片显示审批按钮。' : ''}` });
  }
  return {
    schema: '2.0', config: { update_multi: true, wide_screen_mode: true },
    header: { template: entry.kind === 'inbound' ? 'green' : 'blue', title: { tag: 'plain_text', content: title } },
    body: { direction: 'vertical', padding: '12px', elements: [
      { tag: 'markdown', content: `共 ${entry.items.length} 项` },
      ...elements,
    ] },
  };
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, '$1 [redacted]')
    .replace(/\b(secret|token|password)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .slice(0, 300);
}
