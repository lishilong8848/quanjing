import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  ChangeInfo,
  MonthlySchedule,
  SealingInfo,
} from '../../../shared/api.interface';
import type { TodayOperationsKpiResponse } from '../../../shared/today-operations-kpi.interface';
import { readPublicApplicationUrl } from '../../common/config/public-application-url';
import { BitableSyncService } from '../bitable-sync/bitable-sync.service';
import { TodayOperationsKpiService } from '../bitable-sync/today-operations-kpi.service';
import { TodayOperationsAnomalyService } from '../bitable-sync/today-operations-anomaly.service';
import { TodayOperationsFollowUpCardService } from '../bitable-sync/today-operations-follow-up-card.service';
import type { AttendanceSummarySection } from './attendance-automation.card';
import { buildDailyOperationsPatrolCard } from './daily-operations-patrol.card';
import { DailyOperationsPatrolGateway } from './daily-operations-patrol.gateway';
import {
  detectFacilityMetricIssues,
  detectPlanConflicts,
  detectScheduleRisks,
  detectWeatherAlerts,
  shiftDate,
  unavailablePatrolCheck,
} from './daily-operations-patrol.rules';
import { DailyOperationsPatrolStore } from './daily-operations-patrol.store';
import type {
  DailyOperationsPatrolCheckResult,
  DailyOperationsPatrolFacilityMetric,
  DailyOperationsPatrolReport,
} from './daily-operations-patrol.types';
import { DutyScheduleService } from './duty-schedule.service';

export interface DailyOperationsPatrolRunResult {
  sent: boolean;
  skipped: boolean;
  report?: DailyOperationsPatrolReport;
  messageId?: string;
}

@Injectable()
export class DailyOperationsPatrolService {
  private readonly logger = new Logger(DailyOperationsPatrolService.name);
  private readonly activeRuns = new Map<
    string,
    Promise<DailyOperationsPatrolRunResult>
  >();

  constructor(
    private readonly kpiService: TodayOperationsKpiService,
    private readonly dutyScheduleService: DutyScheduleService,
    private readonly bitableSyncService: BitableSyncService,
    private readonly store: DailyOperationsPatrolStore,
    private readonly gateway: DailyOperationsPatrolGateway,
    @Optional()
    private readonly followUpService?: TodayOperationsAnomalyService,
    @Optional() private readonly followUpCards?: TodayOperationsFollowUpCardService,
  ) {}

  isEnabled(): boolean {
    return (
      process.env.NANTONG_DAILY_PATROL_ENABLED?.trim().toLowerCase() !== 'false'
    );
  }

  runForBusinessDate(
    businessDate: string,
    now: Date = new Date(),
  ): Promise<DailyOperationsPatrolRunResult> {
    assertBusinessDate(businessDate);
    const active = this.activeRuns.get(businessDate);
    if (active) return active;
    const execution = this.execute(businessDate, now).finally(() => {
      if (this.activeRuns.get(businessDate) === execution) {
        this.activeRuns.delete(businessDate);
      }
    });
    this.activeRuns.set(businessDate, execution);
    return execution;
  }

  async sendMorningBriefCard(
    card: object,
    businessDate: string,
    deliveryIdentity?: string,
    followUpCardId?: string,
  ): Promise<string> {
    assertBusinessDate(businessDate);
    const existing = deliveryIdentity
      ? await this.store.getDelivery(businessDate, deliveryIdentity)
      : await this.store.getDelivery(businessDate);
    if (existing?.status === 'sent' && existing.messageId) {
      await this.gateway.updateCard(existing.messageId, card);
      if (followUpCardId) await this.requireFollowUpCards().bindMessage(followUpCardId, existing.messageId, card as Record<string, unknown>);
      return existing.messageId;
    }
    const digest = createHash('sha256')
      .update(JSON.stringify(card))
      .digest('hex');
    if (deliveryIdentity) {
      await this.store.prepare(businessDate, digest, deliveryIdentity);
    } else {
      await this.store.prepare(businessDate, digest);
    }
    try {
      const messageId = deliveryIdentity
        ? await this.gateway.sendCard(card, businessDate, deliveryIdentity)
        : await this.gateway.sendCard(card, businessDate);
      if (followUpCardId) await this.requireFollowUpCards().bindMessage(followUpCardId, messageId, card as Record<string, unknown>);
      if (deliveryIdentity) {
        await this.store.markSent(businessDate, messageId, deliveryIdentity);
      } else {
        await this.store.markSent(businessDate, messageId);
      }
      return messageId;
    } catch (error) {
      const markFailed = deliveryIdentity
        ? this.store.markFailed(businessDate, error, deliveryIdentity)
        : this.store.markFailed(businessDate, error);
      await markFailed.catch((storeError) =>
        this.logger.error(
          `记录统一巡视卡片发送失败状态失败：${safeError(storeError)}`,
        ),
      );
      throw error;
    }
  }

  async prepareMorningFollowUps(input: {
    patrol: DailyOperationsPatrolReport | null;
    sections: readonly AttendanceSummarySection[];
    detectedAt: string;
  }): Promise<{ recordIds: string[]; followUpCardId: string }> {
    if (!this.followUpService) {
      const hasAnomalies =
        Boolean(input.patrol?.totalIssues) ||
        input.sections.some((section) => section.anomalies.length > 0);
      if (hasAnomalies) throw new Error('异常跟进服务未配置');
      return { recordIds: [], followUpCardId: await this.requireFollowUpCards().prepare([], input.detectedAt.slice(0, 10)) };
    }
    const result = await this.followUpService.syncMorningFollowUps(input);
    const identity = input.patrol?.businessDate || input.sections.map(section => section.date).sort().join(':') || input.detectedAt.slice(0, 10);
    return { ...result, followUpCardId: await this.requireFollowUpCards().prepare(result.recordIds, identity) };
  }

  private requireFollowUpCards(): TodayOperationsFollowUpCardService {
    if (!this.followUpCards) throw new Error('异常跟进卡片服务未配置');
    return this.followUpCards;
  }

  private async execute(
    businessDate: string,
    now: Date,
  ): Promise<DailyOperationsPatrolRunResult> {
    if (await this.store.isSent(businessDate)) {
      return { sent: false, skipped: true };
    }
    const report = await this.collectReport(businessDate, now);
    const followUp = await this.prepareMorningFollowUps({
      patrol: report,
      sections: [],
      detectedAt: report.generatedAt,
    });
    const digest = createHash('sha256')
      .update(JSON.stringify(report))
      .digest('hex');
    await this.store.prepare(businessDate, digest);
    try {
      const card = buildDailyOperationsPatrolCard(report, { ...this.cardUrls(), followUpCardId: followUp.followUpCardId });
      const messageId = await this.gateway.sendCard(
        card,
        businessDate,
      );
      await this.requireFollowUpCards().bindMessage(followUp.followUpCardId, messageId, card);
      await this.store.markSent(businessDate, messageId);
      return { sent: true, skipped: false, report, messageId };
    } catch (error) {
      await this.store
        .markFailed(businessDate, error)
        .catch((storeError) =>
          this.logger.error(
            `记录巡视发送失败状态失败：${safeError(storeError)}`,
          ),
        );
      throw error;
    }
  }

  async collectReport(
    businessDate: string,
    now: Date = new Date(),
  ): Promise<DailyOperationsPatrolReport> {
    assertBusinessDate(businessDate);
    const endDate = shiftDate(businessDate, 7);
    const [facilitySource, scheduleSource, planSource, weatherSource] =
      await Promise.allSettled([
        this.kpiService.getKpisForAnomalyScan(businessDate),
        this.loadSchedules(shiftDate(businessDate, -1), endDate),
        this.loadPlans(businessDate, endDate),
        this.bitableSyncService.getWeatherWarningFetchResult(true),
      ]);

    const facility =
      facilitySource.status === 'fulfilled'
        ? this.buildFacilityCheck(facilitySource.value, businessDate)
        : unavailablePatrolCheck(
            'facility',
            '用电 / PUE / 水耗',
            facilitySource.reason,
          );
    const schedule =
      scheduleSource.status === 'fulfilled'
        ? detectScheduleRisks(scheduleSource.value, businessDate, endDate)
        : unavailablePatrolCheck(
            'schedule',
            '排班连班风险',
            scheduleSource.reason,
          );
    const plan =
      planSource.status === 'fulfilled'
        ? detectPlanConflicts(
            planSource.value.changes,
            planSource.value.sealings,
            businessDate,
            endDate,
          )
        : unavailablePatrolCheck('plan', '计划冲突', planSource.reason);
    const weather = this.buildWeatherCheck(weatherSource);
    const checks = [facility, schedule, plan, weather];
    const report = this.buildReport(
      businessDate,
      endDate,
      now,
      checks,
      facilitySource.status === 'fulfilled'
        ? countFacilityPoints(facilitySource.value)
        : 0,
    );
    return report;
  }

  private buildFacilityCheck(
    response: TodayOperationsKpiResponse,
    businessDate: string,
  ): DailyOperationsPatrolCheckResult {
    const metrics = response.details?.buildingMetrics;
    if (!metrics) {
      return unavailablePatrolCheck(
        'facility',
        '用电 / PUE / 水耗',
        '未获得楼栋指标历史数据',
      );
    }
    const input: DailyOperationsPatrolFacilityMetric[] = [
      {
        key: 'electricityKwh',
        label: '用电',
        unit: 'kWh',
        history: metrics.electricityKwh.history,
      },
      {
        key: 'averagePue',
        label: 'PUE',
        unit: '',
        history: metrics.averagePue.history,
      },
      {
        key: 'waterTons',
        label: '水耗',
        unit: '吨',
        history: metrics.waterTons.history,
      },
    ];
    return detectFacilityMetricIssues({ businessDate, metrics: input });
  }

  private buildWeatherCheck(
    source: PromiseSettledResult<
      Awaited<ReturnType<BitableSyncService['getWeatherWarningFetchResult']>>
    >,
  ): DailyOperationsPatrolCheckResult {
    if (source.status === 'rejected') {
      return unavailablePatrolCheck('weather', '天气告警', source.reason);
    }
    if (source.value.state !== 'fresh' || !source.value.data) {
      return unavailablePatrolCheck(
        'weather',
        '天气告警',
        source.value.errorMessage || `天气数据状态为 ${source.value.state}`,
      );
    }
    return detectWeatherAlerts(source.value.data.warning || []);
  }

  private async loadSchedules(
    startDate: string,
    endDate: string,
  ): Promise<MonthlySchedule[]> {
    const months = monthsBetween(startDate, endDate);
    const results = await Promise.all(
      months.map(({ year, month }) =>
        this.dutyScheduleService.getMonthlySchedules(year, month, true),
      ),
    );
    return results.flat();
  }

  private async loadPlans(
    startDate: string,
    endDate: string,
  ): Promise<{ changes: ChangeInfo[]; sealings: SealingInfo[] }> {
    const years = yearsBetween(startDate, endDate);
    const [changeResponses, sealingResponses] = await Promise.all([
      Promise.all(
        years.map((year) =>
          this.dutyScheduleService.getYearlyChangeInfo(year, true),
        ),
      ),
      Promise.all(
        years.map((year) =>
          this.dutyScheduleService.getYearlySealingInfo(year, true),
        ),
      ),
    ]);
    return {
      changes: changeResponses.flatMap((response) => response.changes || []),
      sealings: sealingResponses.flatMap((response) => response.sealings || []),
    };
  }

  private buildReport(
    businessDate: string,
    endDate: string,
    now: Date,
    checks: DailyOperationsPatrolCheckResult[],
    evaluatedFacilityPoints: number,
  ): DailyOperationsPatrolReport {
    const totalIssues = checks.reduce((sum, check) => sum + check.count, 0);
    return {
      businessDate,
      startDate: businessDate,
      endDate,
      generatedAt: now.toISOString(),
      evaluatedFacilityPoints,
      checks,
      totalIssues,
      hasAlerts: totalIssues > 0,
    };
  }

  private cardUrls(): { dashboardUrl?: string; scheduleUrl?: string } {
    const baseUrl = readPublicApplicationUrl([
      'NANTONG_DAILY_PATROL_PUBLIC_BASE_URL',
    ]).replace(/\/+$/u, '');
    if (!baseUrl) return {};
    return {
      dashboardUrl: `${baseUrl}/today-operations-panorama`,
      scheduleUrl: `${baseUrl}/monthly-schedule`,
    };
  }
}

function countFacilityPoints(response: TodayOperationsKpiResponse): number {
  const metrics = response.details?.buildingMetrics;
  if (!metrics) return 0;
  return [metrics.electricityKwh, metrics.averagePue, metrics.waterTons].reduce(
    (sum, metric) => sum + (metric.history?.[0]?.rows.length || 0),
    0,
  );
}

function monthsBetween(
  startDate: string,
  endDate: string,
): Array<{ year: number; month: number }> {
  const [startYear, startMonth] = startDate.split('-').map(Number);
  const [endYear, endMonth] = endDate.split('-').map(Number);
  const months: Array<{ year: number; month: number }> = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push({ year, month });
    month += 1;
    if (month > 12) {
      year += 1;
      month = 1;
    }
  }
  return months;
}

function yearsBetween(startDate: string, endDate: string): number[] {
  const startYear = Number(startDate.slice(0, 4));
  const endYear = Number(endDate.slice(0, 4));
  return Array.from(
    { length: endYear - startYear + 1 },
    (_, index) => startYear + index,
  );
}

function assertBusinessDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`业务日期格式无效：${value}`);
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || '未知错误'))
    .replace(/[\r\n\t]+/gu, ' ')
    .trim()
    .slice(0, 1_000);
}
