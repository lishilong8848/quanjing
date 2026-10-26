import { EquipmentHistoryService } from '../../server/modules/equipment-lifecycle/equipment-history.service';
import { mapLedgerRecords } from '../../server/modules/equipment-lifecycle/equipment-ledger.model';
const asset = mapLedgerRecords([
  {
    record_id: 'a',
    fields: { 机楼: 'A楼', 设备编号: 'A-311-UPS-01', 设备名称: 'UPS', 数量: 1 },
  },
])[0];
const records = [
  {
    record_id: 'r',
    fields: {
      '所属数据中心/楼栋-使用': 'A楼',
      设备编号: 'A-311-UPS-01',
      设备名称: 'UPS',
      台账关联状态: '已关联',
      关联台账记录ID: 'a',
      流程: '未开始',
    },
  },
];
const make = () => {
  const ledger = {
    getItems: jest.fn().mockResolvedValue({ items: [asset] }),
    getDashboardState: jest
      .fn()
      .mockResolvedValue({ refreshing: false, dashboard: { stale: false } }),
    getHistoryAssets: jest
      .fn()
      .mockResolvedValue({ assets: [asset], snapshotId: 'l1', stale: false }),
  };
  const repairs = {
    getState: jest
      .fn()
      .mockResolvedValue({
        snapshot: { version: 'r1', fetchedAt: Date.now(), records },
        refreshing: false,
        stale: false,
        error: '',
      }),
  };
  return {
    ledger,
    repairs,
    service: new EquipmentHistoryService(ledger as never, repairs as never),
  };
};
describe('device history scope and freshness', () => {
  it('lists only confirmed devices in the trusted floor and separates completed repairs', async () => {
    const { ledger, service } = make();
    ledger.getHistoryAssets.mockResolvedValue({ assets: [asset, { ...asset, id: 'b', building: 'B楼' }], snapshotId: 'l1', stale: false });
    const response = await (service as unknown as { getDevices: (building: string) => Promise<any> }).getDevices('A楼');
    expect(response.status).toBe('ready');
    expect(response.devices).toHaveLength(1);
    expect(response.devices[0]).toMatchObject({ asset: { id: 'a', building: 'A楼' }, count: 1, completed: 0, pending: 1 });
  });

  it('does not enumerate repairs while the ledger identity is untrusted', async () => {
    const { ledger, repairs, service } = make();
    ledger.getDashboardState.mockResolvedValue({ refreshing: true, dashboard: { stale: true } });
    const response = await (service as unknown as { getDevices: (building: string) => Promise<any> }).getDevices('A楼');
    expect(response.status).toBe('loading');
    expect(response.devices).toEqual([]);
    expect(repairs.getState).not.toHaveBeenCalled();
  });
  it('rejects a building move between authorization and reading the identity snapshot', async () => {
    const { ledger, repairs, service } = make();
    ledger.getHistoryAssets.mockResolvedValue({
      assets: [{ ...asset, building: 'B楼' }],
      snapshotId: 'l2',
      stale: false,
    });
    await expect(service.getState('a', 'A楼')).rejects.toThrow('无查看权限');
    expect(repairs.getState).not.toHaveBeenCalled();
  });
  it('does not read repairs when the device is outside the first scoped lookup', async () => {
    const { ledger, repairs, service } = make();
    ledger.getItems.mockResolvedValue({ items: [] });
    await expect(service.getState('a', 'B楼')).rejects.toThrow('无查看权限');
    expect(repairs.getState).not.toHaveBeenCalled();
  });
  it('stops mounting history when a persisted device identity is stale', async () => {
    const { ledger, repairs, service } = make();
    ledger.getHistoryAssets.mockResolvedValue({
      assets: [asset],
      snapshotId: 'l1',
      stale: true,
    });
    expect((await service.getState('a', 'A楼')).status).toBe('error');
    expect(repairs.getState).not.toHaveBeenCalled();
  });
  it('revalidates source and ledger changes instead of reusing an obsolete association', async () => {
    const { ledger, service } = make();
    expect((await service.getState('a', null)).items).toHaveLength(1);
    ledger.getHistoryAssets.mockResolvedValue({
      assets: [{ ...asset, quantity: 2 }],
      snapshotId: 'l2',
      stale: false,
    });
    expect((await service.getState('a', null)).items).toHaveLength(0);
  });
  it('keeps records with unknown fault time separate from a fabricated event date', async () => {
    const { service } = make();
    const response = await service.getState('a', null);
    expect(response.items[0].status).toBe('未开始');
    expect(response.items[0].faultAt).toBeNull();
  });
});
