import { comparePue } from '../../client/src/pages/MonthlyOperations/pue-comparison';
import { mapMonthlyLoad } from '../../server/modules/bitable-sync/monthly-operations-resources.model';
import type {
  MonthlyOperationsResourcesResponse,
  MonthlyEnergyBuilding,
} from '../../shared/monthly-operations-resources.interface';
const point = (
  date: string,
  building: MonthlyEnergyBuilding,
  pue: number | null,
  weight: number | null = 100,
) => ({ date, building, pue, pueWeight: weight });
const response = (days: ReturnType<typeof point>[]) =>
  ({ energy: { days } }) as MonthlyOperationsResourcesResponse;
describe('PUE 对比与 IT 负载', () => {
  it('楼间比较只用共同日期并按电量加权，缺失不当0', () => {
    const s = comparePue(
      response([
        point('2026-09-01', 'A楼', 1.2),
        point('2026-09-02', 'A楼', 1.4, 300),
        point('2026-09-03', 'A楼', 9),
        point('2026-09-01', 'B楼', 1.3),
        point('2026-09-02', 'B楼', 1.5),
      ]),
      '2026-09-01',
      '2026-09-03',
      ['A楼', 'B楼'],
    );
    expect(s.commonDays).toBe(2);
    expect(s.rows[0].value).toBeCloseTo(1.35);
    expect(s.low?.building).toBe('A楼');
    expect(s.high?.value).toBeCloseTo(1.4);
  });
  it('周期前后差为后半段减前半段；没有后半段不推断变化', () => {
    const data = response([
      point('2026-09-01', 'A楼', 1.3),
      point('2026-09-04', 'A楼', 1.2),
    ]);
    expect(
      comparePue(data, '2026-09-01', '2026-09-04', ['A楼']).rows[0].delta,
    ).toBeCloseTo(-0.1);
    expect(
      comparePue(data, '2026-09-01', '2026-09-02', ['A楼']).rows[0].delta,
    ).toBeNull();
  });
  it('无数据或全部隐藏时不给比较结论', () => {
    expect(
      comparePue(null, '2026-09-01', '2026-09-13', ['A楼']).low,
    ).toBeUndefined();
    expect(
      comparePue(response([]), '2026-09-01', '2026-09-13', []).commonDays,
    ).toBe(0);
  });
  const records = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'].map((building, i) => ({
    fields: {
      日期: Date.parse('2026-09-12T00:00:00+08:00'),
      楼栋: building,
      IT负载率: 0.3 + i * 0.1,
      园区IT负载率: 0.533,
    },
  }));
  it('IT负载同今日航图优先园区字段，楼栋比例转百分数', () => {
    const result = mapMonthlyLoad(records, '2026-09-13');
    expect(result.park).toBeCloseTo(53.3);
    expect(result.rows[0].value).toBe(30);
    expect(result.rows).toHaveLength(5);
  });
  it('IT负载选最近完整日期，不能把不同日期楼栋拼接', () => {
    expect(mapMonthlyLoad(records.slice(0, 4), '2026-09-13').park).toBeNull();
    expect(mapMonthlyLoad(records, '2026-09-11').date).toBeNull();
  });
});
