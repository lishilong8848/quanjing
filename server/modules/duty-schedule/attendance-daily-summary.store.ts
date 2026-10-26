import { Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AttendanceAnomaly } from './attendance-automation.rules';
import type { AttendanceAutomationTask } from './attendance-automation.scheduler';
import { resolveDutyDailyReportStateFilePath } from './duty-daily-report-state-path';

type AttendanceLiveCheckTask = Exclude<
  AttendanceAutomationTask,
  'archive-yesterday'
>;

export interface AttendanceDailyCheckSummary {
  generatedAt: string;
  expectedKeys: string[];
  normalKeys: string[];
  excludedKeys: string[];
  anomalies: AttendanceAnomaly[];
}

export interface AttendanceDailySummary {
  version: 1;
  businessDate: string;
  generatedAt: string;
  source: 'dingtalk-archive';
  expected: number;
  normal: number;
  excluded: number;
  anomalies: AttendanceAnomaly[];
  checks?: Partial<
    Record<AttendanceLiveCheckTask, AttendanceDailyCheckSummary>
  >;
}

interface AttendanceDailySummaryLedger {
  version: 1;
  summaries: Record<string, AttendanceDailySummary>;
}

@Injectable()
export class AttendanceDailySummaryStore {
  private readonly logger = new Logger(AttendanceDailySummaryStore.name);
  private operation: Promise<unknown> = Promise.resolve();

  async read(businessDate: string): Promise<AttendanceDailySummary | null> {
    assertDateKey(businessDate);
    const ledger = await this.readLedger();
    return ledger.summaries[businessDate]
      ? structuredClone(ledger.summaries[businessDate])
      : null;
  }

  async write(summary: AttendanceDailySummary): Promise<void> {
    assertSummary(summary);
    await this.enqueue(async () => {
      const ledger = await this.readLedger();
      ledger.summaries[summary.businessDate] = structuredClone(summary);
      await this.writeLedger(ledger);
    });
  }

  async mergeLiveCheck(input: {
    task: AttendanceLiveCheckTask;
    businessDate: string;
    generatedAt: string;
    normal: Array<{ key: string }>;
    excluded: Array<{ key: string }>;
    anomalies: AttendanceAnomaly[];
    isExcluded?: (event: AttendanceAnomaly) => boolean;
  }): Promise<AttendanceDailySummary> {
    assertDateKey(input.businessDate);
    return this.enqueue(async () => {
      const ledger = await this.readLedger();
      const previous = ledger.summaries[input.businessDate];
      // Each scheduled read reevaluates every due overtime punch; discard older overtime projections, including cancelled/zero-hour approvals.
      const previousChecks = structuredClone(previous?.checks || {});
      Object.values(previousChecks).forEach((check) => {
        if (!check) return;
        const newlyExcluded = check.anomalies.filter((event) =>
          input.isExcluded?.(event),
        );
        check.excludedKeys = [
          ...new Set([
            ...check.excludedKeys,
            ...newlyExcluded.map((event) => event.key),
          ]),
        ];
        check.expectedKeys = check.expectedKeys.filter(
          (key) => !key.includes(':overtime_'),
        );
        check.normalKeys = check.normalKeys.filter(
          (key) => !key.includes(':overtime_'),
        );
        check.excludedKeys = check.excludedKeys.filter(
          (key) => !key.includes(':overtime_'),
        );
        check.anomalies = check.anomalies.filter(
          (item) => item.status !== 'overtime',
        );
      });
      const checks = {
        ...previousChecks,
        [input.task]: {
          generatedAt: input.generatedAt,
          expectedKeys: [
            ...input.normal.map((item) => item.key),
            ...input.anomalies.map((item) => item.key),
          ],
          normalKeys: input.normal.map((item) => item.key),
          excludedKeys: input.excluded.map((item) => item.key),
          anomalies: structuredClone(input.anomalies),
        },
      } satisfies Partial<
        Record<AttendanceLiveCheckTask, AttendanceDailyCheckSummary>
      >;
      const summary = aggregateChecks(input.businessDate, checks);
      ledger.summaries[input.businessDate] = summary;
      await this.writeLedger(ledger);
      return structuredClone(summary);
    });
  }

  private async writeLedger(
    ledger: AttendanceDailySummaryLedger,
  ): Promise<void> {
    ledger.summaries = Object.fromEntries(
      Object.entries(ledger.summaries)
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(-31),
    );
    const filePath = this.filePath();
    await mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(ledger, null, 2)}\n`,
      'utf8',
    );
    await rename(temporaryPath, filePath);
  }

  private async readLedger(): Promise<AttendanceDailySummaryLedger> {
    try {
      const parsed = JSON.parse(
        await readFile(this.filePath(), 'utf8'),
      ) as Partial<AttendanceDailySummaryLedger>;
      return {
        version: 1,
        summaries:
          parsed.summaries && typeof parsed.summaries === 'object'
            ? parsed.summaries
            : {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { version: 1, summaries: {} };
      }
      this.logger.error(
        `读取昨日考勤汇总失败：${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const execution = this.operation.then(operation, operation);
    this.operation = execution.catch(() => undefined);
    return execution;
  }

  private filePath(): string {
    return resolveDutyDailyReportStateFilePath({
      fileName: 'attendance-daily-summary.json',
      explicitPath: process.env.ATTENDANCE_DAILY_SUMMARY_PATH,
      configuredDirectory:
        process.env.ATTENDANCE_AUTOMATION_STATE_DIR ||
        process.env.DUTY_DAILY_REPORT_STATE_DIR,
    });
  }
}

function aggregateChecks(
  businessDate: string,
  checks: Partial<Record<AttendanceLiveCheckTask, AttendanceDailyCheckSummary>>,
): AttendanceDailySummary {
  const expectedKeys = new Set<string>();
  const normalKeys = new Set<string>();
  const excludedKeys = new Set<string>();
  const anomalies = new Map<string, AttendanceAnomaly>();
  let generatedAt = '';

  Object.values(checks).forEach((check) => {
    if (!check) return;
    if (check.generatedAt > generatedAt) generatedAt = check.generatedAt;
    check.expectedKeys.forEach((key) => expectedKeys.add(key));
    check.normalKeys.forEach((key) => normalKeys.add(key));
    check.excludedKeys.forEach((key) => excludedKeys.add(key));
    check.anomalies.forEach((anomaly) => anomalies.set(anomaly.key, anomaly));
  });
  anomalies.forEach((_anomaly, key) => normalKeys.delete(key));
  excludedKeys.forEach((key) => {
    expectedKeys.delete(key);
    normalKeys.delete(key);
    anomalies.delete(key);
  });

  return {
    version: 1,
    businessDate,
    generatedAt,
    source: 'dingtalk-archive',
    expected: expectedKeys.size,
    normal: normalKeys.size,
    excluded: excludedKeys.size,
    anomalies: [...anomalies.values()],
    checks,
  };
}

function assertSummary(summary: AttendanceDailySummary): void {
  assertDateKey(summary.businessDate);
  if (
    summary.version !== 1 ||
    summary.source !== 'dingtalk-archive' ||
    !Number.isFinite(summary.expected) ||
    !Number.isFinite(summary.normal) ||
    !Number.isFinite(summary.excluded) ||
    !Array.isArray(summary.anomalies)
  ) {
    throw new Error('昨日考勤汇总格式无效');
  }
}

function assertDateKey(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error('昨日考勤汇总日期无效');
  }
}
