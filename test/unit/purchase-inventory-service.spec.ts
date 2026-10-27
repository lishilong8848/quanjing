jest.mock(
  '@server/common/config/external-services.config',
  () =>
    jest.requireActual('../../server/common/config/external-services.config'),
  { virtual: true },
);

jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  resolveBitableAppToken: jest.fn().mockResolvedValue('app-token'),
  fetchBitableRecords: jest.fn().mockResolvedValue([]),
}));

import {
  fetchBitableRecords,
  resolveBitableAppToken,
} from '../../server/common/feishu/bitable-direct-read';
import { PurchaseInventoryService } from '../../server/modules/purchase-inventory/purchase-inventory.service';

const ENV_KEYS = [
  'FEISHU_PURCHASE_INVENTORY_SOURCE_URL',
  'FEISHU_PURCHASE_SUBMISSION_TABLE_ID',
  'FEISHU_PURCHASE_EXECUTION_TABLE_ID',
  'FEISHU_ITEM_CATEGORY_TABLE_ID',
  'FEISHU_INVENTORY_LEDGER_TABLE_ID',
  'FEISHU_INBOUND_TABLE_ID',
  'FEISHU_OUTBOUND_TABLE_ID',
  'FEISHU_ACTIVE_EMPLOYEE_SOURCE_URL',
  'FEISHU_ACTIVE_EMPLOYEE_TABLE_ID',
  'FEISHU_ACTIVE_EMPLOYEE_VIEW_ID',
] as const;

describe('PurchaseInventoryService', () => {
  const originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    (resolveBitableAppToken as jest.Mock).mockResolvedValue('app-token');
    (fetchBitableRecords as jest.Mock).mockResolvedValue([]);
    process.env.FEISHU_PURCHASE_INVENTORY_SOURCE_URL =
      'https://vnet.feishu.cn/wiki/SiW9wuy9DiIsykkTkNUcM0HfnSb';
    process.env.FEISHU_PURCHASE_SUBMISSION_TABLE_ID = 'tblIfmOB4VTUMmMh';
    process.env.FEISHU_PURCHASE_EXECUTION_TABLE_ID = 'tblKmajonrdwW7Z0';
    process.env.FEISHU_ITEM_CATEGORY_TABLE_ID = 'tblhdbfhazvxIlmX';
    process.env.FEISHU_INVENTORY_LEDGER_TABLE_ID = 'tblXXobhAGwvQc4r';
    process.env.FEISHU_INBOUND_TABLE_ID = 'tblSAt65HQJUthlY';
    process.env.FEISHU_OUTBOUND_TABLE_ID = 'tble4MtOm1QD4sUG';
    process.env.FEISHU_ACTIVE_EMPLOYEE_SOURCE_URL =
      'https://vnet.feishu.cn/wiki/AdQmwOqwei6Xr4kag3pcp1Flnmg';
    process.env.FEISHU_ACTIVE_EMPLOYEE_TABLE_ID = 'tblOu75UtJTDNHIM';
    process.env.FEISHU_ACTIVE_EMPLOYEE_VIEW_ID = 'vewrQcypV4';
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('reads all configured purchase tables and the active employee table on refresh', async () => {
    const service = new PurchaseInventoryService({ axiosRef: {} } as never);
    const result = await service.getDashboard(true);

    expect(fetchBitableRecords).toHaveBeenCalledTimes(6);
    expect(fetchBitableRecords).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tableId: 'tblIfmOB4VTUMmMh' }),
    );
    expect(
      (fetchBitableRecords as jest.Mock).mock.calls.map(
        (call) => call[1].tableId,
      ),
    ).toEqual(
      expect.arrayContaining([
        'tblKmajonrdwW7Z0',
        'tblhdbfhazvxIlmX',
        'tblXXobhAGwvQc4r',
        'tblSAt65HQJUthlY',
        'tble4MtOm1QD4sUG',
        'tblOu75UtJTDNHIM',
      ]),
    );
    expect(fetchBitableRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tableId: 'tblOu75UtJTDNHIM',
        viewId: 'vewrQcypV4',
        tableName: '在职人员',
        forceRefresh: true,
      }),
    );
    expect(
      (fetchBitableRecords as jest.Mock).mock.calls.every(
        (call) => call[1].allowStale === false && call[1].strict === true,
      ),
    ).toBe(true);
    expect(result.refreshState).toBe('fresh');
    expect(result.sectionStatus.outbound).toEqual({
      configured: true,
      count: 0,
    });
    expect(result.sectionStatus.submissions).toBe(
      result.sectionStatus.executions,
    );
  });

  it('reuses the mapped dashboard until a force refresh replaces it', async () => {
    const service = new PurchaseInventoryService({ axiosRef: {} } as never);

    const first = await service.getDashboard(false);
    const second = await service.getDashboard(false);

    expect(second).toBe(first);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(6);

    const refreshed = await service.getDashboard(true);
    expect(refreshed).not.toBe(first);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(12);
  });

  it('invalidates the dashboard and prevents an older in-flight read from restoring stale cache', async () => {
    const staleGate = deferred<void>();
    let calls = 0;
    (fetchBitableRecords as jest.Mock).mockImplementation(
      async (_httpService, options: { tableId: string }) => {
        calls += 1;
        const staleBatch = calls <= 6;
        if (staleBatch) await staleGate.promise;
        if (options.tableId !== 'tblKmajonrdwW7Z0') return [];
        return [
          executionRecord(
            staleBatch ? 'stale-execution' : 'fresh-execution',
            '未开始（待审批）',
          ),
        ];
      },
    );
    const service = new PurchaseInventoryService({ axiosRef: {} } as never);
    const staleRead = service.getDashboard(false);
    await waitFor(() => calls === 6);

    service.invalidateCache();
    const fresh = await service.getDashboard(false);
    staleGate.resolve();
    await staleRead;
    const cached = await service.getDashboard(false);

    expect(fresh.requests.map((item) => item.recordId)).toEqual([
      'fresh-execution',
    ]);
    expect(cached).toBe(fresh);
    expect(calls).toBe(12);
  });

  it('refreshes only active execution rows while retaining the completed snapshot', async () => {
    const activeBefore = executionRecord('active-before', '未开始（待审批）');
    const completed = executionRecord('completed-1', '采购完成（已入库）');
    const activeAfter = executionRecord('active-after', '未开始（待审批）');
    (fetchBitableRecords as jest.Mock).mockImplementation(
      async (_httpService, options: { tableId: string; filter?: unknown }) => {
        if (options.tableId !== 'tblKmajonrdwW7Z0') return [];
        return options.filter ? [activeAfter] : [activeBefore, completed];
      },
    );
    const service = new PurchaseInventoryService({ axiosRef: {} } as never);
    await service.getDashboard(false);

    const refreshed = await service.getDashboard('active' as never);

    expect(fetchBitableRecords).toHaveBeenCalledTimes(7);
    expect(fetchBitableRecords).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        tableId: 'tblKmajonrdwW7Z0',
        cacheTtlMs: 10_000,
        filter: {
          conjunction: 'and',
          conditions: [
            {
              field_name: '采购流程',
              operator: 'isNot',
              value: ['采购完成（已入库）'],
            },
          ],
        },
      }),
    );
    expect(refreshed.requests.map((item) => item.recordId).sort()).toEqual([
      'active-after',
      'completed-1',
    ]);
    expect(refreshed.summary.stageCounts).toMatchObject({
      approval: 1,
      stocked: 1,
    });
  });

  it('keeps the active source cache shorter than the 15-second browser polling interval', async () => {
    const baseNow = 1_800_000_000_000;
    let now = baseNow;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    let activeCacheExpiresAt = 0;
    let activeCacheRecords: ReturnType<typeof executionRecord>[] = [];
    let externalActiveReads = 0;
    try {
      (fetchBitableRecords as jest.Mock).mockImplementation(
        async (
          _httpService,
          options: {
            tableId: string;
            filter?: unknown;
            cacheTtlMs?: number;
          },
        ) => {
          if (options.tableId !== 'tblKmajonrdwW7Z0' || !options.filter) {
            return [];
          }
          if (activeCacheExpiresAt > now) return activeCacheRecords;
          externalActiveReads += 1;
          now += 250;
          activeCacheRecords = [
            executionRecord(
              `active-poll-${externalActiveReads}`,
              '未开始（待审批）',
            ),
          ];
          activeCacheExpiresAt = now + (options.cacheTtlMs || 0);
          return activeCacheRecords;
        },
      );
      const service = new PurchaseInventoryService({ axiosRef: {} } as never);
      await service.getDashboard(false);

      now = baseNow + 15_000;
      await service.getDashboard('active');
      now = baseNow + 30_000;
      const secondPoll = await service.getDashboard('active');

      expect(externalActiveReads).toBe(2);
      expect(secondPoll.requests.map((item) => item.recordId)).toContain(
        'active-poll-2',
      );
      const activeCalls = (fetchBitableRecords as jest.Mock).mock.calls.filter(
        ([, options]) => Boolean(options.filter),
      );
      expect(activeCalls).toHaveLength(2);
      expect(
        activeCalls.every(([, options]) => options.cacheTtlMs < 15_000),
      ).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps the successful sections and marks the dashboard partial when one section refresh fails', async () => {
    const existing = executionRecord('existing-active', '未开始（待审批）');
    (fetchBitableRecords as jest.Mock).mockImplementation(
      async (_httpService, options: { tableId: string }) =>
        options.tableId === 'tblKmajonrdwW7Z0' ? [existing] : [],
    );
    const service = new PurchaseInventoryService({ axiosRef: {} } as never);
    const first = await service.getDashboard(false);

    (fetchBitableRecords as jest.Mock).mockImplementation(
      async (_httpService, options: { tableId: string }) => {
        if (options.tableId === 'tblKmajonrdwW7Z0') {
          throw new Error('temporary Feishu read failure');
        }
        return [];
      },
    );

    const refreshed = await service.getDashboard(true);

    expect(refreshed).not.toBe(first);
    expect(refreshed.requests.map((item) => item.recordId)).toContain(
      'existing-active',
    );
    expect(refreshed.refreshState).toBe('partial');
    expect(refreshed.refreshError).toContain('采购进行读取失败');
    expect(refreshed.sectionStatus.executions.message).toContain('读取失败');
  });

  it('returns an explicit stale snapshot when a forced refresh fails before table reads', async () => {
    const service = new PurchaseInventoryService({ axiosRef: {} } as never);
    const first = await service.getDashboard(false);
    (resolveBitableAppToken as jest.Mock).mockRejectedValueOnce(
      new Error('temporary token failure'),
    );

    const refreshed = await service.getDashboard(true);

    expect(refreshed).not.toBe(first);
    expect(refreshed.requests).toEqual(first.requests);
    expect(refreshed.refreshState).toBe('stale');
    expect(refreshed.refreshError).toContain('采购数据刷新失败');
  });

  it('keeps a catastrophic full-refresh failure visible until a full refresh succeeds', async () => {
    const service = new PurchaseInventoryService({ axiosRef: {} } as never);
    await service.getDashboard(false);
    (resolveBitableAppToken as jest.Mock).mockRejectedValueOnce(
      new Error('temporary token failure'),
    );

    const stale = await service.getDashboard(true);
    const activeRefreshed = await service.getDashboard('active');
    const fullyRefreshed = await service.getDashboard(true);

    expect(stale.refreshState).toBe('stale');
    expect(activeRefreshed.refreshState).toBe('stale');
    expect(activeRefreshed.refreshError).toBe(stale.refreshError);
    expect(fullyRefreshed.refreshState).toBe('fresh');
    expect(fullyRefreshed.refreshError).toBeUndefined();
  });

  it('marks the dashboard partial when the employee directory refresh fails', async () => {
    const service = new PurchaseInventoryService({ axiosRef: {} } as never);
    await service.getDashboard(false);
    (fetchBitableRecords as jest.Mock).mockImplementation(
      async (_httpService, options: { tableId: string }) => {
        if (options.tableId === 'tblOu75UtJTDNHIM') {
          throw new Error('temporary employee read failure');
        }
        return [];
      },
    );

    const refreshed = await service.getDashboard(true);

    expect(refreshed.refreshState).toBe('partial');
    expect(refreshed.refreshError).toContain('在职人员读取失败');
  });

  it('retries a partial employee-directory refresh after the active cache TTL', async () => {
    const baseNow = 1_800_000_000_000;
    let now = baseNow;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    let employeeCacheExpiresAt = 0;
    let employeeCachePresent = false;
    let employeeExternalReads = 0;
    try {
      (fetchBitableRecords as jest.Mock).mockImplementation(
        async (
          _httpService,
          options: {
            tableId: string;
            cacheTtlMs?: number;
            forceRefresh?: boolean;
          },
        ) => {
          if (options.tableId !== 'tblOu75UtJTDNHIM') return [];
          if (
            !options.forceRefresh &&
            employeeCachePresent &&
            employeeCacheExpiresAt > now
          ) {
            return [];
          }
          employeeExternalReads += 1;
          if (employeeExternalReads === 2) {
            now += 250;
            throw new Error('temporary employee read failure');
          }
          employeeCachePresent = true;
          employeeCacheExpiresAt = now + (options.cacheTtlMs || 0);
          return [];
        },
      );
      const service = new PurchaseInventoryService({ axiosRef: {} } as never);
      await service.getDashboard(false);
      const partial = await service.getDashboard(true);
      expect(partial.refreshState).toBe('partial');
      expect(employeeExternalReads).toBe(2);

      now = baseNow + 60_000;
      const retried = await service.getDashboard(false);

      expect(employeeExternalReads).toBe(3);
      expect(retried.refreshState).toBe('fresh');
      const employeeCalls = (
        fetchBitableRecords as jest.Mock
      ).mock.calls.filter(([, options]) =>
        String(options.tableId).includes('tblOu75UtJTDNHIM'),
      );
      expect(employeeCalls.at(-1)?.[1]).toEqual(
        expect.objectContaining({ forceRefresh: true }),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('returns an explicit stale snapshot when the active refresh fails', async () => {
    const service = new PurchaseInventoryService({ axiosRef: {} } as never);
    const first = await service.getDashboard(false);
    (fetchBitableRecords as jest.Mock).mockRejectedValueOnce(
      new Error('temporary active read failure'),
    );

    const refreshed = await service.getDashboard('active');

    expect(refreshed).not.toBe(first);
    expect(refreshed.refreshState).toBe('stale');
    expect(refreshed.refreshError).toContain('进行中数据刷新失败');
  });

  it.each([false, true])(
    'waits for an older in-flight read (force=%s) before starting a new force refresh',
    async (olderReadIsForceRefresh) => {
      let releaseFirstWave!: (value: []) => void;
      const firstWave = new Promise<[]>((resolve) => {
        releaseFirstWave = resolve;
      });
      for (let index = 0; index < 6; index += 1) {
        (fetchBitableRecords as jest.Mock).mockImplementationOnce(
          () => firstWave,
        );
      }
      const service = new PurchaseInventoryService({ axiosRef: {} } as never);

      const olderRead = service.getDashboard(olderReadIsForceRefresh);
      await Promise.resolve();
      await Promise.resolve();
      const forcedRead = service.getDashboard(true);
      expect(fetchBitableRecords).toHaveBeenCalledTimes(6);

      releaseFirstWave([]);
      const olderDashboard = await olderRead;
      const forcedDashboard = await forcedRead;

      if (olderReadIsForceRefresh) {
        expect(forcedDashboard).toBe(olderDashboard);
        expect(fetchBitableRecords).toHaveBeenCalledTimes(6);
      } else {
        expect(forcedDashboard).not.toBe(olderDashboard);
        expect(fetchBitableRecords).toHaveBeenCalledTimes(12);
        expect(fetchBitableRecords).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.objectContaining({ forceRefresh: true }),
        );
      }
    },
  );

  it('waits for an active refresh that crosses the full-cache expiry before rebuilding', async () => {
    let now = 1_800_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const service = new PurchaseInventoryService({ axiosRef: {} } as never);
    await service.getDashboard(false);

    let releaseActive!: (value: []) => void;
    const activeRead = new Promise<[]>((resolve) => {
      releaseActive = resolve;
    });
    (fetchBitableRecords as jest.Mock).mockImplementation(
      async (_httpService, options: { filter?: unknown }) =>
        options.filter ? activeRead : [],
    );
    now += 4 * 60 * 60 * 1000 - 1;
    const activeRefresh = service.getDashboard('active');
    await Promise.resolve();
    await Promise.resolve();
    now += 2;
    const expiredFullRefresh = service.getDashboard(false);

    expect(fetchBitableRecords).toHaveBeenCalledTimes(7);
    releaseActive([]);
    await activeRefresh;
    await expiredFullRefresh;
    expect(fetchBitableRecords).toHaveBeenCalledTimes(13);
    nowSpy.mockRestore();
  });
});

function executionRecord(recordId: string, workflowStatus: string) {
  return {
    record_id: recordId,
    created_time: 1_723_350_000_000,
    fields: {
      采购编码: `CG-${recordId}`,
      需求人: '张申请',
      申请楼栋: ['A楼'],
      专业: '电气',
      一级分类: '设备',
      二级分类: '备件',
      物品名称: recordId,
      采购申请数量: 1,
      计数单位: '件',
      采购流程: workflowStatus,
      采购完成: workflowStatus === '采购完成（已入库）',
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setImmediate(resolveDelay));
  }
  throw new Error('timed out waiting for condition');
}
