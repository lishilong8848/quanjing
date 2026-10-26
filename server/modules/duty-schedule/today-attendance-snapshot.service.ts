import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  TodayAttendanceCorrectionEvidenceManifest,
  TodayAttendanceCorrectionEvidenceQuery,
  TodayAttendanceEntry,
  TodayAttendanceDisplayScope,
  TodayAttendanceRunStatus,
  TodayAttendanceSnapshot,
  TodayAttendanceSourceStatus,
  TodayAttendanceTask,
} from '@shared/today-attendance.interface';
import {
  AttendanceAutomationCoordinatorService,
  type AttendanceAutomationRunStatus,
} from './attendance-automation-coordinator.service';
import {
  AttendanceAutomationFeishuGateway,
  type ArchivedAttendanceSummary,
} from './attendance-automation-feishu.gateway';
import {
  AttendanceDailySummaryStore,
  type AttendanceDailySummary,
} from './attendance-daily-summary.store';
import {
  getShanghaiDateKey,
  getTodayAttendanceFinalTasks,
} from './today-attendance.tasks';
import { excludesApprovedLeave } from './attendance-approved-leave';

const CACHE_TTL_MS = 15_000;

interface SnapshotCache {
  date: string;
  phase: string;
  cachedAt: number;
  snapshot: TodayAttendanceSnapshot;
}

@Injectable()
export class TodayAttendanceSnapshotService {
  private readonly logger = new Logger(TodayAttendanceSnapshotService.name);
  private cache: SnapshotCache | null = null;
  private inFlight: Promise<TodayAttendanceSnapshot> | null = null;
  private inFlightDate = '';
  private inFlightPhase = '';
  private requestGeneration = 0;
  private cacheGeneration = 0;

  constructor(
    private readonly attendanceArchive: AttendanceAutomationFeishuGateway,
    @Optional()
    private readonly dailySummaryStore?: AttendanceDailySummaryStore,
    @Optional()
    private readonly automationCoordinator?: AttendanceAutomationCoordinatorService,
  ) {}

  getCorrectionEvidence(
    query: TodayAttendanceCorrectionEvidenceQuery,
  ): Promise<TodayAttendanceCorrectionEvidenceManifest> {
    return this.attendanceArchive.readCorrectionEvidence(query);
  }

  downloadCorrectionEvidence(
    query: TodayAttendanceCorrectionEvidenceQuery,
    index: number,
  ): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
    return this.attendanceArchive.downloadCorrectionEvidence(query, index);
  }

  async getSnapshot(
    now = new Date(),
    forceRefresh = false,
  ): Promise<TodayAttendanceSnapshot> {
    const currentDate = getShanghaiDateKey(now);
    const displayScope: TodayAttendanceDisplayScope =
      getTodayAttendanceFinalTasks(now).length === 0 ? 'previous-day' : 'today';
    const date =
      displayScope === 'previous-day'
        ? shiftDateKey(currentDate, -1)
        : currentDate;
    const taskReferenceTime =
      displayScope === 'previous-day' ? shanghaiEndOfDay(date) : now;
    const phase = `${displayScope}:${getTodayAttendanceFinalTasks(taskReferenceTime).join(',')}`;
    const cacheIsFresh =
      this.cache?.date === date &&
      this.cache.phase === phase &&
      now.getTime() - this.cache.cachedAt < CACHE_TTL_MS;

    if (!forceRefresh && cacheIsFresh) return this.cache!.snapshot;
    const requestGeneration = forceRefresh
      ? ++this.requestGeneration
      : this.requestGeneration;
    if (
      !forceRefresh &&
      this.inFlight &&
      this.inFlightDate === date &&
      this.inFlightPhase === phase
    )
      return this.inFlight;

    const request = this.buildSnapshot(date, taskReferenceTime, displayScope)
      .then((snapshot) => {
        if (requestGeneration >= this.cacheGeneration) {
          this.cacheGeneration = requestGeneration;
          this.cache = { date, phase, cachedAt: now.getTime(), snapshot };
        }
        return snapshot;
      })
      .catch((error) => {
        const message = safeErrorMessage(error);
        if (this.cache?.date === date) {
          this.logger.warn(`今日考勤归档刷新失败，返回最近快照：${message}`);
          if (this.cache.phase !== phase) {
            return unavailableSnapshot(
              date,
              displayScope === 'previous-day' ? 'stale' : 'not-run',
              undefined,
              displayScope,
            );
          }
          return {
            ...this.cache.snapshot,
            sourceStatus:
              this.cache.snapshot.sourceStatus === 'fresh'
                ? ('stale' as const)
                : this.cache.snapshot.sourceStatus,
          };
        }
        if (message.startsWith('请休假审批状态核验失败：')) {
          this.logger.warn(message);
          return unavailableSnapshot(date, 'stale', undefined, displayScope);
        }
        this.logger.error(`今日考勤归档读取失败：${message}`);
        throw new ServiceUnavailableException(
          message.includes('今日考勤归档暂无可核验记录')
            ? message
            : '今日考勤数据暂不可用，请稍后重试',
        );
      })
      .finally(() => {
        if (this.inFlight === request) {
          this.inFlight = null;
          this.inFlightDate = '';
          this.inFlightPhase = '';
        }
      });
    this.inFlight = request;
    this.inFlightDate = date;
    this.inFlightPhase = phase;
    return request;
  }

  private async buildSnapshot(
    date: string,
    now: Date,
    displayScope: TodayAttendanceDisplayScope,
  ): Promise<TodayAttendanceSnapshot> {
    const checkedTasks = getTodayAttendanceFinalTasks(now);
    if (checkedTasks.length === 0) {
      return pendingSnapshot(date, displayScope);
    }
    const latestTask = checkedTasks[checkedTasks.length - 1];
    const persistedRun =
      displayScope === 'today'
        ? this.automationCoordinator?.getRunStatus(latestTask, date)
        : undefined;
    const archivedCorrectionRun =
      displayScope === 'previous-day'
        ? this.automationCoordinator?.getRunStatus('archive-yesterday', date)
        : undefined;
    const runStatus =
      displayScope === 'today' && this.automationCoordinator
        ? buildRunStatus(date, latestTask, persistedRun)
        : archivedCorrectionRun?.correctionSyncFailureReason
          ? buildRunStatus(date, 'archive-yesterday', archivedCorrectionRun)
          : undefined;
    const incompleteSourceStatus =
      displayScope === 'today' && this.automationCoordinator
        ? persistedRun?.state === 'running'
          ? 'running'
          : persistedRun?.state === 'failed'
            ? 'failed'
            : persistedRun?.state === 'completed'
              ? null
              : 'not-run'
        : null;
    if (this.dailySummaryStore) {
      try {
        const localSummary = await this.dailySummaryStore.read(date);
        if (localSummary) {
          const snapshot = snapshotFromDailySummary(
            localSummary,
            now,
            displayScope,
          );
          if (snapshot) {
            return this.excludeNewlyApprovedLeave({
              ...snapshot,
              sourceStatus: incompleteSourceStatus || 'fresh',
              ...(runStatus ? { runStatus } : {}),
            });
          }
        }
      } catch (error) {
        this.logger.warn(
          `今日考勤本地汇总读取失败，回退飞书归档：${safeErrorMessage(error)}`,
        );
      }
    }
    if (incompleteSourceStatus) {
      return unavailableSnapshot(
        date,
        incompleteSourceStatus,
        runStatus,
        displayScope,
      );
    }
    let archived: ArchivedAttendanceSummary;
    try {
      archived =
        await this.attendanceArchive.readArchivedAttendanceSummary(date);
    } catch (error) {
      if (displayScope !== 'previous-day') throw error;
      this.logger.warn(
        `昨日考勤归档读取失败，返回明确的昨日不可用状态：${safeErrorMessage(error)}`,
      );
      return unavailableSnapshot(date, 'stale', undefined, displayScope);
    }
    const finalTaskSet = new Set<TodayAttendanceTask>(checkedTasks);
    const archivedFinalTasks = (archived.checkedTasks || []).filter((task) =>
      finalTaskSet.has(task),
    );
    if (
      (archived.checkedTasks || []).length > 0 &&
      archivedFinalTasks.length === 0 &&
      !(displayScope === 'previous-day' && archived.hasArchivedResult)
    ) {
      return displayScope === 'previous-day' || this.automationCoordinator
        ? unavailableSnapshot(date, 'stale', runStatus, displayScope)
        : unavailableSnapshot(date, 'not-run', undefined, displayScope);
    }
    const normal = Object.values(archived.normalByBuilding).reduce(
      (sum, count) => sum + count,
      0,
    );
    const anomaly = archived.anomalies.length;
    if (normal + anomaly === 0) {
      return displayScope === 'previous-day' || this.automationCoordinator
        ? unavailableSnapshot(date, 'stale', runStatus, displayScope)
        : unavailableSnapshot(date, 'not-run', undefined, displayScope);
    }
    const entries: TodayAttendanceEntry[] = archived.anomalies
      .map((item) => ({
        key: item.key,
        name: item.name,
        building: item.building,
        shiftLabel: item.shiftLabel,
        direction: item.direction,
        expectedAt: item.expectedAt,
        status: 'anomaly' as const,
        reason: item.reason,
      }))
      .sort(compareEntries);
    return this.excludeNewlyApprovedLeave({
      date,
      displayScope,
      fetchedAt: archived.fetchedAt,
      sourceStatus: 'fresh',
      ...(runStatus ? { runStatus } : {}),
      checkedTasks,
      summary: {
        expected: normal + anomaly,
        normal,
        anomaly,
        excluded: 0,
      },
      entries,
    });
  }

  private async excludeNewlyApprovedLeave(
    snapshot: TodayAttendanceSnapshot,
  ): Promise<TodayAttendanceSnapshot> {
    if (snapshot.entries.length === 0) return snapshot;
    let approvedLeave;
    try {
      approvedLeave = this.attendanceArchive.readApprovedAttendanceLeaveForDisplay
        ? await this.attendanceArchive.readApprovedAttendanceLeaveForDisplay()
        : await this.attendanceArchive.readApprovedAttendanceLeave?.();
    } catch (error) {
      throw new Error(`请休假审批状态核验失败：${safeErrorMessage(error)}`);
    }
    if (!approvedLeave) return snapshot;
    const entries = snapshot.entries.filter(
      (entry) => !excludesApprovedLeave(entry, approvedLeave),
    );
    const newlyExcluded = snapshot.entries.length - entries.length;
    if (!newlyExcluded) return snapshot;
    return {
      ...snapshot,
      summary: {
        ...snapshot.summary,
        expected: Math.max(0, snapshot.summary.expected - newlyExcluded),
        anomaly: entries.length,
        excluded: snapshot.summary.excluded + newlyExcluded,
      },
      entries,
    };
  }
}

function snapshotFromDailySummary(
  summary: AttendanceDailySummary,
  now: Date,
  displayScope: TodayAttendanceDisplayScope,
): TodayAttendanceSnapshot | null {
  const dueTasks = getTodayAttendanceFinalTasks(now);
  const selectedChecks = dueTasks.flatMap((task) => {
    const check = summary.checks?.[task];
    return check ? [{ task, check }] : [];
  });
  if (
    displayScope === 'previous-day' &&
    !summary.checks &&
    summary.expected > 0 &&
    summary.normal + summary.anomalies.length === summary.expected
  ) {
    const entries: TodayAttendanceEntry[] = summary.anomalies
      .map((item) => ({
        key: item.key,
        name: item.name,
        building: item.building,
        shiftLabel: item.shiftLabel,
        direction: item.direction,
        expectedAt: item.expectedAt,
        status: 'anomaly' as const,
        reason: item.reason,
      }))
      .sort(compareEntries);
    return {
      date: summary.businessDate,
      displayScope,
      fetchedAt: formatShanghaiMinute(summary.generatedAt),
      sourceStatus: 'fresh',
      checkedTasks: [],
      summary: {
        expected: summary.expected,
        normal: summary.normal,
        anomaly: summary.anomalies.length,
        excluded: summary.excluded,
      },
      entries,
    };
  }
  if (selectedChecks.length === 0) return null;

  const expectedKeys = new Set<string>();
  const normalKeys = new Set<string>();
  const excludedKeys = new Set<string>();
  const anomaliesByKey = new Map(
    selectedChecks.flatMap(({ check }) =>
      check.anomalies.map((item) => [item.key, item] as const),
    ),
  );
  selectedChecks.forEach(({ check }) => {
    check.expectedKeys.forEach((key) => expectedKeys.add(key));
    check.normalKeys.forEach((key) => normalKeys.add(key));
    check.excludedKeys.forEach((key) => excludedKeys.add(key));
  });
  anomaliesByKey.forEach((_item, key) => normalKeys.delete(key));
  excludedKeys.forEach((key) => {
    expectedKeys.delete(key);
    normalKeys.delete(key);
    anomaliesByKey.delete(key);
  });
  const entries: TodayAttendanceEntry[] = [...anomaliesByKey.values()]
    .map((item) => ({
      key: item.key,
      name: item.name,
      building: item.building,
      shiftLabel: item.shiftLabel,
      direction: item.direction,
      expectedAt: item.expectedAt,
      status: 'anomaly' as const,
      reason: item.reason,
    }))
    .sort(compareEntries);
  return {
    date: summary.businessDate,
    displayScope,
    fetchedAt: formatShanghaiMinute(
      selectedChecks.reduce(
        (latest, { check }) =>
          check.generatedAt > latest ? check.generatedAt : latest,
        '',
      ),
    ),
    sourceStatus: 'fresh',
    checkedTasks: selectedChecks.map(({ task }) => task),
    summary: {
      expected: expectedKeys.size,
      normal: normalKeys.size,
      anomaly: anomaliesByKey.size,
      excluded: excludedKeys.size,
    },
    entries,
  };
}

function pendingSnapshot(
  date: string,
  displayScope: TodayAttendanceDisplayScope,
): TodayAttendanceSnapshot {
  return {
    date,
    displayScope,
    fetchedAt: '',
    sourceStatus: 'pending',
    runStatus: {
      state: 'waiting',
      scheduledAt: `${date} 09:30`,
    },
    checkedTasks: [],
    summary: { expected: 0, normal: 0, anomaly: 0, excluded: 0 },
    entries: [],
  };
}

function unavailableSnapshot(
  date: string,
  sourceStatus: Exclude<TodayAttendanceSourceStatus, 'pending' | 'fresh'>,
  runStatus?: TodayAttendanceRunStatus,
  displayScope: TodayAttendanceDisplayScope = 'today',
): TodayAttendanceSnapshot {
  return {
    date,
    displayScope,
    fetchedAt: '',
    sourceStatus,
    ...(runStatus ? { runStatus } : {}),
    checkedTasks: [],
    summary: { expected: 0, normal: 0, anomaly: 0, excluded: 0 },
    entries: [],
  };
}

function buildRunStatus(
  date: string,
  task: TodayAttendanceTask | 'archive-yesterday',
  persisted: AttendanceAutomationRunStatus | null | undefined,
): TodayAttendanceRunStatus {
  const scheduledAt =
    formatShanghaiMinute(persisted?.scheduledAt || '') ||
    (task === 'archive-yesterday'
      ? `${shiftDateKey(date, 1)} 00:30`
      : `${date} ${task === 'evening-off-duty-check' ? '18:35' : '09:30'}`);
  if (!persisted) return { state: 'not-run', scheduledAt };
  const failureScope =
    persisted.failureScope ||
    (/个人异常接收人读取失败|个人考勤异常卡片发送失败/u.test(
      persisted.failureReason || '',
    )
      ? 'personal-delivery'
      : undefined);
  return {
    state: persisted.state,
    scheduledAt,
    ...(persisted.firstAttemptAt
      ? { firstAttemptAt: formatShanghaiMinute(persisted.firstAttemptAt) }
      : {}),
    ...(persisted.lastAttemptAt
      ? { lastAttemptAt: formatShanghaiMinute(persisted.lastAttemptAt) }
      : {}),
    ...(persisted.attemptCount ? { attemptCount: persisted.attemptCount } : {}),
    ...(persisted.maxAttempts ? { maxAttempts: persisted.maxAttempts } : {}),
    ...(persisted.completedAt
      ? { completedAt: formatShanghaiMinute(persisted.completedAt) }
      : {}),
    ...(persisted.failureReason
      ? { failureReason: persisted.failureReason }
      : {}),
    ...(persisted.archiveSyncFailureReason
      ? { archiveSyncFailureReason: persisted.archiveSyncFailureReason }
      : {}),
    ...(persisted.archiveSyncState
      ? { archiveSyncState: persisted.archiveSyncState }
      : {}),
    ...(persisted.correctionSyncFailureReason
      ? { correctionSyncFailureReason: persisted.correctionSyncFailureReason }
      : {}),
    ...(persisted.correctionSyncState
      ? { correctionSyncState: persisted.correctionSyncState }
      : {}),
    ...(failureScope ? { failureScope } : {}),
    ...(persisted.nextRetryAt
      ? { nextRetryAt: formatShanghaiMinute(persisted.nextRetryAt) }
      : {}),
    ...(persisted.retryCutoffAt
      ? { retryCutoffAt: formatShanghaiMinute(persisted.retryCutoffAt) }
      : {}),
    ...(typeof persisted.finalFailure === 'boolean'
      ? { finalFailure: persisted.finalFailure }
      : {}),
  };
}

function compareEntries(
  left: TodayAttendanceEntry,
  right: TodayAttendanceEntry,
): number {
  return (
    left.building.localeCompare(right.building, 'zh-CN') ||
    left.expectedAt.localeCompare(right.expectedAt) ||
    left.name.localeCompare(right.name, 'zh-CN')
  );
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatShanghaiMinute(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp + 8 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
}

function shiftDateKey(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

function shanghaiEndOfDay(date: string): Date {
  return new Date(`${date}T23:59:59.999+08:00`);
}
