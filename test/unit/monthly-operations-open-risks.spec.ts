import { mapOpenRisks } from '../../server/modules/bitable-sync/monthly-operations-open-risks.model';

describe('月览 OPEN 风险项', () => {
  const open = (id: string, building: string, code: string) => ({
    record_id: id,
    fields: {
      楼栋名称: `南通${building}`,
      风险项编号: code,
      风险等级: '中',
      检查项_描述: '检查设备状态',
    },
  });
  const inspection = (id: string, building: string, code: string, created: string) => ({
    record_id: id,
    fields: {
      楼栋: building,
      风险编号: code,
      排查状态: '已排查',
      当前风险状态: 'OPEN',
      记录创建时间: Date.parse(created),
    },
  });
  it('仅按楼栋与风险编号关联所选周期的排查，不串楼也不把历史记录当本月', () => {
    const rows = mapOpenRisks(
      [open('a', 'A楼', 'JS-JZ-FS-3'), open('b', 'B楼', 'JS-JZ-FS-3')],
      [
        inspection('old', 'A楼', 'JS-JZ-FS-3', '2026-08-15T08:00:00+08:00'),
        inspection('current', 'B楼', 'JS-JZ-FS-3', '2026-09-15T08:00:00+08:00'),
      ],
      '2026-09-01',
      '2026-09-18',
    );
    expect(rows.map((r) => [r.building, r.inspectionStatus, r.inspectionId])).toEqual([
      ['A楼', '本月未排查', null],
      ['B楼', '已排查', 'current'],
    ]);
  });
});
