jest.mock('../../client/src/pages/MonthlyOperations/period', () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-13T12:00:00+08:00'));
  const period = jest.requireActual('../../client/src/pages/MonthlyOperations/period');
  clock.mockRestore();
  return period;
});
import {
  createMonthlyDemo,
  createPeriodDemo,
} from '../../client/src/pages/MonthlyOperations/mock-data';
import {
  rangeError,
  resolvePeriod,
  type PeriodSelection,
} from '../../client/src/pages/MonthlyOperations/period';
import {
  buildMonthlyView,
  buildPeriodView,
  filterRecords,
  previousMonth,
  percentage,
} from '../../client/src/pages/MonthlyOperations/model';

describe('智舱月览演示数据与筛选口径', () => {
  const data = createMonthlyDemo('2026-09');
  it('容量和能源指标从同一数据集合计算，PUE 使用电量加权', () => {
    const view = buildMonthlyView(data, 'all');
    expect(view.racks).toBe(5322);
    expect(view.online).toBe(4037);
    expect(view.pue).toBe(view.totalEnergy / view.itEnergy);
    expect(view.daily).toHaveLength(13);
    view.daily.forEach((day) =>
      expect(day.it + day.cooling + day.terminal + day.auxiliary).toBe(
        day.total,
      ),
    );
    expect(view.wue).toBe((view.water * 1000) / view.itEnergy);
  });
  it('下钻数量与摘要一致，并继承楼栋、状态和月份', () => {
    const view = buildMonthlyView(data, 'A楼');
    expect(view.records.every((item) => item.building === 'A楼')).toBe(true);
    expect(
      filterRecords(view.records, { kind: 'maintenance', status: 'done' }),
    ).toHaveLength(view.kinds.maintenance.done);
    expect(filterRecords(view.records, { kind: 'event' })).toHaveLength(
      view.kinds.event.total,
    );
    expect(view.records.every((item) => item.date.startsWith('2026-09'))).toBe(
      true,
    );
  });
  it('未开始的计划可落在未来，当期实际记录不超过快照日', () => {
    expect(
      data.records
        .filter((item) => item.status !== 'pending')
        .every((item) => item.date <= data.asOf),
    ).toBe(true);
    expect(
      data.records
        .filter((item) => item.status === 'pending')
        .every((item) => item.date > data.asOf),
    ).toBe(true);
  });
  it('H楼无资源数据时返回明确空集合，不伪造为零 PUE', () => {
    const view = buildMonthlyView(data, 'H楼');
    expect(view.resources).toEqual([]);
    expect(view.daily).toEqual([]);
    expect(view.pue).toBeNull();
    expect(view.kinds.maintenance.total).toBeGreaterThan(0);
  });
  it('月份切换生成不同且稳定的数据，日期和 ID 有效', () => {
    const august = createMonthlyDemo('2026-08');
    expect(august).toEqual(createMonthlyDemo('2026-08'));
    expect(august.asOf).toBe('2026-08-31');
    expect(august.resources[0].online).not.toBe(data.resources[0].online);
    expect(new Set(data.records.map((item) => item.id)).size).toBe(
      data.records.length,
    );
    expect(august.records.every((item) => item.date <= '2026-08-31')).toBe(
      true,
    );
  });
  it('支持组合搜索和明确的无结果状态', () => {
    expect(
      filterRecords(data.records, {
        kind: 'event',
        building: 'D楼',
        status: 'unfinished',
      }).every(
        (item) =>
          item.kind === 'event' &&
          item.building === 'D楼' &&
          item.status !== 'done',
      ),
    ).toBe(true);
    expect(filterRecords(data.records, {}, '绝不会出现的内容')).toEqual([]);
    expect(filterRecords(data.records, {}, 'demo-event')).toHaveLength(31);
    expect(percentage(0, 0)).toBe(0);
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(() => createMonthlyDemo('2026-13')).toThrow();
  });

  it('专业、恢复状态和单条记录下钻不会丢失筛选条件', () => {
    const overdue = filterRecords(data.records, {
      kind: 'maintenance',
      status: 'overdue',
      specialty: '电气',
    });
    expect(overdue.length).toBeGreaterThan(0);
    expect(
      overdue.every(
        (item) => item.specialty === '电气' && item.status === 'overdue',
      ),
    ).toBe(true);
    const unrecovered = filterRecords(data.records, {
      kind: 'alarm',
      recovered: false,
    });
    expect(unrecovered).toHaveLength(4);
    expect(filterRecords(data.records, { id: unrecovered[0].id })).toEqual([
      unrecovered[0],
    ]);
  });
});

describe('周期汇总与智航考核', () => {
  const viewFor = (
    period: PeriodSelection,
    building: Parameters<typeof buildPeriodView>[2] = 'all',
  ) => buildPeriodView(createPeriodDemo(period), period, building);
  it('整年电量及水量与十二个月相加一致，容量只取期末快照', () => {
    const period = { mode: 'year', year: '2025' } as const;
    const annual = viewFor(period);
    const monthly = createPeriodDemo(period).map((data) =>
      buildMonthlyView(data, 'all'),
    );
    expect(annual.daily).toHaveLength(365);
    expect(annual.trend).toHaveLength(12);
    expect(annual.totalEnergy).toBe(
      monthly.reduce((sum, view) => sum + view.totalEnergy, 0),
    );
    expect(annual.water).toBe(
      monthly.reduce((sum, view) => sum + view.water, 0),
    );
    expect(annual.online).toBe(monthly[11].online);
    expect(annual.racks).toBe(5322);
    expect(annual.poweredOn).toBe(
      monthly.reduce((sum, view) => sum + view.poweredOn, 0),
    );
    expect(annual.records).toHaveLength(
      monthly.reduce((sum, view) => sum + view.records.length, 0),
    );
    expect(new Set(annual.records.map((row) => row.id)).size).toBe(
      annual.records.length,
    );
    expect(annual.pue).toBe(annual.totalEnergy / annual.itEnergy);
    expect(annual.wue).toBe((annual.water * 1000) / annual.itEnergy);
    annual.trend.forEach((row, index) => {
      expect(row.total).toBe(monthly[index].totalEnergy);
      expect(row.pue).toBe(monthly[index].pue);
      expect(row.wue).toBe(monthly[index].wue);
    });
  });
  it('当前年度不生成截止日后的实测能耗，计划与实际口径明确', () => {
    const view = viewFor({ mode: 'year', year: '2026' });
    expect(view.period.partial).toBe(true);
    expect(view.period.end).toBe('2026-12-31');
    expect(view.asOf).toBe('2026-09-13');
    expect(view.daily.at(-1)?.day).toBe('2026-09-13');
    expect(view.trend).toHaveLength(9);
    expect(
      view.records
        .filter((row) => row.status !== 'pending')
        .every((row) => row.date <= view.asOf),
    ).toBe(true);
  });
  it('跨年范围包含两端且可与相邻周期相加，机柜上下电不重复累计', () => {
    const range = viewFor({
      mode: 'range',
      start: '2025-12-20',
      end: '2026-01-10',
    });
    const left = viewFor({
      mode: 'range',
      start: '2025-12-20',
      end: '2025-12-31',
    });
    const right = viewFor({
      mode: 'range',
      start: '2026-01-01',
      end: '2026-01-10',
    });
    expect(range.daily).toHaveLength(22);
    expect(range.daily[0].day).toBe('2025-12-20');
    expect(range.daily.at(-1)?.day).toBe('2026-01-10');
    expect(range.totalEnergy).toBe(left.totalEnergy + right.totalEnergy);
    expect(range.poweredOn).toBe(left.poweredOn + right.poweredOn);
    expect(range.poweredOff).toBe(left.poweredOff + right.poweredOff);
    expect(range.records).toHaveLength(
      left.records.length + right.records.length,
    );
    expect(
      range.records.every(
        (row) => row.date >= range.period.start && row.date <= range.period.end,
      ),
    ).toBe(true);
    const full = viewFor({ mode: 'month', month: '2026-01' });
    const rest = viewFor({
      mode: 'range',
      start: '2026-01-11',
      end: '2026-01-31',
    });
    expect(full.poweredOn).toBe(right.poweredOn + rest.poweredOn);
    expect(full.poweredOff).toBe(right.poweredOff + rest.poweredOff);
    expect(right.online).toBe(full.online - rest.poweredOn + rest.poweredOff);
  });
  it('单日与长范围都有合理趋势粒度；非法日期明确拒绝', () => {
    expect(
      viewFor({ mode: 'range', start: '2026-09-13', end: '2026-09-13' }).daily,
    ).toHaveLength(1);
    expect(
      viewFor({ mode: 'range', start: '2025-01-01', end: '2026-09-13' }).trend,
    ).toHaveLength(21);
    expect(rangeError('2026-02-30', '2026-03-01')).not.toBeNull();
    expect(rangeError('', '')).not.toBeNull();
    expect(rangeError('2026-09-12', '2026-09-01')).toContain('开始日期');
    expect(rangeError('2024-12-31', '2025-01-01')).toContain('可选日期');
    expect(() => resolvePeriod({ mode: 'year', year: '2024' })).toThrow();
    expect(() =>
      resolvePeriod({ mode: 'range', start: '2026-09-01', end: '2026-09-14' }),
    ).toThrow();
  });
  it('楼栋筛选的电量可加回园区，空楼栋无伪造资源', () => {
    const period = { mode: 'year', year: '2025' } as const;
    const campus = viewFor(period);
    const buildings = (['A楼', 'B楼', 'C楼', 'D楼', 'E楼'] as const).map(
      (building) => viewFor(period, building),
    );
    expect(campus.totalEnergy).toBe(
      buildings.reduce((sum, view) => sum + view.totalEnergy, 0),
    );
    expect(campus.water).toBe(
      buildings.reduce((sum, view) => sum + view.water, 0),
    );
    const empty = viewFor(period, 'H楼');
    expect(empty.daily).toEqual([]);
    expect(empty.pue).toBeNull();
    expect(empty.kinds.inspection.total).toBeGreaterThan(0);
  });
  it('风险排查、演练和巡检异常明细与考核统计完全一致', () => {
    for (const selection of [
      { mode: 'month', month: '2026-09' },
      { mode: 'year', year: '2025' },
      { mode: 'range', start: '2026-07-10', end: '2026-08-15' },
    ] as PeriodSelection[]) {
      const view = viewFor(selection, 'A楼');
      for (const kind of ['risk', 'drill', 'inspection'] as const) {
        expect(filterRecords(view.records, { kind })).toHaveLength(
          view.kinds[kind].total,
        );
        expect(
          filterRecords(view.records, { kind, status: 'done' }),
        ).toHaveLength(view.kinds[kind].done);
      }
      const completed = filterRecords(view.records, {
        kind: 'risk',
        status: 'done',
      });
      expect(
        completed.every((row) =>
          ['高风险', '中风险', '低风险', '未见风险'].includes(row.level),
        ),
      ).toBe(true);
      expect(
        filterRecords(view.records, { kind: 'risk', status: 'pending' }).every(
          (row) => row.level === '待排查',
        ),
      ).toBe(true);
      expect(view.records.every((row) => row.building === 'A楼')).toBe(true);
    }
  });
});
