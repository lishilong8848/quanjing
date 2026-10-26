import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { resolveDutyDailyReportStateFilePath } from './duty-daily-report-state-path';

export const DAILY_OPERATIONS_PATROL_LEDGER_PATH = Symbol(
  'DAILY_OPERATIONS_PATROL_LEDGER_PATH',
);

type DailyOperationsPatrolDeliveryStatus = 'pending' | 'failed' | 'sent';

export interface DailyOperationsPatrolDeliveryEntry {
  businessDate: string;
  status: DailyOperationsPatrolDeliveryStatus;
  digest: string;
  messageId: string;
  attempts: number;
  lastError: string;
  createdAt: string;
  updatedAt: string;
  sentAt: string;
}

interface DailyOperationsPatrolLedger {
  version: 1;
  entries: Record<string, DailyOperationsPatrolDeliveryEntry>;
}

@Injectable()
export class DailyOperationsPatrolStore {
  private readonly logger = new Logger(DailyOperationsPatrolStore.name);
  private readonly ledgerPath: string;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(
    @Optional()
    @Inject(DAILY_OPERATIONS_PATROL_LEDGER_PATH)
    ledgerPath?: string,
  ) {
    this.ledgerPath = resolve(
      ledgerPath ||
        process.env.NANTONG_DAILY_PATROL_LEDGER_PATH ||
        resolveDutyDailyReportStateFilePath({
          fileName: 'daily-operations-patrol-ledger.json',
          configuredDirectory: process.env.DUTY_DAILY_REPORT_STATE_DIR,
        }),
    );
  }

  async isSent(businessDate: string): Promise<boolean> {
    assertBusinessDate(businessDate);
    return this.enqueue(async () => {
      const ledger = await this.readLedger();
      return ledger.entries[businessDate]?.status === 'sent';
    });
  }

  async getDelivery(
    businessDate: string,
    deliveryIdentity?: string,
  ): Promise<DailyOperationsPatrolDeliveryEntry | null> {
    assertBusinessDate(businessDate);
    const entryKey = deliveryEntryKey(businessDate, deliveryIdentity);
    return this.enqueue(async () => {
      const ledger = await this.readLedger();
      const entry = ledger.entries[entryKey];
      return entry ? { ...entry } : null;
    });
  }

  async prepare(
    businessDate: string,
    digest: string,
    deliveryIdentity?: string,
  ): Promise<void> {
    assertBusinessDate(businessDate);
    if (!digest.trim()) throw new Error('巡视摘要不能为空');
    const entryKey = deliveryEntryKey(businessDate, deliveryIdentity);
    await this.enqueue(async () => {
      const ledger = await this.readLedger();
      const previous = ledger.entries[entryKey];
      if (previous?.status === 'sent') return;
      const now = new Date().toISOString();
      ledger.entries[entryKey] = {
        businessDate,
        status: 'pending',
        digest,
        messageId: '',
        attempts: (previous?.attempts || 0) + 1,
        lastError: '',
        createdAt: previous?.createdAt || now,
        updatedAt: now,
        sentAt: '',
      };
      await this.writeLedger(ledger);
    });
  }

  async markSent(
    businessDate: string,
    messageId: string,
    deliveryIdentity?: string,
  ): Promise<void> {
    assertBusinessDate(businessDate);
    if (!messageId.trim()) throw new Error('飞书消息 ID 不能为空');
    await this.updateEntry(
      businessDate,
      (entry, now) => ({
        ...entry,
        status: 'sent',
        messageId,
        lastError: '',
        updatedAt: now,
        sentAt: now,
      }),
      deliveryIdentity,
    );
  }

  async markFailed(
    businessDate: string,
    error: unknown,
    deliveryIdentity?: string,
  ): Promise<void> {
    assertBusinessDate(businessDate);
    await this.updateEntry(
      businessDate,
      (entry, now) => ({
        ...entry,
        status: 'failed',
        messageId: '',
        lastError: safeError(error),
        updatedAt: now,
        sentAt: '',
      }),
      deliveryIdentity,
    );
  }

  private async updateEntry(
    businessDate: string,
    update: (
      entry: DailyOperationsPatrolDeliveryEntry,
      now: string,
    ) => DailyOperationsPatrolDeliveryEntry,
    deliveryIdentity?: string,
  ): Promise<void> {
    const entryKey = deliveryEntryKey(businessDate, deliveryIdentity);
    await this.enqueue(async () => {
      const ledger = await this.readLedger();
      const entry = ledger.entries[entryKey];
      if (!entry) throw new Error(`巡视台账不存在：${entryKey}`);
      ledger.entries[entryKey] = update(entry, new Date().toISOString());
      await this.writeLedger(ledger);
    });
  }

  private async readLedger(): Promise<DailyOperationsPatrolLedger> {
    try {
      const parsed = JSON.parse(
        await readFile(this.ledgerPath, 'utf8'),
      ) as Partial<DailyOperationsPatrolLedger>;
      return {
        version: 1,
        entries:
          parsed.entries && typeof parsed.entries === 'object'
            ? parsed.entries
            : {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { version: 1, entries: {} };
      }
      this.logger.error(`读取巡视台账失败：${safeError(error)}`);
      throw error;
    }
  }

  private async writeLedger(
    ledger: DailyOperationsPatrolLedger,
  ): Promise<void> {
    ledger.entries = Object.fromEntries(
      Object.entries(ledger.entries)
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(-31),
    );
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    const temporaryPath = `${this.ledgerPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(ledger, null, 2)}\n`,
      'utf8',
    );
    await rename(temporaryPath, this.ledgerPath);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const execution = this.operation.then(operation, operation);
    this.operation = execution.catch(() => undefined);
    return execution;
  }
}

function assertBusinessDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`业务日期格式无效：${value}`);
  }
}

function deliveryEntryKey(
  businessDate: string,
  deliveryIdentity?: string,
): string {
  if (!deliveryIdentity) return businessDate;
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(deliveryIdentity)) {
    throw new Error(`巡视投递标识无效：${deliveryIdentity}`);
  }
  return `${businessDate}:${deliveryIdentity}`;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || '未知错误'))
    .replace(/[\r\n\t]+/gu, ' ')
    .trim()
    .slice(0, 1_000);
}
