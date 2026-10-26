import type {
  SystemMonthlyReportDashboard,
  SystemMonthlyReportMonthlySnapshot,
  SystemMonthlyReportStepKey,
} from '@shared/system-monthly-report.interface';

const STAGE_LABELS: Record<SystemMonthlyReportStepKey, string> = {
  initial_submit: '月报提交',
  initial_review: '初审',
  recheck_submit: '复审月报提交',
  recheck_review: '复审',
  final_submit: '终版月报提交',
};

const STAGE_KEYS = Object.keys(STAGE_LABELS) as SystemMonthlyReportStepKey[];

export function systemMonthlyReportPeriodKey(
  year: number,
  month: number,
): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export interface SystemMonthlyReportPackagePeriodOption {
  value: string;
  label: string;
  totalRooms: number;
  completedRooms: number;
}

export function buildSystemMonthlyReportPackagePeriodOptions(
  dashboard: Pick<SystemMonthlyReportDashboard, 'period' | 'monthlySnapshots'>,
): SystemMonthlyReportPackagePeriodOption[] {
  const snapshots = new Map(
    dashboard.monthlySnapshots.map((snapshot) => [
      systemMonthlyReportPeriodKey(snapshot.year, snapshot.month),
      snapshot,
    ]),
  );
  return Array.from(snapshots.entries())
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([value, snapshot]) => ({
      value,
      label: `${snapshot.year}年${snapshot.month}月`,
      totalRooms: snapshot.totalRooms,
      completedRooms: snapshot.completedRooms,
    }));
}

export function buildSystemMonthlyReportOverviewModel(
  dashboard: Pick<
    SystemMonthlyReportDashboard,
    'period' | 'monthlySnapshots' | 'history' | 'rooms'
  >,
  requestedPeriodKey?: string,
) {
  const snapshots = [...dashboard.monthlySnapshots].sort(
    (left, right) => left.year - right.year || left.month - right.month,
  );
  const currentPeriodKey = systemMonthlyReportPeriodKey(
    dashboard.period.year,
    dashboard.period.month,
  );
  const availablePeriodKeys = snapshots
    .map((item) => systemMonthlyReportPeriodKey(item.year, item.month))
    .reverse();
  const selectedPeriodKey = availablePeriodKeys.includes(
    requestedPeriodKey || '',
  )
    ? String(requestedPeriodKey)
    : availablePeriodKeys.includes(currentPeriodKey)
      ? currentPeriodKey
      : availablePeriodKeys[0] || currentPeriodKey;
  const selectedSnapshot =
    snapshots.find(
      (item) =>
        systemMonthlyReportPeriodKey(item.year, item.month) ===
        selectedPeriodKey,
    ) || emptySnapshot(selectedPeriodKey);
  const stageSeries = STAGE_KEYS.map((key) => {
    const completed = selectedSnapshot.stageCompletedRooms[key] || 0;
    return {
      key,
      label: STAGE_LABELS[key],
      completed,
      pending: Math.max(0, selectedSnapshot.totalRooms - completed),
      completionRate: percentage(completed, selectedSnapshot.totalRooms),
    };
  });
  const trend = snapshots.slice(-6).map((snapshot) => ({
    periodKey: systemMonthlyReportPeriodKey(snapshot.year, snapshot.month),
    year: snapshot.year,
    month: snapshot.month,
    completedRooms: snapshot.completedRooms,
    totalRooms: snapshot.totalRooms,
    completionRate: percentage(snapshot.completedRooms, snapshot.totalRooms),
  }));
  const selectedHistory = dashboard.history.filter(
    (item) =>
      systemMonthlyReportPeriodKey(item.year, item.month) === selectedPeriodKey,
  );

  return {
    currentPeriodKey,
    selectedPeriodKey,
    selectedSnapshot,
    availablePeriodKeys,
    stageSeries,
    trend,
    selectedHistory,
    selectedRooms:
      selectedPeriodKey === currentPeriodKey ? dashboard.rooms : [],
  };
}

export function buildSystemMonthlyReportStageDrilldownRows(
  snapshot: Pick<SystemMonthlyReportMonthlySnapshot, 'rooms'>,
  stageKey: SystemMonthlyReportStepKey,
) {
  return (snapshot.rooms || []).map((room) => ({
    room: room.room,
    completed: Boolean(room.stages[stageKey]?.completed),
    completedAt: room.stages[stageKey]?.completedAt || null,
  }));
}

function emptySnapshot(periodKey: string): SystemMonthlyReportMonthlySnapshot {
  const [year, month] = periodKey.split('-').map(Number);
  return {
    year: Number.isFinite(year) ? year : 0,
    month: Number.isFinite(month) ? month : 0,
    totalRooms: 0,
    completedRooms: 0,
    stageCompletedRooms: Object.fromEntries(
      STAGE_KEYS.map((key) => [key, 0]),
    ) as Record<SystemMonthlyReportStepKey, number>,
    rooms: [],
    milestones: [],
  };
}

function percentage(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}
