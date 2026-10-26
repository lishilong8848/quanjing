import {
  EQUIPMENT_ROTATION_PLAN_2026,
  type RotationPlanDevice,
  type RotationPlanWindow,
} from './equipment-rotation-plan-2026.generated';

export type PatrolCellStatus =
  | 'planned'
  | 'adjusted'
  | 'completed'
  | 'partial'
  | 'missed'
  | 'none';

export interface PatrolDayCell {
  day: number;
  status: PatrolCellStatus;
  taskCount: number;
  note?: string;
  windowId?: string;
  isWindowStart?: boolean;
  sourceCell?: string;
}

export interface PatrolDeviceRow {
  id: string;
  name: string;
  planned: number;
  executed: number | null;
  partial: number | null;
  missed: number | null;
  lastMissedDate: string | null;
  days: PatrolDayCell[];
  sourceSeq: number;
  sourceRow: number;
  category: string | null;
  quantity: number | string;
  redundancy: string;
  runningState: string;
  strategy: string;
  frequency: string;
  notes: string[];
}

export interface PatrolMonthDashboard {
  month: string;
  referenceDate: string;
  referenceDay: number;
  planSourceUpdatedAt: string;
  executionDataAvailable: boolean;
  comparedPlanRate: number | null;
  comparedUnexecutedRate: number | null;
  dailyPlanned: number;
  dailyCompleted: number | null;
  healthScore: number | null;
  devices: PatrolDeviceRow[];
}

export interface PatrolMonthSummary {
  planned: number;
  executed: number | null;
  partial: number | null;
  missed: number | null;
  unexecuted: number | null;
  executionRate: number | null;
}

export interface RankedPatrolDevice extends PatrolDeviceRow {
  rate: number | null;
}

export interface PendingPatrolTask {
  deviceId: string;
  deviceName: string;
  missed: number;
  lastMissedDate: string | null;
}

const DEFAULT_PATROL_MONTH = '2026-07';

export const PATROL_MONTH_OPTIONS = Object.freeze(
  Array.from({ length: 12 }, (_, index) => {
    const monthNumber = String(index + 1).padStart(2, '0');
    return Object.freeze({
      value: `2026-${monthNumber}`,
      label: `2026年${monthNumber}月`,
    });
  }),
);

const VALID_PATROL_MONTHS: ReadonlySet<string> = new Set<string>(
  PATROL_MONTH_OPTIONS.map((option) => option.value),
);

const roundOne = (value: number): number => Math.round(value * 10) / 10;

function getDayCount(month: string): number {
  const monthNumber = Number(month.slice(5, 7));
  return new Date(Date.UTC(2026, monthNumber, 0)).getUTCDate();
}

function getDayOffset(startDate: string, currentDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const current = Date.parse(`${currentDate}T00:00:00Z`);
  return Math.round((current - start) / 86_400_000);
}

function isWindowActive(window: RotationPlanWindow, date: string): boolean {
  return window.startDate <= date && date <= window.endDate;
}

function countMonthWindows(device: RotationPlanDevice, month: string): number {
  return device.plannedWindows.filter((window) =>
    window.startDate.startsWith(month),
  ).length;
}

function createDayCells(
  device: RotationPlanDevice,
  month: string,
): PatrolDayCell[] {
  return Array.from({ length: getDayCount(month) }, (_, index) => {
    const day = index + 1;
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const window = device.plannedWindows.find((candidate) =>
      isWindowActive(candidate, date),
    );

    if (!window) {
      return { day, status: 'none', taskCount: 0 };
    }

    const adjustment = device.adjustments.find(
      (candidate) => candidate.date === date,
    );
    const sourceCell = window.sourceCells[getDayOffset(window.startDate, date)];
    const isWindowStart = window.startDate === date;

    return {
      day,
      status: adjustment ? 'adjusted' : 'planned',
      taskCount: isWindowStart ? 1 : 0,
      ...(adjustment ? { note: adjustment.label } : {}),
      windowId: window.id,
      isWindowStart,
      ...(sourceCell ? { sourceCell } : {}),
    };
  });
}

function cloneDevice(device: PatrolDeviceRow): PatrolDeviceRow {
  return {
    ...device,
    notes: [...device.notes],
    days: device.days.map((day) => ({ ...day })),
  };
}

function getPlanTotal(month: string): number {
  return EQUIPMENT_ROTATION_PLAN_2026.devices.reduce(
    (total, device) => total + countMonthWindows(device, month),
    0,
  );
}

function getComparedPlanRate(month: string): number | null {
  const monthNumber = Number(month.slice(5, 7));
  if (monthNumber <= 1) return null;

  const previousMonth = `2026-${String(monthNumber - 1).padStart(2, '0')}`;
  const previousTotal = getPlanTotal(previousMonth);
  if (previousTotal === 0) return null;

  return roundOne(
    ((getPlanTotal(month) - previousTotal) / previousTotal) * 100,
  );
}

export function summarizePatrolMonth(
  dashboard: PatrolMonthDashboard,
): PatrolMonthSummary {
  const planned = dashboard.devices.reduce(
    (total, device) => total + device.planned,
    0,
  );

  if (!dashboard.executionDataAvailable) {
    return {
      planned,
      executed: null,
      partial: null,
      missed: null,
      unexecuted: null,
      executionRate: null,
    };
  }

  const hasCompleteExecutionData = dashboard.devices.every(
    (device) =>
      device.executed !== null &&
      device.partial !== null &&
      device.missed !== null,
  );

  if (!hasCompleteExecutionData) {
    return {
      planned,
      executed: null,
      partial: null,
      missed: null,
      unexecuted: null,
      executionRate: null,
    };
  }

  const executed = dashboard.devices.reduce(
    (total, device) => total + device.executed!,
    0,
  );
  const partial = dashboard.devices.reduce(
    (total, device) => total + device.partial!,
    0,
  );
  const missed = dashboard.devices.reduce(
    (total, device) => total + device.missed!,
    0,
  );

  return {
    planned,
    executed,
    partial,
    missed,
    unexecuted: planned - executed,
    executionRate: planned === 0 ? null : roundOne((executed / planned) * 100),
  };
}

export function rankPatrolDevices(
  devices: readonly PatrolDeviceRow[],
): RankedPatrolDevice[] {
  const ranked = devices.map((device, index) => ({
    device: {
      ...cloneDevice(device),
      rate:
        device.executed === null || device.planned === 0
          ? null
          : roundOne((device.executed / device.planned) * 100),
    },
    index,
  }));

  if (ranked.every(({ device }) => device.rate === null)) {
    return ranked.map(({ device }) => device);
  }

  return ranked
    .sort(
      (left, right) =>
        (right.device.rate ?? Number.NEGATIVE_INFINITY) -
          (left.device.rate ?? Number.NEGATIVE_INFINITY) ||
        left.index - right.index,
    )
    .map(({ device }) => device);
}

export function getPendingPatrolTasks(
  devices: readonly PatrolDeviceRow[],
): PendingPatrolTask[] {
  if (devices.every((device) => device.missed === null)) return [];

  return devices
    .map((device, index) => ({
      task: {
        deviceId: device.id,
        deviceName: device.name,
        missed: device.missed ?? 0,
        lastMissedDate: device.lastMissedDate,
      },
      index,
    }))
    .filter(({ task }) => task.missed > 0)
    .sort(
      (left, right) =>
        right.task.missed - left.task.missed || left.index - right.index,
    )
    .map(({ task }) => task);
}

export function getPatrolMonthDashboard(month: string): PatrolMonthDashboard {
  const selectedMonth = VALID_PATROL_MONTHS.has(month)
    ? month
    : DEFAULT_PATROL_MONTH;
  const referenceDate = `${selectedMonth}-10`;

  return {
    month: selectedMonth,
    referenceDate,
    referenceDay: 10,
    planSourceUpdatedAt: EQUIPMENT_ROTATION_PLAN_2026.metadata.sourceModifiedAt,
    executionDataAvailable: false,
    comparedPlanRate: getComparedPlanRate(selectedMonth),
    comparedUnexecutedRate: null,
    dailyPlanned: EQUIPMENT_ROTATION_PLAN_2026.devices.reduce(
      (total, device) =>
        total +
        Number(
          device.plannedWindows.some((window) =>
            isWindowActive(window, referenceDate),
          ),
        ),
      0,
    ),
    dailyCompleted: null,
    healthScore: null,
    devices: EQUIPMENT_ROTATION_PLAN_2026.devices.map((device) => ({
      id: device.id,
      name: device.name,
      planned: countMonthWindows(device, selectedMonth),
      executed: null,
      partial: null,
      missed: null,
      lastMissedDate: null,
      days: createDayCells(device, selectedMonth),
      sourceSeq: device.sourceSeq,
      sourceRow: device.sourceRow,
      category: device.category,
      quantity: device.quantity,
      redundancy: device.redundancy,
      runningState: device.runningState,
      strategy: device.strategy,
      frequency: device.frequency,
      notes: [...device.notes],
    })),
  };
}
