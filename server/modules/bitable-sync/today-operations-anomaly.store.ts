import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { readEnv } from '../../common/config/external-services.config';
import type {
  TodayOperationsAnomaly,
  TodayOperationsAnomalyEvent,
  TodayOperationsAnomalyTerminal,
} from './today-operations-anomaly.types';

export const TODAY_OPERATIONS_ANOMALY_LEDGER_PATH = Symbol(
  'TODAY_OPERATIONS_ANOMALY_LEDGER_PATH',
);

export type TodayOperationsAnomalySyncStatus =
  | 'idle'
  | 'pending'
  | 'syncing'
  | 'completed';

export type TodayOperationsAnomalyProvisionStatus = 'pending' | 'completed';

export interface TodayOperationsAnomalyEntry {
  anomalyEvent: TodayOperationsAnomalyEvent;
  recordId: string;
  messageIds: string[];
  duplicateRecordIds: string[];
  provisionStatus: TodayOperationsAnomalyProvisionStatus;
  terminal: TodayOperationsAnomalyTerminal | null;
  terminalEventId: string;
  actorOpenId: string;
  actorName: string;
  handledAt: string;
  treatmentMeasure: string;
  syncStatus: TodayOperationsAnomalySyncStatus;
  syncAttempts: number;
  nextAttemptAt: string;
  lastError: string;
  createdAt: string;
  updatedAt: string;
}

interface Ledger {
  version: 2;
  entries: TodayOperationsAnomalyEntry[];
  completedScanDates?: string[];
}

interface LegacyEntry {
  anomaly: TodayOperationsAnomaly;
  recordId?: string;
  messageId?: string;
  terminal?: TodayOperationsAnomalyTerminal | null;
  terminalEventId?: string;
  actorOpenId?: string;
  actorName?: string;
  handledAt?: string;
  treatmentMeasure?: string;
  syncStatus?: TodayOperationsAnomalySyncStatus;
  syncAttempts?: number;
  nextAttemptAt?: string;
  lastError?: string;
  createdAt?: string;
  updatedAt?: string;
}

@Injectable()
export class TodayOperationsAnomalyStore {
  private readonly ledgerPath: string;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(
    @Optional()
    @Inject(TODAY_OPERATIONS_ANOMALY_LEDGER_PATH)
    ledgerPath?: string,
  ) {
    this.ledgerPath = resolve(
      ledgerPath ||
        readEnv('TODAY_OPERATIONS_ANOMALY_LEDGER_PATH') ||
        '../nantong-schedule-state/today-operations-anomaly-ledger.json',
    );
  }

  async isBusinessDateScanCompleted(businessDate: string): Promise<boolean> {
    assertBusinessDate(businessDate);
    return this.enqueue(async () => {
      const ledger = await this.read();
      return (ledger.completedScanDates || []).includes(businessDate);
    });
  }

  async markBusinessDateScanCompleted(businessDate: string): Promise<void> {
    assertBusinessDate(businessDate);
    await this.enqueue(async () => {
      const ledger = await this.read();
      if ((ledger.completedScanDates || []).includes(businessDate)) return;
      ledger.completedScanDates = unique([
        ...(ledger.completedScanDates || []),
        businessDate,
      ])
        .sort()
        .slice(-31);
      await this.write(ledger);
    });
  }

  async discoverAll(
    anomalies: TodayOperationsAnomaly[],
    now: Date = new Date(),
  ): Promise<{ created: boolean; entry: TodayOperationsAnomalyEntry }> {
    if (!anomalies.length) throw new Error('异常事件明细不能为空');
    const businessDate = anomalies[0].businessDate;
    if (anomalies.some((anomaly) => anomaly.businessDate !== businessDate)) {
      throw new Error('同一异常事件的业务日期必须一致');
    }
    return this.enqueue(async () => {
      const ledger = await this.read();
      const entriesForDate = ledger.entries.filter(
        (entry) => entry.anomalyEvent.businessDate === businessDate,
      );
      const knownIds = new Set(
        entriesForDate.flatMap((entry) =>
          entry.anomalyEvent.anomalies.map((anomaly) => anomaly.anomalyId),
        ),
      );
      const additions = anomalies.filter(
        (anomaly) => !knownIds.has(anomaly.anomalyId),
      );
      const existing = entriesForDate.find((entry) => !entry.terminal);
      if (existing) {
        if (!additions.length)
          return { created: false, entry: clone(existing) };
        existing.anomalyEvent.anomalies = sortAnomalies([
          ...existing.anomalyEvent.anomalies,
          ...clone(additions),
        ]);
        existing.provisionStatus = 'pending';
        existing.updatedAt = now.toISOString();
        existing.lastError = '';
        await this.write(ledger);
        return { created: false, entry: clone(existing) };
      }
      if (!additions.length && entriesForDate.length > 0) {
        return {
          created: false,
          entry: clone(entriesForDate[entriesForDate.length - 1]),
        };
      }

      const timestamp = now.toISOString();
      const entry: TodayOperationsAnomalyEntry = {
        anomalyEvent: createAnomalyEvent(
          additions,
          entriesForDate.length > 0
            ? stableTodayOperationsAnomalyBatchId(businessDate, additions)
            : undefined,
        ),
        recordId: '',
        messageIds: [],
        duplicateRecordIds: [],
        provisionStatus: 'pending',
        terminal: null,
        terminalEventId: '',
        actorOpenId: '',
        actorName: '',
        handledAt: '',
        treatmentMeasure: '',
        syncStatus: 'idle',
        syncAttempts: 0,
        nextAttemptAt: timestamp,
        lastError: '',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      ledger.entries.push(entry);
      await this.write(ledger);
      return { created: true, entry: clone(entry) };
    });
  }

  async reconcileScheduleConsistency(
    businessDate: string,
    currentAnomalies: TodayOperationsAnomaly[],
    now: Date = new Date(),
  ): Promise<{
    changed: boolean;
    autoResolved: boolean;
    entry: TodayOperationsAnomalyEntry | null;
  }> {
    assertBusinessDate(businessDate);
    if (
      currentAnomalies.some(
        (anomaly) =>
          anomaly.businessDate !== businessDate ||
          !isScheduleConsistencyAnomaly(anomaly),
      )
    ) {
      throw new TypeError('排班一致性复核事件范围无效');
    }

    return this.enqueue(async () => {
      const ledger = await this.read();
      const entry = ledger.entries.find(
        (candidate) =>
          candidate.anomalyEvent.businessDate === businessDate &&
          !candidate.terminal,
      );
      if (!entry) {
        return { changed: false, autoResolved: false, entry: null };
      }

      const previousScheduleAnomalies = entry.anomalyEvent.anomalies.filter(
        isScheduleConsistencyAnomaly,
      );
      if (previousScheduleAnomalies.length === 0) {
        return { changed: false, autoResolved: false, entry: clone(entry) };
      }

      const nonScheduleAnomalies = entry.anomalyEvent.anomalies.filter(
        (anomaly) => !isScheduleConsistencyAnomaly(anomaly),
      );
      const nextAnomalies = sortAnomalies(
        clone([...nonScheduleAnomalies, ...currentAnomalies]),
      );
      if (
        JSON.stringify(nextAnomalies) ===
        JSON.stringify(entry.anomalyEvent.anomalies)
      ) {
        return { changed: false, autoResolved: false, entry: clone(entry) };
      }

      const timestamp = now.toISOString();
      if (nextAnomalies.length === 0) {
        entry.terminal = 'resolved';
        entry.terminalEventId = `system:schedule-consistency:${businessDate}`;
        entry.actorOpenId = 'system';
        entry.actorName = '系统自动复核';
        entry.handledAt = timestamp;
        entry.treatmentMeasure = '排班数据已恢复一致';
        entry.syncStatus = 'pending';
        entry.nextAttemptAt = timestamp;
      } else {
        entry.anomalyEvent.anomalies = nextAnomalies;
        entry.provisionStatus = 'pending';
        entry.lastError = '';
      }
      entry.updatedAt = timestamp;
      await this.write(ledger);
      return {
        changed: true,
        autoResolved: nextAnomalies.length === 0,
        entry: clone(entry),
      };
    });
  }

  async get(
    anomalyEventId: string,
  ): Promise<TodayOperationsAnomalyEntry | null> {
    return this.enqueue(async () => {
      const ledger = await this.read();
      const entry = findEntry(ledger, anomalyEventId);
      return entry ? clone(entry) : null;
    });
  }

  async listUnprovisioned(): Promise<TodayOperationsAnomalyEntry[]> {
    return this.enqueue(async () => {
      const ledger = await this.read();
      return clone(
        ledger.entries.filter(
          (entry) =>
            entry.provisionStatus !== 'completed' ||
            !entry.recordId ||
            (!entry.messageIds.length && !entry.terminal),
        ),
      );
    });
  }

  async markBaseReady(anomalyEventId: string, recordId: string): Promise<void> {
    await this.patch(anomalyEventId, { recordId, lastError: '' });
  }

  async markCardSent(anomalyEventId: string, messageId: string): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.read();
      const entry = requireEntry(ledger, anomalyEventId);
      entry.messageIds = unique([...entry.messageIds, messageId]);
      entry.updatedAt = new Date().toISOString();
      entry.lastError = '';
      await this.write(ledger);
    });
  }

  async markProvisioned(
    anomalyEventId: string,
    now: Date = new Date(),
  ): Promise<void> {
    await this.patch(anomalyEventId, {
      provisionStatus: 'completed',
      duplicateRecordIds: [],
      lastError: '',
      updatedAt: now.toISOString(),
    });
  }

  async markProvisionFailed(
    anomalyEventId: string,
    error: unknown,
  ): Promise<void> {
    await this.patch(anomalyEventId, { lastError: safeError(error) });
  }

  async claimTerminal(
    input: {
      anomalyEventId: string;
      recordId?: string;
      eventId: string;
      terminal: TodayOperationsAnomalyTerminal;
      actorOpenId: string;
      actorName: string;
      messageId: string;
      treatmentMeasure?: string;
    },
    now: Date = new Date(),
  ): Promise<{ claimed: boolean; entry: TodayOperationsAnomalyEntry }> {
    return this.enqueue(async () => {
      const ledger = await this.read();
      const entry = requireEntry(ledger, input.anomalyEventId);
      if (
        (input.recordId !== undefined && entry.recordId !== input.recordId) ||
        !entry.messageIds.includes(input.messageId)
      ) {
        throw new NotFoundException('今日航图异常事件不存在');
      }
      if (
        entry.terminalEventId === input.eventId ||
        entry.terminal === 'resolved' ||
        (entry.terminal === 'acknowledged' &&
          (input.terminal === 'acknowledged' ||
            entry.syncStatus !== 'completed'))
      ) {
        return { claimed: false, entry: clone(entry) };
      }
      const timestamp = now.toISOString();
      entry.terminal = input.terminal;
      entry.terminalEventId = input.eventId;
      entry.actorOpenId = input.actorOpenId;
      entry.actorName = input.actorName;
      entry.handledAt = timestamp;
      entry.messageIds = unique([...entry.messageIds, input.messageId]);
      entry.treatmentMeasure = input.treatmentMeasure || '';
      entry.syncStatus = 'pending';
      entry.nextAttemptAt = timestamp;
      entry.updatedAt = timestamp;
      entry.lastError = '';
      await this.write(ledger);
      return { claimed: true, entry: clone(entry) };
    });
  }

  async listPendingSync(
    now: Date = new Date(),
  ): Promise<TodayOperationsAnomalyEntry[]> {
    return this.enqueue(async () => {
      const ledger = await this.read();
      return clone(
        ledger.entries.filter(
          (entry) =>
            Boolean(entry.terminal) &&
            entry.syncStatus !== 'completed' &&
            Date.parse(entry.nextAttemptAt) <= now.getTime(),
        ),
      );
    });
  }

  async markSyncing(
    anomalyEventId: string,
    now: Date = new Date(),
  ): Promise<void> {
    await this.patch(anomalyEventId, {
      syncStatus: 'syncing',
      updatedAt: now.toISOString(),
    });
  }

  async markSynced(
    anomalyEventId: string,
    now: Date = new Date(),
  ): Promise<void> {
    await this.patch(anomalyEventId, {
      syncStatus: 'completed',
      nextAttemptAt: '',
      lastError: '',
      updatedAt: now.toISOString(),
    });
  }

  async markSyncFailed(
    anomalyEventId: string,
    error: unknown,
    now: Date = new Date(),
  ): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.read();
      const entry = requireEntry(ledger, anomalyEventId);
      entry.syncAttempts += 1;
      entry.syncStatus = 'pending';
      entry.lastError = safeError(error);
      entry.updatedAt = now.toISOString();
      entry.nextAttemptAt = new Date(
        now.getTime() + Math.min(30 * 60_000, 2_000 * 2 ** entry.syncAttempts),
      ).toISOString();
      await this.write(ledger);
    });
  }

  private async patch(
    anomalyEventId: string,
    patch: Partial<TodayOperationsAnomalyEntry>,
  ): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.read();
      const entry = requireEntry(ledger, anomalyEventId);
      Object.assign(entry, patch, {
        updatedAt: patch.updatedAt || new Date().toISOString(),
      });
      await this.write(ledger);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async read(): Promise<Ledger> {
    try {
      const parsed = JSON.parse(await readFile(this.ledgerPath, 'utf8')) as {
        version?: unknown;
        entries?: unknown;
        completedScanDates?: unknown;
      };
      if (!Array.isArray(parsed.entries)) {
        throw new Error('今日航图异常台账格式无效');
      }
      if (parsed.version === 2) {
        if (
          parsed.completedScanDates !== undefined &&
          (!Array.isArray(parsed.completedScanDates) ||
            parsed.completedScanDates.some(
              (value) =>
                typeof value !== 'string' ||
                !/^\d{4}-\d{2}-\d{2}$/u.test(value),
            ))
        ) {
          throw new Error('今日航图异常台账扫描日期格式无效');
        }
        return parsed as Ledger;
      }
      if (parsed.version === 1) {
        const migrated = migrateLegacyLedger(parsed.entries as LegacyEntry[]);
        await this.write(migrated);
        return migrated;
      }
      throw new Error('今日航图异常台账格式无效');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { version: 2, entries: [] };
      }
      throw error;
    }
  }

  private async write(ledger: Ledger): Promise<void> {
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    const tempPath = `${this.ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(ledger, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(tempPath, this.ledgerPath);
  }
}

export function stableTodayOperationsAnomalyEventId(
  businessDate: string,
): string {
  return createHash('sha256')
    .update(`today-operations-anomaly-event:${businessDate}`)
    .digest('hex');
}

function createAnomalyEvent(
  anomalies: TodayOperationsAnomaly[],
  anomalyEventId?: string,
): TodayOperationsAnomalyEvent {
  const sorted = sortAnomalies(clone(anomalies));
  return {
    anomalyEventId:
      anomalyEventId ||
      stableTodayOperationsAnomalyEventId(sorted[0].businessDate),
    businessDate: sorted[0].businessDate,
    anomalies: sorted,
    detectedAt: sorted.map((anomaly) => anomaly.detectedAt).sort()[0],
  };
}

function stableTodayOperationsAnomalyBatchId(
  businessDate: string,
  anomalies: TodayOperationsAnomaly[],
): string {
  const anomalyIds = anomalies
    .map((anomaly) => anomaly.anomalyId)
    .sort()
    .join(',');
  return createHash('sha256')
    .update(`today-operations-anomaly-batch:${businessDate}:${anomalyIds}`)
    .digest('hex');
}

function migrateLegacyLedger(entries: LegacyEntry[]): Ledger {
  const byDate = new Map<string, LegacyEntry[]>();
  for (const entry of entries) {
    if (!entry?.anomaly?.businessDate) continue;
    const current = byDate.get(entry.anomaly.businessDate) || [];
    current.push(entry);
    byDate.set(entry.anomaly.businessDate, current);
  }
  return {
    version: 2,
    entries: Array.from(byDate.values()).map((group) => {
      const terminalEntry = group.find((entry) => entry.terminal) || group[0];
      const canonical = terminalEntry.recordId ? terminalEntry : group[0];
      const timestamp =
        canonical.updatedAt || canonical.createdAt || new Date().toISOString();
      const recordIds = unique(
        group.map((entry) => entry.recordId || '').filter(Boolean),
      );
      const recordId = canonical.recordId || recordIds[0] || '';
      return {
        anomalyEvent: createAnomalyEvent(group.map((entry) => entry.anomaly)),
        recordId,
        messageIds: unique(
          group.map((entry) => entry.messageId || '').filter(Boolean),
        ),
        duplicateRecordIds: recordIds.filter(
          (candidate) => candidate !== recordId,
        ),
        provisionStatus: 'pending',
        terminal: terminalEntry.terminal || null,
        terminalEventId: terminalEntry.terminalEventId || '',
        actorOpenId: terminalEntry.actorOpenId || '',
        actorName: terminalEntry.actorName || '',
        handledAt: terminalEntry.handledAt || '',
        treatmentMeasure: terminalEntry.treatmentMeasure || '',
        syncStatus: terminalEntry.terminal ? 'pending' : 'idle',
        syncAttempts: terminalEntry.syncAttempts || 0,
        nextAttemptAt:
          terminalEntry.nextAttemptAt ||
          terminalEntry.anomaly.detectedAt ||
          timestamp,
        lastError: '',
        createdAt:
          group.map((entry) => entry.createdAt || timestamp).sort()[0] ||
          timestamp,
        updatedAt: timestamp,
      } satisfies TodayOperationsAnomalyEntry;
    }),
  };
}

function findEntry(
  ledger: Ledger,
  anomalyEventId: string,
): TodayOperationsAnomalyEntry | undefined {
  return ledger.entries.find(
    (candidate) =>
      candidate.anomalyEvent.anomalyEventId === anomalyEventId ||
      candidate.anomalyEvent.anomalies.some(
        (anomaly) => anomaly.anomalyId === anomalyEventId,
      ),
  );
}

function requireEntry(
  ledger: Ledger,
  anomalyEventId: string,
): TodayOperationsAnomalyEntry {
  const entry = findEntry(ledger, anomalyEventId);
  if (!entry) throw new NotFoundException('今日航图异常事件不存在');
  return entry;
}

function sortAnomalies(
  anomalies: TodayOperationsAnomaly[],
): TodayOperationsAnomaly[] {
  return anomalies.sort((left, right) =>
    `${left.location}|${left.metricKey}`.localeCompare(
      `${right.location}|${right.metricKey}`,
      'zh-CN',
    ),
  );
}

function isScheduleConsistencyAnomaly(
  anomaly: TodayOperationsAnomaly,
): boolean {
  return anomaly.metricKey.startsWith('scheduleConsistency.');
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function assertBusinessDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new TypeError('今日航图异常扫描业务日期无效');
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(
      /(app[_-]?secret|tenant[_-]?access[_-]?token|access[_-]?token|token|password|secret)/giu,
      'credential',
    )
    .replace(/[\r\n\t]/gu, ' ')
    .slice(0, 500);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
