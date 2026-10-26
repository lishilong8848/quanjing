import type { MonthlyAlarm } from '@shared/monthly-operations-alarms.interface';
const alarmDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
export function repeatAlarms(records: MonthlyAlarm[]) {
  const groups = new Map<string, MonthlyAlarm[]>();
  for (const r of records) {
    const group = groups.get(r.repeatKey) ?? [];
    group.push(r);
    groups.set(r.repeatKey, group);
  }
  return [...groups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => {
      const sorted = rows
        .slice()
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
      return {
        key,
        rows: sorted,
        latest: sorted[0],
        count: rows.length,
        pending: rows.filter((r) => r.process === '未处理' || !r.confirmedAt)
          .length,
      };
    })
    .sort(
      (a, b) =>
        b.count - a.count ||
        b.latest.occurredAt.localeCompare(a.latest.occurredAt),
    );
}
export function alarmDate(value: string | null) {
  return value ? alarmDateFormatter.format(new Date(value)) : '—';
}
export function alarmDetails(r: MonthlyAlarm) {
  return [
    ['等级', r.level],
    ['楼栋', r.building],
    ['产生时间', alarmDate(r.occurredAt)],
    ['恢复时间', alarmDate(r.recoveredAt)],
    ['确认时间', alarmDate(r.confirmedAt)],
    ['处理状态', r.process],
    ['恢复状态', r.recovery],
    ['监控对象', r.object],
    ['具体位置', r.location],
    ['预期分类', r.expected || '未打标'],
    ['原因分类', r.category],
    ['恢复耗时', r.minutes === null ? '—' : r.minutes.toFixed(1) + ' 分钟'],
    ...r.detail.map((d) => [d.label, d.value]),
  ].map(([label, value]) => ({ label, value }));
}
export function alarmGroups(
  records: MonthlyAlarm[],
  field: 'recovery' | 'process' | 'expected' | 'category' | 'level',
) {
  const counts = new Map<string, number>();
  for (const r of records) {
    const name = r[field] || '未打标';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}
