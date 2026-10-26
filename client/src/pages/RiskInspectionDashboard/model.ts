import type {
  AliRiskInspectionDashboard,
  AliRiskIssue,
  AliRiskLevel,
  AliRiskStatus,
  CrossInspectionDashboard,
  CrossInspectionIssue,
} from '@shared/risk-inspection.interface';

export interface RiskDashboardFilters {
  specialty: 'all' | string;
  level: 'all' | AliRiskLevel;
  status: 'all' | AliRiskStatus;
}

export const DEFAULT_RISK_FILTERS: RiskDashboardFilters = {
  specialty: 'all',
  level: 'all',
  status: 'all',
};

export type AliMetricListKey =
  | 'historyTotal'
  | 'unclosed'
  | 'overdueUnclosed'
  | 'monthlyAdded'
  | 'rectificationRate'
  | 'monthlyClosed';

export type AliChartIssueScope =
  | { kind: 'severity'; level: AliRiskLevel }
  | { kind: 'status'; status: AliRiskStatus }
  | { kind: 'specialty'; specialty: string }
  | { kind: 'trend'; periodStart: string };

export type CrossMetricListKey = keyof CrossInspectionDashboard['summary'];

export function selectAliMetricIssues(
  dashboard: AliRiskInspectionDashboard,
  key: AliMetricListKey,
): AliRiskIssue[] {
  if (key === 'unclosed') return dashboard.unresolvedIssues.slice();

  return dashboard.issues.filter((issue) => {
    switch (key) {
      case 'historyTotal':
        return true;
      case 'overdueUnclosed':
        return issue.status !== 'completed' && issue.overdueDays > 0;
      case 'monthlyAdded':
        return issue.discoveredAt?.startsWith(dashboard.month);
      case 'rectificationRate':
        return issue.status === 'completed' || issue.status === 'rectifying';
      case 'monthlyClosed':
        return issue.closedAt?.startsWith(dashboard.month);
    }
  });
}

export function selectAliChartIssues(
  dashboard: AliRiskInspectionDashboard,
  scope: AliChartIssueScope,
): AliRiskIssue[] {
  if (scope.kind === 'trend') {
    const period = resolveAliTrendPeriod(scope.periodStart, dashboard.month);
    if (!period) return [];

    return dashboard.issues.filter(({ discoveredAt }) => {
      const date = discoveredAt?.slice(0, 10);
      return Boolean(date && date >= period.start && date <= period.end);
    });
  }

  return dashboard.issues.filter((issue) => {
    switch (scope.kind) {
      case 'severity':
        return issue.level === scope.level;
      case 'status':
        return (
          issue.status === scope.status &&
          issue.discoveredAt?.startsWith(dashboard.month)
        );
      case 'specialty':
        return issue.specialty === scope.specialty;
    }
  });
}

export function selectCrossMetricIssues(
  dashboard: CrossInspectionDashboard,
  key: CrossMetricListKey,
): CrossInspectionIssue[] {
  switch (key) {
    case 'historyTotal':
    case 'closureRate':
      return dashboard.issues.slice();
    case 'monthlyTotal':
      return dashboard.issues.filter(
        ({ month }) => month === dashboard.selectedMonth,
      );
    case 'legacyTotal':
      return dashboard.legacyIssues.slice();
  }
}

export function filterAliMetricIssues(
  items: readonly AliRiskIssue[],
  query: string,
): AliRiskIssue[] {
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');

  if (!normalizedQuery) {
    return items.slice();
  }

  return items.filter((issue) =>
    [
      issue.description,
      issue.building,
      issue.specialty,
      issue.owner,
      issue.levelLabel,
      issue.statusLabel,
      issue.discoveredAt,
      issue.dueAt,
      issue.closedAt,
    ].some((value) =>
      String(value || '')
        .toLocaleLowerCase('zh-CN')
        .includes(normalizedQuery),
    ),
  );
}

export function filterCrossMetricIssues(
  items: readonly CrossInspectionIssue[],
  query: string,
): CrossInspectionIssue[] {
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');

  if (!normalizedQuery) {
    return items.slice();
  }

  return items.filter((issue) =>
    [
      issue.building,
      issue.month,
      issue.tag,
      issue.type,
      issue.description,
      issue.owner,
      issue.rectification,
    ].some((value) =>
      String(value || '')
        .toLocaleLowerCase('zh-CN')
        .includes(normalizedQuery),
    ),
  );
}

export function getAliRectificationStats(items: readonly AliRiskIssue[]): {
  completed: number;
  eligible: number;
  rate: number;
} {
  const completed = items.filter(({ status }) => status === 'completed').length;
  const eligible = items.filter(
    ({ status }) => status === 'completed' || status === 'rectifying',
  ).length;

  return {
    completed,
    eligible,
    rate: eligible === 0 ? 0 : Math.round((completed / eligible) * 1_000) / 10,
  };
}

export function getRiskDashboardView(
  dashboard: AliRiskInspectionDashboard,
  filters: RiskDashboardFilters,
): AliRiskInspectionDashboard {
  return {
    ...dashboard,
    unresolvedIssues: dashboard.unresolvedIssues.filter(
      (issue) =>
        (filters.specialty === 'all' ||
          issue.specialty === filters.specialty) &&
        (filters.level === 'all' || issue.level === filters.level) &&
        (filters.status === 'all' || issue.status === filters.status),
    ),
  };
}

export function paginateRiskIssues(
  items: readonly AliRiskIssue[],
  page: number,
  pageSize: number,
): AliRiskIssue[] {
  const safePage = Math.max(1, Math.floor(page));
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const start = (safePage - 1) * safePageSize;
  return items
    .slice(start, start + safePageSize)
    .map((issue) => ({ ...issue }));
}

function resolveAliTrendPeriod(
  label: string,
  dashboardMonth: string,
): { start: string; end: string } | null {
  const labelMatch = label.trim().match(/^(\d{1,2})\/(\d{1,2})$/u);
  const monthMatch = dashboardMonth.match(/^(\d{4})-(\d{2})$/u);
  if (!labelMatch || !monthMatch) return null;

  const dashboardYear = Number(monthMatch[1]);
  const dashboardMonthNumber = Number(monthMatch[2]);
  const periodMonth = Number(labelMatch[1]);
  const periodDay = Number(labelMatch[2]);
  let periodYear = dashboardYear;
  if (periodMonth - dashboardMonthNumber > 6) periodYear -= 1;
  if (dashboardMonthNumber - periodMonth > 6) periodYear += 1;

  const start = new Date(Date.UTC(periodYear, periodMonth - 1, periodDay));
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);

  const formatDate = (date: Date) =>
    `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(
      2,
      '0',
    )}-${String(date.getUTCDate()).padStart(2, '0')}`;

  return {
    start: formatDate(start),
    end: formatDate(end),
  };
}
