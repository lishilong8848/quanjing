import type {
  MonthlyScheduleLeaveAssignment,
  TodayLeaveStaffByBuilding,
  TravelStaffDetail,
} from '@shared/api.interface';
import { normalizeDutyStaffDisplayName } from '@shared/duty-staff-name';

export interface DutyStaffActualUpdate {
  recordId: string;
  dutyStaffActual: string[];
}

interface ScheduleWithDutyStaffActual {
  recordId: string;
  dutyStaffActual: string[];
}

interface ScheduleWithPersonnelMovement {
  scheduleDate: string | null;
  building: string;
  buildingText: string;
  shift: string;
  shiftText: string;
  team: string;
  teamText: string;
  leaveStaff: string[];
  substituteStaff: string[];
  leaveAssignments?: MonthlyScheduleLeaveAssignment[];
}

export interface PersonnelMovementLeaveSubstitutionGroup {
  shift: 'white' | 'night' | 'long_white';
  shiftLabel: string;
  leaveStaff: string[];
  substituteStaff: string[];
  assignments?: MonthlyScheduleLeaveAssignment[];
}

export function applyDutyStaffActualUpdates<T extends ScheduleWithDutyStaffActual>(
  schedules: T[],
  updates: DutyStaffActualUpdate[],
): T[] {
  const updatesByRecordId = new Map(
    updates
      .filter((update) => Boolean(update.recordId))
      .map((update) => [update.recordId, update.dutyStaffActual]),
  );
  if (updatesByRecordId.size === 0) {
    return schedules;
  }

  let changed = false;
  const nextSchedules = schedules.map((schedule) => {
    const nextDutyStaffActual = updatesByRecordId.get(schedule.recordId);
    if (!nextDutyStaffActual) {
      return schedule;
    }
    if (
      schedule.dutyStaffActual.length === nextDutyStaffActual.length &&
      schedule.dutyStaffActual.every((name, index) => name === nextDutyStaffActual[index])
    ) {
      return schedule;
    }

    changed = true;
    return {
      ...schedule,
      dutyStaffActual: [...nextDutyStaffActual],
    };
  });

  return changed ? nextSchedules : schedules;
}

export interface PersonnelMovementBuilding {
  building: string;
  buildingName: string;
  leaveStaff: string[];
  substituteStaff: string[];
  temporarySubstituteStaff: string[];
  temporarySubstitutes: {
    shift: string;
    shiftLabel: string;
    staff: string[];
  }[];
  travelStaff: string[];
}

interface BuildPersonnelMovementOverviewOptions {
  leaveData: TodayLeaveStaffByBuilding[];
  travelDetails: TravelStaffDetail[];
  buildingOrder: string[];
  buildingNameMap: Record<string, string>;
}

interface MutablePersonnelMovementBuilding {
  building: string;
  buildingName: string;
  leaveStaff: Set<string>;
  substituteStaff: Set<string>;
  temporarySubstituteStaff: Set<string>;
  temporarySubstitutesByShift: Map<string, {
    shift: string;
    shiftLabel: string;
    staff: Set<string>;
  }>;
  travelStaff: Set<string>;
}

function normalizeBuildingKey(value: string): string {
  const text = value.trim().toUpperCase();
  if (!text) return '';
  if (text.includes('110')) return 'station_110';
  if (text.includes('A楼') || text.includes('A栋') || text === 'A' || text.includes('BUILDING_A')) return 'building_a';
  if (text.includes('B楼') || text.includes('B栋') || text === 'B' || text.includes('BUILDING_B')) return 'building_b';
  if (text.includes('C楼') || text.includes('C栋') || text === 'C' || text.includes('BUILDING_C')) return 'building_c';
  if (text.includes('D楼') || text.includes('D栋') || text === 'D' || text.includes('BUILDING_D')) return 'building_d';
  if (text.includes('E楼') || text.includes('E栋') || text === 'E' || text.includes('BUILDING_E')) return 'building_e';
  if (text.includes('H楼') || text.includes('H栋') || text === 'H' || text.includes('BUILDING_H')) return 'building_h';
  return value;
}

function resolvePersonnelMovementShift(
  schedule: ScheduleWithPersonnelMovement,
): PersonnelMovementLeaveSubstitutionGroup['shift'] | null {
  const text = [
    schedule.shift,
    schedule.shiftText,
    schedule.team,
    schedule.teamText,
  ].filter(Boolean).join(' ');

  if (/long_white|longwhite|长白/i.test(text)) return 'long_white';
  if (/night|夜/i.test(text)) return 'night';
  if (/white|白/i.test(text)) return 'white';
  return null;
}

function splitPersonnelMovementNames(names: string[]): string[] {
  return names
    .flatMap((name) => String(name || '').split(/[\s、,，;；/]+/))
    .map(normalizeDutyStaffDisplayName)
    .filter(Boolean);
}

export function buildLeaveSubstitutionGroupsByBuilding(
  schedules: ScheduleWithPersonnelMovement[],
  date: string,
): Map<string, PersonnelMovementLeaveSubstitutionGroup[]> {
  const shiftLabels: Record<
    PersonnelMovementLeaveSubstitutionGroup['shift'],
    string
  > = {
    white: '白',
    night: '夜',
    long_white: '长白',
  };
  const shiftOrder: PersonnelMovementLeaveSubstitutionGroup['shift'][] = [
    'white',
    'night',
    'long_white',
  ];
  const groupsByBuilding = new Map<string, Map<
    PersonnelMovementLeaveSubstitutionGroup['shift'],
    {
      leaveStaff: Set<string>;
      substituteStaff: Set<string>;
      assignments: Map<string, MonthlyScheduleLeaveAssignment>;
    }
  >>();

  schedules.forEach((schedule) => {
    const leaveStaff = splitPersonnelMovementNames(schedule.leaveStaff);
    if (schedule.scheduleDate !== date || leaveStaff.length === 0) {
      return;
    }

    const shift = resolvePersonnelMovementShift(schedule);
    const building =
      normalizeBuildingKey(schedule.building) ||
      normalizeBuildingKey(schedule.buildingText);
    if (!shift || !building) {
      return;
    }

    const groups = groupsByBuilding.get(building) || new Map();
    const group = groups.get(shift) || {
      leaveStaff: new Set<string>(),
      substituteStaff: new Set<string>(),
      assignments: new Map<string, MonthlyScheduleLeaveAssignment>(),
    };
    leaveStaff.forEach((name) => group.leaveStaff.add(name));
    splitPersonnelMovementNames(schedule.substituteStaff)
      .forEach((name) => group.substituteStaff.add(name));
    (schedule.leaveAssignments || []).forEach((assignment) => {
      const leaveStaffName = normalizeDutyStaffDisplayName(
        assignment.leaveStaffName,
      );
      if (!leaveStaffName) return;
      const normalizedAssignment: MonthlyScheduleLeaveAssignment = {
        ...assignment,
        leaveStaffName,
        substituteStaff: splitPersonnelMovementNames(
          assignment.substituteStaff,
        ),
      };
      group.assignments.set(
        `${assignment.requestRecordId}:${leaveStaffName}`,
        normalizedAssignment,
      );
    });
    groups.set(shift, group);
    groupsByBuilding.set(building, groups);
  });

  return new Map(
    [...groupsByBuilding.entries()].map(([building, groups]) => [
      building,
      shiftOrder
        .filter((shift) => groups.has(shift))
        .map((shift) => {
          const group = groups.get(shift)!;
          const assignments = [...group.assignments.values()];
          return {
            shift,
            shiftLabel: shiftLabels[shift],
            leaveStaff: [...group.leaveStaff],
            substituteStaff: [...group.substituteStaff],
            ...(assignments.length > 0 ? { assignments } : {}),
          };
        }),
    ]),
  );
}

function getOrCreateBuilding(
  buildings: Map<string, MutablePersonnelMovementBuilding>,
  building: string,
  buildingName: string,
  buildingNameMap: Record<string, string>,
): MutablePersonnelMovementBuilding {
  const key = normalizeBuildingKey(building) || normalizeBuildingKey(buildingName);
  const stableKey = key || building || buildingName;
  const existing = buildings.get(stableKey);
  if (existing) {
    return existing;
  }

  const created: MutablePersonnelMovementBuilding = {
    building: stableKey,
    buildingName: buildingNameMap[stableKey] || buildingName || stableKey,
    leaveStaff: new Set<string>(),
    substituteStaff: new Set<string>(),
    temporarySubstituteStaff: new Set<string>(),
    temporarySubstitutesByShift: new Map(),
    travelStaff: new Set<string>(),
  };
  buildings.set(stableKey, created);
  return created;
}

function addNames(target: Set<string>, names: string[]): void {
  names
    .map(normalizeDutyStaffDisplayName)
    .filter(Boolean)
    .forEach((name) => target.add(name));
}

function addTemporarySubstitutes(
  building: MutablePersonnelMovementBuilding,
  groups: NonNullable<TodayLeaveStaffByBuilding['temporarySubstitutes']>,
): void {
  groups.forEach((group) => {
    const shiftKey = group.shift || group.shiftLabel || 'temporary';
    const existing = building.temporarySubstitutesByShift.get(shiftKey);
    const target = existing || {
      shift: group.shift,
      shiftLabel: group.shiftLabel,
      staff: new Set<string>(),
    };
    addNames(target.staff, group.staff);
    if (!existing) {
      building.temporarySubstitutesByShift.set(shiftKey, target);
    }
  });
}

export function buildPersonnelMovementOverview({
  leaveData,
  travelDetails,
  buildingOrder,
  buildingNameMap,
}: BuildPersonnelMovementOverviewOptions): PersonnelMovementBuilding[] {
  const buildings = new Map<string, MutablePersonnelMovementBuilding>();

  leaveData.forEach((item) => {
    const building = getOrCreateBuilding(buildings, item.building, item.buildingName, buildingNameMap);
    addNames(building.leaveStaff, item.leaveStaff);
    addNames(building.substituteStaff, item.substituteStaff);
    addNames(building.temporarySubstituteStaff, item.temporarySubstituteStaff || []);
    addTemporarySubstitutes(building, item.temporarySubstitutes || []);
  });

  travelDetails.forEach((detail) => {
    detail.records.forEach((record) => {
      const building = getOrCreateBuilding(
        buildings,
        record.building,
        record.buildingText,
        buildingNameMap,
      );
      addNames(building.travelStaff, record.travelStaff);
    });
  });

  const orderRank = new Map(buildingOrder.map((building, index) => [building, index]));

  return [...buildings.values()]
    .filter((item) => (
      item.leaveStaff.size > 0 ||
      item.substituteStaff.size > 0 ||
      item.temporarySubstituteStaff.size > 0 ||
      item.travelStaff.size > 0
    ))
    .sort((a, b) => (
      (orderRank.get(a.building) ?? 999) - (orderRank.get(b.building) ?? 999) ||
      a.buildingName.localeCompare(b.buildingName, 'zh-CN')
    ))
    .map((item) => ({
      building: item.building,
      buildingName: item.buildingName,
      leaveStaff: [...item.leaveStaff],
      substituteStaff: [...item.substituteStaff],
      temporarySubstituteStaff: [...item.temporarySubstituteStaff],
      temporarySubstitutes: [...item.temporarySubstitutesByShift.values()].map((group) => ({
        shift: group.shift,
        shiftLabel: group.shiftLabel,
        staff: [...group.staff],
      })),
      travelStaff: [...item.travelStaff],
    }));
}
