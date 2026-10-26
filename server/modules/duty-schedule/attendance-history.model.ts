import type {
  AttendanceHistoryBuildingRanking,
  AttendanceHistoryCategory,
  AttendanceHistoryCategoryBreakdown,
  AttendanceHistoryItem,
  AttendanceHistoryPersonRanking,
  AttendanceHistoryResponse,
} from '@shared/attendance-history.interface';
import type {
  AttendanceAnomaly,
  AttendanceExpectation,
} from './attendance-automation.rules';

const BUILDING_ORDER = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'];
const CATEGORY_ORDER: AttendanceHistoryCategory[] = [
  'late',
  'early',
  'missing',
  'corrected',
  'other',
];
const CATEGORY_LABELS: Record<AttendanceHistoryCategory, string> = {
  late: '迟到',
  early: '早退',
  missing: '未打卡且未补卡',
  corrected: '补卡后正常',
  other: '其他异常',
};

interface AttendanceHistorySource {
  startDate: string;
  endDate: string;
  fetchedAt: string;
  checkedCount: number;
  anomalies: readonly (AttendanceAnomaly & { businessDate?: string })[];
  corrected?: readonly (AttendanceExpectation & { businessDate?: string })[];
}

export function buildAttendanceHistoryResponse(
  source: AttendanceHistorySource,
): AttendanceHistoryResponse {
  const anomalyItems = source.anomalies.map(toHistoryItem);
  const correctedItems = (source.corrected || []).map(toCorrectedHistoryItem);
  const items = [...anomalyItems, ...correctedItems].sort(compareHistoryItems);
  const people = new Set(anomalyItems.map((item) => personKey(item)));
  const buildings = new Set(anomalyItems.map((item) => item.building));

  return {
    startDate: source.startDate,
    endDate: source.endDate,
    fetchedAt: source.fetchedAt,
    checkedCount: source.checkedCount,
    anomalyCount: anomalyItems.length,
    abnormalPeople: people.size,
    affectedBuildings: buildings.size,
    correctedCount: correctedItems.length,
    items,
    categoryBreakdown: buildCategoryBreakdown(items),
    personRanking: buildPersonRanking(items),
    buildingRanking: buildBuildingRanking(items),
  };
}

function toCorrectedHistoryItem(
  expectation: AttendanceExpectation & { businessDate?: string },
): AttendanceHistoryItem {
  return {
    key: expectation.key,
    date: expectation.expectedAt.slice(0, 10),
    businessDate: expectation.businessDate,
    building: expectation.building,
    name: expectation.name,
    shiftLabel: expectation.shiftLabel,
    direction: expectation.direction,
    expectedAt: expectation.expectedAt,
    reason: '补卡后正常',
    category: 'corrected',
    categoryLabel: CATEGORY_LABELS.corrected,
  };
}

export function attendanceHistoryCategoryOf(
  reason: AttendanceAnomaly['reason'],
): AttendanceHistoryCategory {
  if (reason === '迟到') return 'late';
  if (reason === '早退') return 'early';
  if (['未打卡', '未查询到有效打卡', '旷工'].includes(reason)) {
    return 'missing';
  }
  return 'other';
}

function toHistoryItem(
  anomaly: AttendanceAnomaly & { businessDate?: string },
): AttendanceHistoryItem {
  const category = attendanceHistoryCategoryOf(anomaly.reason);
  return {
    key: anomaly.key,
    date: anomaly.expectedAt.slice(0, 10),
    businessDate: anomaly.businessDate,
    building: anomaly.building,
    name: anomaly.name,
    shiftLabel: anomaly.shiftLabel,
    direction: anomaly.direction,
    expectedAt: anomaly.expectedAt,
    reason: anomaly.reason,
    category,
    categoryLabel: CATEGORY_LABELS[category],
  };
}

function buildCategoryBreakdown(
  items: readonly AttendanceHistoryItem[],
): AttendanceHistoryCategoryBreakdown[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    count: items.filter((item) => item.category === category).length,
  }));
}

function buildPersonRanking(
  items: readonly AttendanceHistoryItem[],
): AttendanceHistoryPersonRanking[] {
  const counts = new Map<
    string,
    { name: string; buildings: Set<string>; count: number }
  >();
  items.forEach((item) => {
    const current = counts.get(item.name) ?? {
      name: item.name,
      buildings: new Set<string>(),
      count: 0,
    };
    current.buildings.add(item.building);
    current.count += 1;
    counts.set(item.name, current);
  });
  return [...counts.values()]
    .map((item) => ({
      name: item.name,
      buildings: [...item.buildings].sort(compareBuildings),
      count: item.count,
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.name.localeCompare(right.name, 'zh-CN'),
    );
}

function buildBuildingRanking(
  items: readonly AttendanceHistoryItem[],
): AttendanceHistoryBuildingRanking[] {
  const counts = new Map<
    string,
    { building: string; people: Set<string>; count: number }
  >();
  items.forEach((item) => {
    const current = counts.get(item.building) ?? {
      building: item.building,
      people: new Set<string>(),
      count: 0,
    };
    current.people.add(item.name);
    current.count += 1;
    counts.set(item.building, current);
  });
  return [...counts.values()]
    .map((item) => ({
      building: item.building,
      peopleCount: item.people.size,
      count: item.count,
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        compareBuildings(left.building, right.building),
    );
}

function compareHistoryItems(
  left: AttendanceHistoryItem,
  right: AttendanceHistoryItem,
): number {
  return (
    left.expectedAt.localeCompare(right.expectedAt) ||
    compareBuildings(left.building, right.building) ||
    left.name.localeCompare(right.name, 'zh-CN') ||
    left.key.localeCompare(right.key)
  );
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

function personKey(item: AttendanceHistoryItem): string {
  return `${item.building}\u0000${item.name}`;
}
