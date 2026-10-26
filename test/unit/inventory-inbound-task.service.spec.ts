import {
  PURCHASE_ACCESS_BUILDINGS,
  type AccessPrincipal,
} from '../../shared/access-control.interface';
import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  InventoryExistingInboundMovementCreateRequest,
  InventoryInboundTask,
  InventoryNewInboundMovementCreateRequest,
  PurchaseExistingInboundConfirmRequest,
} from '../../shared/inventory-management.interface';
import {
  calculateInventoryInboundRetryDelay,
  InventoryInboundTaskService,
} from '../../server/modules/inventory-management/inventory-inbound-task.service';
import type { InventoryInboundTaskLedgerTask } from '../../server/modules/inventory-management/inventory-inbound-task-ledger.store';

const ADMIN: AccessPrincipal = { role: 'admin', purchaseBuilding: null };
const CLAIM_TOKEN = 'inbound-claim-token-001';
const MANUAL_REQUEST: InventoryExistingInboundMovementCreateRequest = {
  type: 'inbound',
  mode: 'existing',
  clientMutationId: 'manual-inbound-001',
  catalogRecordId: 'catalog-d1007',
  sku: 'D1007',
  building: 'H楼',
  quantity: 2,
  occurredAt: '2026-08-21T03:00:00.000Z',
};
const PURCHASE_REQUEST: PurchaseExistingInboundConfirmRequest = {
  executionRecordId: 'purchase-execution-001',
  mode: 'existing',
  clientMutationId: 'purchase-inbound-001',
  catalogRecordId: 'catalog-b1056',
  sku: 'B1056',
  building: 'H楼',
  quantity: 1,
  occurredAt: '2026-08-21T03:10:00.000Z',
};
const MANUAL_NEW_REQUEST: InventoryNewInboundMovementCreateRequest = {
  type: 'inbound',
  mode: 'new',
  clientMutationId: 'manual-new-inbound-001',
  building: 'H楼',
  quantity: 1,
  occurredAt: '2026-08-21T03:20:00.000Z',
  newItem: {
    primaryCategory: 'B工具类',
    secondaryCategory: '检测工具B1',
    name: '地磅秤',
    specification: '0.6*0.8米1吨',
    location: 'H-2F-226储存间01-0F',
    locationRecordId: 'location-h-226',
  },
};

describe('InventoryInboundTaskService', () => {
  const ledger = {
    reserveInbound: jest.fn(),
    findInboundByTaskId: jest.fn(),
    listRecoverableInbounds: jest.fn(),
    claimPendingInbound: jest.fn(),
    updateInboundTask: jest.fn(),
    renewClaim: jest.fn(),
    getLeaseHeartbeatIntervalMs: jest.fn(() => 60_000),
  };
  const movementCommand = { createMovement: jest.fn(), assertProfessionalRequest: jest.fn().mockResolvedValue(undefined) };
  const purchaseInbound = {
    confirm: jest.fn(),
    ensureCompletionNotificationOutbox: jest.fn(),
  };
  const purchaseWorkflow = {
    ensureManualInboundCompletionNotification: jest.fn(),
  };
  const storageLocations = { resolveSelectedLocation: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    ledger.listRecoverableInbounds.mockResolvedValue([]);
    ledger.renewClaim.mockResolvedValue(undefined);
    movementCommand.createMovement.mockResolvedValue(manualResult());
    purchaseInbound.confirm.mockResolvedValue(purchaseResult());
    purchaseInbound.ensureCompletionNotificationOutbox.mockResolvedValue(
      undefined,
    );
    purchaseWorkflow.ensureManualInboundCompletionNotification.mockResolvedValue(
      undefined,
    );
    storageLocations.resolveSelectedLocation.mockResolvedValue({
      recordId: 'location-h-226',
      name: 'H-2F-226储存间01-0F',
      building: 'H楼',
    });
  });

  it('rejects a manual request before reservation when the existing professional authorization denies it', async () => {
    movementCommand.assertProfessionalRequest.mockRejectedValueOnce(new ForbiddenException('synthetic-professional-denied'));
    const service = createService();
    try {
      await expect(service.acceptManual(MANUAL_REQUEST, ADMIN, 'principal-admin')).rejects.toThrow('synthetic-professional-denied');
      expect(ledger.reserveInbound).not.toHaveBeenCalled();
    } finally { await service.onModuleDestroy(); }
  });

  it('accepts a manual inbound before starting the slow external write', async () => {
    const entry = pendingEntry('manual', MANUAL_REQUEST);
    ledger.reserveInbound.mockResolvedValue({ created: true, entry });
    ledger.claimPendingInbound.mockResolvedValue({
      claimed: true,
      entry: runningEntry(entry),
    });
    ledger.updateInboundTask.mockImplementation(
      async (_taskId: string, task: InventoryInboundTaskLedgerTask) => ({
        ...entry,
        task,
      }),
    );
    const service = createService();

    await expect(
      service.acceptManual(MANUAL_REQUEST, ADMIN, 'principal-admin'),
    ).resolves.toMatchObject({
      accepted: true,
      kind: 'manual',
      status: 'pending',
    });
    expect(movementCommand.createMovement).not.toHaveBeenCalled();

    await flushImmediate();

    expect(movementCommand.createMovement).toHaveBeenCalledWith(
      MANUAL_REQUEST,
      ADMIN,
      expect.any(Function),
    );
    const assertOwnership = movementCommand.createMovement.mock.calls[0]?.[2];
    await expect(assertOwnership()).resolves.toBeUndefined();
    expect(ledger.renewClaim).toHaveBeenCalledWith(entry.task.id, CLAIM_TOKEN);
    const checkpointCall = ledger.updateInboundTask.mock.calls.find(
      (call) => call[1]?.status === 'running' && call[1]?.businessResult,
    );
    expect(checkpointCall?.[1]).toMatchObject({
      status: 'running',
      businessResult: manualResult(),
    });
    expect(ledger.updateInboundTask.mock.invocationCallOrder[0]).toBeLessThan(
      purchaseWorkflow.ensureManualInboundCompletionNotification.mock
        .invocationCallOrder[0]!,
    );
    expect(
      purchaseWorkflow.ensureManualInboundCompletionNotification,
    ).toHaveBeenCalledWith(manualResult());
    expect(ledger.updateInboundTask).toHaveBeenCalledWith(
      entry.task.id,
      expect.objectContaining({
        kind: 'manual',
        status: 'completed',
        result: manualResult(),
      }),
      CLAIM_TOKEN,
    );
    await service.onModuleDestroy();
  });

  it('reuses the persisted business checkpoint when notification registration first fails', async () => {
    const entry = pendingEntry('manual', MANUAL_REQUEST);
    let current = runningEntry(entry);
    ledger.claimPendingInbound
      .mockImplementationOnce(async () => ({ claimed: true, entry: current }))
      .mockImplementationOnce(async () => {
        current = {
          ...current,
          attemptCount: 2,
          owner: { ...current.owner },
          task: { ...current.task, status: 'running' as const },
        };
        return { claimed: true, entry: current };
      });
    ledger.updateInboundTask.mockImplementation(
      async (_taskId: string, task: InventoryInboundTaskLedgerTask) => {
        current = { ...current, task } as typeof current;
        return current;
      },
    );
    purchaseWorkflow.ensureManualInboundCompletionNotification
      .mockRejectedValueOnce(new Error('通知账本暂时不可用'))
      .mockResolvedValueOnce(undefined);
    const service = createService();
    const executeTask = (
      service as unknown as {
        executeTask(taskId: string): Promise<number | null>;
      }
    ).executeTask.bind(service);

    await expect(executeTask(entry.task.id)).resolves.toBe(1);
    expect(current.task).toMatchObject({
      status: 'pending',
      businessResult: manualResult(),
    });
    await expect(executeTask(entry.task.id)).resolves.toBeNull();

    expect(movementCommand.createMovement).toHaveBeenCalledTimes(1);
    expect(
      purchaseWorkflow.ensureManualInboundCompletionNotification,
    ).toHaveBeenCalledTimes(2);
    expect(current.task.status).toBe('completed');
    expect(current.task).not.toHaveProperty('businessResult');
  });

  it('does not expose the manual business checkpoint after notification registration fails', async () => {
    const entry = pendingEntry('manual', MANUAL_REQUEST);
    let current = runningEntry(entry);
    ledger.claimPendingInbound.mockResolvedValueOnce({
      claimed: true,
      entry: current,
    });
    ledger.updateInboundTask.mockImplementation(
      async (_taskId: string, task: InventoryInboundTaskLedgerTask) => {
        current = { ...current, task } as typeof current;
        return current;
      },
    );
    purchaseWorkflow.ensureManualInboundCompletionNotification.mockRejectedValueOnce(
      new Error('通知账本暂时不可用'),
    );
    const service = createService();
    const executeTask = (
      service as unknown as {
        executeTask(taskId: string): Promise<number | null>;
      }
    ).executeTask.bind(service);

    await expect(executeTask(entry.task.id)).resolves.toBe(1);
    expect(current.task).toMatchObject({
      status: 'pending',
      businessResult: manualResult(),
    });
    ledger.findInboundByTaskId.mockResolvedValue(current);
    ledger.claimPendingInbound.mockResolvedValue({
      claimed: false,
      entry: current,
    });

    const response = await service.getTaskStatus(entry.task.id, ADMIN);

    expect(response).toMatchObject({
      success: true,
      task: { id: entry.task.id, status: 'pending' },
    });
    expect(response.task).not.toHaveProperty('businessResult');
    await flushImmediate();
    await service.onModuleDestroy();
  });

  it('does not expose internal ledger fields from a failed task status response', async () => {
    const entry = pendingEntry('manual', MANUAL_REQUEST);
    ledger.findInboundByTaskId.mockResolvedValue({
      ...entry,
      task: {
        ...entry.task,
        status: 'failed',
        message: '入库参数无效',
        completedAt: '2026-08-21T03:01:00.000Z',
        definitelyNotWritten: true,
        businessResult: manualResult(),
        internalMarker: 'must-not-leak',
      },
    });
    const service = createService();

    const response = await service.getTaskStatus(entry.task.id, ADMIN);

    expect(response).toEqual({
      success: true,
      task: {
        id: entry.task.id,
        kind: 'manual',
        status: 'failed',
        message: '入库参数无效',
        createdAt: entry.task.createdAt,
        updatedAt: entry.task.updatedAt,
        completedAt: '2026-08-21T03:01:00.000Z',
        definitelyNotWritten: true,
      },
    });
    await service.onModuleDestroy();
  });

  it('accepts a purchase inbound before starting the slow external write', async () => {
    const entry = pendingEntry('purchase', PURCHASE_REQUEST);
    ledger.reserveInbound.mockResolvedValue({ created: true, entry });
    ledger.claimPendingInbound.mockResolvedValue({
      claimed: true,
      entry: runningEntry(entry),
    });
    ledger.updateInboundTask.mockImplementation(
      async (_taskId: string, task: InventoryInboundTaskLedgerTask) => ({
        ...entry,
        task,
      }),
    );
    const service = createService();

    await expect(
      service.acceptPurchase(PURCHASE_REQUEST, ADMIN, 'principal-admin'),
    ).resolves.toMatchObject({
      accepted: true,
      kind: 'purchase',
      status: 'pending',
    });
    expect(purchaseInbound.confirm).not.toHaveBeenCalled();

    await flushImmediate();

    expect(purchaseInbound.confirm).toHaveBeenCalledWith(
      PURCHASE_REQUEST,
      ADMIN,
      expect.any(Function),
    );
    expect(ledger.updateInboundTask).toHaveBeenCalledWith(
      entry.task.id,
      expect.objectContaining({
        kind: 'purchase',
        status: 'completed',
        result: purchaseResult(),
      }),
      CLAIM_TOKEN,
    );
    await service.onModuleDestroy();
  });

  it('does not block an already completed purchase task accept on notification outbox repair', async () => {
    const entry = completedEntry('purchase', PURCHASE_REQUEST);
    ledger.reserveInbound.mockResolvedValue({ created: false, entry });
    purchaseInbound.ensureCompletionNotificationOutbox.mockRejectedValueOnce(
      new Error('通知账本暂时不可用'),
    );
    const service = createService();

    await expect(
      service.acceptPurchase(PURCHASE_REQUEST, ADMIN, 'principal-admin'),
    ).resolves.toMatchObject({
      accepted: true,
      kind: 'purchase',
      status: 'completed',
    });

    expect(
      purchaseInbound.ensureCompletionNotificationOutbox,
    ).toHaveBeenCalledWith(
      PURCHASE_REQUEST.executionRecordId,
      expect.objectContaining({
        sku: 'B1056',
        location: 'H-2F-226储存间01-0F',
      }),
    );
    expect(purchaseInbound.confirm).not.toHaveBeenCalled();
    await flushImmediate();
    await service.onModuleDestroy();
  });

  it('validates and canonicalizes a new-item location only in the background', async () => {
    const entry = pendingEntry('manual', MANUAL_NEW_REQUEST);
    ledger.reserveInbound.mockResolvedValue({ created: true, entry });
    ledger.claimPendingInbound.mockResolvedValue({
      claimed: true,
      entry: runningEntry(entry),
    });
    ledger.updateInboundTask.mockImplementation(
      async (_taskId: string, task: InventoryInboundTaskLedgerTask) => ({
        ...entry,
        task,
      }),
    );
    const service = createService();

    await service.acceptManual(MANUAL_NEW_REQUEST, ADMIN, 'principal-admin');
    expect(storageLocations.resolveSelectedLocation).not.toHaveBeenCalled();

    await flushImmediate();

    expect(storageLocations.resolveSelectedLocation).toHaveBeenCalledWith(
      'H楼',
      'location-h-226',
      'H-2F-226储存间01-0F',
    );
    expect(movementCommand.createMovement).toHaveBeenCalledWith(
      MANUAL_NEW_REQUEST,
      ADMIN,
      expect.any(Function),
    );
    await service.onModuleDestroy();
  });

  it('keeps the original task pending when the external response times out', async () => {
    const entry = pendingEntry('manual', MANUAL_REQUEST);
    ledger.reserveInbound.mockResolvedValue({ created: true, entry });
    ledger.claimPendingInbound.mockResolvedValue({
      claimed: true,
      entry: runningEntry(entry),
    });
    ledger.updateInboundTask.mockImplementation(
      async (_taskId: string, task: InventoryInboundTaskLedgerTask) => ({
        ...entry,
        task,
      }),
    );
    movementCommand.createMovement.mockRejectedValue(
      Object.assign(new Error('timeout of 45000ms exceeded'), {
        code: 'ECONNABORTED',
        inventoryStage: '写入库存台账',
      }),
    );
    const service = createService();

    await service.acceptManual(MANUAL_REQUEST, ADMIN, 'principal-admin');
    await flushImmediate();

    expect(ledger.updateInboundTask).toHaveBeenCalledWith(
      entry.task.id,
      expect.objectContaining({
        status: 'pending',
        message: expect.stringContaining('原编号'),
      }),
      CLAIM_TOKEN,
    );
    expect(ledger.updateInboundTask).toHaveBeenCalledWith(
      entry.task.id,
      expect.objectContaining({
        status: 'pending',
        message: expect.stringContaining('第 1 次'),
      }),
      CLAIM_TOKEN,
    );
    expect(ledger.updateInboundTask).toHaveBeenCalledWith(
      entry.task.id,
      expect.objectContaining({
        status: 'pending',
        message: expect.stringContaining('写入库存台账'),
      }),
      CLAIM_TOKEN,
    );
    await service.onModuleDestroy();
  });

  it('backs off repeated inbound retries up to one minute', () => {
    expect(calculateInventoryInboundRetryDelay(5_000, 1)).toBe(5_000);
    expect(calculateInventoryInboundRetryDelay(5_000, 2)).toBe(10_000);
    expect(calculateInventoryInboundRetryDelay(5_000, 5)).toBe(60_000);
    expect(calculateInventoryInboundRetryDelay(5_000, 200)).toBe(60_000);
  });

  it('does not let the recovery scan bypass an active retry backoff', async () => {
    const entry = pendingEntry('purchase', PURCHASE_REQUEST);
    ledger.listRecoverableInbounds.mockResolvedValue([entry]);
    const service = new InventoryInboundTaskService(
      ledger as never,
      movementCommand as never,
      purchaseInbound as never,
      purchaseWorkflow as never,
      storageLocations as never,
      { retryDelayMs: 60_000, recoveryScanDelayMs: 60_000 },
    );
    const internal = service as unknown as {
      scheduleRetry(taskId: string, attemptCount: number): void;
    };

    internal.scheduleRetry(entry.task.id, 2);
    await service.onModuleInit();
    await flushImmediate();

    expect(ledger.claimPendingInbound).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('retries the same persisted task when claiming the ledger is temporarily unavailable', async () => {
    const entry = pendingEntry('purchase', PURCHASE_REQUEST);
    ledger.reserveInbound.mockResolvedValue({ created: true, entry });
    ledger.claimPendingInbound
      .mockRejectedValueOnce(
        new ServiceUnavailableException('入库任务台账暂时被占用'),
      )
      .mockResolvedValueOnce({
        claimed: true,
        entry: runningEntry(entry),
      });
    ledger.updateInboundTask.mockImplementation(
      async (_taskId: string, task: InventoryInboundTaskLedgerTask) => ({
        ...entry,
        task,
      }),
    );
    const service = createService();

    await service.acceptPurchase(PURCHASE_REQUEST, ADMIN, 'principal-admin');
    await flushImmediate();
    expect(purchaseInbound.confirm).not.toHaveBeenCalled();

    await waitForRetry();

    expect(ledger.claimPendingInbound).toHaveBeenCalledTimes(2);
    expect(purchaseInbound.confirm).toHaveBeenCalledTimes(1);
    expect(purchaseInbound.confirm).toHaveBeenCalledWith(
      PURCHASE_REQUEST,
      ADMIN,
      expect.any(Function),
    );
    await service.onModuleDestroy();
  });

  it('renews the exact claim token while inbound synchronization is running', async () => {
    const entry = pendingEntry('manual', MANUAL_REQUEST);
    ledger.reserveInbound.mockResolvedValue({ created: true, entry });
    ledger.claimPendingInbound.mockResolvedValue({
      claimed: true,
      entry: runningEntry(entry),
    });
    ledger.updateInboundTask.mockImplementation(
      async (_taskId: string, task: InventoryInboundTaskLedgerTask) => ({
        ...entry,
        task,
      }),
    );
    ledger.getLeaseHeartbeatIntervalMs.mockReturnValue(1);
    movementCommand.createMovement.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return manualResult();
    });
    const service = createService();

    await service.acceptManual(MANUAL_REQUEST, ADMIN, 'principal-admin');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ledger.renewClaim).toHaveBeenCalledWith(entry.task.id, CLAIM_TOKEN);
    await service.onModuleDestroy();
    ledger.getLeaseHeartbeatIntervalMs.mockReturnValue(60_000);
  });

  it('allows the same-building inventory administrator to query an old task after re-login', async () => {
    const entry = {
      ...pendingEntry('manual', MANUAL_REQUEST),
      principal: {
        role: 'inventory_admin' as const,
        purchaseBuilding: MANUAL_REQUEST.building,
      },
      principalFingerprint: 'principal-before-relogin',
      task: {
        ...pendingEntry('manual', MANUAL_REQUEST).task,
        status: 'running' as const,
      },
    };
    ledger.findInboundByTaskId.mockResolvedValue(entry);
    const service = createService();
    const getTaskStatus = service.getTaskStatus.bind(service) as unknown as (
      taskId: string,
      principal: AccessPrincipal,
    ) => Promise<unknown>;

    await expect(
      getTaskStatus(entry.task.id, {
        role: 'inventory_admin',
        purchaseBuilding: MANUAL_REQUEST.building,
      }),
    ).resolves.toMatchObject({
      success: true,
      task: { id: entry.task.id },
    });
  });

  it('does not block a completed purchase task status on notification outbox repair', async () => {
    const entry = completedEntry('purchase', PURCHASE_REQUEST);
    ledger.findInboundByTaskId.mockResolvedValue(entry);
    purchaseInbound.ensureCompletionNotificationOutbox.mockRejectedValueOnce(
      new Error('通知账本暂时不可用'),
    );
    const service = createService();

    await expect(
      service.getTaskStatus(entry.task.id, ADMIN),
    ).resolves.toMatchObject({
      success: true,
      task: { id: entry.task.id, status: 'completed' },
    });

    expect(
      purchaseInbound.ensureCompletionNotificationOutbox,
    ).toHaveBeenCalledWith(
      PURCHASE_REQUEST.executionRecordId,
      expect.objectContaining({
        sku: 'B1056',
        location: 'H-2F-226储存间01-0F',
      }),
    );
    await flushImmediate();
  });

  it('returns a completed purchase task before a slow notification repair settles', async () => {
    const entry = completedEntry('purchase', PURCHASE_REQUEST);
    ledger.findInboundByTaskId.mockResolvedValue(entry);
    purchaseInbound.ensureCompletionNotificationOutbox.mockImplementationOnce(
      () => new Promise<void>(() => undefined),
    );
    const service = createService();

    const outcome = await Promise.race([
      service.getTaskStatus(entry.task.id, ADMIN).then(() => 'completed'),
      new Promise<'blocked'>((resolve) =>
        setImmediate(() => resolve('blocked')),
      ),
    ]);

    expect(outcome).toBe('completed');
    expect(
      purchaseInbound.ensureCompletionNotificationOutbox,
    ).toHaveBeenCalledWith(
      PURCHASE_REQUEST.executionRecordId,
      expect.objectContaining({
        sku: 'B1056',
        location: 'H-2F-226储存间01-0F',
      }),
    );
    await service.onModuleDestroy();
  });

  it('repairs the manual completion outbox on completed accept and status lookup', async () => {
    const entry = completedEntry('manual', MANUAL_REQUEST);
    ledger.reserveInbound.mockResolvedValue({ created: false, entry });
    ledger.findInboundByTaskId.mockResolvedValue(entry);
    const service = createService();

    await service.acceptManual(MANUAL_REQUEST, ADMIN, 'principal-admin');
    await service.getTaskStatus(entry.task.id, ADMIN);

    expect(
      purchaseInbound.ensureCompletionNotificationOutbox,
    ).not.toHaveBeenCalled();
    expect(
      purchaseWorkflow.ensureManualInboundCompletionNotification,
    ).toHaveBeenCalledTimes(2);
    expect(
      purchaseWorkflow.ensureManualInboundCompletionNotification,
    ).toHaveBeenNthCalledWith(1, manualResult());
    expect(
      purchaseWorkflow.ensureManualInboundCompletionNotification,
    ).toHaveBeenNthCalledWith(2, manualResult());
    expect(purchaseInbound.confirm).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it.each([
    [
      'an inventory administrator from another building',
      {
        role: 'inventory_admin' as const,
        purchaseBuilding: PURCHASE_ACCESS_BUILDINGS.find(
          (building) => building !== MANUAL_REQUEST.building,
        )!,
      },
    ],
    [
      'a role without inventory permission',
      { role: 'guest' as const, purchaseBuilding: null },
    ],
  ])('rejects task lookup by %s', async (_label, principal) => {
    const entry = {
      ...pendingEntry('manual', MANUAL_REQUEST),
      principal: {
        role: 'inventory_admin' as const,
        purchaseBuilding: MANUAL_REQUEST.building,
      },
      principalFingerprint: 'principal-before-relogin',
      task: {
        ...pendingEntry('manual', MANUAL_REQUEST).task,
        status: 'running' as const,
      },
    };
    ledger.findInboundByTaskId.mockResolvedValue(entry);
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
    return new InventoryInboundTaskService(
      ledger as never,
      movementCommand as never,
      purchaseInbound as never,
      purchaseWorkflow as never,
      storageLocations as never,
      { retryDelayMs: 1, recoveryScanDelayMs: 60_000 },
    );
  }
});

function pendingEntry(
  kind: 'manual' | 'purchase',
  request:
    | InventoryExistingInboundMovementCreateRequest
    | InventoryNewInboundMovementCreateRequest
    | PurchaseExistingInboundConfirmRequest,
) {
  const task: InventoryInboundTask = {
    id: `inventory-inbound-${kind}-task-1`,
    kind,
    status: 'pending',
    message: '入库已受理，正在后台同步',
    createdAt: '2026-08-21T03:00:00.000Z',
    updatedAt: '2026-08-21T03:00:00.000Z',
  };
  return {
    kind,
    principal: ADMIN,
    principalFingerprint: 'principal-admin',
    requestFingerprint: `fingerprint-${kind}`,
    request,
    attemptCount: 0,
    task,
  };
}

function runningEntry(entry: ReturnType<typeof pendingEntry>) {
  return {
    ...entry,
    attemptCount: 1,
    owner: {
      token: CLAIM_TOKEN,
      acquiredAt: '2026-08-21T03:00:00.000Z',
      leaseExpiresAt: '2026-08-21T03:01:00.000Z',
    },
    task: { ...entry.task, status: 'running' as const },
  };
}

function completedEntry(
  kind: 'manual' | 'purchase',
  request:
    | InventoryExistingInboundMovementCreateRequest
    | InventoryNewInboundMovementCreateRequest
    | PurchaseExistingInboundConfirmRequest,
) {
  const entry = pendingEntry(kind, request);
  return {
    ...entry,
    task: {
      ...entry.task,
      status: 'completed' as const,
      message: '入库已完成',
      updatedAt: '2026-08-21T03:30:00.000Z',
      completedAt: '2026-08-21T03:30:00.000Z',
      result: kind === 'purchase' ? purchaseResult() : manualResult(),
    },
  };
}

function manualResult() {
  return {
    success: true as const,
    recordId: 'inbound-record-001',
    type: 'inbound' as const,
    message: '入库记录已完成',
    movement: {
      recordId: 'inbound-record-001',
      clientMutationId: MANUAL_REQUEST.clientMutationId,
      type: 'inbound' as const,
      sku: MANUAL_REQUEST.sku,
      name: '测试物品',
      specification: '测试规格',
      quantity: MANUAL_REQUEST.quantity,
      unit: '个',
      building: MANUAL_REQUEST.building,
      destinationBuilding: '',
      location: 'H-2F-226储存间01-0F',
      reason: '入库登记',
      operator: '管理员',
      applicant: '',
      status: '新增',
      occurredAt: MANUAL_REQUEST.occurredAt,
      expectedReturnAt: null,
      overdue: false,
    },
  };
}

function purchaseResult() {
  return {
    success: true as const,
    executionRecordId: PURCHASE_REQUEST.executionRecordId,
    catalogRecordId: PURCHASE_REQUEST.catalogRecordId,
    inboundRecordId: 'purchase-inbound-record-001',
    alreadyProcessed: false,
    message: '采购入库已完成',
    notificationWarnings: [],
    movement: {
      ...manualResult().movement,
      recordId: 'purchase-inbound-record-001',
      clientMutationId: PURCHASE_REQUEST.clientMutationId,
      sku: PURCHASE_REQUEST.sku,
      quantity: PURCHASE_REQUEST.quantity,
    },
  };
}

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForRetry(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await flushImmediate();
}
