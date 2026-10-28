jest.mock(
  '@lark-apaas/client-toolkit/logger',
  () => ({ logger: { error: jest.fn(), warn: jest.fn() } }),
  { virtual: true },
);

jest.mock('@nestjs/common', () => {
  const actual = jest.requireActual('@nestjs/common');
  const decorator = () => () => undefined;
  return {
    ...actual,
    Body: decorator,
    Controller: decorator,
    Get: decorator,
    HttpCode: decorator,
    Injectable: decorator,
    Param: decorator,
    Post: decorator,
    Query: decorator,
    Req: decorator,
    SetMetadata: decorator,
  };
});

jest.mock(
  '@lark-apaas/client-toolkit/utils/getAxiosForBackend',
  () => ({ axiosForBackend: jest.fn() }),
  { virtual: true },
);

jest.mock(
  '../../server/modules/purchase-inventory/purchase-inventory.module',
  () => ({ PurchaseInventoryModule: class PurchaseInventoryModule {} }),
);

import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type {
  CreateInventoryMovementDeletionRequest,
  InventoryMovementCreateRequest,
  InventoryMovementDeletionAcceptedResponse,
  InventoryMovementDeletionTaskStatusResponse,
  InventoryOutboundAcceptedResponse,
  InventoryOutboundConfirmRequest,
  InventoryOutboundMovementCreateRequest,
  InventoryOutboundTaskStatusResponse,
  PurchaseInboundConfirmRequest,
  WarehouseStorageLocationCreateRequest,
} from '../../shared/inventory-management.interface';
import {
  confirmInventoryOutbound,
  createInventoryMovement,
  createInventoryMovementDeletion,
  confirmPurchaseInbound,
  getInventoryManagementDashboard,
  getInventoryManagementItems,
  getInventoryManagementMovements,
  getInventoryMovementOptions,
  getInventoryMovementDeletionTaskStatus,
  getInventoryOutboundTaskStatus,
  getPurchaseInboundCategoryTaskStatus,
  getPendingPurchaseInbounds,
  preparePurchaseInboundCategory,
  getInventoryWorkflowStatus,
  runInventoryWorkflow,
  runInventoryWorkflowSelfTest,
  submitInventoryOutbound,
} from '../../client/src/api';
import { InventoryManagementController } from '../../server/modules/inventory-management/inventory-management.controller';
import { InventoryManagementModule } from '../../server/modules/inventory-management/inventory-management.module';
import { InventoryInboundTaskLedgerStore } from '../../server/modules/inventory-management/inventory-inbound-task-ledger.store';
import { InventoryInboundTaskService } from '../../server/modules/inventory-management/inventory-inbound-task.service';
import { InventoryOutboundWorkflowService } from '../../server/modules/inventory-management/inventory-outbound-workflow.service';
import { InventoryOutboundTaskLedgerStore } from '../../server/modules/inventory-management/inventory-outbound-task-ledger.store';
import { PurchaseInboundCategoryTaskLedgerStore } from '../../server/modules/inventory-management/purchase-inbound-category-task-ledger.store';
import { PurchaseInboundCategoryTaskService } from '../../server/modules/inventory-management/purchase-inbound-category-task.service';

describe('inventory management api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (axiosForBackend as jest.Mock).mockResolvedValue({ data: {} });
  });

  it('loads the warehouse dashboard through its independent backend route', async () => {
    await getInventoryManagementDashboard(true);

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/inventory-management/dashboard',
      method: 'GET',
      params: { refresh: '1' },
      timeout: 120_000,
    });
  });

  it('passes inventory filters and refresh to the paged item route', async () => {
    await getInventoryManagementItems(
      {
        page: 2,
        pageSize: 25,
        search: '滤芯',
        building: 'A楼',
        category: '机房耗材',
        risk: 'low',
        sort: 'quantityAsc',
      },
      true,
    );

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/inventory-management/items',
      method: 'GET',
      params: {
        page: 2,
        pageSize: 25,
        search: '滤芯',
        building: 'A楼',
        category: '机房耗材',
        risk: 'low',
        sort: 'quantityAsc',
        refresh: '1',
      },
      timeout: 120_000,
    });
  });

  it('passes movement type, filters, pagination, and refresh to the movement route', async () => {
    await getInventoryManagementMovements(
      {
        type: 'outbound',
        page: 3,
        pageSize: 20,
        search: '滤芯',
        building: 'A楼',
        status: '已出库',
      },
      true,
    );

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/inventory-management/movements',
      method: 'GET',
      params: {
        type: 'outbound',
        page: 3,
        pageSize: 20,
        search: '滤芯',
        building: 'A楼',
        status: '已出库',
        refresh: '1',
      },
      timeout: 120_000,
    });
  });

  it('loads inbound movement options and posts a typed inbound command', async () => {
    (axiosForBackend as jest.Mock)
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: {
          success: true,
          recordId: 'inbound-create-a101',
          type: 'inbound',
          message: '入库已完成',
        },
      });
    await getInventoryMovementOptions({
      type: 'inbound',
      building: 'A楼',
      query: '滤芯',
      limit: 30,
      refresh: true,
    });
    await createInventoryMovement({
      type: 'inbound',
      mode: 'existing',
      clientMutationId: 'inbound-create-a101',
      catalogRecordId: 'catalog-a101',
      sku: 'A101',
      building: 'A楼',
      quantity: 2,
      occurredAt: '2026-07-12T10:00:00.000Z',
      applicantOpenId: 'ou_applicant',
      reason: '现场更换',
    });

    expect(axiosForBackend).toHaveBeenNthCalledWith(1, {
      url: '/api/inventory-management/movement-options',
      method: 'GET',
      params: {
        type: 'inbound',
        building: 'A楼',
        query: '滤芯',
        limit: 30,
        refresh: true,
      },
      timeout: 120_000,
    });
    expect(axiosForBackend).toHaveBeenNthCalledWith(2, {
      url: '/api/inventory-management/movements',
      method: 'POST',
      data: {
        type: 'inbound',
        mode: 'existing',
        clientMutationId: 'inbound-create-a101',
        catalogRecordId: 'catalog-a101',
        sku: 'A101',
        building: 'A楼',
        quantity: 2,
        occurredAt: '2026-07-12T10:00:00.000Z',
        applicantOpenId: 'ou_applicant',
        reason: '现场更换',
      },
      timeout: 15_000,
    });
  });

  it('returns an accepted inbound task immediately without polling in the submit request', async () => {
    jest.useFakeTimers();
    const request = {
      type: 'inbound' as const,
      mode: 'existing' as const,
      clientMutationId: 'inbound-poll-a101',
      catalogRecordId: 'catalog-a101',
      sku: 'A101',
      building: 'A楼' as const,
      quantity: 2,
      occurredAt: '2026-07-12T10:00:00.000Z',
    };
    const accepted = {
      accepted: true as const,
      taskId: 'inventory-inbound-manual-task-1',
      kind: 'manual' as const,
      status: 'pending' as const,
      message: '入库已受理',
    };
    (axiosForBackend as jest.Mock).mockResolvedValueOnce({ data: accepted });

    try {
      const acceptance = createInventoryMovement(request);
      await jest.advanceTimersByTimeAsync(0);
      await expect(
        Promise.race([
          acceptance,
          Promise.resolve({ accepted: false as const }),
        ]),
      ).resolves.toEqual(accepted);
    } finally {
      jest.useRealTimers();
    }

    expect(axiosForBackend).toHaveBeenNthCalledWith(1, {
      url: '/api/inventory-management/movements',
      method: 'POST',
      data: request,
      timeout: 15_000,
    });
    expect(axiosForBackend).toHaveBeenCalledTimes(1);
  });

  it('waits for an accepted manual inbound task only when the page starts background reconciliation', async () => {
    const api = require('../../client/src/api') as Record<string, unknown>;
    const waitForTask = api.waitForManualInventoryInboundTask;
    expect(typeof waitForTask).toBe('function');
    if (typeof waitForTask !== 'function') return;

    jest.useFakeTimers();
    const accepted = {
      accepted: true as const,
      taskId: 'inventory-inbound-manual-task-background-1',
      kind: 'manual' as const,
      status: 'pending' as const,
      message: '入库已受理',
    };
    const result = {
      success: true as const,
      recordId: 'inbound-record-background-1',
      type: 'inbound' as const,
      message: '入库已完成',
    };
    (axiosForBackend as jest.Mock).mockResolvedValueOnce({
      data: {
        success: true,
        task: {
          id: accepted.taskId,
          kind: 'manual',
          status: 'completed',
          message: '入库已完成',
          createdAt: '2026-07-12T10:00:00.000Z',
          updatedAt: '2026-07-12T10:00:01.000Z',
          completedAt: '2026-07-12T10:00:01.000Z',
          result,
        },
      },
    });

    try {
      const completion = (
        waitForTask as (value: typeof accepted) => Promise<typeof result>
      )(accepted);
      await jest.advanceTimersByTimeAsync(800);
      await expect(completion).resolves.toEqual(result);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops inbound task polling immediately when the session is forbidden', async () => {
    const api = require('../../client/src/api') as Record<string, unknown>;
    const waitForTask = api.waitForManualInventoryInboundTask;
    expect(typeof waitForTask).toBe('function');
    if (typeof waitForTask !== 'function') return;

    const accepted = {
      accepted: true as const,
      taskId: 'inventory-inbound-manual-task-forbidden',
      kind: 'manual' as const,
      status: 'pending' as const,
      message: 'accepted',
    };
    const forbidden = Object.assign(new Error('forbidden'), {
      response: { status: 403, data: { message: 'forbidden' } },
    });
    (axiosForBackend as jest.Mock).mockRejectedValueOnce(forbidden);
    jest.useFakeTimers();

    try {
      const outcome = (
        waitForTask as (value: typeof accepted) => Promise<unknown>
      )(accepted).then(
        () => ({ state: 'resolved' as const }),
        (error: unknown) => ({ state: 'rejected' as const, error }),
      );

      await jest.advanceTimersByTimeAsync(800);

      await expect(
        Promise.race([
          outcome,
          Promise.resolve({ state: 'still-pending' as const }),
        ]),
      ).resolves.toEqual({ state: 'rejected', error: forbidden });
      expect(axiosForBackend).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['a network interruption', new Error('network unavailable')],
    [
      'HTTP 503',
      Object.assign(new Error('service unavailable'), {
        response: { status: 503, data: { message: 'service unavailable' } },
      }),
    ],
  ])('continues inbound task polling after %s', async (_label, transientError) => {
    const api = require('../../client/src/api') as Record<string, unknown>;
    const waitForTask = api.waitForManualInventoryInboundTask;
    expect(typeof waitForTask).toBe('function');
    if (typeof waitForTask !== 'function') return;

    const accepted = {
      accepted: true as const,
      taskId: `inventory-inbound-manual-task-retry-${_label}`,
      kind: 'manual' as const,
      status: 'pending' as const,
      message: 'accepted',
    };
    const result = {
      success: true as const,
      recordId: 'inbound-record-after-transient-error',
      type: 'inbound' as const,
      message: 'completed',
    };
    (axiosForBackend as jest.Mock)
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce({
        data: {
          success: true,
          task: {
            id: accepted.taskId,
            kind: 'manual',
            status: 'completed',
            message: 'completed',
            createdAt: '2026-08-24T01:00:00.000Z',
            updatedAt: '2026-08-24T01:00:02.000Z',
            completedAt: '2026-08-24T01:00:02.000Z',
            result,
          },
        },
      });
    jest.useFakeTimers();

    try {
      const completion = (
        waitForTask as (value: typeof accepted) => Promise<typeof result>
      )(accepted);

      await jest.advanceTimersByTimeAsync(800);
      expect(axiosForBackend).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1_200);

      await expect(completion).resolves.toEqual(result);
      expect(axiosForBackend).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('posts an encoded outbound record id and the confirmation mutation id', async () => {
    const request: InventoryOutboundConfirmRequest = {
      clientMutationId: 'outbound-confirm-1',
    };

    await confirmInventoryOutbound('record/with space', request);

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/inventory-management/outbounds/record%2Fwith%20space/confirm',
      method: 'POST',
      data: request,
      timeout: 45_000,
    });
  });

  it('quickly accepts a typed outbound request through the dedicated asynchronous route', async () => {
    const request: InventoryOutboundMovementCreateRequest = {
      type: 'outbound',
      clientMutationId: 'outbound-async-a101',
      catalogRecordId: 'catalog-a101',
      sku: 'A101',
      building: 'A楼',
      quantity: 2,
      occurredAt: '2026-07-12T10:00:00.000Z',
      applicantOpenId: 'ou_applicant',
      reason: '现场更换',
    };
    const accepted: InventoryOutboundAcceptedResponse = {
      accepted: true,
      taskId: 'inventory-outbound-task-1',
      status: 'pending',
      message: '已受理',
    };
    (axiosForBackend as jest.Mock).mockResolvedValueOnce({ data: accepted });

    await expect(submitInventoryOutbound(request)).resolves.toBe(accepted);

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/inventory-management/outbounds',
      method: 'POST',
      data: request,
      timeout: 15_000,
    });
    expect(
      (axiosForBackend as jest.Mock).mock.calls[0][0].data,
    ).not.toHaveProperty('principalFingerprint');
  });

  it('queries an encoded outbound task by building without resubmitting it', async () => {
    const status: InventoryOutboundTaskStatusResponse = {
      success: true,
      task: {
        id: 'task/with space',
        status: 'running',
        message: '同步中',
        createdAt: '2026-07-12T10:00:00.000Z',
      },
    };
    (axiosForBackend as jest.Mock).mockResolvedValueOnce({ data: status });

    await expect(
      getInventoryOutboundTaskStatus('task/with space', 'A楼'),
    ).resolves.toBe(status);

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/inventory-management/outbounds/tasks/task%2Fwith%20space',
      method: 'GET',
      params: { building: 'A楼' },
      timeout: 15_000,
    });
  });

  it('quickly accepts a typed movement deletion through its dedicated asynchronous route', async () => {
    const request: CreateInventoryMovementDeletionRequest = {
      clientMutationId: 'movement-delete-1',
      movementType: 'outbound',
      recordId: 'record/with space',
    };
    const accepted: InventoryMovementDeletionAcceptedResponse = {
      accepted: true,
      taskId: 'movement-deletion-task-1',
      status: 'pending',
      message: '已受理',
    };
    (axiosForBackend as jest.Mock).mockResolvedValueOnce({ data: accepted });

    await expect(createInventoryMovementDeletion(request)).resolves.toBe(
      accepted,
    );

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/inventory-management/movements/deletions',
      method: 'POST',
      data: request,
      timeout: 15_000,
    });
  });

  it('queries an encoded movement deletion task without resubmitting it', async () => {
    const status: InventoryMovementDeletionTaskStatusResponse = {
      success: true,
      task: {
        id: 'task/with space',
        status: 'running',
        message: '删除同步中',
        createdAt: '2026-08-13T02:00:00.000Z',
        updatedAt: '2026-08-13T02:00:01.000Z',
      },
    };
    (axiosForBackend as jest.Mock).mockResolvedValueOnce({ data: status });

    await expect(
      getInventoryMovementDeletionTaskStatus('task/with space'),
    ).resolves.toBe(status);

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/inventory-management/movements/deletions/tasks/task%2Fwith%20space',
      method: 'GET',
      timeout: 15_000,
    });
  });

  it('loads and confirms pending purchase inbound work', async () => {
    (axiosForBackend as jest.Mock)
      .mockResolvedValueOnce({ data: { generatedAt: '', items: [] } })
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({
        data: {
          success: true,
          executionRecordId: 'exec-1',
          catalogRecordId: 'catalog-a101',
          inboundRecordId: 'inbound-exec-1',
          alreadyProcessed: false,
          message: '采购入库已完成',
          notificationWarnings: [],
        },
      });
    await getPendingPurchaseInbounds(true);
    await preparePurchaseInboundCategory({
      executionRecordId: 'exec-1',
      clientMutationId: 'purchase-prepare-1',
      building: 'A楼',
      quantity: 2,
      occurredAt: '2026-07-13T03:00:00.000Z',
      newItem: {
        primaryCategory: '机房耗材',
        secondaryCategory: '过滤器 A2',
        name: '新风滤芯',
        specification: 'MERV 8',
        location: 'A-1F-001',
      },
    });
    await getPurchaseInboundCategoryTaskStatus('purchase-category-task-1');
    await confirmPurchaseInbound({
      executionRecordId: 'exec-1',
      building: 'A楼',
      clientMutationId: 'purchase-confirm-1',
      mode: 'existing',
      catalogRecordId: 'catalog-a101',
      sku: 'A101',
      quantity: 2,
      occurredAt: '2026-07-13T03:00:00.000Z',
    });

    expect(axiosForBackend).toHaveBeenNthCalledWith(1, {
      url: '/api/inventory-management/purchase-inbounds/pending',
      method: 'GET',
      params: { refresh: '1' },
      timeout: 120_000,
    });
    expect(axiosForBackend).toHaveBeenNthCalledWith(2, {
      url: '/api/inventory-management/purchase-inbounds/prepare-category',
      method: 'POST',
      data: expect.objectContaining({
        executionRecordId: 'exec-1',
        clientMutationId: 'purchase-prepare-1',
      }),
      timeout: 10_000,
    });
    expect(axiosForBackend).toHaveBeenNthCalledWith(3, {
      url: '/api/inventory-management/purchase-inbounds/category-tasks/purchase-category-task-1',
      method: 'GET',
      timeout: 30_000,
    });
    expect(axiosForBackend).toHaveBeenNthCalledWith(4, {
      url: '/api/inventory-management/purchase-inbounds/confirm',
      method: 'POST',
      data: expect.objectContaining({
        executionRecordId: 'exec-1',
        catalogRecordId: 'catalog-a101',
      }),
      timeout: 15_000,
    });
  });

  it('preserves definite non-2xx purchase inbound responses for recovery classification', async () => {
    const conflictResponse = {
      status: 409,
      data: {
        message: 'clientMutationId 已被不同的物品类别号请求占用',
      },
    };
    (axiosForBackend as jest.Mock).mockResolvedValue(conflictResponse);

    await expect(
      preparePurchaseInboundCategory({
        executionRecordId: 'exec-conflict',
        clientMutationId: 'prepare-conflict',
        building: 'H楼',
        quantity: 1,
        occurredAt: '2026-08-24T05:00:00.000Z',
        newItem: {
          primaryCategory: 'B工具类',
          secondaryCategory: '检测工具B1',
          name: '地磅秤',
          specification: '0.6*0.8米1吨',
          location: 'H-2F-226储存间01-0F',
          brand: '正峰',
          unit: '台',
          minimumQuantity: 0,
        },
      }),
    ).rejects.toMatchObject({ response: conflictResponse });

    await expect(
      confirmPurchaseInbound({
        executionRecordId: 'exec-conflict',
        clientMutationId: 'confirm-conflict',
        mode: 'new',
        building: 'H楼',
        quantity: 1,
        occurredAt: '2026-08-24T05:00:00.000Z',
        preparedCatalogRecordId: 'catalog-b1056',
        generatedSku: 'B1056',
      }),
    ).rejects.toMatchObject({ response: conflictResponse });
  });

  it('returns an accepted purchase inbound task immediately without polling in the dialog request', async () => {
    jest.useFakeTimers();
    const request: PurchaseInboundConfirmRequest = {
      executionRecordId: 'exec-poll-1',
      building: 'A楼',
      clientMutationId: 'purchase-confirm-poll-1',
      mode: 'existing',
      catalogRecordId: 'catalog-a101',
      sku: 'A101',
      quantity: 2,
      occurredAt: '2026-07-13T03:00:00.000Z',
    };
    const accepted = {
      accepted: true as const,
      taskId: 'inventory-inbound-purchase-task-1',
      kind: 'purchase' as const,
      status: 'pending' as const,
      message: '采购入库已受理',
    };
    (axiosForBackend as jest.Mock).mockResolvedValueOnce({ data: accepted });

    try {
      const acceptance = confirmPurchaseInbound(request);
      await jest.advanceTimersByTimeAsync(0);
      await expect(
        Promise.race([
          acceptance,
          Promise.resolve({ accepted: false as const }),
        ]),
      ).resolves.toEqual(accepted);
    } finally {
      jest.useRealTimers();
    }

    expect(axiosForBackend).toHaveBeenNthCalledWith(1, {
      url: '/api/inventory-management/purchase-inbounds/confirm',
      method: 'POST',
      data: request,
      timeout: 15_000,
    });
    expect(axiosForBackend).toHaveBeenCalledTimes(1);
  });

  it('waits for an accepted purchase inbound task only during background reconciliation', async () => {
    const api = require('../../client/src/api') as Record<string, unknown>;
    const waitForTask = api.waitForPurchaseInventoryInboundTask;
    expect(typeof waitForTask).toBe('function');
    if (typeof waitForTask !== 'function') return;

    jest.useFakeTimers();
    const accepted = {
      accepted: true as const,
      taskId: 'inventory-inbound-purchase-task-background-1',
      kind: 'purchase' as const,
      status: 'pending' as const,
      message: '采购入库已受理',
    };
    const result = {
      success: true as const,
      executionRecordId: 'exec-background-1',
      catalogRecordId: 'catalog-background-1',
      inboundRecordId: 'inbound-background-1',
      alreadyProcessed: false,
      message: '采购入库已完成',
      notificationWarnings: [],
    };
    (axiosForBackend as jest.Mock).mockResolvedValueOnce({
      data: {
        success: true,
        task: {
          id: accepted.taskId,
          kind: 'purchase',
          status: 'completed',
          message: '采购入库已完成',
          createdAt: '2026-07-13T03:00:00.000Z',
          updatedAt: '2026-07-13T03:00:01.000Z',
          completedAt: '2026-07-13T03:00:01.000Z',
          result,
        },
      },
    });

    try {
      const completion = (
        waitForTask as (value: typeof accepted) => Promise<typeof result>
      )(accepted);
      await jest.advanceTimersByTimeAsync(800);
      await expect(completion).resolves.toEqual(result);
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns a deferred purchase inbound task after the polling time budget expires', async () => {
    const api = require('../../client/src/api') as Record<string, unknown>;
    const waitForTask = api.waitForPurchaseInventoryInboundTask;
    expect(typeof waitForTask).toBe('function');
    if (typeof waitForTask !== 'function') return;

    const accepted = {
      accepted: true as const,
      taskId: 'inventory-inbound-purchase-task-deferred-1',
      kind: 'purchase' as const,
      status: 'pending' as const,
      message: '采购入库已受理',
    };
    (axiosForBackend as jest.Mock).mockResolvedValue({
      data: {
        success: true,
        task: {
          id: accepted.taskId,
          kind: 'purchase',
          status: 'pending',
          message: '采购入库仍在后台同步',
          createdAt: '2026-08-25T01:00:00.000Z',
          updatedAt: '2026-08-25T01:00:01.000Z',
        },
      },
    });
    jest.useFakeTimers();

    try {
      const completion = (
        waitForTask as (
          value: typeof accepted,
          options: { maxWaitMs: number },
        ) => Promise<unknown>
      )(accepted, { maxWaitMs: 2_000 });

      await jest.advanceTimersByTimeAsync(2_001);

      await expect(
        Promise.race([
          completion,
          Promise.resolve({ deferred: false as const }),
        ]),
      ).resolves.toMatchObject({
        deferred: true,
        taskId: accepted.taskId,
        kind: 'purchase',
        status: 'pending',
        message: '采购入库仍在后台同步',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('loads workflow status and exposes explicit run and self-test actions', async () => {
    await getInventoryWorkflowStatus();
    await runInventoryWorkflow('purchase_h');
    await runInventoryWorkflowSelfTest();

    expect(axiosForBackend).toHaveBeenNthCalledWith(1, {
      url: '/api/inventory-management/workflows',
      method: 'GET',
      timeout: 120_000,
    });
    expect(axiosForBackend).toHaveBeenNthCalledWith(2, {
      url: '/api/inventory-management/workflows/purchase_h/run',
      method: 'POST',
      timeout: 120_000,
    });
    expect(axiosForBackend).toHaveBeenNthCalledWith(3, {
      url: '/api/inventory-management/workflows/self-test',
      method: 'POST',
      timeout: 180_000,
    });
  });
});

describe('inventory management movement controller', () => {
  const movementCommandService = {
    createMovement: jest.fn().mockResolvedValue({
      success: true,
      recordId: 'inbound-1',
      type: 'inbound',
      message: '入库记录已提交',
    }),
  };
  const storageLocationService = {
    resolveSelectedLocation: jest.fn().mockResolvedValue({
      recordId: 'rec-location-a-001',
      building: 'A楼',
      company: '南通承宏',
      category: '库内',
      name: 'A-1F-001',
    }),
  };
  const controller = new InventoryManagementController(
    {} as never,
    {} as never,
    movementCommandService as never,
    {} as never,
    {} as never,
    {} as never,
    storageLocationService as never,
    {} as never,
  );
  const request = {
    type: 'inbound',
    mode: 'new',
    clientMutationId: 'manual-new-1',
    building: 'A楼',
    quantity: 3,
    occurredAt: '2026-07-12T10:00:00.000Z',
    newItem: {
      primaryCategory: '机房耗材',
      secondaryCategory: '过滤器 A2',
      name: '新风滤芯',
      specification: 'MERV 8',
      location: 'A-1F-001',
      locationRecordId: 'rec-location-a-001',
    },
  } as unknown as InventoryMovementCreateRequest;

  beforeEach(() => {
    movementCommandService.createMovement.mockClear();
    storageLocationService.resolveSelectedLocation.mockClear();
    storageLocationService.resolveSelectedLocation.mockResolvedValue({
      recordId: 'rec-location-a-001',
      building: 'A楼',
      company: '南通承宏',
      category: '库内',
      name: 'A-1F-001',
    });
  });

  it('passes the complete scoped request and caller to the command service', async () => {
    const principal: AccessPrincipal = {
      role: 'admin',
      purchaseBuilding: null,
    };

    await controller.createMovement(
      { accessPrincipal: principal } as never,
      request,
    );

    expect(storageLocationService.resolveSelectedLocation).toHaveBeenCalledWith(
      'A楼',
      'rec-location-a-001',
      'A-1F-001',
    );
    expect(movementCommandService.createMovement).toHaveBeenCalledWith(
      request,
      principal,
    );
  });

  it('does not dispatch a new inbound when the selected location is stale or cross-building', async () => {
    const principal: AccessPrincipal = {
      role: 'admin',
      purchaseBuilding: null,
    };
    storageLocationService.resolveSelectedLocation.mockRejectedValueOnce(
      new BadRequestException('所选存放位置与当前楼栋不匹配'),
    );

    await expect(
      controller.createMovement(
        { accessPrincipal: principal } as never,
        request,
      ),
    ).rejects.toThrow('所选存放位置与当前楼栋不匹配');
    expect(movementCommandService.createMovement).not.toHaveBeenCalled();
  });

  it('requires a storage-location record id before dispatching a new inbound', async () => {
    const principal: AccessPrincipal = {
      role: 'admin',
      purchaseBuilding: null,
    };
    storageLocationService.resolveSelectedLocation.mockRejectedValueOnce(
      new BadRequestException('请选择底表中的存放位置'),
    );
    const requestWithoutLocationRecordId = {
      ...request,
      newItem: {
        ...request.newItem,
        locationRecordId: '',
      },
    } as InventoryMovementCreateRequest;

    await expect(
      controller.createMovement(
        { accessPrincipal: principal } as never,
        requestWithoutLocationRecordId,
      ),
    ).rejects.toThrow('请选择底表中的存放位置');
    expect(storageLocationService.resolveSelectedLocation).toHaveBeenCalledWith(
      'A楼',
      '',
      'A-1F-001',
    );
    expect(movementCommandService.createMovement).not.toHaveBeenCalled();
  });

  it('rejects outbound commands on the legacy movements route before dispatch', () => {
    const principal: AccessPrincipal = {
      role: 'admin',
      purchaseBuilding: null,
    };
    const outboundRequest: InventoryOutboundMovementCreateRequest = {
      type: 'outbound',
      clientMutationId: 'legacy-outbound-a101',
      catalogRecordId: 'catalog-a101',
      sku: 'A101',
      building: 'A楼',
      quantity: 2,
      occurredAt: '2026-07-12T10:00:00.000Z',
      applicantOpenId: 'ou_applicant',
      reason: '现场更换',
    };

    let thrown: unknown;
    try {
      controller.createMovement(
        { accessPrincipal: principal } as never,
        outboundRequest,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getStatus()).toBe(400);
    expect((thrown as BadRequestException).message).toBe(
      '出库申请请使用异步出库接口 /api/inventory-management/outbounds',
    );
    expect(movementCommandService.createMovement).not.toHaveBeenCalled();
  });

  it('keeps authorization scoped to the target building before dispatch', () => {
    const principal: AccessPrincipal = {
      role: 'inventory_admin',
      purchaseBuilding: 'B楼',
    };

    expect(() =>
      controller.createMovement(
        { accessPrincipal: principal } as never,
        request,
      ),
    ).toThrow(new ForbiddenException('无权访问或操作该楼栋库存数据'));
    expect(movementCommandService.createMovement).not.toHaveBeenCalled();
  });
});

describe('inventory management purchase inbound controller', () => {
  const purchaseInboundService = {
    listPending: jest.fn(),
    prepareCategory: jest.fn().mockResolvedValue({
      catalogRecordId: 'catalog-prepared',
      sku: 'A2001',
    }),
    confirm: jest.fn().mockResolvedValue({ success: true }),
  };
  const controller = new InventoryManagementController(
    {} as never,
    {} as never,
    {} as never,
    purchaseInboundService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const request: PurchaseInboundConfirmRequest = {
    executionRecordId: 'execution-a',
    mode: 'existing',
    building: 'A楼',
    clientMutationId: 'purchase-controller-1',
    catalogRecordId: 'catalog-a',
    sku: 'A-01',
    quantity: 1,
    occurredAt: '2026-07-16T10:00:00.000Z',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    purchaseInboundService.listPending.mockResolvedValue({
      generatedAt: '2026-07-16T10:00:00.000Z',
      items: [],
    });
    purchaseInboundService.confirm.mockResolvedValue({ success: true });
  });

  it('fails closed when the purchase category task service is unavailable', async () => {
    const principal: AccessPrincipal = {
      role: 'inventory_admin',
      purchaseBuilding: 'A楼',
    };
    const prepareRequest = {
      executionRecordId: 'execution-a',
      clientMutationId: 'purchase-prepare-controller-1',
      building: 'A楼' as const,
      quantity: 1,
      occurredAt: '2026-07-16T10:00:00.000Z',
      newItem: {
        primaryCategory: '机房耗材',
        secondaryCategory: '过滤器 A2',
        name: '新风滤芯',
        specification: 'MERV 8',
        location: 'A-1F-001',
      },
    };

    await expect(
      controller.preparePurchaseInboundCategory(
        { accessPrincipal: principal } as never,
        prepareRequest,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(purchaseInboundService.prepareCategory).not.toHaveBeenCalled();
  });

  it('passes the caller directly to purchase confirmation without preloading all pending rows', async () => {
    const principal: AccessPrincipal = {
      role: 'inventory_admin',
      purchaseBuilding: 'A楼',
    };

    await controller.confirmPurchaseInbound(
      { accessPrincipal: principal } as never,
      request,
    );

    expect(purchaseInboundService.confirm).toHaveBeenCalledWith(
      request,
      principal,
    );
    expect(purchaseInboundService.listPending).not.toHaveBeenCalled();
  });

  it('delegates target and original-building authorization to the authoritative service snapshot', async () => {
    const principal: AccessPrincipal = {
      role: 'inventory_admin',
      purchaseBuilding: 'A楼',
    };

    await controller.confirmPurchaseInbound(
      { accessPrincipal: principal } as never,
      { ...request, building: 'B楼' },
    );

    expect(purchaseInboundService.confirm).toHaveBeenCalledWith(
      { ...request, building: 'B楼' },
      principal,
    );
    expect(purchaseInboundService.listPending).not.toHaveBeenCalled();
  });
});

describe('inventory management asynchronous inbound controller', () => {
  const categoryTaskService = {
    getTaskStatus: jest.fn().mockResolvedValue({
      success: true,
      task: {
        id: 'purchase-inbound-category-task-1',
        status: 'pending',
      },
    }),
  };
  const inboundTaskService = {
    acceptManual: jest.fn().mockResolvedValue({
      accepted: true,
      taskId: 'inventory-inbound-manual-task-1',
      kind: 'manual',
      status: 'pending',
      message: '入库已受理',
    }),
    acceptPurchase: jest.fn().mockResolvedValue({
      accepted: true,
      taskId: 'inventory-inbound-purchase-task-1',
      kind: 'purchase',
      status: 'pending',
      message: '采购入库已受理',
    }),
    getTaskStatus: jest.fn().mockResolvedValue({
      success: true,
      task: {
        id: 'inventory-inbound-manual-task-1',
        kind: 'manual',
        status: 'pending',
      },
    }),
  };
  const movementCommandService = { createMovement: jest.fn() };
  const purchaseInboundService = { confirm: jest.fn() };
  const storageLocationService = { resolveSelectedLocation: jest.fn() };
  const controller = new InventoryManagementController(
    {} as never,
    {} as never,
    movementCommandService as never,
    purchaseInboundService as never,
    {} as never,
    {} as never,
    storageLocationService as never,
    {} as never,
    undefined,
    categoryTaskService as never,
    inboundTaskService as never,
  );
  const principal: AccessPrincipal = {
    role: 'inventory_admin',
    purchaseBuilding: 'H楼',
  };
  const accessRequest = {
    accessPrincipal: principal,
    accessPrincipalFingerprint: 'principal-fingerprint-inbound-h',
  } as never;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts manual new inbound without waiting for storage-location reads', async () => {
    const request: InventoryMovementCreateRequest = {
      type: 'inbound',
      mode: 'new',
      clientMutationId: 'manual-new-async-1',
      building: 'H楼',
      quantity: 1,
      occurredAt: '2026-08-21T03:00:00.000Z',
      newItem: {
        primaryCategory: 'B工具类',
        secondaryCategory: '检测工具B1',
        name: '地磅秤',
        specification: '0.6*0.8米1吨',
        location: 'H-2F-226储存间01-0F',
        locationRecordId: 'location-h-226',
      },
    };

    await controller.createMovement(accessRequest, request);

    expect(inboundTaskService.acceptManual).toHaveBeenCalledWith(
      request,
      principal,
      'principal-fingerprint-inbound-h',
    );
    expect(storageLocationService.resolveSelectedLocation).not.toHaveBeenCalled();
    expect(movementCommandService.createMovement).not.toHaveBeenCalled();
  });

  it('accepts purchase inbound without waiting for the purchase confirmation write', async () => {
    const request: PurchaseInboundConfirmRequest = {
      executionRecordId: 'purchase-execution-h-1',
      mode: 'existing',
      clientMutationId: 'purchase-inbound-async-1',
      catalogRecordId: 'catalog-b1056',
      sku: 'B1056',
      building: 'H楼',
      quantity: 1,
      occurredAt: '2026-08-21T03:10:00.000Z',
    };

    await controller.confirmPurchaseInbound(accessRequest, request);

    expect(inboundTaskService.acceptPurchase).toHaveBeenCalledWith(
      request,
      principal,
      'principal-fingerprint-inbound-h',
    );
    expect(purchaseInboundService.confirm).not.toHaveBeenCalled();
  });

  it('queries the accepted inbound task without resubmitting it', async () => {
    await controller.getInventoryInboundTask(
      accessRequest,
      'inventory-inbound-manual-task-1',
    );

    expect(inboundTaskService.getTaskStatus).toHaveBeenCalledWith(
      'inventory-inbound-manual-task-1',
      principal,
    );
  });

  it('queries an accepted category task with the current principal after re-login', async () => {
    await controller.getPurchaseInboundCategoryTask(
      accessRequest,
      'purchase-inbound-category-task-1',
    );

    expect(categoryTaskService.getTaskStatus).toHaveBeenCalledWith(
      'purchase-inbound-category-task-1',
      principal,
    );
  });
});

describe('inventory management storage location controller', () => {
  const storageLocationService = {
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({
      item: {
        recordId: 'location-a-001',
        building: 'A楼',
        company: '南通承宏',
        category: '库内',
        name: 'A-1F-001',
      },
      alreadyExists: false,
      clientMutationId: 'storage-location-a-001',
    }),
  };
  const controller = new InventoryManagementController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    storageLocationService as never,
    {} as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scopes storage location queries to the inventory administrator building', async () => {
    const principal: AccessPrincipal = {
      role: 'inventory_admin',
      purchaseBuilding: 'A楼',
    };

    await controller.getStorageLocations(
      { accessPrincipal: principal } as never,
      'B楼',
      ' 001 ',
      '25',
    );

    expect(storageLocationService.list).toHaveBeenCalledWith({
      building: 'A楼',
      query: ' 001 ',
      limit: 25,
    });
  });

  it('rejects cross-building storage location creation before the service call', () => {
    const principal: AccessPrincipal = {
      role: 'inventory_admin',
      purchaseBuilding: 'A楼',
    };
    const request: WarehouseStorageLocationCreateRequest = {
      building: 'B楼',
      category: '库内',
      name: 'B-1F-001',
      clientMutationId: 'storage-location-b-001',
    };

    expect(() =>
      controller.createStorageLocation(
        { accessPrincipal: principal } as never,
        request,
      ),
    ).toThrow(ForbiddenException);
    expect(storageLocationService.create).not.toHaveBeenCalled();
  });
});

describe('inventory management outbound confirmation controller', () => {
  const outboundWorkflowService = {
    acceptPending: jest.fn().mockResolvedValue({
      accepted: true,
      taskId: 'inventory-outbound-task-1',
      status: 'pending',
      message: '已受理',
    }),
    confirm: jest.fn().mockResolvedValue({ success: true }),
    getTaskStatus: jest.fn().mockResolvedValue({
      success: true,
      task: { id: 'inventory-outbound-task-1', status: 'pending' },
    }),
  };
  const controller = new InventoryManagementController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    outboundWorkflowService as never,
  );

  beforeEach(() => {
    outboundWorkflowService.acceptPending.mockClear();
    outboundWorkflowService.confirm.mockClear();
    outboundWorkflowService.getTaskStatus.mockClear();
  });

  it('accepts an outbound request with the authenticated principal fingerprint', async () => {
    const principal: AccessPrincipal = {
      role: 'inventory_admin',
      purchaseBuilding: 'A楼',
    };
    const request: InventoryMovementCreateRequest = {
      type: 'outbound',
      clientMutationId: 'outbound-controller-async-1',
      catalogRecordId: 'catalog-a101',
      sku: 'A101',
      building: 'A楼',
      quantity: 2,
      occurredAt: '2026-07-12T10:00:00.000Z',
      applicantOpenId: 'ou_applicant',
      reason: '现场更换',
    };

    await controller.createInventoryOutbound(
      {
        accessPrincipal: principal,
        accessPrincipalFingerprint: 'principal-fingerprint-controller-a',
      } as never,
      request,
    );

    expect(outboundWorkflowService.acceptPending).toHaveBeenCalledWith(
      request,
      principal,
      'principal-fingerprint-controller-a',
    );
  });

  it('marks an outbound request rejected before service acceptance as definitely not written', async () => {
    const principal: AccessPrincipal = {
      role: 'inventory_admin',
      purchaseBuilding: 'A楼',
    };

    let caught: unknown;
    try {
      await controller.createInventoryOutbound(
        {
          accessPrincipal: principal,
          accessPrincipalFingerprint: 'principal-fingerprint-controller-a',
        } as never,
        { type: 'inbound' } as never,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(400);
    expect((caught as HttpException).getResponse()).toMatchObject({
      definitelyNotWritten: true,
      writeDisposition: 'definitely-not-written',
    });
    expect(outboundWorkflowService.acceptPending).not.toHaveBeenCalled();
  });

  it.each([
    ['HTTP 409', new ConflictException('编号冲突')],
    ['HTTP 503', new ServiceUnavailableException('账本响应结果未知')],
  ])(
    'does not mark an unclassified outbound acceptance %s failure as definitely not written',
    async (_label, failure) => {
      const principal: AccessPrincipal = {
        role: 'inventory_admin',
        purchaseBuilding: 'A楼',
      };
      const request: InventoryOutboundMovementCreateRequest = {
        type: 'outbound',
        clientMutationId: `outbound-controller-failure-${failure.getStatus()}`,
        catalogRecordId: 'catalog-a101',
        sku: 'A101',
        building: 'A楼',
        quantity: 2,
        occurredAt: '2026-07-12T10:00:00.000Z',
        applicantOpenId: 'ou_applicant',
        reason: '现场更换',
      };
      outboundWorkflowService.acceptPending.mockRejectedValueOnce(failure);

      let caught: unknown;
      try {
        await controller.createInventoryOutbound(
          {
            accessPrincipal: principal,
            accessPrincipalFingerprint: 'principal-fingerprint-controller-a',
          } as never,
          request,
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(failure);
      expect((caught as HttpException).getResponse()).not.toMatchObject({
        definitelyNotWritten: true,
      });
    },
  );

  it('does not mark outbound task query failures as definitely not written', async () => {
    const principal: AccessPrincipal = {
      role: 'inventory_admin',
      purchaseBuilding: 'A楼',
    };
    const failure = new ConflictException('任务状态冲突');
    outboundWorkflowService.getTaskStatus.mockRejectedValueOnce(failure);

    await expect(
      controller.getInventoryOutboundTask(
        {
          accessPrincipal: principal,
          accessPrincipalFingerprint: 'principal-fingerprint-controller-a',
        } as never,
        'inventory-outbound-task-1',
        'A楼',
      ),
    ).rejects.toBe(failure);
    expect(failure.getResponse()).not.toMatchObject({
      writeDisposition: 'definitely-not-written',
    });
  });

  it('queries a task with both the requested building and principal fingerprint', async () => {
    const principal: AccessPrincipal = {
      role: 'inventory_admin',
      purchaseBuilding: 'A楼',
    };

    await controller.getInventoryOutboundTask(
      {
        accessPrincipal: principal,
        accessPrincipalFingerprint: 'principal-fingerprint-controller-a',
      } as never,
      'inventory-outbound-task-1',
      'A楼',
    );

    expect(outboundWorkflowService.getTaskStatus).toHaveBeenCalledWith(
      'inventory-outbound-task-1',
      'A楼',
      principal,
      'principal-fingerprint-controller-a',
    );
  });

  it('passes the record id, mutation id, and authenticated principal to the authoritative service', async () => {
    const principal: AccessPrincipal = {
      role: 'inventory_admin',
      purchaseBuilding: 'A楼',
    };
    const request: InventoryOutboundConfirmRequest = {
      clientMutationId: 'outbound-confirm-controller-1',
    };

    await controller.confirmInventoryOutbound(
      { accessPrincipal: principal } as never,
      'outbound-record-1',
      request,
    );

    expect(outboundWorkflowService.confirm).toHaveBeenCalledWith(
      'outbound-record-1',
      request,
      principal,
    );
  });

  it('registers the outbound workflow service as a module provider', () => {
    const providers = Reflect.getMetadata(
      'providers',
      InventoryManagementModule,
    );

    expect(providers).toContain(InventoryOutboundWorkflowService);
    expect(providers).toContain(InventoryOutboundTaskLedgerStore);
    expect(providers).toContain(InventoryInboundTaskLedgerStore);
    expect(providers).toContain(InventoryInboundTaskService);
    expect(providers).toContain(PurchaseInboundCategoryTaskLedgerStore);
    expect(providers).toContain(PurchaseInboundCategoryTaskService);
  });
});
