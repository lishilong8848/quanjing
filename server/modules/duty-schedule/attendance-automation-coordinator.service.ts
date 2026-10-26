import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { readEnv } from '@server/common/config/external-services.config';
import { DutyScheduleService } from './duty-schedule.service';
import {
  buildPersonalAttendanceAnomalyCard,
  type AttendanceSummarySection,
} from './attendance-automation.card';
import {
  buildAttendanceExpectationPlan,
  buildDailyAttendanceExpectationPlan,
  buildFinalAttendanceExpectationPlan,
  matchDingTalkResultsToExpectations,
} from './attendance-automation.expectations';
import {
  classifyAttendanceExpectations,
  type AttendanceClassification,
  type AttendanceExpectation,
  type DingTalkAttendanceResult,
} from './attendance-automation.rules';
import {
  buildAttendanceAutomationIdempotencyKey,
  buildLiveAttendanceWindow,
  buildYesterdayAttendanceWindow,
  type AttendanceAutomationRun,
  type AttendanceAutomationTask,
} from './attendance-automation.scheduler';
import {
  AttendanceAutomationFeishuGateway,
  type ArchivedAttendanceRecheckTarget,
  type ArchivedAttendanceSummary,
  type AttendancePersonalRecipient,
  type AttendancePersonalRecipientResolution,
} from './attendance-automation-feishu.gateway';
import {
  DingTalkAttendanceClient,
  type DingTalkCorrectionApproval,
  type DingTalkAttendanceRawDetail,
  type DingTalkAttendanceRawResult,
  type DingTalkDirectoryUser,
} from './dingtalk-attendance.client';
import { resolveDutyDailyReportStateFilePath } from './duty-daily-report-state-path';
import { AttendanceDailySummaryStore } from './attendance-daily-summary.store';
import { DailyOperationsPatrolService } from './daily-operations-patrol.service';
import { buildAttendanceMorningBrief } from './attendance-morning-brief.card';
import { TrainingDashboardService } from '../bitable-sync/training-dashboard.service';
import { TodayOperationsAlarmService } from '../bitable-sync/today-operations-alarm.service';
import {
  excludesApprovedLeave,
  excludesInactiveSubstitute,
  hasValidApprovedLeavePeriod,
} from './attendance-approved-leave';
import type { ApprovedLeaveRequest } from '@server/common/feishu/leave-approval-source';
import type { BitableRecordItem } from '@server/common/feishu/bitable-direct-read';
import {
  buildApprovedOvertimeExpectations,
  mergeOvertimeExpectations,
} from './attendance-overtime';
import type {
  TodayAttendanceFailureScope,
  TodayAttendanceManualSyncResponse,
} from '@shared/today-attendance.interface';
import { getShanghaiDateKey } from './today-attendance.tasks';

export type AttendanceAutomationRunState = 'running' | 'failed' | 'completed';

export interface AttendanceAutomationRunStatus {
  state: AttendanceAutomationRunState;
  task: AttendanceAutomationTask;
  date: string;
  scheduledAt: string;
  firstAttemptAt?: string;
  lastAttemptAt: string;
  attemptCount?: number;
  maxAttempts?: number;
  completedAt?: string;
  failedAt?: string;
  failureReason?: string;
  failureScope?: TodayAttendanceFailureScope;
  archiveSyncState?: 'syncing' | 'failed';
  archiveSyncFailureReason?: string;
  correctionSyncState?: 'syncing' | 'failed';
  correctionSyncFailureReason?: string;
  nextRetryAt?: string;
  retryCutoffAt?: string;
  finalFailure?: boolean;
}

interface AttendanceAutomationTaskState {
  version: 1;
  completed: Record<string, { completedAt: string }>;
  runs: Record<string, AttendanceAutomationRunStatus>;
  manualRetries?: Record<string, AttendanceManualRetryLedgerEntry>;
}

interface AttendanceManualRetryLedgerEntry {
  taskKey: string;
  task: Extract<
    AttendanceAutomationTask,
    'morning-off-duty-check' | 'evening-off-duty-check'
  >;
  date: string;
  requestedAt: string;
}

interface AttendanceAutomationSnapshot {
  version: 4;
  task: AttendanceAutomationTask;
  date: string;
  mode: 'details' | 'archive';
  capturedAt: string;
  query: { start: string; end: string };
  correctionQuery?: { start: string; end: string };
  users: DingTalkDirectoryUser[];
  results: DingTalkAttendanceRawResult[];
  details: DingTalkAttendanceRawDetail[];
  corrections: DingTalkCorrectionApproval[];
}

interface AttendanceRepairSnapshot {
  version: 1;
  runDate: string;
  businessDate: string;
  capturedAt: string;
  query: { start: string; end: string };
  targetKeys: string[];
  users: DingTalkDirectoryUser[];
  results: DingTalkAttendanceRawResult[];
  corrections: DingTalkCorrectionApproval[];
}

interface AttendanceCorrectionJob {
  version: 1;
  task: AttendanceAutomationTask;
  date: string;
  scheduledAt: string;
  query: { start: string; end: string };
  stage: 'pending' | 'fetched' | 'completed';
  corrections?: DingTalkCorrectionApproval[];
  failureReason?: string;
  failureDetail?: string;
  alertedAt?: string;
  attemptCount?: number;
  nextRetryAt?: string;
  completedAt?: string;
}

interface AttendanceArchiveJob {
  version: 1;
  task: AttendanceAutomationTask;
  date: string;
  scheduledAt: string;
  stage: 'pending' | 'completed';
  input: {
    businessDate: string;
    users: DingTalkDirectoryUser[];
    results: DingTalkAttendanceRawResult[];
    details: DingTalkAttendanceRawDetail[];
  };
  failureReason?: string;
  failureDetail?: string;
  alertedAt?: string;
  attemptCount?: number;
  nextRetryAt?: string;
  completedAt?: string;
}

interface LiveAttendanceExecutionResult {
  success: true;
  task: Exclude<AttendanceAutomationTask, 'archive-yesterday'>;
  date: string;
  source: 'dingtalk-scheduled-snapshot';
  expected: number;
  anomalies: number;
  normal: number;
  deliveries: Array<{
    recipient: string;
    messageId: string;
    anomalies: number;
    normal: number;
    scope: 'personal';
  }>;
  personalDeliveryFailures: string[];
  classification: AttendanceClassification;
  fetchedAt: string;
  archiveFailure?: AttendanceAutomationFailure;
  correctionSyncFailure?: AttendanceAutomationFailure;
}

type AttendanceExecutionRun = AttendanceAutomationRun & {
  deferAttendanceArchive?: boolean;
};

interface MorningAttendanceSummarySectionData {
  title: AttendanceSummarySection['title'];
  date: string;
  anomalies: AttendanceClassification['anomalies'];
  normal: AttendanceExpectation[];
}

const DINGTALK_ATTENDANCE_APP_LINK =
  'https://applink.dingtalk.com/action/openapp?container_type=work_platform&app_id=158';

@Injectable()
export class AttendanceAutomationCoordinatorService {
  private readonly logger = new Logger(
    AttendanceAutomationCoordinatorService.name,
  );
  private readonly activeTasks = new Map<string, Promise<unknown>>();
  private correctionRecovery: Promise<void> | null = null;
  private archiveRecovery: Promise<void> | null = null;
  private syncFailureAlertRecovery: Promise<void> | null = null;

  constructor(
    private readonly dingTalkClient: DingTalkAttendanceClient,
    private readonly dutyScheduleService: DutyScheduleService,
    private readonly feishuGateway: AttendanceAutomationFeishuGateway,
    @Optional()
    private readonly dailySummaryStore: AttendanceDailySummaryStore = new AttendanceDailySummaryStore(),
    @Optional() private readonly patrolService?: DailyOperationsPatrolService,
    @Optional()
    private readonly trainingDashboardService?: TrainingDashboardService,
    @Optional()
    private readonly alarmService?: TodayOperationsAlarmService,
  ) {}

  run(run: AttendanceAutomationRun): Promise<unknown> {
    const taskKey = this.taskKey(run.task, run.date);
    const completed = this.readState().completed[taskKey];
    if (completed) {
      return Promise.resolve({
        success: true,
        skipped: true,
        task: run.task,
        date: run.date,
        completedAt: completed.completedAt,
      });
    }
    const active = this.activeTasks.get(taskKey);
    if (active) return active;
    const claimId = this.claimTask(taskKey);
    if (!claimId) {
      return Promise.resolve({
        success: true,
        skipped: true,
        inProgress: true,
        task: run.task,
        date: run.date,
      });
    }
    try {
      this.markRunning(taskKey, run);
    } catch (error) {
      this.releaseClaim(taskKey, claimId);
      return Promise.reject(error);
    }
    let execution!: Promise<unknown>;
    execution = this.execute(run)
      .then((result) => {
        this.markCompleted(taskKey, run, result);
        return result;
      })
      .catch((error) => {
        try {
          this.markFailed(taskKey, run, error);
        } catch (stateError) {
          this.logger.error(
            `考勤自动化失败状态落盘失败：task=${run.task}, date=${run.date}, error=${stateError instanceof Error ? stateError.message : String(stateError)}`,
          );
        }
        throw error;
      })
      .finally(() => {
        this.releaseClaim(taskKey, claimId);
        if (this.activeTasks.get(taskKey) === execution) {
          this.activeTasks.delete(taskKey);
        }
      });
    this.activeTasks.set(taskKey, execution);
    return execution;
  }

  requestManualRetry(
    run: AttendanceAutomationRun & {
      task: Extract<
        AttendanceAutomationTask,
        'morning-off-duty-check' | 'evening-off-duty-check'
      >;
    },
    clientMutationId: string,
  ): TodayAttendanceManualSyncResponse {
    if (!isValidAttendanceManualMutationId(clientMutationId)) {
      throw new Error('手动同步请求标识无效');
    }
    const taskKey = this.taskKey(run.task, run.date);
    const initialState = this.readState();
    if (initialState.manualRetries?.[clientMutationId]) {
      return this.manualRetryResponse(run, clientMutationId, true, false);
    }
    if (this.activeTasks.has(taskKey)) {
      return this.manualRetryResponse(
        run,
        clientMutationId,
        false,
        false,
        true,
      );
    }

    const claimId = this.claimTask(taskKey);
    if (!claimId) {
      return this.manualRetryResponse(
        run,
        clientMutationId,
        false,
        false,
        true,
      );
    }

    try {
      const state = this.readState();
      if (state.manualRetries?.[clientMutationId]) {
        this.releaseClaim(taskKey, claimId);
        return this.manualRetryResponse(run, clientMutationId, true, false);
      }
      state.manualRetries = {
        ...(state.manualRetries || {}),
        [clientMutationId]: {
          taskKey,
          task: run.task,
          date: run.date,
          requestedAt: new Date().toISOString(),
        },
      };
      state.manualRetries = pruneAttendanceManualRetries(state.manualRetries);
      const attemptedAt = new Date().toISOString();
      const policy = attendanceRetryPolicy(run.task);
      delete state.completed[taskKey];
      state.runs[taskKey] = {
        state: 'running',
        task: run.task,
        date: run.date,
        scheduledAt: run.scheduledAt.toISOString(),
        firstAttemptAt: attemptedAt,
        lastAttemptAt: attemptedAt,
        attemptCount: 1,
        maxAttempts: 1,
        retryCutoffAt: new Date(
          Date.parse(attemptedAt) + policy.windowMs,
        ).toISOString(),
      };
      this.writeState(state);
    } catch (error) {
      this.releaseClaim(taskKey, claimId);
      throw error;
    }

    let execution!: Promise<unknown>;
    execution = this.execute({ ...run, deferAttendanceArchive: true })
      .then((result) => {
        this.markCompleted(taskKey, run, result);
        void this.recoverPendingAttendanceArchives().catch((error) => {
          this.logger.error(
            `手动考勤飞书归档后台启动失败：task=${run.task}, date=${run.date}, error=${safeAttendanceErrorMessage(error)}`,
          );
        });
        void this.recoverPendingCorrections().catch((error) => {
          this.logger.error(
            `手动考勤补卡后台启动失败：task=${run.task}, date=${run.date}, error=${safeAttendanceErrorMessage(error)}`,
          );
        });
        return result;
      })
      .catch((error) => {
        try {
          this.markFailed(taskKey, run, error);
        } catch (stateError) {
          this.logger.error(
            `手动考勤同步失败状态落盘失败：task=${run.task}, date=${run.date}, error=${safeAttendanceErrorMessage(stateError)}`,
          );
        }
        throw error;
      })
      .finally(() => {
        this.releaseClaim(taskKey, claimId);
        if (this.activeTasks.get(taskKey) === execution) {
          this.activeTasks.delete(taskKey);
        }
      });
    this.activeTasks.set(taskKey, execution);
    void execution.catch((error) => {
      this.logger.error(
        `手动考勤同步失败：task=${run.task}, date=${run.date}, error=${safeAttendanceErrorMessage(error)}`,
      );
    });
    return this.manualRetryResponse(run, clientMutationId, false, true, true);
  }

  getRunStatus(
    task: AttendanceAutomationTask,
    date: string,
  ): AttendanceAutomationRunStatus | null {
    const taskKey = this.taskKey(task, date);
    const state = this.readState();
    const status = state.runs[taskKey];
    if (status) {
      const result = { ...status };
      const archiveJob = this.readAttendanceArchiveJob(task, date);
      if (archiveJob?.stage === 'completed') {
        delete result.archiveSyncState;
        delete result.archiveSyncFailureReason;
      } else if (archiveJob) {
        const failed = Boolean(
          archiveJob.failureReason &&
          !isPendingExternalSyncReason(archiveJob.failureReason),
        );
        result.archiveSyncState = failed ? 'failed' : 'syncing';
        if (failed) {
          result.archiveSyncFailureReason = archiveJob.failureReason;
        } else {
          delete result.archiveSyncFailureReason;
        }
      }
      const correctionJob = this.readCorrectionJob(task, date);
      if (correctionJob?.stage === 'completed') {
        delete result.correctionSyncState;
        delete result.correctionSyncFailureReason;
      } else if (correctionJob) {
        const failed = Boolean(
          correctionJob.failureReason &&
          !isPendingExternalSyncReason(correctionJob.failureReason),
        );
        result.correctionSyncState = failed ? 'failed' : 'syncing';
        if (failed) {
          result.correctionSyncFailureReason = correctionJob.failureReason;
        } else {
          delete result.correctionSyncFailureReason;
        }
      }
      return result;
    }
    const completed = state.completed[taskKey];
    if (!completed) return null;
    return {
      state: 'completed',
      task,
      date,
      scheduledAt: '',
      lastAttemptAt: completed.completedAt,
      completedAt: completed.completedAt,
    };
  }

  private manualRetryResponse(
    run: AttendanceAutomationRun & {
      task: Extract<
        AttendanceAutomationTask,
        'morning-off-duty-check' | 'evening-off-duty-check'
      >;
    },
    clientMutationId: string,
    duplicate: boolean,
    accepted: boolean,
    forceInProgress = false,
  ): TodayAttendanceManualSyncResponse {
    const status = this.getRunStatus(run.task, run.date);
    const state = forceInProgress
      ? 'running'
      : status?.state === 'completed' || status?.state === 'failed'
        ? status.state
        : 'running';
    return {
      success: true,
      accepted,
      duplicate,
      inProgress: forceInProgress || state === 'running',
      clientMutationId,
      task: run.task,
      date: run.date,
      state,
    };
  }

  private async execute(run: AttendanceExecutionRun): Promise<unknown> {
    return this.executeAttendance(run);
  }

  private async executeAttendance(
    run: AttendanceExecutionRun,
  ): Promise<unknown> {
    const [approvedLeave, overtimeRecords] = await withAttendanceFailureReason(
      '飞书请休假或加班数据读取失败',
      () =>
        Promise.all([
          this.feishuGateway.readApprovedAttendanceLeave(),
          this.feishuGateway.readAttendanceOvertimeRecords(),
        ]),
    );
    if (run.task === 'morning-off-duty-check') {
      const invalidRecordIds = approvedLeave
        .filter((request) => !hasValidApprovedLeavePeriod(request))
        .map((request) => request.recordId)
        .filter(Boolean);
      if (invalidRecordIds.length > 0) {
        this.logger.warn(
          `09:30 考勤已忽略 ${invalidRecordIds.length} 条缺少有效起止时间的历史请休假记录，不作为请假豁免：recordIds=${invalidRecordIds.slice(0, 20).join(',')}${invalidRecordIds.length > 20 ? ',...' : ''}`,
        );
      }
    }
    if (run.task === 'archive-yesterday')
      return this.archive(run, approvedLeave, overtimeRecords);
    const live = await this.checkLiveAttendance(
      { ...run, task: run.task },
      approvedLeave,
      overtimeRecords,
    );
    const managementSummary =
      run.task === 'morning-off-duty-check' && !run.deferAttendanceArchive
        ? await this.sendMorningManagementSummary(
            { ...run, task: 'morning-off-duty-check' },
            live,
            approvedLeave,
            overtimeRecords,
          )
        : null;
    if (live.personalDeliveryFailures.length > 0) {
      throw new AttendanceAutomationFailure(
        '个人考勤异常卡片发送失败',
        `${live.personalDeliveryFailures.length} 位接收人待重试；${live.personalDeliveryFailures.join('；')}`,
        'personal-delivery',
      );
    }
    return managementSummary ? { ...live, managementSummary } : live;
  }

  private async archive(
    run: AttendanceAutomationRun,
    approvedLeave: readonly ApprovedLeaveRequest[],
    overtimeRecords: readonly BitableRecordItem[],
  ): Promise<unknown> {
    const archiveExecution = await this.archiveBusinessDate(
      run,
      run.date,
      approvedLeave,
      overtimeRecords,
    );
    const correctionDates = archiveExecution.corrections
      .map(correctionBusinessDate)
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/u.test(date) && date < run.date);
    const repairDates = [
      ...new Set([
        shiftDate(run.date, -1),
        shiftDate(run.date, -2),
        ...correctionDates,
      ]),
    ];
    const targets =
      await this.feishuGateway.readArchivedAttendanceRecheckTargets(
        repairDates,
      );
    const repaired: Array<{
      businessDate: string;
      targets: number;
      archived: number;
    }> = [];
    for (const businessDate of repairDates) {
      const overtimeByKey = new Map(
        buildApprovedOvertimeExpectations(overtimeRecords, businessDate).map(
          (event) => [event.key, event],
        ),
      );
      const dateTargets = targets
        .filter(
          (target) =>
            target.businessDate === businessDate &&
            !excludesApprovedLeave(target.expectation, approvedLeave) &&
            (target.expectation.status !== 'overtime' ||
              overtimeByKey.has(target.expectation.key)),
        )
        .map((target) => ({
          ...target,
          expectation:
            overtimeByKey.get(target.expectation.key) || target.expectation,
        }));
      if (dateTargets.length === 0) continue;
      const repair = await this.recheckArchivedAnomalies(
        run.date,
        businessDate,
        dateTargets,
        archiveExecution.corrections.filter(
          (correction) => correctionBusinessDate(correction) === businessDate,
        ),
      );
      repaired.push({
        businessDate,
        targets: repair.targets,
        archived: repair.archived,
      });
    }
    return { ...archiveExecution.result, repairedDates: repaired };
  }

  private async archiveBusinessDate(
    run: AttendanceAutomationRun,
    businessDate: string,
    approvedLeave: readonly ApprovedLeaveRequest[] = [],
    overtimeRecords: readonly BitableRecordItem[] = [],
  ): Promise<{
    result: Record<string, unknown>;
    corrections: DingTalkCorrectionApproval[];
  }> {
    const window = buildYesterdayAttendanceWindow(businessDate);
    const previousDate = shiftDate(businessDate, -1);
    const snapshotRun =
      businessDate === run.date ? run : { ...run, date: businessDate };
    const approvalSnapshot = { verified: true, requests: [...approvedLeave] };
    let correctionSyncFailure: AttendanceAutomationFailure | undefined;
    const [snapshot, schedules, longWhite] = await Promise.all([
      this.loadOrCaptureSnapshot(
        snapshotRun,
        { start: window.start, end: window.end },
        'archive',
      ).catch((error: unknown) => {
        const captured = this.readSnapshot(
          snapshotRun,
          { start: window.start, end: window.end },
          'archive',
          buildCorrectionDiscoveryWindow(snapshotRun.scheduledAt),
        );
        if (!captured) throw error;
        correctionSyncFailure =
          error instanceof AttendanceAutomationFailure
            ? error
            : new AttendanceAutomationFailure('钉钉补卡审批查询失败', error);
        return captured;
      }),
      this.dutyScheduleService.getDutySchedules(
        previousDate,
        businessDate,
        approvalSnapshot,
      ),
      this.dutyScheduleService.getLongWhiteDutyStaff(
        businessDate,
        true,
        approvalSnapshot,
      ),
    ]);
    const plan = buildDailyAttendanceExpectationPlan({
      date: businessDate,
      schedules,
      longWhiteBuildings: longWhite.buildings,
      preciseLeave: true,
    });
    plan.expectations = mergeOvertimeExpectations(
      plan.expectations,
      buildApprovedOvertimeExpectations(overtimeRecords, businessDate),
    ).filter(
      (item) =>
        !excludesApprovedLeave(item, approvedLeave) &&
        !excludesInactiveSubstitute(item, approvedLeave),
    );
    if (plan.expectations.length === 0) {
      throw new Error(
        `昨日考勤汇总没有应打卡事件：date=${window.businessDate}`,
      );
    }
    const results = tagAttendanceResults(
      deriveAttendanceResults(
        plan.expectations,
        snapshot.users,
        snapshot.details,
        snapshot.results,
        snapshot.corrections,
      ),
      'archive-yesterday',
    );
    const archived = await this.feishuGateway.archiveAttendance({
      businessDate,
      users: snapshot.users,
      results,
      details: snapshot.details,
      corrections: snapshot.corrections,
    });
    const matched = matchDingTalkResultsToExpectations(
      plan.expectations,
      snapshot.users,
      results,
      snapshot.details,
    );
    const classification = classifyAttendanceExpectations(
      plan.expectations,
      matched,
    );
    const archivedSummary =
      await this.feishuGateway.readArchivedAttendanceSummary(businessDate);
    await this.dailySummaryStore.write({
      version: 1,
      businessDate,
      generatedAt: new Date().toISOString(),
      source: 'dingtalk-archive',
      expected:
        archivedSummary.anomalies.length +
        Object.values(archivedSummary.normalByBuilding).reduce(
          (sum, count) => sum + count,
          0,
        ),
      normal: Object.values(archivedSummary.normalByBuilding).reduce(
        (sum, count) => sum + count,
        0,
      ),
      excluded: classification.excluded.length,
      anomalies: archivedSummary.anomalies,
    });
    if (correctionSyncFailure) {
      this.queueCorrectionJob(snapshotRun, correctionSyncFailure);
      this.logger.error(
        `昨日原始考勤已归档，补卡审批转入后台续跑：date=${businessDate}, error=${safeAttendanceErrorMessage(correctionSyncFailure)}`,
      );
    } else {
      this.completeCoveredCorrectionJobs(
        buildCorrectionDiscoveryWindow(snapshotRun.scheduledAt),
      );
    }
    this.logger.log(
      `钉钉考勤归档完成：date=${businessDate}, total=${archived.total}, created=${archived.created}, updated=${archived.updated}, expected=${plan.expectations.length}, anomalies=${archivedSummary.anomalies.length}`,
    );
    return {
      result: {
        success: true,
        task: 'archive-yesterday',
        date: businessDate,
        ...archived,
        expected: plan.expectations.length,
        anomalies: archivedSummary.anomalies.length,
        normal: Object.values(archivedSummary.normalByBuilding).reduce(
          (sum, count) => sum + count,
          0,
        ),
        ...(correctionSyncFailure ? { correctionSyncFailure } : {}),
      },
      corrections: snapshot.corrections,
    };
  }

  private async recheckArchivedAnomalies(
    runDate: string,
    businessDate: string,
    targets: readonly ArchivedAttendanceRecheckTarget[],
    discoveredCorrections: readonly DingTalkCorrectionApproval[] = [],
  ): Promise<{ targets: number; archived: number }> {
    const uniqueTargets = [
      ...new Map(
        targets.map((target) => [target.expectation.key, target]),
      ).values(),
    ].slice(0, 50);
    if (targets.length > uniqueTargets.length) {
      this.logger.warn(
        `考勤异常回查已限制为 50 个期望事件：date=${businessDate}, requested=${targets.length}`,
      );
    }
    if (uniqueTargets.length === 0) return { targets: 0, archived: 0 };

    const snapshot = await this.loadOrCaptureRepairSnapshot(
      runDate,
      businessDate,
      uniqueTargets,
    );
    const expectations = uniqueTargets.map((target) => target.expectation);
    const corrections = mergeCorrectionApprovals(
      snapshot.corrections,
      discoveredCorrections,
    );
    let results = tagAttendanceResults(
      deriveAttendanceResults(
        expectations,
        snapshot.users,
        [],
        snapshot.results,
        corrections,
      ),
      'archive-yesterday',
    );
    const archived = await this.feishuGateway.archiveAttendance({
      businessDate,
      users: snapshot.users,
      results,
      details: [],
      corrections,
    });
    const summary =
      await this.feishuGateway.readArchivedAttendanceSummary(businessDate);
    await this.dailySummaryStore.write({
      version: 1,
      businessDate,
      generatedAt: new Date().toISOString(),
      source: 'dingtalk-archive',
      expected: summary.anomalies.length + summary.normal.length,
      normal: summary.normal.length,
      excluded: 0,
      anomalies: summary.anomalies,
    });
    return { targets: uniqueTargets.length, archived: archived.total };
  }

  private async checkLiveAttendance(
    run: AttendanceAutomationRun & {
      task: Exclude<AttendanceAutomationTask, 'archive-yesterday'>;
      deferAttendanceArchive?: boolean;
    },
    approvedLeave: readonly ApprovedLeaveRequest[] = [],
    overtimeRecords: readonly BitableRecordItem[] = [],
  ): Promise<LiveAttendanceExecutionResult> {
    const { task, date } = run;
    const isFinalTask =
      task === 'morning-off-duty-check' || task === 'evening-off-duty-check';
    const previousDate = shiftDate(date, -1);
    const approvalSnapshot = { verified: true, requests: [...approvedLeave] };
    const [schedules, longWhite] = await withAttendanceFailureReason(
      '排班数据读取失败',
      () =>
        Promise.all([
          this.dutyScheduleService.getDutySchedules(
            previousDate,
            date,
            approvalSnapshot,
          ),
          this.dutyScheduleService.getLongWhiteDutyStaff(
            date,
            true,
            approvalSnapshot,
          ),
        ]),
    );
    const plan = isFinalTask
      ? buildFinalAttendanceExpectationPlan({
          task,
          date,
          schedules,
          longWhiteBuildings: longWhite.buildings,
          preciseLeave: true,
        })
      : buildAttendanceExpectationPlan({
          task,
          date,
          schedules,
          longWhiteBuildings: longWhite.buildings,
          preciseLeave: true,
        });
    const isExcluded = (item: AttendanceExpectation) =>
      excludesApprovedLeave(item, approvedLeave) ||
      excludesInactiveSubstitute(item, approvedLeave);
    const combined = mergeOvertimeExpectations(
      plan.expectations,
      buildApprovedOvertimeExpectations(
        overtimeRecords,
        date,
        `${taskTime(task)}:59`,
      ),
    );
    const approvedExclusions = combined.filter(isExcluded);
    plan.expectations = combined.filter((item) => !isExcluded(item));
    if (plan.expectations.length === 0) {
      if (isFinalTask) {
        await withAttendanceFailureReason('考勤本地汇总保存失败', () =>
          this.dailySummaryStore.mergeLiveCheck({
            task,
            businessDate: date,
            generatedAt: new Date().toISOString(),
            normal: [],
            excluded: approvedExclusions,
            anomalies: [],
            isExcluded,
          }),
        );
      }
      this.logger.log(
        `考勤核验无应打卡人员，跳过发送：task=${task}, date=${date}`,
      );
      return {
        success: true,
        task,
        date,
        source: 'dingtalk-scheduled-snapshot',
        expected: 0,
        anomalies: 0,
        normal: 0,
        deliveries: [],
        personalDeliveryFailures: [],
        classification: {
          anomalies: [],
          excluded: approvedExclusions,
          normal: [],
        },
        fetchedAt: formatShanghaiMinute(new Date()),
      };
    }

    const query = buildLiveAttendanceWindow(task, date);
    const snapshot = await withAttendanceFailureReason(
      '钉钉考勤数据拉取失败',
      () => this.loadOrCaptureSnapshot(run, query),
    );
    let results = tagAttendanceResults(
      deriveAttendanceResults(
        plan.expectations,
        snapshot.users,
        snapshot.details,
      ),
      task,
    );
    let matched = matchDingTalkResultsToExpectations(
      plan.expectations,
      snapshot.users,
      results,
      snapshot.details,
    );
    let all = classifyAttendanceExpectations(plan.expectations, matched);
    all.excluded.push(...approvedExclusions);
    let archiveFailure: AttendanceAutomationFailure | undefined;
    const attendanceArchiveInput: AttendanceArchiveJob['input'] = {
      businessDate: date,
      users: snapshot.users,
      results,
      details: snapshot.details,
    };
    if (run.deferAttendanceArchive) {
      archiveFailure = new AttendanceAutomationFailure(
        '飞书考勤多维表正在后台同步',
        '手动刷新已受理',
      );
      this.queueAttendanceArchiveJob(
        run,
        attendanceArchiveInput,
        archiveFailure,
        true,
      );
    } else {
      try {
        await withAttendanceFailureReason('飞书考勤多维表同步失败', () =>
          this.feishuGateway.archiveAttendance({
            ...attendanceArchiveInput,
            corrections: [],
          }),
        );
        this.completeAttendanceArchiveJob(task, date);
      } catch (error) {
        if (!isFinalTask) throw error;
        archiveFailure =
          error instanceof AttendanceAutomationFailure
            ? error
            : new AttendanceAutomationFailure('飞书考勤多维表同步失败', error);
        this.queueAttendanceArchiveJob(
          run,
          attendanceArchiveInput,
          archiveFailure,
        );
        this.logger.error(
          `飞书考勤多维表同步失败，考勤结果已保存并转入后台续跑：task=${task}, date=${date}, error=${safeAttendanceErrorMessage(archiveFailure)}`,
        );
      }
    }
    let correctionSyncFailure: AttendanceAutomationFailure | undefined;
    let discoveredCorrections: DingTalkCorrectionApproval[] | undefined;
    const existingCorrectionJob = this.readCorrectionJob(task, date);
    if (existingCorrectionJob && existingCorrectionJob.stage !== 'completed') {
      correctionSyncFailure = new AttendanceAutomationFailure(
        existingCorrectionJob.failureReason || '补卡记录及举证待同步',
        '后台待办将继续处理',
      );
    } else if (!existingCorrectionJob) {
      try {
        const corrections = await withAttendanceFailureReason(
          '钉钉补卡审批查询失败',
          () =>
            this.dingTalkClient.listCorrectionApprovals(
              buildCorrectionDiscoveryWindow(run.scheduledAt),
            ),
        );
        discoveredCorrections = corrections;
        if (corrections.length > 0) {
          results = tagAttendanceResults(
            deriveAttendanceResults(
              plan.expectations,
              snapshot.users,
              snapshot.details,
              snapshot.results,
              corrections,
            ),
            task,
          );
          matched = matchDingTalkResultsToExpectations(
            plan.expectations,
            snapshot.users,
            results,
            snapshot.details,
          );
          all = classifyAttendanceExpectations(plan.expectations, matched);
          all.excluded.push(...approvedExclusions);
          if (run.deferAttendanceArchive) {
            correctionSyncFailure = new AttendanceAutomationFailure(
              '补卡记录及举证仍在后台同步',
              '手动刷新已受理',
            );
            this.queueCorrectionJob(
              run,
              correctionSyncFailure,
              corrections,
              true,
            );
          } else {
            await withAttendanceFailureReason('补卡记录及举证同步失败', () =>
              this.feishuGateway.archiveAttendance({
                businessDate: date,
                users: snapshot.users,
                results,
                details: snapshot.details,
                corrections,
              }),
            );
            this.completeAttendanceArchiveJob(task, date);
          }
        }
        if (!correctionSyncFailure) {
          this.completeCoveredCorrectionJobs(
            buildCorrectionDiscoveryWindow(run.scheduledAt),
          );
        }
      } catch (error) {
        correctionSyncFailure =
          error instanceof AttendanceAutomationFailure
            ? error
            : new AttendanceAutomationFailure('补卡记录及举证同步失败', error);
        this.logger.error(
          `补卡记录及举证同步失败，考勤结果与09:30群卡继续保留：task=${task}, date=${date}, error=${safeAttendanceErrorMessage(correctionSyncFailure)}`,
        );
        this.queueCorrectionJob(
          run,
          correctionSyncFailure,
          discoveredCorrections,
        );
      }
    }
    if (isFinalTask) {
      await withAttendanceFailureReason('考勤本地汇总保存失败', () =>
        this.dailySummaryStore.mergeLiveCheck({
          task,
          businessDate: date,
          generatedAt: new Date(snapshot.capturedAt).toISOString(),
          normal: all.normal,
          excluded: all.excluded,
          anomalies: all.anomalies,
          isExcluded,
        }),
      );
    }
    const personalDeliveryFailures: string[] = [];
    let personalRecipients: AttendancePersonalRecipient[] = [];
    if (
      isFinalTask &&
      !run.deferAttendanceArchive &&
      all.anomalies.length > 0
    ) {
      try {
        const bestEffortResolver = (
          this.feishuGateway as unknown as {
            resolvePersonalRecipientsBestEffort?: (
              anomalies: readonly { name: string; building: string }[],
            ) => Promise<{
              recipients: AttendancePersonalRecipient[];
              failures: string[];
            }>;
          }
        ).resolvePersonalRecipientsBestEffort;
        if (bestEffortResolver) {
          const resolution =
            await withAttendanceFailureReason<AttendancePersonalRecipientResolution>(
              '个人异常接收人读取失败',
              () => bestEffortResolver.call(this.feishuGateway, all.anomalies),
            );
          personalRecipients = resolution.recipients;
          personalDeliveryFailures.push(...resolution.failures);
        } else {
          personalRecipients = await withAttendanceFailureReason(
            '个人异常接收人读取失败',
            () => this.feishuGateway.resolvePersonalRecipients(all.anomalies),
          );
        }
      } catch (error) {
        personalDeliveryFailures.push(safeAttendanceErrorMessage(error));
        this.logger.error(
          `个人异常接收人读取失败，核心考勤结果继续保留：task=${task}, date=${date}, error=${safeAttendanceErrorMessage(error)}`,
        );
      }
    }
    const deliveries: Array<{
      recipient: string;
      messageId: string;
      anomalies: number;
      normal: number;
      scope: 'personal';
    }> = [];
    const fetchedAt = formatShanghaiMinute(new Date(snapshot.capturedAt));
    const scheduleUrl = buildAttendancePageUrl('/monthly-schedule');
    const leaveRequestUrl = buildAttendancePageUrl(
      '/monthly-schedule/apply/leave',
    );
    const dingTalkCorrectionUrl = buildDingTalkCorrectionUrl();

    for (const recipient of personalRecipients) {
      const personalAnomalies = all.anomalies.filter(
        (anomaly) =>
          normalizeName(anomaly.name) === normalizeName(recipient.name),
      );
      if (personalAnomalies.length === 0) continue;
      const idempotencyKey = buildAttendanceAutomationIdempotencyKey(
        task,
        date,
        `personal:${recipient.openId}:${PERSONAL_ATTENDANCE_DELIVERY_VERSION}`,
      );
      const deliveryKey = `${date}:${task}:personal:${idempotencyKey}:${PERSONAL_ATTENDANCE_DELIVERY_VERSION}`;
      if (this.readState().completed[deliveryKey]) {
        this.logger.log(
          `个人考勤异常卡片已完成，跳过重复发送：recipient=${recipient.name}, task=${task}, date=${date}`,
        );
        continue;
      }
      const card = buildPersonalAttendanceAnomalyCard({
        date,
        fetchedAt,
        label: `${taskTime(task)} 个人`,
        recipientName: recipient.name,
        anomalies: personalAnomalies,
        dingTalkCorrectionUrl,
        leaveRequestUrl,
        scheduleUrl,
      });
      let messageId = '';
      try {
        messageId = await this.feishuGateway.sendCard(
          recipient.openId,
          card,
          idempotencyKey,
        );
      } catch (error) {
        personalDeliveryFailures.push(
          `${recipient.name}: ${safeAttendanceErrorMessage(error)}`,
        );
        this.logger.error(
          `个人考勤异常卡片发送失败，核心考勤结果继续保留：recipient=${recipient.name}, error=${safeAttendanceErrorMessage(error)}`,
        );
        continue;
      }
      this.markCompleted(deliveryKey);
      deliveries.push({
        recipient: recipient.name,
        messageId,
        anomalies: personalAnomalies.length,
        normal: 0,
        scope: 'personal',
      });
    }
    this.logger.log(
      `考勤实时核验完成：task=${task}, date=${date}, expected=${plan.expectations.length}, anomalies=${all.anomalies.length}, normal=${all.normal.length}, deliveries=${deliveries.length}`,
    );
    return {
      success: true,
      task,
      date,
      source: 'dingtalk-scheduled-snapshot',
      expected: plan.expectations.length,
      anomalies: all.anomalies.length,
      normal: all.normal.length,
      deliveries,
      personalDeliveryFailures,
      classification: all,
      fetchedAt,
      ...(archiveFailure ? { archiveFailure } : {}),
      ...(correctionSyncFailure ? { correctionSyncFailure } : {}),
    };
  }

  private async sendMorningManagementSummary(
    run: AttendanceAutomationRun & { task: 'morning-off-duty-check' },
    live: LiveAttendanceExecutionResult,
    approvedLeave: readonly ApprovedLeaveRequest[] = [],
    overtimeRecords: readonly BitableRecordItem[] = [],
  ): Promise<{ reportDate: string; archiveDate: string; sent: number }> {
    const archiveDate = shiftDate(run.date, -1);
    const summary = await withAttendanceFailureReason(
      '昨日考勤汇总读取失败',
      () => this.feishuGateway.readArchivedAttendanceSummary(archiveDate),
    );
    const currentOvertime = new Map(
      buildApprovedOvertimeExpectations(overtimeRecords, archiveDate).map(
        (event) => [event.key, event.expectedAt],
      ),
    );
    const isCurrent = (item: AttendanceExpectation) =>
      !excludesApprovedLeave(item, approvedLeave) &&
      (item.status !== 'overtime' ||
        currentOvertime.get(item.key) === item.expectedAt);
    // Re-evaluate approvals at send time instead of treating old missing-punch rows as current truth.
    const sections = buildMorningSummarySectionData(run.date, live, {
      ...summary,
      anomalies: summary.anomalies.filter(isCurrent),
      normal: (summary.normal || []).filter(isCurrent),
    });
    if (!this.patrolService) {
      throw new Error('南通每日运维巡视群发服务未配置');
    }
    const scheduleUrl = buildAttendancePageUrl('/monthly-schedule');
    const patrol = this.patrolService.isEnabled()
      ? await this.patrolService.collectReport(run.date).catch((error) => {
          this.logger.warn(
            `巡视数据采集失败，简报标为待核验：${error instanceof Error ? error.message : '未知错误'}`,
          );
          return null;
        })
      : null;
    const deliveryKey = `${run.date}:morning-brief:group:${MORNING_BRIEF_COMPLETION_VERSION}`;
    if (this.readState().completed[deliveryKey]) {
      return { reportDate: run.date, archiveDate, sent: 0 };
    }
    const cardSections = sections.map((section) => ({
      title: section.title,
      date: section.date,
      anomalies: section.anomalies,
      normalCount: section.normal.length,
    }));
    const followUp =
      typeof (
        this.patrolService as DailyOperationsPatrolService & {
          prepareMorningFollowUps?: DailyOperationsPatrolService['prepareMorningFollowUps'];
        }
      ).prepareMorningFollowUps === 'function'
        ? await withAttendanceFailureReason('异常跟进记录同步失败', () =>
            this.patrolService!.prepareMorningFollowUps({
              patrol,
              sections: cardSections,
              detectedAt: new Date().toISOString(),
            }),
          )
        : { recordIds: [], followUpUrl: '' };
    const trainingParticipation =
      Number(run.date.slice(8, 10)) >= 25
        ? await this.trainingDashboardService
            ?.getMonthlyPatrolParticipation(run.date.slice(0, 7))
            .catch((error) => {
              this.logger.warn(
                `月度培训数据读取失败，保留原巡视简报：${error instanceof Error ? error.message : '未知错误'}`,
              );
              return undefined;
            })
        : undefined;
    const alarmDashboard = await this.readMorningAlarmDashboard(archiveDate);
    const alarmDetailsUrl = new URL(buildAttendancePageUrl('/alarm-tag-anomalies'));
    alarmDetailsUrl.searchParams.set('date', archiveDate);
    const card = buildAttendanceMorningBrief({
      reportDate: run.date,
      fetchedAt:
        summary.fetchedAt > live.fetchedAt ? summary.fetchedAt : live.fetchedAt,
      sections: cardSections,
      scheduleUrl,
      dashboardUrl: buildAttendancePageUrl('/today-operations-panorama'),
      patrol,
      trainingParticipation,
      archiveRecordCount: summary.archiveRecordCount,
      followUpUrl: followUp.followUpUrl,
      alarmTagAnomalies: alarmDashboard?.sourceStatus === 'fresh' ? {
        date: archiveDate,
        count: alarmDashboard.summary.tagAnomalyTotal,
        detailsUrl: alarmDetailsUrl.toString(),
      } : undefined,
      alarmTagsUnavailable: !alarmDashboard || alarmDashboard.sourceStatus !== 'fresh',
    });
    await withAttendanceFailureReason('09:30 群卡片发送失败', () =>
      this.patrolService!.sendMorningBriefCard(
        card,
        run.date,
        MORNING_BRIEF_DELIVERY_IDENTITY,
      ),
    );
    this.markCompleted(deliveryKey);
    this.logger.log(
      `09:30 考勤与巡视简报群发完成：date=${run.date}, archiveDate=${archiveDate}, deliveries=1`,
    );
    return { reportDate: run.date, archiveDate, sent: 1 };
  }

  private async readMorningAlarmDashboard(date: string) {
    if (!this.alarmService) return null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.alarmService.getDashboard({ date, metric: 'tagAnomaly', pageSize: '1' }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('告警读取超时')), 8_000);
        }),
      ]);
    } catch (error) {
      this.logger.warn(`昨日告警打标读取失败，不阻断巡视简报：${error instanceof Error ? error.message : '未知错误'}`);
      return null;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async loadOrCaptureRepairSnapshot(
    runDate: string,
    businessDate: string,
    targets: readonly ArchivedAttendanceRecheckTarget[],
  ): Promise<AttendanceRepairSnapshot> {
    const targetKeys = targets
      .map((target) => target.expectation.key)
      .sort((left, right) => left.localeCompare(right));
    const query = {
      start: `${businessDate} 00:00:00`,
      end: `${businessDate} 23:59:59`,
    };
    const snapshotPath = this.repairSnapshotPath(
      runDate,
      businessDate,
      targetKeys,
    );
    if (existsSync(snapshotPath)) {
      try {
        const parsed = JSON.parse(
          readFileSync(snapshotPath, 'utf8'),
        ) as Partial<AttendanceRepairSnapshot>;
        if (
          parsed.version === 1 &&
          parsed.runDate === runDate &&
          parsed.businessDate === businessDate &&
          parsed.query?.start === query.start &&
          parsed.query?.end === query.end &&
          JSON.stringify(parsed.targetKeys) === JSON.stringify(targetKeys) &&
          Array.isArray(parsed.users) &&
          Array.isArray(parsed.results) &&
          Array.isArray(parsed.corrections)
        ) {
          return parsed as AttendanceRepairSnapshot;
        }
      } catch {
        // Invalid snapshots are replaced atomically below.
      }
    }

    const users = [
      ...new Map(
        targets.map((target) => [
          target.userId,
          { userId: target.userId, name: target.expectation.name },
        ]),
      ).values(),
    ];
    const results = await this.dingTalkClient.listAttendanceResults({
      ...query,
      userIds: users.map((user) => user.userId),
    });
    const corrections =
      await this.dingTalkClient.getCorrectionApprovalsByInstanceIds(
        results.map((record) => record.procInstId || '').filter(Boolean),
      );
    const snapshot: AttendanceRepairSnapshot = {
      version: 1,
      runDate,
      businessDate,
      capturedAt: new Date().toISOString(),
      query,
      targetKeys,
      users,
      results,
      corrections,
    };
    mkdirSync(dirname(snapshotPath), { recursive: true });
    const temporaryPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(
        temporaryPath,
        `${JSON.stringify(snapshot, null, 2)}\n`,
        'utf8',
      );
      renameSync(temporaryPath, snapshotPath);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
    return snapshot;
  }

  private taskKey(task: AttendanceAutomationTask, date: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`考勤自动化任务日期无效：${date}`);
    }
    const version =
      task === 'morning-off-duty-check'
        ? ':v6-group-card-resilience'
        : task === 'evening-off-duty-check'
          ? ':v5-scoped-reconciliation-recovery'
          : task === 'archive-yesterday'
            ? ':v4-late-punch-recovery'
            : '';
    return `${date}:${task}${version}`;
  }

  private async loadOrCaptureSnapshot(
    run: AttendanceAutomationRun,
    query: { start: string; end: string },
    mode: AttendanceAutomationSnapshot['mode'] = 'details',
  ): Promise<AttendanceAutomationSnapshot> {
    const correctionQuery =
      mode === 'archive'
        ? buildCorrectionDiscoveryWindow(run.scheduledAt)
        : undefined;
    let snapshot = this.readSnapshot(run, query, mode, correctionQuery);
    if (!snapshot) {
      const users = await this.dingTalkClient.listAllUsers();
      const attendanceQuery = {
        ...query,
        userIds: users.map((user) => user.userId),
      };
      const [results, details] = await Promise.all([
        mode === 'archive'
          ? this.dingTalkClient.listAttendanceResults(attendanceQuery)
          : Promise.resolve([]),
        run.task === 'evening-off-duty-check'
          ? this.dingTalkClient.listAttendanceDetails(attendanceQuery, {
              budgetPriority: 'evening-final',
            })
          : this.dingTalkClient.listAttendanceDetails(attendanceQuery),
      ]);
      snapshot = {
        version: 4,
        task: run.task,
        date: run.date,
        mode,
        capturedAt: new Date().toISOString(),
        query,
        ...(correctionQuery ? { correctionQuery } : {}),
        users,
        results,
        details,
        corrections: [],
      };
      this.writeSnapshot(run, snapshot);
    }
    if (mode !== 'archive' || !correctionQuery) return snapshot;
    const discovered =
      await this.dingTalkClient.listCorrectionApprovals(correctionQuery);
    const discoveredIds = new Set(
      discovered.map((item) => item.processInstanceId).filter(Boolean),
    );
    const directIds = snapshot.results
      .map((record) => record.procInstId || '')
      .filter((id) => id && !discoveredIds.has(id));
    const direct =
      await this.dingTalkClient.getCorrectionApprovalsByInstanceIds(directIds);
    return {
      ...snapshot,
      corrections: mergeCorrectionApprovals(discovered, direct),
    };
  }

  private readSnapshot(
    run: AttendanceAutomationRun,
    expectedQuery?: { start: string; end: string },
    expectedMode?: AttendanceAutomationSnapshot['mode'],
    expectedCorrectionQuery?: { start: string; end: string },
  ): AttendanceAutomationSnapshot | null {
    const snapshotPath = this.snapshotPath(run);
    if (!existsSync(snapshotPath)) return null;
    try {
      const parsed = JSON.parse(
        readFileSync(snapshotPath, 'utf8'),
      ) as Partial<AttendanceAutomationSnapshot>;
      if (
        parsed.version !== 4 ||
        parsed.task !== run.task ||
        parsed.date !== run.date ||
        !parsed.mode ||
        !parsed.query ||
        !Array.isArray(parsed.users) ||
        !Array.isArray(parsed.results) ||
        !Array.isArray(parsed.details) ||
        !Array.isArray(parsed.corrections) ||
        (expectedMode && parsed.mode !== expectedMode) ||
        (expectedCorrectionQuery &&
          (parsed.correctionQuery?.start !== expectedCorrectionQuery.start ||
            parsed.correctionQuery?.end !== expectedCorrectionQuery.end)) ||
        (expectedQuery &&
          (parsed.query.start !== expectedQuery.start ||
            parsed.query.end !== expectedQuery.end))
      ) {
        return null;
      }
      return parsed as AttendanceAutomationSnapshot;
    } catch {
      return null;
    }
  }

  private writeSnapshot(
    run: AttendanceAutomationRun,
    snapshot: AttendanceAutomationSnapshot,
  ): void {
    const snapshotPath = this.snapshotPath(run);
    mkdirSync(dirname(snapshotPath), { recursive: true });
    const tempPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      renameSync(tempPath, snapshotPath);
    } finally {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    }
  }

  private queueCorrectionJob(
    run: AttendanceAutomationRun,
    error: AttendanceAutomationFailure,
    corrections?: DingTalkCorrectionApproval[],
    retryImmediately = false,
  ): void {
    const existing = this.readCorrectionJob(run.task, run.date);
    const query = buildCorrectionDiscoveryWindow(run.scheduledAt);
    this.writeCorrectionJob({
      version: 1,
      task: run.task,
      date: run.date,
      scheduledAt: run.scheduledAt.toISOString(),
      query,
      stage: corrections ? 'fetched' : 'pending',
      ...(corrections ? { corrections } : {}),
      failureReason: retryImmediately
        ? undefined
        : publicAttendanceFailureReason(error),
      failureDetail: retryImmediately
        ? undefined
        : safeAttendanceErrorMessage(error),
      alertedAt:
        existing?.stage === 'completed' ? undefined : existing?.alertedAt,
      attemptCount: retryImmediately ? existing?.attemptCount || 0 : 1,
      nextRetryAt: retryImmediately
        ? new Date().toISOString()
        : correctionRetryAt(error, new Date()).toISOString(),
      ...(existing?.stage === 'fetched' && !corrections
        ? { stage: 'fetched' as const, corrections: existing.corrections }
        : {}),
    });
  }

  private queueAttendanceArchiveJob(
    run: AttendanceAutomationRun,
    input: AttendanceArchiveJob['input'],
    error: AttendanceAutomationFailure,
    retryImmediately = false,
  ): void {
    const existing = this.readAttendanceArchiveJob(run.task, run.date);
    this.writeAttendanceArchiveJob({
      version: 1,
      task: run.task,
      date: run.date,
      scheduledAt: run.scheduledAt.toISOString(),
      stage: 'pending',
      input: {
        businessDate: input.businessDate,
        users: [...input.users],
        results: [...input.results],
        details: [...input.details],
      },
      failureReason: retryImmediately
        ? undefined
        : publicAttendanceFailureReason(error),
      failureDetail: retryImmediately
        ? undefined
        : safeAttendanceErrorMessage(error),
      alertedAt:
        existing?.stage === 'completed' ? undefined : existing?.alertedAt,
      attemptCount: retryImmediately ? existing?.attemptCount || 0 : 1,
      nextRetryAt: retryImmediately
        ? new Date().toISOString()
        : attendanceArchiveRetryAt(new Date()).toISOString(),
    });
  }

  async notifyPendingSyncFailures(): Promise<void> {
    if (this.syncFailureAlertRecovery) return this.syncFailureAlertRecovery;
    const recovery = this.deliverPendingSyncFailureAlerts();
    this.syncFailureAlertRecovery = recovery;
    try {
      await recovery;
    } finally {
      if (this.syncFailureAlertRecovery === recovery) {
        this.syncFailureAlertRecovery = null;
      }
    }
  }

  private async deliverPendingSyncFailureAlerts(): Promise<void> {
    const pending = [
      ...this.readAttendanceArchiveJobs().map((job) => ({
        stage: 'archive' as const,
        job,
      })),
      ...this.readCorrectionJobs().map((job) => ({
        stage: 'correction' as const,
        job,
      })),
    ];
    for (const { stage, job } of pending) {
      if (job.stage === 'completed' || !job.failureDetail || job.alertedAt) {
        continue;
      }
      try {
        await this.feishuGateway.sendSyncFailureAlert({
          task: job.task,
          date: job.date,
          stage,
          detail: job.failureDetail,
        });
        if (stage === 'archive') {
          const current = this.readAttendanceArchiveJob(job.task, job.date);
          if (current && current.stage !== 'completed' && !current.alertedAt) {
            this.writeAttendanceArchiveJob({
              ...current,
              alertedAt: new Date().toISOString(),
            });
          }
        } else {
          const current = this.readCorrectionJob(job.task, job.date);
          if (current && current.stage !== 'completed' && !current.alertedAt) {
            this.writeCorrectionJob({
              ...current,
              alertedAt: new Date().toISOString(),
            });
          }
        }
      } catch (error) {
        this.logger.error(
          `考勤同步故障私信发送失败：task=${job.task}, date=${job.date}, stage=${stage}, error=${safeAttendanceErrorMessage(error)}`,
        );
      }
    }
  }

  async recoverPendingAttendanceArchives(now = new Date()): Promise<void> {
    if (this.archiveRecovery) return this.archiveRecovery;
    const recovery = this.recoverAttendanceArchiveJobs(now);
    this.archiveRecovery = recovery;
    try {
      await recovery;
    } finally {
      if (this.archiveRecovery === recovery) this.archiveRecovery = null;
    }
  }

  async reconcileApprovedLeaveAnomalies(now = new Date()): Promise<number> {
    const approvedLeave = await this.feishuGateway.readApprovedAttendanceLeave();
    if (approvedLeave.length === 0) return 0;
    const today = getShanghaiDateKey(now);
    const removed = await this.feishuGateway.reconcileApprovedLeaveMissingPunches(
      [today, shiftDate(today, -1)],
      approvedLeave,
    );
    if (removed > 0) {
      this.logger.log(`已审批请假缺卡误报归档收口：${removed} 条`);
    }
    return removed;
  }

  private async recoverAttendanceArchiveJobs(now: Date): Promise<void> {
    for (const queued of this.readAttendanceArchiveJobs()) {
      if (queued.stage === 'completed') continue;
      if (Date.parse(queued.nextRetryAt || '') > now.getTime()) continue;
      const claimKey = `attendance-archive:${queued.date}:${queued.task}`;
      const claimId = this.claimTask(claimKey);
      if (!claimId) continue;
      try {
        const job = this.readAttendanceArchiveJob(queued.task, queued.date);
        if (!job || job.stage === 'completed') continue;
        await withAttendanceFailureReason('飞书考勤多维表同步失败', () =>
          this.feishuGateway.archiveAttendance(job.input),
        );
        this.completeAttendanceArchiveJob(job.task, job.date);
        this.logger.log(
          `飞书考勤多维表后台同步完成：task=${job.task}, date=${job.date}`,
        );
      } catch (error) {
        const job = this.readAttendanceArchiveJob(queued.task, queued.date);
        if (job && job.stage !== 'completed') {
          this.writeAttendanceArchiveJob({
            ...job,
            failureReason: publicAttendanceFailureReason(error),
            failureDetail: safeAttendanceErrorMessage(error),
            attemptCount: (job.attemptCount || 0) + 1,
            nextRetryAt: attendanceArchiveRetryAt(now).toISOString(),
          });
        }
        this.logger.error(
          `飞书考勤多维表后台同步失败：task=${queued.task}, date=${queued.date}, error=${safeAttendanceErrorMessage(error)}`,
        );
      } finally {
        this.releaseClaim(claimKey, claimId);
      }
    }
  }

  private completeAttendanceArchiveJob(
    task: AttendanceAutomationTask,
    date: string,
  ): void {
    const job = this.readAttendanceArchiveJob(task, date);
    if (!job || job.stage === 'completed') return;
    this.writeAttendanceArchiveJob({
      ...job,
      stage: 'completed',
      completedAt: new Date().toISOString(),
      failureReason: undefined,
      nextRetryAt: undefined,
    });
  }

  private readAttendanceArchiveJobs(): AttendanceArchiveJob[] {
    const directory = join(
      dirname(this.statePath()),
      'attendance-archive-jobs',
    );
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) =>
        /^\d{4}-\d{2}-\d{2}-(archive-yesterday|morning-on-duty-reminder|morning-off-duty-check|evening-on-duty-reminder|evening-off-duty-check)\.json$/u.test(
          name,
        ),
      )
      .map((name) => {
        const parsed = JSON.parse(
          readFileSync(join(directory, name), 'utf8'),
        ) as AttendanceArchiveJob;
        if (
          parsed.version !== 1 ||
          typeof parsed.date !== 'string' ||
          typeof parsed.task !== 'string' ||
          !['pending', 'completed'].includes(parsed.stage) ||
          !parsed.input ||
          typeof parsed.input.businessDate !== 'string' ||
          !Array.isArray(parsed.input.users) ||
          !Array.isArray(parsed.input.results) ||
          !Array.isArray(parsed.input.details)
        ) {
          throw new Error(`考勤归档待办损坏：${name}`);
        }
        return parsed;
      });
  }

  private readAttendanceArchiveJob(
    task: AttendanceAutomationTask,
    date: string,
  ): AttendanceArchiveJob | null {
    const path = this.attendanceArchiveJobPath(task, date);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(
      readFileSync(path, 'utf8'),
    ) as AttendanceArchiveJob;
    if (
      parsed.version !== 1 ||
      parsed.task !== task ||
      parsed.date !== date ||
      !parsed.input
    ) {
      throw new Error(`考勤归档待办损坏：${date}:${task}`);
    }
    return parsed;
  }

  private writeAttendanceArchiveJob(job: AttendanceArchiveJob): void {
    const path = this.attendanceArchiveJobPath(job.task, job.date);
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
      renameSync(tempPath, path);
    } finally {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    }
  }

  private attendanceArchiveJobPath(
    task: AttendanceAutomationTask,
    date: string,
  ): string {
    return join(
      dirname(this.statePath()),
      'attendance-archive-jobs',
      `${date}-${task}.json`,
    );
  }

  async recoverPendingCorrections(now = new Date()): Promise<void> {
    if (this.correctionRecovery) return this.correctionRecovery;
    const recovery = this.recoverCorrectionJobs(now);
    this.correctionRecovery = recovery;
    try {
      await recovery;
    } finally {
      if (this.correctionRecovery === recovery) this.correctionRecovery = null;
    }
  }

  private async recoverCorrectionJobs(now: Date): Promise<void> {
    for (const queued of this.readCorrectionJobs()) {
      if (queued.stage === 'completed') continue;
      if (Date.parse(queued.nextRetryAt || '') > now.getTime()) continue;
      const claimKey = `correction:${queued.date}:${queued.task}`;
      const claimId = this.claimTask(claimKey);
      if (!claimId) continue;
      try {
        let job = this.readCorrectionJob(queued.task, queued.date);
        if (!job || job.stage === 'completed') continue;
        if (job.stage === 'pending') {
          const corrections = await withAttendanceFailureReason(
            '钉钉补卡审批查询失败',
            () => this.dingTalkClient.listCorrectionApprovals(job!.query),
          );
          job = { ...job, stage: 'fetched', corrections };
          this.writeCorrectionJob(job);
        }
        if (job.corrections?.length) {
          const run: AttendanceAutomationRun = {
            task: job.task,
            date: job.date,
            scheduledAt: new Date(job.scheduledAt),
          };
          const snapshot = this.readSnapshot(run);
          await withAttendanceFailureReason(
            '补卡记录及举证同步失败',
            async () => {
              if (!snapshot) {
                throw new Error('补卡待办缺少已保存的考勤人员快照');
              }
              await this.feishuGateway.archiveAttendance({
                businessDate: job!.date,
                users: snapshot.users,
                results: [],
                details: [],
                corrections: job!.corrections!,
              });
            },
          );
          await withAttendanceFailureReason('补卡后考勤复核失败', () =>
            this.recheckCorrectedAttendance(job!),
          );
        }
        this.completeCoveredCorrectionJobs(job.query);
      } catch (error) {
        const job = this.readCorrectionJob(queued.task, queued.date);
        if (job && job.stage !== 'completed') {
          this.writeCorrectionJob({
            ...job,
            failureReason: publicAttendanceFailureReason(error),
            failureDetail: safeAttendanceErrorMessage(error),
            attemptCount: (job.attemptCount || 0) + 1,
            nextRetryAt: correctionRetryAt(error, now).toISOString(),
          });
        }
        this.logger.error(
          `补卡审批后台续跑失败：task=${queued.task}, date=${queued.date}, error=${safeAttendanceErrorMessage(error)}`,
        );
      } finally {
        this.releaseClaim(claimKey, claimId);
      }
    }
  }

  private async recheckCorrectedAttendance(
    job: AttendanceCorrectionJob,
  ): Promise<void> {
    const corrections = job.corrections || [];
    const businessDates = [
      ...new Set(
        corrections
          .map(correctionBusinessDate)
          .filter(
            (date) => /^\d{4}-\d{2}-\d{2}$/u.test(date) && date <= job.date,
          ),
      ),
    ];
    if (businessDates.length === 0) return;
    const targets =
      await this.feishuGateway.readArchivedAttendanceRecheckTargets(
        businessDates,
      );
    for (const businessDate of businessDates) {
      const dateCorrections = corrections.filter(
        (correction) => correctionBusinessDate(correction) === businessDate,
      );
      const correctedUsers = new Set(
        dateCorrections.map((correction) => correction.userId).filter(Boolean),
      );
      const dateTargets = targets.filter(
        (target) =>
          target.businessDate === businessDate &&
          correctedUsers.has(target.userId),
      );
      if (dateTargets.length === 0) continue;
      await this.recheckArchivedAnomalies(
        job.date,
        businessDate,
        dateTargets,
        dateCorrections,
      );
    }
  }

  private completeCoveredCorrectionJobs(query: {
    start: string;
    end: string;
  }): void {
    for (const job of this.readCorrectionJobs()) {
      if (
        job.stage !== 'completed' &&
        job.query.start >= query.start &&
        job.query.end <= query.end
      ) {
        this.writeCorrectionJob({
          ...job,
          stage: 'completed',
          completedAt: new Date().toISOString(),
          failureReason: undefined,
          nextRetryAt: undefined,
        });
      }
    }
  }

  private readCorrectionJobs(): AttendanceCorrectionJob[] {
    const directory = join(
      dirname(this.statePath()),
      'attendance-correction-jobs',
    );
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) =>
        /^\d{4}-\d{2}-\d{2}-(archive-yesterday|morning-on-duty-reminder|morning-off-duty-check|evening-on-duty-reminder|evening-off-duty-check)\.json$/u.test(
          name,
        ),
      )
      .map((name) => {
        const parsed = JSON.parse(
          readFileSync(join(directory, name), 'utf8'),
        ) as AttendanceCorrectionJob;
        if (
          parsed.version !== 1 ||
          typeof parsed.date !== 'string' ||
          typeof parsed.task !== 'string' ||
          !parsed.query?.start ||
          !parsed.query?.end ||
          !['pending', 'fetched', 'completed'].includes(parsed.stage)
        ) {
          throw new Error(`补卡待办损坏：${name}`);
        }
        return parsed;
      });
  }

  private readCorrectionJob(
    task: AttendanceAutomationTask,
    date: string,
  ): AttendanceCorrectionJob | null {
    const path = this.correctionJobPath(task, date);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(
      readFileSync(path, 'utf8'),
    ) as AttendanceCorrectionJob;
    if (parsed.version !== 1 || parsed.task !== task || parsed.date !== date) {
      throw new Error(`补卡待办损坏：${date}:${task}`);
    }
    return parsed;
  }

  private writeCorrectionJob(job: AttendanceCorrectionJob): void {
    const path = this.correctionJobPath(job.task, job.date);
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
      renameSync(tempPath, path);
    } finally {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    }
  }

  private correctionJobPath(
    task: AttendanceAutomationTask,
    date: string,
  ): string {
    return join(
      dirname(this.statePath()),
      'attendance-correction-jobs',
      `${date}-${task}.json`,
    );
  }

  private claimTask(taskKey: string): string | null {
    const claimPath = this.claimPath(taskKey);
    mkdirSync(dirname(claimPath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const claimId = randomUUID();
      try {
        writeFileSync(
          claimPath,
          `${JSON.stringify({
            taskKey,
            claimId,
            pid: process.pid,
            claimedAt: new Date().toISOString(),
          })}\n`,
          { encoding: 'utf8', flag: 'wx' },
        );
        return claimId;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (attempt > 0 || !this.isStaleClaim(claimPath)) return null;
        try {
          unlinkSync(claimPath);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
            return null;
          }
        }
      }
    }
    return null;
  }

  private isStaleClaim(claimPath: string): boolean {
    try {
      const parsed = JSON.parse(readFileSync(claimPath, 'utf8')) as {
        pid?: unknown;
        claimedAt?: unknown;
      };
      const pid = Number(parsed.pid);
      if (Number.isInteger(pid) && pid > 0) {
        if (pid === process.pid) return true;
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ESRCH';
        }
      }
      const claimedAt = Date.parse(String(parsed.claimedAt || ''));
      return (
        !Number.isFinite(claimedAt) || Date.now() - claimedAt >= 15 * 60 * 1_000
      );
    } catch {
      return true;
    }
  }

  private releaseClaim(taskKey: string, claimId: string): void {
    const claimPath = this.claimPath(taskKey);
    try {
      const parsed = JSON.parse(readFileSync(claimPath, 'utf8')) as {
        claimId?: unknown;
      };
      if (parsed.claimId === claimId) unlinkSync(claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(
          `清理考勤任务占用标记失败：task=${taskKey}, error=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private snapshotPath(run: AttendanceAutomationRun): string {
    return join(
      dirname(this.statePath()),
      'dingtalk-attendance-snapshots',
      `${run.date}-${run.task}.json`,
    );
  }

  private repairSnapshotPath(
    runDate: string,
    businessDate: string,
    targetKeys: readonly string[],
  ): string {
    const targetHash = createHash('sha256')
      .update(targetKeys.join('\n'))
      .digest('hex')
      .slice(0, 16);
    return join(
      dirname(this.statePath()),
      'dingtalk-attendance-repair-snapshots',
      `${runDate}-${businessDate}-${targetHash}.json`,
    );
  }

  private claimPath(taskKey: string): string {
    const key = createHash('sha256').update(taskKey).digest('hex');
    return join(
      dirname(this.statePath()),
      'attendance-automation-claims',
      `${key}.json`,
    );
  }

  private readState(): AttendanceAutomationTaskState {
    const statePath = this.statePath();
    if (!existsSync(statePath)) {
      return { version: 1, completed: {}, runs: {} };
    }
    try {
      const parsed = JSON.parse(
        readFileSync(statePath, 'utf8'),
      ) as Partial<AttendanceAutomationTaskState>;
      if (parsed.version === 1 && parsed.completed) {
        return {
          version: 1,
          completed: parsed.completed,
          runs: parsed.runs || {},
          manualRetries: parsed.manualRetries || {},
        };
      }
    } catch (error) {
      this.logger.warn(
        `读取考勤自动化任务台账失败，将按幂等键重试：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { version: 1, completed: {}, runs: {} };
  }

  private markRunning(
    taskKey: string,
    run: AttendanceAutomationRun,
    maxAttemptsOverride?: number,
  ): void {
    const state = this.readState();
    const attemptedAt = new Date().toISOString();
    const previous = state.runs[taskKey];
    const policy = attendanceRetryPolicy(run.task);
    state.runs[taskKey] = {
      state: 'running',
      task: run.task,
      date: run.date,
      scheduledAt: run.scheduledAt.toISOString(),
      firstAttemptAt: previous?.firstAttemptAt || attemptedAt,
      lastAttemptAt: attemptedAt,
      attemptCount: Math.max(0, previous?.attemptCount || 0) + 1,
      maxAttempts: maxAttemptsOverride || policy.maxAttempts,
      retryCutoffAt: new Date(
        Date.parse(previous?.firstAttemptAt || attemptedAt) + policy.windowMs,
      ).toISOString(),
    };
    this.writeState(state);
  }

  private markFailed(
    taskKey: string,
    run: AttendanceAutomationRun,
    error: unknown,
  ): void {
    const state = this.readState();
    const failedAt = new Date().toISOString();
    const previous = state.runs[taskKey];
    const policy = attendanceRetryPolicy(run.task);
    const firstAttemptAt = previous?.firstAttemptAt || failedAt;
    const attemptCount = Math.max(1, previous?.attemptCount || 1);
    const maxAttempts = Math.max(
      1,
      previous?.maxAttempts || policy.maxAttempts,
    );
    const retryCutoffAt = new Date(
      Date.parse(firstAttemptAt) + policy.windowMs,
    ).toISOString();
    const nextRetryAt = new Date(
      Date.parse(failedAt) + policy.delayMs,
    ).toISOString();
    const finalFailure =
      !isFinalAttendanceTask(run.task) ||
      attemptCount >= maxAttempts ||
      Date.parse(nextRetryAt) > Date.parse(retryCutoffAt);
    state.runs[taskKey] = {
      state: 'failed',
      task: run.task,
      date: run.date,
      scheduledAt: run.scheduledAt.toISOString(),
      firstAttemptAt,
      lastAttemptAt: previous?.lastAttemptAt || failedAt,
      attemptCount,
      maxAttempts,
      failedAt,
      failureReason: publicAttendanceFailureReason(error),
      failureScope: publicAttendanceFailureScope(error),
      retryCutoffAt,
      ...(finalFailure ? {} : { nextRetryAt }),
      finalFailure,
    };
    this.writeState(state);
  }

  private markCompleted(
    taskKey: string,
    run?: AttendanceAutomationRun,
    result?: unknown,
  ): void {
    const state = this.readState();
    const completedAt = new Date().toISOString();
    const correctionSyncFailure =
      result && typeof result === 'object' && 'correctionSyncFailure' in result
        ? result.correctionSyncFailure
        : undefined;
    const archiveFailure =
      result && typeof result === 'object' && 'archiveFailure' in result
        ? result.archiveFailure
        : undefined;
    state.completed[taskKey] = { completedAt };
    if (run) {
      const previous = state.runs[taskKey];
      state.runs[taskKey] = {
        state: 'completed',
        task: run.task,
        date: run.date,
        scheduledAt: run.scheduledAt.toISOString(),
        ...(previous?.firstAttemptAt
          ? { firstAttemptAt: previous.firstAttemptAt }
          : {}),
        lastAttemptAt: previous?.lastAttemptAt || completedAt,
        ...(previous?.attemptCount
          ? { attemptCount: previous.attemptCount }
          : {}),
        ...(previous?.maxAttempts ? { maxAttempts: previous.maxAttempts } : {}),
        completedAt,
        ...(archiveFailure instanceof AttendanceAutomationFailure
          ? {
              archiveSyncFailureReason:
                publicAttendanceFailureReason(archiveFailure),
            }
          : {}),
        ...(correctionSyncFailure instanceof AttendanceAutomationFailure
          ? {
              correctionSyncFailureReason: publicAttendanceFailureReason(
                correctionSyncFailure,
              ),
            }
          : {}),
      };
    }
    this.writeState(state);
  }

  private writeState(state: AttendanceAutomationTaskState): void {
    const statePath = this.statePath();
    mkdirSync(dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      renameSync(tempPath, statePath);
    } finally {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    }
  }

  private statePath(): string {
    return resolveDutyDailyReportStateFilePath({
      fileName: 'attendance-automation-task-state.json',
      explicitPath: process.env.ATTENDANCE_AUTOMATION_STATE_PATH,
      configuredDirectory:
        process.env.ATTENDANCE_AUTOMATION_STATE_DIR ||
        process.env.DUTY_DAILY_REPORT_STATE_DIR,
    });
  }
}

const ATTENDANCE_MANUAL_RETRY_LEDGER_LIMIT = 100;

function isValidAttendanceManualMutationId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{11,127}$/u.test(value);
}

function pruneAttendanceManualRetries(
  entries: Record<string, AttendanceManualRetryLedgerEntry>,
): Record<string, AttendanceManualRetryLedgerEntry> {
  return Object.fromEntries(
    Object.entries(entries)
      .sort((left, right) =>
        left[1].requestedAt.localeCompare(right[1].requestedAt),
      )
      .slice(-ATTENDANCE_MANUAL_RETRY_LEDGER_LIMIT),
  );
}

function buildAttendancePageUrl(pathname: string): string {
  const rawPublicBaseUrl = readEnv('PUBLIC_BASE_URL');
  let url: URL;
  try {
    url = new URL(rawPublicBaseUrl);
  } catch {
    throw new Error('考勤卡片链接生成失败：PUBLIC_BASE_URL 配置无效');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      '考勤卡片链接生成失败：PUBLIC_BASE_URL 必须是无凭据 HTTPS 地址',
    );
  }
  const clientBasePath = normalizeClientBasePath(readEnv('CLIENT_BASE_PATH'));
  const publicBasePath = url.pathname.replace(/^\/+|\/+$/g, '');
  url.pathname = `/${[
    publicBasePath,
    clientBasePath.replace(/^\/+|\/+$/g, ''),
    pathname.replace(/^\/+|\/+$/g, ''),
  ]
    .filter(Boolean)
    .join('/')}`;
  return url.toString();
}

function normalizeClientBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  if (
    trimmed.includes('\\') ||
    /[?#\u0000-\u001f\u007f]/u.test(trimmed) ||
    trimmed.startsWith('//') ||
    /^[A-Za-z][A-Za-z\d+.-]*:/u.test(trimmed)
  ) {
    throw new Error('考勤卡片链接生成失败：CLIENT_BASE_PATH 配置无效');
  }
  const segments = trimmed.replace(/^\/+|\/+$/g, '').split('/');
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('考勤卡片链接生成失败：CLIENT_BASE_PATH 配置无效');
  }
  return `/${segments.join('/')}`;
}

function buildDingTalkCorrectionUrl(): string {
  const configured = readEnv('DINGTALK_ATTENDANCE_CORRECTION_URL');
  if (!configured) return DINGTALK_ATTENDANCE_APP_LINK;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('考勤卡片链接生成失败：钉钉补卡链接配置无效');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'applink.dingtalk.com' ||
    url.username ||
    url.password
  ) {
    throw new Error('考勤卡片链接生成失败：补卡链接必须使用钉钉官方 AppLink');
  }
  return url.toString();
}

function normalizeName(value: string): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '');
}

function tagAttendanceResults(
  results: readonly DingTalkAttendanceRawResult[],
  task: AttendanceAutomationTask,
): DingTalkAttendanceRawResult[] {
  return results.map((record) => ({
    ...record,
    original: {
      ...record.original,
      automationTask: task,
    },
  }));
}

function buildMorningSummarySectionData(
  reportDate: string,
  live: LiveAttendanceExecutionResult,
  archived: ArchivedAttendanceSummary,
): MorningAttendanceSummarySectionData[] {
  const archiveDate = shiftDate(reportDate, -1);
  const archivedNormal = archived.normal || [];
  return [
    {
      title: '今日白班',
      date: reportDate,
      anomalies: live.classification.anomalies.filter(
        (item) => !isNightShift(item.shiftLabel) && item.direction === 'OnDuty',
      ),
      normal: live.classification.normal.filter(
        (item) => !isNightShift(item.shiftLabel) && item.direction === 'OnDuty',
      ),
    },
    {
      title: '昨日白班',
      date: archiveDate,
      anomalies: archived.anomalies.filter(
        (item) => !isNightShift(item.shiftLabel),
      ),
      normal: archivedNormal.filter((item) => !isNightShift(item.shiftLabel)),
    },
    {
      title: '昨日夜班',
      date: archiveDate,
      anomalies: dedupeAttendanceItems([
        ...archived.anomalies.filter(
          (item) =>
            isNightShift(item.shiftLabel) && item.direction === 'OnDuty',
        ),
        ...live.classification.anomalies.filter(
          (item) =>
            isNightShift(item.shiftLabel) && item.direction === 'OffDuty',
        ),
      ]),
      normal: dedupeAttendanceItems([
        ...archivedNormal.filter(
          (item) =>
            isNightShift(item.shiftLabel) && item.direction === 'OnDuty',
        ),
        ...live.classification.normal.filter(
          (item) =>
            isNightShift(item.shiftLabel) && item.direction === 'OffDuty',
        ),
      ]),
    },
  ];
}

function isNightShift(shiftLabel: string): boolean {
  return /夜|night/iu.test(shiftLabel);
}

function dedupeAttendanceItems<T extends AttendanceExpectation>(
  items: readonly T[],
): T[] {
  return [...new Map(items.map((item) => [item.key, item])).values()];
}

const DEFAULT_ATTENDANCE_RETRY_DELAY_MS = 5 * 60_000;
const DEFAULT_ATTENDANCE_RETRY_MAX_ATTEMPTS = 6;
const DEFAULT_ATTENDANCE_RETRY_WINDOW_MS = 30 * 60_000;
const PERSONAL_ATTENDANCE_DELIVERY_VERSION = 'v2-per-recipient-ledger';
const MORNING_BRIEF_COMPLETION_VERSION = 'v6-group-card-resilience';
const MORNING_BRIEF_DELIVERY_IDENTITY = 'unified-full-v4';

class AttendanceAutomationFailure extends Error {
  constructor(
    readonly publicReason: string,
    cause: unknown,
    readonly failureScope: TodayAttendanceFailureScope = 'core',
  ) {
    super(`${publicReason}：${safeAttendanceErrorMessage(cause)}`);
    this.name = 'AttendanceAutomationFailure';
  }
}

async function withAttendanceFailureReason<T>(
  publicReason: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AttendanceAutomationFailure) throw error;
    throw new AttendanceAutomationFailure(publicReason, error);
  }
}

function publicAttendanceFailureReason(error: unknown): string {
  if (error instanceof AttendanceAutomationFailure) return error.publicReason;
  return '考勤自动化执行失败';
}

function publicAttendanceFailureScope(
  error: unknown,
): TodayAttendanceFailureScope {
  return error instanceof AttendanceAutomationFailure
    ? error.failureScope
    : 'core';
}

function safeAttendanceErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(
      /(app_secret|client_secret|access_token|tenant_access_token|token)\s*[=:]\s*[^\s&,]+/giu,
      '$1=[REDACTED]',
    )
    .slice(0, 500);
}

function attendanceRetryPolicy(task: AttendanceAutomationTask): {
  delayMs: number;
  maxAttempts: number;
  windowMs: number;
} {
  if (!isFinalAttendanceTask(task)) {
    return { delayMs: 0, maxAttempts: 1, windowMs: 0 };
  }
  return {
    delayMs: readBoundedInteger(
      'ATTENDANCE_AUTOMATION_RETRY_DELAY_MS',
      DEFAULT_ATTENDANCE_RETRY_DELAY_MS,
      1_000,
      60 * 60_000,
    ),
    maxAttempts: readBoundedInteger(
      'ATTENDANCE_AUTOMATION_RETRY_MAX_ATTEMPTS',
      DEFAULT_ATTENDANCE_RETRY_MAX_ATTEMPTS,
      1,
      20,
    ),
    windowMs:
      readBoundedInteger(
        'ATTENDANCE_AUTOMATION_RETRY_WINDOW_MINUTES',
        DEFAULT_ATTENDANCE_RETRY_WINDOW_MS / 60_000,
        1,
        24 * 60,
      ) * 60_000,
  };
}

function isFinalAttendanceTask(task: AttendanceAutomationTask): boolean {
  return task === 'morning-off-duty-check' || task === 'evening-off-duty-check';
}

function readBoundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

function correctionRetryAt(error: unknown, now: Date): Date {
  const message = safeAttendanceErrorMessage(error);
  if (/当日调用上限|预留|安全上限|未查询完整/u.test(message)) {
    const today = new Date(now.getTime() + 8 * 60 * 60 * 1_000)
      .toISOString()
      .slice(0, 10);
    return new Date(`${shiftDate(today, 1)}T00:45:00+08:00`);
  }
  return new Date(now.getTime() + 30 * 60 * 1_000);
}

function attendanceArchiveRetryAt(now: Date): Date {
  return new Date(
    now.getTime() +
      readBoundedInteger(
        'ATTENDANCE_ARCHIVE_RETRY_DELAY_MS',
        DEFAULT_ATTENDANCE_RETRY_DELAY_MS,
        1_000,
        60 * 60_000,
      ),
  );
}

function isPendingExternalSyncReason(reason: string): boolean {
  return /正在后台同步|仍在后台同步|手动刷新已受理/u.test(reason);
}

function buildCorrectionDiscoveryWindow(scheduledAt: Date): {
  start: string;
  end: string;
} {
  if (!Number.isFinite(scheduledAt.getTime())) {
    throw new Error('钉钉补卡审批发现时间无效');
  }
  const shanghai = new Date(scheduledAt.getTime() + 8 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  const endDate = shanghai.slice(0, 10);
  return {
    start: `${shiftDate(endDate, -13)} 00:00:00`,
    end: shanghai,
  };
}

function mergeCorrectionApprovals(
  ...groups: ReadonlyArray<readonly DingTalkCorrectionApproval[]>
): DingTalkCorrectionApproval[] {
  const merged = new Map<string, DingTalkCorrectionApproval>();
  groups.flat().forEach((item) => {
    if (item.processInstanceId) merged.set(item.processInstanceId, item);
  });
  return [...merged.values()];
}

function taskTime(
  task: Exclude<AttendanceAutomationTask, 'archive-yesterday'>,
): string {
  return {
    'morning-on-duty-reminder': '08:55',
    'morning-off-duty-check': '09:30',
    'evening-on-duty-reminder': '17:55',
    'evening-off-duty-check': '18:35',
  }[task];
}

function formatShanghaiMinute(value: Date): string {
  const local = new Date(value.getTime() + 8 * 60 * 60 * 1000);
  return `${local.toISOString().slice(0, 10)} ${local
    .toISOString()
    .slice(11, 16)}`;
}

export function deriveAttendanceResults(
  expectations: readonly AttendanceExpectation[],
  users: readonly DingTalkDirectoryUser[],
  details: readonly DingTalkAttendanceRawDetail[],
  rawResults: readonly DingTalkAttendanceRawResult[] = [],
  corrections: readonly DingTalkCorrectionApproval[] = [],
): DingTalkAttendanceRawResult[] {
  const matchedByExpectation = new Map<string, DingTalkAttendanceResult>(
    matchDingTalkResultsToExpectations(
      expectations,
      users,
      rawResults,
      details,
    ).map((item) => [item.expectationKey, item]),
  );
  const userIdsByName = new Map<string, string[]>();
  users.forEach((user) => {
    const key = normalizeName(user.name);
    const current = userIdsByName.get(key) || [];
    current.push(user.userId);
    userIdsByName.set(key, current);
  });

  return expectations.flatMap((expectation) => {
    const matched = matchedByExpectation.get(expectation.key);
    const candidateIds =
      userIdsByName.get(normalizeName(expectation.name)) || [];
    const userId =
      matched?.userId || (candidateIds.length === 1 ? candidateIds[0] : '');
    if (!userId) return [];
    const relatedRaw = findClosestRawAttendanceResult(
      rawResults,
      userId,
      expectation,
    );
    const relatedCorrection = findClosestCorrectionApproval(
      corrections,
      userId,
      expectation,
      relatedRaw,
    );
    const correctionEvidenceStatus = resolveCorrectionEvidenceStatus(
      relatedRaw,
      relatedCorrection,
    );
    const correctionApproved = isApprovedCorrection(relatedCorrection);
    const correctedAt = correctionApproved
      ? relatedCorrection?.correctionTime
      : null;
    const processInstanceId =
      relatedRaw?.procInstId || relatedCorrection?.processInstanceId || null;
    return [
      {
        id: `derived-${createHash('sha256')
          .update(expectation.key)
          .digest('hex')
          .slice(0, 24)}`,
        userId,
        checkType: expectation.direction,
        baseCheckTime: expectation.expectedAt,
        userCheckTime: correctedAt || matched?.userCheckTime || null,
        workDate: `${expectation.expectedAt.slice(0, 10)} 00:00:00`,
        timeResult: correctionApproved
          ? 'Normal'
          : matched?.timeResult || 'NotSigned',
        locationResult: null,
        approveId: relatedRaw?.approveId || null,
        procInstId: processInstanceId,
        sourceType:
          relatedCorrection || /APPROVE/iu.test(relatedRaw?.sourceType || '')
            ? 'APPROVE'
            : matched?.sourceType || 'SCHEDULE_COMPARISON',
        ...(correctionEvidenceStatus ? { correctionEvidenceStatus } : {}),
        original: {
          derived: true,
          expectationKey: expectation.key,
          attendanceChecks: [
            {
              expectation,
              timeResult: correctionApproved
                ? 'Normal'
                : matched?.timeResult || 'NotSigned',
              userCheckTime: correctedAt || matched?.userCheckTime || null,
              sourceType: relatedCorrection ? 'APPROVE' : matched?.sourceType,
              correctionEvidenceStatus,
              ...(processInstanceId ? { processInstanceId } : {}),
            },
          ],
          source:
            rawResults.length > 0
              ? 'schedule-and-attendance-list'
              : 'schedule-and-listRecord',
          ...(processInstanceId ? { processInstanceId } : {}),
        },
      },
    ];
  });
}

function findClosestRawAttendanceResult(
  records: readonly DingTalkAttendanceRawResult[],
  userId: string,
  expectation: AttendanceExpectation,
): DingTalkAttendanceRawResult | undefined {
  const expectedMillis = parseShanghaiDateTime(expectation.expectedAt);
  return records
    .filter(
      (record) =>
        record.userId === userId && record.checkType === expectation.direction,
    )
    .sort(
      (left, right) =>
        Math.abs(toEpochMillis(left.baseCheckTime) - expectedMillis) -
        Math.abs(toEpochMillis(right.baseCheckTime) - expectedMillis),
    )[0];
}

function resolveCorrectionEvidenceStatus(
  record: DingTalkAttendanceRawResult | undefined,
  correction: DingTalkCorrectionApproval | undefined,
): DingTalkAttendanceRawResult['correctionEvidenceStatus'] | undefined {
  if (
    !correction &&
    (!record ||
      (!record.procInstId && !/APPROVE/iu.test(record.sourceType || '')))
  ) {
    return undefined;
  }
  if (!correction) return 'unavailable';
  if (/^(RUNNING|NEW)$/iu.test(correction.status)) return 'pending';
  if (/^(refuse|rejected|deny)$/iu.test(correction.result)) return 'rejected';
  if (/^(agree|approved|pass)$/iu.test(correction.result)) {
    return correction.photoUrls.length > 0 ? 'present' : 'missing';
  }
  return 'unavailable';
}

function findClosestCorrectionApproval(
  corrections: readonly DingTalkCorrectionApproval[],
  userId: string,
  expectation: AttendanceExpectation,
  relatedRaw?: DingTalkAttendanceRawResult,
): DingTalkCorrectionApproval | undefined {
  if (relatedRaw?.procInstId) {
    const exact = corrections.find(
      (item) => item.processInstanceId === relatedRaw.procInstId,
    );
    if (exact) return exact;
  }
  const expectedMillis = parseShanghaiDateTime(expectation.expectedAt);
  const expectedDate = expectation.expectedAt.slice(0, 10);
  const candidates = corrections
    .flatMap((correction) => {
      if (correction.userId !== userId) return [];
      const direction = inferCorrectionDirection(correction.planText);
      if (direction && direction !== expectation.direction) return [];
      const correctionDate = correctionBusinessDate(correction);
      if (correctionDate && correctionDate !== expectedDate) return [];
      const distance = correction.correctionTime
        ? Math.abs(correction.correctionTime - expectedMillis)
        : Number.POSITIVE_INFINITY;
      if (Number.isFinite(distance) && distance > 90 * 60 * 1_000) {
        return [];
      }
      return [{ correction, distance }];
    })
    .sort((left, right) => left.distance - right.distance);
  if (candidates.length === 0) return undefined;
  const bestDistance = candidates[0].distance;
  const closest = candidates.filter(
    (candidate) => candidate.distance === bestDistance,
  );
  return closest.length === 1 ? closest[0].correction : undefined;
}

function inferCorrectionDirection(
  planText: string,
): AttendanceExpectation['direction'] | null {
  if (/上班/u.test(planText)) return 'OnDuty';
  if (/下班/u.test(planText)) return 'OffDuty';
  return null;
}

function correctionBusinessDate(
  correction: DingTalkCorrectionApproval,
): string {
  const value = correction.workDate || correction.correctionTime;
  if (!value || !Number.isFinite(value)) return '';
  return new Date(value + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

function isApprovedCorrection(
  correction: DingTalkCorrectionApproval | undefined,
): boolean {
  return Boolean(
    correction && /^(agree|approved|pass)$/iu.test(correction.result),
  );
}

function parseShanghaiDateTime(value: string): number {
  return Date.parse(`${value.replace(' ', 'T')}+08:00`);
}

function toEpochMillis(value: number | string | null): number {
  if (typeof value === 'number') return value;
  if (!value) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getCurrentWeekArchiveDates(
  latestBusinessDate: string,
): string[] {
  const syncDate = shiftDate(latestBusinessDate, 1);
  const [year, month, day] = syncDate.split('-').map(Number);
  const syncUtc = new Date(Date.UTC(year, month - 1, day));
  const weekday = syncUtc.getUTCDay();
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  const monday = shiftDate(syncDate, -daysSinceMonday);
  if (latestBusinessDate < monday) return [];

  const dates: string[] = [];
  for (
    let date = monday;
    date <= latestBusinessDate;
    date = shiftDate(date, 1)
  ) {
    dates.push(date);
  }
  return dates;
}
