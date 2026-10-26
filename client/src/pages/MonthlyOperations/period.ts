export const DEMO_AS_OF = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(Date.now());
export const DEMO_YEARS = [String(Number(DEMO_AS_OF.slice(0, 4)) - 1), DEMO_AS_OF.slice(0, 4)];
export const DEMO_START = `${DEMO_YEARS[0]}-01-01`;
export type PeriodSelection =
  | { mode: 'month'; month: string }
  | { mode: 'year'; year: string }
  | { mode: 'last30' }
  | { mode: 'range'; start: string; end: string };

export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}
export function monthEnd(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
}
export function monthsInRange(start: string, end: string): string[] {
  const result: string[] = [];
  const date = new Date(`${start.slice(0, 7)}-01T00:00:00Z`);
  while (date.toISOString().slice(0, 7) <= end.slice(0, 7)) {
    result.push(date.toISOString().slice(0, 7));
    date.setUTCMonth(date.getUTCMonth() + 1);
  }
  return result;
}
export const DEMO_MONTHS = monthsInRange(DEMO_START, DEMO_AS_OF);

export function rangeError(start: string, end: string): string | null {
  if (!isValidDate(start) || !isValidDate(end))
    return '请填写有效的开始和结束日期';
  if (start > end) return '开始日期不能晚于结束日期';
  if (start < DEMO_START || end > DEMO_AS_OF)
    return `可选日期范围为 ${DEMO_START} 至 ${DEMO_AS_OF}`;
  return null;
}
export function resolvePeriod(selection: PeriodSelection, today = DEMO_AS_OF) {
  let start: string, end: string;
  if (selection.mode === 'month') {
    if (!DEMO_MONTHS.includes(selection.month))
      throw new Error('月份超出可选范围');
    start = `${selection.month}-01`;
    end = monthEnd(selection.month);
  } else if (selection.mode === 'year') {
    if (!DEMO_YEARS.some((year) => year === selection.year))
      throw new Error('年份超出可选范围');
    start = `${selection.year}-01-01`;
    end = `${selection.year}-12-31`;
  } else if (selection.mode === 'last30') {
    if (!isValidDate(today)) throw new Error('统计日期无效');
    end = today;
    start = new Date(Date.parse(`${end}T00:00:00Z`) - 29 * 86400000)
      .toISOString().slice(0, 10);
  } else {
    const error = rangeError(selection.start, selection.end);
    if (error) throw new Error(error);
    ({ start, end } = selection);
  }
  const asOf = end < today ? end : today;
  const days =
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
      86400000 +
    1;
  const noun =
    selection.mode === 'month'
      ? '月度'
      : selection.mode === 'year'
        ? '年度'
        : selection.mode === 'last30'
          ? '近30天'
          : '周期';
  return {
    mode: selection.mode,
    start,
    end,
    asOf,
    days,
    noun,
    scope:
      selection.mode === 'month'
        ? '本月'
        : selection.mode === 'year'
          ? '本年'
          : selection.mode === 'last30'
            ? '过去30天'
            : '周期内',
    label:
      selection.mode === 'month'
        ? `${start.slice(0, 4)} 年 ${Number(start.slice(5, 7))} 月`
        : selection.mode === 'year'
          ? `${start.slice(0, 4)} 全年`
          : selection.mode === 'last30'
            ? '过去30天'
            : `${start} 至 ${end}`,
    rangeLabel: `${start} 至 ${end}`,
    key: `${selection.mode}-${start}-${end}`,
    grain:
      selection.mode === 'year' || days > 62
        ? ('month' as const)
        : ('day' as const),
    partial: asOf < end,
  };
}
export type ReportPeriod = ReturnType<typeof resolvePeriod>;
