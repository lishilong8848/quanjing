jest.mock(
  '@server/common/config/external-services.config',
  () => ({
    assertBitableTableConfig: jest.fn(),
    getFeishuAuthPayload: jest.fn(() => ({
      app_id: 'app',
      app_secret: 'secret',
    })),
    readEnv: jest.fn((name: string) => process.env[name] || ''),
    parseFeishuBitableLink: jest.fn((url: string) => ({
      appToken: new URL(url).pathname.split('/').filter(Boolean).at(-1) || '',
      wikiToken: '',
      tableId: '',
      viewId: '',
    })),
  }),
  { virtual: true },
);

jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
  resolveBitableAppToken: jest.fn(),
}));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type {
  PurchaseInboundConfirmRequest,
  PurchaseInboundConfirmResponse,
} from '../../shared/inventory-management.interface';
import {
  fetchBitableRecords,
  resolveBitableAppToken,
} from '../../server/common/feishu/bitable-direct-read';
import type {
  TrustedInventoryInboundRequest,
  TrustedInventoryInboundResult,
} from '../../server/modules/inventory-management/inventory-movement-command.service';
import { InventoryWorkflowRecordNotFoundError } from '../../server/modules/inventory-management/inventory-workflow.gateway';
import { PurchaseInboundConfirmationService } from '../../server/modules/inventory-management/purchase-inbound-confirmation.service';

const TABLES = {
  submission: 'tbl-submission',
  execution: 'tbl-execution',
  catalog: 'tbl-catalog',
  inbound: 'tbl-inbound',
};

const ADMIN: AccessPrincipal = { role: 'admin', purchaseBuilding: null };
const A_BUILDING_ADMIN: AccessPrincipal = {
  role: 'inventory_admin',
  purchaseBuilding: 'A楼',
};
const B_BUILDING_ADMIN: AccessPrincipal = {
  role: 'inventory_admin',
  purchaseBuilding: 'B楼',
};
const COMPLETE_EXECUTION_FIELD_SCHEMAS = [
  { fieldName: '物品类别码', type: 1, uiType: 'Text', writable: true },
  { fieldName: '实际采购数量', type: 2, uiType: 'Number', writable: true },
  { fieldName: '是否已入库', type: 7, uiType: 'Checkbox', writable: true },
  { fieldName: '采购流程', type: 3, uiType: 'SingleSelect', writable: true },
  { fieldName: '程序采购状态', type: 1, uiType: 'Text', writable: true },
];

describe('PurchaseInboundConfirmationService', () => {
  const originalEnv = { ...process.env };
  const gateway = {
    listRecords: jest.fn(),
    getRecord: jest.fn(),
    createRecord: jest.fn(),
    updateRecord: jest.fn(),
    ensureTextField: jest.fn(),
    getFieldSchemas: jest.fn(),
  };
  const workflow = {
    enqueueCompletionNotifications: jest.fn(),
  };
  const movementCommand = {
    prepareTrustedNewInboundCatalog: jest.fn(),
    createTrustedInbound: jest.fn(),
  };
  const storageLocation = {
    resolveSelectedLocation: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FEISHU_PURCHASE_INVENTORY_SOURCE_URL =
      'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE';
    process.env.FEISHU_PURCHASE_SUBMISSION_TABLE_ID = TABLES.submission;
    process.env.FEISHU_PURCHASE_EXECUTION_TABLE_ID = TABLES.execution;
    process.env.FEISHU_WAREHOUSE_SOURCE_URL =
      'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE';
    process.env.FEISHU_WAREHOUSE_CATALOG_TABLE_ID = TABLES.catalog;
    process.env.FEISHU_WAREHOUSE_INBOUND_TABLE_ID = TABLES.inbound;
    (resolveBitableAppToken as jest.Mock).mockImplementation(
      (_http: unknown, options: { tableName: string }) =>
        Promise.resolve(
          options.tableName === '采购与库房管理'
            ? 'purchase-app'
            : 'warehouse-app',
        ),
    );
    (fetchBitableRecords as jest.Mock).mockImplementation(
      (_http: unknown, { tableId }: { tableId: string }) =>
        Promise.resolve(pendingReadRecords(tableId)),
    );
    gateway.listRecords.mockImplementation(({ tableId }: { tableId: string }) =>
      Promise.resolve(
        tableId === TABLES.submission
          ? [submission()]
          : tableId === TABLES.execution
            ? [execution()]
            : tableId === TABLES.catalog
              ? [preparedCatalog()]
              : [],
      ),
    );
    gateway.getRecord.mockImplementation(
      async (_appToken: string, tableId: string, recordId: string) => {
        const implementation = gateway.listRecords.getMockImplementation();
        const records = implementation ? await implementation({ tableId }) : [];
        const selected = records.find(
          (record: { record_id?: string; id?: string }) =>
            (record.record_id || record.id) === recordId,
        );
        if (!selected) {
          throw new InventoryWorkflowRecordNotFoundError(
            tableId === TABLES.execution ? '采购执行' : '物品类别',
            recordId,
          );
        }
        return selected;
      },
    );
    gateway.createRecord.mockResolvedValue('unexpected-direct-write');
    gateway.updateRecord.mockResolvedValue(undefined);
    gateway.ensureTextField.mockResolvedValue(undefined);
    gateway.getFieldSchemas.mockResolvedValue(COMPLETE_EXECUTION_FIELD_SCHEMAS);
    workflow.enqueueCompletionNotifications.mockResolvedValue(1);
    storageLocation.resolveSelectedLocation.mockResolvedValue({
      recordId: 'location-b-009',
      building: 'B楼',
      company: '南通承宏',
      category: '库内',
      name: 'B-1F-009',
    });
    movementCommand.prepareTrustedNewInboundCatalog.mockResolvedValue({
      catalogRecordId: 'catalog-prepared',
      sku: 'A2001',
      alreadyPrepared: false,
      preparedAt: '2026-07-13T02:30:00.000Z',
    });
    movementCommand.createTrustedInbound.mockImplementation(
      (
        _sourceKey: string,
        request: TrustedInventoryInboundRequest,
        _principal: AccessPrincipal,
      ) =>
        Promise.resolve(
          trustedResult(
            request.clientMutationId,
            request.building,
            request.quantity,
          ),
        ),
    );
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('待入库清单附上原生责任代际；旧直接确认入口不能绕过交接受理', async () => {
    const item = execution();
    const recordId = item.record_id || item.id;
    const responsibility = { generation: 2 };
    const ledger = { purchaseResponsibilities: jest.fn().mockResolvedValue({ [recordId]: responsibility }), purchaseResponsibility: jest.fn().mockResolvedValue(responsibility) };
    const service = createService(undefined, ledger);
    const response = await service.listPending();expect(response.items.find(value => value.executionRecordId === recordId)).toMatchObject({ responsibilityGeneration: 2 });
    const before = gateway.updateRecord.mock.calls.length;
    await expect(service.confirm({ executionRecordId: recordId, sku: 'synthetic', mode: 'existing', quantity: 1, occurredAt: '2026-10-15T00:00:00.000Z' }, ADMIN)).rejects.toThrow('交接');
    expect(gateway.updateRecord.mock.calls).toHaveLength(before);
  });

  it('delegates a strict new item to the shared three-table coordinator before completing purchase', async () => {
    const service = createService();
    const request = newItemRequest();

    const result = await service.confirm(request, ADMIN);

    expect(movementCommand.createTrustedInbound).toHaveBeenCalledWith(
      '采购:exec-1',
      {
        type: 'inbound',
        mode: 'new',
        clientMutationId: 'purchase-new-transport-1',
        building: 'B楼',
        quantity: 2,
        occurredAt: '2026-07-13T03:00:00.000Z',
        newItem: request.newItem,
      },
      ADMIN,
      {
        requirePreparedCatalog: true,
        expectedCatalogRecordId: 'catalog-prepared',
        expectedSku: 'A2001',
      },
    );
    expect(storageLocation.resolveSelectedLocation).toHaveBeenCalledWith(
      'B楼',
      'location-b-009',
      'B-1F-009',
    );
    expect(
      storageLocation.resolveSelectedLocation.mock.invocationCallOrder[0],
    ).toBeLessThan(
      movementCommand.createTrustedInbound.mock.invocationCallOrder[0],
    );
    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(gateway.updateRecord).toHaveBeenCalledWith(
      'purchase-app',
      TABLES.execution,
      'exec-1',
      {
        物品类别码: 'A2001',
        实际采购数量: 2,
        是否已入库: true,
        采购流程: '采购完成（已入库）',
        程序采购状态: '物品签收已入库',
      },
      '采购执行',
    );
    expect(gateway.getFieldSchemas.mock.invocationCallOrder[0]).toBeLessThan(
      movementCommand.createTrustedInbound.mock.invocationCallOrder[0],
    );
    expect(
      movementCommand.createTrustedInbound.mock.invocationCallOrder[0],
    ).toBeLessThan(gateway.updateRecord.mock.invocationCallOrder[0]);
    expect(result).toEqual({
      success: true,
      executionRecordId: 'exec-1',
      catalogRecordId: 'catalog-created',
      inboundRecordId: 'inbound-created',
      alreadyProcessed: false,
      message: '采购物品已确认入库',
      notificationWarnings: [],
      movement: expect.objectContaining({
        clientMutationId: 'purchase-new-transport-1',
        sku: 'A2001',
        building: 'B楼',
        location: 'B-1F-009',
      }),
    });
    expect(gateway.getRecord).toHaveBeenCalledWith(
      'purchase-app',
      TABLES.execution,
      'exec-1',
      '采购执行',
    );
    expect(gateway.listRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        appToken: 'purchase-app',
        tableId: TABLES.submission,
        tableName: '采购提交',
        filter: 'CurrentValue.[采购编码]="PR-001"',
      }),
    );
    expect(
      gateway.listRecords.mock.calls.every(
        ([options]) =>
          typeof options.filter === 'string' && options.filter.length > 0,
      ),
    ).toBe(true);
  });

  it('authorizes and prepares a category without completing the purchase', async () => {
    const service = createService();
    const request = prepareCategoryRequest();

    const result = await service.prepareCategory(request, ADMIN);

    expect(
      movementCommand.prepareTrustedNewInboundCatalog,
    ).toHaveBeenCalledWith(
      '采购:exec-1',
      {
        type: 'inbound',
        mode: 'new',
        clientMutationId: 'purchase-prepare-transport-1',
        building: 'B楼',
        quantity: 2,
        occurredAt: '2026-07-13T03:00:00.000Z',
        newItem: request.newItem,
      },
      ADMIN,
    );
    expect(storageLocation.resolveSelectedLocation).toHaveBeenCalledWith(
      'B楼',
      'location-b-009',
      'B-1F-009',
    );
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(workflow.enqueueCompletionNotifications).not.toHaveBeenCalled();
    expect(result).toEqual({
      catalogRecordId: 'catalog-prepared',
      sku: 'A2001',
      alreadyPrepared: false,
      preparedAt: '2026-07-13T02:30:00.000Z',
    });
  });

  it('uses the authorized execution for category eligibility without rereading submissions', async () => {
    const service = createService();

    await service.prepareCategory(prepareCategoryRequest(), ADMIN);

    expect(gateway.getRecord).toHaveBeenCalledWith(
      'purchase-app',
      TABLES.execution,
      'exec-1',
      '采购执行',
    );
    expect(gateway.listRecords).not.toHaveBeenCalled();
    expect(
      movementCommand.prepareTrustedNewInboundCatalog,
    ).toHaveBeenCalledTimes(1);
  });

  it('starts execution authorization and location validation concurrently when preparing a category', async () => {
    let releaseExecution!: () => void;
    let releaseLocation!: () => void;
    gateway.getRecord.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseExecution = () => resolve(execution());
        }),
    );
    storageLocation.resolveSelectedLocation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseLocation = () =>
            resolve({
              recordId: 'location-b-009',
              building: 'B楼',
              company: '南通承宏',
              category: '库内',
              name: 'B-1F-009',
            });
        }),
    );
    const service = createService();
    const preparation = service.prepareCategory(
      prepareCategoryRequest(),
      ADMIN,
    );

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(gateway.getRecord).toHaveBeenCalledTimes(1);
      expect(storageLocation.resolveSelectedLocation).toHaveBeenCalledTimes(1);
    } finally {
      releaseExecution?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseLocation?.();
      await preparation;
    }
  });

  it('rejects category preparation without a selected location record before any catalog write', async () => {
    const service = createService();
    const request = prepareCategoryRequest();
    delete request.newItem.locationRecordId;

    await expect(service.prepareCategory(request, ADMIN)).rejects.toThrow(
      '请选择底表中的存放位置',
    );
    expect(storageLocation.resolveSelectedLocation).not.toHaveBeenCalled();
    expect(
      movementCommand.prepareTrustedNewInboundCatalog,
    ).not.toHaveBeenCalled();
  });

  it('uses the canonical selected location when preparing a category', async () => {
    storageLocation.resolveSelectedLocation.mockResolvedValueOnce({
      recordId: 'location-b-009',
      building: 'B楼',
      company: '南通承宏',
      category: '库内',
      name: 'B-1F-009（规范）',
    });
    const service = createService();
    const request = prepareCategoryRequest();

    await service.prepareCategory(request, ADMIN);

    expect(
      movementCommand.prepareTrustedNewInboundCatalog,
    ).toHaveBeenCalledWith(
      '采购:exec-1',
      expect.objectContaining({
        newItem: expect.objectContaining({
          location: 'B-1F-009（规范）',
          locationRecordId: 'location-b-009',
        }),
      }),
      ADMIN,
    );
  });

  it('stops final inbound before inventory writes when the prepared location no longer validates', async () => {
    storageLocation.resolveSelectedLocation.mockRejectedValueOnce(
      new BadRequestException('所选存放位置不存在，请重新选择'),
    );
    const service = createService();

    await expect(service.confirm(newItemRequest(), ADMIN)).rejects.toThrow(
      '所选存放位置不存在，请重新选择',
    );
    expect(movementCommand.createTrustedInbound).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it('starts purchase completion schema read while validating the prepared location', async () => {
    let releaseLocation!: () => void;
    storageLocation.resolveSelectedLocation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseLocation = () =>
            resolve({
              recordId: 'location-b-009',
              building: 'B楼',
              company: '南通承宏',
              category: '库内',
              name: 'B-1F-009',
            });
        }),
    );
    const service = createService();
    const confirmation = service.confirm(newItemRequest(), ADMIN);

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(storageLocation.resolveSelectedLocation).toHaveBeenCalledTimes(1);
      expect(gateway.getFieldSchemas).toHaveBeenCalledWith(
        'purchase-app',
        TABLES.execution,
        '采购执行',
      );
    } finally {
      releaseLocation();
      await confirmation;
    }
  });

  it.each([undefined, 'location-b-other'])(
    'rejects a final request whose location record no longer matches the prepared category (%s)',
    async (locationRecordId) => {
      const request = newItemRequest();
      if (request.mode === 'new') {
        request.newItem = {
          ...request.newItem,
          locationRecordId,
        };
      }
      const service = createService();

      await expect(service.confirm(request, ADMIN)).rejects.toThrow(
        '存放位置已变化，请重新生成物品类别号',
      );
      expect(storageLocation.resolveSelectedLocation).not.toHaveBeenCalled();
      expect(movementCommand.createTrustedInbound).not.toHaveBeenCalled();
      expect(gateway.updateRecord).not.toHaveBeenCalled();
    },
  );

  it('allows one-time completion of a legacy prepared category without a location record id', async () => {
    gateway.listRecords.mockImplementation(({ tableId }: { tableId: string }) =>
      Promise.resolve(
        tableId === TABLES.submission
          ? [submission()]
          : tableId === TABLES.execution
            ? [execution()]
            : tableId === TABLES.catalog
              ? [preparedCatalog(false)]
              : [],
      ),
    );
    const request = newItemRequest();
    if (request.mode === 'new') {
      delete request.newItem.locationRecordId;
    }
    const service = createService();

    await expect(service.confirm(request, ADMIN)).resolves.toMatchObject({
      success: true,
    });
    expect(storageLocation.resolveSelectedLocation).not.toHaveBeenCalled();
    expect(movementCommand.createTrustedInbound).toHaveBeenCalledTimes(1);
  });

  it('writes only completion fields that exist in the purchase execution schema', async () => {
    gateway.getFieldSchemas.mockResolvedValue([
      { fieldName: '实际采购数量', type: 2, uiType: 'Number', writable: true },
      {
        fieldName: '采购流程',
        type: 3,
        uiType: 'SingleSelect',
        writable: true,
      },
    ]);
    const service = createService();

    await service.confirm(newItemRequest(), ADMIN);

    expect(gateway.updateRecord).toHaveBeenCalledWith(
      'purchase-app',
      TABLES.execution,
      'exec-1',
      {
        实际采购数量: 2,
        采购流程: '采购完成（已入库）',
      },
      '采购执行',
    );
  });

  it('rejects a missing required completion field before inventory persistence', async () => {
    gateway.getFieldSchemas.mockResolvedValue([
      {
        fieldName: '采购流程',
        type: 3,
        uiType: 'SingleSelect',
        writable: true,
      },
    ]);
    const service = createService();

    await expect(service.confirm(newItemRequest(), ADMIN)).rejects.toEqual(
      expect.objectContaining({
        constructor: BadRequestException,
        message: expect.stringContaining('实际采购数量'),
      }),
    );
    expect(movementCommand.createTrustedInbound).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it('rejects an incompatible completion field type before inventory persistence', async () => {
    gateway.getFieldSchemas.mockResolvedValue([
      { fieldName: '实际采购数量', type: 1, uiType: 'Text', writable: true },
      {
        fieldName: '采购流程',
        type: 3,
        uiType: 'SingleSelect',
        writable: true,
      },
    ]);
    const service = createService();

    await expect(service.confirm(newItemRequest(), ADMIN)).rejects.toEqual(
      expect.objectContaining({
        constructor: BadRequestException,
        message: expect.stringContaining('实际采购数量'),
      }),
    );
    expect(movementCommand.createTrustedInbound).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it('rejects a read-only completion field before inventory persistence', async () => {
    gateway.getFieldSchemas.mockResolvedValue([
      { fieldName: '实际采购数量', type: 2, uiType: 'Number', writable: true },
      {
        fieldName: '采购流程',
        type: 20,
        uiType: 'Formula',
        writable: false,
      },
    ]);
    const service = createService();

    await expect(service.confirm(newItemRequest(), ADMIN)).rejects.toEqual(
      expect.objectContaining({
        constructor: BadRequestException,
        message: expect.stringContaining('采购流程'),
      }),
    );
    expect(movementCommand.createTrustedInbound).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it('omits incompatible optional fields when a valid completion status remains', async () => {
    gateway.getFieldSchemas.mockResolvedValue([
      {
        fieldName: '物品类别码',
        type: 20,
        uiType: 'Formula',
        writable: false,
      },
      { fieldName: '实际采购数量', type: 2, uiType: 'Number', writable: true },
      {
        fieldName: '是否已入库',
        type: 20,
        uiType: 'Formula',
        writable: false,
      },
      {
        fieldName: '采购流程',
        type: 3,
        uiType: 'SingleSelect',
        writable: true,
      },
    ]);
    const service = createService();

    await service.confirm(newItemRequest(), ADMIN);

    expect(gateway.updateRecord).toHaveBeenCalledWith(
      'purchase-app',
      TABLES.execution,
      'exec-1',
      {
        实际采购数量: 2,
        采购流程: '采购完成（已入库）',
      },
      '采购执行',
    );
  });

  it('does not persist inventory when the execution schema cannot be read', async () => {
    const schemaReadFailure = new Error('schema read failed');
    gateway.getFieldSchemas.mockRejectedValueOnce(schemaReadFailure);
    const service = createService();

    await expect(service.confirm(newItemRequest(), ADMIN)).rejects.toBe(
      schemaReadFailure,
    );
    expect(movementCommand.createTrustedInbound).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it('delegates an existing item selected from the requested target building', async () => {
    gateway.listRecords.mockImplementation(({ tableId }: { tableId: string }) =>
      Promise.resolve(
        tableId === TABLES.submission
          ? [existingSubmission()]
          : tableId === TABLES.execution
            ? [execution({ 物品类别码: 'A2001' })]
            : tableId === TABLES.catalog
              ? [catalog('catalog-b', 'B楼', 'A2001')]
              : [],
      ),
    );
    const service = createService();
    const request: PurchaseInboundConfirmRequest = {
      executionRecordId: 'exec-1',
      mode: 'existing',
      building: 'B楼',
      clientMutationId: 'purchase-existing-transport-1',
      catalogRecordId: 'catalog-b',
      sku: 'A2001',
      quantity: 2,
      occurredAt: '2026-07-13T03:00:00.000Z',
    };

    await service.confirm(request, ADMIN);

    expect(gateway.getRecord).toHaveBeenCalledWith(
      'warehouse-app',
      TABLES.catalog,
      'catalog-b',
      '物品类别',
    );
    expect(movementCommand.createTrustedInbound).toHaveBeenCalledWith(
      '采购:exec-1',
      {
        type: 'inbound',
        mode: 'existing',
        clientMutationId: 'purchase-existing-transport-1',
        building: 'B楼',
        catalogRecordId: 'catalog-b',
        sku: 'A2001',
        quantity: 2,
        occurredAt: '2026-07-13T03:00:00.000Z',
      },
      ADMIN,
      undefined,
    );
  });

  it('returns a business error when the purchase execution record no longer exists', async () => {
    gateway.listRecords.mockResolvedValue([]);
    const service = createService();

    const confirmation = service.confirm(newItemRequest(), ADMIN);
    await expect(confirmation).rejects.toBeInstanceOf(BadRequestException);
    await expect(confirmation).rejects.toThrow('采购执行记录不存在');
    expect(movementCommand.createTrustedInbound).not.toHaveBeenCalled();
  });

  it('returns a business error when the selected inventory catalog record no longer exists', async () => {
    gateway.listRecords.mockImplementation(({ tableId }: { tableId: string }) =>
      Promise.resolve(
        tableId === TABLES.submission
          ? [existingSubmission()]
          : tableId === TABLES.execution
            ? [execution({ 物品类别码: 'A2001' })]
            : [],
      ),
    );
    const service = createService();
    const request: PurchaseInboundConfirmRequest = {
      executionRecordId: 'exec-1',
      mode: 'existing',
      building: 'B楼',
      clientMutationId: 'purchase-missing-catalog',
      catalogRecordId: 'catalog-missing',
      sku: 'A2001',
      quantity: 2,
      occurredAt: '2026-07-13T03:00:00.000Z',
    };

    const confirmation = service.confirm(request, ADMIN);
    await expect(confirmation).rejects.toBeInstanceOf(BadRequestException);
    await expect(confirmation).rejects.toThrow('所选库存物品类别不存在');
    expect(movementCommand.createTrustedInbound).not.toHaveBeenCalled();
  });

  it('preserves directed-read network failures instead of reporting missing data', async () => {
    const networkFailure = new Error('network unavailable');
    gateway.getRecord.mockRejectedValueOnce(networkFailure);
    const service = createService();

    await expect(service.confirm(newItemRequest(), ADMIN)).rejects.toBe(
      networkFailure,
    );
    expect(movementCommand.createTrustedInbound).not.toHaveBeenCalled();
  });

  it('does not complete purchase when the shared coordinator fails', async () => {
    movementCommand.createTrustedInbound.mockRejectedValueOnce(
      new Error('inbound failed'),
    );
    const service = createService();

    await expect(service.confirm(newItemRequest(), ADMIN)).rejects.toThrow(
      'inbound failed',
    );

    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(workflow.enqueueCompletionNotifications).not.toHaveBeenCalled();
  });

  it('retries only purchase completion after a terminal write failure', async () => {
    movementCommand.createTrustedInbound
      .mockResolvedValueOnce(
        trustedResult('purchase-new-transport-1', 'B楼', 2, false),
      )
      .mockResolvedValueOnce(
        trustedResult('purchase-new-transport-retry', 'B楼', 2, true),
      );
    gateway.updateRecord
      .mockRejectedValueOnce(new Error('采购终态回写失败'))
      .mockResolvedValueOnce(undefined);
    const service = createService();

    await expect(service.confirm(newItemRequest(), ADMIN)).rejects.toThrow(
      '采购终态回写失败',
    );
    const result = await service.confirm(
      {
        ...newItemRequest(),
        clientMutationId: 'purchase-new-transport-retry',
      },
      ADMIN,
    );

    expect(movementCommand.createTrustedInbound).toHaveBeenCalledTimes(2);
    expect(
      movementCommand.createTrustedInbound.mock.calls.map((call) => call[0]),
    ).toEqual(['采购:exec-1', '采购:exec-1']);
    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      alreadyProcessed: true,
      movement: {
        clientMutationId: 'purchase-new-transport-retry',
        sku: 'A2001',
      },
    });
  });

  it('rejects a different business payload while the same execution is in flight', async () => {
    const service = createService();
    const first = service.confirm(newItemRequest(), ADMIN);

    await expect(
      service.confirm({ ...newItemRequest(), quantity: 1 }, ADMIN),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(first).resolves.toMatchObject({ success: true });
    expect(movementCommand.createTrustedInbound).toHaveBeenCalledTimes(1);
  });

  it('treats a different selected location record as a different in-flight business payload', async () => {
    const service = createService();
    const first = service.confirm(newItemRequest(), ADMIN);
    const changedLocationRequest = newItemRequest();
    if (changedLocationRequest.mode === 'new') {
      changedLocationRequest.newItem = {
        ...changedLocationRequest.newItem,
        locationRecordId: 'location-b-other',
      };
    }

    await expect(
      service.confirm(changedLocationRequest, ADMIN),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(first).resolves.toMatchObject({ success: true });
    expect(movementCommand.createTrustedInbound).toHaveBeenCalledTimes(1);
  });

  it('coalesces the same business payload while preserving each transport mutation id', async () => {
    const service = createService();
    const first = service.confirm(newItemRequest(), ADMIN);
    const retry = service.confirm(
      {
        ...newItemRequest(),
        clientMutationId: 'purchase-new-transport-concurrent-retry',
      },
      ADMIN,
    );

    await expect(first).resolves.toMatchObject({
      movement: { clientMutationId: 'purchase-new-transport-1' },
    });
    await expect(retry).resolves.toMatchObject({
      movement: {
        clientMutationId: 'purchase-new-transport-concurrent-retry',
      },
    });
    expect(movementCommand.createTrustedInbound).toHaveBeenCalledTimes(1);
  });

  it('coordinates purchase confirmation with deletion for the same execution', async () => {
    const operationCoordinator = {
      run: jest.fn(
        (_resourceKeys: readonly string[], operation: () => Promise<unknown>) =>
          operation(),
      ),
    };
    const service = createService(operationCoordinator);

    await service.confirm(newItemRequest(), ADMIN);

    expect(operationCoordinator.run).toHaveBeenCalledWith(
      ['purchase:exec-1'],
      expect.any(Function),
    );
  });

  it('rechecks execution scope before joining an in-flight confirmation', async () => {
    const service = createService();
    const first = service.confirm(newItemRequest(), ADMIN);

    await expect(
      service.confirm(newItemRequest(), B_BUILDING_ADMIN),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(first).resolves.toMatchObject({ success: true });
    expect(movementCommand.createTrustedInbound).toHaveBeenCalledTimes(1);
  });

  it('uses recover-only coordination for a completed execution retry', async () => {
    gateway.listRecords.mockImplementation(({ tableId }: { tableId: string }) =>
      Promise.resolve(
        tableId === TABLES.submission
          ? [submission()]
          : tableId === TABLES.execution
            ? [
                execution({
                  是否已入库: true,
                  采购流程: '到货已签收（待入库）',
                  程序采购状态: '',
                }),
              ]
            : [],
      ),
    );
    movementCommand.createTrustedInbound.mockResolvedValueOnce(
      trustedResult('purchase-completed-retry', 'B楼', 2, true),
    );
    const service = createService();

    const result = await service.confirm(
      {
        ...newItemRequest(),
        clientMutationId: 'purchase-completed-retry',
      },
      ADMIN,
    );

    expect(movementCommand.createTrustedInbound).toHaveBeenCalledWith(
      '采购:exec-1',
      expect.objectContaining({
        clientMutationId: 'purchase-completed-retry',
        building: 'B楼',
      }),
      ADMIN,
      {
        recoverOnly: true,
        requirePreparedCatalog: true,
        expectedCatalogRecordId: 'catalog-prepared',
        expectedSku: 'A2001',
      },
    );
    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(gateway.updateRecord).toHaveBeenCalledWith(
      'purchase-app',
      TABLES.execution,
      'exec-1',
      {
        物品类别码: 'A2001',
        实际采购数量: 2,
        是否已入库: true,
        采购流程: '采购完成（已入库）',
        程序采购状态: '物品签收已入库',
      },
      '采购执行',
    );
    expect(gateway.getRecord).toHaveBeenCalledWith(
      'purchase-app',
      TABLES.execution,
      'exec-1',
      '采购执行',
    );
    expect(gateway.listRecords).not.toHaveBeenCalled();
    expect(result.alreadyProcessed).toBe(true);
  });

  it('recovers a completed legacy existing request with the authorized execution building', async () => {
    gateway.listRecords.mockImplementation(({ tableId }: { tableId: string }) =>
      Promise.resolve(
        tableId === TABLES.submission
          ? [existingSubmission()]
          : tableId === TABLES.execution
            ? [
                execution({
                  物品类别码: 'A2001',
                  是否已入库: true,
                  采购流程: '采购完成（已入库）',
                }),
              ]
            : tableId === TABLES.catalog
              ? [catalog('catalog-a', 'A楼', 'A2001')]
              : [],
      ),
    );
    movementCommand.createTrustedInbound.mockResolvedValue(
      trustedResult('canonical-recovery-mutation', 'A楼', 2, true),
    );
    const service = createService();
    const request: PurchaseInboundConfirmRequest = {
      executionRecordId: 'exec-1',
      mode: 'existing',
      catalogRecordId: 'catalog-a',
      sku: 'A2001',
      quantity: 2,
      occurredAt: '2026-07-13T03:00:00.000Z',
    };

    const result = await service.confirm(request, A_BUILDING_ADMIN);

    expect(movementCommand.createTrustedInbound).toHaveBeenCalledWith(
      '采购:exec-1',
      {
        type: 'inbound',
        mode: 'existing',
        clientMutationId: 'purchase-legacy:exec-1',
        building: 'A楼',
        catalogRecordId: 'catalog-a',
        sku: 'A2001',
        quantity: 2,
        occurredAt: '2026-07-13T03:00:00.000Z',
      },
      A_BUILDING_ADMIN,
      { recoverOnly: true },
    );
    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(gateway.updateRecord).toHaveBeenCalledWith(
      'purchase-app',
      TABLES.execution,
      'exec-1',
      {
        物品类别码: 'A2001',
        实际采购数量: 2,
        是否已入库: true,
        采购流程: '采购完成（已入库）',
        程序采购状态: '物品签收已入库',
      },
      '采购执行',
    );
    expect(result).toMatchObject({
      catalogRecordId: 'catalog-created',
      inboundRecordId: 'inbound-created',
      alreadyProcessed: true,
      movement: {
        clientMutationId: 'purchase-legacy:exec-1',
        building: 'A楼',
        sku: 'A2001',
      },
    });
  });

  it('does not create records when a completed retry has no purchase source marker', async () => {
    gateway.listRecords.mockImplementation(({ tableId }: { tableId: string }) =>
      Promise.resolve(
        tableId === TABLES.submission
          ? [submission()]
          : tableId === TABLES.execution
            ? [
                execution({
                  是否已入库: true,
                  采购流程: '采购完成（已入库）',
                }),
              ]
            : [],
      ),
    );
    movementCommand.createTrustedInbound.mockRejectedValueOnce(
      new BadRequestException('未找到可恢复的采购入库记录'),
    );
    const service = createService();

    await expect(
      service.confirm(
        {
          ...newItemRequest(),
          clientMutationId: 'purchase-completed-no-marker',
        },
        ADMIN,
      ),
    ).rejects.toThrow('未找到可恢复的采购入库记录');
    expect(movementCommand.createTrustedInbound).toHaveBeenCalledWith(
      '采购:exec-1',
      expect.anything(),
      ADMIN,
      {
        recoverOnly: true,
        requirePreparedCatalog: true,
        expectedCatalogRecordId: 'catalog-prepared',
        expectedSku: 'A2001',
      },
    );
    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it('checks the original execution building inside the service', async () => {
    gateway.listRecords.mockImplementation(({ tableId }: { tableId: string }) =>
      Promise.resolve(
        tableId === TABLES.submission
          ? [submission()]
          : tableId === TABLES.execution
            ? [
                execution({
                  申请楼栋: 'B楼',
                  是否已入库: true,
                  采购流程: '采购完成（已入库）',
                }),
              ]
            : [],
      ),
    );
    const service = createService();

    await expect(
      service.confirm(
        { ...newItemRequest(), building: 'A楼' },
        A_BUILDING_ADMIN,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(movementCommand.createTrustedInbound).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['invalid', 'Z楼'],
  ])(
    'rejects a strict completed retry when the original execution building is %s',
    async (_label, originalBuilding) => {
      gateway.listRecords.mockImplementation(
        ({ tableId }: { tableId: string }) =>
          Promise.resolve(
            tableId === TABLES.submission
              ? [existingSubmission()]
              : tableId === TABLES.execution
                ? [
                    execution({
                      申请楼栋: originalBuilding,
                      物品类别码: 'A2001',
                      是否已入库: true,
                      采购流程: '采购完成（已入库）',
                    }),
                  ]
                : tableId === TABLES.catalog
                  ? [catalog('catalog-a', 'A楼', 'A2001')]
                  : [],
          ),
      );
      const service = createService();

      await expect(
        service.confirm(
          {
            executionRecordId: 'exec-1',
            mode: 'existing',
            building: 'A楼',
            clientMutationId: `strict-${_label}-execution-building`,
            catalogRecordId: 'catalog-a',
            sku: 'A2001',
            quantity: 2,
            occurredAt: '2026-07-13T03:00:00.000Z',
          },
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(movementCommand.createTrustedInbound).not.toHaveBeenCalled();
    },
  );

  it('completes the business write when the completion notification outbox is unavailable', async () => {
    const enqueueError = new Error('完成通知队列不可用');
    workflow.enqueueCompletionNotifications.mockRejectedValueOnce(enqueueError);
    const service = createService();

    await expect(
      service.confirm(newItemRequest(), ADMIN),
    ).resolves.toMatchObject({
      success: true,
      executionRecordId: 'exec-1',
      notificationWarnings: [],
    });
    expect(gateway.updateRecord).toHaveBeenCalledTimes(1);
    expect(movementCommand.createTrustedInbound).toHaveBeenCalledTimes(1);
    expect(workflow.enqueueCompletionNotifications).toHaveBeenCalledWith(
      'exec-1',
      expect.objectContaining({ sku: 'A2001', location: 'B-1F-009' }),
    );
  });

  it('does not wait for a slow completion notification outbox after the business write', async () => {
    workflow.enqueueCompletionNotifications.mockImplementationOnce(
      () => new Promise<number>(() => undefined),
    );
    const service = createService();

    const outcome = await Promise.race([
      service.confirm(newItemRequest(), ADMIN).then(() => 'completed'),
      new Promise<'blocked'>((resolve) =>
        setImmediate(() => resolve('blocked')),
      ),
    ]);

    expect(outcome).toBe('completed');
    expect(workflow.enqueueCompletionNotifications).toHaveBeenCalledWith(
      'exec-1',
      expect.objectContaining({ sku: 'A2001', location: 'B-1F-009' }),
    );
  });

  it('ensures the completion notification outbox without reading or writing Base', async () => {
    const service = createService();

    await expect(
      service.ensureCompletionNotificationOutbox('exec-1'),
    ).resolves.toBeUndefined();

    expect(workflow.enqueueCompletionNotifications).toHaveBeenCalledWith(
      'exec-1',
      undefined,
    );
    expect(gateway.getRecord).not.toHaveBeenCalled();
    expect(gateway.listRecords).not.toHaveBeenCalled();
    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(movementCommand.createTrustedInbound).not.toHaveBeenCalled();
    expect(fetchBitableRecords).not.toHaveBeenCalled();
  });

  it('rejects legacy existing requests while the purchase is still pending', async () => {
    gateway.listRecords.mockImplementation(({ tableId }: { tableId: string }) =>
      Promise.resolve(
        tableId === TABLES.submission
          ? [existingSubmission()]
          : tableId === TABLES.execution
            ? [execution({ 物品类别码: 'A2001' })]
            : tableId === TABLES.catalog
              ? [catalog('catalog-a', 'A楼', 'A2001')]
              : [],
      ),
    );
    const service = createService();
    const request: PurchaseInboundConfirmRequest = {
      executionRecordId: 'exec-1',
      mode: 'existing',
      catalogRecordId: 'catalog-a',
      sku: 'A2001',
      quantity: 2,
      occurredAt: '2026-07-13T03:00:00.000Z',
    };

    await expect(service.confirm(request, ADMIN)).rejects.toThrow(
      '请刷新页面后提供目标楼栋和请求标识',
    );

    expect(movementCommand.createTrustedInbound).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'lists pending purchases through cached direct reads (forceRefresh=%s)',
    async (forceRefresh) => {
      const service = createService();

      await expect(
        forceRefresh ? service.listPending(true) : service.listPending(),
      ).resolves.toMatchObject({
        items: [
          expect.objectContaining({
            mode: null,
            action: 'needs_selection',
            catalogRecordId: '',
          }),
        ],
      });

      expect(fetchBitableRecords).toHaveBeenCalledTimes(3);
      expect(fetchBitableRecords).toHaveBeenCalledWith(expect.anything(), {
        appToken: 'purchase-app',
        tableId: TABLES.submission,
        tableName: '采购提交',
        cacheTtlMs: 4 * 60 * 60 * 1000,
        forceRefresh,
      });
      expect(fetchBitableRecords).toHaveBeenCalledWith(expect.anything(), {
        appToken: 'purchase-app',
        tableId: TABLES.execution,
        tableName: '采购执行',
        cacheTtlMs: 4 * 60 * 60 * 1000,
        forceRefresh,
      });
      expect(fetchBitableRecords).toHaveBeenCalledWith(expect.anything(), {
        appToken: 'warehouse-app',
        tableId: TABLES.catalog,
        tableName: '物品类别',
        cacheTtlMs: 4 * 60 * 60 * 1000,
        forceRefresh,
      });
      expect(gateway.listRecords).not.toHaveBeenCalled();
    },
  );

  function createService(operationCoordinator?: {
    run<T>(
      resourceKeys: readonly string[],
      operation: () => Promise<T>,
    ): Promise<T>;
  }, responsibilityLedger?: unknown): PurchaseConfirmationTestService {
    const Service = PurchaseInboundConfirmationService as unknown as new (
      httpService: unknown,
      inventoryGateway: unknown,
      purchaseWorkflow: unknown,
      inventoryMovementCommand: unknown,
      inventoryStorageLocation: unknown,
      inventoryMovementOperationCoordinator?: unknown,
      inventoryInboundTaskLedger?: unknown,
    ) => PurchaseInboundConfirmationService;
    return new Service(
      { axiosRef: {} },
      gateway,
      workflow,
      movementCommand,
      storageLocation,
      operationCoordinator,
      responsibilityLedger,
    ) as unknown as PurchaseConfirmationTestService;
  }
});

interface PurchaseConfirmationTestService {
  listPending(forceRefresh?: boolean): Promise<unknown>;
  ensureCompletionNotificationOutbox(executionRecordId: string): Promise<void>;
  prepareCategory(
    request: PurchaseInboundCategoryPrepareTestRequest,
    principal: AccessPrincipal,
  ): Promise<{
    catalogRecordId: string;
    sku: string;
    alreadyPrepared: boolean;
    preparedAt: string;
  }>;
  confirm(
    request: PurchaseInboundConfirmRequest,
    principal: AccessPrincipal,
  ): Promise<PurchaseInboundConfirmResponse>;
}

interface PurchaseInboundCategoryPrepareTestRequest {
  executionRecordId: string;
  clientMutationId: string;
  building: 'B楼';
  quantity: number;
  occurredAt: string;
  newItem: {
    name: string;
    primaryCategory: string;
    secondaryCategory: string;
    specification: string;
    location: string;
    locationRecordId?: string;
    brand: string;
    unit: string;
    minimumQuantity: number;
  };
}

function prepareCategoryRequest(): PurchaseInboundCategoryPrepareTestRequest {
  return {
    executionRecordId: 'exec-1',
    clientMutationId: 'purchase-prepare-transport-1',
    building: 'B楼',
    quantity: 2,
    occurredAt: '2026-07-13T03:00:00.000Z',
    newItem: {
      name: '新型滤芯',
      primaryCategory: 'A备品备件类',
      secondaryCategory: '常备件A2',
      specification: 'MERV 8',
      location: 'B-1F-009',
      locationRecordId: 'location-b-009',
      brand: '测试品牌',
      unit: '个',
      minimumQuantity: 1,
    },
  };
}

function newItemRequest(): PurchaseInboundConfirmRequest {
  return {
    executionRecordId: 'exec-1',
    mode: 'new',
    building: 'B楼',
    clientMutationId: 'purchase-new-transport-1',
    preparedCatalogRecordId: 'catalog-prepared',
    generatedSku: 'A2001',
    quantity: 2,
    occurredAt: '2026-07-13T03:00:00.000Z',
    newItem: {
      name: '新型滤芯',
      primaryCategory: 'A备品备件类',
      secondaryCategory: '常备件A2',
      specification: 'MERV 8',
      location: 'B-1F-009',
      locationRecordId: 'location-b-009',
      brand: '测试品牌',
      unit: '个',
      minimumQuantity: 1,
    },
  } as unknown as PurchaseInboundConfirmRequest;
}

function trustedResult(
  clientMutationId: string,
  building: 'A楼' | 'B楼',
  quantity: number,
  alreadyProcessed = false,
): TrustedInventoryInboundResult {
  return {
    response: {
      success: true,
      recordId: 'inbound-created',
      type: 'inbound',
      message: '入库记录已提交',
      movement: {
        recordId: 'inbound-created',
        clientMutationId,
        pendingSync: false,
        type: 'inbound',
        sku: 'A2001',
        name: '新型滤芯',
        specification: 'MERV 8',
        quantity,
        unit: '个',
        building,
        destinationBuilding: '',
        location: building === 'B楼' ? 'B-1F-009' : 'A-1F-009',
        reason: '',
        operator: '',
        applicant: '',
        status: '已入库',
        occurredAt: '2026-07-13T03:00:00.000Z',
        expectedReturnAt: null,
        overdue: false,
      },
    },
    catalogRecordId: 'catalog-created',
    inventoryRecordId: 'inventory-created',
    inboundRecordId: 'inbound-created',
    alreadyProcessed,
  };
}

function submission() {
  return record('sub-1', {
    采购编码: 'PR-001',
    新增物品名称: '新型滤芯',
    一级分类: 'A备品备件类',
    二级分类: '常备件A2',
    规格型号: 'MERV 8',
    品牌: '测试品牌',
    单位: '个',
  });
}

function existingSubmission() {
  return record('sub-1', {
    采购编码: 'PR-001',
    非新增物品名称: '已有滤芯',
  });
}

function execution(overrides: Record<string, unknown> = {}) {
  return record('exec-1', {
    采购编码: 'PR-001',
    物品名称: '新型滤芯',
    申请楼栋: 'A楼',
    实际采购数量: 2,
    采购完成: true,
    是否已入库: false,
    '到货签收确认（签收内容填写完成后点击）': true,
    签收时间: Date.parse('2026-07-13T02:00:00.000Z'),
    ...overrides,
  });
}

function catalog(recordId: string, building: 'A楼' | 'B楼', sku: string) {
  return record(recordId, {
    物品类别号: sku,
    名称: '已有滤芯',
    '规格型号、设备序列号': 'MERV 8',
    品牌: '测试品牌',
    一级分类: 'A备品备件类',
    二级分类: '常备件A2',
    楼栋: building,
    计数单位: '个',
  });
}

function preparedCatalog(withLocationRecordId = true) {
  const request = {
    type: 'inbound',
    mode: 'new',
    clientMutationId: 'purchase-prepare-transport-1',
    building: 'B楼',
    quantity: 2,
    occurredAt: '2026-07-13T03:00:00.000Z',
    newItem: {
      name: '新型滤芯',
      primaryCategory: 'A备品备件类',
      secondaryCategory: '常备件A2',
      specification: 'MERV 8',
      location: 'B-1F-009',
      ...(withLocationRecordId ? { locationRecordId: 'location-b-009' } : {}),
      brand: '测试品牌',
      unit: '个',
      minimumQuantity: 1,
    },
  };
  return record('catalog-prepared', {
    入库创建标识: '采购:exec-1',
    入库请求指纹: 'f'.repeat(64),
    采购入库准备参数: JSON.stringify({
      version: 1,
      preparedAt: '2026-07-13T02:30:00.000Z',
      request,
    }),
    物品类别号: 'A2001',
    楼栋: 'B楼',
    一级分类: 'A备品备件类',
    二级分类: '常备件A2',
    名称: '新型滤芯',
    '规格型号、设备序列号': 'MERV 8',
    品牌: '测试品牌',
    计数单位: '个',
    最小库存量: 1,
  });
}

function pendingReadRecords(tableId: string) {
  return tableId === TABLES.submission
    ? [existingSubmission()]
    : tableId === TABLES.execution
      ? [execution({ 物品类别码: 'A2-009' })]
      : tableId === TABLES.catalog
        ? [catalog('catalog-existing', 'A楼', 'A2-009')]
        : [];
}

function record(recordId: string, fields: Record<string, unknown>) {
  return { record_id: recordId, fields };
}
