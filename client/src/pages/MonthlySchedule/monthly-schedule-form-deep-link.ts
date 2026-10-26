export type MonthlyScheduleFormDeepLink = 'leave' | 'overtime';

const MONTHLY_SCHEDULE_FORM_QUERY_KEY = 'form';
const MONTHLY_SCHEDULE_LEAVE_FORM_PATH = '/monthly-schedule/apply/leave';
const MONTHLY_SCHEDULE_OVERTIME_FORM_PATH = '/monthly-schedule/apply/overtime';

export function readMonthlyScheduleFormDeepLink(
  searchParams: URLSearchParams,
  pathname = '',
): MonthlyScheduleFormDeepLink | null {
  const normalizedPathname = normalizePathname(pathname);
  if (normalizedPathname === MONTHLY_SCHEDULE_LEAVE_FORM_PATH) return 'leave';
  if (normalizedPathname === MONTHLY_SCHEDULE_OVERTIME_FORM_PATH) {
    return 'overtime';
  }

  const value = searchParams.get(MONTHLY_SCHEDULE_FORM_QUERY_KEY);
  return value === 'leave' || value === 'overtime' ? value : null;
}

function normalizePathname(pathname: string): string {
  const normalized = String(pathname || '').toLowerCase().replace(/\/+$/g, '');
  return normalized || '/';
}
