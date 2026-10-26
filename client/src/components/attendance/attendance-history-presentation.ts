import type {
  AttendanceHistoryBuildingRanking,
  AttendanceHistoryCategory,
  AttendanceHistoryItem,
  AttendanceHistoryPersonRanking,
} from '@shared/attendance-history.interface';

export type AttendanceHistoryGroupMode = 'building' | 'category';

export interface AttendanceHistoryGroup {
  key: string;
  label: string;
  count: number;
  items: AttendanceHistoryItem[];
}

const BUILDING_ORDER = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'];
const CATEGORY_ORDER: AttendanceHistoryCategory[] = [
  'late',
  'early',
  'missing',
  'corrected',
  'other',
];

export type AttendanceHistoryCategoryFilter = 'all' | AttendanceHistoryCategory;
export interface AttendanceHistoryDrilldown {
  kind: 'person' | 'building';
  value: string;
}

export function getDefaultAttendanceHistoryRange(now = new Date()): {
  from: string;
  through: string;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const through = `${value.year}-${value.month}-${value.day}`;
  return { from: `${value.year}-${value.month}-01`, through };
}

export function groupAttendanceHistoryItems(
  items: readonly AttendanceHistoryItem[],
  mode: AttendanceHistoryGroupMode,
): AttendanceHistoryGroup[] {
  const groups = new Map<string, AttendanceHistoryItem[]>();
  items.forEach((item) => {
    const key = mode === 'building' ? item.building : item.category;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  });
  return [...groups]
    .map(([key, groupItems]) => ({
      key,
      label: mode === 'building' ? key : groupItems[0]?.categoryLabel || key,
      count: groupItems.length,
      items: groupItems,
    }))
    .sort((left, right) =>
      mode === 'building'
        ? compareBuildings(left.key, right.key)
        : CATEGORY_ORDER.indexOf(left.key as AttendanceHistoryCategory) -
          CATEGORY_ORDER.indexOf(right.key as AttendanceHistoryCategory),
    );
}

export function filterAttendanceHistoryItems(
  items: readonly AttendanceHistoryItem[],
  category: AttendanceHistoryCategoryFilter,
  drilldown?: AttendanceHistoryDrilldown | null,
): AttendanceHistoryItem[] {
  return items.filter(
    (item) =>
      (category === 'all' || item.category === category) &&
      (!drilldown ||
        (drilldown.kind === 'person' ? item.name : item.building) ===
          drilldown.value),
  );
}

export function buildAttendanceHistoryRankings(
  items: readonly AttendanceHistoryItem[],
): {
  people: AttendanceHistoryPersonRanking[];
  buildings: AttendanceHistoryBuildingRanking[];
} {
  const people = new Map<
    string,
    { name: string; buildings: Set<string>; count: number }
  >();
  const buildings = new Map<
    string,
    { building: string; names: Set<string>; count: number }
  >();
  items.forEach((item) => {
    const person = people.get(item.name) || {
      name: item.name,
      buildings: new Set<string>(),
      count: 0,
    };
    person.buildings.add(item.building);
    person.count += 1;
    people.set(item.name, person);
    const building = buildings.get(item.building) || {
      building: item.building,
      names: new Set<string>(),
      count: 0,
    };
    building.names.add(item.name);
    building.count += 1;
    buildings.set(item.building, building);
  });
  return {
    people: [...people.values()]
      .map((item) => ({
        name: item.name,
        buildings: [...item.buildings].sort(compareBuildings),
        count: item.count,
      }))
      .sort(
        (left, right) =>
          right.count - left.count ||
          left.name.localeCompare(right.name, 'zh-CN'),
      ),
    buildings: [...buildings.values()]
      .map((item) => ({
        building: item.building,
        peopleCount: item.names.size,
        count: item.count,
      }))
      .sort(
        (left, right) =>
          right.count - left.count ||
          compareBuildings(left.building, right.building),
      ),
  };
}

function compareBuildings(left: string, right: string): number {
  const leftIndex = BUILDING_ORDER.indexOf(left);
  const rightIndex = BUILDING_ORDER.indexOf(right);
  if (leftIndex >= 0 || rightIndex >= 0) {
    return (
      (leftIndex < 0 ? BUILDING_ORDER.length : leftIndex) -
      (rightIndex < 0 ? BUILDING_ORDER.length : rightIndex)
    );
  }
  return left.localeCompare(right, 'zh-CN');
}
