import { Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AttendanceAutomationFeishuGateway } from './attendance-automation-feishu.gateway';
import { buildAttendancePeriodicSummaryCard } from './attendance-periodic-summary.card';
import type { AttendancePeriodicSummaryRun } from './attendance-periodic-summary.scheduler';
import { AttendancePeriodicSummaryStore } from './attendance-periodic-summary.store';
import { DailyOperationsPatrolGateway } from './daily-operations-patrol.gateway';
import { TodayOperationsAnomalyService } from '../bitable-sync/today-operations-anomaly.service';

export interface AttendancePeriodicSummaryRunResult {
  sent: boolean;
  skipped: boolean;
}

@Injectable()
export class AttendancePeriodicSummaryService {
  private readonly active = new Map<
    string,
    Promise<AttendancePeriodicSummaryRunResult>
  >();

  constructor(
    private readonly attendanceGateway: AttendanceAutomationFeishuGateway,
    private readonly groupGateway: DailyOperationsPatrolGateway,
    private readonly store: AttendancePeriodicSummaryStore,
    @Optional()
    private readonly followUpService?: TodayOperationsAnomalyService,
  ) {}

  run(
    run: AttendancePeriodicSummaryRun,
  ): Promise<AttendancePeriodicSummaryRunResult> {
    const key = summaryKey(run);
    const current = this.active.get(key);
    if (current) return current;
    let execution!: Promise<AttendancePeriodicSummaryRunResult>;
    execution = this.execute(run, key).finally(() => {
      if (this.active.get(key) === execution) this.active.delete(key);
    });
    this.active.set(key, execution);
    return execution;
  }

  private async execute(
    run: AttendancePeriodicSummaryRun,
    key: string,
  ): Promise<AttendancePeriodicSummaryRunResult> {
    if (await this.store.isSent(key)) return { sent: false, skipped: true };
    const summary = await this.attendanceGateway.readArchivedAttendancePeriod(
      run.startDate,
      run.endDate,
    );
    const card = buildAttendancePeriodicSummaryCard({
      period: run.period,
      startDate: run.startDate,
      endDate: run.endDate,
      fetchedAt: summary.fetchedAt,
      checkedCount: summary.checkedCount,
      anomalies: summary.anomalies,
      followUpUrl: this.followUpService?.issueFollowUpUrl({
        from: run.startDate,
        through: run.endDate,
      }),
    });
    const digest = createHash('sha256')
      .update(JSON.stringify(card))
      .digest('hex');
    await this.store.prepare(key, digest, run);
    try {
      const messageId =
        await this.groupGateway.sendAttendancePeriodicSummaryCard(card, run);
      await this.store.markSent(key, messageId);
      return { sent: true, skipped: false };
    } catch (error) {
      await this.store.markFailed(key, error);
      throw error;
    }
  }
}

export function summaryKey(run: AttendancePeriodicSummaryRun): string {
  return `${run.period}:${run.startDate}:${run.endDate}`;
}
