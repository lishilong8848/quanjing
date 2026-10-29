import {
  ForbiddenException,
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { readEnv } from '../../common/config/external-services.config';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { assertFeishuBusinessIdentity } from '../../common/access/feishu-business-identity';
import { AttendanceDailySummaryStore } from '../duty-schedule/attendance-daily-summary.store';
import {
  buildTodayOperationsAnomalyCard,
  buildTodayOperationsAnomalyResolutionPromptCard,
  buildTodayOperationsAnomalySyncingCard,
  buildTodayOperationsAnomalyTerminalCard,
} from './today-operations-anomaly.card';
import { TodayOperationsAlarmService } from './today-operations-alarm.service';
import { TodayOperationsAnomalyGateway } from './today-operations-anomaly.gateway';
import {
  detectTodayOperationsAnomalies,
  detectTodayOperationsScheduleConsistencyAnomalies,
} from './today-operations-anomaly.rules';
import {
  TodayOperationsAnomalyStore,
  type TodayOperationsAnomalyEntry,
} from './today-operations-anomaly.store';
import type { TodayOperationsAnomalyTerminal } from './today-operations-anomaly.types';
import type {
  TodayOperationsAnomalyEvent,
  TodayOperationsFollowUpRecord,
  TodayOperationsFollowUpUpdate,
} from './today-operations-anomaly.types';
import { TodayOperationsKpiService } from './today-operations-kpi.service';
import { TodayOperationsOverviewService } from './today-operations-overview.service';
import { TodayOperationsScheduleConsistencyService } from './today-operations-schedule-consistency.service';
import { buildYesterdayAttendanceAnomalies } from './today-operations-attendance-anomaly';
import {
  buildAttendanceFollowUpEvents,
  buildPatrolFollowUpEvent,
} from './today-operations-follow-up';
import { TodayOperationsFollowUpTicketService } from './today-operations-follow-up.ticket';
import type { AttendanceSummarySection } from '../duty-schedule/attendance-automation.card';
import type { DailyOperationsPatrolReport } from '../duty-schedule/daily-operations-patrol.types';

@Injectable()
export class TodayOperationsAnomalyService {
  private readonly logger = new Logger(TodayOperationsAnomalyService.name);
  private activeRun: Promise<{
    detected: number;
    provisioned: number;
    failed: number;
  }> | null = null;

  constructor(
    private readonly kpiService: TodayOperationsKpiService,
    private readonly overviewService: TodayOperationsOverviewService,
    private readonly alarmService: TodayOperationsAlarmService,
    private readonly store: TodayOperationsAnomalyStore,
    private readonly gateway: TodayOperationsAnomalyGateway,
    @Optional()
    private readonly scheduleConsistencyService?: TodayOperationsScheduleConsistencyService,
    @Optional()
    private readonly attendanceSummaryStore?: AttendanceDailySummaryStore,
    @Optional()
    private readonly followUpTickets?: TodayOperationsFollowUpTicketService,
    @Inject(AccessConfigurationService)
    private readonly accessConfiguration?: AccessConfigurationService,
  ) {}

  isEnabled(): boolean {
    const value = readEnv('TODAY_OPERATIONS_ANOMALY_ENABLED').toLowerCase();
    return !['0', 'false', 'off', 'no'].includes(value);
  }

  runForBusinessDate(
    businessDate: string,
  ): Promise<{ detected: number; provisioned: number; failed: number }> {
    if (this.activeRun) return this.activeRun;
    this.activeRun = this.executeRun(businessDate).finally(() => {
      this.activeRun = null;
    });
    return this.activeRun;
  }

  isBusinessDateScanCompleted(businessDate: string): Promise<boolean> {
    return this.store.isBusinessDateScanCompleted(businessDate);
  }

  markBusinessDateScanCompleted(businessDate: string): Promise<void> {
    return this.store.markBusinessDateScanCompleted(businessDate);
  }

  async syncMorningFollowUps(input: {
    patrol: DailyOperationsPatrolReport | null;
    sections: readonly AttendanceSummarySection[];
    detectedAt: string;
  }): Promise<{ recordIds: string[] }> {
    const events = [
      ...(input.patrol
        ? [buildPatrolFollowUpEvent(input.patrol)].filter(
            (event): event is TodayOperationsAnomalyEvent => Boolean(event),
          )
        : []),
      ...buildAttendanceFollowUpEvents(input.sections, input.detectedAt),
    ];
    const recordIds: string[] = [];
    for (const event of events) {
      recordIds.push(await this.gateway.ensureFollowUpEvent(event));
    }
    return { recordIds };
  }

  issueFollowUpUrl(input: { from: string; through: string }): string {
    if (!this.followUpTickets) {
      throw new Error('异常跟进票据服务未配置');
    }
    return this.followUpTickets.issueUrl(input);
  }

  listFollowUps(
    from: string,
    through: string,
  ): Promise<TodayOperationsFollowUpRecord[]> {
    return this.gateway.listFollowUps(from, through);
  }

  async updateFollowUp(
    input: TodayOperationsFollowUpUpdate,
    scope: { from: string; through: string },
  ): Promise<TodayOperationsFollowUpRecord> {
    const current = await this.gateway.getFollowUp(input.recordId);
    if (current.date < scope.from || current.date > scope.through) {
      throw new ForbiddenException('异常跟进记录不在当前授权范围内');
    }
    return this.gateway.updateFollowUp(input);
  }

  async reconcileScheduleConsistencyForBusinessDate(
    businessDate: string,
  ): Promise<{ detected: number; changed: boolean; autoResolved: boolean }> {
    if (!this.isEnabled() || !this.scheduleConsistencyService) {
      return { detected: 0, changed: false, autoResolved: false };
    }
    const issues = await this.scheduleConsistencyService.scan(businessDate);
    const anomalies = detectTodayOperationsScheduleConsistencyAnomalies({
      businessDate,
      detectedAt: new Date().toISOString(),
      issues,
    });
    if (anomalies.length > 0) {
      await this.store.discoverAll(anomalies);
    }
    const reconciled = await this.store.reconcileScheduleConsistency(
      businessDate,
      anomalies,
    );
    return {
      detected: anomalies.length,
      changed: reconciled.changed,
      autoResolved: reconciled.autoResolved,
    };
  }

  async renderCardView(input: {
    anomalyEventId: string;
    recordId: string;
    actorOpenId: string;
    messageId: string;
    view: 'resolution' | 'anomaly';
  }): Promise<Record<string, unknown>> {
    this.assertActor(input.actorOpenId);
    const entry = await this.requireEntry(input.anomalyEventId, input.recordId);
    if (
      entry.terminal === 'resolved' ||
      (entry.terminal === 'acknowledged' && entry.syncStatus !== 'completed')
    ) {
      return this.cardForEntry(entry);
    }
    return input.view === 'resolution'
      ? buildTodayOperationsAnomalyResolutionPromptCard(
          entry.anomalyEvent,
          entry.recordId,
        )
      : buildTodayOperationsAnomalyCard(entry.anomalyEvent, entry.recordId);
  }

  async patchCardView(
    messageId: string,
    card: Record<string, unknown>,
  ): Promise<void> {
    await this.gateway.patchInteractiveCard(messageId, card);
  }

  async acceptTerminalAction(input: {
    anomalyEventId: string;
    recordId?: string;
    eventId: string;
    actorOpenId: string;
    messageId: string;
    terminal: TodayOperationsAnomalyTerminal;
    treatmentMeasure?: string;
  }): Promise<{ claimed: boolean; card: Record<string, unknown> }> {
    this.assertActor(input.actorOpenId);
    const claim = await this.store.claimTerminal({
      ...input,
      recordId: input.recordId,
      actorName: this.gateway.recipientName(),
    });
    return {
      claimed: claim.claimed,
      card: claim.claimed
        ? buildTodayOperationsAnomalySyncingCard(
            claim.entry.anomalyEvent,
            claim.entry.terminal!,
          )
        : this.cardForEntry(claim.entry),
    };
  }

  async runPendingTasks(): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;
    const unprovisioned = await this.store.listUnprovisioned();
    for (const entry of unprovisioned) {
      try {
        await this.provision(entry);
        processed += 1;
      } catch (error) {
        failed += 1;
        await this.store.markProvisionFailed(
          entry.anomalyEvent.anomalyEventId,
          error,
        );
        this.logger.warn(
          `今日航图异常事件建档、合并或发卡失败，将重试：event=${entry.anomalyEvent.anomalyEventId.slice(0, 12)}, error=${safeError(error)}`,
        );
      }
    }

    for (const entry of await this.store.listPendingSync()) {
      try {
        await this.syncTerminal(entry);
        processed += 1;
      } catch (error) {
        failed += 1;
        await this.store.markSyncFailed(
          entry.anomalyEvent.anomalyEventId,
          error,
        );
        this.logger.warn(
          `今日航图异常事件终态同步失败，将重试：event=${entry.anomalyEvent.anomalyEventId.slice(0, 12)}, error=${safeError(error)}`,
        );
      }
    }
    return { processed, failed };
  }

  private async executeRun(
    businessDate: string,
  ): Promise<{ detected: number; provisioned: number; failed: number }> {
    if (!this.isEnabled()) return { detected: 0, provisioned: 0, failed: 0 };
    const summaryDate = shiftDate(businessDate, -1);
    const [kpi, overview, alarms, scheduleConsistency, attendanceSummary] =
      await Promise.all([
        settle(() => this.kpiService.getKpisForAnomalyScan()),
        settle(() => this.overviewService.getOverview(true)),
        settle(() => this.alarmService.getDashboard({ refresh: '1' })),
        settle(() =>
          this.scheduleConsistencyService
            ? this.scheduleConsistencyService.scan(businessDate)
            : Promise.resolve([]),
        ),
        settle(() =>
          this.attendanceSummaryStore
            ? this.attendanceSummaryStore.read(summaryDate)
            : Promise.resolve(null),
        ),
      ]);
    const detectedAt = new Date().toISOString();
    const anomalies = [
      ...detectTodayOperationsAnomalies({
        businessDate,
        detectedAt,
        thresholdPercent: readThreshold(),
        ...(kpi.value ? { kpi: kpi.value } : { kpiError: kpi.error }),
        ...(overview.value
          ? { overview: overview.value }
          : { overviewError: overview.error }),
        ...(alarms.value
          ? { alarms: alarms.value }
          : { alarmError: alarms.error }),
        ...(scheduleConsistency.value
          ? { scheduleConsistencyIssues: [...scheduleConsistency.value] }
          : { scheduleConsistencyError: scheduleConsistency.error }),
      }),
      ...buildYesterdayAttendanceAnomalies({
        businessDate,
        summaryDate,
        summary: attendanceSummary.value ?? null,
        summaryError: attendanceSummary.error,
        detectedAt,
        required: Boolean(this.attendanceSummaryStore),
      }),
    ];
    if (anomalies.length) await this.store.discoverAll(anomalies);
    const result = await this.runPendingTasks();
    return {
      detected: anomalies.length,
      provisioned: result.processed,
      failed: result.failed,
    };
  }

  private async provision(entry: TodayOperationsAnomalyEntry): Promise<void> {
    let current = entry;
    if (!current.recordId) {
      const recordId = await this.gateway.ensureRecord(current.anomalyEvent);
      await this.store.markBaseReady(
        current.anomalyEvent.anomalyEventId,
        recordId,
      );
      current = (await this.store.get(current.anomalyEvent.anomalyEventId))!;
    } else {
      await this.gateway.writeEvent(current.recordId, current.anomalyEvent);
    }

    if (!current.messageIds.length && !current.terminal) {
      const messageId = await this.gateway.sendInteractiveCard(
        buildTodayOperationsAnomalyCard(current.anomalyEvent, current.recordId),
        current.anomalyEvent.anomalyEventId,
      );
      await this.store.markCardSent(
        current.anomalyEvent.anomalyEventId,
        messageId,
      );
      current = (await this.store.get(current.anomalyEvent.anomalyEventId))!;
    } else {
      const card = this.cardForEntry(current);
      for (const messageId of current.messageIds) {
        await this.gateway.patchInteractiveCard(messageId, card);
      }
    }

    for (const duplicateRecordId of current.duplicateRecordIds) {
      await this.gateway.deleteRecord(duplicateRecordId);
    }
    await this.store.markProvisioned(current.anomalyEvent.anomalyEventId);
  }

  private async syncTerminal(
    entry: TodayOperationsAnomalyEntry,
  ): Promise<void> {
    if (!entry.terminal || !entry.recordId) {
      throw new Error('异常事件终态同步缺少记录或处置状态');
    }
    await this.store.markSyncing(entry.anomalyEvent.anomalyEventId);
    await this.gateway.writeTerminal(entry.recordId, entry.anomalyEvent, {
      terminal: entry.terminal,
      actorName: entry.actorName,
      handledAt: entry.handledAt,
      ...(entry.treatmentMeasure
        ? { treatmentMeasure: entry.treatmentMeasure }
        : {}),
    });
    const terminalCard = buildTodayOperationsAnomalyTerminalCard(
      entry.anomalyEvent,
      {
        recordId: entry.recordId,
        terminal: entry.terminal,
        actorName: entry.actorName,
        handledAt: entry.handledAt,
        treatmentMeasure: entry.treatmentMeasure,
        synced: true,
      },
    );
    for (const messageId of entry.messageIds) {
      await this.gateway.patchInteractiveCard(messageId, terminalCard);
    }
    await this.store.markSynced(entry.anomalyEvent.anomalyEventId);
  }

  private async requireEntry(
    anomalyEventId: string,
    recordId?: string,
    messageId?: string,
  ): Promise<TodayOperationsAnomalyEntry> {
    const entry = await this.store.get(anomalyEventId);
    if (
      !entry ||
      (recordId !== undefined && entry.recordId !== recordId) ||
      (messageId !== undefined && !entry.messageIds.includes(messageId))
    ) {
      throw new NotFoundException('今日航图异常事件不存在');
    }
    return entry;
  }

  private assertActor(actorOpenId: string): void {
    assertFeishuBusinessIdentity(this.accessConfiguration, actorOpenId);
    if (actorOpenId !== this.gateway.recipientOpenId()) {
      throw new ForbiddenException('无权处理该今日航图异常提醒');
    }
  }

  private cardForEntry(
    entry: TodayOperationsAnomalyEntry,
  ): Record<string, unknown> {
    if (!entry.terminal) {
      return buildTodayOperationsAnomalyCard(
        entry.anomalyEvent,
        entry.recordId,
      );
    }
    if (entry.syncStatus !== 'completed') {
      return buildTodayOperationsAnomalySyncingCard(
        entry.anomalyEvent,
        entry.terminal,
      );
    }
    return buildTodayOperationsAnomalyTerminalCard(entry.anomalyEvent, {
      recordId: entry.recordId,
      terminal: entry.terminal,
      actorName: entry.actorName,
      handledAt: entry.handledAt,
      treatmentMeasure: entry.treatmentMeasure,
      synced: true,
    });
  }
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

function readThreshold(): number {
  const configured = Number(
    readEnv('TODAY_OPERATIONS_ANOMALY_CHANGE_THRESHOLD_PERCENT') || '50',
  );
  return Number.isFinite(configured) && configured >= 0 ? configured : 50;
}

async function settle<T>(
  operation: () => Promise<T>,
): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await operation() };
  } catch (error) {
    return { error: safeError(error) };
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(
      /(app[_-]?secret|tenant[_-]?access[_-]?token|access[_-]?token|password|secret)\s*[:=]\s*[^\s,;}&]+/giu,
      '$1=***',
    )
    .replace(/[\r\n\t]/gu, ' ')
    .slice(0, 300);
}
