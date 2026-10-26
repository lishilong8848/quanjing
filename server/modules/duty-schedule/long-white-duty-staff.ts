import type { LongWhiteDutyStaffByBuilding } from '../../../shared/api.interface';
import { normalizeDutyStaffDisplayName } from '../../../shared/duty-staff-name';

export interface LongWhiteDutyStaffSourceRow {
  building: string;
  buildingName: string;
  staff: string[];
  leaveStaff: string[];
  substituteStaff: string[];
  vacancySubstituteStaff?: string[];
  travelStaff?: string[];
}

export function buildLongWhiteDutyStaffByBuilding(
  rows: LongWhiteDutyStaffSourceRow[],
  buildingOrder: string[],
): LongWhiteDutyStaffByBuilding[] {
  const byBuilding = new Map<
    string,
    { buildingName: string; staff: Set<string> }
  >();

  const getOrCreateGroup = (row: LongWhiteDutyStaffSourceRow) => {
    const building = row.building.trim();
    if (!building) {
      return null;
    }

    const group = byBuilding.get(building) || {
      buildingName: row.buildingName || building,
      staff: new Set<string>(),
    };
    byBuilding.set(building, group);
    return { building, group };
  };

  rows.forEach((row) => {
    const target = getOrCreateGroup(row);
    if (!target) {
      return;
    }

    row.staff
      .map(normalizeStaffName)
      .filter(Boolean)
      .forEach((name) => target.group.staff.add(name));
  });

  rows.forEach((row) => {
    const target = getOrCreateGroup(row);
    if (!target) {
      return;
    }

    row.leaveStaff
      .map(normalizeStaffName)
      .filter(Boolean)
      .forEach((name) => removeStaffFromBuildings(byBuilding, name));

    [...row.substituteStaff, ...(row.vacancySubstituteStaff || [])]
      .map(normalizeStaffName)
      .filter(Boolean)
      .forEach((name) => {
        removeStaffFromBuildings(byBuilding, name, target.building);
        target.group.staff.add(name);
      });

    (row.travelStaff || [])
      .map(normalizeStaffName)
      .filter(Boolean)
      .forEach((name) => removeStaffFromBuildings(byBuilding, name));
  });

  const orderRank = new Map(
    buildingOrder.map((building, index) => [building, index]),
  );
  return [...byBuilding.entries()]
    .sort(([a], [b]) => (orderRank.get(a) ?? 999) - (orderRank.get(b) ?? 999))
    .map(([building, value]) => ({
      building,
      buildingName: value.buildingName,
      staff: [...value.staff],
    }))
    .filter((building) => building.staff.length > 0);
}

export function hasMissingLongWhiteDutyBuildings(
  rows: LongWhiteDutyStaffSourceRow[],
  expectedBuildings: string[],
): boolean {
  return (
    getExpectedBuildingCoverage(rows, expectedBuildings) <
    getDistinctExpectedBuildings(expectedBuildings).length
  );
}

export function preferMoreCompleteLongWhiteDutyRows(
  primaryRows: LongWhiteDutyStaffSourceRow[],
  fallbackRows: LongWhiteDutyStaffSourceRow[],
  expectedBuildings: string[],
): LongWhiteDutyStaffSourceRow[] {
  const primaryCoverage = getExpectedBuildingCoverage(
    primaryRows,
    expectedBuildings,
  );
  const fallbackCoverage = getExpectedBuildingCoverage(
    fallbackRows,
    expectedBuildings,
  );

  return fallbackCoverage > primaryCoverage ? fallbackRows : primaryRows;
}

function normalizeStaffName(value: string): string {
  return normalizeDutyStaffDisplayName(value);
}

function getExpectedBuildingCoverage(
  rows: LongWhiteDutyStaffSourceRow[],
  expectedBuildings: string[],
): number {
  const expected = new Set(getDistinctExpectedBuildings(expectedBuildings));
  const covered = new Set<string>();

  rows.forEach((row) => {
    const building = row.building.trim();
    if (expected.has(building)) {
      covered.add(building);
    }
  });

  return covered.size;
}

function getDistinctExpectedBuildings(expectedBuildings: string[]): string[] {
  return [
    ...new Set(
      expectedBuildings.map((building) => building.trim()).filter(Boolean),
    ),
  ];
}

function compareStaffName(value: string): string {
  return normalizeStaffName(value).replace(/\s+/g, '');
}

function removeStaffFromBuildings(
  byBuilding: Map<string, { buildingName: string; staff: Set<string> }>,
  name: string,
  exceptBuilding?: string,
): void {
  const compareName = compareStaffName(name);
  if (!compareName) {
    return;
  }

  byBuilding.forEach((group, building) => {
    if (exceptBuilding && building === exceptBuilding) {
      return;
    }
    [...group.staff].forEach((currentName) => {
      if (compareStaffName(currentName) === compareName) {
        group.staff.delete(currentName);
      }
    });
  });
}
