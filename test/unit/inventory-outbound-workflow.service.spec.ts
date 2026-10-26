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
  NotFoundException,
} from '@nestjs/common';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { InventoryOutboundMovementCreateRequest } from '../../shared/inventory-management.interface';
import type { InventoryOutboundApprovalSnapshot, InventoryOutboundApprovalDecision } from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.types';
import {
  fetchBitableRecords,
  resolveBitableAppToken,
} from '../../server/common/feishu/bitable-direct-read';
import { InventoryOutboundWorkflowService } from '../../server/modules/inventory-management/inventory-outbound-workflow.service';
import { InventoryWorkflowRecordNotFoundError } from '../../server/modules/inventory-management/inventory-workflow.gateway';

const ENV_KEYS = [
  'FEISHU_WAREHOUSE_SOURCE_URL',
  'FEISHU_WAREHOUSE_APP_TOKEN',
  'FEISHU_WAREHOUSE_INVENTORY_TABLE_ID',
  'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID',
  'FEISHU_WAREHOUSE_CATALOG_TABLE_ID',
] as const;

const TABLES = {
  inventory: 'tbl_inventory',
  outbound: 'tbl_outbound',
  catalog: 'tbl_catalog',
};

interface TestRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

const CATALOG: TestRecord = {
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

const INVENTORY: TestRecord = {
  record_id: 'inventory-a101',
  fields: {
    物品类别号: 'A101',
    楼栋: 'A楼',
    入库存放位置: 'A-1F-001',
    剩余库存: 5,
  },
};

const REQUEST: InventoryOutboundMovementCreateRequest = {
  type: 'outbound',
  clientMutationId: 'outbound-create-1',
  catalogRecordId: 'catalog-a101',
  sku: 'A101',
  building: 'A楼',
  quantity: 2,
  occurredAt: '2026-07-12T18:00:00+08:00',
  applicantOpenId: 'ou_applicant',
  reason: '现场更换',
};

const ADMIN: AccessPrincipal = { role: 'admin', purchaseBuilding: null };
const BUILDING_A_ADMIN: AccessPrincipal = {
  role: 'inventory_admin',
  purchaseBuilding: 'A楼',
};
const BUILDING_B_ADMIN: AccessPrincipal = {
  role: 'inventory_admin',
  purchaseBuilding: 'B楼',
};
const EDITOR: AccessPrincipal = { role: 'editor', purchaseBuilding: null };

describe('InventoryOutboundWorkflowService', () => {
  const originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  const gateway = {
    createRecord: jest.fn(),
    ensureNumberField: jest.fn().mockResolvedValue(undefined),
    ensureTextField: jest.fn().mockResolvedValue(undefined),
    getRecord: jest.fn(),
    listRecords: jest.fn(),
    updateRecord: jest.fn(),
  };
  const managementService = { invalidateCache: jest.fn() };
  const approvalService = {
    assertAcceptedDecision: jest.fn(async (snapshot:InventoryOutboundApprovalSnapshot,decision:InventoryOutboundApprovalDecision) => {
      if (decision.action!=='approve'||!snapshot.approvers.some(person=>person.openId===decision.actorOpenId))throw new ForbiddenException('未绑定的正式审批决定');
    }),
    registerPending: jest.fn(),
    ensurePendingForRequest: jest
      .fn()
      .mockImplementation(async (_record, _request, createSnapshot) => {
        const snapshot = await createSnapshot();
        const result = await approvalService.registerPending(snapshot);
        return result?.entry || { snapshot };
      }),
  };
  const warehouseRoleDirectory = {
    resolveApprovers: jest.fn(),
    resolveNotificationRecipients: jest.fn(),
  };
  const approvalGateway = { writeWorkflowError: jest.fn() };
  let recordsByTable: Record<string, TestRecord[]>;
  let nextOutboundId: number;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FEISHU_WAREHOUSE_SOURCE_URL =
      'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE';
    delete process.env.FEISHU_WAREHOUSE_APP_TOKEN;
    process.env.FEISHU_WAREHOUSE_INVENTORY_TABLE_ID = TABLES.inventory;
    process.env.FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID = TABLES.outbound;
    process.env.FEISHU_WAREHOUSE_CATALOG_TABLE_ID = TABLES.catalog;
    recordsByTable = {
      [TABLES.catalog]: [cloneRecord(CATALOG)],
      [TABLES.inventory]: [cloneRecord(INVENTORY)],
      [TABLES.outbound]: [],
    };
    nextOutboundId = 1;
    (resolveBitableAppToken as jest.Mock).mockResolvedValue('app-token');
    (fetchBitableRecords as jest.Mock).mockImplementation(
      (_httpService: unknown, options: { tableId: string }) =>
        Promise.resolve(
          (recordsByTable[options.tableId] || []).map(cloneRecord),
        ),
    );
    gateway.ensureNumberField.mockResolvedValue(undefined);
    gateway.ensureTextField.mockResolvedValue(undefined);
    gateway.listRecords.mockImplementation(
      (options: {
        tableId: string;
        filter?: string;
        searchFilter?: {
          conditions: Array<{
            field_name: string;
            operator: string;
            value?: string[];
          }>;
        };
      }) => {
        const records = recordsByTable[options.tableId] || [];
        const marker =
          options.searchFilter?.conditions.find(
            (condition) => condition.field_name === '出库创建标识',
          )?.value?.[0] || exactFilterValue(options.filter, '出库创建标识');
        return Promise.resolve(
          records
            .filter(
              (record) =>
                marker === null || record.fields['出库创建标识'] === marker,
            )
            .map(cloneRecord),
        );
      },
    );
    gateway.getRecord.mockImplementation(readRecord);
    gateway.createRecord.mockImplementation(
      async (
        _appToken: string,
        tableId: string,
        fields: Record<string, unknown>,
      ) => persistRecord(tableId, fields),
    );
    gateway.updateRecord.mockImplementation(applyUpdate);
    approvalService.registerPending.mockResolvedValue(undefined);
    warehouseRoleDirectory.resolveApprovers.mockResolvedValue([
      { openId: 'ou_warehouse_responsible', name: 'A楼示例人员019' },
    ]);
    warehouseRoleDirectory.resolveNotificationRecipients.mockResolvedValue([
      { openId: 'ou_warehouse_manager', name: 'A楼管理人' },
    ]);
    approvalGateway.writeWorkflowError.mockResolvedValue(undefined);
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('creates a routing record, registers its immutable approval snapshot, and never writes formal quantity or Stage', async () => {
    const service = createService();

    const result = await service.createPending(REQUEST, ADMIN);

    const fields = gateway.createRecord.mock.calls[0][2];
    expect(Object.keys(fields).sort()).toEqual(
      [
        '物品类别号',
        '物品申请人',
        '楼栋',
        '出库原因/出库后使用地点',
        '程序出库状态',
        '出库工作流状态',
        '程序出库申请数量',
        '程序出库申请时间',
        '出库创建标识',
        '出库请求指纹',
      ].sort(),
    );
    expect(fields).toEqual(
      expect.objectContaining({
        程序出库状态: '待审批',
        出库工作流状态: '待路由',
        程序出库申请数量: 2,
        程序出库申请时间: '2026-07-12T10:00:00.000Z',
        出库创建标识: 'outbound-create-1',
        出库请求指纹: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(fields).not.toHaveProperty('出库时间');
    expect(fields).not.toHaveProperty('出库数量');
    expect(fields).not.toHaveProperty('流程');
    expect(gateway.ensureTextField).toHaveBeenCalledTimes(5);
    expect(gateway.ensureNumberField).toHaveBeenCalledWith(
      'app-token',
      TABLES.outbound,
      '程序出库申请数量',
      '出库填写',
    );
    expect(result).toMatchObject({
      success: true,
      type: 'outbound',
      alreadyProcessed: false,
      movement: {
        recordId: 'outbound-record-1',
        clientMutationId: 'outbound-create-1',
        sku: 'A101',
        building: 'A楼',
        quantity: 2,
        status: '待审批',
        operator: 'A楼示例人员019',
        occurredAt: '2026-07-12T10:00:00.000Z',
      },
    });
    expect(warehouseRoleDirectory.resolveApprovers).toHaveBeenCalledWith('A楼');
    expect(gateway.listRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        tableId: TABLES.outbound,
        searchFilter: {
          conjunction: 'and',
          conditions: [
            {
              field_name: '出库创建标识',
              operator: 'is',
              value: [REQUEST.clientMutationId],
            },
          ],
        },
      }),
    );
    expect(gateway.listRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        tableId: TABLES.inventory,
        searchFilter: {
          conjunction: 'and',
          conditions: [{ field_name: '楼栋', operator: 'is', value: ['A楼'] }],
        },
      }),
    );
    expect(approvalService.registerPending).toHaveBeenCalledWith({
      recordId: 'outbound-record-1',
      outboundNumber: REQUEST.clientMutationId,
      version: 1,
      policyVersion: 'inventory-outbound-v1',
      applicantOpenId: REQUEST.applicantOpenId,
      applicantName: expect.any(String),
      itemName: '测试滤芯',
      sku: REQUEST.sku,
      specification: 'MERV 8',
      brand: '测试品牌',
      quantity: REQUEST.quantity,
      unit: '个',
      availableStock: 5,
      building: REQUEST.building,
      location: 'A-1F-001',
      reason: REQUEST.reason,
      appliedAt: '2026-07-12T10:00:00.000Z',
      approvers: [{ openId: 'ou_warehouse_responsible', name: 'A楼示例人员019' }],
      managerRecipients: [
        { openId: 'ou_warehouse_manager', name: 'A楼管理人' },
      ],
    });
    expect(managementService.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it('does not create an outbound record when the inventory ledger has no location', async () => {
    recordsByTable[TABLES.inventory][0].fields.入库存放位置 = '';
    const service = createService();

    await expect(service.createPending(REQUEST, ADMIN)).rejects.toThrow(
      '当前楼栋库存台账缺少存放位置，请先配置库位',
    );

    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(approvalService.registerPending).not.toHaveBeenCalled();
  });

  it('recovers an existing routing record after its inventory location is configured', async () => {
    const service = createService();
    const created = await service.createPending(REQUEST, ADMIN);
    recordsByTable[TABLES.inventory][0].fields.入库存放位置 = '';
    approvalService.registerPending.mockImplementation(async (snapshot) => {
      if (!snapshot.location.trim()) {
        throw new BadRequestException('存放位置无效');
      }
    });

    await expect(
      service.recoverUnregisteredOutbound(created.recordId),
    ).rejects.toThrow('存放位置无效');
    expect(approvalGateway.writeWorkflowError).toHaveBeenCalledWith(
      created.recordId,
      expect.stringMatching(/库存台账.*存放位置.*原编号.*自动恢复/u),
    );

    recordsByTable[TABLES.inventory][0].fields.入库存放位置 = 'A-1F-002';
    await expect(
      service.recoverUnregisteredOutbound(created.recordId),
    ).resolves.toBeUndefined();

    expect(approvalService.registerPending).toHaveBeenLastCalledWith(
      expect.objectContaining({
        recordId: created.recordId,
        outboundNumber: REQUEST.clientMutationId,
        location: 'A-1F-002',
      }),
    );
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
  });

  it('rejects creation when Base drops the routing workflow status', async () => {
    gateway.createRecord.mockImplementationOnce(
      async (
        _appToken: string,
        tableId: string,
        fields: Record<string, unknown>,
      ) => {
        const { 出库工作流状态: _droppedStatus, ...persistedFields } = fields;
        return persistRecord(tableId, persistedFields);
      },
    );
    const service = createService();

    await expect(service.createPending(REQUEST, ADMIN)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(gateway.createRecord).toHaveBeenCalledWith(
      'app-token',
      TABLES.outbound,
      expect.objectContaining({ 出库工作流状态: '待路由' }),
      '出库填写',
    );
  });

  it('writes an actionable workflow error and preserves the original record when no approver can be resolved', async () => {
    warehouseRoleDirectory.resolveApprovers.mockRejectedValueOnce(
      new Error('A楼未配置有效的库房示例人员019员'),
    );
    const service = createService();

    await expect(service.createPending(REQUEST, ADMIN)).rejects.toThrow(
      /A楼未配置有效的库房示例人员019员/u,
    );

    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(approvalService.registerPending).not.toHaveBeenCalled();
    expect(approvalGateway.writeWorkflowError).toHaveBeenCalledWith(
      'outbound-record-1',
      expect.stringMatching(/A楼.*库房示例人员019员.*原编号/u),
    );
    expect(recordsByTable[TABLES.outbound]).toHaveLength(1);
    expect(recordsByTable[TABLES.outbound][0].fields['出库创建标识']).toBe(
      REQUEST.clientMutationId,
    );
  });

  it('registers a new approval and returns waiting approval when warehouse manager notification recipients are empty', async () => {
    warehouseRoleDirectory.resolveNotificationRecipients.mockResolvedValueOnce(
      [],
    );
    const service = createService();

    await expect(service.createPending(REQUEST, ADMIN)).resolves.toMatchObject({
      success: true,
      movement: { status: '待审批' },
    });

    expect(approvalService.registerPending).toHaveBeenCalledWith(
      expect.objectContaining({
        approvers: [{ openId: 'ou_warehouse_responsible', name: 'A楼示例人员019' }],
        managerRecipients: [],
      }),
    );
    expect(approvalGateway.writeWorkflowError).not.toHaveBeenCalled();
  });

  it.each([
    ['link_record_ids', { link_record_ids: [REQUEST.catalogRecordId] }],
    ['record_ids', { record_ids: [REQUEST.catalogRecordId] }],
  ])(
    'accepts the Feishu real link readback shape: %s',
    async (_label, linkValue) => {
      gateway.getRecord.mockImplementation(
        async (appToken: string, tableId: string, recordId: string) => {
          const record = await readRecord(appToken, tableId, recordId);
          if (tableId === TABLES.outbound) {
            record.fields['物品类别号'] = [linkValue];
          }
          return record;
        },
      );
      const service = createService();

      const result = await service.createPending(REQUEST, ADMIN);

      expect(result).toMatchObject({
        success: true,
        alreadyProcessed: false,
        movement: {
          recordId: 'outbound-record-1',
          quantity: REQUEST.quantity,
          status: '待审批',
        },
      });
      expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a Feishu link readback that contains multiple catalog records', async () => {
    gateway.getRecord.mockImplementation(
      async (appToken: string, tableId: string, recordId: string) => {
        const record = await readRecord(appToken, tableId, recordId);
        if (tableId === TABLES.outbound) {
          record.fields['物品类别号'] = [
            {
              link_record_ids: [REQUEST.catalogRecordId, 'catalog-other'],
            },
          ];
        }
        return record;
      },
    );
    const service = createService();

    await expect(service.createPending(REQUEST, ADMIN)).rejects.toThrow(
      '出库物品关联与请求不一致',
    );
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
  });

  it('coordinates confirmation with deletion for the same outbound record', async () => {
    const operationCoordinator = {
      run: jest.fn(
        (_resourceKeys: readonly string[], operation: () => Promise<unknown>) =>
          operation(),
      ),
    };
    const service = createService(operationCoordinator);
    const created = await service.createPending(REQUEST, ADMIN);
    approveForWarehouseConfirmation(created.recordId);

    await service.confirm(
      created.recordId,
      { clientMutationId: 'outbound-confirm-coordinated' },
      ADMIN,
    );

    expect(operationCoordinator.run).toHaveBeenCalledWith(
      [`movement:outbound:${created.recordId}`],
      expect.any(Function),
    );
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['array', []],
    ['primitive', 42],
    ['non-string mutation id', { ...REQUEST, clientMutationId: [] }],
    ['non-numeric quantity', { ...REQUEST, quantity: '2' }],
    ['non-string reason', { ...REQUEST, reason: {} }],
    ['date-only occurred at', { ...REQUEST, occurredAt: '2026-07-12' }],
  ])(
    'rejects an invalid direct create payload: %s',
    async (_label, payload) => {
      const service = createService();

      await expect(
        service.createPending(
          payload as InventoryOutboundMovementCreateRequest,
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(gateway.createRecord).not.toHaveBeenCalled();
    },
  );

  it('uses the Feishu person id instead of the display name for durable verification', async () => {
    gateway.getRecord.mockImplementation(
      async (appToken: string, tableId: string, recordId: string) => {
        const record = await readRecord(appToken, tableId, recordId);
        if (tableId === TABLES.outbound) {
          record.fields['物品申请人'] = [
            { id: REQUEST.applicantOpenId, name: '申请人姓名' },
          ];
        }
        return record;
      },
    );
    const service = createService();

    const created = await service.createPending(REQUEST, ADMIN);
    approveForWarehouseConfirmation(created.recordId);
    const confirmed = await service.confirm(
      created.recordId,
      { clientMutationId: 'outbound-confirm-person-shape' },
      ADMIN,
    );

    expect(confirmed.movement.status).toBe('已出库');
  });

  it('rejects creation when the fresh targeted stock is insufficient', async () => {
    recordsByTable[TABLES.inventory][0].fields['剩余库存'] = 1;
    (fetchBitableRecords as jest.Mock).mockRejectedValue(
      new Error('full-table reads are forbidden for outbound CRUD'),
    );
    const service = createService();

    await expect(service.createPending(REQUEST, ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(fetchBitableRecords).not.toHaveBeenCalled();
    expect(gateway.getRecord).toHaveBeenCalledWith(
      'app-token',
      TABLES.catalog,
      REQUEST.catalogRecordId,
      '物品类别',
    );
    expect(gateway.listRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        tableId: TABLES.inventory,
        searchFilter: {
          conjunction: 'and',
          conditions: [{ field_name: '楼栋', operator: 'is', value: ['A楼'] }],
        },
      }),
    );
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('rejects creation without persisting when the same building and sku have duplicate inventory rows', async () => {
    recordsByTable[TABLES.inventory].push({
      record_id: 'inventory-a101-duplicate',
      fields: {
        ...recordsByTable[TABLES.inventory][0].fields,
        入库存放位置: 'A-1F-002',
        剩余库存: 36,
      },
    });
    const service = createService();

    await expect(service.createPending(REQUEST, ADMIN)).rejects.toThrow(
      /重复库存台账/u,
    );

    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(approvalService.registerPending).not.toHaveBeenCalled();
    expect(recordsByTable[TABLES.outbound]).toHaveLength(0);
  });

  it('returns the persisted result for the same mutation and fingerprint', async () => {
    const service = createService();
    const first = await service.createPending(REQUEST, ADMIN);
    managementService.invalidateCache.mockClear();

    const retry = await service.createPending({ ...REQUEST }, ADMIN);

    expect(retry).toMatchObject({
      recordId: first.recordId,
      alreadyProcessed: true,
      movement: { recordId: first.recordId, status: '待审批' },
    });
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(approvalService.registerPending).toHaveBeenCalledTimes(2);
    expect(managementService.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it('keeps formal quantity empty while idempotently re-registering a pending approval', async () => {
    const service = createService();
    const created = await service.createPending(REQUEST, ADMIN);
    managementService.invalidateCache.mockClear();
    gateway.updateRecord.mockClear();

    const retry = await service.createPending({ ...REQUEST }, ADMIN);

    expect(retry).toMatchObject({
      recordId: created.recordId,
      alreadyProcessed: true,
      movement: { status: '待审批' },
    });
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(recordsByTable[TABLES.outbound][0].fields).not.toHaveProperty(
      '出库数量',
    );
    expect(approvalService.registerPending).toHaveBeenCalledTimes(2);
    expect(managementService.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it.each<[string, (fields: Record<string, unknown>) => void]>([
    ['program quantity changed', (fields) => (fields['程序出库申请数量'] = 3)],
    ['formal quantity changed', (fields) => (fields['出库数量'] = 3)],
    ['program time missing', (fields) => delete fields['程序出库申请时间']],
    ['building changed', (fields) => (fields['楼栋'] = 'B楼')],
    [
      'catalog relation changed',
      (fields) => (fields['物品类别号'] = ['catalog-other']),
    ],
    [
      'program status polluted',
      (fields) => (fields['程序出库状态'] = '处理中'),
    ],
    ['program status missing', (fields) => delete fields['程序出库状态']],
    [
      'applicant changed',
      (fields) => (fields['物品申请人'] = [{ id: 'ou_other' }]),
    ],
    [
      'reason changed',
      (fields) => (fields['出库原因/出库后使用地点'] = '其它用途'),
    ],
  ])(
    'rejects idempotent recovery when an immutable field is corrupted: %s',
    async (_label, corrupt) => {
      const service = createService();
      await service.createPending(REQUEST, ADMIN);
      corrupt(recordsByTable[TABLES.outbound][0].fields);

      await expect(
        service.createPending(REQUEST, ADMIN),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    },
  );

  it('recovers an already-confirmed row for the same create marker and fingerprint', async () => {
    const service = createService();
    const created = await service.createPending(REQUEST, ADMIN);
    approveForWarehouseConfirmation(created.recordId);
    await service.confirm(
      created.recordId,
      { clientMutationId: 'outbound-confirm-1' },
      ADMIN,
    );
    managementService.invalidateCache.mockClear();

    const retry = await service.createPending(REQUEST, ADMIN);

    expect(retry).toMatchObject({
      recordId: created.recordId,
      alreadyProcessed: true,
      movement: { status: '已出库', quantity: 2 },
    });
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(approvalService.registerPending).toHaveBeenCalledTimes(1);
    expect(managementService.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it.each<[string, (fields: Record<string, unknown>) => void]>([
    ['formal quantity differs', (fields) => (fields['出库数量'] = 3)],
    [
      'formal time differs',
      (fields) => (fields['出库时间'] = Date.parse('2026-07-12T10:01:00.000Z')),
    ],
  ])(
    'rejects confirmed create recovery when formal data differs from the application: %s',
    async (_label, corrupt) => {
      const service = createService();
      const created = await service.createPending(REQUEST, ADMIN);
      approveForWarehouseConfirmation(created.recordId);
      await service.confirm(
        created.recordId,
        { clientMutationId: 'outbound-confirm-1' },
        ADMIN,
      );
      corrupt(recordsByTable[TABLES.outbound][0].fields);
      managementService.invalidateCache.mockClear();

      await expect(
        service.createPending(REQUEST, ADMIN),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(managementService.invalidateCache).not.toHaveBeenCalled();
    },
  );

  it('rejects reuse of a mutation marker with different business data', async () => {
    const service = createService();
    await service.createPending(REQUEST, ADMIN);

    await expect(
      service.createPending({ ...REQUEST, quantity: 3 }, ADMIN),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent creates for the same building and sku', async () => {
    let activeCreates = 0;
    let maximumActiveCreates = 0;
    gateway.createRecord.mockImplementation(
      async (
        _appToken: string,
        tableId: string,
        fields: Record<string, unknown>,
      ) => {
        activeCreates += 1;
        maximumActiveCreates = Math.max(maximumActiveCreates, activeCreates);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const recordId = persistRecord(tableId, fields);
        activeCreates -= 1;
        return recordId;
      },
    );
    const service = createService();

    await Promise.all([
      service.createPending(REQUEST, ADMIN),
      service.createPending(
        { ...REQUEST, clientMutationId: 'outbound-create-2' },
        ADMIN,
      ),
    ]);

    expect(maximumActiveCreates).toBe(1);
    expect(gateway.createRecord).toHaveBeenCalledTimes(2);
  });

  it('serializes same-sku confirmations so the second sees the latest inventory', async () => {
    const service = createService();
    const [first, second] = await Promise.all([
      service.createPending(
        { ...REQUEST, quantity: 4, clientMutationId: 'outbound-create-1' },
        ADMIN,
      ),
      service.createPending(
        { ...REQUEST, quantity: 4, clientMutationId: 'outbound-create-2' },
        ADMIN,
      ),
    ]);
    approveForWarehouseConfirmation(first.recordId);
    approveForWarehouseConfirmation(second.recordId);
    gateway.updateRecord.mockImplementation(
      async (
        appToken: string,
        tableId: string,
        recordId: string,
        fields: Record<string, unknown>,
      ) => {
        await applyUpdate(appToken, tableId, recordId, fields);
        const quantity = Number(fields['出库数量']);
        if (Number.isFinite(quantity)) {
          const inventoryFields = recordsByTable[TABLES.inventory][0].fields;
          inventoryFields['剩余库存'] =
            Number(inventoryFields['剩余库存']) - quantity;
        }
      },
    );

    const results = await Promise.allSettled([
      service.confirm(
        first.recordId,
        { clientMutationId: 'outbound-confirm-1' },
        ADMIN,
      ),
      service.confirm(
        second.recordId,
        { clientMutationId: 'outbound-confirm-2' },
        ADMIN,
      ),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(ConflictException);
    expect(gateway.updateRecord).toHaveBeenCalledTimes(1);
  });

  it('confirms a pending record using authoritative stock and verifies the write', async () => {
    const service = createService();
    const created = await service.createPending(REQUEST, ADMIN);
    approveForWarehouseConfirmation(created.recordId);
    gateway.updateRecord.mockClear();
    managementService.invalidateCache.mockClear();

    const result = await service.confirm(
      created.recordId,
      { clientMutationId: 'outbound-confirm-1' },
      BUILDING_A_ADMIN,
    );

    expect(gateway.updateRecord).toHaveBeenCalledWith(
      'app-token',
      TABLES.outbound,
      created.recordId,
      {
        出库数量: 2,
        出库时间: Date.parse('2026-07-12T10:00:00.000Z'),
        程序出库状态: '已出库',
        出库确认标识: 'outbound-confirm-1',
      },
      '出库填写',
    );
    expect(result).toMatchObject({
      success: true,
      recordId: created.recordId,
      alreadyConfirmed: false,
      movement: {
        quantity: 2,
        status: '已出库',
        occurredAt: '2026-07-12T10:00:00.000Z',
      },
    });
    expect(managementService.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it('finalizes an approved card with its event id and cannot be confirmed twice', async () => {
    const service = createService();
    const created = await service.createPending(REQUEST, ADMIN);
    const snapshot = approvalService.registerPending.mock.calls[0][0];
    const decision = {
      action: 'approve' as const,
      actorOpenId: 'ou_warehouse_responsible',
      actorName: 'A楼示例人员019',
      messageId: 'om_approval_card',
      eventId: 'evt_approval_once',
      decidedAt: '2026-07-12T10:05:00.000Z',
      reason: '',
    };
    const record = recordsByTable[TABLES.outbound][0];
    Object.assign(record.fields, {
      程序出库状态: '待库房确认',
      出库工作流状态: '已通过',
      出库当前审批人: [],
      出库实际审批人: [{ id: decision.actorOpenId, name: decision.actorName }],
      出库审批时间: Date.parse(decision.decidedAt),
      出库审批策略版本: snapshot.policyVersion,
      出库审批动作标识: decision.eventId,
      出库审批快照: JSON.stringify({ schemaVersion: 2, snapshot }),
    });
    gateway.updateRecord.mockClear();

    await expect(
      service.confirm(
        created.recordId,
        { clientMutationId: 'manual-racing-confirmation' },
        BUILDING_A_ADMIN,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(gateway.updateRecord).not.toHaveBeenCalled();

    await service.finalizeApprovedOutbound(snapshot, decision);

    expect(gateway.updateRecord).toHaveBeenCalledWith(
      'app-token',
      TABLES.outbound,
      created.recordId,
      expect.objectContaining({
        出库数量: REQUEST.quantity,
        出库时间: Date.parse(REQUEST.occurredAt),
        程序出库状态: '已出库',
        出库确认标识: decision.eventId,
        出库实际审批人: [
          { id: decision.actorOpenId, name: decision.actorName },
        ],
        出库审批时间: Date.parse(decision.decidedAt),
      }),
      '出库填写',
    );
    gateway.updateRecord.mockClear();

    await expect(
      service.finalizeApprovedOutbound(snapshot, decision),
    ).resolves.toBeUndefined();
    await expect(
      service.confirm(
        created.recordId,
        { clientMutationId: 'manual-second-confirmation' },
        BUILDING_A_ADMIN,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it('does not forward-complete an unbound historical approval decision', async () => {
    const service = createService();
    const created = await service.createPending(REQUEST, ADMIN);
    const snapshot = approvalService.registerPending.mock.calls[0][0];
    const decision = {
      action: 'approve' as const,
      actorOpenId: 'ou_warehouse_manager',
      actorName: '旧审批人',
      messageId: 'om_historical_approval',
      eventId: 'evt_historical_approval',
      decidedAt: '2026-07-12T10:05:00.000Z',
      reason: '',
    };
    Object.assign(recordsByTable[TABLES.outbound][0].fields, {
      程序出库状态: '待库房确认',
      出库工作流状态: '已通过',
      出库当前审批人: [],
      出库实际审批人: [{ id: decision.actorOpenId }],
      出库审批时间: Date.parse(decision.decidedAt),
      出库审批策略版本: snapshot.policyVersion,
      出库审批动作标识: decision.eventId,
      出库审批快照: JSON.stringify({ schemaVersion: 1, snapshot }),
    });
    warehouseRoleDirectory.resolveApprovers.mockResolvedValueOnce([
      { openId: 'ou_current_responsible', name: '当前示例人员019' },
    ]);
    gateway.updateRecord.mockClear();

    await expect(
      service.finalizeApprovedOutbound(snapshot, decision),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(recordsByTable[TABLES.outbound][0].fields).toMatchObject({
      程序出库状态: '待库房确认',
      出库工作流状态: '已通过',
    });
    expect(recordsByTable[TABLES.outbound][0].fields).not.toHaveProperty(
      '出库确认标识',
    );
  });

  it('writes formal quantity only after approval and warehouse confirmation', async () => {
    const service = createService();
    const created = await service.createPending(REQUEST, ADMIN);
    approveForWarehouseConfirmation(created.recordId);
    gateway.updateRecord.mockClear();

    const result = await service.confirm(
      created.recordId,
      { clientMutationId: 'outbound-confirm-pre-backfill' },
      BUILDING_A_ADMIN,
    );

    expect(gateway.updateRecord).toHaveBeenCalledWith(
      'app-token',
      TABLES.outbound,
      created.recordId,
      expect.objectContaining({
        出库数量: REQUEST.quantity,
        程序出库状态: '已出库',
      }),
      '出库填写',
    );
    expect(result.movement).toMatchObject({
      quantity: REQUEST.quantity,
      status: '已出库',
    });
  });

  it.each<[string, (fields: Record<string, unknown>) => void]>([
    [
      'program quantity',
      (fields) => {
        fields['程序出库申请数量'] = 3;
      },
    ],
    [
      'program time',
      (fields) => {
        fields['程序出库申请时间'] = '2026-07-12T10:01:00.000Z';
      },
    ],
    [
      'applicant id',
      (fields) => {
        fields['物品申请人'] = [{ id: 'ou_other', name: '其他申请人' }];
      },
    ],
    [
      'reason',
      (fields) => {
        fields['出库原因/出库后使用地点'] = '其它用途';
      },
    ],
    [
      'source building',
      (fields) => {
        recordsByTable[TABLES.catalog][0].fields['楼栋'] = 'B楼';
        recordsByTable[TABLES.inventory].push({
          record_id: 'inventory-b101',
          fields: {
            物品类别号: 'A101',
            楼栋: 'B楼',
            入库存放位置: 'B-1F-001',
            剩余库存: 5,
          },
        });
        fields['楼栋'] = 'B楼';
      },
    ],
    [
      'catalog and sku',
      (fields) => {
        recordsByTable[TABLES.catalog].push({
          record_id: 'catalog-a102',
          fields: { ...CATALOG.fields, 物品类别号: 'A102' },
        });
        recordsByTable[TABLES.inventory].push({
          record_id: 'inventory-a102',
          fields: {
            物品类别号: 'A102',
            楼栋: 'A楼',
            入库存放位置: 'A-1F-002',
            剩余库存: 5,
          },
        });
        fields['物品类别号'] = ['catalog-a102'];
      },
    ],
  ])(
    'rejects first confirmation when persisted %s no longer matches the request fingerprint',
    async (_label, corrupt) => {
      const service = createService();
      const created = await service.createPending(REQUEST, ADMIN);
      approveForWarehouseConfirmation(created.recordId);
      corrupt(recordsByTable[TABLES.outbound][0].fields);
      gateway.updateRecord.mockClear();

      await expect(
        service.confirm(
          created.recordId,
          { clientMutationId: 'outbound-confirm-tampered' },
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(gateway.updateRecord).not.toHaveBeenCalled();
    },
  );

  it('rejects confirmation with 409 when realtime stock fell below the requested quantity', async () => {
    const service = createService();
    const created = await service.createPending(REQUEST, ADMIN);
    approveForWarehouseConfirmation(created.recordId);
    recordsByTable[TABLES.inventory][0].fields['剩余库存'] = 1;
    gateway.updateRecord.mockClear();

    await expect(
      service.confirm(
        created.recordId,
        { clientMutationId: 'outbound-confirm-1' },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it('rejects confirmation without updating either record when duplicate inventory rows appear after creation', async () => {
    const service = createService();
    const created = await service.createPending(REQUEST, ADMIN);
    approveForWarehouseConfirmation(created.recordId);
    recordsByTable[TABLES.inventory].push({
      record_id: 'inventory-a101-duplicate',
      fields: {
        ...recordsByTable[TABLES.inventory][0].fields,
        入库存放位置: 'A-1F-002',
        剩余库存: 36,
      },
    });
    gateway.updateRecord.mockClear();

    await expect(
      service.confirm(
        created.recordId,
        { clientMutationId: 'outbound-confirm-duplicate-inventory' },
        ADMIN,
      ),
    ).rejects.toThrow(/重复库存台账/u);

    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(recordsByTable[TABLES.inventory]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record_id: 'inventory-a101',
          fields: expect.objectContaining({ 剩余库存: 5 }),
        }),
        expect.objectContaining({
          record_id: 'inventory-a101-duplicate',
          fields: expect.objectContaining({ 剩余库存: 36 }),
        }),
      ]),
    );
    expect(recordsByTable[TABLES.outbound][0].fields).toEqual(
      expect.objectContaining({
        程序出库状态: '待库房确认',
        出库工作流状态: '已通过',
      }),
    );
    expect(recordsByTable[TABLES.outbound][0].fields).not.toHaveProperty(
      '出库数量',
    );
    expect(recordsByTable[TABLES.outbound][0].fields).not.toHaveProperty(
      '出库确认标识',
    );
  });

  it('returns alreadyConfirmed for the same confirmation marker without rewriting', async () => {
    const service = createService();
    const created = await service.createPending(REQUEST, ADMIN);
    approveForWarehouseConfirmation(created.recordId);
    await service.confirm(
      created.recordId,
      { clientMutationId: 'outbound-confirm-1' },
      ADMIN,
    );
    gateway.updateRecord.mockClear();
    managementService.invalidateCache.mockClear();

    const retry = await service.confirm(
      created.recordId,
      { clientMutationId: 'outbound-confirm-1' },
      ADMIN,
    );

    expect(retry.alreadyConfirmed).toBe(true);
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(managementService.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it.each<[string, (fields: Record<string, unknown>) => void]>([
    ['formal quantity differs', (fields) => (fields['出库数量'] = 3)],
    [
      'formal time differs',
      (fields) => (fields['出库时间'] = Date.parse('2026-07-12T10:01:00.000Z')),
    ],
    [
      'application quantity is missing',
      (fields) => delete fields['程序出库申请数量'],
    ],
    [
      'application time is missing',
      (fields) => delete fields['程序出库申请时间'],
    ],
    [
      'applicant changed',
      (fields) => (fields['物品申请人'] = [{ id: 'ou_other' }]),
    ],
    [
      'reason changed',
      (fields) => (fields['出库原因/出库后使用地点'] = '其它用途'),
    ],
  ])(
    'rejects confirmed idempotent recovery when persisted data is corrupted: %s',
    async (_label, corrupt) => {
      const service = createService();
      const created = await service.createPending(REQUEST, ADMIN);
      approveForWarehouseConfirmation(created.recordId);
      await service.confirm(
        created.recordId,
        { clientMutationId: 'outbound-confirm-1' },
        ADMIN,
      );
      corrupt(recordsByTable[TABLES.outbound][0].fields);
      gateway.updateRecord.mockClear();
      managementService.invalidateCache.mockClear();

      await expect(
        service.confirm(
          created.recordId,
          { clientMutationId: 'outbound-confirm-1' },
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(gateway.updateRecord).not.toHaveBeenCalled();
      expect(managementService.invalidateCache).not.toHaveBeenCalled();
    },
  );

  it('rejects a non-legacy confirmed row when all program application fields are missing', async () => {
    const service = createService();
    const created = await service.createPending(REQUEST, ADMIN);
    approveForWarehouseConfirmation(created.recordId);
    await service.confirm(
      created.recordId,
      { clientMutationId: 'outbound-confirm-1' },
      ADMIN,
    );
    for (const fieldName of [
      '出库创建标识',
      '出库请求指纹',
      '程序出库申请数量',
      '程序出库申请时间',
    ]) {
      delete recordsByTable[TABLES.outbound][0].fields[fieldName];
    }
    gateway.updateRecord.mockClear();
    managementService.invalidateCache.mockClear();

    await expect(
      service.confirm(
        created.recordId,
        { clientMutationId: 'outbound-confirm-1' },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(managementService.invalidateCache).not.toHaveBeenCalled();
  });

  it('does not fall back to pending fields when a program-confirmed row lost formal fields', async () => {
    const service = createService();
    const created = await service.createPending(REQUEST, ADMIN);
    approveForWarehouseConfirmation(created.recordId);
    await service.confirm(
      created.recordId,
      { clientMutationId: 'outbound-confirm-1' },
      ADMIN,
    );
    delete recordsByTable[TABLES.outbound][0].fields['出库数量'];
    delete recordsByTable[TABLES.outbound][0].fields['出库时间'];
    gateway.updateRecord.mockClear();

    await expect(
      service.confirm(
        created.recordId,
        { clientMutationId: 'outbound-confirm-1' },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it('rejects a different confirmation marker after confirmation', async () => {
    const service = createService();
    const created = await service.createPending(REQUEST, ADMIN);
    approveForWarehouseConfirmation(created.recordId);
    await service.confirm(
      created.recordId,
      { clientMutationId: 'outbound-confirm-1' },
      ADMIN,
    );
    gateway.updateRecord.mockClear();

    await expect(
      service.confirm(
        created.recordId,
        { clientMutationId: 'outbound-confirm-2' },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it.each<[string, AccessPrincipal | undefined]>([
    ['missing principal', undefined],
    ['editor', EDITOR],
  ])(
    'rejects an unauthorized confirmer before reading or ensuring: %s',
    async (_label, principal) => {
      const service = createService();
      const created = await service.createPending(REQUEST, ADMIN);
      gateway.getRecord.mockClear();
      gateway.ensureTextField.mockClear();
      gateway.ensureNumberField.mockClear();
      gateway.updateRecord.mockClear();

      await expect(
        service.confirm(
          created.recordId,
          { clientMutationId: 'outbound-confirm-1' },
          principal as AccessPrincipal,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(gateway.getRecord).not.toHaveBeenCalled();
      expect(gateway.ensureTextField).not.toHaveBeenCalled();
      expect(gateway.ensureNumberField).not.toHaveBeenCalled();
      expect(gateway.updateRecord).not.toHaveBeenCalled();
    },
  );

  it('rejects a cross-building confirmer before any write', async () => {
    const service = createService();
    const created = await service.createPending(REQUEST, ADMIN);
    gateway.ensureTextField.mockClear();
    gateway.ensureNumberField.mockClear();
    gateway.updateRecord.mockClear();

    await expect(
      service.confirm(
        created.recordId,
        { clientMutationId: 'outbound-confirm-1' },
        BUILDING_B_ADMIN,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(gateway.ensureTextField).not.toHaveBeenCalled();
    expect(gateway.ensureNumberField).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it('does not ensure fields when the authoritative record does not exist', async () => {
    const service = createService();

    await expect(
      service.confirm(
        'missing-outbound-record',
        { clientMutationId: 'outbound-confirm-1' },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(gateway.ensureTextField).not.toHaveBeenCalled();
    expect(gateway.ensureNumberField).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it('returns 409 when an outbound row references a missing catalog record', async () => {
    recordsByTable[TABLES.outbound].push({
      record_id: 'outbound-missing-catalog',
      fields: {
        物品类别号: ['catalog-missing'],
        楼栋: 'A楼',
      },
    });
    const service = createService();

    await expect(
      service.confirm(
        'outbound-missing-catalog',
        { clientMutationId: 'outbound-confirm-missing-catalog' },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it('returns 409 when a program outbound row is in an illegal state', async () => {
    const service = createService();
    const created = await service.createPending(REQUEST, ADMIN);
    recordsByTable[TABLES.outbound][0].fields['程序出库状态'] = '处理中';
    gateway.updateRecord.mockClear();

    await expect(
      service.confirm(
        created.recordId,
        { clientMutationId: 'outbound-confirm-invalid-state' },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it.each([
    ['待审批', '待路由'],
    ['待审批', '待审批'],
    ['已驳回', '已驳回'],
    ['待库房确认', '同步异常'],
  ])(
    'rejects warehouse confirmation before approval for program=%s workflow=%s',
    async (programStatus, workflowStatus) => {
      const service = createService();
      const created = await service.createPending(REQUEST, ADMIN);
      Object.assign(recordsByTable[TABLES.outbound][0].fields, {
        程序出库状态: programStatus,
        出库工作流状态: workflowStatus,
      });
      gateway.updateRecord.mockClear();

      await expect(
        service.confirm(
          created.recordId,
          { clientMutationId: `confirm-${programStatus}-${workflowStatus}` },
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(gateway.updateRecord).not.toHaveBeenCalled();
    },
  );

  it.each<[string, Record<string, unknown>]>([
    ['building', { 楼栋: 'B楼' }],
    ['sku', { 物品类别号: 'A102' }],
  ])(
    'rejects when the locked reread changes the authoritative %s',
    async (_label, drift) => {
      const service = createService();
      const created = await service.createPending(REQUEST, ADMIN);
      approveForWarehouseConfirmation(created.recordId);
      let outboundReads = 0;
      gateway.ensureTextField.mockClear();
      gateway.ensureNumberField.mockClear();
      gateway.updateRecord.mockClear();
      gateway.getRecord.mockImplementation(
        async (appToken: string, tableId: string, recordId: string) => {
          const record = await readRecord(appToken, tableId, recordId);
          if (tableId === TABLES.outbound && recordId === created.recordId) {
            outboundReads += 1;
            if (outboundReads === 2) {
              record.fields = { ...record.fields, ...drift };
            }
          }
          return record;
        },
      );

      await expect(
        service.confirm(
          created.recordId,
          { clientMutationId: 'outbound-confirm-1' },
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(gateway.ensureTextField).not.toHaveBeenCalled();
      expect(gateway.ensureNumberField).not.toHaveBeenCalled();
      expect(gateway.updateRecord).not.toHaveBeenCalled();
    },
  );

  it('confirms a legacy cross-building pending row without rewriting formal quantity or time', async () => {
    const formalTime = Date.parse('2026-07-01T08:00:00.000Z');
    recordsByTable[TABLES.outbound].push({
      record_id: 'legacy-outbound-1',
      fields: {
        物品类别号: ['catalog-a101'],
        物品申请人: [{ id: 'ou_applicant' }],
        出库数量: 4,
        楼栋: 'A楼',
        出库时间: formalTime,
        '出库原因/出库后使用地点': '旧跨楼流程',
        是否借出本楼栋: '是',
      },
    });
    const service = createService();

    const result = await service.confirm(
      'legacy-outbound-1',
      { clientMutationId: 'legacy-confirm-1' },
      BUILDING_A_ADMIN,
    );

    expect(gateway.updateRecord).toHaveBeenCalledWith(
      'app-token',
      TABLES.outbound,
      'legacy-outbound-1',
      {
        程序出库状态: '已出库',
        出库确认标识: 'legacy-confirm-1',
      },
      '出库填写',
    );
    expect(result.movement).toMatchObject({
      quantity: 4,
      occurredAt: '2026-07-01T08:00:00.000Z',
      status: '已出库',
    });

    gateway.updateRecord.mockClear();
    managementService.invalidateCache.mockClear();
    const retry = await service.confirm(
      'legacy-outbound-1',
      { clientMutationId: 'legacy-confirm-1' },
      BUILDING_A_ADMIN,
    );

    expect(retry.alreadyConfirmed).toBe(true);
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(managementService.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it.each<[string, unknown]>([
    ['出库创建标识', ''],
    ['出库请求指纹', null],
    ['程序出库申请数量', null],
    ['程序出库申请时间', ''],
  ])(
    'rejects a legacy-looking row when the program field is present: %s',
    async (fieldName, fieldValue) => {
      recordsByTable[TABLES.outbound].push({
        record_id: `polluted-legacy-${fieldName}`,
        fields: {
          物品类别号: ['catalog-a101'],
          出库数量: 2,
          楼栋: 'A楼',
          出库时间: Date.parse('2026-07-01T08:00:00.000Z'),
          是否借出本楼栋: '是',
          [fieldName]: fieldValue,
        },
      });
      const service = createService();

      await expect(
        service.confirm(
          `polluted-legacy-${fieldName}`,
          { clientMutationId: 'legacy-confirm-1' },
          BUILDING_A_ADMIN,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(gateway.updateRecord).not.toHaveBeenCalled();
    },
  );

  it('resolves a legacy plain-text sku without treating it as a catalog record id', async () => {
    recordsByTable[TABLES.outbound].push({
      record_id: 'legacy-text-sku-1',
      fields: {
        物品类别号: 'A101',
        出库数量: 1,
        楼栋: 'A楼',
        出库时间: Date.parse('2026-07-01T08:00:00.000Z'),
        是否借出本楼栋: '是',
      },
    });
    const service = createService();

    const result = await service.confirm(
      'legacy-text-sku-1',
      { clientMutationId: 'legacy-text-confirm-1' },
      BUILDING_A_ADMIN,
    );

    expect(result.movement).toMatchObject({ sku: 'A101', status: '已出库' });
    expect(gateway.updateRecord).toHaveBeenCalledTimes(1);
  });

  it('rejects an ordinary legacy completed row as a new confirmation', async () => {
    recordsByTable[TABLES.outbound].push({
      record_id: 'legacy-completed-1',
      fields: {
        物品类别号: ['catalog-a101'],
        出库数量: 2,
        楼栋: 'A楼',
        出库时间: Date.parse('2026-07-01T08:00:00.000Z'),
        是否借出本楼栋: '否',
      },
    });
    const service = createService();

    await expect(
      service.confirm(
        'legacy-completed-1',
        { clientMutationId: 'legacy-confirm-1' },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it('recovers a creation after authoritative readback failed and invalidates cache', async () => {
    let outboundReadbackFailed = false;
    gateway.getRecord.mockImplementation(
      async (appToken: string, tableId: string, recordId: string) => {
        if (tableId === TABLES.outbound && !outboundReadbackFailed) {
          outboundReadbackFailed = true;
          throw new Error('readback failed');
        }
        return readRecord(appToken, tableId, recordId);
      },
    );
    const service = createService();

    await expect(service.createPending(REQUEST, ADMIN)).rejects.toThrow(
      'readback failed',
    );

    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(managementService.invalidateCache).toHaveBeenCalledTimes(1);

    const retry = await service.createPending(REQUEST, ADMIN);

    expect(retry.alreadyProcessed).toBe(true);
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(managementService.invalidateCache).toHaveBeenCalledTimes(2);
  });

  it('recovers the same confirmation id after update succeeded but readback failed', async () => {
    const service = createService();
    const created = await service.createPending(REQUEST, ADMIN);
    approveForWarehouseConfirmation(created.recordId);
    let outboundReads = 0;
    gateway.updateRecord.mockClear();
    managementService.invalidateCache.mockClear();
    gateway.getRecord.mockImplementation(
      async (appToken: string, tableId: string, recordId: string) => {
        if (tableId === TABLES.outbound && recordId === created.recordId) {
          outboundReads += 1;
          if (outboundReads === 3) throw new Error('confirm readback failed');
        }
        return readRecord(appToken, tableId, recordId);
      },
    );

    await expect(
      service.confirm(
        created.recordId,
        { clientMutationId: 'outbound-confirm-1' },
        ADMIN,
      ),
    ).rejects.toThrow('confirm readback failed');
    expect(gateway.updateRecord).toHaveBeenCalledTimes(1);
    expect(managementService.invalidateCache).toHaveBeenCalledTimes(1);

    gateway.getRecord.mockImplementation(readRecord);
    const retry = await service.confirm(
      created.recordId,
      { clientMutationId: 'outbound-confirm-1' },
      ADMIN,
    );

    expect(retry.alreadyConfirmed).toBe(true);
    expect(gateway.updateRecord).toHaveBeenCalledTimes(1);
    expect(managementService.invalidateCache).toHaveBeenCalledTimes(2);
  });

  function createService(operationCoordinator?: {
    run<T>(
      resourceKeys: readonly string[],
      operation: () => Promise<T>,
    ): Promise<T>;
  }): InventoryOutboundWorkflowService {
    const service = new InventoryOutboundWorkflowService(
      { axiosRef: {} } as never,
      gateway as never,
      approvalService as never,
      warehouseRoleDirectory as never,
      approvalGateway as never,
      managementService as never,
      undefined,
      undefined,
      operationCoordinator as never,
    );
    return service;
  }

  function approveForWarehouseConfirmation(recordId: string): void {
    const record = recordsByTable[TABLES.outbound].find(
      (candidate) => candidate.record_id === recordId,
    );
    if (!record) throw new Error(`record ${recordId} not found`);
    Object.assign(record.fields, {
      程序出库状态: '待库房确认',
      出库工作流状态: '已通过',
    });
  }

  function readRecord(
    _appToken: string,
    tableId: string,
    recordId: string,
  ): Promise<TestRecord> {
    const record = (recordsByTable[tableId] || []).find(
      (candidate) => candidate.record_id === recordId,
    );
    return record
      ? Promise.resolve(cloneRecord(record))
      : Promise.reject(
          new InventoryWorkflowRecordNotFoundError(
            tableId === TABLES.outbound ? '出库填写' : '物品类别',
            recordId,
          ),
        );
  }

  async function applyUpdate(
    _appToken: string,
    tableId: string,
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const record = (recordsByTable[tableId] || []).find(
      (candidate) => candidate.record_id === recordId,
    );
    if (!record) throw new Error(`record ${recordId} not found`);
    record.fields = { ...record.fields, ...fields };
  }

  function persistRecord(
    tableId: string,
    fields: Record<string, unknown>,
  ): string {
    const recordId = `outbound-record-${nextOutboundId++}`;
    (recordsByTable[tableId] ||= []).push({
      record_id: recordId,
      fields: { ...fields },
    });
    return recordId;
  }
});

function cloneRecord(record: TestRecord): TestRecord {
  return {
    record_id: record.record_id,
    fields: { ...record.fields },
  };
}

function exactFilterValue(
  filter: string | undefined,
  fieldName: string,
): string | null {
  if (!filter) return null;
  const prefix = `CurrentValue.[${fieldName}]="`;
  if (!filter.startsWith(prefix) || !filter.endsWith('"')) return null;
  return filter
    .slice(prefix.length, -1)
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}
