import {
  PURCHASE_ACCESS_BUILDINGS,
  type AccessPrincipal,
} from '../../shared/access-control.interface';
import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  PurchaseInboundCategoryPrepareRequest,
  PurchaseInboundCategoryTask,
} from '../../shared/inventory-management.interface';
import { PurchaseInboundCategoryTaskService } from '../../server/modules/inventory-management/purchase-inbound-category-task.service';

const ADMIN: AccessPrincipal = { role: 'admin', purchaseBuilding: null };
const CLAIM_TOKEN = 'category-claim-token-001';
const REQUEST: PurchaseInboundCategoryPrepareRequest = {
  executionRecordId: 'exec-category-1',
  clientMutationId: 'purchase-category-001',
  building: 'A楼',
  quantity: 1,
  occurredAt: '2026-08-20T01:00:00.000Z',
  newItem: {
    primaryCategory: 'A备品备件类',
    secondaryCategory: '常备件A2',
    name: '开利达单个执行器',
    specification: 'KLD400系列B3S',
    location: 'A-1F-126储藏室01-1F',
    locationRecordId: 'location-a-126',
    unit: '只',
  },
};

describe('PurchaseInboundCategoryTaskService', () => {
  const ledger = {
    reserve: jest.fn(),
    findByTaskId: jest.fn(),
    listRecoverable: jest.fn(),
    claimPending: jest.fn(),
    updateTask: jest.fn(),
    renewClaim: jest.fn(),
    getLeaseHeartbeatIntervalMs: jest.fn(() => 60_000),
  };
  const preparation = { prepareCategory: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    const entry = pendingEntry();
    ledger.reserve.mockResolvedValue({ created: true, entry });
    ledger.claimPending.mockResolvedValue({
      claimed: true,
      entry: {
        ...entry,
        attemptCount: 1,
        owner: claimOwner(),
        task: { ...entry.task, status: 'running' },
      },
    });
    ledger.listRecoverable.mockResolvedValue([]);
    ledger.renewClaim.mockResolvedValue(undefined);
    ledger.findByTaskId.mockResolvedValue(entry);
    ledger.updateTask.mockImplementation(
      async (_taskId: string, task: PurchaseInboundCategoryTask) => ({
        ...entry,
        task,
      }),
    );
    preparation.prepareCategory.mockResolvedValue({
      catalogRecordId: 'catalog-a2001',
      sku: 'A2001',
      alreadyPrepared: false,
      preparedAt: '2026-08-20T01:00:01.000Z',
    });
  });

  it('accepts immediately and completes category generation in the background', async () => {
    const service = createService();

    await expect(
      service.accept(REQUEST, ADMIN, 'principal-category-a'),
    ).resolves.toMatchObject({
      accepted: true,
      taskId: 'purchase-inbound-category-task-1',
      status: 'pending',
    });
    expect(preparation.prepareCategory).not.toHaveBeenCalled();

    await flushImmediate();

    expect(preparation.prepareCategory).toHaveBeenCalledWith(
      REQUEST,
      ADMIN,
      expect.any(Function),
    );
    expect(ledger.updateTask).toHaveBeenCalledWith(
      'purchase-inbound-category-task-1',
      expect.objectContaining({
        status: 'completed',
        result: expect.objectContaining({ sku: 'A2001' }),
      }),
      CLAIM_TOKEN,
    );
    await service.onModuleDestroy();
  });

  it('returns the existing task for a duplicate mutation without a second write', async () => {
    ledger.reserve.mockResolvedValue({ created: false, entry: pendingEntry() });
    const service = createService();

    const first = await service.accept(REQUEST, ADMIN, 'principal-category-a');
    const second = await service.accept(REQUEST, ADMIN, 'principal-category-a');

    expect(first.taskId).toBe(second.taskId);
    expect(ledger.reserve).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
  });

  it('keeps the original mutation pending when the external write times out', async () => {
    preparation.prepareCategory.mockRejectedValue(
      Object.assign(new Error('timeout of 45000ms exceeded'), {
        code: 'ECONNABORTED',
      }),
    );
    const service = createService();

    await service.accept(REQUEST, ADMIN, 'principal-category-a');
    await flushImmediate();

    expect(ledger.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          clientMutationId: REQUEST.clientMutationId,
        }),
      }),
    );
    expect(ledger.updateTask).toHaveBeenCalledWith(
      'purchase-inbound-category-task-1',
      expect.objectContaining({
        status: 'pending',
        message: expect.stringContaining('原变更号'),
      }),
      CLAIM_TOKEN,
    );
    await service.onModuleDestroy();
  });

  it('retries the same category task when claiming the ledger is temporarily unavailable', async () => {
    const entry = pendingEntry();
    ledger.claimPending
      .mockRejectedValueOnce(
        new ServiceUnavailableException('物品类别号任务台账暂时被占用'),
      )
      .mockResolvedValueOnce({
        claimed: true,
        entry: {
          ...entry,
          attemptCount: 1,
          owner: claimOwner(),
          task: { ...entry.task, status: 'running' },
        },
      });
    const service = createService();

    await service.accept(REQUEST, ADMIN, 'principal-category-a');
    await flushImmediate();
    expect(preparation.prepareCategory).not.toHaveBeenCalled();

    await waitForRetry();

    expect(ledger.claimPending).toHaveBeenCalledTimes(2);
    expect(preparation.prepareCategory).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
  });

  it('renews the exact claim token while category preparation is running', async () => {
    ledger.getLeaseHeartbeatIntervalMs.mockReturnValueOnce(1);
    preparation.prepareCategory.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        catalogRecordId: 'catalog-a2001',
        sku: 'A2001',
        alreadyPrepared: false,
        preparedAt: '2026-08-20T01:00:01.000Z',
      };
    });
    const service = createService();

    await service.accept(REQUEST, ADMIN, 'principal-category-a');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ledger.renewClaim).toHaveBeenCalledWith(
      'purchase-inbound-category-task-1',
      CLAIM_TOKEN,
    );
    await service.onModuleDestroy();
  });

  it('allows the same-building inventory administrator to query an old category task after re-login', async () => {
    const entry = {
      ...pendingEntry(),
      principal: {
        role: 'inventory_admin' as const,
        purchaseBuilding: REQUEST.building,
      },
      principalFingerprint: 'principal-before-relogin',
      task: { ...pendingEntry().task, status: 'running' as const },
    };
    ledger.findByTaskId.mockResolvedValue(entry);
    const service = createService();
    const getTaskStatus = service.getTaskStatus.bind(service) as unknown as (
      taskId: string,
      principal: AccessPrincipal,
    ) => Promise<unknown>;

    await expect(
      getTaskStatus(entry.task.id, {
        role: 'inventory_admin',
        purchaseBuilding: REQUEST.building,
      }),
    ).resolves.toMatchObject({
      success: true,
      task: { id: entry.task.id },
    });
  });

  it.each([
    [
      'an inventory administrator from another building',
      {
        role: 'inventory_admin' as const,
        purchaseBuilding: PURCHASE_ACCESS_BUILDINGS.find(
          (building) => building !== REQUEST.building,
        )!,
      },
    ],
    [
      'a role without inventory permission',
      { role: 'guest' as const, purchaseBuilding: null },
    ],
  ])('rejects category task lookup by %s', async (_label, principal) => {
    const entry = {
      ...pendingEntry(),
      principal: {
        role: 'inventory_admin' as const,
        purchaseBuilding: REQUEST.building,
      },
      principalFingerprint: 'principal-before-relogin',
      task: { ...pendingEntry().task, status: 'running' as const },
    };
    ledger.findByTaskId.mockResolvedValue(entry);
    const service = createService();
    const getTaskStatus = service.getTaskStatus.bind(service) as unknown as (
      taskId: string,
      principal: AccessPrincipal,
    ) => Promise<unknown>;

    await expect(
      getTaskStatus(entry.task.id, principal),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  function createService() {
    return new PurchaseInboundCategoryTaskService(
      ledger as never,
      preparation as never,
      { retryDelayMs: 1, recoveryScanDelayMs: 60_000 },
    );
  }
});

function pendingEntry() {
  return {
    principal: ADMIN,
    principalFingerprint: 'principal-category-a',
    requestFingerprint: 'fingerprint-category-a',
    request: REQUEST,
    attemptCount: 0,
    task: {
      id: 'purchase-inbound-category-task-1',
      status: 'pending' as const,
      message: '类别号生成已受理',
      createdAt: '2026-08-20T01:00:00.000Z',
      updatedAt: '2026-08-20T01:00:00.000Z',
    },
  };
}

function claimOwner() {
  return {
    token: CLAIM_TOKEN,
    acquiredAt: '2026-08-20T01:00:00.000Z',
    leaseExpiresAt: '2026-08-20T01:01:00.000Z',
  };
}

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForRetry(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await flushImmediate();
}
