import { mapZhihangProgress } from '../../server/modules/bitable-sync/monthly-operations-progress.model';
import {
  delayLabel,
  filterProgress,
  progressAttention,
  progressScope,
} from '../../client/src/pages/MonthlyOperations/progress-model';

const record = (id: string, fields: Record<string, unknown> = {}) => ({
  record_id: id,
  fields: {
    编码: `智航-${id}`,
    标题: '变更测试',
    楼栋: ['A楼', 'C楼', 'A楼'],
    计划开始: Date.parse('2026-09-10T09:00:00+08:00'),
    计划结束: Date.parse('2026-09-10T20:00:00+08:00'),
    ...fields,
  },
});
const map = (fields: Record<string, unknown>) =>
  mapZhihangProgress([record('a', fields)]).records[0];

describe('智航变更进展', () => {
  it('实施成功或执行已结束不能抹掉当前审批节点', () => {
    const post = map({
      当前节点: '实施后审批',
      状态: '实施成功',
      当前状态: ['已结束'],
      实际结束: Date.parse('2026-09-10T20:00:00+08:00'),
    });
    expect(progressAttention(post).post).toBe(true);
    expect(post.status).toBe('实施成功');
    expect(progressAttention(map({ 当前节点: '客服审批' })).customer).toBe(
      true,
    );
    expect(progressAttention(map({ 当前节点: '区域经理关闭' })).post).toBe(
      false,
    );
  });
  it('区分时间顺延、原样重填与提前，不将所有调整误报为延期', () => {
    expect(
      progressAttention(
        map({ 计划延期开始: Date.parse('2026-09-10T09:00:00+08:00') }),
      ).delayed,
    ).toBe(false);
    expect(
      progressAttention(
        map({ 计划延期开始: Date.parse('2026-09-09T09:00:00+08:00') }),
      ).delayed,
    ).toBe(false);
    const endOnly = map({
      计划延期结束: Date.parse('2026-09-10T22:00:00+08:00'),
    });
    expect(delayLabel(endOnly)).toBe('顺延 2 小时');
    expect(
      delayLabel(
        map({ 计划延期开始: Date.parse('2026-09-13T09:00:00+08:00') }),
      ),
    ).toBe('顺延 3 天');
    expect(progressAttention(map({ 当前节点: '计划延期' })).delayed).toBe(true);
  });
  it('保留缺失日期供历史追查，并裁剪人员、关联、附件', () => {
    const source = record('a', {
      计划开始: null,
      计划结束: null,
      提交人: 'private',
      '提交人（账号）': [{ id: 'secret' }],
      附件: 'secret',
    });
    const result = mapZhihangProgress([source, source]);
    expect(result.invalid).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].buildings).toEqual(['A楼', 'C楼']);
    expect(JSON.stringify(result)).not.toMatch(/private|secret/);
    expect(
      progressScope(result.records, '2026-09-01', '2026-09-30', 'all'),
    ).toHaveLength(0);
    expect(
      progressScope(result.records, '2026-09-01', '2026-09-30', 'all', true),
    ).toHaveLength(1);
  });
  it('跨周期延期按调整后时段归属，上海边界且多楼只计一次', () => {
    const rows = mapZhihangProgress([
      record('a', {
        计划延期开始: Date.parse('2026-10-01T00:30:00+08:00'),
        计划延期结束: Date.parse('2026-10-02T20:00:00+08:00'),
      }),
      record('span', { 计划开始: Date.parse('2026-08-30T09:00:00+08:00') }),
    ]).records;
    expect(
      progressScope(rows, '2026-09-01', '2026-09-30', 'all').map((r) => r.id),
    ).toEqual(['span']);
    expect(
      progressScope(rows, '2026-10-01', '2026-10-31', 'C楼').map((r) => r.id),
    ).toEqual(['a']);
    expect(progressScope(rows, '2026-10-01', '2026-10-31', 'B楼')).toEqual([]);
  });
  it('摘要、筛选共用关注口径，支持交叠状态和工单搜索', () => {
    const rows = mapZhihangProgress([
      record('customer', { 当前节点: '客服审批' }),
      record('post', {
        当前节点: '实施后审批',
        工单号: 'ORDER-42',
        计划延期结束: Date.parse('2026-09-11T20:00:00+08:00'),
      }),
      record('normal'),
    ]).records;
    expect(filterProgress(rows, 'post', '').map((r) => r.id)).toEqual(['post']);
    expect(
      filterProgress(rows, 'delayed', 'order-42').map((r) => r.id),
    ).toEqual(['post']);
    expect(filterProgress(rows, 'customer', 'order-42')).toEqual([]);
    expect(filterProgress(rows, 'all', '')).toHaveLength(3);
  });
  it('日期类型无效时回退到真实文本字段', () => {
    const row = map({
      计划开始: 'invalid',
      计划开始时间: '2026-09-11 09:00:00',
      计划延时结束时间: '2026-09-13 20:00:00',
    });
    expect(row.plannedStart).toBeTruthy();
    expect(row.deferredEnd).toBeTruthy();
    expect(progressAttention(row).delayed).toBe(true);
  });
});
