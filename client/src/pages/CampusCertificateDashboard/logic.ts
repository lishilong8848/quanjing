import type { NonCompliantPerson } from './model';

const DASHBOARD_WIDTH = 1920;
const DASHBOARD_HEIGHT = 600;
const CERTIFICATE_PEOPLE_PAGE_SIZE = 4;

export type DashboardStatusKind = 'success' | 'warning' | 'error';

interface DashboardStatusPresentation {
  className: string;
  autoDismissMs: number | null;
}

interface PaginatedResult<T> {
  items: T[];
  page: number;
  pageCount: number;
  total: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

function getValidPreviousScale(previousScale = 1) {
  if (!Number.isFinite(previousScale) || previousScale <= 0) {
    return 1;
  }

  return Math.min(1, previousScale);
}

export function calculateDashboardScale(
  width: number,
  height: number,
  previousScale = 1,
): number {
  const fallbackScale = getValidPreviousScale(previousScale);

  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return fallbackScale;
  }

  return Math.min(1, width / DASHBOARD_WIDTH, height / DASHBOARD_HEIGHT);
}

export function formatDashboardTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function filterNonCompliantPeople(
  people: NonCompliantPerson[],
  query: string,
): NonCompliantPerson[] {
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');

  if (!normalizedQuery) {
    return people;
  }

  return people.filter((person) =>
    [
      person.building,
      person.name,
      person.position,
      person.missingCertificate,
    ].some((value) =>
      value.toLocaleLowerCase('zh-CN').includes(normalizedQuery),
    ),
  );
}

export function paginateNonCompliantPeople<T>(
  people: readonly T[],
  requestedPage: number,
  pageSize = CERTIFICATE_PEOPLE_PAGE_SIZE,
): PaginatedResult<T> {
  const safePageSize =
    Number.isInteger(pageSize) && pageSize > 0
      ? pageSize
      : CERTIFICATE_PEOPLE_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(people.length / safePageSize));
  const normalizedPage = Number.isFinite(requestedPage)
    ? Math.trunc(requestedPage)
    : 1;
  const page = Math.min(pageCount, Math.max(1, normalizedPage));
  const start = (page - 1) * safePageSize;

  return {
    items: people.slice(start, start + safePageSize),
    page,
    pageCount,
    total: people.length,
    hasPrevious: page > 1,
    hasNext: page < pageCount,
  };
}

export function getDashboardStatusPresentation(
  kind: DashboardStatusKind,
): DashboardStatusPresentation {
  return {
    className: `certificate-refresh-status-${kind}`,
    autoDismissMs: kind === 'success' ? 4000 : null,
  };
}
