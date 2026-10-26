import type { MonthlyScheduleResponse } from '@shared/api.interface';

type ReadSchedules = (year: number, month: number, forceRefresh?: boolean) => Promise<MonthlyScheduleResponse>;
type ScheduleReadScope = {
  identity: string;
  cache: Map<string, { schedules: MonthlyScheduleResponse['schedules']; fetchedAt: number }>;
  inFlight: Map<string, Promise<MonthlyScheduleResponse>>;
  read: ReadSchedules;
};

export function createScheduleReadCache(getMonthlySchedules: ReadSchedules) {
  let active: ScheduleReadScope | undefined;
  return (identity: string): ScheduleReadScope => {
    if (active?.identity === identity) return active;
    const monthlyScheduleReadInFlight = new Map<string, Promise<MonthlyScheduleResponse>>();
    function getMonthlySchedulesWithInFlightDeduplication(year: number, month: number, forceRefresh = false) {
      if (forceRefresh) return getMonthlySchedules(year, month, true);
      const monthKey = `${year}-${month}`;
      const existingRequest = monthlyScheduleReadInFlight.get(monthKey);
      if (existingRequest) return existingRequest;
      const request = getMonthlySchedules(year, month).finally(() => {
        if (monthlyScheduleReadInFlight.get(monthKey) === request) {
          monthlyScheduleReadInFlight.delete(monthKey);
        }
      });
      monthlyScheduleReadInFlight.set(monthKey, request);
      return request;
    }
    active = { identity, cache: new Map(), inFlight: monthlyScheduleReadInFlight, read: getMonthlySchedulesWithInFlightDeduplication };
    return active;
  };
}
