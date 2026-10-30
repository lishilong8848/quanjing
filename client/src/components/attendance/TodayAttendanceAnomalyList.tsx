import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { TodayAttendanceSnapshot } from '@shared/today-attendance.interface';
import type { TodayAttendanceLoadState } from './use-today-attendance';
import { AttendanceHistoryDialogButton } from './AttendanceHistoryDialogButton';
import {
  AttendanceCorrectionEvidenceDialog,
  type AttendanceCorrectionEvidenceTarget,
} from './AttendanceCorrectionEvidenceDialog';
import {
  formatTodayAttendanceAnomaly,
  getTodayAttendanceCardLabel,
  groupTodayAttendanceAnomalies,
} from './today-attendance-presentation';

interface TodayAttendanceAnomalyListProps {
  snapshot: TodayAttendanceSnapshot | null;
  state: TodayAttendanceLoadState;
  retry: () => void;
  compact?: boolean;
  title?: string;
  canManualSync?: boolean;
  canViewCorrectionEvidence?: boolean;
  manualSync?: () => void;
  manualSyncState?: 'idle' | 'submitting' | 'accepted' | 'pending' | 'success' | 'error';
  manualSyncError?: string | null;
}

export function TodayAttendanceAnomalyList({
  snapshot,
  state,
  retry,
  compact = false,
  title = '今日考勤异常一览',
  canManualSync = false,
  canViewCorrectionEvidence = false,
  manualSync,
  manualSyncState = 'idle',
  manualSyncError,
}: TodayAttendanceAnomalyListProps) {
  const [correctionEvidenceTarget, setCorrectionEvidenceTarget] =
    useState<AttendanceCorrectionEvidenceTarget | null>(null);
  const anomalies = (snapshot?.entries || [])
    .filter((entry) => entry.status === 'anomaly')
    .map(formatTodayAttendanceAnomaly);
  const grouped = groupTodayAttendanceAnomalies(anomalies);
  const abnormalPeople = new Set(
    anomalies.map((item) => `${item.building}:${item.name}`),
  ).size;
  const isPreviousDay = snapshot?.displayScope === 'previous-day';
  const attendanceDayLabel = isPreviousDay
    ? `昨日（${snapshot.date}）`
    : '今日';
  const resolvedTitle = isPreviousDay
    ? `${attendanceDayLabel}考勤异常一览`
    : title;
  const hasData = Boolean(snapshot);
  const sourceStatus = snapshot?.sourceStatus;
  const runStatus = snapshot?.runStatus;
  const isPending = sourceStatus === 'pending';
  const isNotRun = sourceStatus === 'not-run';
  const isRunning = sourceStatus === 'running';
  const isPersonalDeliveryFailure =
    sourceStatus === 'failed' &&
    runStatus?.failureScope === 'personal-delivery';
  const isFailed = sourceStatus === 'failed' && !isPersonalDeliveryFailure;
  const hasRetainedAttendanceResult = Boolean(
    snapshot &&
    snapshot.summary.expected > 0 &&
    snapshot.summary.anomaly === anomalies.length &&
    snapshot.checkedTasks.includes(
      runStatus?.scheduledAt.slice(-5) === '18:35'
        ? 'evening-off-duty-check'
        : 'morning-off-duty-check',
    ),
  );
  const isStale = sourceStatus === 'stale';
  const isLoadingWithoutData =
    !hasData && (state === 'idle' || state === 'loading');
  const isUnavailable = !hasData && !isLoadingWithoutData;
  const isWarning = isNotRun || isRunning || isStale || isUnavailable;
  const hasCompletedData =
    sourceStatus === 'fresh' ||
    (isFailed && hasRetainedAttendanceResult) ||
    (isPersonalDeliveryFailure && (snapshot?.summary.expected || 0) > 0) ||
    (isStale && (snapshot?.summary.expected || 0) > 0);
  const resultText = snapshot
    ? `正常 ${snapshot.summary.normal} · 异常 ${snapshot.summary.anomaly}`
    : '';
  const lastSync =
    snapshot?.fetchedAt || snapshot?.runStatus?.lastAttemptAt || '—';
  const checkTime = snapshot?.runStatus?.scheduledAt.slice(-5) || '09:30';
  const attemptText =
    runStatus?.attemptCount && runStatus?.maxAttempts
      ? `${runStatus.attemptCount}/${runStatus.maxAttempts} 次`
      : '';
  const nextRetryTime = runStatus?.nextRetryAt?.slice(-5) || '';
  const failureReason = runStatus?.failureReason || '考勤数据处理失败';
  const isManualSyncing =
    manualSyncState === 'submitting' || manualSyncState === 'accepted';
  const isManualPending = manualSyncState === 'pending';
  const showManualSync =
    canManualSync && Boolean(snapshot) && !isPreviousDay && !isPending;
  const isRefreshing = state === 'refreshing' || state === 'loading';
  const refreshFailed = state === 'stale' || state === 'error';
  const refreshLabel = isRefreshing
    ? '正在刷新考勤结果'
    : refreshFailed
      ? '刷新未完成，显示上次结果；点击重试'
      : '刷新考勤结果';

  return (
    <>
      <section
        className={cn(
          'today-attendance-anomaly-list overflow-hidden rounded-lg border bg-white shadow-sm',
          isPending || isLoadingWithoutData
            ? 'border-sky-200'
            : isWarning
              ? 'border-amber-200'
              : isFailed || anomalies.length > 0
                ? 'border-rose-200'
                : 'border-emerald-200',
          compact && 'mt-4 shadow-none',
        )}
        aria-label={resolvedTitle}
      >
        <header
          className={cn(
            'flex items-center gap-2 border-b px-4 py-3',
            isPending || isLoadingWithoutData
              ? 'border-sky-100 bg-sky-50/70 text-sky-800'
              : isWarning
                ? 'border-amber-100 bg-amber-50/70 text-amber-800'
                : isFailed || anomalies.length > 0
                  ? 'border-rose-100 bg-rose-50/70 text-rose-800'
                  : 'border-emerald-100 bg-emerald-50/70 text-emerald-800',
          )}
        >
          {isPending || isNotRun || isLoadingWithoutData ? (
            <Clock3 className="size-4 shrink-0" aria-hidden="true" />
          ) : isRunning ? (
            <RefreshCw
              className="size-4 shrink-0 animate-spin"
              aria-hidden="true"
            />
          ) : isFailed || isStale || isUnavailable || anomalies.length > 0 ? (
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
          )}
          <h3 className="min-w-0 text-sm font-semibold">{resolvedTitle}</h3>
          <div className="ml-auto flex items-center gap-2">
            {hasData && hasCompletedData && (
              <span className="text-xs font-semibold">
                {getTodayAttendanceCardLabel(
                  abnormalPeople,
                  attendanceDayLabel,
                )}
              </span>
            )}
            {hasData && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={cn('shrink-0', refreshFailed && 'text-amber-700')}
                onClick={retry}
                disabled={isRefreshing}
                aria-label={refreshLabel}
                title={`${refreshLabel}；数据更新于 ${lastSync}`}
              >
                {refreshFailed ? (
                  <AlertTriangle className="size-3.5" aria-hidden="true" />
                ) : (
                  <RefreshCw
                    className={cn('size-3.5', isRefreshing && 'animate-spin')}
                    aria-hidden="true"
                  />
                )}
              </Button>
            )}
            {!compact && (
              <AttendanceHistoryDialogButton
                canViewCorrectionEvidence={canViewCorrectionEvidence}
              />
            )}
            {showManualSync && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-current"
                onClick={manualSync}
                disabled={isManualSyncing || isManualPending}
                aria-label="手动同步今日考勤"
                title={isManualPending ? '等待本次手动核验结果' : isManualSyncing ? '今日考勤同步中' : '手动同步今日考勤'}
              >
                <RefreshCw
                  className={cn('size-3.5', isManualSyncing && 'animate-spin')}
                  aria-hidden="true"
                />
              </Button>
            )}
          </div>
        </header>

        {isManualSyncing && (
          <div
            className="border-b border-sky-100 bg-sky-50/50 px-4 py-2 text-xs font-medium text-sky-700"
            role="status"
          >
            正在核验本次手动同步，完成后页面会自动更新
          </div>
        )}
        {isManualPending && <div role="status" className="flex items-center justify-between gap-3 border-b border-amber-100 bg-amber-50/50 px-4 py-2 text-xs text-amber-800"><span>本次手动核验结果尚未确认，正在继续读取；已有考勤结果保留。</span><button type="button" className="shrink-0 underline" disabled={isRefreshing} onClick={retry}>刷新结果</button></div>}
        {manualSyncState === 'success' && (
          <div
            className="border-b border-emerald-100 bg-emerald-50/50 px-4 py-2 text-xs font-medium text-emerald-700"
            role="status"
          >
            本次手动同步已完成
            {(runStatus?.archiveSyncState === 'syncing' || runStatus?.correctionSyncState === 'syncing') && <div className="mt-1 font-normal text-slate-500">归档或补卡资料仍在后台更新，考勤核验已完成。</div>}
          </div>
        )}
        {manualSyncState === 'error' && (
          <div
            className="flex items-center justify-between gap-3 border-b border-rose-100 bg-rose-50/50 px-4 py-2"
            role="alert"
          >
            <span className="text-xs font-medium text-rose-700">
              {manualSyncError || '手动同步失败，请稍后重试'}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={manualSync}
            >
              重新同步
            </Button>
          </div>
        )}
        {isFailed && hasRetainedAttendanceResult && (
          <div
            className="border-b border-amber-100 bg-amber-50/60 px-4 py-2 text-xs text-amber-800"
            role="alert"
          >
            已显示最近保存的打卡结果（{lastSync}）；本轮{failureReason}
            {attemptText ? `，已尝试 ${attemptText}` : ''}
            {nextRetryTime ? `，下次重试 ${nextRetryTime}` : ''}
            ，异常状态仍待核验
          </div>
        )}
        {isLoadingWithoutData ? (
          <div className="px-4 py-4 text-sm text-slate-500" role="status">
            考勤数据加载中…
          </div>
        ) : isUnavailable ? (
          <div
            className="flex items-center justify-between gap-3 px-4 py-3"
            role="alert"
          >
            <span className="text-sm text-rose-700">考勤数据暂不可用</span>
            <Button type="button" variant="outline" size="sm" onClick={retry}>
              <RefreshCw className="size-3.5" aria-hidden="true" />
              重试
            </Button>
          </div>
        ) : isPending ? (
          <div className="px-4 py-4 text-sm font-medium text-sky-700">
            等待 09:30 考勤终检
          </div>
        ) : isNotRun ? (
          <div className="px-4 py-4 text-sm font-medium text-amber-700">
            {checkTime} 考勤终检本轮未执行
          </div>
        ) : isRunning ? (
          <div className="space-y-1 px-4 py-4 text-sm text-amber-700">
            <div className="font-medium">{isManualSyncing ? '正在核验本次手动同步' : isManualPending ? '本次手动核验结果待确认' : (runStatus?.attemptCount || 0) > 1 ? `${checkTime} 考勤终检正在补跑` : `${checkTime} 考勤终检正在核验`}</div>
            {!isManualSyncing && !isManualPending && attemptText && <div className="text-xs">当前第 {attemptText}</div>}
          </div>
        ) : isFailed && !hasRetainedAttendanceResult ? (
          <div className="space-y-1 px-4 py-4 text-sm text-rose-700">
            <div className="font-medium">
              {runStatus?.finalFailure
                ? `${checkTime} 考勤终检失败，已停止自动重试`
                : `${checkTime} 考勤终检本轮执行失败`}
            </div>
            <div className="text-xs">原因：{failureReason}</div>
            {!runStatus?.finalFailure && (
              <div className="text-xs text-slate-600">
                {attemptText && `已尝试 ${attemptText} · `}
                {nextRetryTime
                  ? `下次自动重试 ${nextRetryTime}`
                  : '系统稍后自动重试'}
              </div>
            )}
            {runStatus?.finalFailure && (
              <div className="text-xs text-slate-600">
                {attemptText ? `已尝试 ${attemptText}` : '本轮已结束'}
              </div>
            )}
            {snapshot && snapshot.summary.expected > 0 && (
              <div className="text-xs text-slate-600">
                已获取考勤结果：{resultText} · 最后同步 {lastSync}
              </div>
            )}
          </div>
        ) : isStale && snapshot?.summary.expected === 0 ? (
          <div className="px-4 py-4 text-sm text-amber-700">
            {attendanceDayLabel}考勤结果暂不可用，正在重新读取
          </div>
        ) : anomalies.length === 0 ? (
          <div className="px-4 py-4">
            <div className="text-sm font-medium text-emerald-700">
              {isFailed
                ? `${attendanceDayLabel}当前打卡结果无异常，待核验`
                : `${attendanceDayLabel}考勤正常`}
            </div>
          </div>
        ) : (
          <div>
            <div className="grid gap-2 p-3 lg:grid-cols-2">
              {grouped.map((group) => (
                <div
                  key={group.building}
                  className="flex min-w-0 items-start gap-2 rounded-md border border-slate-200 bg-slate-50/60 px-2.5 py-2"
                >
                  <Badge color="neutral" className="mt-0.5 font-semibold">
                    {group.building}
                  </Badge>
                  <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                    {group.people.map((person) => (
                      <span
                        key={`${group.building}-${person.name}`}
                        className="inline-flex min-w-0 flex-wrap items-center gap-1 rounded-md bg-white px-2 py-1 text-xs shadow-sm ring-1 ring-slate-200"
                      >
                        <strong className="font-semibold text-slate-900">
                          {person.name}
                        </strong>
                        {person.anomalies.map((item) => (
                          <span
                            key={`${item.entryKey}-${item.card}`}
                            className="inline-flex items-center gap-1"
                          >
                            <Badge
                              color={item.card === '上班卡' ? 'blue' : 'orange'}
                              className="px-1.5 py-0 font-medium"
                            >
                              {item.card === '上班卡' ? '上班' : '下班'}
                            </Badge>
                            {item.punchStatus &&
                              (canViewCorrectionEvidence && snapshot ? (
                                <button
                                  type="button"
                                  className="inline-flex items-center rounded-md bg-emerald-50 px-1.5 py-0 font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200 transition-colors hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                                  aria-label={`查看${person.name}${item.card === '上班卡' ? '上班' : '下班'}补卡举证`}
                                  onClick={() =>
                                    setCorrectionEvidenceTarget({
                                      businessDate: snapshot.date,
                                      entryKey: item.entryKey,
                                      displayName: person.name,
                                      cardLabel:
                                        item.card === '上班卡'
                                          ? '上班'
                                          : '下班',
                                    })
                                  }
                                >
                                  {item.punchStatus}
                                </button>
                              ) : (
                                <Badge
                                  color="emerald"
                                  className="px-1.5 py-0 font-medium"
                                >
                                  {item.punchStatus}
                                </Badge>
                              ))}
                            <span className="font-semibold text-rose-600">
                              {item.anomaly}
                            </span>
                          </span>
                        ))}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
      <AttendanceCorrectionEvidenceDialog
        target={correctionEvidenceTarget}
        onOpenChange={(open) => {
          if (!open) setCorrectionEvidenceTarget(null);
        }}
      />
    </>
  );
}
