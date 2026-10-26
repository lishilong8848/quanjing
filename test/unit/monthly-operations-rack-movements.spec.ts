import { mapMonthlyRackMovements } from '../../server/modules/bitable-sync/monthly-operations-resources.model';

describe('月览机柜上下电班次记录', () => {
  const row = (id: string, day: string, building: string, on: unknown, off: unknown) => ({
    record_id: id,
    fields: {
      日期: Date.parse(`${day}T12:00:00+08:00`),
      楼栋: building,
      班次: '白班',
      '本班组上电机柜数（个）': on,
      '本班组下电机柜数（个）': off,
    },
  });
  it('按周期保留真实零值，排除未来、其他楼栋及重复记录', () => {
    const rows = mapMonthlyRackMovements([
      row('a', '2026-09-16', 'A楼', 0, 0),
      row('b', '2026-09-17', 'B楼', 2, 1),
      row('b', '2026-09-17', 'B楼', 2, 1),
      row('c', '2026-08-30', 'C楼', 5, 0),
      row('d', '2026-09-20', 'D楼', 1, 1),
      row('e', '2026-09-17', 'X楼', 1, 1),
    ], '2026-09-01', '2026-09-18');
    expect(rows.map((item) => [item.building, item.poweredOn, item.poweredOff])).toEqual([
      ['B楼', 2, 1],
      ['A楼', 0, 0],
    ]);
  });
});
