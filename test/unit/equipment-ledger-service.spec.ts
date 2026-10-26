jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
  resolveBitableAppToken: jest.fn().mockResolvedValue('test-base'),
  readLatestPersistedBitableRecordSnapshot: jest.fn().mockResolvedValue(null),
}));
import { EquipmentLedgerService } from '../../server/modules/equipment-lifecycle/equipment-ledger.service';
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
} from '../../server/common/feishu/bitable-direct-read';
import type { HttpService } from '@nestjs/axios';
import type { EquipmentLifecycleService } from '../../server/modules/equipment-lifecycle/equipment-lifecycle.service';

describe('equipment ledger service snapshots', () => {
  const records = [
    {
      record_id: 'a',
      fields: {
        机楼: 'A楼',
        设备名称: 'UPS',
        设备编号: 'A01',
        型号: 'X1',
        维保截止日期: '2099-01-01',
      },
    },
  ];
  const lifecycle = { getDashboard: jest.fn() };
  beforeEach(() => {
    jest.clearAllMocks();
    (fetchBitableRecords as jest.Mock).mockResolvedValue(records);
    (readLatestPersistedBitableRecordSnapshot as jest.Mock).mockResolvedValue(
      null,
    );
  });
  const service = () =>
    new EquipmentLedgerService(
      {} as HttpService,
      lifecycle as unknown as EquipmentLifecycleService,
    );

  it('coalesces concurrent reads and serves filters from one source snapshot', async () => {
    const s = service();
    const [a, b] = await Promise.all([
      s.getDashboard(),
      s.getItems({ building: 'A楼' }),
    ]);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
    expect(a.snapshotId).toBe(b.snapshotId);
    expect(a.overview.metrics.total).toBe(b.total);
    await s.getItems({ model: 'X1' });
    expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
    expect(lifecycle.getDashboard).not.toHaveBeenCalled();
  });
  it('preserves a good snapshot on forced refresh failure and marks it stale', async () => {
    const s = service();
    await s.getDashboard();
    (fetchBitableRecords as jest.Mock).mockRejectedValue(new Error('offline'));
    const result = await s.getDashboard(true);
    expect(result.stale).toBe(true);
    expect(result.overview.metrics.total).toBe(1);
  });
  it('rejects unavailable first reads rather than returning zero', async () => {
    (fetchBitableRecords as jest.Mock).mockRejectedValue(new Error('offline'));
    await expect(service().getDashboard()).rejects.toThrow(
      '设备台账暂时不可用',
    );
  });
  it('loads lifecycle independently and propagates its failure', async () => {
    lifecycle.getDashboard.mockRejectedValue(
      new Error('maintenance unavailable'),
    );
    const s = service();
    expect((await s.getDashboard()).overview.metrics.total).toBe(1);
    await expect(s.getLifecycle()).rejects.toThrow('maintenance unavailable');
  });
  it('renders an existing persistent cache before a slow live refresh completes', async () => {
    (readLatestPersistedBitableRecordSnapshot as jest.Mock).mockResolvedValue({
      records,
      fetchedAt: Date.now() - 5 * 60 * 60 * 1000,
    });
    let finish!: (rows: typeof records) => void;
    (fetchBitableRecords as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const s = service();
    const result = await s.getDashboard();
    expect(result.stale).toBe(true);
    expect((await s.getItems({})).items).toHaveLength(1);
    finish(records);
    expect((await s.getDashboard(true)).stale).toBe(false);
  });

  it.each([
    { records: [null, ...records], fetchedAt: Date.now() },
    { records, fetchedAt: 1e20 },
  ])(
    'discards malformed warm caches and recovers through a live read: %j',
    async (cache) => {
      (readLatestPersistedBitableRecordSnapshot as jest.Mock).mockResolvedValue(
        cache,
      );
      const s = service();
      const result = await s.getDashboard();
      expect(result.overview.metrics.total).toBe(1);
      expect(result.stale).toBe(false);
      expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
    },
  );

  it('reports unavailable rather than trusting a malformed fallback cache', async () => {
    (readLatestPersistedBitableRecordSnapshot as jest.Mock).mockResolvedValue({
      records: [null, ...records],
      fetchedAt: Date.now(),
    });
    (fetchBitableRecords as jest.Mock).mockRejectedValue(new Error('offline'));
    await expect(service().getDashboard()).rejects.toThrow(
      '设备台账暂时不可用',
    );
  });
});
