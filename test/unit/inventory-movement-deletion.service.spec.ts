jest.mock(
  '@server/common/config/external-services.config',
  () =>
    jest.requireActual('../../server/common/config/external-services.config'),
  { virtual: true },
);

jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  resolveBitableAppToken: jest.fn(
    async (_httpService: unknown, options: { appToken?: string }) =>
      options.appToken || 'resolved-app-token',
  ),
}));

import { ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { CreateInventoryMovementDeletionRequest } from '../../shared/inventory-management.interface';
import {
  InventoryMovementDeletionService,
  type InventoryMovementDeletionServiceOptions,
} from '../../server/modules/inventory-management/inventory-movement-deletion.service';
import {
  buildInventoryMovementDeletionRequestFingerprint,
  InventoryMovementDeletionTaskLedgerStore,
  type InventoryMovementDeletionTaskLedgerEntry,
} from '../../server/modules/inventory-management/inventory-movement-deletion-task-ledger.store';
import { InventoryMovementOperationCoordinator } from '../../server/modules/inventory-management/inventory-movement-operation-coordinator';
import {
  InventoryWorkflowRecordDefinitelyNotDeletedError,
  InventoryWorkflowRecordDeleteUncertainError,
} from '../../server/modules/inventory-management/inventory-workflow.gateway';

const ADMIN: AccessPrincipal = { role: 'admin', purchaseBuilding: null };
const INVENTORY_ADMIN_A: AccessPrincipal = {
  role: 'inventory_admin',
  purchaseBuilding: 'A楼',
};
const PRINCIPAL_FINGERPRINT = 'principal-fingerprint-delete-admin';
const REQUEST: CreateInventoryMovementDeletionRequest = {
  clientMutationId: 'movement-delete-001',
  movementType: 'inbound',
  recordId: 'rec-inbound-001',
};
const ENV_KEYS = [
  'FEISHU_WAREHOUSE_APP_TOKEN',
  'FEISHU_WAREHOUSE_INBOUND_TABLE_ID',
  'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID',
  'FEISHU_PURCHASE_INVENTORY_APP_TOKEN',
  'FEISHU_PURCHASE_EXECUTION_TABLE_ID',
] as const;

describe('InventoryMovementDeletionService', () => {
  const originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  let directory: string;
  let ledgerPath: string;
  let gateway: ReturnType<typeof createGateway>;
  let managementService: { invalidateCache: jest.Mock };
  let purchaseInventoryService: { invalidateCache: jest.Mock };
  let services: InventoryMovementDeletionService[];
  let loggerError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    directory = mkdtempSync(join(tmpdir(), 'movement-delete-service-'));
    ledgerPath = join(directory, 'ledger.json');
    process.env.FEISHU_WAREHOUSE_APP_TOKEN = 'warehouse-app';
    process.env.FEISHU_WAREHOUSE_INBOUND_TABLE_ID = 'tbl-inbound';
    process.env.FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID = 'tbl-outbound';
    process.env.FEISHU_PURCHASE_INVENTORY_APP_TOKEN = 'purchase-app';
    process.env.FEISHU_PURCHASE_EXECUTION_TABLE_ID = 'tbl-execution';
    gateway = createGateway();
    managementService = { invalidateCache: jest.fn() };
    purchaseInventoryService = { invalidateCache: jest.fn() };
    services = [];
  });

  afterEach(async () => {
    await Promise.all(services.map((service) => service.onModuleDestroy()));
    loggerError.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('returns accepted before deletion completes and persists the terminal result', async () => {
    const deleteGate = deferred<void>();
    gateway.tryGetRecord.mockResolvedValueOnce(inboundRecord('A楼'));
    gateway.deleteRecordAndConfirmAbsent.mockImplementationOnce(
      () => deleteGate.promise,
    );
    const { service, ledger } = createService();

    const accepted = await service.accept(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );

    expect(accepted).toMatchObject({ accepted: true, status: 'pending' });
    expect(gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
    await waitFor(
      () => gateway.deleteRecordAndConfirmAbsent.mock.calls.length === 1,
    );
    expect((await ledger.findByTaskId(accepted.taskId))?.task.status).toBe(
      'running',
    );

    deleteGate.resolve();
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'completed',
    );
    const restarted = new InventoryMovementDeletionTaskLedgerStore(ledgerPath);
    expect((await restarted.findByTaskId(accepted.taskId))?.task).toMatchObject(
      {
        status: 'completed',
        result: {
          recordId: REQUEST.recordId,
          type: 'inbound',
          purchaseRolledBack: false,
        },
      },
    );
    expect(managementService.invalidateCache).toHaveBeenCalled();
    expect(purchaseInventoryService.invalidateCache).toHaveBeenCalled();
  });

  it('deletes an outbound record without writing the inventory master table', async () => {
    gateway.tryGetRecord.mockResolvedValueOnce(outboundRecord('A楼', '已出库'));
    const request = {
      ...REQUEST,
      clientMutationId: 'movement-delete-outbound-001',
      movementType: 'outbound' as const,
      recordId: 'rec-outbound-001',
    };
    const { service, ledger } = createService();

    const accepted = await service.accept(
      request,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'completed',
    );

    expect(gateway.deleteRecordAndConfirmAbsent).toHaveBeenCalledWith(
      'warehouse-app',
      'tbl-outbound',
      request.recordId,
      '出库填写',
    );
    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it('allows an inventory administrator only for the server-read own building', async () => {
    gateway.tryGetRecord.mockResolvedValueOnce(inboundRecord('B楼'));
    const { service, ledger } = createService();

    const accepted = await service.accept(
      REQUEST,
      INVENTORY_ADMIN_A,
      'principal-fingerprint-inventory-a',
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status === 'failed',
    );

    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'failed',
      definitelyNotDeleted: true,
    });
    expect(gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
  });

  it('rejects an A-building inbound linked to a B-building purchase with zero writes', async () => {
    gateway.tryGetRecord.mockImplementation(
      async (_appToken: string, tableId: string) =>
        tableId === 'tbl-inbound'
          ? inboundRecord('A楼', '采购:exec-001')
          : purchaseExecutionCompleted('B楼'),
    );
    gateway.getFieldSchemas.mockResolvedValue(purchaseExecutionSchemas());
    const { service, ledger } = createService();

    const accepted = await service.accept(
      REQUEST,
      INVENTORY_ADMIN_A,
      'principal-fingerprint-inventory-a',
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status === 'failed',
    );

    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'failed',
      definitelyNotDeleted: true,
    });
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
  });

  it('treats an already absent movement as idempotently completed', async () => {
    gateway.tryGetRecord.mockResolvedValueOnce(undefined);
    const { service, ledger } = createService();

    const accepted = await service.accept(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'completed',
    );

    expect(gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'completed',
      result: { message: expect.stringContaining('已不存在') },
    });
    expect(managementService.invalidateCache).toHaveBeenCalled();
    expect(gateway.invalidateRecordsCache).toHaveBeenCalledWith(
      'warehouse-app',
      'tbl-inbound',
    );
  });

  it('rolls a purchase-linked inbound back to pending before deletion', async () => {
    let execution = purchaseExecutionCompleted();
    let acceptedTaskId = '';
    let ledgerForWriteCheck!: InventoryMovementDeletionTaskLedgerStore;
    let recoveryAtFirstWrite: unknown;
    gateway.tryGetRecord.mockImplementation(
      async (_appToken: string, tableId: string) =>
        tableId === 'tbl-inbound'
          ? inboundRecord('A楼', '采购:exec-001')
          : execution,
    );
    gateway.getFieldSchemas.mockResolvedValue(purchaseExecutionSchemas());
    gateway.updateRecord.mockImplementation(
      async (
        _appToken: string,
        _tableId: string,
        _recordId: string,
        fields: Record<string, unknown>,
      ) => {
        recoveryAtFirstWrite = (
          await ledgerForWriteCheck.findByTaskId(acceptedTaskId)
        )?.recovery;
        execution = {
          ...execution,
          fields: { ...execution.fields, ...fields },
        };
      },
    );
    const { service, ledger } = createService();
    ledgerForWriteCheck = ledger;

    const accepted = await service.accept(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    acceptedTaskId = accepted.taskId;
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'completed',
    );

    expect(gateway.updateRecord).toHaveBeenCalledWith(
      'purchase-app',
      'tbl-execution',
      'exec-001',
      {
        是否已入库: false,
        采购流程: '到货已签收（待入库）',
        程序采购状态: '物品签收（待入库）',
      },
      '采购执行',
    );
    expect(execution.fields).toMatchObject({
      是否已入库: false,
      采购流程: '到货已签收（待入库）',
      程序采购状态: '物品签收（待入库）',
    });
    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'completed',
      result: { purchaseRolledBack: true },
    });
    expect(recoveryAtFirstWrite).toMatchObject({ phase: 'prepared' });
  });

  it('does not delete when rollback fields match but purchase derivation still says completed', async () => {
    const original = purchaseExecutionCompleted();
    let execution = original;
    gateway.tryGetRecord.mockImplementation(
      async (_appToken: string, tableId: string) =>
        tableId === 'tbl-inbound'
          ? inboundRecord('A楼', '采购:exec-001')
          : execution,
    );
    gateway.getFieldSchemas.mockResolvedValue([
      {
        fieldName: '采购流程',
        type: 1,
        uiType: 'Text',
        writable: false,
      },
      {
        fieldName: '程序采购状态',
        type: 1,
        uiType: 'Text',
        writable: true,
      },
    ]);
    gateway.updateRecord.mockImplementation(
      async (
        _appToken: string,
        _tableId: string,
        _recordId: string,
        fields: Record<string, unknown>,
      ) => {
        execution = {
          ...execution,
          fields: { ...execution.fields, ...fields },
        };
      },
    );
    const { service, ledger } = createService();

    const accepted = await service.accept(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status === 'failed',
    );

    expect(gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
    expect(execution.fields).toEqual(original.fields);
    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'failed',
      definitelyNotDeleted: true,
    });
  });

  it('conditionally compensates purchase fields when deletion definitely fails', async () => {
    const original = purchaseExecutionCompleted();
    let execution = original;
    gateway.tryGetRecord.mockImplementation(
      async (_appToken: string, tableId: string) =>
        tableId === 'tbl-inbound'
          ? inboundRecord('A楼', '采购:exec-001')
          : execution,
    );
    gateway.getFieldSchemas.mockResolvedValue(purchaseExecutionSchemas());
    gateway.updateRecord.mockImplementation(
      async (
        _appToken: string,
        _tableId: string,
        _recordId: string,
        fields: Record<string, unknown>,
      ) => {
        execution = {
          ...execution,
          fields: { ...execution.fields, ...fields },
        };
      },
    );
    gateway.deleteRecordAndConfirmAbsent.mockRejectedValueOnce(
      new InventoryWorkflowRecordDefinitelyNotDeletedError('入库填写'),
    );
    const { service, ledger } = createService();

    const accepted = await service.accept(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status === 'failed',
    );

    expect(gateway.updateRecord).toHaveBeenCalledTimes(2);
    expect(execution.fields).toEqual(original.fields);
    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'failed',
      definitelyNotDeleted: true,
    });
    expect(gateway.invalidateRecordsCache).toHaveBeenCalledWith(
      'warehouse-app',
      'tbl-inbound',
    );
    expect(purchaseInventoryService.invalidateCache).toHaveBeenCalled();
  });

  it('does not compensate purchase fields when deletion outcome is uncertain', async () => {
    let execution = purchaseExecutionCompleted();
    gateway.tryGetRecord.mockImplementation(
      async (_appToken: string, tableId: string) =>
        tableId === 'tbl-inbound'
          ? inboundRecord('A楼', '采购:exec-001')
          : execution,
    );
    gateway.getFieldSchemas.mockResolvedValue(purchaseExecutionSchemas());
    gateway.updateRecord.mockImplementation(
      async (
        _appToken: string,
        _tableId: string,
        _recordId: string,
        fields: Record<string, unknown>,
      ) => {
        execution = {
          ...execution,
          fields: { ...execution.fields, ...fields },
        };
      },
    );
    gateway.deleteRecordAndConfirmAbsent.mockRejectedValueOnce(
      new InventoryWorkflowRecordDeleteUncertainError('入库填写'),
    );
    const { service, ledger } = createService();

    const accepted = await service.accept(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'uncertain',
    );

    expect(gateway.updateRecord).toHaveBeenCalledTimes(1);
    expect(execution.fields).toMatchObject({
      是否已入库: false,
      程序采购状态: '物品签收（待入库）',
    });
    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'uncertain',
      definitelyNotDeleted: false,
    });
    expect(gateway.invalidateRecordsCache).toHaveBeenCalledWith(
      'warehouse-app',
      'tbl-inbound',
    );
    expect(purchaseInventoryService.invalidateCache).toHaveBeenCalled();
  });

  it('bounds transient preflight retries and then fails definitely not deleted', async () => {
    gateway.tryGetRecord.mockRejectedValue(
      Object.assign(new Error('read timeout'), { code: 'ETIMEDOUT' }),
    );
    const { service, ledger } = createService({
      maxPreflightAttempts: 2,
      retryDelayMs: 1,
    });

    const accepted = await service.accept(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status === 'failed',
    );

    expect(gateway.tryGetRecord).toHaveBeenCalledTimes(2);
    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'failed',
      definitelyNotDeleted: true,
    });
  });

  it('reconciles an expired running deletion from authoritative absence after restart', async () => {
    let now = new Date('2026-08-13T01:00:00.000Z');
    const firstLedger = new InventoryMovementDeletionTaskLedgerStore(
      ledgerPath,
      {
        now: () => now,
        taskLeaseMs: 1_000,
      },
    );
    const seeded = pendingLedgerEntry();
    await firstLedger.reserve(seeded);
    const claimed = await firstLedger.claimPending(seeded.task.id);
    await firstLedger.updateRecoveryState(seeded.task.id, {
      version: 1,
      phase: 'delete_started',
      movement: {
        building: 'A楼',
        purchaseExecutionRecordId: '',
        sku: 'D1001',
        quantity: 2,
      },
    });
    await firstLedger.updateTask(seeded.task.id, {
      ...claimed.entry.task,
      status: 'running',
      message: '正在删除飞书记录',
      updatedAt: now.toISOString(),
    });

    now = new Date('2026-08-13T01:00:02.000Z');
    gateway.tryGetRecord.mockResolvedValue(undefined);
    const restartedLedger = new InventoryMovementDeletionTaskLedgerStore(
      ledgerPath,
      {
        now: () => now,
        taskLeaseMs: 1_000,
      },
    );
    const service = new InventoryMovementDeletionService(
      {} as never,
      gateway as never,
      managementService as never,
      restartedLedger,
      new InventoryMovementOperationCoordinator(),
      {
        now: () => now,
        retryDelayMs: 5,
        recoveryScanDelayMs: 5_000,
      },
      purchaseInventoryService as never,
    );
    services.push(service);

    await service.onModuleInit();
    await waitFor(
      async () =>
        (await restartedLedger.findByTaskId(seeded.task.id))?.task.status ===
        'completed',
    );

    expect(gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
    expect(
      (await restartedLedger.findByTaskId(seeded.task.id))?.task,
    ).toMatchObject({
      status: 'completed',
      result: { purchaseRolledBack: false },
    });
  });

  it('resumes deletion after restart when purchase rollback is authoritatively pending', async () => {
    let now = new Date('2026-08-13T01:00:00.000Z');
    const firstLedger = new InventoryMovementDeletionTaskLedgerStore(
      ledgerPath,
      {
        now: () => now,
        taskLeaseMs: 1_000,
      },
    );
    const seeded = pendingLedgerEntry();
    await firstLedger.reserve(seeded);
    const claimed = await firstLedger.claimPending(seeded.task.id);
    const preparedRecovery = purchaseRollbackRecoveryState();
    await firstLedger.updateRecoveryState(seeded.task.id, preparedRecovery);
    await firstLedger.updateRecoveryState(seeded.task.id, {
      ...preparedRecovery,
      phase: 'purchase_rolled_back',
    });
    await firstLedger.updateTask(seeded.task.id, {
      ...claimed.entry.task,
      status: 'running',
      message: '正在删除飞书记录',
      updatedAt: now.toISOString(),
    });

    now = new Date('2026-08-13T01:00:02.000Z');
    const pendingExecution = {
      ...purchaseExecutionCompleted(),
      fields: {
        ...purchaseExecutionCompleted().fields,
        是否已入库: false,
        采购流程: '到货已签收（待入库）',
        程序采购状态: '物品签收（待入库）',
      },
    };
    gateway.tryGetRecord.mockImplementation(
      async (_appToken: string, tableId: string) =>
        tableId === 'tbl-inbound'
          ? inboundRecord('A楼', '采购:exec-001')
          : pendingExecution,
    );
    const restartedLedger = new InventoryMovementDeletionTaskLedgerStore(
      ledgerPath,
      {
        now: () => now,
        taskLeaseMs: 1_000,
      },
    );
    const service = new InventoryMovementDeletionService(
      {} as never,
      gateway as never,
      managementService as never,
      restartedLedger,
      new InventoryMovementOperationCoordinator(),
      {
        now: () => now,
        retryDelayMs: 5,
        recoveryScanDelayMs: 5_000,
      },
      purchaseInventoryService as never,
    );
    services.push(service);

    await service.onModuleInit();
    await waitFor(
      async () =>
        (await restartedLedger.findByTaskId(seeded.task.id))?.task.status ===
        'completed',
    );

    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(gateway.deleteRecordAndConfirmAbsent).toHaveBeenCalledTimes(1);
    expect(
      (await restartedLedger.findByTaskId(seeded.task.id))?.task,
    ).toMatchObject({
      status: 'completed',
      result: { purchaseRolledBack: true },
    });
  });

  it.each([
    {
      scenario: '补偿写入失败',
      compensationMode: 'failed' as const,
      expectedWarning: '采购状态自动补偿失败：补偿写入超时',
    },
    {
      scenario: '采购状态变化导致补偿跳过',
      compensationMode: 'skipped' as const,
      expectedWarning: '采购状态已被其他操作改变，未执行自动补偿',
    },
  ])(
    'preserves the compensation warning when recovered deletion definitely fails: $scenario',
    async ({ compensationMode, expectedWarning }) => {
      let now = new Date('2026-08-13T01:00:00.000Z');
      const firstLedger = new InventoryMovementDeletionTaskLedgerStore(
        ledgerPath,
        {
          now: () => now,
          taskLeaseMs: 1_000,
        },
      );
      const seeded = pendingLedgerEntry();
      await firstLedger.reserve(seeded);
      const claimed = await firstLedger.claimPending(seeded.task.id);
      const preparedRecovery = purchaseRollbackRecoveryState();
      await firstLedger.updateRecoveryState(seeded.task.id, preparedRecovery);
      await firstLedger.updateRecoveryState(seeded.task.id, {
        ...preparedRecovery,
        phase: 'purchase_rolled_back',
      });
      await firstLedger.updateTask(seeded.task.id, {
        ...claimed.entry.task,
        status: 'running',
        message: '正在删除飞书记录',
        updatedAt: now.toISOString(),
      });

      now = new Date('2026-08-13T01:00:02.000Z');
      const pendingExecution = {
        ...purchaseExecutionCompleted(),
        fields: {
          ...purchaseExecutionCompleted().fields,
          ...preparedRecovery.purchase.rollbackFields,
        },
      };
      let executionReadCount = 0;
      gateway.tryGetRecord.mockImplementation(
        async (_appToken: string, tableId: string) => {
          if (tableId === 'tbl-inbound') {
            return inboundRecord('A楼', '采购:exec-001');
          }
          executionReadCount += 1;
          if (executionReadCount === 1 || compensationMode === 'failed') {
            return pendingExecution;
          }
          return purchaseExecutionCompleted();
        },
      );
      if (compensationMode === 'failed') {
        gateway.updateRecord.mockRejectedValueOnce(new Error('补偿写入超时'));
      }
      gateway.deleteRecordAndConfirmAbsent.mockRejectedValueOnce(
        new InventoryWorkflowRecordDefinitelyNotDeletedError('入库填写'),
      );
      const restartedLedger = new InventoryMovementDeletionTaskLedgerStore(
        ledgerPath,
        {
          now: () => now,
          taskLeaseMs: 1_000,
        },
      );
      const service = new InventoryMovementDeletionService(
        {} as never,
        gateway as never,
        managementService as never,
        restartedLedger,
        new InventoryMovementOperationCoordinator(),
        {
          now: () => now,
          retryDelayMs: 5,
          recoveryScanDelayMs: 5_000,
        },
        purchaseInventoryService as never,
      );
      services.push(service);

      await service.onModuleInit();
      await waitFor(
        async () =>
          (await restartedLedger.findByTaskId(seeded.task.id))?.task.status ===
          'failed',
      );

      const task = (await restartedLedger.findByTaskId(seeded.task.id))?.task;
      expect(task).toMatchObject({
        status: 'failed',
        definitelyNotDeleted: true,
      });
      expect(task?.message).toContain('删除入库填写记录失败，已确认记录未删除');
      expect(task?.message).toContain(expectedWarning);
    },
  );

  it('enforces request idempotency and task-query ownership', async () => {
    gateway.tryGetRecord.mockResolvedValueOnce(undefined);
    const { service } = createService();
    const accepted = await service.accept(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    const duplicate = await service.accept(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    expect(duplicate.taskId).toBe(accepted.taskId);

    await expect(
      service.accept(
        { ...REQUEST, recordId: 'rec-inbound-other' },
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).rejects.toThrow(ConflictException);
    await expect(
      service.getTaskStatus(
        accepted.taskId,
        ADMIN,
        'principal-fingerprint-other',
      ),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.accept(
        { ...REQUEST, clientMutationId: 'movement-delete-editor' },
        { role: 'editor', purchaseBuilding: null },
        'principal-fingerprint-editor',
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  function createService(
    options: InventoryMovementDeletionServiceOptions = {},
  ) {
    const ledger = new InventoryMovementDeletionTaskLedgerStore(ledgerPath, {
      taskLeaseMs: 1_000,
    });
    const service = new InventoryMovementDeletionService(
      {} as never,
      gateway as never,
      managementService as never,
      ledger,
      new InventoryMovementOperationCoordinator(),
      {
        retryDelayMs: 5,
        recoveryScanDelayMs: 5_000,
        ...options,
      },
      purchaseInventoryService as never,
    );
    services.push(service);
    return { service, ledger };
  }
});

function createGateway() {
  return {
    tryGetRecord: jest.fn(),
    getFieldSchemas: jest.fn(),
    updateRecord: jest.fn().mockResolvedValue(undefined),
    deleteRecordAndConfirmAbsent: jest.fn().mockResolvedValue(undefined),
    invalidateRecordsCache: jest.fn(),
  };
}

function inboundRecord(building: string, source = '手工:inbound-001') {
  return {
    record_id: REQUEST.recordId,
    fields: {
      楼栋: building,
      入库来源: source,
      入库数量: 2,
      物品类别号: 'D1001',
    },
  };
}

function outboundRecord(building: string, status: string) {
  return {
    record_id: 'rec-outbound-001',
    fields: { 楼栋: building, 程序出库状态: status, 出库数量: 2 },
  };
}

function purchaseExecutionCompleted(building = 'A楼') {
  return {
    record_id: 'exec-001',
    fields: {
      采购编码: 'CG260813-001',
      申请楼栋: building,
      物品类别码: 'D1001',
      是否已入库: true,
      采购流程: '采购完成（已入库）',
      程序采购状态: '物品签收已入库',
      实际采购数量: 2,
    },
  };
}

function pendingLedgerEntry(): InventoryMovementDeletionTaskLedgerEntry {
  return {
    principal: ADMIN,
    principalFingerprint: PRINCIPAL_FINGERPRINT,
    requestFingerprint:
      buildInventoryMovementDeletionRequestFingerprint(REQUEST),
    request: REQUEST,
    attemptCount: 0,
    task: {
      id: 'inventory-movement-deletion-recovery-task-1',
      status: 'pending',
      message: '删除申请已受理',
      createdAt: '2026-08-13T01:00:00.000Z',
      updatedAt: '2026-08-13T01:00:00.000Z',
    },
  };
}

function purchaseRollbackRecoveryState() {
  return {
    version: 1,
    phase: 'prepared',
    movement: {
      building: 'A楼',
      purchaseExecutionRecordId: 'exec-001',
      sku: 'D1001',
      quantity: 2,
    },
    purchase: {
      executionRecordId: 'exec-001',
      building: 'A楼',
      requestCode: 'CG260813-001',
      sku: 'D1001',
      quantity: 2,
      originalFields: {
        是否已入库: true,
        采购流程: '采购完成（已入库）',
        程序采购状态: '物品签收已入库',
      },
      rollbackFields: {
        是否已入库: false,
        采购流程: '到货已签收（待入库）',
        程序采购状态: '物品签收（待入库）',
      },
    },
  } as const;
}

function purchaseExecutionSchemas() {
  return [
    { fieldName: '是否已入库', type: 7, uiType: 'Checkbox', writable: true },
    { fieldName: '采购流程', type: 1, uiType: 'Text', writable: true },
    {
      fieldName: '程序采购状态',
      type: 1,
      uiType: 'Text',
      writable: true,
    },
  ];
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  throw new Error('timed out waiting for condition');
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
