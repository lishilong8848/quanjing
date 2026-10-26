jest.mock(
  '@server/common/config/external-services.config',
  () =>
    jest.requireActual('../../server/common/config/external-services.config'),
  { virtual: true },
);

jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  createBitableBackgroundRefresh: jest.fn(() => ({
    start: jest.fn(),
    stop: jest.fn(),
  })),
  resolveBitableAppToken: jest.fn().mockResolvedValue('app-token'),
  fetchBitableRecords: jest.fn().mockResolvedValue([]),
}));

import {
  createBitableBackgroundRefresh,
  fetchBitableRecords,
  resolveBitableAppToken,
} from '../../server/common/feishu/bitable-direct-read';
import {
  ContractManagementService,
  resolveContractCosSyncIntervalMs,
} from '../../server/modules/contract-management/contract-management.service';

describe('ContractManagementService dashboard cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(resolveBitableAppToken).mockResolvedValue('app-token');
    jest.mocked(fetchBitableRecords).mockResolvedValue([]);
  });

  it('accepts a safe contract COS interval override and rejects an accidental tight loop', () => {
    expect(resolveContractCosSyncIntervalMs('172800000')).toBe(172800000);
    expect(resolveContractCosSyncIntervalMs('900000')).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
    expect(resolveContractCosSyncIntervalMs('invalid')).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
  });

  it('runs a weekly fallback scan for new contract attachments without waiting for a page visit', async () => {
    const attachmentStorage = {
      enrichAndSchedule: jest.fn(async (dashboard: unknown) => dashboard),
      refreshDashboardAttachmentStates: jest.fn(
        (dashboard: unknown) => dashboard,
      ),
    };
    const service = new ContractManagementService(
      { axiosRef: {} } as never,
      attachmentStorage as never,
    );
    const refreshOptions = jest.mocked(createBitableBackgroundRefresh).mock
      .calls[0][0];
    const refreshController = jest.mocked(createBitableBackgroundRefresh).mock
      .results[0].value;

    expect(refreshOptions.intervalMs).toBe(7 * 24 * 60 * 60 * 1000);
    service.onModuleInit();
    expect(refreshController.start).toHaveBeenCalledTimes(1);

    await refreshOptions.refresh();

    expect(fetchBitableRecords).toHaveBeenCalledTimes(4);
    expect(attachmentStorage.enrichAndSchedule).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
    expect(refreshController.stop).toHaveBeenCalledTimes(1);
  });

  it('reuses the mapped dashboard until a force refresh replaces it', async () => {
    const attachmentStorage = {
      enrichAndSchedule: jest.fn(async (dashboard: unknown) => dashboard),
      refreshDashboardAttachmentStates: jest.fn(
        (dashboard: unknown) => dashboard,
      ),
    };
    const service = new ContractManagementService(
      { axiosRef: {} } as never,
      attachmentStorage as never,
    );

    const first = await service.getDashboard(false);
    const second = await service.getDashboard(false);

    expect(second).toBe(first);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(4);
    expect(attachmentStorage.enrichAndSchedule).toHaveBeenCalledTimes(1);
    expect(
      attachmentStorage.refreshDashboardAttachmentStates,
    ).toHaveBeenCalledTimes(1);

    const refreshed = await service.getDashboard(true);
    expect(refreshed).not.toBe(first);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(8);
    expect(attachmentStorage.enrichAndSchedule).toHaveBeenCalledTimes(2);
  });

  it('invalidates the cached dashboard and ignores an older in-flight cache write', async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let enrichmentCount = 0;
    const attachmentStorage = {
      enrichAndSchedule: jest.fn(async (dashboard: any) => {
        enrichmentCount += 1;
        if (enrichmentCount === 1) {
          await firstBlocked;
          return { ...dashboard, generatedAt: 'older-response' };
        }
        return { ...dashboard, generatedAt: 'fresh-response' };
      }),
      refreshDashboardAttachmentStates: jest.fn(
        (dashboard: unknown) => dashboard,
      ),
    };
    const service = new ContractManagementService(
      { axiosRef: {} } as never,
      attachmentStorage as never,
    );

    const olderRequest = service.getDashboard(false);
    await waitUntil(
      () => attachmentStorage.enrichAndSchedule.mock.calls.length,
    );
    service.invalidateDashboardCache();
    const fresh = await service.getDashboard(false);
    releaseFirst();
    await olderRequest;

    expect(fresh.generatedAt).toBe('fresh-response');
    await expect(service.getDashboard(false)).resolves.toBe(fresh);
    expect(attachmentStorage.enrichAndSchedule).toHaveBeenCalledTimes(2);
  });
});

async function waitUntil(readValue: () => number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (readValue() > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('等待合同看板构建开始超时');
}
