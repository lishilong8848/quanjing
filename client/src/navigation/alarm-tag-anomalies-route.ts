export const ALARM_TAG_ANOMALIES_DIRECT_PATH = '/alarm-tag-anomalies';

export function isAlarmTagAnomaliesDirectPath(pathname: string): boolean {
  return String(pathname || '/').toLowerCase().replace(/\/+$/g, '') === ALARM_TAG_ANOMALIES_DIRECT_PATH;
}

export function readAlarmTagAnomaliesDate(search: string): string | null {
  const values = new URLSearchParams(search).getAll('date');
  if (values.length !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(values[0])) return null;
  const timestamp = Date.parse(`${values[0]}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== values[0]) return null;
  return values[0];
}
