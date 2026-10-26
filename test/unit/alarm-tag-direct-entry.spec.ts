import { isAlarmTagAnomaliesDirectPath, readAlarmTagAnomaliesDate } from '../../client/src/navigation/alarm-tag-anomalies-route';

it('matches only the lightweight alarm tag route', () => {
  expect(isAlarmTagAnomaliesDirectPath('/alarm-tag-anomalies/')).toBe(true);
  expect(isAlarmTagAnomaliesDirectPath('/monthly-schedule')).toBe(false);
  expect(isAlarmTagAnomaliesDirectPath('/alarm-tag-anomalies/other')).toBe(false);
});

it('reads a fixed date without falling back to seven days', () => {
  expect(readAlarmTagAnomaliesDate('?date=2026-09-30')).toBe('2026-09-30');
  expect(readAlarmTagAnomaliesDate('?date=2026-02-30')).toBeNull();
  expect(readAlarmTagAnomaliesDate('?date=2026-09-30&date=2026-09-29')).toBeNull();
  expect(readAlarmTagAnomaliesDate('')).toBeNull();
});
