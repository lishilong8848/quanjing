import {
  mapAssessment,
  assessmentDate,
  eventTimingAnomalies,
} from '../../server/modules/bitable-sync/monthly-operations-assessment.model';
import {
  assessmentFilter,
  assessmentProgress,
  groupEventTimingAnomalies,
} from '../../client/src/pages/MonthlyOperations/assessment-model';
const input = (id: string, fields: Record<string, unknown>) => ({
  record_id: id,
  fields,
});
describe('智航考核口径', () => {
  it('上海时间、公式日期和无效日期；不把同步创建日期当业务日期', () => {
    expect(assessmentDate({ type: 5, value: [1790643600000] })).toBe(
      '2026-09-29T01:00:00.000Z',
    );
    expect(assessmentDate([{ text: '2026/09/01 00:30' }])).toBe(
      '2026-08-31T16:30:00.000Z',
    );
    expect(assessmentDate('2026-02-30')).toBeNull();
    expect(assessmentDate('2026-99-01')).toBeNull();
    const result = mapAssessment('drill', [
      input('x', { 创建时间: '2026-09-14', 演练场景: '日期缺失' }),
    ]);
    expect(result.records[0].date).toBeNull();
    expect(result.invalid).toBe(1);
  });
  it('风险分开排查和审核，缺失与越界不能显示为完成', () => {
    const { records } = mapAssessment('risk', [
      input('a', {
        风险排查编码: 'a',
        楼栋: 'A楼',
        应完成条目: { value: [10] },
        排查完成数量: { value: [10] },
        审核完成数量: { value: [8] },
        审核截止时间: 1790643600000,
      }),
      input('b', {
        风险排查编码: 'b',
        楼栋: 'B楼',
        应完成条目: 10,
        排查完成数量: 12,
        审核完成数量: 12,
        审核截止时间: 1790643600000,
      }),
      input('c', {
        风险排查编码: 'c',
        楼栋: 'C楼',
        审核截止时间: 1790643600000,
      }),
    ]);
    expect(records[0]).toMatchObject({
      date: '2026-09-29',
      done: false,
      status: '待审核',
      checked: 10,
      approved: 8,
    });
    expect(assessmentProgress(records)).toEqual({
      planned: 10,
      checked: 10,
      approved: 8,
      valid: 1,
    });
    expect(records[2].planned).toBeNull();
  });
  it('演练按计划ID去重取新记录；已执行不等于已评估完成', () => {
    const common = {
      计划ID: 'same',
      计划演练时间: '2026-09-12',
      实施区域: 'A楼',
    };
    const result = mapAssessment('drill', [
      input('old', { ...common, 演练状态: '完成', 最后更新: 1000 }),
      input('new', {
        ...common,
        演练状态: '待评估',
        执行状态: '已执行',
        最后更新: 2000,
        是否逾期: '是',
      }),
    ]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      id: 'new',
      done: false,
      tags: ['逾期', '待评估'],
    });
  });
  it('三类事件可以交叉，不把未知真实标识或已完成事件当待解决', () => {
    const rows = mapAssessment('event', [
      input('a', {
        事件ID: '1',
        发生时间: '2026-09-12',
        位置: '南通数据中心A/A-F1',
        真实事件: '否',
        最高等级: 'I2',
        当前等级: 'I3',
        告警状态: '已恢复',
        处理状态: '待解决',
      }),
      input('b', {
        事件ID: '2',
        发生时间: '2026-09-12',
        真实事件: '是',
        最高等级: 'I3',
        告警状态: '已恢复',
        处理状态: '完成',
      }),
      input('c', {
        事件ID: '3',
        发生时间: '2026-09-12',
        当前等级: 'I2',
        告警状态: '未恢复',
        处理状态: '待解决',
      }),
    ]).records;
    expect(rows[0]).toMatchObject({
      building: 'A楼',
      tags: ['非真实事件', 'I2事件', '已恢复待解决'],
    });
    expect(rows[1].tags).toEqual([]);
    expect(rows[2].tags).toEqual(['I2事件']);
    expect(assessmentFilter(rows, 'I2事件')).toHaveLength(2);
    expect(assessmentFilter(rows, 'I2事件', '', 'A楼')).toHaveLength(1);
  });
  it('处理异常仅按通知至响应 2 分钟、通知至确认 7 分钟计算，同一事件只计一次', () => {
    const base = '2026-09-15 09:00:00';
    expect(
      eventTimingAnomalies(
        {
          通知时间: base,
          响应时间: '2026-09-15 09:02:00',
          确认时间: '2026-09-15 09:07:00',
          解决时间: '2026-09-15 19:00:00',
        },
        true,
      ),
    ).toEqual([]);
    const records = mapAssessment(
      'event',
      [
        input('slow', {
          事件ID: 'slow',
          发生时间: base,
          通知时间: base,
          响应时间: '2026-09-15 09:02:01',
          确认时间: '2026-09-15 09:07:01',
          解决时间: '2026-09-15 19:00:00',
          处理状态: '完成',
        }),
        input('pending', {
          事件ID: 'pending',
          发生时间: base,
          通知时间: base,
          处理状态: '待处理',
        }),
        input('unknown', {
          事件ID: 'unknown',
          发生时间: base,
          响应时间: '2026-09-15 12:00:00',
          确认时间: '2026-09-15 12:00:00',
          处理状态: '完成',
        }),
      ],
      Date.parse('2026-09-15T09:10:00+08:00'),
    ).records;
    expect(records[0].tags).toEqual(['处理异常', '响应超时', '确认超时']);
    expect(
      records[0].detail.find((item) => item.label === '响应超时')?.value,
    ).toContain('09:02:01');
    expect(records[1].tags).toEqual(['处理异常', '响应超时', '确认超时']);
    expect(records[2].tags).toEqual([]);
    expect(records.filter((row) => row.tags.includes('处理异常'))).toHaveLength(
      2,
    );
    expect(records[0].tags).not.toContain('处理超时');
  });
  it('同位置同故障一小时内的事件只计一个处理异常，保留组内原始记录', () => {
    const occurrence = (
      id: string,
      location: string,
      title: string,
      occurred: string,
      responseMinutes: number,
    ) => {
      const notified = new Date(occurred);
      const response = new Date(notified.getTime() + responseMinutes * 60000);
      return input(id, {
        事件ID: id,
        事件编号: id,
        事件标题: title,
        位置: location,
        发生时间: notified.getTime(),
        通知时间: notified.getTime(),
        响应时间: response.getTime(),
        确认时间: notified.getTime() + 6 * 60000,
        处理状态: '完成',
      });
    };
    const title = (n: string) =>
      `供油控制柜故障21V-HD8FOC-SJ-20260911-${n}`;
    const records = mapAssessment('event', [
      occurrence('first', 'C楼供油控制柜', title('13527'), '2026-09-11T05:00:00Z', 1),
      occurrence('slow', 'C楼供油控制柜', title('13528'), '2026-09-11T05:10:00Z', 3),
      occurrence('last', 'C楼供油控制柜', title('13529'), '2026-09-11T05:40:00Z', 1),
      occurrence('later', 'C楼供油控制柜', title('13530'), '2026-09-11T06:30:00Z', 3),
      occurrence('other', 'C楼另一供油控制柜', title('13531'), '2026-09-11T05:20:00Z', 3),
      occurrence('other-device', 'C楼供油控制柜', '供油控制柜故障21V-HD7FOC-SJ-20260911-13535', '2026-09-11T05:20:00Z', 3),
      occurrence('building', 'D楼供油控制柜', title('13532'), '2026-09-11T05:20:00Z', 3),
      occurrence('unknown-a', '', title('13533'), '2026-09-11T05:20:00Z', 3),
      occurrence('unknown-b', '', title('13534'), '2026-09-11T05:21:00Z', 3),
    ]).records;
    const groups = groupEventTimingAnomalies(records);
    expect(groups).toHaveLength(7);
    const clustered = groups.find((row) => row.id === 'slow');
    expect(clustered?.title).toBe('供油控制柜故障');
    expect(clustered?.groupedEvents?.map((item) => item.code)).toEqual([
      'first',
      'slow',
      'last',
    ]);
    expect(clustered?.tags).toEqual(['处理异常', '响应超时']);
    expect(assessmentFilter(groups, '处理异常')).toHaveLength(7);
    expect(assessmentFilter(groups, '处理异常', 'first')).toContain(clustered);
  });
  it('巡检正常0异常不是异常；跨日延迟提交、待提交和取消分别处理', () => {
    const common = {
      计划区间: '2026/09/12 22:00-2026/09/13 00:00',
      楼栋: 'B楼',
    };
    const rows = mapAssessment(
      'inspection',
      [
        input('a', {
          ...common,
          自动编码: 'a',
          工单状态: '完成',
          巡检结果: '总:18 正常:18 异常:0',
          提交时间: '2026/09/13 00:00',
        }),
        input('b', {
          ...common,
          自动编码: 'b',
          工单状态: '完成',
          巡检结果: '总:18 正常:17 异常:1',
          提交时间: '2026/09/13 00:01',
        }),
        input('c', { ...common, 自动编码: 'c', 工单状态: '待巡检' }),
        input('d', { ...common, 自动编码: 'd', 工单状态: '已取消' }),
      ],
      Date.parse('2026-09-14T00:00:00+08:00'),
    ).records;
    expect(rows.map((r) => r.tags)).toEqual([
      [],
      ['巡检异常', '延迟提交'],
      ['超期待提交'],
      [],
    ]);
    expect(rows[1].date).toBe('2026-09-12');
    expect(assessmentFilter(rows, '延迟提交', 'not found')).toHaveLength(0);
  });
  it('巡检异常保留源表原因，超期待提交定位班次及截止时间，未填写原因不伪造', () => {
    const rows = mapAssessment(
      'inspection',
      [
        input('abnormal', {
          自动编码: 'X-01',
          工单名称: '南通C楼暖通巡检',
          楼栋: 'C楼',
          班次: '夜班',
          计划区间: '2026/09/11 20:00-2026/09/12 08:00',
          提交时间: '2026/09/12 07:00',
          异常标: '异常',
          巡检结果: '总:221 正常:220 异常:1',
          异常描述: '冷机压力偏高',
          创建人: '不应泄露',
        }),
        input('overdue', {
          自动编码: 'X-02',
          工单名称: '南通B楼日常巡检',
          楼栋: 'B楼',
          班次: '白班',
          计划区间: '2026/09/13 08:00-2026/09/13 20:00',
          工单状态: '待巡检',
          异常标: '异常',
          巡检结果: '总:18 正常:18 异常:0',
        }),
      ],
      Date.parse('2026-09-14T00:00:00+08:00'),
    ).records;
    expect(rows[0].detail).toEqual(
      expect.arrayContaining([
        { label: '班次', value: '夜班' },
        { label: '异常原因', value: '异常描述：冷机压力偏高' },
      ]),
    );
    expect(rows[1].tags).toEqual(['巡检异常', '超期待提交']);
    expect(rows[1].detail).toEqual(
      expect.arrayContaining([
        { label: '班次', value: '白班' },
        { label: '计划截止', value: '2026-09-13T12:00:00.000Z' },
        { label: '提交情况', value: '计划截止后仍未提交' },
      ]),
    );
    expect(rows[1].detail.find((d) => d.label === '异常原因')?.value).toContain(
      '0 项异常',
    );
    expect(JSON.stringify(rows)).not.toContain('不应泄露');
  });
});
