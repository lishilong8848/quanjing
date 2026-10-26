import type {
  CrossBuildingRectification,
  CrossInspectionIssue,
} from '@shared/risk-inspection.interface';

export interface CrossLedgerFilters {
  building: 'all' | string;
  month: 'all' | string;
  type: 'all' | string;
  query: string;
}

export function filterCrossLedgerIssues(
  issues: readonly CrossInspectionIssue[],
  filters: CrossLedgerFilters,
): CrossInspectionIssue[] {
  const query = filters.query.trim();

  return issues.filter(
    (issue) =>
      (filters.building === 'all' || issue.building === filters.building) &&
      (filters.month === 'all' || issue.month === filters.month) &&
      (filters.type === 'all' || issue.type === filters.type) &&
      `${issue.description}${issue.owner}`.includes(query),
  );
}

export function getPaginationWindow(
  currentPage: number,
  totalPages: number,
): number[] {
  const safeTotalPages = Math.max(1, Math.floor(totalPages));
  const safeCurrentPage = Math.min(
    safeTotalPages,
    Math.max(1, Math.floor(currentPage)),
  );
  const windowSize = Math.min(safeTotalPages, 5);
  const centeredStart = safeCurrentPage - Math.floor(windowSize / 2);
  const start = Math.min(
    Math.max(1, centeredStart),
    safeTotalPages - windowSize + 1,
  );

  return Array.from({ length: windowSize }, (_, index) => start + index);
}

export function getDefaultCrossOverviewMonth(
  months: readonly string[],
  selectedMonth: string,
  now = new Date(),
): string {
  const monthPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
  })
    .formatToParts(now)
    .find(({ type }) => type === 'month')?.value;
  const currentMonth = Number(monthPart);
  const previousMonth = `${
    Number.isFinite(currentMonth) && currentMonth > 1 ? currentMonth - 1 : 12
  }月`;

  if (months.includes(previousMonth)) return previousMonth;
  if (months.includes(selectedMonth)) return selectedMonth;
  return months[0] || previousMonth;
}

export function buildCrossBuildingRectification(
  issues: readonly CrossInspectionIssue[],
  month: string,
): CrossBuildingRectification[] {
  const groups = new Map<string, CrossInspectionIssue[]>();
  for (const issue of issues) {
    if (issue.month !== month || !issue.building) continue;
    const current = groups.get(issue.building) || [];
    current.push(issue);
    groups.set(issue.building, current);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => compareCrossBuildings(left, right))
    .map(([building, buildingIssues]) => {
      const issueCount = buildingIssues.length;
      const completedCount = buildingIssues.filter(
        ({ status }) => status === 'closed',
      ).length;
      return {
        building,
        issueCount,
        completedCount,
        rate:
          issueCount === 0
            ? 0
            : Math.round((completedCount / issueCount) * 1_000) / 10,
      };
    });
}

function compareCrossBuildings(left: string, right: string): number {
  const order = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'];
  const leftIndex = order.indexOf(left);
  const rightIndex = order.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) {
    return (
      (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
      (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
    );
  }
  return left.localeCompare(right, 'zh-CN');
}
