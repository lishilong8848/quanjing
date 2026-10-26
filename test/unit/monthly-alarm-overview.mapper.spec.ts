import { mapMonthlyAlarmOverview } from '../../server/modules/risk-inspection/monthly-alarm-overview.mapper';

describe('月度告警总览映射', () => {
  it('uses the source record identity for year and keeps summary and detail apart', () => {
    const records = mapMonthlyAlarmOverview([
      { record_id: 'summary', fields: {
        序号: 'ALARM-202609-summary-1', 月度: '9月', 标题: '周告警恢复情况',
        楼栋: ['A'], 类型: ['告警总数'], 数量: '948',
      } },
      { record_id: 'detail', fields: {
        序号: 'ALARM-202609-detail-2', 月度: '9月', 标题: '月度预期外告警描述',
        楼栋: ['A'], 数量: '2', 告警分析: '设备告警已确认', 是否闭环: ['否'],
      } },
      { record_id: 'blank', fields: { 序号: 'ALARM-202609-empty', 月度: '9月' } },
      { record_id: 'evidence', fields: {
        序号: 'ALARM-202609-event-1', 标题: '告警打标规范性', 楼栋: 'D',
        日期: '1789459795000', 问题: '打标错误',
        备注截图: [{ file_token: 'private-token', name: '标记.png', type: 'image/png' }],
      } },
    ]);

    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ month: '2026-09', building: 'A', metric: '告警总数', quantity: 948 });
    expect(records[1]).toMatchObject({ month: '2026-09', section: '月度预期外告警描述', quantity: 2, closed: '否' });
    expect(records[2]).toMatchObject({ date: '2026-09-15 16:09:55', problem: '打标错误', images: [{
      name: '标记.png', mimeType: 'image/png', url: '/api/risk-inspection/monthly-alarm-overview/evidence/evidence/0',
    }] });
    expect(JSON.stringify(records)).not.toContain('private-token');
  });
});
