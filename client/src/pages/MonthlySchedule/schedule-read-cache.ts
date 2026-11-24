import type { MonthlyScheduleResponse } from '@shared/api.interface';

type ReadSchedules = (year: number, month: number, forceRefresh?: boolean) => Promise<MonthlyScheduleResponse>;
type ScheduleReadScope = {
  identity: string;
  snapshotRevision: string | null;
  cache: Map<string, { schedules: MonthlyScheduleResponse['schedules']; fetchedAt: number }>;
  inFlight: Map<string, Promise<MonthlyScheduleResponse>>;
  read: ReadSchedules;
};

export function readScheduleOnce<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const request = read().finally(() => {
    if (inFlight.get(key) === request) inFlight.delete(key);
  });
  inFlight.set(key, request);
  return request;
}

export function createScheduleReadCache(getMonthlySchedules: ReadSchedules) {
  let active: ScheduleReadScope | undefined;
  return (identity: string): ScheduleReadScope => {
    if (active?.identity === identity) return active;
    const monthlyScheduleReadInFlight = new Map<string, Promise<MonthlyScheduleResponse>>();
    function getMonthlySchedulesWithInFlightDeduplication(year: number, month: number, forceRefresh = false) {
      if (forceRefresh) return getMonthlySchedules(year, month, true);
      const monthKey = `${year}-${month}`;
      return readScheduleOnce(monthlyScheduleReadInFlight, monthKey, () => getMonthlySchedules(year, month));
    }
    active = { identity, snapshotRevision: null, cache: new Map(), inFlight: monthlyScheduleReadInFlight, read: getMonthlySchedulesWithInFlightDeduplication };
    return active;
  };
}
