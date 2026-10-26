import type {
  EquipmentPatrolBuilding,
  EquipmentPatrolCategory,
  EquipmentPatrolExecutionRecord,
  EquipmentPatrolExecutionResponse,
  EquipmentPatrolExecutionStatus,
  EquipmentPatrolQualityFlag,
} from '../../../../shared/equipment-patrol-execution.interface';
import { EQUIPMENT_PATROL_BUILDINGS } from '../../../../shared/equipment-patrol-execution.interface';

import {
  EQUIPMENT_ROTATION_PLAN_2026,
  type RotationPlanDevice,
  type RotationPlanWindow,
} from './equipment-rotation-plan-2026.generated';
import type { PatrolDeviceRow, PatrolMonthDashboard } from './model';

export type EquipmentPatrolAnomalyType =
  | 'time_quality'
  | 'overdue_uncovered'
  | 'unfinished'
  | 'outside_plan_window'
  | 'start_delay'
  | 'end_overtime';

export interface EquipmentPatrolExecutionGroup {
  id: string;
  building: EquipmentPatrolBuilding | null;
  category: EquipmentPatrolCategory | null;
  date: string | null;
  recordIds: string[];
  title: string;
  equipment: string;
  specialty: string;
  planStart: string | null;
  planEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  updatedAt: string | null;
  progress: string;
  status: EquipmentPatrolExecutionStatus;
  content: string;
  completed: boolean;
  nonPlanned: boolean;
  qualityFlags: EquipmentPatrolQualityFlag[];
  matchedWindowId: string | null;
  matchedDeviceId: string | null;
}

export interface EquipmentPatrolBuildingSummary {
  building: EquipmentPatrolBuilding;
  monthPlan: number;
  due: number;
  covered: number;
  overdue: number;
  active: number;
  future: number;
  outOfPlan: number;
  coverageRate: number | null;
  anomalyCount: number;
}

export interface EquipmentPatrolExecutionKpis {
  monthPlanPerBuilding: number;
  due: number;
  covered: number;
  deviations: number;
  compliantBuildings: number;
}

export interface EquipmentPatrolAnomaly {
  id: string;
  type: EquipmentPatrolAnomalyType;
  priority: 1 | 2 | 3 | 4 | 5 | 6;
  building: EquipmentPatrolBuilding | null;
  category: EquipmentPatrolCategory | null;
  deviceId: string | null;
  windowId: string | null;
  date: string | null;
  minutes: number | null;
  recordIds: string[];
  qualityFlags: EquipmentPatrolQualityFlag[];
  message: string;
}

export interface EquipmentPatrolSourceStatus {
  available: true;
  mode: EquipmentPatrolExecutionResponse['sourceMode'];
  stale: boolean;
  monthMatches: boolean;
  sourceUpdatedAt: string | null;
  generatedAt: string;
  sourceUrl: string;
  totalSourceRecords: number;
  warnings: string[];
  referenceDate: string | null;
  referenceDateSource: 'sourceUpdatedAt' | 'dashboard.referenceDate';
}

export interface EquipmentPatrolExecutionView {
  month: string;
  kpis: EquipmentPatrolExecutionKpis;
  buildings: EquipmentPatrolBuildingSummary[];
  anomalies: EquipmentPatrolAnomaly[];
  buildingDevices: Record<EquipmentPatrolBuilding, PatrolDeviceRow[]>;
  executions: EquipmentPatrolExecutionGroup[];
  sourceStatus: EquipmentPatrolSourceStatus;
}

interface PlanSlot {
  building: EquipmentPatrolBuilding;
  device: RotationPlanDevice;
  window: RotationPlanWindow;
  groups: EquipmentPatrolExecutionGroup[];
}

const TIME_QUALITY_FLAGS: ReadonlySet<EquipmentPatrolQualityFlag> = new Set([
  'plan_time_invalid',
  'actual_time_invalid',
  'actual_time_drift',
]);

const roundOne = (value: number): number => Math.round(value * 10) / 10;

function validDateOnly(value: string | null): string | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;

  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
    ? null
    : date;
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(
    value.includes('T') ? value : value.replace(' ', 'T'),
  );
  return Number.isNaN(parsed) ? null : parsed;
}

function pickTime(
  values: Array<string | null>,
  direction: 'earliest' | 'latest',
): string | null {
  const dated = values
    .map((value, index) => ({ value, index, time: timestamp(value) }))
    .filter(
      (item): item is { value: string; index: number; time: number } =>
        item.value !== null && item.time !== null,
    );
  if (dated.length === 0) return values.find((value) => value !== null) ?? null;

  dated.sort((left, right) =>
    direction === 'earliest'
      ? left.time - right.time || left.index - right.index
      : right.time - left.time || right.index - left.index,
  );
  return dated[0].value;
}

function recordRank(record: EquipmentPatrolExecutionRecord): number {
  const completion = record.actualEnd ? 3 : record.status === '结束' ? 2 : 0;
  return completion * 10_000_000_000_000 + (timestamp(record.updatedAt) ?? 0);
}

function groupRecordDate(
  record: EquipmentPatrolExecutionRecord,
): string | null {
  return (
    validDateOnly(record.planStart) ??
    validDateOnly(record.actualStart) ??
    validDateOnly(record.actualEnd) ??
    validDateOnly(record.updatedAt)
  );
}

function mergeExecutionRecords(
  records: EquipmentPatrolExecutionRecord[],
  building: EquipmentPatrolBuilding | null,
  category: EquipmentPatrolCategory | null,
  date: string | null,
  id: string,
): EquipmentPatrolExecutionGroup {
  const representative = [...records].sort(
    (left, right) => recordRank(right) - recordRank(left),
  )[0];
  const actualEnd = pickTime(
    records.map((record) => record.actualEnd),
    'latest',
  );
  const completed =
    actualEnd !== null || records.some((record) => record.status === '结束');

  return {
    id,
    building,
    category,
    date,
    recordIds: records.map((record) => record.recordId),
    title: representative.title,
    equipment: representative.equipment,
    specialty: representative.specialty,
    planStart: pickTime(
      records.map((record) => record.planStart),
      'earliest',
    ),
    planEnd: pickTime(
      records.map((record) => record.planEnd),
      'latest',
    ),
    actualStart: pickTime(
      records.map((record) => record.actualStart),
      'earliest',
    ),
    actualEnd,
    updatedAt: pickTime(
      records.map((record) => record.updatedAt),
      'latest',
    ),
    progress: representative.progress,
    status: completed ? '结束' : representative.status,
    content: representative.content,
    completed,
    nonPlanned: records.some((record) => record.nonPlanned),
    qualityFlags: Array.from(
      new Set(records.flatMap((record) => record.qualityFlags)),
    ),
    matchedWindowId: null,
    matchedDeviceId: null,
  };
}

function groupExecutions(
  records: readonly EquipmentPatrolExecutionRecord[],
): EquipmentPatrolExecutionGroup[] {
  const groups = new Map<
    string,
    {
      building: EquipmentPatrolBuilding | null;
      category: EquipmentPatrolCategory | null;
      date: string | null;
      records: EquipmentPatrolExecutionRecord[];
    }
  >();

  records.forEach((sourceRecord) => {
    const record: EquipmentPatrolExecutionRecord = {
      ...sourceRecord,
      categories: [...sourceRecord.categories],
      qualityFlags: [...sourceRecord.qualityFlags],
    };
    const date = groupRecordDate(record);
    const categories: Array<EquipmentPatrolCategory | null> =
      record.categories.length > 0
        ? Array.from(new Set(record.categories))
        : [null];

    categories.forEach((category) => {
      const key = [
        record.building ?? 'building-missing',
        category ?? 'category-missing',
        date ?? `date-missing:${record.recordId}`,
      ].join('|');
      const existing = groups.get(key);
      if (existing) {
        existing.records.push(record);
      } else {
        groups.set(key, {
          building: record.building,
          category,
          date,
          records: [record],
        });
      }
    });
  });

  return Array.from(groups.entries()).map(([id, group]) =>
    mergeExecutionRecords(
      group.records,
      group.building,
      group.category,
      group.date,
      id,
    ),
  );
}

function monthEnd(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const day = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

function resolveReferenceDate(
  dashboard: PatrolMonthDashboard,
  response: EquipmentPatrolExecutionResponse,
): {
  referenceDate: string | null;
  source: EquipmentPatrolSourceStatus['referenceDateSource'];
} {
  const sourceDate = validDateOnly(response.sourceUpdatedAt);
  if (!sourceDate) {
    return {
      referenceDate: validDateOnly(dashboard.referenceDate),
      source: 'dashboard.referenceDate',
    };
  }

  const sourceMonth = sourceDate.slice(0, 7);
  if (dashboard.month < sourceMonth) {
    return {
      referenceDate: monthEnd(dashboard.month),
      source: 'sourceUpdatedAt',
    };
  }
  if (dashboard.month === sourceMonth) {
    return { referenceDate: sourceDate, source: 'sourceUpdatedAt' };
  }
  return { referenceDate: null, source: 'sourceUpdatedAt' };
}

function createPlanSlots(month: string): PlanSlot[] {
  return EQUIPMENT_PATROL_BUILDINGS.flatMap((building) =>
    EQUIPMENT_ROTATION_PLAN_2026.devices.flatMap((device) =>
      device.plannedWindows
        .filter((window) => window.startDate.startsWith(month))
        .map((window) => ({ building, device, window, groups: [] })),
    ),
  );
}

function dateInWindow(
  date: string | null,
  window: RotationPlanWindow,
): boolean {
  return date !== null && window.startDate <= date && date <= window.endDate;
}

function matchExecutions(
  slots: PlanSlot[],
  groups: EquipmentPatrolExecutionGroup[],
): void {
  groups.forEach((group) => {
    if (group.nonPlanned || !group.building || !group.category) return;

    const planDate = validDateOnly(group.planStart);
    const actualDate = validDateOnly(group.actualStart);
    const slot = slots.find(
      (candidate) =>
        candidate.building === group.building &&
        candidate.device.name === group.category &&
        (dateInWindow(planDate, candidate.window) ||
          dateInWindow(actualDate, candidate.window)),
    );
    if (!slot) return;

    slot.groups.push(group);
    group.matchedWindowId = slot.window.id;
    group.matchedDeviceId = slot.device.id;
  });
}

function isCovered(slot: PlanSlot): boolean {
  return slot.groups.length > 0;
}

function isCompleted(slot: PlanSlot): boolean {
  return slot.groups.some((group) => group.completed);
}

function isDue(slot: PlanSlot, referenceDate: string | null): boolean {
  return referenceDate !== null && slot.window.startDate <= referenceDate;
}

function isOverdue(slot: PlanSlot, referenceDate: string | null): boolean {
  return (
    referenceDate !== null &&
    slot.window.endDate < referenceDate &&
    !isCovered(slot)
  );
}

function isFuture(slot: PlanSlot, referenceDate: string | null): boolean {
  return referenceDate === null || slot.window.startDate > referenceDate;
}

function cloneDevice(device: PatrolDeviceRow): PatrolDeviceRow {
  return {
    ...device,
    notes: [...device.notes],
    days: device.days.map((day) => ({ ...day })),
  };
}

function decorateDevices(
  dashboard: PatrolMonthDashboard,
  building: EquipmentPatrolBuilding,
  slots: PlanSlot[],
): PatrolDeviceRow[] {
  const buildingSlots = slots.filter((slot) => slot.building === building);

  return dashboard.devices.map((sourceDevice) => {
    const device = cloneDevice(sourceDevice);
    const deviceSlots = buildingSlots.filter(
      (slot) => slot.device.id === device.id,
    );
    const completed = deviceSlots.filter(isCompleted).length;
    const partial = deviceSlots.filter(
      (slot) => isCovered(slot) && !isCompleted(slot),
    ).length;
    const missedSlots = deviceSlots.filter((slot) => isOverdue(slot, null));

    return {
      ...device,
      planned: deviceSlots.length,
      executed: completed,
      partial,
      missed: missedSlots.length,
      lastMissedDate:
        missedSlots
          .map((slot) => slot.window.endDate)
          .sort()
          .at(-1) ?? null,
      days: device.days.map((day) => {
        if (!day.windowId || day.status === 'adjusted') return { ...day };
        const slot = deviceSlots.find(
          (candidate) => candidate.window.id === day.windowId,
        );
        if (!slot) return { ...day };
        const group =
          slot.groups.find((item) => item.completed) ?? slot.groups[0];
        const executionNote = group
          ? `${building}执行：${group.status}；计划 ${group.planStart ?? '--'} 至 ${group.planEnd ?? '--'}；实际 ${group.actualStart ?? '--'} 至 ${group.actualEnd ?? '--'}${group.nonPlanned ? '；源记录标记为非计划性' : ''}`
          : undefined;
        const note =
          [day.note, executionNote].filter(Boolean).join('；') || undefined;
        if (isCompleted(slot)) return { ...day, status: 'completed', note };
        if (isCovered(slot)) return { ...day, status: 'partial', note };
        return { ...day };
      }),
    };
  });
}

function minutesBetween(
  start: string | null,
  end: string | null,
): number | null {
  const startTime = timestamp(start);
  const endTime = timestamp(end);
  return startTime === null || endTime === null
    ? null
    : Math.round((endTime - startTime) / 60_000);
}

function groupAnomaly(
  group: EquipmentPatrolExecutionGroup,
  type: EquipmentPatrolAnomalyType,
  priority: EquipmentPatrolAnomaly['priority'],
  message: string,
  minutes: number | null = null,
): EquipmentPatrolAnomaly {
  return {
    id: `${type}:${group.id}`,
    type,
    priority,
    building: group.building,
    category: group.category,
    deviceId: group.matchedDeviceId,
    windowId: group.matchedWindowId,
    date: group.date,
    minutes,
    recordIds: [...group.recordIds],
    qualityFlags: [...group.qualityFlags],
    message,
  };
}

function collectAnomalies(
  slots: PlanSlot[],
  groups: EquipmentPatrolExecutionGroup[],
  referenceDate: string | null,
): EquipmentPatrolAnomaly[] {
  const anomalies: EquipmentPatrolAnomaly[] = [];

  groups.forEach((group) => {
    const timeFlags = group.qualityFlags.filter((flag) =>
      TIME_QUALITY_FLAGS.has(flag),
    );
    if (timeFlags.length > 0) {
      anomalies.push(
        groupAnomaly(group, 'time_quality', 1, '执行时间数据质量异常'),
      );
    }
  });

  slots
    .filter((slot) => isOverdue(slot, referenceDate))
    .forEach((slot) => {
      anomalies.push({
        id: `overdue_uncovered:${slot.building}:${slot.window.id}`,
        type: 'overdue_uncovered',
        priority: 2,
        building: slot.building,
        category: slot.device.name as EquipmentPatrolCategory,
        deviceId: slot.device.id,
        windowId: slot.window.id,
        date: slot.window.endDate,
        minutes: null,
        recordIds: [],
        qualityFlags: [],
        message: `${slot.device.name}计划窗口已逾期且无执行覆盖`,
      });
    });

  groups
    .filter((group) => !group.completed)
    .forEach((group) => {
      anomalies.push(groupAnomaly(group, 'unfinished', 3, '执行记录尚未结束'));
    });

  groups
    .filter((group) => group.nonPlanned || group.matchedWindowId === null)
    .forEach((group) => {
      anomalies.push(
        groupAnomaly(
          group,
          'outside_plan_window',
          4,
          group.nonPlanned ? '非计划执行记录' : '执行记录未落入计划窗口',
        ),
      );
    });

  groups.forEach((group) => {
    const startDelay = minutesBetween(group.planStart, group.actualStart);
    if (startDelay !== null && startDelay > 30) {
      anomalies.push(
        groupAnomaly(
          group,
          'start_delay',
          5,
          '实际开始晚于计划开始超过30分钟',
          startDelay,
        ),
      );
    }

    const endOvertime = minutesBetween(group.planEnd, group.actualEnd);
    if (endOvertime !== null && endOvertime > 30) {
      anomalies.push(
        groupAnomaly(
          group,
          'end_overtime',
          6,
          '实际结束晚于计划结束超过30分钟',
          endOvertime,
        ),
      );
    }
  });

  return anomalies
    .map((anomaly, index) => ({ anomaly, index }))
    .sort(
      (left, right) =>
        left.anomaly.priority - right.anomaly.priority ||
        left.index - right.index,
    )
    .map(({ anomaly }) => ({
      ...anomaly,
      recordIds: [...anomaly.recordIds],
      qualityFlags: [...anomaly.qualityFlags],
    }));
}

export function buildEquipmentPatrolExecutionView(
  dashboard: PatrolMonthDashboard,
  response: EquipmentPatrolExecutionResponse,
): EquipmentPatrolExecutionView {
  const { referenceDate, source } = resolveReferenceDate(dashboard, response);
  const groups = groupExecutions(response.records);
  const slots = createPlanSlots(dashboard.month);
  matchExecutions(slots, groups);

  const anomalies = collectAnomalies(slots, groups, referenceDate);
  const buildingDevices = {} as Record<
    EquipmentPatrolBuilding,
    PatrolDeviceRow[]
  >;
  const buildings = EQUIPMENT_PATROL_BUILDINGS.map((building) => {
    const buildingSlots = slots.filter((slot) => slot.building === building);
    const dueSlots = buildingSlots.filter((slot) => isDue(slot, referenceDate));
    const covered = dueSlots.filter(isCovered).length;
    const buildingAnomalies = anomalies.filter(
      (anomaly) => anomaly.building === building,
    );
    const outOfPlan = groups.filter(
      (group) =>
        group.building === building &&
        (group.nonPlanned || group.matchedWindowId === null),
    ).length;

    buildingDevices[building] = decorateDevices(dashboard, building, slots).map(
      (device) => {
        const deviceSlots = buildingSlots.filter(
          (slot) => slot.device.id === device.id,
        );
        const missedSlots = deviceSlots.filter((slot) =>
          isOverdue(slot, referenceDate),
        );
        return {
          ...device,
          missed: missedSlots.length,
          lastMissedDate:
            missedSlots
              .map((slot) => slot.window.endDate)
              .sort()
              .at(-1) ?? null,
          days: device.days.map((day) => {
            if (!day.windowId || day.status === 'adjusted') return { ...day };
            const slot = deviceSlots.find(
              (candidate) => candidate.window.id === day.windowId,
            );
            return slot && isOverdue(slot, referenceDate)
              ? {
                  ...day,
                  status: 'missed',
                  note: `${building}：计划窗口 ${slot.window.startDate} 至 ${slot.window.endDate} 已逾期，未找到完成记录`,
                }
              : { ...day };
          }),
        };
      },
    );

    return {
      building,
      monthPlan: buildingSlots.length,
      due: dueSlots.length,
      covered,
      overdue: buildingSlots.filter((slot) => isOverdue(slot, referenceDate))
        .length,
      active: buildingSlots.filter(
        (slot) => isCovered(slot) && !isCompleted(slot),
      ).length,
      future: buildingSlots.filter((slot) => isFuture(slot, referenceDate))
        .length,
      outOfPlan,
      coverageRate:
        dueSlots.length === 0
          ? null
          : roundOne((covered / dueSlots.length) * 100),
      anomalyCount: buildingAnomalies.length,
    };
  });

  return {
    month: dashboard.month,
    kpis: {
      monthPlanPerBuilding: slots.length / EQUIPMENT_PATROL_BUILDINGS.length,
      due: buildings.reduce((total, building) => total + building.due, 0),
      covered: buildings.reduce(
        (total, building) => total + building.covered,
        0,
      ),
      deviations: anomalies.length,
      compliantBuildings: buildings.filter(
        (building) => building.anomalyCount === 0,
      ).length,
    },
    buildings,
    anomalies,
    buildingDevices,
    executions: groups.map((group) => ({
      ...group,
      recordIds: [...group.recordIds],
      qualityFlags: [...group.qualityFlags],
    })),
    sourceStatus: {
      available: true,
      mode: response.sourceMode,
      stale: response.stale,
      monthMatches: response.month === dashboard.month,
      sourceUpdatedAt: response.sourceUpdatedAt,
      generatedAt: response.generatedAt,
      sourceUrl: response.sourceUrl,
      totalSourceRecords: response.totalSourceRecords,
      warnings: [...response.warnings],
      referenceDate,
      referenceDateSource: source,
    },
  };
}
