import { mapMaintenance } from '../../server/modules/bitable-sync/monthly-operations-maintenance.model';
import { assessmentDate } from '../../server/modules/bitable-sync/monthly-operations-assessment.model';
const record = (id: string, fields: Record<string, unknown> = {}) => ({
  record_id: id,
  fields: {
    维护总项: 'UPS维护',
    楼栋: 'A楼',
    专业类别: '电气',
    计划开始维护时间: '2026-09-10',
    维护实施状态: '未开始',
    ...fields,
  },
});
describe('维护推进数据适配', () => {
  it('计划与非计划分开，查找引用时间、工作流与执行状态独立', () => {
    const stamp = Date.parse('2026-09-10T08:00:00+08:00');
    const r = mapMaintenance('planned', [
      record('a', {
        实际开始时间: { value: [String(stamp)] },
        实际结束时间: { value: [String(stamp + 3600000)] },
        维护实施状态: '正常结束',
        '维护实施状态（新）': '工程师确认中',
      }),
    ]).records[0];
    expect(r).toMatchObject({
      done: true,
      date: '2026-09-10',
      status: '工程师确认中',
      planType: 'planned',
    });
    expect(r.tags).toContain('工程师确认中');
    const u = mapMaintenance('unplanned', [
      record('u', {
        计划开始维护时间: null,
        实际开始时间: '2026-09-11',
        维护状态: '进行中',
      }),
    ]).records[0];
    expect(u).toMatchObject({
      date: '2026-09-11',
      running: true,
      done: false,
      planType: 'unplanned',
    });
  });
  it('异常明细包含延期、结束倒置；去重与未知日期不伪造', () => {
    const result = mapMaintenance('planned', [
      record('late', { 维护实施状态: '延期未开始' }),
      record('late'),
      record('reverse', {
        维护实施状态: '正常结束',
        实际开始时间: '2026-09-11',
        实际结束时间: '2026-09-10',
      }),
      record('undated', { 计划开始维护时间: null }),
    ]);
    expect(result.records).toHaveLength(3);
    expect(result.records.filter((r) => r.abnormal)).toHaveLength(2);
    expect(result.records[1].done).toBe(false);
    expect(result.invalid).toBe(1);
  });
  it('超范围日期不抛出，非法日期不修正成有效日期', () => {
    expect(assessmentDate(1e30)).toBeNull();
    expect(assessmentDate('2026-02-30')).toBeNull();
  });
});
