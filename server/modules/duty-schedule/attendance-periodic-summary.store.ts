import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { resolveDutyDailyReportStateFilePath } from './duty-daily-report-state-path';
import type { AttendancePeriodicSummaryRun } from './attendance-periodic-summary.scheduler';

export const ATTENDANCE_PERIODIC_SUMMARY_LEDGER_PATH = Symbol(
  'ATTENDANCE_PERIODIC_SUMMARY_LEDGER_PATH',
);

type DeliveryStatus = 'pending' | 'failed' | 'sent';

interface DeliveryEntry {
  key: string;
  period: AttendancePeriodicSummaryRun['period'];
  startDate: string;
  endDate: string;
  status: DeliveryStatus;
  digest: string;
  messageId: string;
  attempts: number;
  lastError: string;
  createdAt: string;
  updatedAt: string;
  sentAt: string;
}

interface DeliveryLedger {
  version: 1;
  entries: Record<string, DeliveryEntry>;
}

@Injectable()
export class AttendancePeriodicSummaryStore {
  private readonly logger = new Logger(AttendancePeriodicSummaryStore.name);
  private readonly ledgerPath: string;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(
    @Optional()
    @Inject(ATTENDANCE_PERIODIC_SUMMARY_LEDGER_PATH)
    ledgerPath?: string,
  ) {
    this.ledgerPath = resolve(
      ledgerPath ||
        process.env.ATTENDANCE_PERIODIC_SUMMARY_LEDGER_PATH ||
        resolveDutyDailyReportStateFilePath({
          fileName: 'attendance-periodic-summary-ledger.json',
          configuredDirectory:
            process.env.ATTENDANCE_AUTOMATION_STATE_DIR ||
            process.env.DUTY_DAILY_REPORT_STATE_DIR,
        }),
    );
  }

  async isSent(key: string): Promise<boolean> {
    assertKey(key);
    return this.enqueue(async () => {
      const ledger = await this.readLedger();
      return ledger.entries[key]?.status === 'sent';
    });
  }

  async prepare(
    key: string,
    digest: string,
    run: AttendancePeriodicSummaryRun,
  ): Promise<void> {
    assertKey(key);
    if (!digest.trim()) throw new Error('考勤通晒摘要不能为空');
    await this.enqueue(async () => {
      const ledger = await this.readLedger();
      const previous = ledger.entries[key];
      if (previous?.status === 'sent') return;
      const now = new Date().toISOString();
      ledger.entries[key] = {
        key,
        period: run.period,
        startDate: run.startDate,
        endDate: run.endDate,
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

  async markSent(key: string, messageId: string): Promise<void> {
    if (!messageId.trim()) throw new Error('飞书消息 ID 不能为空');
    await this.updateEntry(key, (entry, now) => ({
      ...entry,
      status: 'sent',
      messageId,
      lastError: '',
      updatedAt: now,
      sentAt: now,
    }));
  }

  async markFailed(key: string, error: unknown): Promise<void> {
    await this.updateEntry(key, (entry, now) => ({
      ...entry,
      status: 'failed',
      messageId: '',
      lastError: safeError(error),
      updatedAt: now,
      sentAt: '',
    }));
  }

  private async updateEntry(
    key: string,
    update: (entry: DeliveryEntry, now: string) => DeliveryEntry,
  ): Promise<void> {
    assertKey(key);
    await this.enqueue(async () => {
      const ledger = await this.readLedger();
      const entry = ledger.entries[key];
      if (!entry) throw new Error(`考勤通晒台账不存在：${key}`);
      ledger.entries[key] = update(entry, new Date().toISOString());
      await this.writeLedger(ledger);
    });
  }

  private async readLedger(): Promise<DeliveryLedger> {
    try {
      const parsed = JSON.parse(
        await readFile(this.ledgerPath, 'utf8'),
      ) as Partial<DeliveryLedger>;
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
      this.logger.error(`读取考勤通晒台账失败：${safeError(error)}`);
      throw error;
    }
  }

  private async writeLedger(ledger: DeliveryLedger): Promise<void> {
    ledger.entries = Object.fromEntries(
      Object.entries(ledger.entries)
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(-160),
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

function assertKey(key: string): void {
  if (!/^(weekly|monthly):\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$/u.test(key)) {
    throw new Error(`考勤通晒台账键无效：${key}`);
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || '未知错误'))
    .replace(/[\r\n\t]+/gu, ' ')
    .trim()
    .slice(0, 1_000);
}
