import { mapMonthlyChanges } from '../../server/modules/bitable-sync/monthly-operations-changes.model';
import {
  changeScope,
  changeTrend,
  changeGroups,
  filterChanges,
  CHANGE_FILTERS,
  changeCohorts,
  sortChanges,
} from '../../client/src/pages/MonthlyOperations/change-model';

const input = (id: string, fields: Record<string, unknown> = {}) => ({
  record_id: id,
  fields: {
    '计划开始日期（阿里）': Date.parse('2026-09-12T00:30:00+08:00'),
    '计划结束日期（阿里）': Date.parse('2026-09-12T20:00:00+08:00'),
    变更简述: '测试变更',
    自增编号: '123',
    变更楼栋: ['A楼', 'B楼'],
    变更进度: { type: 3, value: ['已结束'] },
    变更类型: '计划性变更',
    ...fields,
  },
});

describe('月览变更真实接入', () => {
  it('退回、驳回、取消不计入展示；进行中和中风险以上卡片与下钻一致', () => {
    const { records } = mapMonthlyChanges([
      input('cancel', { '变更情况（变更完成或取消后填写）': '变更取消' }),
      input('returned', { 变更进度: '退回' }),
      input('rejected', { 变更进度: '已驳回' }),
      input('mid', { 变更进度: '进行中', '变更等级（阿里）': '中' }),
      input('high', { '变更等级（阿里）': '高风险' }),
      input('low', { 变更进度: '进行中', '变更等级（阿里）': '超低' }),
      input('done', {
        '变更等级（阿里）': '中',
        '变更情况（变更完成或取消后填写）': '变更成功',
      }),
      input('failed', { '变更情况（变更完成或取消后填写）': '变更失败' }),
    ]);
    const rows = changeScope(records, '2026-09-01', '2026-09-30');
    const cohorts = changeCohorts(rows);
    expect(rows).toHaveLength(5);
    expect(cohorts.running.map((r) => r.id).sort()).toEqual(['low', 'mid']);
    expect(cohorts.priority.map((r) => r.id).sort()).toEqual([
      'done',
      'high',
      'mid',
    ]);
    expect(
      filterChanges(records, { ...CHANGE_FILTERS, risk: 'priority' }),
    ).toEqual(cohorts.priority);
    expect(
      filterChanges(records, { ...CHANGE_FILTERS, state: 'running' }),
    ).toEqual(cohorts.running);
    expect(changeGroups(rows, 'state').reduce((n, r) => n + r.value, 0)).toBe(
      5,
    );
    expect(
      changeTrend(rows, '2026-09-01', '2026-09-30', 'day').reduce(
        (n, r) => n + r.total,
        0,
      ),
    ).toBe(5);
    expect(sortChanges(rows)[0].id).toBe('mid');
    expect(sortChanges(rows).at(-1)?.id).toBe('done');
    expect(cohorts.pending.some((r) => r.id === 'failed')).toBe(true);
  });
  it('计划已结束不等于成功，按明确结果划分状态', () => {
    const { records } = mapMonthlyChanges([
      input('pending'),
      input('done', { '变更情况（变更完成或取消后填写）': '变更成功' }),
      input('cancel', { '变更情况（变更完成或取消后填写）': '变更取消' }),
      input('delay', { '变更情况（变更完成或取消后填写）': '变更延期' }),
      input('late', { '变更情况（变更完成或取消后填写）': '延期完成' }),
      input('return', { 变更进度: { type: 3, value: ['退回'] } }),
      input('running', { 变更进度: '进行中' }),
      input('planned', { 变更进度: '未开始' }),
      input('ended', {
        变更进度: '',
        实际结束时间: { type: 5, value: [Date.parse('2026-09-13')] },
      }),
      input('fail', { '变更情况（变更完成或取消后填写）': '变更失败' }),
    ]);
    expect(Object.fromEntries(records.map((r) => [r.id, r.state]))).toEqual({
      pending: 'pending',
      done: 'done',
      cancel: 'cancelled',
      delay: 'delayed',
      late: 'done',
      return: 'returned',
      running: 'running',
      planned: 'planned',
      ended: 'pending',
      fail: 'failed',
    });
  });
  it('解析查找字段、上海日期和延期计划，去重、排除无日期，裁剪人员和附件', () => {
    const mapped = mapMonthlyChanges([
      input('a', {
        变更楼栋: { type: 4, value: ['A楼', 'C楼', 'A楼'] },
        计划延迟开始日期: Date.parse('2026-10-01T01:00:00+08:00'),
        提交人: 'private',
        附件: ['private'],
      }),
      input('a'),
      input('bad', { '计划开始日期（阿里）': null }),
      input('midnight'),
    ]);
    expect(mapped.invalid).toBe(1);
    expect(mapped.records).toHaveLength(2);
    expect(mapped.records[0].buildings).toEqual(['A楼', 'C楼']);
    expect(mapped.records[0].date).toBe('2026-10-01');
    expect(mapped.records[1].date).toBe('2026-09-12');
    expect(JSON.stringify(mapped)).not.toContain('private');
  });
  it('多楼变更园区只计一次，月份、年度、自定义与清单筛选共用口径', () => {
    const { records } = mapMonthlyChanges([
      input('sept'),
      input('march', {
        '计划开始日期（阿里）': Date.parse('2026-03-02'),
        变更类型: '紧急变更',
      }),
      input('old', { '计划开始日期（阿里）': Date.parse('2025-01-01') }),
      input('future', { '计划开始日期（阿里）': Date.parse('2026-09-28') }),
    ]);
    expect(changeScope(records, '2026-09-01', '2026-09-30')).toHaveLength(2);
    expect(changeScope(records, '2026-01-01', '2026-12-31')).toHaveLength(3);
    expect(
      changeScope(records, '2026-03-01', '2026-03-10', 'B楼').map((r) => r.id),
    ).toEqual(['march']);
    expect(changeScope(records, '2026-01-01', '2026-12-31', 'C楼')).toEqual([]);
    expect(
      filterChanges(records, {
        ...CHANGE_FILTERS,
        type: '紧急变更',
        search: 'BG-123',
      }).map((r) => r.id),
    ).toEqual(['march']);
  });
  it('日/月趋势、分布与清单总数一致，空周期和零完成显示真实零值', () => {
    const records = changeScope(
      mapMonthlyChanges([
        input('a'),
        input('b', { '变更情况（变更完成或取消后填写）': '变更成功' }),
      ]).records,
      '2026-09-01',
      '2026-09-30',
    );
    const days = changeTrend(records, '2026-09-01', '2026-09-30', 'day');
    expect(days).toHaveLength(30);
    expect(days[11]).toEqual({ name: '09/12', total: 2, done: 1 });
    expect(days.reduce((n, r) => n + r.total, 0)).toBe(records.length);
    expect(
      changeGroups(records, 'state').reduce((n, r) => n + r.value, 0),
    ).toBe(2);
    expect(
      changeTrend(records, '2026-01-01', '2026-12-31', 'month'),
    ).toHaveLength(12);
    expect(changeGroups([], 'state')).toEqual([]);
  });
});
