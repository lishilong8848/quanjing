import { resolvePeriod } from '../../client/src/pages/MonthlyOperations/period';
import { createPeriodDemo } from '../../client/src/pages/MonthlyOperations/mock-data';
import { buildPeriodView } from '../../client/src/pages/MonthlyOperations/model';
import { createMonthlyQuery } from '../../client/src/pages/MonthlyOperations/query-cache';

describe('智舱月览过去30天', () => {
  it.each([
    ['2026-10-03', '2026-09-04'],
    ['2026-01-01', '2025-12-03'],
    ['2024-03-01', '2024-02-01'],
    ['2025-03-01', '2025-01-31'],
  ])('以 %s 为结束日，含今天恰好30个自然日', (end, start) => {
    const period = resolvePeriod({ mode: 'last30' }, end);
    expect(period).toMatchObject({
      start, end, asOf: end, days: 30, grain: 'day', partial: false,
      label: '过去30天', scope: '过去30天', noun: '近30天',
    });
    expect(period.rangeLabel).toBe(`${start} 至 ${end}`);
  });
  it('总览和下钻派生数据沿用相同的30天范围和楼栋', () => {
    const selection = { mode: 'last30' } as const;
    const period = resolvePeriod(selection);
    const view = buildPeriodView(createPeriodDemo(selection), selection, 'A楼');
    expect(view.period).toEqual(period);
    expect(view.records.every(row => row.building === 'A楼'
      && row.date >= period.start && row.date <= period.end)).toBe(true);
    expect(view.daily).toHaveLength(30);
  });
  it('两万条记录预取后可同步读取，重复点击不重新请求', async () => {
    const period = resolvePeriod({ mode: 'last30' });
    const range = { start: period.start, end: period.end };
    const data = { range, records: Array.from({ length: 20000 }, (_, id) => id) };
    const fetch = jest.fn().mockResolvedValue(data);
    const query = createMonthlyQuery<typeof data>({
      name: 'last30-large', fetch, storage: () => undefined,
      validate: (value, requested) => value.range.start === requested.start
        && value.range.end === requested.end && Array.isArray(value.records),
    });
    await query.load(range);
    expect(query.read(range).data).toBe(data);
    await Promise.all(Array.from({ length: 10 }, () => query.load(range)));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(query.read(range).loading).toBe(false);
  });
});
