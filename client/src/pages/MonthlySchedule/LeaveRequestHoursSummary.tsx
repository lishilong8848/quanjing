import type { LeaveRequestImpact } from '@shared/leave-request-impact';

type LeaveScheduleCoverageStatus = 'idle' | 'loading' | 'ready' | 'error';

interface LeaveRequestHoursSummaryProps {
  coverageStatus: LeaveScheduleCoverageStatus;
  isCoverageReady: boolean;
  hasTimeRange: boolean;
  impact: LeaveRequestImpact;
  submitting: boolean;
  onRetry: () => void;
}

export function LeaveRequestHoursSummary({
  coverageStatus,
  isCoverageReady,
  hasTimeRange,
  impact,
  submitting,
  onRetry,
}: LeaveRequestHoursSummaryProps) {
  if (coverageStatus === 'error') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-3">
        <p className="text-sm text-rose-700">
          时间范围内排班加载失败，暂不能提交。
        </p>
        <button
          type="button"
          disabled={submitting}
          onClick={onRetry}
          className="h-8 rounded-md border border-rose-200 bg-white px-3 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          重新加载排班
        </button>
      </div>
    );
  }

  if (coverageStatus === 'loading' || !isCoverageReady) {
    return (
      <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">
        正在加载休假时段内的排班，请稍候。
      </p>
    );
  }

  if (!hasTimeRange) {
    return (
      <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-700">
        当前加载范围内没有该人员可申请的排班时段。
      </p>
    );
  }

  if (impact.invalidRange) {
    return (
      <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-700">
        开始和结束时间必须为有效整点，且结束时间必须晚于开始时间。
      </p>
    );
  }

  if (impact.unrecognizedShifts.length > 0) {
    return (
      <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-700">
        未识别班次 {impact.unrecognizedShifts.join('、')}
        ，已阻止提交，请先核对排班。
      </p>
    );
  }

  if (impact.missingCalendarYears.length > 0) {
    return (
      <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-700">
        缺少 {impact.missingCalendarYears.join('、')}{' '}
        年法定节假日数据，已阻止提交。
      </p>
    );
  }

  if (impact.rawHours < 4) {
    return (
      <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-700">
        当前实际休假工时不足 4 小时，请调整开始或结束时间。
      </p>
    );
  }

  return (
    <p className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-4 text-xl font-semibold text-blue-800">
      休假工时：{impact.rawHours} 小时
    </p>
  );
}
