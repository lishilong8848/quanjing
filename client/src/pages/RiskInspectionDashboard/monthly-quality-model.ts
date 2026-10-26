import type {
  AliMonthlyQualityDataset,
  AliMonthlyQualityIssue,
  AliMonthlyQualityRating,
} from '@shared/risk-inspection.interface';

const GRADE_ORDER = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-'];
const ATTENTION_GRADE_INDEX = GRADE_ORDER.indexOf('B-');

export type MonthlyQualityFilters = {
  year?: string;
  month: string;
  item: 'all' | string;
  building?: string;
};

export type MonthlyQualityMovement = 'up' | 'same' | 'down' | 'none';

export type MonthlyQualitySelection =
  | { kind: 'summary' }
  | { kind: 'attention' }
  | { kind: 'building'; building: string }
  | { kind: 'month'; month: string }
  | { kind: 'matrix'; building: string; item: string }
  | { kind: 'rating'; month: string; building: string };

export interface MonthlyQualityBuildingView {
  building: string;
  grade: string;
  previousGrade: string;
  cumulativeAPlus: number | null;
  movement: MonthlyQualityMovement;
  issueCount: number;
  primaryItem: string;
  covered: boolean;
  benchmark: boolean;
  attention: boolean;
}

export interface MonthlyQualityTrendPoint {
  month: string;
  total: number;
  items: Array<{ item: string; value: number }>;
}

export interface MonthlyQualityMatrixCell {
  item: string;
  value: number;
}

export interface MonthlyQualityMatrixRow {
  building: string;
  covered: boolean;
  cells: MonthlyQualityMatrixCell[];
}

export interface MonthlyQualityRatingMatrixCell {
  building: string;
  grade: string;
  benchmark: boolean;
  attention: boolean;
}

export interface MonthlyQualityRatingMatrixRow {
  year: string;
  month: string;
  cells: MonthlyQualityRatingMatrixCell[];
}

export interface MonthlyQualityBuildingTrendPoint {
  year: string;
  month: string;
  grade: string;
  gradeRank: number | null;
}

export interface AliMonthlyQualityViewModel {
  selectedYear: string;
  selectedMonth: string;
  selectedBuilding: string;
  selectedItem: 'all' | string;
  summary: {
    monthlyIssues: number;
    coveredBuildings: number;
    ratedBuildings: number;
    benchmarkBuildings: string[];
    attentionBuildings: string[];
    movement: { up: number; same: number; down: number };
    previousMonthDelta: number | null;
  };
  gradeDistribution: Array<{
    grade: string;
    value: number;
    buildings: string[];
  }>;
  buildings: MonthlyQualityBuildingView[];
  trend: MonthlyQualityTrendPoint[];
  matrix: MonthlyQualityMatrixRow[];
  ratingMatrix: MonthlyQualityRatingMatrixRow[];
  buildingTrend: MonthlyQualityBuildingTrendPoint[];
  items: string[];
  issues: AliMonthlyQualityIssue[];
  filteredIssues: AliMonthlyQualityIssue[];
  sourceStates: AliMonthlyQualityDataset['sources'];
  evidenceYearAmbiguous: boolean;
}

export function buildAliMonthlyQualityView(
  dataset: AliMonthlyQualityDataset,
  filters: MonthlyQualityFilters,
): AliMonthlyQualityViewModel {
  const ratedYears = unique(
    dataset.ratings
      .filter(({ grade }) => Boolean(normalizeGrade(grade)))
      .map(({ year }) => year),
  ).sort((left, right) => yearNumber(right) - yearNumber(left));
  const selectedYear =
    filters.year && ratedYears.includes(filters.year)
      ? filters.year
      : ratedYears[0] || dataset.options.years[0] || '';
  const yearRatings = dataset.ratings.filter(
    ({ year, grade }) =>
      year === selectedYear && Boolean(normalizeGrade(grade)),
  );
  const ratedMonths = unique(yearRatings.map(({ month }) => month)).sort(
    (left, right) => monthNumber(left) - monthNumber(right),
  );
  const selectedMonth = ratedMonths.includes(filters.month)
    ? filters.month
    : selectLatestCompleteMonth(yearRatings, ratedMonths) ||
      dataset.options.months[0] ||
      '';
  const selectedItem = dataset.options.items.includes(filters.item)
    ? filters.item
    : 'all';
  const evidenceYearAmbiguous = ratedYears.length > 1;
  const filteredIssues = evidenceYearAmbiguous
    ? []
    : dataset.issues.filter(
        ({ item }) => selectedItem === 'all' || item === selectedItem,
      );
  const issues = filteredIssues
    .filter(({ month }) => month === selectedMonth)
    .sort((left, right) => compareIssues(left, right, dataset));
  const ratingsByKey = new Map(
    dataset.ratings.map((rating) => [ratingKey(rating), rating]),
  );
  const selectedRatings = yearRatings.filter(
    ({ month }) => month === selectedMonth,
  );
  const selectedBuilding = selectBuilding(
    filters.building,
    selectedRatings,
    dataset.options.buildings,
  );
  const selectedMonthIndex = ratedMonths.indexOf(selectedMonth);
  const previousMonth =
    selectedMonthIndex > 0 ? ratedMonths[selectedMonthIndex - 1] : '';
  const buildingCounts = countBy(issues, ({ building }) => building);
  const itemCountsByBuilding = countNestedBy(
    issues,
    ({ building }) => building,
    ({ item }) => item,
  );
  const buildings = dataset.options.buildings.map((building) => {
    const currentRating = ratingsByKey.get(
      `${selectedYear}::${selectedMonth}::${building}`,
    );
    const previousRating = previousMonth
      ? ratingsByKey.get(`${selectedYear}::${previousMonth}::${building}`)
      : undefined;
    const grade = normalizeGrade(currentRating?.grade || '');
    const previousGrade = normalizeGrade(previousRating?.grade || '');
    const issueCount = buildingCounts.get(building) || 0;

    return {
      building,
      grade,
      previousGrade,
      cumulativeAPlus: currentRating?.cumulativeAPlus ?? null,
      movement: compareGradeMovement(grade, previousGrade),
      issueCount,
      primaryItem: selectPrimaryItem(
        itemCountsByBuilding.get(building),
        dataset.options.items,
      ),
      covered: issueCount > 0,
      benchmark: grade === 'A+',
      attention: isAttentionGrade(grade),
    };
  });
  const previousMonthTotal = previousMonth
    ? filteredIssues.filter(({ month }) => month === previousMonth).length
    : null;
  const visibleItems =
    selectedItem === 'all' ? dataset.options.items : [selectedItem];

  return {
    selectedYear,
    selectedMonth,
    selectedBuilding,
    selectedItem,
    summary: {
      monthlyIssues: issues.length,
      coveredBuildings: buildings.filter(({ covered }) => covered).length,
      ratedBuildings: buildings.filter(({ grade }) => Boolean(grade)).length,
      benchmarkBuildings: buildings
        .filter(({ benchmark }) => benchmark)
        .map(({ building }) => building),
      attentionBuildings: buildings
        .filter(({ attention }) => attention)
        .map(({ building }) => building),
      movement: {
        up: buildings.filter(({ movement }) => movement === 'up').length,
        same: buildings.filter(({ movement }) => movement === 'same').length,
        down: buildings.filter(({ movement }) => movement === 'down').length,
      },
      previousMonthDelta:
        previousMonthTotal === null ? null : issues.length - previousMonthTotal,
    },
    gradeDistribution: buildGradeDistribution(buildings),
    buildings,
    trend: dataset.options.months
      .slice(0, 5)
      .reverse()
      .map((month) => {
        const monthIssues = filteredIssues.filter(
          (issue) => issue.month === month,
        );
        const itemCounts = countBy(monthIssues, ({ item }) => item);
        return {
          month,
          total: monthIssues.length,
          items: visibleItems.map((item) => ({
            item,
            value: itemCounts.get(item) || 0,
          })),
        };
      }),
    matrix: buildings.map(({ building, covered }) => ({
      building,
      covered,
      cells: visibleItems.map((item) => ({
        item,
        value: issues.filter(
          (issue) => issue.building === building && issue.item === item,
        ).length,
      })),
    })),
    ratingMatrix: ratedMonths.map((month) => ({
      year: selectedYear,
      month,
      cells: dataset.options.buildings.map((building) => {
        const grade = normalizeGrade(
          ratingsByKey.get(`${selectedYear}::${month}::${building}`)?.grade ||
            '',
        );
        return {
          building,
          grade,
          benchmark: grade === 'A+',
          attention: isAttentionGrade(grade),
        };
      }),
    })),
    buildingTrend: ratedMonths.map((month) => {
      const grade = normalizeGrade(
        ratingsByKey.get(`${selectedYear}::${month}::${selectedBuilding}`)
          ?.grade || '',
      );
      return {
        year: selectedYear,
        month,
        grade,
        gradeRank: getGradeRank(grade),
      };
    }),
    items: visibleItems,
    issues,
    filteredIssues,
    sourceStates: dataset.sources,
    evidenceYearAmbiguous,
  };
}

export function selectMonthlyQualityIssues(
  view: AliMonthlyQualityViewModel,
  selection: MonthlyQualitySelection,
): AliMonthlyQualityIssue[] {
  if (selection.kind === 'month') {
    return view.filteredIssues.filter(({ month }) => month === selection.month);
  }
  if (selection.kind === 'building') {
    return view.issues.filter(
      ({ building }) => building === selection.building,
    );
  }
  if (selection.kind === 'matrix') {
    return view.issues.filter(
      ({ building, item }) =>
        building === selection.building && item === selection.item,
    );
  }
  if (selection.kind === 'rating') {
    return view.filteredIssues.filter(
      ({ month, building }) =>
        month === selection.month && building === selection.building,
    );
  }
  if (selection.kind === 'attention') {
    const buildings = new Set(view.summary.attentionBuildings);
    return view.issues.filter(({ building }) => buildings.has(building));
  }
  return view.issues;
}

export function getMonthlyQualityGradeRank(grade: string): number | null {
  return getGradeRank(normalizeGrade(grade));
}

function buildGradeDistribution(
  buildings: MonthlyQualityBuildingView[],
): AliMonthlyQualityViewModel['gradeDistribution'] {
  const grades = unique(
    buildings.map(({ grade }) => grade).filter(Boolean),
  ).sort(compareGrades);
  return grades.map((grade) => {
    const matched = buildings.filter((building) => building.grade === grade);
    return {
      grade,
      value: matched.length,
      buildings: matched.map(({ building }) => building),
    };
  });
}

function selectLatestCompleteMonth(
  ratings: AliMonthlyQualityRating[],
  months: string[],
): string {
  const coverage = countBy(ratings, ({ month }) => month);
  return (
    [...months].sort(
      (left, right) =>
        (coverage.get(right) || 0) - (coverage.get(left) || 0) ||
        monthNumber(right) - monthNumber(left),
    )[0] || ''
  );
}

function selectBuilding(
  requested: string | undefined,
  ratings: AliMonthlyQualityRating[],
  buildingOrder: string[],
): string {
  if (requested && buildingOrder.includes(requested)) return requested;
  const benchmarks = new Set(
    ratings
      .filter(({ grade }) => normalizeGrade(grade) === 'A+')
      .map(({ building }) => building),
  );
  return (
    buildingOrder.find((building) => benchmarks.has(building)) ||
    buildingOrder.find((building) =>
      ratings.some((rating) => rating.building === building),
    ) ||
    buildingOrder[0] ||
    ''
  );
}

function compareGradeMovement(
  current: string,
  previous: string,
): MonthlyQualityMovement {
  const currentRank = getGradeRank(current);
  const previousRank = getGradeRank(previous);
  if (currentRank === null || previousRank === null) return 'none';
  if (currentRank < previousRank) return 'up';
  if (currentRank > previousRank) return 'down';
  return 'same';
}

function isAttentionGrade(grade: string): boolean {
  const rank = getGradeRank(grade);
  return rank !== null && rank >= ATTENTION_GRADE_INDEX;
}

function normalizeGrade(value: string): string {
  return value.trim().toUpperCase();
}

function getGradeRank(grade: string): number | null {
  const rank = GRADE_ORDER.indexOf(grade);
  return rank === -1 ? null : rank;
}

function compareGrades(left: string, right: string): number {
  const leftRank = getGradeRank(left);
  const rightRank = getGradeRank(right);
  if (leftRank === null && rightRank === null) {
    return left.localeCompare(right, 'zh-CN');
  }
  if (leftRank === null) return 1;
  if (rightRank === null) return -1;
  return leftRank - rightRank;
}

function ratingKey(rating: AliMonthlyQualityRating): string {
  return `${rating.year}::${rating.month}::${rating.building}`;
}

function selectPrimaryItem(
  counts: Map<string, number> | undefined,
  itemOrder: string[],
): string {
  if (!counts?.size) return '暂无问题记录';
  return [...counts.entries()].sort(
    (left, right) =>
      right[1] - left[1] ||
      itemOrder.indexOf(left[0]) - itemOrder.indexOf(right[0]) ||
      left[0].localeCompare(right[0], 'zh-CN'),
  )[0][0];
}

function countBy<T>(
  items: readonly T[],
  getKey: (item: T) => string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = getKey(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function countNestedBy<T>(
  items: readonly T[],
  getOuterKey: (item: T) => string,
  getInnerKey: (item: T) => string,
): Map<string, Map<string, number>> {
  const counts = new Map<string, Map<string, number>>();
  for (const item of items) {
    const outerKey = getOuterKey(item);
    const innerKey = getInnerKey(item);
    const inner = counts.get(outerKey) || new Map<string, number>();
    inner.set(innerKey, (inner.get(innerKey) || 0) + 1);
    counts.set(outerKey, inner);
  }
  return counts;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function monthNumber(value: string): number {
  const match = value.match(/\d{1,2}/u);
  return match ? Number(match[0]) : 0;
}

function yearNumber(value: string): number {
  const match = value.match(/\d{4}/u);
  return match ? Number(match[0]) : 0;
}

function compareIssues(
  left: AliMonthlyQualityIssue,
  right: AliMonthlyQualityIssue,
  dataset: AliMonthlyQualityDataset,
): number {
  return (
    dataset.options.buildings.indexOf(left.building) -
      dataset.options.buildings.indexOf(right.building) ||
    dataset.options.items.indexOf(left.item) -
      dataset.options.items.indexOf(right.item) ||
    left.id.localeCompare(right.id)
  );
}
