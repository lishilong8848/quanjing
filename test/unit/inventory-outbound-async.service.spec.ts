jest.mock(
  '@server/common/config/external-services.config',
  () =>
    jest.requireActual('../../server/common/config/external-services.config'),
  { virtual: true },
);

jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  resolveBitableAppToken: jest.fn().mockResolvedValue('app-token'),
  fetchBitableRecords: jest.fn(),
}));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryOutboundApprovalStore } from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.store';
import { InventoryOutboundApprovalService } from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.service';
import type { InventoryOutboundApprovalSnapshot } from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.types';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { InventoryOutboundMovementCreateRequest } from '../../shared/inventory-management.interface';
import {
  fetchBitableRecords,
  resolveBitableAppToken,
} from '../../server/common/feishu/bitable-direct-read';
import {
  InventoryOutboundWorkflowService,
  isInventoryOutboundAcceptanceDefinitelyNotWrittenError,
} from '../../server/modules/inventory-management/inventory-outbound-workflow.service';
import {
  InventoryOutboundTaskLedgerStore,
  type InventoryOutboundTaskLedgerStoreOptions,
} from '../../server/modules/inventory-management/inventory-outbound-task-ledger.store';
import {
  InventoryWorkflowGateway,
  InventoryWorkflowRecordDefinitelyNotWrittenError,
  InventoryWorkflowRecordWriteUncertainError,
} from '../../server/modules/inventory-management/inventory-workflow.gateway';

const ENV_KEYS = [
  'FEISHU_WAREHOUSE_SOURCE_URL',
  'FEISHU_WAREHOUSE_APP_TOKEN',
  'FEISHU_WAREHOUSE_INVENTORY_TABLE_ID',
  'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID',
  'FEISHU_WAREHOUSE_CATALOG_TABLE_ID',
] as const;

const REQUEST: InventoryOutboundMovementCreateRequest = {
  type: 'outbound',
  clientMutationId: 'outbound-async-1',
  catalogRecordId: 'catalog-a101',
  sku: 'A101',
  building: 'A楼',
  quantity: 2,
  occurredAt: '2026-07-12T10:00:00.000Z',
  applicantOpenId: 'ou_applicant',
  reason: '现场更换',
};

const ADMIN: AccessPrincipal = { role: 'admin', purchaseBuilding: null };
const PRINCIPAL_FINGERPRINT = 'principal-fingerprint-admin-a';

type AsyncOutboundService = InventoryOutboundWorkflowService & {
  onModuleInit(): Promise<void>;
  onModuleDestroy?(): Promise<void>;
  recoverUnregisteredOutbound(recordId: string): Promise<void>;
  acceptPending(
    request: InventoryOutboundMovementCreateRequest,
    principal: AccessPrincipal,
    principalFingerprint: string,
  ): Promise<{
    accepted: true;
    taskId: string;
    status: string;
    message: string;
  }>;
  getTaskStatus(
    taskId: string,
    building: string,
    principal: AccessPrincipal,
    principalFingerprint: string,
  ): Promise<{
    success: true;
    task: {
      id: string;
      status: string;
      result?: { movement: { status: string } };
    };
  }>;
};

describe('InventoryOutboundWorkflowService async submission', () => {
  const originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  let directory: string;
  let ledgerPath: string;
  let gateway: ReturnType<typeof createGateway>;
  let persistedFields: Record<string, unknown> | null;
  let loggerError: jest.SpyInstance;
  let loggerWarn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    loggerWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    directory = mkdtempSync(join(tmpdir(), 'inventory-outbound-async-'));
    ledgerPath = join(directory, 'ledger.json');
    process.env.FEISHU_WAREHOUSE_SOURCE_URL =
      'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE';
    delete process.env.FEISHU_WAREHOUSE_APP_TOKEN;
    process.env.FEISHU_WAREHOUSE_INVENTORY_TABLE_ID = 'tbl_inventory';
    process.env.FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID = 'tbl_outbound';
    process.env.FEISHU_WAREHOUSE_CATALOG_TABLE_ID = 'tbl_catalog';
    (resolveBitableAppToken as jest.Mock).mockResolvedValue('app-token');
    (fetchBitableRecords as jest.Mock).mockImplementation(
      (_httpService: unknown, options: { tableId: string }) =>
        Promise.resolve(
          options.tableId === 'tbl_catalog'
            ? [catalogRecord()]
            : options.tableId === 'tbl_inventory'
              ? [inventoryRecord()]
              : [],
        ),
    );
    persistedFields = null;
    gateway = createGateway(() => persistedFields);
    gateway.createRecord.mockImplementation(
      async (
        _appToken: string,
        _tableId: string,
        fields: Record<string, unknown>,
      ) => {
        persistedFields = { ...fields };
        return 'outbound-record-1';
      },
    );
  });

  afterEach(() => {
    loggerError.mockRestore();
    loggerWarn.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('returns accepted before the Base POST has completed', async () => {
    const postGate = deferred<void>();
    gateway.createRecord.mockImplementation(
      async (
        _appToken: string,
        _tableId: string,
        fields: Record<string, unknown>,
      ) => {
        await postGate.promise;
        persistedFields = { ...fields };
        return 'outbound-record-1';
      },
    );
    const { service, ledger } = createService(gateway, ledgerPath);

    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );

    expect(accepted).toMatchObject({
      accepted: true,
      status: 'pending',
      taskId: expect.any(String),
    });
    expect(gateway.createRecord).not.toHaveBeenCalled();

    await waitFor(() => gateway.createRecord.mock.calls.length === 1);
    expect((await ledger.findByTaskId(accepted.taskId))?.task.status).toBe(
      'running',
    );

    postGate.resolve();
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'completed',
    );
    expect(persistedFields).toEqual(
      expect.objectContaining({
        程序出库状态: '待审批',
        出库工作流状态: '待路由',
        程序出库申请数量: REQUEST.quantity,
      }),
    );
    expect(persistedFields).not.toHaveProperty('出库数量');
    expect(persistedFields).not.toHaveProperty('流程');
  });

  it.each([false, true])(
    'reconciles a registered request through the real approval ledger without rebuilding its snapshot (Base committed: %s)',
    async (baseCommitted) => {
      const fixture = createService(gateway, ledgerPath);
      const approvalStore = new InventoryOutboundApprovalStore(
        join(directory, 'approval.json'),
      );
      const approvalGateway = {
        writePendingApproval: jest
          .fn()
          .mockImplementationOnce(
            async (snapshot: InventoryOutboundApprovalSnapshot) => {
              if (baseCommitted)
                persistedFields = {
                  ...persistedFields,
                  出库工作流状态: '待审批',
                  出库当前审批人: snapshot.approvers.map(
                    ({ openId, name }) => ({ id: openId, name }),
                  ),
                  出库审批策略版本: snapshot.policyVersion,
                  出库审批快照: JSON.stringify({ schemaVersion: 2, snapshot }),
                  出库工作流错误: '同一出库记录和审批版本的审批快照冲突',
                };
              throw new Error('readback timed out');
            },
          )
          .mockResolvedValue(undefined),
        clearWorkflowError: jest.fn().mockResolvedValue(undefined),
        sendInteractiveCard: jest.fn().mockResolvedValue('om_test_approval'),
        writeApprovalCardDeliveryLedger: jest.fn().mockResolvedValue(undefined),
      };
      const approval = new InventoryOutboundApprovalService(
        approvalStore,
        approvalGateway as never,
      );
      Object.assign(fixture.approvalService, {
        registerPending: approval.registerPending.bind(approval),
        ensurePendingForRequest:
          approval.ensurePendingForRequest.bind(approval),
      });
      const accepted = await fixture.service.acceptPending(
        REQUEST,
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      );
      await waitFor(
        async () =>
          (await fixture.ledger.findByTaskId(accepted.taskId))?.task.status ===
          'uncertain',
      );
      const original = await approvalStore.find('outbound-record-1', 1);
      expect(original?.snapshot.availableStock).toBe(5);
      persistedFields = {
        ...persistedFields,
        名称: '测试滤芯',
        计数单位: '个',
        入库存放位置: 'A-1F-001',
      };
      gateway.listRecords.mockImplementation(
        async (options: { tableId: string }) =>
          options.tableId === 'tbl_outbound'
            ? [
                {
                  record_id: 'outbound-record-1',
                  fields: { ...persistedFields },
                },
              ]
            : options.tableId === 'tbl_catalog'
              ? [catalogRecord()]
              : [inventoryRecord()],
      );
      fixture.warehouseRoleDirectory.resolveApprovers.mockResolvedValue([
        { openId: 'ou_new_responsible', name: '新示例人员019' },
      ]);
      await expect(
        fixture.service.getTaskStatus(
          accepted.taskId,
          REQUEST.building,
          ADMIN,
          PRINCIPAL_FINGERPRINT,
        ),
      ).resolves.toMatchObject({
        task: {
          status: 'completed',
          result: {
            movement: { operator: 'A楼示例人员019', name: '测试滤芯', unit: '个' },
          },
        },
      });
      expect(
        (await approvalStore.find('outbound-record-1', 1))?.snapshot,
      ).toEqual(original?.snapshot);
      expect(approvalGateway.writePendingApproval).toHaveBeenLastCalledWith(
        original?.snapshot,
      );
      expect(gateway.createRecord).toHaveBeenCalledTimes(1);
      expect(approvalGateway.writePendingApproval).toHaveBeenCalledTimes(
        baseCommitted ? 1 : 2,
      );
      await approval.runPending();
      await approval.runPending();
      expect(approvalGateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
      if (baseCommitted)
        expect(approvalGateway.clearWorkflowError).toHaveBeenCalledTimes(1);
    },
  );

  it('completes approval registration when filtered legacy GET reads are unavailable', async () => {
    gateway.listRecords.mockImplementation(
      async (options: { tableId: string; searchFilter?: unknown }) => {
        if (!options.searchFilter) throw new Error('legacy GET unavailable');
        if (options.tableId === 'tbl_inventory') return [inventoryRecord()];
        if (options.tableId === 'tbl_catalog') return [catalogRecord()];
        return [];
      },
    );
    const { service, ledger, approvalService } = createService(
      gateway,
      ledgerPath,
    );

    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'completed',
    );

    const task = (await ledger.findByTaskId(accepted.taskId))?.task;
    expect(task?.result?.movement.operator).toBe('A楼示例人员019');
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(approvalService.registerPending).toHaveBeenCalledTimes(1);
  });

  it('does not mark a progressing readback uncertain after only ten seconds', async () => {
    const readbackGate = deferred<void>();
    gateway.getRecord.mockImplementation(
      async (_appToken: string, tableId: string) => {
        if (tableId === 'tbl_catalog') return catalogRecord();
        await readbackGate.promise;
        return { record_id: 'outbound-record-1', fields: persistedFields };
      },
    );
    const { service, ledger } = createService(gateway, ledgerPath);

    try {
      const accepted = await service.acceptPending(
        REQUEST,
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      );
      await waitFor(() =>
        gateway.getRecord.mock.calls.some(
          ([, tableId]: [string, string]) => tableId === 'tbl_outbound',
        ),
      );

      await sleep(10_250);
      expect((await ledger.findByTaskId(accepted.taskId))?.task.status).toBe(
        'running',
      );

      readbackGate.resolve();
      await waitFor(
        async () =>
          (await ledger.findByTaskId(accepted.taskId))?.task.status ===
          'completed',
      );
      expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    } finally {
      readbackGate.resolve();
      await service.onModuleDestroy?.();
    }
  }, 20_000);

  it('marks a Base write that never responds as uncertain instead of leaving the task running', async () => {
    gateway.createRecord.mockImplementation(
      () => new Promise<string>(() => undefined),
    );
    const { service, ledger } = createService(gateway, ledgerPath, {
      externalOperationTimeoutMs: 10,
      shutdownDrainTimeoutMs: 10,
    });

    try {
      const accepted = await service.acceptPending(
        REQUEST,
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      );

      await waitFor(
        async () =>
          (await ledger.findByTaskId(accepted.taskId))?.task.status ===
          'uncertain',
        1_000,
      );
      expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
        status: 'uncertain',
        definitelyNotWritten: false,
      });
    } finally {
      await service.onModuleDestroy?.();
    }
  });

  it('registers approval idempotently when an uncertain write is recovered by its original marker', async () => {
    gateway.createRecord.mockImplementationOnce(
      async (
        _appToken: string,
        _tableId: string,
        fields: Record<string, unknown>,
      ) => {
        persistedFields = { ...fields };
        throw new InventoryWorkflowRecordWriteUncertainError(
          '出库填写',
          Object.assign(new Error('socket timed out after commit'), {
            code: 'ETIMEDOUT',
          }),
        );
      },
    );
    const { service, ledger, approvalService, warehouseRoleDirectory } =
      createService(gateway, ledgerPath);
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'uncertain',
    );
    gateway.listRecords.mockImplementation((options: { tableId: string }) => {
      if (options.tableId === 'tbl_inventory') {
        return Promise.resolve([inventoryRecord()]);
      }
      if (options.tableId === 'tbl_catalog') {
        return Promise.resolve([catalogRecord()]);
      }
      return Promise.resolve([
        { record_id: 'outbound-record-1', fields: { ...persistedFields } },
      ]);
    });

    await expect(
      service.getTaskStatus(
        accepted.taskId,
        REQUEST.building,
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).resolves.toMatchObject({
      task: {
        status: 'completed',
        result: { movement: { status: '待审批' } },
      },
    });

    expect(warehouseRoleDirectory.resolveApprovers).toHaveBeenCalledWith(
      REQUEST.building,
    );
    expect(approvalService.registerPending).toHaveBeenCalledTimes(1);
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
  });

  it('rebuilds approval registration from a Base-only waiting-route record', async () => {
    const seeded = createService(gateway, ledgerPath);
    await seeded.service.createPending(REQUEST, ADMIN);
    expect(persistedFields).toEqual(
      expect.objectContaining({
        程序出库状态: '待审批',
        出库工作流状态: '待路由',
        出库创建标识: REQUEST.clientMutationId,
        出库请求指纹: requestFingerprint(REQUEST),
      }),
    );

    const restarted = createService(
      gateway,
      join(directory, 'empty-restarted-ledger.json'),
    );
    gateway.getRecord.mockClear();
    await restarted.service.recoverUnregisteredOutbound('outbound-record-1');

    expect(
      gateway.getRecord.mock.calls.filter(
        ([, tableId]: [string, string]) => tableId === 'tbl_catalog',
      ),
    ).toHaveLength(1);
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);

    expect(
      restarted.warehouseRoleDirectory.resolveApprovers,
    ).toHaveBeenCalledWith(REQUEST.building);
    expect(restarted.approvalService.registerPending).toHaveBeenCalledTimes(1);
    expect(restarted.approvalService.registerPending).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: 'outbound-record-1',
        outboundNumber: REQUEST.clientMutationId,
        building: REQUEST.building,
        applicantOpenId: REQUEST.applicantOpenId,
        quantity: REQUEST.quantity,
      }),
    );
  });

  it('discovers and repairs a Base-only waiting-route record during the background recovery scan', async () => {
    const seeded = createService(gateway, ledgerPath);
    await seeded.service.createPending(REQUEST, ADMIN);
    const baseOnlyRecord = {
      record_id: 'outbound-record-1',
      fields: { ...persistedFields },
    };
    gateway.listRecords.mockImplementation((options: { tableId: string }) => {
      if (options.tableId === 'tbl_inventory') {
        return Promise.resolve([inventoryRecord()]);
      }
      if (options.tableId === 'tbl_catalog') {
        return Promise.resolve([catalogRecord()]);
      }
      return Promise.resolve([]);
    });
    gateway.searchRecords.mockResolvedValue([baseOnlyRecord]);
    gateway.listRecords.mockClear();
    const restarted = createService(
      gateway,
      join(directory, 'auto-recovery-empty-ledger.json'),
      { initialScanDelayMs: 5, maximumScanDelayMs: 10 },
    );

    try {
      await restarted.service.onModuleInit();
      await waitForEventually(
        () => restarted.approvalService.registerPending.mock.calls.length === 1,
        1_000,
      );

      expect(gateway.createRecord).toHaveBeenCalledTimes(1);
      expect(gateway.searchRecords).toHaveBeenCalledWith({
        appToken: 'app-token',
        tableId: 'tbl_outbound',
        tableName: '出库填写',
        filter: {
          conjunction: 'and',
          conditions: [
            {
              field_name: '出库工作流状态',
              operator: 'is',
              value: ['待路由'],
            },
          ],
        },
      });
      expect(gateway.listRecords).not.toHaveBeenCalledWith(
        expect.objectContaining({ tableId: 'tbl_outbound' }),
      );
      expect(restarted.approvalService.registerPending).toHaveBeenCalledWith(
        expect.objectContaining({
          recordId: 'outbound-record-1',
          outboundNumber: REQUEST.clientMutationId,
        }),
      );
    } finally {
      await restarted.service.onModuleDestroy?.();
    }
  });

  it('does not recover a Base waiting-route record already tracked by the local ledger', async () => {
    const seeded = createService(gateway, ledgerPath);
    await seeded.ledger.reserve({
      building: REQUEST.building,
      principalFingerprint: PRINCIPAL_FINGERPRINT,
      clientMutationId: REQUEST.clientMutationId,
      requestFingerprint: requestFingerprint(REQUEST),
      request: REQUEST,
      task: {
        id: 'inventory-outbound-locally-pending',
        status: 'pending',
        message: '出库申请已受理',
        createdAt: new Date().toISOString(),
      },
    });
    expect(
      (await seeded.ledger.claimPending('inventory-outbound-locally-pending'))
        .claimed,
    ).toBe(true);
    const baseOnlyRecord = {
      record_id: 'outbound-record-1',
      fields: { ...persistedFields },
    };
    gateway.listRecords.mockImplementation((options: { tableId: string }) => {
      if (options.tableId === 'tbl_inventory') {
        return Promise.resolve([inventoryRecord()]);
      }
      if (options.tableId === 'tbl_catalog') {
        return Promise.resolve([catalogRecord()]);
      }
      return Promise.resolve([]);
    });
    gateway.searchRecords.mockResolvedValue([baseOnlyRecord]);
    const restarted = createService(gateway, ledgerPath, {
      initialScanDelayMs: 5,
      maximumScanDelayMs: 10,
    });
    const recoverSpy = jest.spyOn(
      restarted.service,
      'recoverUnregisteredOutbound',
    );

    try {
      await restarted.service.onModuleInit();
      await waitForEventually(
        () =>
          gateway.searchRecords.mock.calls.some(
            (call) =>
              call[0]?.filter?.conditions?.[0]?.field_name ===
                '出库工作流状态' &&
              call[0]?.filter?.conditions?.[0]?.value?.[0] === '待路由',
          ),
        1_000,
      );
      await flushImmediate();

      expect(gateway.searchRecords).toHaveBeenCalledWith({
        appToken: 'app-token',
        tableId: 'tbl_outbound',
        tableName: '出库填写',
        filter: {
          conjunction: 'and',
          conditions: [
            {
              field_name: '出库工作流状态',
              operator: 'is',
              value: ['待路由'],
            },
          ],
        },
      });
      expect(gateway.listRecords).not.toHaveBeenCalledWith(
        expect.objectContaining({ tableId: 'tbl_outbound' }),
      );
      expect(recoverSpy).not.toHaveBeenCalled();
      expect(restarted.approvalService.registerPending).not.toHaveBeenCalled();
    } finally {
      await restarted.service.onModuleDestroy?.();
    }
  });

  it('identifies a timed-out catalog read during waiting-route recovery without creating another record', async () => {
    const seeded = createService(gateway, ledgerPath);
    await seeded.service.createPending(REQUEST, ADMIN);
    gateway.getRecord.mockImplementation(
      async (_appToken: string, tableId: string) => {
        if (tableId === 'tbl_catalog') {
          throw Object.assign(new Error('timeout of 30000ms exceeded'), {
            code: 'ECONNABORTED',
          });
        }
        return { record_id: 'outbound-record-1', fields: persistedFields };
      },
    );

    const restarted = createService(
      gateway,
      join(directory, 'catalog-timeout-restarted-ledger.json'),
    );
    await expect(
      restarted.service.recoverUnregisteredOutbound('outbound-record-1'),
    ).rejects.toThrow(/读取关联物品类别.*timeout of 30000ms exceeded/u);
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(restarted.approvalService.registerPending).not.toHaveBeenCalled();
  });

  it('recovers the same waiting-route record after a transient catalog timeout', async () => {
    const seeded = createService(gateway, ledgerPath);
    await seeded.service.createPending(REQUEST, ADMIN);
    let catalogReads = 0;
    gateway.getRecord.mockImplementation(
      async (_appToken: string, tableId: string) => {
        if (tableId === 'tbl_catalog') {
          catalogReads += 1;
          if (catalogReads === 1) {
            throw Object.assign(new Error('timeout of 30000ms exceeded'), {
              code: 'ECONNABORTED',
            });
          }
          return catalogRecord();
        }
        return { record_id: 'outbound-record-1', fields: persistedFields };
      },
    );

    const restarted = createService(
      gateway,
      join(directory, 'retry-restarted-ledger.json'),
    );
    await expect(
      restarted.service.recoverUnregisteredOutbound('outbound-record-1'),
    ).rejects.toThrow(/读取关联物品类别/u);
    await restarted.service.recoverUnregisteredOutbound('outbound-record-1');

    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(catalogReads).toBe(2);
    expect(restarted.approvalService.registerPending).toHaveBeenCalledTimes(1);
  });

  it('treats a stale unregistered recovery request as complete after the record has already been routed', async () => {
    const seeded = createService(gateway, ledgerPath);
    await seeded.service.createPending(REQUEST, ADMIN);
    persistedFields = {
      ...persistedFields,
      出库工作流状态: '待审批',
      出库审批快照: '{"version":1}',
    };

    const restarted = createService(
      gateway,
      join(directory, 'already-routed-ledger.json'),
    );
    await restarted.service.recoverUnregisteredOutbound('outbound-record-1');

    expect(
      restarted.warehouseRoleDirectory.resolveApprovers,
    ).not.toHaveBeenCalled();
    expect(restarted.approvalService.registerPending).not.toHaveBeenCalled();
    expect(restarted.approvalGateway.writeWorkflowError).not.toHaveBeenCalled();
  });

  it('rejects a tampered Base-only waiting-route record before approval registration', async () => {
    const seeded = createService(gateway, ledgerPath);
    await seeded.service.createPending(REQUEST, ADMIN);
    persistedFields = {
      ...persistedFields,
      出库请求指纹: '0'.repeat(64),
    };

    const restarted = createService(
      gateway,
      join(directory, 'tampered-base-ledger.json'),
    );
    await expect(
      restarted.service.recoverUnregisteredOutbound('outbound-record-1'),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(
      restarted.warehouseRoleDirectory.resolveApprovers,
    ).not.toHaveBeenCalled();
    expect(restarted.approvalService.registerPending).not.toHaveBeenCalled();
  });

  it('allows a progressing cold-start preflight to outlive the write timeout', async () => {
    gateway.ensureTextField.mockImplementation(async () => {
      await sleep(15);
    });
    gateway.ensureNumberField.mockImplementation(async () => {
      await sleep(15);
    });
    gateway.listRecords.mockImplementation(
      async (options: { tableId: string }) => {
        await sleep(15);
        if (options.tableId === 'tbl_catalog') return [catalogRecord()];
        if (options.tableId === 'tbl_inventory') return [inventoryRecord()];
        return [];
      },
    );
    const { service, ledger } = createService(gateway, ledgerPath, {
      externalOperationTimeoutMs: 10,
      preflightOperationTimeoutMs: 100,
    });

    try {
      const accepted = await service.acceptPending(
        REQUEST,
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      );

      await waitFor(() => gateway.createRecord.mock.calls.length === 1);
      await waitFor(
        async () =>
          (await ledger.findByTaskId(accepted.taskId))?.task.status ===
          'completed',
      );
    } finally {
      await service.onModuleDestroy?.();
    }
  }, 20_000);

  it.each([
    ['link_record_ids', { link_record_ids: [REQUEST.catalogRecordId] }],
    ['record_ids', { record_ids: [REQUEST.catalogRecordId] }],
  ])(
    'completes the background task after a real Feishu link readback: %s',
    async (_label, linkValue) => {
      gateway.getRecord.mockImplementation(
        (_appToken: string, tableId: string) => {
          if (tableId === 'tbl_catalog') {
            return Promise.resolve(catalogRecord());
          }
          if (!persistedFields) throw new Error('record not persisted');
          return Promise.resolve({
            record_id: 'outbound-record-1',
            fields: {
              ...persistedFields,
              物品类别号: [linkValue],
            },
          });
        },
      );
      const { service, ledger } = createService(gateway, ledgerPath);

      const accepted = await service.acceptPending(
        REQUEST,
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      );

      await waitFor(
        async () =>
          (await ledger.findByTaskId(accepted.taskId))?.task.status ===
          'completed',
      );
      expect(gateway.createRecord).toHaveBeenCalledTimes(1);
      await expect(
        service.getTaskStatus(
          accepted.taskId,
          REQUEST.building,
          ADMIN,
          PRINCIPAL_FINGERPRINT,
        ),
      ).resolves.toMatchObject({
        task: {
          status: 'completed',
          result: { movement: { quantity: REQUEST.quantity } },
        },
      });
    },
  );

  it.each([
    ['short mutation id', { clientMutationId: 'short' }],
    ['long mutation id', { clientMutationId: 'm'.repeat(129) }],
    ['long catalog record id', { catalogRecordId: 'c'.repeat(257) }],
    ['long sku', { sku: 's'.repeat(257) }],
    ['long applicant id', { applicantOpenId: 'a'.repeat(257) }],
    ['long reason', { reason: '更'.repeat(2_001) }],
    ['unsafe reason control', { reason: '机房\u0007更换' }],
    ['leading vertical tab', { reason: '\u000b机房更换' }],
    ['trailing form feed', { reason: '机房更换\u000c' }],
  ])(
    'rejects %s before reserving a task or contacting Feishu',
    async (_label, override) => {
      const { service } = createService(gateway, ledgerPath);

      let rejection: unknown;
      try {
        await service.acceptPending(
          { ...REQUEST, ...override },
          ADMIN,
          PRINCIPAL_FINGERPRINT,
        );
      } catch (error) {
        rejection = error;
      }

      expect(rejection).toBeInstanceOf(BadRequestException);
      expect(
        isInventoryOutboundAcceptanceDefinitelyNotWrittenError(rejection),
      ).toBe(true);

      expect(existsSync(ledgerPath)).toBe(false);
      expect(gateway.listRecords).not.toHaveBeenCalled();
      expect(gateway.createRecord).not.toHaveBeenCalled();
    },
  );

  it('does not classify a task-ledger acceptance failure as definitely not written', async () => {
    const { service, ledger } = createService(gateway, ledgerPath);
    const failure = new ServiceUnavailableException('ledger response unknown');
    jest.spyOn(ledger, 'reserve').mockRejectedValueOnce(failure);

    await expect(
      service.acceptPending(REQUEST, ADMIN, PRINCIPAL_FINGERPRINT),
    ).rejects.toBe(failure);
    expect(
      isInventoryOutboundAcceptanceDefinitelyNotWrittenError(failure),
    ).toBe(false);
  });

  it('keeps the Feishu code and stage when a pre-write Base request returns 400', async () => {
    gateway.listRecords.mockRejectedValueOnce({
      response: {
        status: 400,
        data: { code: 1254015, msg: 'FieldValueTypeNotMatch' },
      },
    });
    const { service, ledger } = createService(gateway, ledgerPath);

    const accepted = await service.acceptPending(
      {
        ...REQUEST,
        building: 'H楼',
        clientMutationId: 'outbound-h-building-400',
      },
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status === 'failed',
    );

    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'failed',
      definitelyNotWritten: true,
      message: expect.stringContaining('写入前校验'),
    });
    expect(
      (await ledger.findByTaskId(accepted.taskId))?.task.message,
    ).toContain('1254015');
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('keeps a rate-limited preflight pending instead of failing the accepted task', async () => {
    gateway.listRecords.mockRejectedValueOnce({
      response: {
        status: 400,
        data: { code: 99991400, msg: 'request trigger frequency limit' },
      },
    });
    const { service, ledger } = createService(gateway, ledgerPath);
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );

    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task
          .preflightAttemptCount === 1,
    );
    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'pending',
      preflightAttemptCount: 1,
      message: expect.stringContaining('限流'),
    });
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('keeps a TooManyRequest preflight under its original pending task', async () => {
    gateway.listRecords.mockRejectedValueOnce(
      Object.assign(new Error('读取出库填写失败：TooManyRequest'), {
        feishuCode: 1254290,
      }),
    );
    const { service, ledger } = createService(gateway, ledgerPath);
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );

    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task
          .preflightAttemptCount === 1,
    );
    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      id: accepted.taskId,
      status: 'pending',
      preflightAttemptCount: 1,
      message: expect.stringContaining('限流'),
    });
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('does not bypass preflight backoff when a pending task is polled or replayed', async () => {
    gateway.listRecords.mockRejectedValue(
      Object.assign(new Error('读取出库填写失败：TooManyRequest'), {
        feishuCode: 1254290,
      }),
    );
    const { service, ledger } = createService(gateway, ledgerPath);
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task
          .preflightAttemptCount === 1,
    );

    await service.getTaskStatus(
      accepted.taskId,
      REQUEST.building,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await service.acceptPending(REQUEST, ADMIN, PRINCIPAL_FINGERPRINT);
    await flushImmediate();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(gateway.listRecords).toHaveBeenCalledTimes(1);
    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'pending',
      preflightAttemptCount: 1,
    });
  });

  it('completes a multiline reason and keeps it readable from a restarted ledger', async () => {
    const request: InventoryOutboundMovementCreateRequest = {
      ...REQUEST,
      clientMutationId: 'outbound-async-multiline',
      reason: '一层机房\r\n临时更换\t滤芯',
    };
    const { service, ledger } = createService(gateway, ledgerPath);

    const accepted = await service.acceptPending(
      request,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'completed',
    );

    expect(persistedFields?.['出库原因/出库后使用地点']).toBe(request.reason);
    const restarted = new InventoryOutboundTaskLedgerStore(ledgerPath);
    expect(
      (await restarted.findByTaskId(accepted.taskId))?.task.result?.movement
        .reason,
    ).toBe(request.reason);
  });

  it('cancels a queued pending-task immediate when the service is destroyed', async () => {
    const { service, ledger } = createService(gateway, ledgerPath);
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );

    await service.onModuleDestroy?.();
    await flushImmediate();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));

    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect((await ledger.findByTaskId(accepted.taskId))?.task.status).toBe(
      'pending',
    );
  });

  it('waits for an in-flight pending task to settle during service destruction', async () => {
    const postStarted = deferred<void>();
    const postGate = deferred<void>();
    gateway.createRecord.mockImplementationOnce(
      async (
        _appToken: string,
        _tableId: string,
        fields: Record<string, unknown>,
      ) => {
        postStarted.resolve();
        await postGate.promise;
        persistedFields = { ...fields };
        return 'outbound-record-1';
      },
    );
    const { service, ledger } = createService(gateway, ledgerPath);
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await withTimeout(postStarted.promise, 1_000);

    let destroySettled = false;
    const destroyPromise = Promise.resolve(service.onModuleDestroy?.()).then(
      () => {
        destroySettled = true;
      },
    );
    await Promise.resolve();

    try {
      expect(destroySettled).toBe(false);
    } finally {
      postGate.resolve();
      await withTimeout(destroyPromise, 1_000);
      await waitForEventually(
        async () =>
          (await ledger.findByTaskId(accepted.taskId))?.task.status ===
          'completed',
        1_000,
      );
    }

    expect(destroySettled).toBe(true);
  });

  it('bounds destruction while preserving an unconfirmed running write for lease recovery', async () => {
    const postStarted = deferred<void>();
    const postGate = deferred<void>();
    gateway.createRecord.mockImplementationOnce(async () => {
      postStarted.resolve();
      await postGate.promise;
      return 'outbound-record-1';
    });
    const { service, ledger } = createService(gateway, ledgerPath, {
      shutdownDrainTimeoutMs: 40,
    });
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await withTimeout(postStarted.promise, 1_000);
    await waitForEventually(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status === 'running',
      1_000,
    );
    const startedAt = Date.now();

    try {
      await expect(
        withTimeout(service.onModuleDestroy?.() || Promise.resolve(), 500),
      ).resolves.toBeUndefined();
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('drain'));
      expect((await ledger.findByTaskId(accepted.taskId))?.task.status).toBe(
        'running',
      );
      expect(readLedgerOwner(ledgerPath)).toBeDefined();

      expireLedgerTaskLease(ledgerPath);
      const restartedLedger = new InventoryOutboundTaskLedgerStore(ledgerPath);
      expect(
        (await restartedLedger.findByTaskId(accepted.taskId))?.task.status,
      ).toBe('uncertain');
    } finally {
      postGate.reject(new Error('shutdown test releases the pending POST'));
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  });

  it('abandons a claimed pending task on drain timeout and never writes after preparation resumes', async () => {
    const preparationStarted = deferred<void>();
    const preparationGate = deferred<void>();
    gateway.ensureTextField.mockImplementationOnce(async () => {
      preparationStarted.resolve();
      await preparationGate.promise;
    });
    const { service, ledger } = createService(gateway, ledgerPath, {
      shutdownDrainTimeoutMs: 40,
    });
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await withTimeout(preparationStarted.promise, 1_000);
    expect((await ledger.findByTaskId(accepted.taskId))?.task.status).toBe(
      'pending',
    );
    expect(readLedgerOwner(ledgerPath)).toBeDefined();

    try {
      await withTimeout(service.onModuleDestroy?.() || Promise.resolve(), 500);
      await waitForEventually(
        () => readLedgerOwner(ledgerPath) === undefined,
        500,
      );
    } finally {
      preparationGate.resolve();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }

    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect((await ledger.findByTaskId(accepted.taskId))?.task.status).toBe(
      'pending',
    );
  });

  it('ignores an existing-marker preparation result after drain timeout releases the pending owner', async () => {
    const seeded = createService(gateway, ledgerPath);
    await seeded.service.createPending(REQUEST, ADMIN);
    const markerFields = structuredClone(persistedFields);
    gateway.createRecord.mockClear();
    const preparationStarted = deferred<void>();
    const preparationGate = deferred<void>();
    gateway.listRecords.mockImplementation(async () => {
      preparationStarted.resolve();
      await preparationGate.promise;
      return [
        {
          record_id: 'outbound-record-1',
          fields: { ...markerFields },
        },
      ];
    });
    const { service, ledger } = createService(gateway, ledgerPath, {
      shutdownDrainTimeoutMs: 40,
    });
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await withTimeout(preparationStarted.promise, 1_000);

    await withTimeout(service.onModuleDestroy?.() || Promise.resolve(), 500);
    preparationGate.resolve();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));

    expect((await ledger.findByTaskId(accepted.taskId))?.task.status).toBe(
      'pending',
    );
    await expect(
      ledger.reserve({
        building: REQUEST.building,
        principalFingerprint: PRINCIPAL_FINGERPRINT,
        clientMutationId: REQUEST.clientMutationId,
        requestFingerprint: requestFingerprint(REQUEST),
        request: REQUEST,
        task: {
          id: 'inventory-outbound-owner-release-probe',
          status: 'pending',
          message: 'probe',
          createdAt: '2026-08-12T00:00:00.000Z',
        },
      }),
    ).resolves.toMatchObject({ created: false });
    expect(gateway.createRecord).not.toHaveBeenCalled();

    const restarted = createService(gateway, ledgerPath);
    await restarted.service.onModuleInit();
    try {
      await waitForEventually(
        async () =>
          (await restarted.ledger.findByTaskId(accepted.taskId))?.task
            .status === 'completed',
        1_000,
      );
      expect(gateway.createRecord).not.toHaveBeenCalled();
    } finally {
      await restarted.service.onModuleDestroy?.();
    }
  });

  it('ignores a preparation error after drain timeout releases the pending owner', async () => {
    const preparationStarted = deferred<void>();
    const preparationGate = deferred<void>();
    gateway.listRecords.mockImplementationOnce(async () => {
      preparationStarted.resolve();
      await preparationGate.promise;
      throw new Error('explicit pre-write validation failure');
    });
    const { service, ledger } = createService(gateway, ledgerPath, {
      shutdownDrainTimeoutMs: 40,
    });
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await withTimeout(preparationStarted.promise, 1_000);

    await withTimeout(service.onModuleDestroy?.() || Promise.resolve(), 500);
    preparationGate.resolve();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));

    expect((await ledger.findByTaskId(accepted.taskId))?.task.status).toBe(
      'pending',
    );
    await expect(
      ledger.reserve({
        building: REQUEST.building,
        principalFingerprint: PRINCIPAL_FINGERPRINT,
        clientMutationId: REQUEST.clientMutationId,
        requestFingerprint: requestFingerprint(REQUEST),
        request: REQUEST,
        task: {
          id: 'inventory-outbound-owner-release-error-probe',
          status: 'pending',
          message: 'probe',
          createdAt: '2026-08-12T00:00:00.000Z',
        },
      }),
    ).resolves.toMatchObject({ created: false });
    expect(gateway.createRecord).not.toHaveBeenCalled();

    const restarted = createService(gateway, ledgerPath);
    await restarted.service.onModuleInit();
    try {
      await waitForEventually(
        async () =>
          (await restarted.ledger.findByTaskId(accepted.taskId))?.task
            .status === 'completed',
        1_000,
      );
      expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    } finally {
      await restarted.service.onModuleDestroy?.();
    }
  });

  it('allows only one Base POST across two service instances for the same id', async () => {
    const postGate = deferred<void>();
    gateway.createRecord.mockImplementation(
      async (
        _appToken: string,
        _tableId: string,
        fields: Record<string, unknown>,
      ) => {
        await postGate.promise;
        persistedFields = { ...fields };
        return 'outbound-record-1';
      },
    );
    const first = createService(gateway, ledgerPath);
    const second = createService(gateway, ledgerPath);

    const [firstAccepted, duplicateAccepted] = await Promise.all([
      first.service.acceptPending(REQUEST, ADMIN, PRINCIPAL_FINGERPRINT),
      second.service.acceptPending(
        structuredClone(REQUEST),
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ]);

    expect(duplicateAccepted.taskId).toBe(firstAccepted.taskId);
    await waitFor(() => gateway.createRecord.mock.calls.length === 1);
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);

    postGate.resolve();
    await waitFor(
      async () =>
        (await first.ledger.findByTaskId(firstAccepted.taskId))?.task.status ===
        'completed',
    );
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
  });

  it('rejects a regenerated id for the same recently accepted outbound request', async () => {
    const { service, ledger } = createService(gateway, ledgerPath);
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );

    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'completed',
    );

    await expect(
      service.acceptPending(
        {
          ...REQUEST,
          clientMutationId: 'outbound-async-regenerated-id',
        },
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).rejects.toThrow(ConflictException);

    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
  });

  it('rejects the same global id when the canonical request fingerprint differs', async () => {
    const { service, ledger } = createService(gateway, ledgerPath);
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );

    await expect(
      service.acceptPending(
        { ...REQUEST, quantity: 3 },
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).rejects.toThrow(ConflictException);
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'completed',
    );
  });

  it('keeps an unacknowledged POST uncertain and never posts again for the same id', async () => {
    gateway.createRecord.mockRejectedValueOnce(
      new InventoryWorkflowRecordWriteUncertainError(
        '出库填写',
        Object.assign(new Error('socket timed out'), { code: 'ETIMEDOUT' }),
      ),
    );
    const { service, ledger } = createService(gateway, ledgerPath);
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'uncertain',
    );

    const retry = await service.acceptPending(
      structuredClone(REQUEST),
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );

    expect(retry).toMatchObject({
      taskId: accepted.taskId,
      status: 'uncertain',
      definitelyNotWritten: false,
    });
    await flushImmediate();
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
  });

  it('marks an explicit record POST rejection failed and definitely not written', async () => {
    gateway.createRecord.mockRejectedValueOnce(
      new InventoryWorkflowRecordDefinitelyNotWrittenError('出库填写', {
        response: {
          status: 400,
          data: { code: 1254015, msg: 'FieldValueTypeNotMatch' },
        },
      }),
    );
    const { service, ledger } = createService(gateway, ledgerPath);
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );

    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status === 'failed',
    );

    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'failed',
      definitelyNotWritten: true,
      message: expect.stringContaining('多维表写入失败：飞书错误码 1254015'),
    });
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
  });

  it.each([99991400, 1254290])(
    'requeues a definitely rejected rate-limited POST with code %s under its original task id',
    async (feishuCode) => {
      gateway.createRecord.mockRejectedValueOnce(
        new InventoryWorkflowRecordDefinitelyNotWrittenError('出库填写', {
          response: {
            status: 400,
            data: { code: feishuCode, msg: 'TooManyRequest' },
          },
        }),
      );
      const { service, ledger } = createService(gateway, ledgerPath, {
        initialScanDelayMs: 5,
        maximumScanDelayMs: 10,
      });
      try {
        await service.onModuleInit();
        const accepted = await service.acceptPending(
          REQUEST,
          ADMIN,
          PRINCIPAL_FINGERPRINT,
        );
        await waitForEventually(
          async () =>
            (await ledger.findByTaskId(accepted.taskId))?.task.status ===
            'completed',
          5_000,
        );
        const task = (await ledger.findByTaskId(accepted.taskId))?.task;
        expect(task).toMatchObject({
          status: 'completed',
          preflightAttemptCount: 2,
        });
        expect(gateway.createRecord).toHaveBeenCalledTimes(2);
      } finally {
        await service.onModuleDestroy?.();
      }
    },
    10_000,
  );

  it('keeps an existing marker uncertain when its record read fails and only reconciles read-only', async () => {
    const seeded = createService(gateway, ledgerPath);
    await seeded.service.createPending(REQUEST, ADMIN);
    const markerFields = structuredClone(persistedFields);
    gateway.createRecord.mockClear();
    gateway.getRecord.mockClear();
    gateway.listRecords.mockResolvedValue([
      { record_id: 'outbound-record-1', fields: { ...markerFields } },
    ]);
    gateway.getRecord.mockRejectedValueOnce(
      Object.assign(new Error('record read timed out'), { code: 'ETIMEDOUT' }),
    );
    const { service, ledger } = createService(gateway, ledgerPath);

    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'uncertain',
    );

    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'uncertain',
      definitelyNotWritten: false,
    });
    await expect(
      service.acceptPending(
        structuredClone(REQUEST),
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).resolves.toMatchObject({
      taskId: accepted.taskId,
      status: 'uncertain',
      definitelyNotWritten: false,
    });
    await expect(
      service.getTaskStatus(
        accepted.taskId,
        REQUEST.building,
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).resolves.toMatchObject({ task: { status: 'completed' } });
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('keeps an existing marker uncertain when its core snapshot read fails', async () => {
    const seeded = createService(gateway, ledgerPath);
    await seeded.service.createPending(REQUEST, ADMIN);
    const markerFields = structuredClone(persistedFields);
    gateway.createRecord.mockClear();
    let inventoryReadFailed = false;
    gateway.listRecords.mockImplementation((options: { tableId: string }) => {
      if (options.tableId === 'tbl_outbound') {
        return Promise.resolve([
          { record_id: 'outbound-record-1', fields: { ...markerFields } },
        ]);
      }
      if (options.tableId === 'tbl_inventory' && !inventoryReadFailed) {
        inventoryReadFailed = true;
        return Promise.reject(
          Object.assign(new Error('snapshot read timed out'), {
            code: 'ETIMEDOUT',
          }),
        );
      }
      if (options.tableId === 'tbl_inventory') {
        return Promise.resolve([inventoryRecord()]);
      }
      return Promise.resolve([catalogRecord()]);
    });
    const { service, ledger } = createService(gateway, ledgerPath);

    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'uncertain',
    );

    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'uncertain',
      definitelyNotWritten: false,
    });
    await expect(
      service.getTaskStatus(
        accepted.taskId,
        REQUEST.building,
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).resolves.toMatchObject({ task: { status: 'completed' } });
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('keeps an existing marker uncertain when its persisted fields cannot be verified', async () => {
    const seeded = createService(gateway, ledgerPath);
    await seeded.service.createPending(REQUEST, ADMIN);
    const markerFields = structuredClone(persistedFields);
    persistedFields = {
      ...markerFields,
      程序出库申请数量: REQUEST.quantity + 1,
    };
    gateway.createRecord.mockClear();
    gateway.listRecords.mockResolvedValue([
      { record_id: 'outbound-record-1', fields: { ...markerFields } },
    ]);
    const { service, ledger } = createService(gateway, ledgerPath);

    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'uncertain',
    );

    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'uncertain',
      definitelyNotWritten: false,
    });
    await expect(
      service.acceptPending(
        structuredClone(REQUEST),
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).resolves.toMatchObject({
      taskId: accepted.taskId,
      status: 'uncertain',
      definitelyNotWritten: false,
    });
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('keeps a 2xx response with a written record id uncertain and reconciles read-only on resubmission', async () => {
    let writtenFields: Record<string, unknown> | null = null;
    const recordPost = jest.fn(
      async (_url: string, body: { fields: Record<string, unknown> }) => {
        writtenFields = { ...body.fields };
        return {
          status: 200,
          data: { data: { record: { record_id: 'rec-written' } } },
        };
      },
    );
    const realGateway = new InventoryWorkflowGateway({
      axiosRef: { post: recordPost },
    } as never);
    const tokenProvider = realGateway as unknown as {
      getTenantAccessToken(): Promise<string>;
    };
    jest
      .spyOn(tokenProvider, 'getTenantAccessToken')
      .mockResolvedValue('tenant-token');
    gateway.createRecord.mockImplementation(
      realGateway.createRecord.bind(realGateway),
    );
    const { service, ledger } = createService(gateway, ledgerPath);

    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitForEventually(async () => {
      const status = (await ledger.findByTaskId(accepted.taskId))?.task.status;
      return status === 'uncertain' || status === 'failed';
    }, 1_000);

    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'uncertain',
      definitelyNotWritten: false,
    });
    expect(recordPost).toHaveBeenCalledTimes(1);

    const retry = await service.acceptPending(
      structuredClone(REQUEST),
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    expect(retry).toMatchObject({
      taskId: accepted.taskId,
      status: 'uncertain',
      definitelyNotWritten: false,
    });
    await flushImmediate();
    expect(recordPost).toHaveBeenCalledTimes(1);

    if (!writtenFields) throw new Error('expected the attempted record fields');
    persistedFields = writtenFields;
    gateway.listRecords.mockClear();
    gateway.getRecord.mockClear();
    gateway.listRecords.mockResolvedValueOnce([
      { record_id: 'rec-written', fields: { ...writtenFields } },
    ]);

    await expect(
      service.getTaskStatus(
        accepted.taskId,
        REQUEST.building,
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).resolves.toMatchObject({ task: { status: 'completed' } });
    expect(recordPost).toHaveBeenCalledTimes(1);
    expect(gateway.listRecords).toHaveBeenCalledTimes(2);
    expect(gateway.getRecord).toHaveBeenCalledTimes(2);
  });

  it('marks a post-zero-marker field preparation failure definitely not written', async () => {
    gateway.ensureTextField.mockImplementation(
      async (_appToken: string, _tableId: string, fieldName: string) => {
        if (fieldName === '程序出库状态') {
          throw new Error('field preparation failed');
        }
      },
    );
    const { service, ledger } = createService(gateway, ledgerPath);
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );

    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status === 'failed',
    );

    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'failed',
      definitelyNotWritten: true,
    });
    expect(gateway.listRecords).toHaveBeenCalledTimes(1);
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('keeps a pre-marker creation-field preparation failure pending and safely resumes the same task', async () => {
    let failMarkerPreparation = true;
    gateway.ensureTextField.mockImplementation(
      async (_appToken: string, _tableId: string, fieldName: string) => {
        if (fieldName === '出库创建标识' && failMarkerPreparation) {
          throw new Error('creation marker field unavailable');
        }
      },
    );
    const { service, ledger } = createService(gateway, ledgerPath);

    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(async () =>
      loggerError.mock.calls.some(([message]) =>
        String(message).includes('写入前查重暂不可用'),
      ),
    );

    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'pending',
    });
    expect(gateway.listRecords).not.toHaveBeenCalled();
    expect(gateway.createRecord).not.toHaveBeenCalled();
    failMarkerPreparation = false;

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await service.getTaskStatus(
      accepted.taskId,
      REQUEST.building,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'completed',
    );
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
  });

  it('fails a permanent pre-marker authorization error without retrying forever', async () => {
    gateway.ensureTextField.mockImplementation(
      async (_appToken: string, _tableId: string, fieldName: string) => {
        if (fieldName === '出库创建标识') {
          throw Object.assign(new Error('field access forbidden'), {
            response: { status: 403 },
          });
        }
      },
    );
    const { service, ledger } = createService(gateway, ledgerPath);

    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status === 'failed',
    );

    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'failed',
      definitelyNotWritten: true,
      preflightAttemptCount: 1,
    });
    expect(gateway.listRecords).not.toHaveBeenCalled();
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('keeps a timed-out preflight pending under its original id and resumes after recovery', async () => {
    let unavailable = true;
    gateway.ensureTextField.mockImplementation(
      async (_appToken: string, _tableId: string, fieldName: string) => {
        if (fieldName === '出库创建标识' && unavailable) {
          throw Object.assign(new Error('marker lookup timed out'), {
            code: 'ETIMEDOUT',
          });
        }
      },
    );
    const { service, ledger } = createService(gateway, ledgerPath, {
      initialScanDelayMs: 5,
      maximumScanDelayMs: 10,
      maximumPreflightAttempts: 2,
      maximumPreflightAgeMs: 60_000,
    });

    try {
      await service.onModuleInit();
      const accepted = await service.acceptPending(
        REQUEST,
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      );
      await waitForEventually(
        async () =>
          ((await ledger.findByTaskId(accepted.taskId))?.task
            .preflightAttemptCount || 0) >= 2,
        3_000,
      );
      expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
        status: 'pending',
        preflightAttemptCount: 2,
        lastPreflightAttemptAt: expect.any(String),
      });
      expect(gateway.createRecord).not.toHaveBeenCalled();
      unavailable = false;
      await waitForEventually(
        async () =>
          (await ledger.findByTaskId(accepted.taskId))?.task.status ===
          'completed',
        5_000,
      );
      expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    } finally {
      await service.onModuleDestroy?.();
    }
  });

  it('keeps an over-age preflight timeout pending without releasing a duplicate retry', async () => {
    gateway.ensureTextField.mockImplementation(
      async (_appToken: string, _tableId: string, fieldName: string) => {
        if (fieldName === '出库创建标识') {
          throw Object.assign(new Error('marker lookup timed out'), {
            code: 'ETIMEDOUT',
          });
        }
      },
    );
    const { service, ledger } = createService(gateway, ledgerPath, {
      initialScanDelayMs: 5,
      maximumScanDelayMs: 10,
      maximumPreflightAttempts: 10,
      maximumPreflightAgeMs: 1_000,
    });
    await ledger.reserve({
      building: REQUEST.building,
      principalFingerprint: PRINCIPAL_FINGERPRINT,
      clientMutationId: REQUEST.clientMutationId,
      requestFingerprint: requestFingerprint(REQUEST),
      request: REQUEST,
      task: {
        id: 'inventory-outbound-over-age',
        status: 'pending',
        message: '出库申请已受理',
        createdAt: new Date(Date.now() - 10_000).toISOString(),
      },
    });

    try {
      await service.onModuleInit();
      await waitForEventually(
        async () =>
          ((await ledger.findByTaskId('inventory-outbound-over-age'))?.task
            .preflightAttemptCount || 0) >= 1,
        1_000,
      );

      expect(
        (await ledger.findByTaskId('inventory-outbound-over-age'))?.task,
      ).toMatchObject({
        status: 'pending',
        preflightAttemptCount: 1,
        message:
          '出库申请外部查询持续超时，已保留原编号等待后台恢复；请勿重复提交',
      });
      expect(gateway.createRecord).not.toHaveBeenCalled();
    } finally {
      await service.onModuleDestroy?.();
    }
  });

  it('keeps a failed exact marker query pending and safely resumes the same task', async () => {
    gateway.listRecords.mockRejectedValueOnce(
      new Error('读取出库填写失败：响应结构无效'),
    );
    const { service, ledger } = createService(gateway, ledgerPath);
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );

    await waitFor(async () =>
      loggerError.mock.calls.some(([message]) =>
        String(message).includes('写入前查重暂不可用'),
      ),
    );

    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'pending',
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(
      service.acceptPending(
        structuredClone(REQUEST),
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).resolves.toMatchObject({
      taskId: accepted.taskId,
      status: 'pending',
    });
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'completed',
    );
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
  });

  it('never starts the record POST when persisting running state fails', async () => {
    const { service, ledger } = createService(gateway, ledgerPath);
    jest
      .spyOn(ledger, 'updateTask')
      .mockRejectedValueOnce(new Error('ledger persistence failed'));

    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );

    await waitFor(() =>
      loggerError.mock.calls.some(([message]) =>
        String(message).includes('已禁止外部写入'),
      ),
    );
    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect((await ledger.claimPending(accepted.taskId)).claimed).toBe(true);
  });

  it('clears a transient heartbeat error after the next renewal succeeds before writing', async () => {
    const preparationGate = deferred<void>();
    gateway.ensureTextField.mockImplementationOnce(async () => {
      await preparationGate.promise;
    });
    const { service, ledger } = createService(gateway, ledgerPath, undefined, {
      taskLeaseMs: 900,
    });
    const renewClaim = ledger.renewClaim.bind(ledger);
    const renewSpy = jest
      .spyOn(ledger, 'renewClaim')
      .mockRejectedValueOnce(new Error('transient lease write failure'))
      .mockImplementation(renewClaim);
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitForEventually(() => renewSpy.mock.calls.length >= 2, 2_000);

    preparationGate.resolve();

    await waitForEventually(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'completed',
      1_000,
    );
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
  });

  it('abandons a pending claim after a persistent heartbeat failure and lets the same instance rescan it', async () => {
    const preparationGate = deferred<void>();
    gateway.ensureTextField.mockImplementationOnce(async () => {
      await preparationGate.promise;
    });
    const { service, ledger } = createService(
      gateway,
      ledgerPath,
      { initialScanDelayMs: 10, maximumScanDelayMs: 20 },
      { taskLeaseMs: 900 },
    );
    const renewClaim = ledger.renewClaim.bind(ledger);
    let renewalMustFail = true;
    const renewSpy = jest
      .spyOn(ledger, 'renewClaim')
      .mockImplementation(async (taskId) => {
        if (renewalMustFail) throw new Error('persistent lease write failure');
        return renewClaim(taskId);
      });
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitForEventually(() => renewSpy.mock.calls.length >= 1, 1_000);
    preparationGate.resolve();
    await waitForEventually(
      () =>
        loggerError.mock.calls.some(([message]) =>
          String(message).includes('lease 续约失败'),
        ),
      1_000,
    );

    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(readLedgerOwner(ledgerPath)).toBeUndefined();

    renewalMustFail = false;
    await service.onModuleInit();
    try {
      await waitForEventually(
        async () =>
          (await ledger.findByTaskId(accepted.taskId))?.task.status ===
          'completed',
        1_000,
      );
      expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    } finally {
      service.onModuleDestroy?.();
    }
  });

  it('marks a confirmed POST uncertain when the directed readback fails', async () => {
    let outboundReadFailed = false;
    gateway.getRecord.mockImplementation(
      (_appToken: string, tableId: string) => {
        if (tableId === 'tbl_catalog') {
          return Promise.resolve(catalogRecord());
        }
        if (!outboundReadFailed) {
          outboundReadFailed = true;
          return Promise.reject(new Error('readback timed out'));
        }
        if (!persistedFields) throw new Error('record not persisted');
        return Promise.resolve({
          record_id: 'outbound-record-1',
          fields: persistedFields,
        });
      },
    );
    const { service, ledger } = createService(gateway, ledgerPath);
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );

    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'uncertain',
    );

    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect((await ledger.findByTaskId(accepted.taskId))?.task).toMatchObject({
      status: 'uncertain',
      definitelyNotWritten: false,
    });
  });

  it('registers approval without backfilling formal quantity during uncertain reconciliation', async () => {
    gateway.createRecord.mockImplementationOnce(
      async (
        _appToken: string,
        _tableId: string,
        fields: Record<string, unknown>,
      ) => {
        const { 出库数量: _droppedFormalQuantity, ...partiallyWritten } =
          fields;
        persistedFields = partiallyWritten;
        throw new InventoryWorkflowRecordWriteUncertainError(
          '出库填写',
          Object.assign(new Error('response timed out'), {
            code: 'ETIMEDOUT',
          }),
        );
      },
    );
    const { service, ledger, approvalService } = createService(
      gateway,
      ledgerPath,
    );
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'uncertain',
    );
    gateway.listRecords.mockResolvedValueOnce([
      { record_id: 'outbound-record-1', fields: { ...persistedFields } },
    ]);

    await expect(
      service.getTaskStatus(
        accepted.taskId,
        REQUEST.building,
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).resolves.toMatchObject({ task: { status: 'completed' } });

    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(approvalService.registerPending).toHaveBeenCalledTimes(1);
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(persistedFields).not.toHaveProperty('出库数量');
    expect(persistedFields).not.toHaveProperty('流程');
  });

  it('serializes concurrent reconciliation so approval is registered once', async () => {
    const registrationStarted = deferred<void>();
    const releaseRegistration = deferred<void>();
    gateway.createRecord.mockImplementationOnce(
      async (
        _appToken: string,
        _tableId: string,
        fields: Record<string, unknown>,
      ) => {
        const { 出库数量: _droppedFormalQuantity, ...partiallyWritten } =
          fields;
        persistedFields = partiallyWritten;
        throw new InventoryWorkflowRecordWriteUncertainError('出库填写');
      },
    );
    const { service, ledger, approvalService } = createService(
      gateway,
      ledgerPath,
    );
    approvalService.registerPending.mockImplementationOnce(async () => {
      registrationStarted.resolve();
      await releaseRegistration.promise;
    });
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'uncertain',
    );
    gateway.listRecords.mockResolvedValue([
      { record_id: 'outbound-record-1', fields: { ...persistedFields } },
    ]);

    const firstQuery = service.getTaskStatus(
      accepted.taskId,
      REQUEST.building,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await registrationStarted.promise;
    const secondQuery = service.getTaskStatus(
      accepted.taskId,
      REQUEST.building,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    releaseRegistration.resolve();

    const [firstResult, secondResult] = await Promise.all([
      firstQuery,
      secondQuery,
    ]);

    expect(firstResult.task.status).toBe('completed');
    expect(['uncertain', 'completed']).toContain(secondResult.task.status);
    await expect(
      service.getTaskStatus(
        accepted.taskId,
        REQUEST.building,
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).resolves.toMatchObject({ task: { status: 'completed' } });
    expect(approvalService.registerPending).toHaveBeenCalledTimes(1);
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(persistedFields).not.toHaveProperty('出库数量');
  });

  it('claims uncertain reconciliation across service instances before approval registration', async () => {
    const registrationStarted = deferred<void>();
    const releaseRegistration = deferred<void>();
    gateway.createRecord.mockImplementationOnce(
      async (
        _appToken: string,
        _tableId: string,
        fields: Record<string, unknown>,
      ) => {
        const { 出库数量: _droppedFormalQuantity, ...partiallyWritten } =
          fields;
        persistedFields = partiallyWritten;
        throw new InventoryWorkflowRecordWriteUncertainError('出库填写');
      },
    );
    const first = createService(gateway, ledgerPath);
    first.approvalService.registerPending.mockImplementationOnce(async () => {
      registrationStarted.resolve();
      await releaseRegistration.promise;
    });
    const accepted = await first.service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await first.ledger.findByTaskId(accepted.taskId))?.task.status ===
        'uncertain',
    );
    gateway.listRecords.mockResolvedValue([
      { record_id: 'outbound-record-1', fields: { ...persistedFields } },
    ]);
    const second = createService(gateway, ledgerPath);

    const firstQuery = first.service.getTaskStatus(
      accepted.taskId,
      REQUEST.building,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await registrationStarted.promise;
    const secondQuery = second.service.getTaskStatus(
      accepted.taskId,
      REQUEST.building,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    releaseRegistration.resolve();
    await expect(firstQuery).resolves.toMatchObject({
      task: { status: 'completed' },
    });
    await expect(secondQuery).resolves.toMatchObject({
      task: expect.any(Object),
    });
    await expect(
      second.service.getTaskStatus(
        accepted.taskId,
        REQUEST.building,
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).resolves.toMatchObject({ task: { status: 'completed' } });
    expect(first.approvalService.registerPending).toHaveBeenCalledTimes(1);
    expect(second.approvalService.registerPending).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it('revalidates the durable uncertain lease before backfilling after another instance takes over', async () => {
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    gateway.createRecord.mockImplementationOnce(
      async (
        _appToken: string,
        _tableId: string,
        fields: Record<string, unknown>,
      ) => {
        const { 出库数量: _droppedFormalQuantity, ...partiallyWritten } =
          fields;
        persistedFields = partiallyWritten;
        throw new InventoryWorkflowRecordWriteUncertainError('出库填写');
      },
    );
    const first = createService(gateway, ledgerPath);
    const accepted = await first.service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await first.ledger.findByTaskId(accepted.taskId))?.task.status ===
        'uncertain',
    );
    gateway.listRecords.mockResolvedValue([
      { record_id: 'outbound-record-1', fields: { ...persistedFields } },
    ]);
    gateway.getRecord.mockImplementation(
      async (_appToken: string, tableId: string) => {
        if (tableId === 'tbl_catalog') return catalogRecord();
        readStarted.resolve();
        await releaseRead.promise;
        return {
          record_id: 'outbound-record-1',
          fields: { ...persistedFields },
        };
      },
    );

    const staleQuery = first.service.getTaskStatus(
      accepted.taskId,
      REQUEST.building,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await readStarted.promise;
    expireLedgerTaskLease(ledgerPath);
    const second = createService(gateway, ledgerPath);
    expect((await second.ledger.claimUncertain(accepted.taskId)).claimed).toBe(
      true,
    );
    releaseRead.resolve();

    await expect(staleQuery).resolves.toMatchObject({
      task: { status: 'uncertain' },
    });
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    await expect(
      second.ledger.abandonUncertainClaim(accepted.taskId),
    ).resolves.toBe(true);
  });

  it('completes uncertain reconciliation without a formal-quantity backfill', async () => {
    gateway.createRecord.mockImplementationOnce(
      async (
        _appToken: string,
        _tableId: string,
        fields: Record<string, unknown>,
      ) => {
        const { 出库数量: _droppedFormalQuantity, ...partiallyWritten } =
          fields;
        persistedFields = partiallyWritten;
        throw new InventoryWorkflowRecordWriteUncertainError('出库填写');
      },
    );
    gateway.updateRecord.mockImplementationOnce(
      async (
        _appToken: string,
        _tableId: string,
        _recordId: string,
        fields: Record<string, unknown>,
      ) => {
        persistedFields = { ...persistedFields, ...fields };
      },
    );
    const { service, ledger, managementService } = createService(
      gateway,
      ledgerPath,
    );
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'uncertain',
    );
    gateway.listRecords.mockResolvedValue([
      { record_id: 'outbound-record-1', fields: { ...persistedFields } },
    ]);
    gateway.getRecord.mockResolvedValueOnce({
      record_id: 'outbound-record-1',
      fields: { ...persistedFields },
    });

    await expect(
      service.getTaskStatus(
        accepted.taskId,
        REQUEST.building,
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).resolves.toMatchObject({ task: { status: 'completed' } });
    expect(persistedFields).not.toHaveProperty('出库数量');
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(managementService.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it('does not invoke the obsolete formal-quantity backfill during reconciliation', async () => {
    gateway.createRecord.mockImplementationOnce(
      async (
        _appToken: string,
        _tableId: string,
        fields: Record<string, unknown>,
      ) => {
        const { 出库数量: _droppedFormalQuantity, ...partiallyWritten } =
          fields;
        persistedFields = partiallyWritten;
        throw new InventoryWorkflowRecordWriteUncertainError('出库填写');
      },
    );
    gateway.updateRecord.mockImplementationOnce(
      async (
        _appToken: string,
        _tableId: string,
        _recordId: string,
        fields: Record<string, unknown>,
      ) => {
        persistedFields = { ...persistedFields, ...fields };
        throw Object.assign(new Error('backfill response timed out'), {
          code: 'ETIMEDOUT',
        });
      },
    );
    const { service, ledger, managementService } = createService(
      gateway,
      ledgerPath,
    );
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'uncertain',
    );
    gateway.listRecords.mockResolvedValue([
      { record_id: 'outbound-record-1', fields: { ...persistedFields } },
    ]);

    await expect(
      service.getTaskStatus(
        accepted.taskId,
        REQUEST.building,
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).resolves.toMatchObject({ task: { status: 'completed' } });
    expect(persistedFields).not.toHaveProperty('出库数量');
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(managementService.invalidateCache).toHaveBeenCalledTimes(1);

    await expect(
      service.getTaskStatus(
        accepted.taskId,
        REQUEST.building,
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).resolves.toMatchObject({ task: { status: 'completed' } });
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(managementService.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it('reconciles an uncertain task read-only and preserves the authoritative completed status', async () => {
    gateway.createRecord.mockImplementationOnce(
      async (
        _appToken: string,
        _tableId: string,
        fields: Record<string, unknown>,
      ) => {
        persistedFields = { ...fields };
        throw new InventoryWorkflowRecordWriteUncertainError(
          '出库填写',
          Object.assign(new Error('response timed out'), {
            code: 'ETIMEDOUT',
          }),
        );
      },
    );
    const { service, ledger } = createService(gateway, ledgerPath);
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'uncertain',
    );
    gateway.listRecords.mockClear();
    gateway.createRecord.mockClear();
    gateway.updateRecord.mockClear();
    gateway.ensureTextField.mockClear();
    gateway.ensureNumberField.mockClear();
    (fetchBitableRecords as jest.Mock).mockClear();
    (fetchBitableRecords as jest.Mock).mockRejectedValue(
      new Error('full-table reads are unavailable'),
    );
    gateway.listRecords.mockResolvedValueOnce([]);

    const stillUncertain = await service.getTaskStatus(
      accepted.taskId,
      'A楼',
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );

    expect(stillUncertain.task.status).toBe('uncertain');
    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(gateway.ensureTextField).not.toHaveBeenCalled();
    expect(gateway.ensureNumberField).not.toHaveBeenCalled();
    expect(fetchBitableRecords).not.toHaveBeenCalled();

    persistedFields = {
      ...persistedFields,
      程序出库状态: '已出库',
      出库工作流状态: '已通过',
      出库数量: REQUEST.quantity,
      出库时间: Date.parse(REQUEST.occurredAt),
      出库确认标识: 'outbound-confirm-reconciled',
    };
    gateway.listRecords.mockResolvedValueOnce([
      { record_id: 'outbound-record-1', fields: { ...persistedFields } },
    ]);

    const completed = await service.getTaskStatus(
      accepted.taskId,
      'A楼',
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );

    expect(completed.task).toMatchObject({
      status: 'completed',
      result: { movement: { status: '已出库' } },
    });
    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(gateway.ensureTextField).not.toHaveBeenCalled();
    expect(gateway.ensureNumberField).not.toHaveBeenCalled();
    expect(fetchBitableRecords).not.toHaveBeenCalled();
  });

  it('returns a conflict instead of swallowing duplicate reconciliation markers', async () => {
    gateway.createRecord.mockImplementationOnce(
      async (
        _appToken: string,
        _tableId: string,
        fields: Record<string, unknown>,
      ) => {
        persistedFields = { ...fields };
        throw new InventoryWorkflowRecordWriteUncertainError('出库填写');
      },
    );
    const { service, ledger } = createService(gateway, ledgerPath);
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'uncertain',
    );
    gateway.createRecord.mockClear();
    gateway.updateRecord.mockClear();
    gateway.ensureTextField.mockClear();
    gateway.ensureNumberField.mockClear();
    gateway.listRecords.mockResolvedValueOnce([
      { record_id: 'outbound-record-1', fields: { ...persistedFields } },
      { record_id: 'outbound-record-2', fields: { ...persistedFields } },
    ]);

    await expect(
      service.getTaskStatus(
        accepted.taskId,
        'A楼',
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(gateway.ensureTextField).not.toHaveBeenCalled();
    expect(gateway.ensureNumberField).not.toHaveBeenCalled();
  });

  it('returns a conflict instead of swallowing a mismatched reconciliation fingerprint', async () => {
    gateway.createRecord.mockImplementationOnce(
      async (
        _appToken: string,
        _tableId: string,
        fields: Record<string, unknown>,
      ) => {
        persistedFields = { ...fields };
        throw new InventoryWorkflowRecordWriteUncertainError('出库填写');
      },
    );
    const { service, ledger } = createService(gateway, ledgerPath);
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'uncertain',
    );
    gateway.createRecord.mockClear();
    gateway.updateRecord.mockClear();
    gateway.ensureTextField.mockClear();
    gateway.ensureNumberField.mockClear();
    gateway.listRecords.mockResolvedValueOnce([
      {
        record_id: 'outbound-record-1',
        fields: {
          ...persistedFields,
          出库请求指纹: '0'.repeat(64),
        },
      },
    ]);

    await expect(
      service.getTaskStatus(
        accepted.taskId,
        'A楼',
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(gateway.ensureTextField).not.toHaveBeenCalled();
    expect(gateway.ensureNumberField).not.toHaveBeenCalled();
  });

  it('keeps an uncertain task retryable when the exact marker read times out', async () => {
    gateway.createRecord.mockRejectedValueOnce(
      new InventoryWorkflowRecordWriteUncertainError('出库填写'),
    );
    const { service, ledger } = createService(gateway, ledgerPath);
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'uncertain',
    );
    gateway.listRecords.mockRejectedValueOnce(
      Object.assign(new Error('marker read timed out'), { code: 'ETIMEDOUT' }),
    );

    await expect(
      service.getTaskStatus(
        accepted.taskId,
        'A楼',
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).resolves.toMatchObject({ task: { status: 'uncertain' } });
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it('rejects task status reads from another building or principal fingerprint', async () => {
    const { service, ledger } = createService(gateway, ledgerPath);
    const accepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await ledger.findByTaskId(accepted.taskId))?.task.status ===
        'completed',
    );

    await expect(
      service.getTaskStatus(
        accepted.taskId,
        'B楼',
        ADMIN,
        PRINCIPAL_FINGERPRINT,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.getTaskStatus(
        accepted.taskId,
        'A楼',
        ADMIN,
        'different-principal-fingerprint',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('replays a completed canonical result from a restarted service without external reads or writes', async () => {
    const first = createService(gateway, ledgerPath);
    const accepted = await first.service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await first.ledger.findByTaskId(accepted.taskId))?.task.status ===
        'completed',
    );
    gateway.createRecord.mockClear();
    gateway.listRecords.mockClear();
    gateway.getRecord.mockClear();

    const restarted = createService(gateway, ledgerPath);
    const replay = await restarted.service.acceptPending(
      structuredClone(REQUEST),
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );

    expect(replay).toMatchObject({
      taskId: accepted.taskId,
      status: 'completed',
      result: {
        success: true,
        recordId: 'outbound-record-1',
        movement: { status: '待审批' },
      },
    });
    await flushImmediate();
    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(gateway.listRecords).not.toHaveBeenCalled();
    expect(gateway.getRecord).not.toHaveBeenCalled();
  });

  it('recovers an evicted old completed task from its exact marker without another record POST', async () => {
    const { service, ledger } = createService(gateway, ledgerPath, undefined, {
      maxEntries: 1,
    });
    const firstAccepted = await service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitForEventually(
      async () =>
        (await ledger.findByTaskId(firstAccepted.taskId))?.task.status ===
        'completed',
      5_000,
    );
    const firstFields = structuredClone(persistedFields);
    const secondRequest: InventoryOutboundMovementCreateRequest = {
      ...REQUEST,
      clientMutationId: 'outbound-async-2',
      reason: '第二次现场更换',
    };
    const secondAccepted = await service.acceptPending(
      secondRequest,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitForEventually(
      async () =>
        (await ledger.findByTaskId(secondAccepted.taskId))?.task.status ===
        'completed',
      5_000,
    );
    expect(await ledger.findByTaskId(firstAccepted.taskId)).toBeUndefined();
    gateway.createRecord.mockClear();
    persistedFields = firstFields;
    gateway.listRecords.mockResolvedValueOnce([
      { record_id: 'outbound-record-1', fields: { ...firstFields } },
    ]);

    const recovered = await service.acceptPending(
      structuredClone(REQUEST),
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitForEventually(
      async () =>
        (await ledger.findByTaskId(recovered.taskId))?.task.status ===
        'completed',
      5_000,
    );

    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(
      (await ledger.findByTaskId(recovered.taskId))?.task.result,
    ).toMatchObject({
      alreadyProcessed: true,
      movement: { clientMutationId: REQUEST.clientMutationId },
    });
  });

  it('safely resumes a durable pending task when a new service instance starts', async () => {
    const seededLedger = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await seededLedger.reserve({
      building: REQUEST.building,
      principalFingerprint: PRINCIPAL_FINGERPRINT,
      clientMutationId: REQUEST.clientMutationId,
      requestFingerprint: requestFingerprint(REQUEST),
      request: REQUEST,
      task: {
        id: 'inventory-outbound-restart-pending',
        status: 'pending',
        message: '出库申请已受理',
        createdAt: '2026-08-11T00:00:00.000Z',
      },
    });
    const restarted = createService(gateway, ledgerPath);

    await restarted.service.onModuleInit();

    await waitFor(
      async () =>
        (
          await restarted.ledger.findByTaskId(
            'inventory-outbound-restart-pending',
          )
        )?.task.status === 'completed',
    );
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    restarted.service.onModuleDestroy?.();
  });

  it('reconciles a durable uncertain task in the background after restart without a status query', async () => {
    gateway.createRecord.mockImplementationOnce(
      async (
        _appToken: string,
        _tableId: string,
        fields: Record<string, unknown>,
      ) => {
        const { 出库数量: _droppedFormalQuantity, ...partiallyWritten } =
          fields;
        persistedFields = partiallyWritten;
        throw new InventoryWorkflowRecordWriteUncertainError('出库填写');
      },
    );
    gateway.updateRecord.mockImplementation(
      async (
        _appToken: string,
        _tableId: string,
        _recordId: string,
        fields: Record<string, unknown>,
      ) => {
        persistedFields = { ...persistedFields, ...fields };
      },
    );
    const first = createService(gateway, ledgerPath);
    const accepted = await first.service.acceptPending(
      REQUEST,
      ADMIN,
      PRINCIPAL_FINGERPRINT,
    );
    await waitFor(
      async () =>
        (await first.ledger.findByTaskId(accepted.taskId))?.task.status ===
        'uncertain',
    );
    gateway.createRecord.mockClear();
    gateway.listRecords.mockResolvedValue([
      { record_id: 'outbound-record-1', fields: { ...persistedFields } },
    ]);
    const restarted = createService(gateway, ledgerPath, {
      initialScanDelayMs: 1_000,
      maximumScanDelayMs: 1_000,
    });

    try {
      await restarted.service.onModuleInit();
      await waitForEventually(
        async () =>
          (await restarted.ledger.findByTaskId(accepted.taskId))?.task
            .status === 'completed',
        1_000,
      );
      expect(gateway.createRecord).not.toHaveBeenCalled();
      expect(gateway.updateRecord).not.toHaveBeenCalled();
    } finally {
      await restarted.service.onModuleDestroy?.();
    }
  });

  it('retries the startup pending scan after a transient list failure', async () => {
    const restarted = createService(gateway, ledgerPath, {
      initialScanDelayMs: 5,
      maximumScanDelayMs: 10,
    });
    await restarted.ledger.reserve({
      building: REQUEST.building,
      principalFingerprint: PRINCIPAL_FINGERPRINT,
      clientMutationId: REQUEST.clientMutationId,
      requestFingerprint: requestFingerprint(REQUEST),
      request: REQUEST,
      task: {
        id: 'inventory-outbound-startup-scan-retry',
        status: 'pending',
        message: '出库申请已受理',
        createdAt: new Date().toISOString(),
      },
    });
    jest
      .spyOn(restarted.ledger, 'listPending')
      .mockRejectedValueOnce(new ServiceUnavailableException('ledger busy'));

    try {
      await restarted.service.onModuleInit();
      await waitForEventually(
        async () =>
          (
            await restarted.ledger.findByTaskId(
              'inventory-outbound-startup-scan-retry',
            )
          )?.task.status === 'completed',
        1_000,
      );

      expect(
        restarted.ledger.listPending.mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
      expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    } finally {
      await restarted.service.onModuleDestroy?.();
    }
  });

  it('fails closed with zero external writes when startup sees a semantically tampered ledger', async () => {
    const seededLedger = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await seededLedger.reserve({
      building: REQUEST.building,
      principalFingerprint: PRINCIPAL_FINGERPRINT,
      clientMutationId: REQUEST.clientMutationId,
      requestFingerprint: requestFingerprint(REQUEST),
      request: REQUEST,
      task: {
        id: 'inventory-outbound-tampered-pending',
        status: 'pending',
        message: '出库申请已受理',
        createdAt: '2026-08-11T00:00:00.000Z',
      },
    });
    tamperLedgerRequestQuantity(ledgerPath);
    const restarted = createService(gateway, ledgerPath);

    await restarted.service.onModuleInit();
    await flushImmediate();

    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('恢复扫描失败'),
    );
    restarted.service.onModuleDestroy?.();
  });

  it('rescans until a rolling-restart pending owner lease expires and then resumes it', async () => {
    const firstStore = new InventoryOutboundTaskLedgerStore(ledgerPath);
    await firstStore.reserve({
      building: REQUEST.building,
      principalFingerprint: PRINCIPAL_FINGERPRINT,
      clientMutationId: REQUEST.clientMutationId,
      requestFingerprint: requestFingerprint(REQUEST),
      request: REQUEST,
      task: {
        id: 'inventory-outbound-rolling-pending',
        status: 'pending',
        message: '出库申请已受理',
        createdAt: '2026-08-11T00:00:00.000Z',
      },
    });
    expect(
      (await firstStore.claimPending('inventory-outbound-rolling-pending'))
        .claimed,
    ).toBe(true);
    const restarted = createService(gateway, ledgerPath, {
      initialScanDelayMs: 10,
      maximumScanDelayMs: 20,
    });
    const firstClaimAttempt = deferred<boolean>();
    const claimPending = restarted.ledger.claimPending.bind(restarted.ledger);
    jest
      .spyOn(restarted.ledger, 'claimPending')
      .mockImplementation(async (taskId) => {
        const result = await claimPending(taskId);
        firstClaimAttempt.resolve(result.claimed);
        return result;
      });

    try {
      await restarted.service.onModuleInit();
      await expect(withTimeout(firstClaimAttempt.promise, 1_000)).resolves.toBe(
        false,
      );
      expireLedgerTaskLease(ledgerPath);

      await waitForEventually(
        async () =>
          (
            await restarted.ledger.findByTaskId(
              'inventory-outbound-rolling-pending',
            )
          )?.task.status === 'completed',
        1_000,
      );
      expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    } finally {
      restarted.service.onModuleDestroy?.();
    }
  });
});

function createService(
  gateway: ReturnType<typeof createGateway>,
  ledgerPath: string,
  recoveryOptions?: {
    initialScanDelayMs?: number;
    maximumScanDelayMs?: number;
    shutdownDrainTimeoutMs?: number;
    maximumPreflightAttempts?: number;
    maximumPreflightAgeMs?: number;
    externalOperationTimeoutMs?: number;
    preflightOperationTimeoutMs?: number;
    writeOperationTimeoutMs?: number;
  },
  ledgerOptions?: InventoryOutboundTaskLedgerStoreOptions,
): {
  service: AsyncOutboundService;
  ledger: InventoryOutboundTaskLedgerStore;
  managementService: { invalidateCache: jest.Mock };
  approvalService: {
    registerPending: jest.Mock;
    ensurePendingForRequest: jest.Mock;
  };
  warehouseRoleDirectory: {
    resolveApprovers: jest.Mock;
    resolveNotificationRecipients: jest.Mock;
  };
  approvalGateway: { writeWorkflowError: jest.Mock };
} {
  const ledger = new InventoryOutboundTaskLedgerStore(
    ledgerPath,
    ledgerOptions,
  );
  const managementService = { invalidateCache: jest.fn() };
  const approvalService = {
    registerPending: jest.fn().mockResolvedValue(undefined),
    ensurePendingForRequest: jest
      .fn()
      .mockImplementation(async (_record, _request, createSnapshot) => {
        const snapshot = await createSnapshot();
        const result = await approvalService.registerPending(snapshot);
        return result?.entry || { snapshot };
      }),
  };
  const warehouseRoleDirectory = {
    resolveApprovers: jest
      .fn()
      .mockResolvedValue([
        { openId: 'ou_warehouse_responsible', name: 'A楼示例人员019' },
      ]),
    resolveNotificationRecipients: jest
      .fn()
      .mockResolvedValue([
        { openId: 'ou_warehouse_manager', name: 'A楼管理人' },
      ]),
  };
  const approvalGateway = {
    writeWorkflowError: jest.fn().mockResolvedValue(undefined),
  };
  const Service = InventoryOutboundWorkflowService as unknown as new (
    httpService: unknown,
    gateway: unknown,
    approvalService: unknown,
    warehouseRoleDirectory: unknown,
    approvalGateway: unknown,
    managementService: unknown,
    ledger: InventoryOutboundTaskLedgerStore,
    recoveryOptions?: unknown,
  ) => AsyncOutboundService;
  const service = new Service(
    { axiosRef: {} },
    gateway,
    approvalService,
    warehouseRoleDirectory,
    approvalGateway,
    managementService,
    ledger,
    recoveryOptions,
  );
  return {
    ledger,
    managementService,
    service,
    approvalService,
    warehouseRoleDirectory,
    approvalGateway,
  };
}

function createGateway(readFields: () => Record<string, unknown> | null) {
  return {
    createRecord: jest.fn(),
    ensureNumberField: jest.fn().mockResolvedValue(undefined),
    ensureTextField: jest.fn().mockResolvedValue(undefined),
    listRecords: jest
      .fn()
      .mockImplementation((options: { tableId: string }) => {
        if (options.tableId === 'tbl_inventory') {
          return Promise.resolve([inventoryRecord()]);
        }
        if (options.tableId === 'tbl_catalog') {
          return Promise.resolve([catalogRecord()]);
        }
        return Promise.resolve([]);
      }),
    searchRecords: jest.fn().mockResolvedValue([]),
    updateRecord: jest.fn(),
    getRecord: jest
      .fn()
      .mockImplementation((_appToken: string, tableId: string) => {
        if (tableId === 'tbl_catalog') {
          return Promise.resolve(catalogRecord());
        }
        const fields = readFields();
        if (!fields) throw new Error('record not persisted');
        return Promise.resolve({ record_id: 'outbound-record-1', fields });
      }),
  };
}

function catalogRecord() {
  return {
    record_id: 'catalog-a101',
    fields: {
      物品类别号: 'A101',
      名称: '测试滤芯',
      '规格型号、设备序列号': 'MERV 8',
      品牌: '测试品牌',
      一级分类: '耗材',
      二级分类: '过滤器',
      楼栋: 'A楼',
      计数单位: '个',
    },
  };
}

function inventoryRecord() {
  return {
    record_id: 'inventory-a101',
    fields: {
      物品类别号: 'A101',
      楼栋: 'A楼',
      入库存放位置: 'A-1F-001',
      剩余库存: 5,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestFingerprint(
  request: InventoryOutboundMovementCreateRequest,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        type: request.type,
        catalogRecordId: request.catalogRecordId,
        sku: request.sku.toUpperCase(),
        building: request.building,
        quantity: request.quantity,
        occurredAt: new Date(request.occurredAt).toISOString(),
        applicantOpenId: request.applicantOpenId,
        reason: request.reason,
      }),
    )
    .digest('hex');
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  throw new Error('condition was not met');
}

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForEventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not met before timeout');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('promise timed out')),
        timeoutMs,
      );
      timer.unref?.();
    }),
  ]);
}

function expireLedgerTaskLease(path: string): void {
  const state = JSON.parse(readFileSync(path, 'utf8')) as {
    entries: Array<{ owner?: { leaseExpiresAt?: string } }>;
  };
  if (!state.entries[0].owner) throw new Error('expected a task owner');
  state.entries[0].owner.leaseExpiresAt = '2000-01-01T00:00:00.000Z';
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function tamperLedgerRequestQuantity(path: string): void {
  const state = JSON.parse(readFileSync(path, 'utf8')) as {
    entries: Array<{ request: { quantity: number } }>;
  };
  state.entries[0].request.quantity += 1;
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function readLedgerOwner(path: string): unknown {
  const state = JSON.parse(readFileSync(path, 'utf8')) as {
    entries: Array<{ owner?: unknown }>;
  };
  return state.entries[0].owner;
}
