import { mapMonthlyAlarms } from '../../server/modules/bitable-sync/monthly-operations-alarms.model';
import {
  repeatAlarms,
  alarmGroups,
} from '../../client/src/pages/MonthlyOperations/alarm-model';
const record = (id: string, fields: Record<string, unknown> = {}) => ({
  record_id: id,
  fields: {
    等级: '重要',
    楼栋: 'A楼',
    监控对象: '温度测点',
    具体位置: 'A-101',
    告警内容: '温度高',
    产生时间: '2026-09-10 08:00:00',
    ...fields,
  },
});
describe('月览告警口径', () => {
  it('有效等级非空，未确认独立于受理状态，描述标签异常独立于预期分类', () => {
    const { records } = mapMonthlyAlarms([
      record('blank', { 等级: ' ' }),
      record('processed', {
        '受理状态（公式）': '已处理',
        '预期外/预期内': '预期内',
        受理描述: '【维护】计划保养',
        确认描述: '【维护】计划保养完成',
      }),
      record('unprocessed', {
        产生时间: '2026-09-11',
        处理状态: '未处理',
        确认时间: '2026-09-11 09:00',
      }),
    ]);
    expect(records).toHaveLength(2);
    expect(records[0].tags).toContain('未确认');
    expect(records[0].tags).not.toContain('未处理');
    expect(records[0].tags).not.toContain('打标异常');
    expect(records[1].tags).toEqual(
      expect.arrayContaining(['未处理', '未处理且未恢复']),
    );
    expect(records[1].tags).not.toContain('打标异常');
    expect(records[1].tags).not.toContain('未确认');
  });
  it('与近日告警使用同一套描述标签规则', () => {
    const rows = mapMonthlyAlarms([
      record('missing', { 具体位置: 'A-101', 处理状态: '已处理', 受理描述: '', 确认描述: '' }),
      record('vague', {
        具体位置: 'A-102',
        处理状态: '已处理',
        受理描述: '【设备故障】人员已去现场查看',
        确认描述: '【设备故障】手动开启均充后，电池电压恢复正常',
      }),
      record('explained', {
        具体位置: 'A-103',
        处理状态: '已处理',
        受理描述: '【设备故障】人员已去现场',
        确认描述: '【设备故障】现场确认燃油自控系统故障',
      }),
    ]).records;
    expect(rows[0].tagIssues.map((issue) => issue.code)).toEqual(['missing', 'missing']);
    expect(rows[1].tagIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vague', side: 'acceptance' }),
    ]));
    expect(rows[2].tagIssues).toEqual([]);
    expect(rows.map((row) => row.tags.includes('打标异常'))).toEqual([true, true, false]);
  });
  it('0至5分钟含端点，反向恢复时间不计入；48小时按截止时间判断', () => {
    const now = Date.parse('2026-09-12T08:00:00+08:00');
    const rows = mapMonthlyAlarms(
      [
        record('zero', {
          恢复时间: '2026-09-10 08:00',
          '预期外/预期内': '预期外',
        }),
        record('five', {
          具体位置: 'A-102',
          恢复时间: '2026-09-10 08:05',
          '预期外/预期内': '预期外',
        }),
        record('reverse', {
          具体位置: 'A-103',
          恢复时间: '2026-09-10 07:59',
          '预期外/预期内': '预期外',
        }),
        record('48h', { 具体位置: 'A-104' }),
        record('less', { 具体位置: 'A-105', 产生时间: '2026-09-10 08:00:01' }),
      ],
      now,
    ).records;
    expect(
      rows.filter((r) => r.tags.includes('预期外5分钟内恢复')).map((r) => r.id),
    ).toEqual(['zero', 'five']);
    expect(rows[3].tags).toContain('未恢复超过48小时');
    expect(rows[4].tags).not.toContain('未恢复超过48小时');
  });
  it('同点同时间重复同步去重，不同时间算复发，不同设备与位置不混合', () => {
    const rows = mapMonthlyAlarms([
      record('first'),
      record('duplicate'),
      record('repeat', { 产生时间: '2026-09-11 08:00' }),
      record('different', { 监控对象: '另一测点' }),
      record('missing1', { 监控对象: '' }),
      record('missing2', { 监控对象: '', 产生时间: '2026-09-11 08:00' }),
    ]).records;
    expect(rows).toHaveLength(5);
    const groups = repeatAlarms(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
    expect(groups[0].latest.id).toBe('repeat');
    expect(alarmGroups(rows, 'level')).toEqual([{ name: '重要', value: 5 }]);
  });
  it('缺日期不编造，敏感人员字段不投影', () => {
    const result = mapMonthlyAlarms([
      record('bad', { 产生时间: '无', 确认人: 'private' }),
      record('ok', { 确认人: 'private' }),
    ]);
    expect(result.invalid).toBe(1);
    expect(JSON.stringify(result)).not.toContain('private');
  });
});
