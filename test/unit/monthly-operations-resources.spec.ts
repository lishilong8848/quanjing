import {
  mapMonthlyEnergy,
  mapMonthlyRacks,
  mapMonthlyRackHistory,
  mapMonthlyTemperature,
  mapMonthlyWater,
  resourceRange,
} from '../../server/modules/bitable-sync/monthly-operations-resources.model';
import {
  defaultResourceTrendWindow,
  pueAnnualComparison,
  pueBaselineReferences,
  pueComparisonAxes,
  pueWithWetBulb,
  rackSummary,
  resourceTrend,
  resourceValue,
} from '../../client/src/pages/MonthlyOperations/resource-model';
import type { MonthlyOperationsResourcesResponse } from '../../shared/monthly-operations-resources.interface';
import { comparePue } from '../../client/src/pages/MonthlyOperations/pue-comparison';
const date = '2026-09-12';
const timestamp = Date.parse(date + 'T08:00:00+08:00');
const formula = (value: number) => ({ type: 2, value: [value] });
const record = (fields: Record<string, unknown>) => ({ fields });
function energy(
  building = 'A楼',
  pue: number | null = 1.264,
  total = 126,
  it = 100,
  day = timestamp,
) {
  return [
    record({
      日期: day,
      楼栋: building,
      汇总分类: 'PUE',
      'PUE（数值）': pue,
      PUE: formula(9),
      '数值（3位小数点）': formula(8),
      '非IT用电量（万）': formula(0.0026),
    }),
    record({
      日期: day,
      楼栋: building,
      汇总分类: '总用电量',
      '数值（3位小数点）': formula(total),
    }),
    record({
      日期: day,
      楼栋: building,
      汇总分类: 'IT用电量',
      '数值（3位小数点）': formula(it),
    }),
  ];
}
function response(
  days = mapMonthlyEnergy(energy(), date, date),
): MonthlyOperationsResourcesResponse {
  return {
    load: { status: 'empty', syncedAt: null, date: null, park: null, rows: [] },
    range: { start: date, end: date, asOf: date, trendStart: '2026-08-14' },
    racks: {
      status: 'ready',
      syncedAt: null,
      month: null,
      rows: [],
      history: [],
    },
    energy: { status: 'ready', syncedAt: null, days },
    weather: { status: 'ready', syncedAt: null, days: [] },
    water: { status: 'ready', syncedAt: null, days: [] },
  };
}
describe('月览真实数据映射与口径', () => {
  it('年度趋势默认展示所选周期，月度和自定义范围仍默认近30天', () => {
    expect(defaultResourceTrendWindow({ mode: 'year' })).toBe('period');
    expect(defaultResourceTrendWindow({ mode: 'month' })).toBe('recent');
    expect(defaultResourceTrendWindow({ mode: 'range' })).toBe('recent');
  });
  it('PUE 基线按年度要求映射，A–C 合并去重且 E 楼不虚构基线', () => {
    expect(pueBaselineReferences(['A楼'])).toEqual([
      { key: 'abc', label: '年度基线', value: 1.19 },
    ]);
    expect(
      pueBaselineReferences(['园区', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼']),
    ).toEqual([
      { key: 'abc', label: 'A–C 年度基线', value: 1.19 },
      { key: 'd', label: 'D楼年度基线', value: 1.4 },
    ]);
    expect(pueBaselineReferences(['E楼'])).toEqual([]);
  });
  it('年度 PUE 对比给出达标、超基线和无基线说明', () => {
    expect(pueAnnualComparison('A楼', 1.203)).toEqual({
      baseline: 1.19,
      delta: 0.013,
      percent: expect.closeTo(1.0924, 4),
      status: 'above',
      text: '高于基线 0.013（+1.1%），未达标',
    });
    expect(pueAnnualComparison('D楼', 1.263)).toEqual({
      baseline: 1.4,
      delta: -0.137,
      percent: expect.closeTo(-9.7857, 4),
      status: 'within',
      text: '低于基线 0.137（-9.8%），达标',
    });
    expect(pueAnnualComparison('E楼', 1.557)).toEqual({
      baseline: null,
      delta: null,
      percent: null,
      status: 'unrated',
      text: '暂无年度基线',
    });
    expect(pueAnnualComparison('B楼', null).text).toBe('年度 PUE 暂无数据');
  });
  it('PUE 合并比较仅在 E 楼明显离群时启用独立纵轴', () => {
    const buildings = ['园区', 'A楼', 'B楼', 'D楼', 'E楼'] as const;
    const rows = [
      {
        name: '2026-09-01',
        园区: 1.24,
        A楼: 1.25,
        B楼: 1.23,
        D楼: 1.32,
        E楼: 1.6,
      },
    ];
    expect(pueComparisonAxes(rows, [...buildings])).toEqual({
      primary: ['园区', 'A楼', 'B楼', 'D楼'],
      secondary: 'E楼',
    });
    expect(
      pueComparisonAxes([{ ...rows[0], E楼: 1.29 }], [...buildings]),
    ).toEqual({
      primary: [...buildings],
      secondary: null,
    });
    expect(pueComparisonAxes(rows, ['E楼'])).toEqual({
      primary: ['E楼'],
      secondary: null,
    });
  });
  it('PUE 与湿球曲线按日期对齐，缺测不补值且零度有效', () => {
    const pue = [
      { name: '2026-09-01', A楼: 1.24 },
      { name: '2026-09-02', A楼: 1.25 },
    ];
    expect(
      pueWithWetBulb(pue, [{ name: '2026-09-01', A楼: 0 }], 'A楼'),
    ).toEqual([
      { name: '2026-09-01', A楼: 1.24, wetBulb: 0 },
      { name: '2026-09-02', A楼: 1.25, wetBulb: null },
    ]);
    expect(pue[0]).toEqual({ name: '2026-09-01', A楼: 1.24 });
  });
  it('机柜历史固定含本月12个月，缺月不沿用前月值', () => {
    const records = [
      record({
        楼栋名称: 'A楼',
        年度: '2026',
        月度: '08',
        当月最后日期: {
          type: 5,
          value: [Date.parse('2026-08-31T00:00:00+08:00')],
        },
        机柜设计数量: 988,
        实际上电数量: 950,
      }),
    ];
    const history = mapMonthlyRackHistory(records, '2026-09-13');
    expect(history).toHaveLength(12);
    expect(history[0].month).toBe('2025-10');
    expect(history[10].rows[0].online).toBe(950);
    expect(history[11]).toEqual({ month: '2026-09', rows: [] });
  });
  it('楼栋 PUE 严格读取数值字段，与公式和普通指标值不同', () => {
    expect(
      mapMonthlyEnergy(energy(), date, date).find((x) => x.building === 'A楼')
        ?.pue,
    ).toBe(1.264);
    expect(
      mapMonthlyEnergy(energy('A楼', null), date, date).find(
        (x) => x.building === 'A楼',
      )?.pue,
    ).toBeNull();
  });
  it('园区仅用同日 A–C 的 PUE 数值按 IT 电量加权，排除 D/E 与源园区行', () => {
    const data = [
      ...energy('A楼', 1.1, 120, 100),
      ...energy('B楼', 1.2, 260, 200),
      ...energy('C楼', 1.3, 450, 300),
      ...energy('D楼', 3, 30000, 10000),
      ...energy('E楼', 4, 40000, 10000),
      ...energy('园区', 9, 90000, 10000),
    ];
    const park = mapMonthlyEnergy(data, date, date)[0];
    expect(park.pue).toBeCloseTo((1.1 * 100 + 1.2 * 200 + 1.3 * 300) / 600, 10);
    expect(park.pueWeight).toBe(600);
    expect(park.total).toBe(70830);
    expect(
      mapMonthlyEnergy(
        data.filter((x) => x.fields['楼栋'] !== 'C楼'),
        date,
        date,
      )[0].pue,
    ).toBeNull();
  });
  it('10月2日异常总电量不抬高园区 PUE，趋势、周期汇总与对比一致', () => {
    const day = '2026-10-02';
    const at = Date.parse(`${day}T00:00:00+08:00`);
    const rows = [
      ...energy('A楼', 1.24703355155483, 527096.81, 212800, at),
      ...energy('B楼', 1.22933358163412, 274616.78, 222848, at),
      ...energy('C楼', 1.23595153991987, 276418.09, 223648, at),
    ];
    const days = mapMonthlyEnergy(rows, day, day);
    const expected =
      (1.24703355155483 * 212800 +
        1.22933358163412 * 222848 +
        1.23595153991987 * 223648) /
      (212800 + 222848 + 223648);
    expect(days[0].pue).toBeCloseTo(expected, 12);
    expect(days[1].total).toBe(527096.81);
    const data = response(days);
    data.range = { start: day, end: day, asOf: day, trendStart: day };
    expect(resourceTrend(data, 'pue', day, day, 'day')[0]['园区']).toBeCloseTo(
      expected,
      12,
    );
    expect(
      resourceTrend(data, 'pue', day, day, 'month')[0]['园区'],
    ).toBeCloseTo(expected, 12);
    expect(resourceValue(data, 'pue', 'all')).toBeCloseTo(expected, 12);
    expect(
      comparePue(data, day, day, ['园区', 'A楼', 'B楼', 'C楼']).park,
    ).toBeCloseTo(expected, 12);
  });
  it.each([null, 0])(
    'A–C 任一楼 PUE 为 %s 时园区缺测，不回退总电量推算',
    (pue) => {
      const days = mapMonthlyEnergy(
        [
          ...energy('A楼', pue, 125, 100),
          ...energy('B楼', 1.25, 250, 200),
          ...energy('C楼', 1.25, 375, 300),
        ],
        date,
        date,
      );
      expect(days[0].pue).toBeNull();
      expect(days[0].pueWeight).toBeNull();
    },
  );
  it('A–C 任一楼 PUE 冲突或 IT 权重缺失时园区缺测', () => {
    const rows = [
      ...energy('A楼', 1.25, 125, 100),
      ...energy('B楼', 1.25, 250, 200),
      ...energy('C楼', 1.25, 375, 300),
    ];
    const conflict = mapMonthlyEnergy(
      [...rows, energy('C楼', 1.4)[0]],
      date,
      date,
    )[0];
    expect(conflict.pue).toBeNull();
    expect(conflict.pueWeight).toBeNull();
    const missing = mapMonthlyEnergy(
      rows.filter(
        (r) =>
          !(r.fields['楼栋'] === 'C楼' && r.fields['汇总分类'] === 'IT用电量'),
      ),
      date,
      date,
    )[0];
    expect(missing.pue).toBeNull();
    expect(missing.pueWeight).toBeNull();
  });
  it('PUE 与 IT 权重齐全时不依赖总电量字段', () => {
    const rows = ['A楼', 'B楼', 'C楼'].flatMap((building) =>
      energy(building, 1.25),
    );
    expect(
      mapMonthlyEnergy(
        rows.filter((r) => r.fields['汇总分类'] !== '总用电量'),
        date,
        date,
      )[0].pue,
    ).toBeCloseTo(1.25);
  });
  it('相同记录去重，冲突留空；缺失日生成断点而不是零', () => {
    const rows = energy();
    expect(mapMonthlyEnergy([...rows, ...rows], date, date)[1].pue).toBe(1.264);
    expect(
      mapMonthlyEnergy([...rows, ...energy('A楼', 1.5)], date, date)[1].pue,
    ).toBeNull();
    const days = mapMonthlyEnergy(rows, date, '2026-09-13');
    expect(days).toHaveLength(12);
    expect(days.slice(6).every((x) => x.pue === null && x.total === null)).toBe(
      true,
    );
  });
  it('电量单位与零值保留，不把非 IT 万单位当作 kWh', () => {
    const days = mapMonthlyEnergy(
      [
        ...energy(),
        record({
          日期: timestamp,
          楼栋: 'A楼',
          汇总分类: '辅助用电',
          '数值（3位小数点）': formula(0),
        }),
        record({
          日期: timestamp,
          楼栋: 'A楼',
          汇总分类: '冷源用电',
          '数值（3位小数点）': formula(17),
        }),
      ],
      date,
      date,
    );
    expect(days[1]).toMatchObject({ nonIt: 26, auxiliary: 0, cooling: 17 });
  });
  it('电量计算列为零时采用有值的可编辑列，并保留真正的零值', () => {
    const rows = [
      ...energy('A楼', 1.25, 125, 100),
      ...energy('B楼', 1.25, 250, 200),
      ...energy('C楼', 1.25, 375, 300),
    ].map((entry) => {
      const fields = { ...entry.fields };
      if (fields['汇总分类'] === 'PUE') {
        fields['非IT用电量（万）'] = formula(0);
        fields['非IT用电量（万）-可编辑'] = 0.0025;
      } else {
        fields['数值（3位小数点）-可编辑'] = fields['数值（3位小数点）'];
        fields['数值（3位小数点）'] = formula(0);
      }
      return record(fields);
    });
    rows.push(
      record({
        日期: timestamp,
        楼栋: 'A楼',
        汇总分类: '辅助用电',
        '数值（3位小数点）': formula(0),
        '数值（3位小数点）-可编辑': 0,
      }),
    );
    const days = mapMonthlyEnergy(rows, date, date);
    expect(days[1]).toMatchObject({
      total: 125,
      it: 100,
      nonIt: 25,
      auxiliary: 0,
      pueWeight: 100,
    });
    expect(days[0]).toMatchObject({ total: null, it: null, pueWeight: 600 });
    expect(days[0].pue).toBeCloseTo(1.25);
  });
  it('周期 PUE 使用 IT 电量加权；没有 IT 电量仍可显示当日源 PUE', () => {
    const d = response(
      mapMonthlyEnergy(
        [
          ...energy('A楼', 1.2, 120, 100),
          ...energy('A楼', 1.4, 420, 300, timestamp + 86400000),
        ],
        date,
        '2026-09-13',
      ),
    );
    d.range.asOf = '2026-09-13';
    d.range.end = '2026-09-13';
    expect(resourceValue(d, 'pue', 'A楼')).toBeCloseTo(1.35);
    expect(
      resourceTrend(d, 'pue', date, '2026-09-13', 'month')[0]['A楼'],
    ).toBeCloseTo(1.35);
    const missing = response(
      mapMonthlyEnergy(energy().slice(0, 1), date, date),
    );
    expect(resourceTrend(missing, 'pue', date, date, 'day')[0]['A楼']).toBe(
      1.264,
    );
    expect(resourceValue(missing, 'pue', 'A楼')).toBeNull();
  });
  it('机柜取截止日前最新快照，不累加月份，部分楼栋园区不上数', () => {
    const rack = (month: string, online: number) =>
      record({
        楼栋名称: 'A楼',
        年度: '2026',
        月度: month,
        当月最后日期: {
          type: 5,
          value: [
            Date.parse(
              `2026-${month}-${month === '08' ? '31' : '13'}T00:00:00+08:00`,
            ),
          ],
        },
        机柜设计数量: formula(988),
        实际上电数量: formula(online),
      });
    expect(
      mapMonthlyRacks([rack('08', 900), rack('09', 970)], '2026-09-12'),
    ).toMatchObject({ month: '2026-08', rows: [{ online: 900 }] });
    const d = response();
    d.racks = {
      ...d.racks,
      ...mapMonthlyRacks([rack('08', 900), rack('09', 970)], '2026-09-13'),
    };
    expect(rackSummary(d, 'A楼').online).toBe(970);
    expect(rackSummary(d, 'all').rate).toBeNull();
  });
  it('湿球温度按楼栋班次去重，负温和零有效，不能重复加权', () => {
    const temp = (shift: string, value: number) =>
      record({
        日期: timestamp,
        楼栋: 'A楼',
        班次: shift,
        '室外湿球温度（℃）': value,
      });
    const d = mapMonthlyTemperature(
      [temp('白班', 0), temp('白班', 0), temp('夜班', -2)],
      date,
      date,
    );
    expect(d[1]).toMatchObject({ value: -1, samples: 2 });
    expect(d[0].value).toBeNull();
    expect(
      mapMonthlyTemperature([temp('白班', 10), temp('白班', 20)], date, date)[1]
        .value,
    ).toBeNull();
  });
  it('水耗只统计水耗日记录，分区和 WUE 使用各自字段', () => {
    const fields = {
      执行日期: timestamp,
      楼栋: 'A楼',
      类型: '水耗',
      频次: '日',
      当日耗水总量: formula(461),
      东区耗水量: formula(227),
      西区耗水量: formula(234),
      WUE: formula(1.68),
      当日用电量: formula(273916),
    };
    const water = mapMonthlyWater(
      [
        record(fields),
        record(fields),
        record({ ...fields, 频次: '月', 当日耗水总量: formula(9999) }),
        record({ ...fields, 类型: '电耗' }),
      ],
      date,
      date,
    );
    expect(water[1]).toMatchObject({
      water: 461,
      waterEast: 227,
      waterWest: 234,
      wue: 1.68,
      wueWeight: 273916,
    });
    expect(water[0].water).toBeNull();
    const d = response();
    d.water.days = water;
    expect(resourceValue(d, 'water', 'A楼')).toBe(461);
    expect(resourceValue(d, 'wue', 'A楼')).toBe(1.68);
  });
  it.each([
    ['2026-02-30', '2026-03-01'],
    ['2026-09-13', '2026-09-12'],
    ['2024-01-01', '2026-09-13'],
    ['2026-09-14', '2026-09-30'],
  ])('拒绝无效范围 %s 至 %s', (start, end) => {
    expect(() => resourceRange(start, end, '2026-09-13')).toThrow();
  });
  it('年度截止今天，近30天跨月保留', () => {
    expect(
      resourceRange('2026-01-01', '2026-12-31', '2026-09-13'),
    ).toMatchObject({ asOf: '2026-09-13', trendStart: '2026-08-15' });
  });
});
