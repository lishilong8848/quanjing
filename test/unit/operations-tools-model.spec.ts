import {
  deriveTools,
  daysRemaining,
} from '../../client/src/pages/OperationsToolsManagement/model';

const tool = (id: string, building: string, extra = {}) => ({
  id,
  name: id,
  building,
  model: '',
  place: '',
  code: '',
  conclusion: '',
  scrapStatus: '',
  maintenanceDue: null,
  inspectionDue: null,
  issues: [],
  checks: {},
  ...extra,
});
describe('tools unified chart and drilldown model', () => {
  it('does not count unapproved borrowing and uses stable ids instead of names', () => {
    const snapshot: any = {
      tools: [tool('recA', 'A楼'), tool('recB', 'B楼')],
      flows: [
        { id: 'f1', kind: 'borrow', status: '示例人员001审批', toolIds: ['recA'] },
        { id: 'f2', kind: 'borrow', status: '工具已出库', toolIds: ['recB'] },
      ],
    };
    const result = deriveTools(snapshot, '', '', '2026-09-30');
    expect(result.groups.borrow.map((t) => t.id)).toEqual(['recB']);
    expect(result.buildings.reduce((sum, b) => sum + b.tools.length, 0)).toBe(
      result.tools.length,
    );
    expect(
      deriveTools(snapshot, 'A楼', '', '2026-09-30').groups.borrow,
    ).toEqual([]);
  });
  it('zero and missing dates remain distinct and search applies to all drilldowns', () => {
    expect(daysRemaining(null, '2026-09-30')).toBeNull();
    expect(daysRemaining('2026-09-30', '2026-09-30')).toBe(0);
    const snapshot: any = {
      tools: [
        tool('recA', 'A楼', { maintenanceDue: '2026-09-30' }),
        tool('recB', 'B楼'),
      ],
      flows: [],
    };
    expect(
      deriveTools(snapshot, '', 'recA', '2026-09-30').groups.maintenance,
    ).toHaveLength(1);
    expect(
      deriveTools(snapshot, '', 'recB', '2026-09-30').groups.maintenance,
    ).toHaveLength(0);
  });
  it('keeps chart totals and deduplicated problems consistent for ten thousand tools', () => {
    const snapshot: any = {
      tools: Array.from({ length: 10000 }, (_, i) =>
        tool(`rec${i}`, i % 2 ? 'A楼' : 'B楼'),
      ),
      flows: Array.from({ length: 10000 }, (_, i) => ({
        id: `flow${i}`,
        kind: 'quality',
        status: '检修中',
        toolIds: [`rec${i}`, `rec${i}`],
        checks: { 功能正常: false },
      })),
    };
    const result = deriveTools(snapshot, 'A楼', '', '2026-09-30');
    expect(result.groups.quality).toHaveLength(5000);
    expect(result.buildings[0].tools).toHaveLength(5000);
    expect(result.problems[0].tools).toHaveLength(5000);
    expect(new Set(result.problems[0].tools.map((t) => t.id)).size).toBe(5000);
  });
});
