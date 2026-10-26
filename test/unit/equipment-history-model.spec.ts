import {
  matchEquipmentRepair,
  mapEquipmentRepair,
} from '../../server/modules/equipment-lifecycle/equipment-history.model';
import { mapLedgerRecords } from '../../server/modules/equipment-lifecycle/equipment-ledger.model';

const ledger = (quantity: number | null = 1) =>
  mapLedgerRecords([
    {
      record_id: 'asset-a',
      fields: {
        机楼: 'A楼',
        设备编号: 'A-311-CRAH-01',
        设备名称: '水冷空调',
        数量: quantity,
      },
    },
  ]);
const repair = (patch: Record<string, unknown> = {}) => ({
  record_id: 'repair-1',
  fields: {
    维修单号: '20261002-1',
    设备编号: 'A-311-CRAH-01',
    '设备编号-L': 'A-311-CRAH-01',
    设备名称: '水冷型精密空调',
    '所属数据中心/楼栋-使用': '南通A楼',
    流程: '维修完成',
    台账关联状态: '已关联',
    关联台账记录ID: 'asset-a',
    ...patch,
  },
});

describe('two-table equipment repair identity', () => {
  it('matches only the uniquely identified single device', () =>
    expect(
      matchEquipmentRepair(ledger(), [repair()]).get('repair-1')?.assetId,
    ).toBe('asset-a'));
  it.each([null, 2, 0])('rejects non-single quantity %s', (quantity) =>
    expect(
      matchEquipmentRepair(ledger(quantity), [repair()]).get('repair-1')
        ?.assetId,
    ).toBeNull(),
  );
  it('rejects duplicate same-floor codes', () =>
    expect(
      matchEquipmentRepair(
        [...ledger(), { ...ledger()[0], id: 'duplicate' }],
        [repair()],
      ).get('repair-1')?.assetId,
    ).toBeNull());
  it('does not match another building', () =>
    expect(
      matchEquipmentRepair(ledger(), [
        repair({ '所属数据中心/楼栋-使用': 'B楼' }),
      ]).get('repair-1')?.assetId,
    ).toBeNull());
  it('rejects conflicting formal/legacy identity', () =>
    expect(
      matchEquipmentRepair(ledger(), [
        repair({ '设备编号-L': 'A-311-CRAH-02' }),
      ]).get('repair-1')?.assetId,
    ).toBeNull());
  it('preserves suffixes and leading zeroes', () =>
    expect(
      matchEquipmentRepair(ledger(), [
        repair({ 设备编号: 'A-311-CRAH-1', '设备编号-L': 'A-311-CRAH-1' }),
      ]).get('repair-1')?.assetId,
    ).toBeNull());
  it('rejects a conflicting equipment name', () =>
    expect(
      matchEquipmentRepair(ledger(), [repair({ 设备名称: '风扇' })]).get(
        'repair-1',
      )?.assetId,
    ).toBeNull());
  it('rejects a different complete equipment tag in fault text', () =>
    expect(
      matchEquipmentRepair(ledger(), [
        repair({ '故障发生现象描述-L': 'A-312-CRAH-01压力表故障' }),
      ]).get('repair-1')?.assetId,
    ).toBeNull());
  it('also rejects contradictions in the current fault field', () =>
    expect(
      matchEquipmentRepair(ledger(), [
        repair({ 故障发生现象描述: 'A-312-CRAH-01压力表故障' }),
      ]).get('repair-1')?.assetId,
    ).toBeNull());
  it('does not require CMDB or follow-up records', () =>
    expect(
      matchEquipmentRepair(ledger(), [
        repair({
          CMDB唯一id: [{ id: 'wrong-cmdb' }],
          维修跟进记录: [{ id: 'unused' }],
        }),
      ]).get('repair-1')?.assetId,
    ).toBe('asset-a'));
  it('rejects stale bindings even if the new device number matches', () =>
    expect(
      matchEquipmentRepair(ledger(), [
        repair({ 关联台账记录ID: 'old-asset' }),
      ]).get('repair-1')?.assetId,
    ).toBeNull());
  it('honours a source pending-confirmation decision', () =>
    expect(
      matchEquipmentRepair(ledger(), [repair({ 台账关联状态: '待确认' })]).get(
        'repair-1',
      )?.assetId,
    ).toBeNull());
  it('allows preflight matching before writing binding metadata', () =>
    expect(
      matchEquipmentRepair(
        ledger(),
        [repair({ 台账关联状态: '', 关联台账记录ID: '' })],
        false,
      ).get('repair-1')?.assetId,
    ).toBe('asset-a'));
  it('keeps not-started distinct from completed maintenance', () =>
    expect(mapEquipmentRepair(repair({ 流程: '未开始' })).status).toBe(
      '未开始',
    ));
  it('does not promote a missing current status from the legacy status', () =>
    expect(
      mapEquipmentRepair(repair({ 流程: undefined, '流程-L': '维修完成' }))
        .status,
    ).toBe('待确认'));
  it('does not invent a date from record creation time', () =>
    expect(
      mapEquipmentRepair(repair({ 创建时间: '2026-10-02' })).faultAt,
    ).toBeNull());
});
