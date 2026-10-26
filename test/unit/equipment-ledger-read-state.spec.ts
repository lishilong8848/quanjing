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

describe('equipment ledger nonblocking read state', () => {
  const records = [
    { record_id: 'a', fields: { 机楼: 'A楼', 设备名称: 'UPS' } },
  ];
  const makeService = () =>
    new EquipmentLedgerService(
      {} as HttpService,
      {} as EquipmentLifecycleService,
    );
  beforeEach(() => {
    jest.clearAllMocks();
    (readLatestPersistedBitableRecordSnapshot as jest.Mock).mockResolvedValue(
      null,
    );
  });

  it('does not relabel an expired persisted source as fresh while shared-cache refresh is still pending', async () => {
    (readLatestPersistedBitableRecordSnapshot as jest.Mock).mockResolvedValue({
      records,
      fetchedAt: Date.now() - 5 * 60 * 60 * 1000,
    });
    let finish!: (value: typeof records) => void;
    (fetchBitableRecords as jest.Mock).mockImplementation((_http, options) =>
      options.allowStale === false
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(records),
    );
    const service = makeService();
    await service.getDashboardState();
    await new Promise((resolve) => setImmediate(resolve));
    const during = await service.getDashboardState();
    expect(during.refreshing).toBe(true);
    expect(during.dashboard?.stale).toBe(true);
    finish([
      ...records,
      { record_id: 'b', fields: { 机楼: 'A楼', 设备名称: '空调' } },
    ]);
    await service.getDashboard(true);
    expect(
      (await service.getDashboardState()).dashboard?.overview.metrics.total,
    ).toBe(2);
  });

  it('uses inventory background warmup and four-hour refresh, then releases its timers', async () => {
    jest.useFakeTimers();
    (fetchBitableRecords as jest.Mock).mockResolvedValue(records);
    const service = makeService();
    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
      expect(fetchBitableRecords).toHaveBeenCalledTimes(2);
      service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
      expect(fetchBitableRecords).toHaveBeenCalledTimes(2);
    } finally {
      service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('returns loading before a cold full-source read completes and coalesces polling', async () => {
    let finish!: (value: typeof records) => void;
    (fetchBitableRecords as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const service = makeService();
    const first = await service.getDashboardState();
    expect(first).toMatchObject({ status: 'loading', dashboard: null });
    await service.getDashboardState();
    expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
    finish(records);
    await service.getDashboard();
    expect(await service.getDashboardState()).toMatchObject({
      status: 'ready',
      refreshing: false,
      dashboard: { overview: { metrics: { total: 1 } } },
    });
  });

  it('ends failed cold reads with an actionable error and permits one explicit retry', async () => {
    (fetchBitableRecords as jest.Mock).mockRejectedValue(new Error('offline'));
    const service = makeService();
    await service.getDashboardState();
    await expect(service.getDashboard()).rejects.toThrow();
    expect(await service.getDashboardState()).toMatchObject({
      status: 'error',
      dashboard: null,
    });
    expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
    (fetchBitableRecords as jest.Mock).mockResolvedValue(records);
    await service.getDashboardState(true);
    await service.getDashboard();
    expect(
      (await service.getDashboardState()).dashboard?.overview.metrics.total,
    ).toBe(1);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(2);
  });

  it('keeps the good snapshot visible during a slow explicit refresh', async () => {
    (fetchBitableRecords as jest.Mock).mockResolvedValue(records);
    const service = makeService();
    const original = await service.getDashboard();
    let finish!: (value: typeof records) => void;
    (fetchBitableRecords as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = await service.getDashboardState(true);
    expect(pending).toMatchObject({
      status: 'ready',
      refreshing: true,
      dashboard: { snapshotId: original.snapshotId },
    });
    finish(records);
    await service.getDashboard(true);
    await Promise.resolve();
    expect((await service.getDashboardState()).refreshing).toBe(false);
  });

  it('uses the previous projection after an upgrade without trusting incomplete repair identities', async () => {
    (readLatestPersistedBitableRecordSnapshot as jest.Mock).mockImplementation(
      async (options) => options.fieldNames.includes('楼栋标识') ? null : {
        records, fetchedAt: Date.now(), expiresAt: Date.now() + 3600000,
      },
    );
    let finish!: (value: typeof records) => void;
    (fetchBitableRecords as jest.Mock).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const service = makeService();
    const first = await service.getDashboardState();
    expect(first.status).toBe('ready');
    expect(first.dashboard?.overview.metrics.total).toBe(1);
    expect(first.dashboard?.stale).toBe(true);
    expect((await service.getHistoryAssets()).stale).toBe(true);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
    expect((readLatestPersistedBitableRecordSnapshot as jest.Mock).mock.calls.every(([o]) => o.directOnly === true)).toBe(true);
    finish(records);
    await service.getDashboard(true);
    expect((await service.getHistoryAssets()).stale).toBe(false);
  });

  it('restores disk data even when the first request explicitly refreshes', async () => {
    (readLatestPersistedBitableRecordSnapshot as jest.Mock).mockResolvedValue({ records, fetchedAt: Date.now() });
    let finish!: (value: typeof records) => void;
    (fetchBitableRecords as jest.Mock).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const service = makeService();
    let result: Awaited<ReturnType<typeof service.getItems>> | undefined;
    const request = service.getDashboard(true);
    await new Promise((resolve) => setImmediate(resolve));
    const items = service.getItems({}).then((page) => { result = page; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(result?.total).toBe(1);
    finish(records);
    await Promise.all([request, items]);
  });
});
