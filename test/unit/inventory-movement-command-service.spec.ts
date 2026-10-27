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

import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type {
  InventoryMovementCreateRequest,
  InventoryMovementCreateResponse,
  InventoryMovementItem,
  PurchaseInboundNewItemInput,
} from '../../shared/inventory-management.interface';
import {
  fetchBitableRecords,
  resolveBitableAppToken,
} from '../../server/common/feishu/bitable-direct-read';
import { getWarehouseInventoryLocationFieldName } from '../../server/common/config/warehouse-inventory-location.config';
import { InventoryMovementCommandService } from '../../server/modules/inventory-management/inventory-movement-command.service';

const ENV_KEYS = [
  'FEISHU_WAREHOUSE_SOURCE_URL',
  'FEISHU_WAREHOUSE_APP_TOKEN',
  'FEISHU_WAREHOUSE_INVENTORY_TABLE_ID',
  'FEISHU_WAREHOUSE_INVENTORY_LOCATION_FIELD_NAME',
  'FEISHU_WAREHOUSE_INBOUND_TABLE_ID',
  'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID',
  'FEISHU_WAREHOUSE_BORROW_TABLE_ID',
  'FEISHU_WAREHOUSE_CATALOG_TABLE_ID',
] as const;

const TABLES = {
  inventory: 'tbl_inventory',
  inbound: 'tbl_inbound',
  outbound: 'tbl_outbound',
  borrow: 'tbl_borrow',
  catalog: 'tbl_catalog',
};

const CATALOG = {
  record_id: 'catalog-a101',
  fields: {
    物品类别号: 'A101',
    名称: '测试滤芯',
    '规格型号、设备序列号': 'MERV 8',
    品牌: '测试品牌',
    一级分类: '耗材',
    二级分类: '过滤器',
    楼栋: ['A楼'],
    计数单位: ['个'],
  },
};

const INVENTORY = {
  record_id: 'inventory-a101',
  fields: {
    物品类别号: 'A101',
    楼栋: ['A楼'],
    存放位置: ['A-1F-001'],
    剩余库存: '5',
  },
};

const NEW_INBOUND_REQUEST = {
  type: 'inbound',
  mode: 'new',
  clientMutationId: 'manual-new-1',
  building: 'A楼',
  quantity: 3,
  occurredAt: '2026-07-12T10:00:00.000Z',
  catalogRecordId: 'client-catalog-must-be-ignored',
  sku: 'CLIENT-SKU-MUST-BE-IGNORED',
  newItem: {
    primaryCategory: '机房耗材',
    secondaryCategory: '过滤器 A2',
    name: '新风滤芯',
    specification: 'MERV 8',
    location: 'A-1F-001',
  },
} as unknown as InventoryMovementCreateRequest;

interface TestRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('InventoryMovementCommandService', () => {
  const originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  const gateway = {
    createRecord: jest.fn().mockResolvedValue('created-record'),
    updateRecord: jest.fn().mockResolvedValue(undefined),
    ensureNumberField: jest.fn().mockResolvedValue(undefined),
    ensureTextField: jest.fn().mockResolvedValue(undefined),
    getFieldSchemas: jest.fn().mockResolvedValue([]),
    getRecord: jest.fn(),
    listRecords: jest.fn().mockResolvedValue([]),
    searchRecords: jest.fn().mockResolvedValue([]),
  };
  let recordsByTable: Record<string, TestRecord[]>;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FEISHU_WAREHOUSE_SOURCE_URL =
      'https://vnet.feishu.cn/base/QmxAbhXNJaA9YKsbfZyclzhGnSd';
    delete process.env.FEISHU_WAREHOUSE_APP_TOKEN;
    process.env.FEISHU_WAREHOUSE_INVENTORY_TABLE_ID = TABLES.inventory;
    delete process.env.FEISHU_WAREHOUSE_INVENTORY_LOCATION_FIELD_NAME;
    process.env.FEISHU_WAREHOUSE_INBOUND_TABLE_ID = TABLES.inbound;
    process.env.FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID = TABLES.outbound;
    process.env.FEISHU_WAREHOUSE_BORROW_TABLE_ID = TABLES.borrow;
    process.env.FEISHU_WAREHOUSE_CATALOG_TABLE_ID = TABLES.catalog;
    (resolveBitableAppToken as jest.Mock).mockResolvedValue('app-token');
    (fetchBitableRecords as jest.Mock).mockImplementation(
      (_httpService: unknown, options: { tableId: string }) =>
        Promise.resolve(
          options.tableId === TABLES.catalog
            ? [CATALOG]
            : options.tableId === TABLES.inventory
              ? [INVENTORY]
              : [],
        ),
    );
    recordsByTable = {
      [TABLES.catalog]: [{ ...CATALOG, fields: { ...CATALOG.fields } }],
      [TABLES.inventory]: [{ ...INVENTORY, fields: { ...INVENTORY.fields } }],
      [TABLES.inbound]: [],
      [TABLES.outbound]: [],
      [TABLES.borrow]: [],
    };
    gateway.ensureTextField.mockResolvedValue(undefined);
    gateway.ensureNumberField.mockResolvedValue(undefined);
    gateway.getFieldSchemas.mockImplementation(
      async (_appToken: string, tableId: string) =>
        tableId === TABLES.inventory
          ? [
              {
                fieldName: getWarehouseInventoryLocationFieldName(),
                type: 3,
                uiType: 'SingleSelect',
                writable: true,
              },
            ]
          : [],
    );
    gateway.updateRecord.mockResolvedValue(undefined);
    gateway.listRecords.mockImplementation((options: { tableId: string }) =>
      Promise.resolve(
        (recordsByTable[options.tableId] || []).map((record) => ({
          ...record,
          fields: { ...record.fields },
        })),
      ),
    );
    gateway.searchRecords.mockImplementation((options: { tableId: string }) =>
      Promise.resolve(
        (recordsByTable[options.tableId] || []).map((record) => ({
          ...record,
          fields: { ...record.fields },
        })),
      ),
    );
    gateway.getRecord.mockImplementation(
      (_appToken: string, tableId: string, recordId: string) => {
        const record = (recordsByTable[tableId] || []).find(
          (candidate) => candidate.record_id === recordId,
        );
        if (!record) {
          return Promise.reject(
            new Error(`record ${recordId} not found in ${tableId}`),
          );
        }
        return Promise.resolve({
          ...record,
          fields: { ...record.fields },
        });
      },
    );
    gateway.createRecord.mockResolvedValue('created-record');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('returns only searchable items for the selected building with live stock', async () => {
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );

    const result = await service.getOptions({
      type: 'outbound',
      building: 'A楼',
      query: '滤芯',
      limit: 20,
    });

    expect(result).toEqual([
      expect.objectContaining({
        catalogRecordId: 'catalog-a101',
        inventoryRecordId: 'inventory-a101',
        sku: 'A101',
        name: '测试滤芯',
        building: 'A楼',
        availableQuantity: 5,
      }),
    ]);
  });

  it('force-refreshes both catalog and inventory snapshots without changing search semantics', async () => {
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );

    await service.getOptions({
      type: 'outbound',
      building: 'A楼',
      query: 'A101',
      limit: 1_000,
      refresh: true,
    });

    expect(fetchBitableRecords).toHaveBeenCalledTimes(2);
    expect(fetchBitableRecords).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        tableId: TABLES.catalog,
        forceRefresh: true,
        strict: true,
      }),
    );
    expect(fetchBitableRecords).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        tableId: TABLES.inventory,
        forceRefresh: true,
        strict: true,
      }),
    );
  });

  it('delegates a strict outbound request before strict-inbound detection', async () => {
    const delegatedResponse = {
      success: true as const,
      recordId: 'outbound-record-1',
      type: 'outbound' as const,
      alreadyProcessed: false,
      message: '出库申请已提交，待库房确认',
      movement: {} as InventoryMovementItem,
    };
    const outboundService = {
      createPending: jest.fn().mockResolvedValue(delegatedResponse),
    };
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
      undefined,
      outboundService as never,
    );
    const request: InventoryMovementCreateRequest = {
      type: 'outbound',
      clientMutationId: 'outbound-create-1',
      catalogRecordId: 'catalog-a101',
      sku: 'A101',
      building: 'A楼',
      quantity: 2,
      occurredAt: '2026-07-12T10:00:00.000Z',
      applicantOpenId: 'ou_applicant',
      reason: '现场更换',
    };

    const response = await service.createMovement(request);

    expect(outboundService.createPending).toHaveBeenCalledWith(
      request,
      undefined,
    );
    expect(fetchBitableRecords).not.toHaveBeenCalled();
    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(response).toBe(delegatedResponse);
  });

  it('rejects a legacy outbound request without a strict clientMutationId', async () => {
    const outboundService = { createPending: jest.fn() };
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
      undefined,
      outboundService as never,
    );

    await expect(
      service.createMovement({
        type: 'outbound',
        catalogRecordId: 'catalog-a101',
        sku: 'A101',
        building: 'A楼',
        quantity: 2,
        occurredAt: '2026-07-12T10:00:00.000Z',
        applicantOpenId: 'ou_applicant',
        reason: '现场更换',
      } as unknown as InventoryMovementCreateRequest),
    ).rejects.toThrow(new BadRequestException('请求标识不能为空'));

    expect(outboundService.createPending).not.toHaveBeenCalled();
    expect(fetchBitableRecords).not.toHaveBeenCalled();
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['array', []],
    ['primitive', 42],
    ['invalid type field', { type: [], building: 'A楼' }],
    [
      'invalid mutation field',
      {
        type: 'outbound',
        clientMutationId: [],
        building: 'A楼',
      },
    ],
  ])(
    'rejects an invalid runtime movement payload safely: %s',
    async (_label, payload) => {
      const outboundService = { createPending: jest.fn() };
      const service = new InventoryMovementCommandService(
        { axiosRef: {} } as never,
        gateway as never,
        undefined,
        outboundService as never,
      );

      await expect(
        service.createMovement(payload as InventoryMovementCreateRequest),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(outboundService.createPending).not.toHaveBeenCalled();
    },
  );

  it('does not write when the force-refreshed stock is insufficient', async () => {
    (fetchBitableRecords as jest.Mock).mockImplementation(
      (_httpService: unknown, options: { tableId: string }) =>
        Promise.resolve(
          options.tableId === TABLES.catalog
            ? [CATALOG]
            : [{ ...INVENTORY, fields: { ...INVENTORY.fields, 剩余库存: 1 } }],
        ),
    );
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );

    await expect(
      service.createMovement({
        type: 'borrow',
        catalogRecordId: 'catalog-a101',
        sku: 'A101',
        building: 'A楼',
        quantity: 2,
        occurredAt: '2026-07-12T10:00:00.000Z',
        expectedReturnAt: '2026-07-20T10:00:00.000Z',
        applicantOpenId: 'ou_applicant',
        operatorOpenId: 'ou_operator',
        reason: '临时借调',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('prepares a durable purchase catalog record without creating a ledger or inbound row', async () => {
    recordsByTable[TABLES.catalog] = [
      {
        record_id: 'catalog-b-a2007',
        fields: {
          物品类别号: 'A2007',
          名称: 'B楼旧滤芯',
          '规格型号、设备序列号': 'MERV 7',
          一级分类: '机房耗材',
          二级分类: '过滤器 A2',
          楼栋: 'B楼',
        },
      },
    ];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;

    const result = await trusted.prepareTrustedNewInboundCatalog(
      '采购:exec-prepare-1',
      trustedNewRequest('prepare-transport-1'),
      { role: 'admin', purchaseBuilding: null },
    );

    expect(result).toMatchObject({
      catalogRecordId: 'tbl_catalog-record-2',
      sku: 'A2008',
      alreadyPrepared: false,
    });
    expect(recordsByTable[TABLES.catalog]).toHaveLength(2);
    expect(recordsByTable[TABLES.inventory]).toHaveLength(0);
    expect(recordsByTable[TABLES.inbound]).toHaveLength(0);
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(
      gateway.searchRecords.mock.calls.map(([options]) => options),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableId: TABLES.catalog,
          filter: {
            conjunction: 'and',
            conditions: [
              {
                field_name: '入库创建标识',
                operator: 'is',
                value: ['采购:exec-prepare-1'],
              },
            ],
          },
        }),
        expect.objectContaining({
          tableId: TABLES.catalog,
          filter: {
            conjunction: 'and',
            conditions: [
              {
                field_name: '二级分类',
                operator: 'is',
                value: ['过滤器 A2'],
              },
            ],
          },
        }),
      ]),
    );
    expect(gateway.listRecords).not.toHaveBeenCalled();
    expect(recordsByTable[TABLES.catalog][1].fields).toEqual(
      expect.objectContaining({
        物品类别号: 'A2008',
        入库创建标识: '采购:exec-prepare-1',
        入库请求指纹: expect.stringMatching(/^[a-f0-9]{64}$/),
        采购入库准备参数: expect.any(String),
      }),
    );
    expect(
      JSON.parse(
        String(recordsByTable[TABLES.catalog][1].fields.采购入库准备参数),
      ).request.newItem,
    ).toEqual(
      expect.objectContaining({
        location: 'A-1F-002',
        locationRecordId: 'location-a-002',
      }),
    );
  });

  it('starts the prepared-marker and category-number searches concurrently', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const markerRead = createDeferred<TestRecord[]>();
    const categoryRead = createDeferred<TestRecord[]>();
    const startedFields: string[] = [];
    gateway.searchRecords.mockImplementation(
      (options: {
        filter?: { conditions?: Array<{ field_name?: string }> };
      }) => {
        const fieldName = options.filter?.conditions?.[0]?.field_name || '';
        startedFields.push(fieldName);
        return fieldName === '入库创建标识'
          ? markerRead.promise
          : categoryRead.promise;
      },
    );
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;
    const preparation = trusted.prepareTrustedNewInboundCatalog(
      '采购:exec-prepare-parallel-search',
      trustedNewRequest('prepare-parallel-search'),
      { role: 'admin', purchaseBuilding: null },
    );

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(startedFields).toEqual(['二级分类', '入库创建标识']);
    } finally {
      markerRead.resolve([]);
      categoryRead.resolve([
        {
          record_id: 'catalog-a2007',
          fields: {
            物品类别号: 'A2007',
            一级分类: '机房耗材',
            二级分类: '过滤器 A2',
            楼栋: 'A楼',
          },
        },
      ]);
      await preparation;
    }
  });

  it('starts category lookups while field validation is still pending and waits before writing', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const schemaRead = createDeferred<never[]>();
    gateway.getFieldSchemas.mockReturnValue(schemaRead.promise);
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const preparation = service.prepareTrustedNewInboundCatalog(
      '采购:exec-prepare-schema-parallel',
      trustedNewRequest('prepare-schema-parallel'),
    );

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(gateway.getFieldSchemas).toHaveBeenCalled();
      expect(gateway.searchRecords).toHaveBeenCalledTimes(1);
      expect(
        gateway.searchRecords.mock.calls[0]?.[0]?.filter?.conditions?.[0]
          ?.field_name,
      ).toBe('二级分类');
      expect(gateway.createRecord).not.toHaveBeenCalled();
    } finally {
      schemaRead.resolve([]);
      await preparation;
    }
    expect(gateway.searchRecords).toHaveBeenCalledTimes(2);
  });

  it('reuses the same prepared purchase catalog for an identical retry', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;
    const request = trustedNewRequest('prepare-transport-retry');

    const first = await trusted.prepareTrustedNewInboundCatalog(
      '采购:exec-prepare-retry',
      request,
      { role: 'admin', purchaseBuilding: null },
    );
    const retry = await trusted.prepareTrustedNewInboundCatalog(
      '采购:exec-prepare-retry',
      request,
      { role: 'admin', purchaseBuilding: null },
    );

    expect(retry).toEqual({ ...first, alreadyPrepared: true });
    expect(recordsByTable[TABLES.catalog]).toHaveLength(1);
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
  });

  it('keeps the legacy prepared fingerprint and payload shape when no location record id exists', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;
    const request = trustedNewRequest('prepare-legacy-location');
    delete request.newItem.locationRecordId;

    await trusted.prepareTrustedNewInboundCatalog(
      '采购:exec-prepare-legacy-location',
      request,
      { role: 'admin', purchaseBuilding: null },
    );

    const fields = recordsByTable[TABLES.catalog][0].fields;
    const payload = JSON.parse(String(fields.采购入库准备参数));
    expect(payload.request.newItem).not.toHaveProperty('locationRecordId');
    expect(fields.入库请求指纹).toBe(
      createHash('sha256')
        .update(
          JSON.stringify({
            type: 'inbound',
            mode: 'new',
            building: 'A楼',
            quantity: 2,
            occurredAt: '2026-07-12T10:00:00.000Z',
            applicantOpenId: '',
            operatorOpenId: '',
            reason: '',
            destinationBuilding: '',
            expectedReturnAt: '',
            newItem: {
              primaryCategory: '机房耗材',
              secondaryCategory: '过滤器 A2',
              name: '采购滤芯',
              specification: 'MERV 9',
              location: 'A-1F-002',
              brand: '采购品牌',
              unit: '个',
              minimumQuantity: 2,
            },
          }),
          'utf8',
        )
        .digest('hex'),
    );
  });

  it('serializes different prepared purchases in the same secondary category', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;
    const secondRequest = trustedNewRequest('prepare-transport-b');
    secondRequest.newItem = {
      ...secondRequest.newItem,
      name: '采购滤芯二号',
    };

    const [first, second] = await Promise.all([
      trusted.prepareTrustedNewInboundCatalog(
        '采购:exec-prepare-a',
        trustedNewRequest('prepare-transport-a'),
        { role: 'admin', purchaseBuilding: null },
      ),
      trusted.prepareTrustedNewInboundCatalog(
        '采购:exec-prepare-b',
        secondRequest,
        { role: 'admin', purchaseBuilding: null },
      ),
    ]);

    expect([first.sku, second.sku]).toEqual(['A2001', 'A2002']);
    expect(recordsByTable[TABLES.inventory]).toHaveLength(0);
    expect(recordsByTable[TABLES.inbound]).toHaveLength(0);
  });

  it('serializes conflicting preparations for the same purchase source across categories', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;
    const firstRequest = trustedNewRequest('same-source-first');
    const secondRequest = trustedNewRequest('same-source-second');
    secondRequest.newItem = {
      ...secondRequest.newItem,
      secondaryCategory: '传感器 B3',
      name: '采购传感器',
    };

    const results = await Promise.allSettled([
      trusted.prepareTrustedNewInboundCatalog(
        '采购:exec-same-source',
        firstRequest,
        { role: 'admin', purchaseBuilding: null },
      ),
      trusted.prepareTrustedNewInboundCatalog(
        '采购:exec-same-source',
        secondRequest,
        { role: 'admin', purchaseBuilding: null },
      ),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(recordsByTable[TABLES.catalog]).toHaveLength(1);
  });

  it('rejects a purchase new inbound before any write when a prepared catalog is required', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;

    await expect(
      trusted.createTrustedInbound(
        '采购:exec-requires-prepare',
        trustedNewRequest('purchase-requires-prepare'),
        { role: 'admin', purchaseBuilding: null },
        { requirePreparedCatalog: true },
      ),
    ).rejects.toThrow('请先生成新的物品类别号');
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('reuses the prepared purchase catalog when completing the ledger and inbound rows', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    recordsByTable[TABLES.inbound] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;
    const request = trustedNewRequest('purchase-prepared-complete');
    const principal = { role: 'admin', purchaseBuilding: null } as const;
    const sourceKey = '采购:exec-prepared-complete';

    const prepared = await trusted.prepareTrustedNewInboundCatalog(
      sourceKey,
      request,
      principal,
    );
    const completed = await trusted.createTrustedInbound(
      sourceKey,
      request,
      principal,
      {
        requirePreparedCatalog: true,
        expectedCatalogRecordId: prepared.catalogRecordId,
        expectedSku: prepared.sku,
      },
    );

    expect(completed).toMatchObject({
      catalogRecordId: prepared.catalogRecordId,
      alreadyProcessed: false,
    });
    expect(recordsByTable[TABLES.catalog]).toHaveLength(1);
    expect(recordsByTable[TABLES.inventory]).toHaveLength(1);
    expect(recordsByTable[TABLES.inbound]).toHaveLength(1);
    expect(gateway.createRecord.mock.calls.map((call) => call[1])).toEqual([
      TABLES.catalog,
      TABLES.inventory,
      TABLES.inbound,
    ]);
  });

  it('completes a prepared legacy purchase when only the location id and default minimum shape changed', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    recordsByTable[TABLES.inbound] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;
    const principal = { role: 'admin', purchaseBuilding: null } as const;
    const sourceKey = '采购:exec-prepared-legacy-shape';
    const legacyRequest = trustedNewRequest('legacy-transport');
    delete legacyRequest.newItem.locationRecordId;
    delete legacyRequest.newItem.minimumQuantity;
    const prepared = await trusted.prepareTrustedNewInboundCatalog(
      sourceKey,
      legacyRequest,
      principal,
    );
    const legacyFingerprint =
      recordsByTable[TABLES.catalog][0].fields['入库请求指纹'];
    const currentRequest = trustedNewRequest('current-transport');
    currentRequest.newItem.minimumQuantity = 0;

    const completed = await trusted.createTrustedInbound(
      sourceKey,
      currentRequest,
      principal,
      {
        requirePreparedCatalog: true,
        expectedCatalogRecordId: prepared.catalogRecordId,
        expectedSku: prepared.sku,
      },
    );

    expect(completed.catalogRecordId).toBe(prepared.catalogRecordId);
    expect(recordsByTable[TABLES.inventory][0].fields['入库请求指纹']).toBe(
      legacyFingerprint,
    );
    expect(recordsByTable[TABLES.inbound][0].fields['入库请求指纹']).toBe(
      legacyFingerprint,
    );
  });

  it('stops before the next multitable write when the inbound task lease is lost', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    recordsByTable[TABLES.inbound] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;
    const leaseLost = new Error('inbound lease lost');
    const assertOwnership = jest
      .fn<Promise<void>, []>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(leaseLost);

    await expect(
      trusted.createTrustedInbound(
        '采购:exec-lease-takeover',
        trustedNewRequest('lease-takeover'),
        { role: 'admin', purchaseBuilding: null },
        { assertOwnership },
      ),
    ).rejects.toBe(leaseLost);

    expect(assertOwnership).toHaveBeenCalledTimes(3);
    expect(gateway.createRecord.mock.calls.map((call) => call[1])).toEqual([
      TABLES.catalog,
    ]);
    expect(recordsByTable[TABLES.inventory]).toHaveLength(0);
    expect(recordsByTable[TABLES.inbound]).toHaveLength(0);
  });

  it('rejects a legacy prepared marker when its stable location id differs from the current request', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    recordsByTable[TABLES.inbound] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;
    const principal = { role: 'admin', purchaseBuilding: null } as const;
    const sourceKey = '采购:exec-prepared-other-location-id';
    const legacyRequest = trustedNewRequest('legacy-location-id');
    legacyRequest.newItem.locationRecordId = 'location-a-legacy';
    const prepared = await trusted.prepareTrustedNewInboundCatalog(
      sourceKey,
      legacyRequest,
      principal,
    );
    const preparedPayload = JSON.parse(
      String(recordsByTable[TABLES.catalog][0].fields['采购入库准备参数']),
    );
    delete preparedPayload.request.newItem.locationRecordId;
    recordsByTable[TABLES.catalog][0].fields['入库请求指纹'] =
      strictNewInboundFingerprint(preparedPayload.request);
    const currentRequest = trustedNewRequest('current-location-id');
    currentRequest.newItem.locationRecordId = 'location-a-current';

    await expect(
      trusted.createTrustedInbound(sourceKey, currentRequest, principal, {
        requirePreparedCatalog: true,
        expectedCatalogRecordId: prepared.catalogRecordId,
        expectedSku: prepared.sku,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(recordsByTable[TABLES.inventory]).toHaveLength(0);
    expect(recordsByTable[TABLES.inbound]).toHaveLength(0);
  });

  it('creates a strict new inbound in catalog-ledger-inbound order with server-generated identity', async () => {
    recordsByTable[TABLES.catalog] = [
      {
        record_id: 'catalog-b-a2007',
        fields: {
          物品类别号: 'A2007',
          名称: 'B楼旧滤芯',
          '规格型号、设备序列号': 'MERV 7',
          一级分类: '机房耗材',
          二级分类: '过滤器 A2',
          楼栋: 'B楼',
        },
      },
    ];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const managementService = {
      invalidateCache: jest.fn(),
    };
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
      managementService as never,
    );

    const response = await service.createMovement(NEW_INBOUND_REQUEST);

    expect(gateway.createRecord.mock.calls.map((call) => call[1])).toEqual([
      TABLES.catalog,
      TABLES.inventory,
      TABLES.inbound,
    ]);
    expect(gateway.ensureTextField).toHaveBeenCalledWith(
      'app-token',
      TABLES.catalog,
      '入库创建标识',
      '物品类别',
    );
    expect(gateway.ensureTextField).toHaveBeenCalledWith(
      'app-token',
      TABLES.inventory,
      '入库创建标识',
      '库存台账',
    );
    expect(gateway.ensureTextField).toHaveBeenCalledWith(
      'app-token',
      TABLES.inventory,
      '入库存放位置',
      '库存台账',
    );
    expect(gateway.ensureNumberField).toHaveBeenCalledWith(
      'app-token',
      TABLES.inventory,
      '初始化库存数量',
      '库存台账',
    );
    expect(gateway.ensureTextField).toHaveBeenCalledWith(
      'app-token',
      TABLES.inbound,
      '入库来源',
      '入库填写',
    );
    for (const [tableId, tableName] of [
      [TABLES.catalog, '物品类别'],
      [TABLES.inventory, '库存台账'],
      [TABLES.inbound, '入库填写'],
    ] as const) {
      expect(gateway.ensureTextField).toHaveBeenCalledWith(
        'app-token',
        tableId,
        '入库请求指纹',
        tableName,
      );
    }
    expect(gateway.createRecord).toHaveBeenNthCalledWith(
      1,
      'app-token',
      TABLES.catalog,
      {
        楼栋: 'A楼',
        物品类别号: 'A2008',
        一级分类: '机房耗材',
        二级分类: '过滤器 A2',
        名称: '新风滤芯',
        '规格型号、设备序列号': 'MERV 8',
        入库创建标识: '手工:manual-new-1',
        入库请求指纹: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      '物品类别',
    );
    expect(gateway.createRecord).toHaveBeenNthCalledWith(
      2,
      'app-token',
      TABLES.inventory,
      {
        楼栋: 'A楼',
        物品类别号: 'A2008',
        初始化库存数量: 0,
        '存放位置（程序）': 'A-1F-001',
        入库存放位置: 'A-1F-001',
        入库创建标识: '手工:manual-new-1',
        入库请求指纹: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      '库存台账',
    );
    expect(gateway.createRecord.mock.calls[1]?.[2]).not.toHaveProperty(
      '存放位置',
    );
    expect(gateway.createRecord).toHaveBeenNthCalledWith(
      3,
      'app-token',
      TABLES.inbound,
      {
        物品类别号: 'A2008',
        入库数量: 3,
        楼栋: 'A楼',
        入库日期: Date.parse('2026-07-12T10:00:00.000Z'),
        入库来源: '手工:manual-new-1',
        入库请求指纹: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      '入库填写',
    );
    const fingerprints = gateway.createRecord.mock.calls.map(
      (call) => call[2].入库请求指纹,
    );
    expect(new Set(fingerprints)).toHaveProperty('size', 1);
    expect(gateway.getRecord).toHaveBeenCalledTimes(3);
    expect(response).toEqual(
      expect.objectContaining({
        success: true,
        recordId: 'tbl_inbound-record-1',
        type: 'inbound',
        movement: expect.objectContaining({
          recordId: 'tbl_inbound-record-1',
          clientMutationId: 'manual-new-1',
          pendingSync: false,
          type: 'inbound',
          sku: 'A2008',
          name: '新风滤芯',
          specification: 'MERV 8',
          brand: '',
          primaryCategory: '机房耗材',
          secondaryCategory: '过滤器 A2',
          building: 'A楼',
          location: 'A-1F-001',
          quantity: 3,
          unit: '',
          occurredAt: '2026-07-12T10:00:00.000Z',
          destinationBuilding: '',
          reason: '',
          operator: '',
          applicant: '',
          status: '已入库',
          expectedReturnAt: null,
          overdue: false,
          categories: ['机房耗材', '过滤器 A2'],
        }),
      }),
    );
    expect(managementService.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it('creates the inventory ledger with only the configured formal location field plus the inbound shadow field', async () => {
    process.env.FEISHU_WAREHOUSE_INVENTORY_LOCATION_FIELD_NAME =
      '迁移后存放位置';
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );

    await service.createMovement(NEW_INBOUND_REQUEST);

    const inventoryWrite = gateway.createRecord.mock.calls.find(
      (call) => call[1] === TABLES.inventory,
    );
    expect(inventoryWrite?.[2]).toMatchObject({
      迁移后存放位置: 'A-1F-001',
      入库存放位置: 'A-1F-001',
    });
    expect(inventoryWrite?.[2]).not.toHaveProperty('存放位置');
  });

  it('audits existing strict inbound fields once per table without issuing duplicate field ensures', async () => {
    recordsByTable[TABLES.catalog] = [
      {
        record_id: 'catalog-b-a2007',
        fields: {
          物品类别号: 'A2007',
          名称: 'B楼旧滤芯',
          '规格型号、设备序列号': 'MERV 7',
          一级分类: '机房耗材',
          二级分类: '过滤器A2',
          楼栋: 'B楼',
        },
      },
    ];
    recordsByTable[TABLES.inventory] = [];
    gateway.getFieldSchemas.mockImplementation(
      async (_appToken: string, tableId: string) => {
        if (tableId === TABLES.catalog) {
          return [
            {
              fieldName: '入库创建标识',
              type: 1,
              uiType: 'Text',
              writable: true,
            },
            {
              fieldName: '入库请求指纹',
              type: 1,
              uiType: 'Text',
              writable: true,
            },
          ];
        }
        if (tableId === TABLES.inventory) {
          return [
            {
              fieldName: '入库创建标识',
              type: 1,
              uiType: 'Text',
              writable: true,
            },
            {
              fieldName: '入库存放位置',
              type: 1,
              uiType: 'Text',
              writable: true,
            },
            {
              fieldName: '存放位置（程序）',
              type: 3,
              uiType: 'SingleSelect',
              writable: true,
            },
            {
              fieldName: '初始化库存数量',
              type: 2,
              uiType: 'Number',
              writable: true,
            },
            {
              fieldName: '入库请求指纹',
              type: 1,
              uiType: 'Text',
              writable: true,
            },
          ];
        }
        return [
          { fieldName: '入库来源', type: 1, uiType: 'Text', writable: true },
          {
            fieldName: '入库请求指纹',
            type: 1,
            uiType: 'Text',
            writable: true,
          },
        ];
      },
    );
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );

    await service.createMovement(NEW_INBOUND_REQUEST);

    expect(gateway.getFieldSchemas.mock.calls.map((call) => call[1])).toEqual([
      TABLES.inventory,
      TABLES.catalog,
      TABLES.inbound,
    ]);
    expect(gateway.ensureTextField).not.toHaveBeenCalled();
    expect(gateway.ensureNumberField).not.toHaveBeenCalled();
  });

  it('starts independent strict inbound field schema reads before waiting for any result', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const schemasByTable = {
      [TABLES.inventory]: [
        {
          fieldName: getWarehouseInventoryLocationFieldName(),
          type: 3,
          uiType: 'SingleSelect',
          writable: true,
        },
        { fieldName: '入库创建标识', type: 1, uiType: 'Text', writable: true },
        { fieldName: '入库存放位置', type: 1, uiType: 'Text', writable: true },
        {
          fieldName: '初始化库存数量',
          type: 2,
          uiType: 'Number',
          writable: true,
        },
        { fieldName: '入库请求指纹', type: 1, uiType: 'Text', writable: true },
      ],
      [TABLES.catalog]: [
        { fieldName: '入库创建标识', type: 1, uiType: 'Text', writable: true },
        { fieldName: '入库请求指纹', type: 1, uiType: 'Text', writable: true },
      ],
      [TABLES.inbound]: [
        { fieldName: '入库来源', type: 1, uiType: 'Text', writable: true },
        { fieldName: '入库请求指纹', type: 1, uiType: 'Text', writable: true },
      ],
    };
    const schemaTableIds = [TABLES.inventory, TABLES.catalog, TABLES.inbound];
    const reads = new Map(
      schemaTableIds.map((tableId) => [
        tableId,
        createDeferred<(typeof schemasByTable)[keyof typeof schemasByTable]>(),
      ]),
    );
    const startedTableIds: string[] = [];
    gateway.getFieldSchemas.mockImplementation(
      (_appToken: string, tableId: keyof typeof schemasByTable) => {
        const read = reads.get(tableId);
        if (!read) return Promise.resolve([]);
        startedTableIds.push(tableId);
        return read.promise;
      },
    );
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );

    const creation = service.createMovement(NEW_INBOUND_REQUEST);
    await new Promise<void>((resolve) => setImmediate(resolve));

    try {
      expect(startedTableIds).toEqual(schemaTableIds);
    } finally {
      for (const tableId of schemaTableIds) {
        reads
          .get(tableId)
          ?.resolve(schemasByTable[tableId as keyof typeof schemasByTable]);
      }
      await creation;
    }
  });

  it('rejects a missing configured formal inventory location field before any record write', async () => {
    process.env.FEISHU_WAREHOUSE_INVENTORY_LOCATION_FIELD_NAME =
      '迁移后存放位置';
    gateway.getFieldSchemas.mockImplementation(
      async (_appToken: string, tableId: string) =>
        tableId === TABLES.inventory
          ? [
              {
                fieldName: '存放位置（程序）',
                type: 3,
                uiType: 'SingleSelect',
                writable: true,
              },
            ]
          : [],
    );
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );

    await expect(service.createMovement(NEW_INBOUND_REQUEST)).rejects.toThrow(
      '库存台账缺少字段“迁移后存放位置”，请先在飞书多维表创建可写单选字段后重试',
    );

    expect(gateway.ensureTextField).not.toHaveBeenCalled();
    expect(gateway.ensureNumberField).not.toHaveBeenCalled();
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('rejects a formal inventory location field with the wrong type before any record write', async () => {
    gateway.getFieldSchemas.mockImplementation(
      async (_appToken: string, tableId: string) =>
        tableId === TABLES.inventory
          ? [
              {
                fieldName: '存放位置（程序）',
                type: 1,
                uiType: 'Text',
                writable: true,
              },
            ]
          : [],
    );
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );

    await expect(service.createMovement(NEW_INBOUND_REQUEST)).rejects.toThrow(
      '库存台账字段“存放位置（程序）”必须是可写单选类型，请先修正多维表字段后重试',
    );

    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('uses POST search filters for strict new inbound reads', async () => {
    recordsByTable[TABLES.catalog] = [
      {
        record_id: 'catalog-b-a2007',
        fields: {
          物品类别号: 'A2007',
          二级分类: '过滤器 A2',
          楼栋: 'B楼',
        },
      },
    ];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );

    await service.createMovement(NEW_INBOUND_REQUEST);

    const reads = gateway.searchRecords.mock.calls.map(([options]) => options);
    expect(reads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableId: TABLES.catalog,
          filter: {
            conjunction: 'and',
            conditions: [
              {
                field_name: '入库创建标识',
                operator: 'is',
                value: ['手工:manual-new-1'],
              },
            ],
          },
        }),
        expect.objectContaining({
          tableId: TABLES.inventory,
          filter: {
            conjunction: 'and',
            conditions: [
              {
                field_name: '入库创建标识',
                operator: 'is',
                value: ['手工:manual-new-1'],
              },
            ],
          },
        }),
        expect.objectContaining({
          tableId: TABLES.inbound,
          filter: {
            conjunction: 'and',
            conditions: [
              {
                field_name: '入库来源',
                operator: 'is',
                value: ['手工:manual-new-1'],
              },
            ],
          },
        }),
        expect.objectContaining({
          tableId: TABLES.catalog,
          filter: {
            conjunction: 'and',
            conditions: [
              {
                field_name: '二级分类',
                operator: 'is',
                value: ['过滤器 A2'],
              },
            ],
          },
        }),
      ]),
    );
    expect(gateway.listRecords).not.toHaveBeenCalled();
  });

  it('starts independent strict inbound marker reads before waiting for any result', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;
    const request = trustedNewRequest('purchase-parallel-marker-first');
    const sourceKey = '采购:exec-parallel-marker';

    await trusted.createTrustedInbound(sourceKey, request, {
      role: 'admin',
      purchaseBuilding: null,
    });

    const markerTableIds = [TABLES.catalog, TABLES.inventory, TABLES.inbound];
    const reads = new Map(
      markerTableIds.map((tableId) => [
        tableId,
        createDeferred<TestRecord[]>(),
      ]),
    );
    const startedTableIds: string[] = [];
    gateway.searchRecords.mockClear();
    gateway.searchRecords.mockImplementation((options: { tableId: string }) => {
      const read = reads.get(options.tableId);
      if (!read) return Promise.resolve([]);
      startedTableIds.push(options.tableId);
      return read.promise;
    });

    const recovery = trusted.createTrustedInbound(
      sourceKey,
      { ...request, clientMutationId: 'purchase-parallel-marker-retry' },
      { role: 'admin', purchaseBuilding: null },
      { recoverOnly: true },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    try {
      expect(startedTableIds).toEqual(markerTableIds);
    } finally {
      for (const tableId of markerTableIds) {
        reads.get(tableId)?.resolve(
          (recordsByTable[tableId] || []).map((record) => ({
            ...record,
            fields: { ...record.fields },
          })),
        );
      }
      await recovery;
    }
  });

  it('uses a directed catalog read and POST search filters for strict existing inbound', async () => {
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const request: InventoryMovementCreateRequest = {
      type: 'inbound',
      mode: 'existing',
      clientMutationId: 'manual-existing-filtered',
      catalogRecordId: 'catalog-a101',
      sku: 'A101',
      building: 'A楼',
      quantity: 2,
      occurredAt: '2026-07-12T10:00:00.000Z',
    };

    await service.createMovement(request);

    expect(gateway.getRecord).toHaveBeenCalledWith(
      'app-token',
      TABLES.catalog,
      'catalog-a101',
      '物品类别',
    );
    const reads = gateway.searchRecords.mock.calls.map(([options]) => options);
    expect(reads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableId: TABLES.catalog,
          filter: {
            conjunction: 'and',
            conditions: [
              {
                field_name: '入库创建标识',
                operator: 'is',
                value: ['手工:manual-existing-filtered'],
              },
            ],
          },
        }),
        expect.objectContaining({
          tableId: TABLES.inventory,
          filter: {
            conjunction: 'and',
            conditions: [
              {
                field_name: '入库创建标识',
                operator: 'is',
                value: ['手工:manual-existing-filtered'],
              },
            ],
          },
        }),
        expect.objectContaining({
          tableId: TABLES.inbound,
          filter: {
            conjunction: 'and',
            conditions: [
              {
                field_name: '入库来源',
                operator: 'is',
                value: ['手工:manual-existing-filtered'],
              },
            ],
          },
        }),
        expect.objectContaining({
          tableId: TABLES.inventory,
          filter: {
            conjunction: 'and',
            conditions: [
              {
                field_name: '物品类别号',
                operator: 'is',
                value: ['A101'],
              },
            ],
          },
        }),
      ]),
    );
    expect(gateway.listRecords).not.toHaveBeenCalled();
  });

  it('reuses the completed result after a slow strict existing inbound exceeds the transport timeout', async () => {
    installStatefulGateway();
    jest.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValue(46_001);
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const request: InventoryMovementCreateRequest = {
      type: 'inbound',
      mode: 'existing',
      clientMutationId: 'manual-existing-1',
      catalogRecordId: 'catalog-a101',
      sku: 'A101',
      building: 'A楼',
      quantity: 2,
      occurredAt: '2026-07-12T10:00:00.000Z',
    };

    const first = await service.createMovement(request);
    const readsAfterFirst = gateway.listRecords.mock.calls.length;
    const fieldChecksAfterFirst = gateway.ensureTextField.mock.calls.length;
    const retry = await service.createMovement(request);

    expect(gateway.listRecords).toHaveBeenCalledTimes(readsAfterFirst);
    expect(gateway.ensureTextField).toHaveBeenCalledTimes(
      fieldChecksAfterFirst,
    );
    expect(
      gateway.createRecord.mock.calls.filter(
        (call) => call[1] === TABLES.inbound,
      ),
    ).toHaveLength(1);
    expect(retry).toEqual(first);
    expect(retry).toEqual(
      expect.objectContaining({
        recordId: 'tbl_inbound-record-1',
        movement: expect.objectContaining({
          recordId: 'tbl_inbound-record-1',
          clientMutationId: 'manual-existing-1',
          pendingSync: false,
          sku: 'A101',
          name: '测试滤芯',
          specification: 'MERV 8',
          brand: '测试品牌',
          primaryCategory: '耗材',
          secondaryCategory: '过滤器',
          building: 'A楼',
          location: 'A-1F-001',
          quantity: 2,
          unit: '个',
          occurredAt: '2026-07-12T10:00:00.000Z',
        }),
      }),
    );
  });

  it('continues a strict new inbound from the completed catalog stage after a retry', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    const ledgerFailure = new Error('temporary ledger network failure');
    installStatefulGateway(TABLES.inventory, ledgerFailure);
    const managementService = {
      invalidateCache: jest.fn(),
    };
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
      managementService as never,
    );

    await expect(service.createMovement(NEW_INBOUND_REQUEST)).rejects.toBe(
      ledgerFailure,
    );
    expect(managementService.invalidateCache).toHaveBeenCalledTimes(1);
    const response = await service.createMovement(NEW_INBOUND_REQUEST);

    expect(
      recordsByTable[TABLES.catalog].filter(
        (record) => record.fields.入库创建标识 === '手工:manual-new-1',
      ),
    ).toHaveLength(1);
    expect(
      recordsByTable[TABLES.inventory].filter(
        (record) => record.fields.入库创建标识 === '手工:manual-new-1',
      ),
    ).toHaveLength(1);
    expect(recordsByTable[TABLES.inbound]).toHaveLength(1);
    expect(response.recordId).toBe('tbl_inbound-record-1');
    expect(managementService.invalidateCache).toHaveBeenCalledTimes(2);
  });

  it('continues from completed catalog and ledger stages after an inbound write failure', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    const inboundFailure = new Error('temporary inbound network failure');
    installStatefulGateway(TABLES.inbound, inboundFailure);
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );

    await expect(service.createMovement(NEW_INBOUND_REQUEST)).rejects.toBe(
      inboundFailure,
    );
    const response = await service.createMovement(NEW_INBOUND_REQUEST);

    expect(recordsByTable[TABLES.catalog]).toHaveLength(1);
    expect(recordsByTable[TABLES.inventory]).toHaveLength(1);
    expect(recordsByTable[TABLES.inbound]).toHaveLength(1);
    expect(
      gateway.createRecord.mock.calls.filter(
        (call) => call[1] === TABLES.catalog,
      ),
    ).toHaveLength(1);
    expect(
      gateway.createRecord.mock.calls.filter(
        (call) => call[1] === TABLES.inventory,
      ),
    ).toHaveLength(1);
    expect(
      gateway.createRecord.mock.calls.filter(
        (call) => call[1] === TABLES.inbound,
      ),
    ).toHaveLength(2);
    expect(response.recordId).toBe('tbl_inbound-record-1');
  });

  it('coalesces concurrent retries of the same strict existing mutation', async () => {
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const request: InventoryMovementCreateRequest = {
      type: 'inbound',
      mode: 'existing',
      clientMutationId: 'manual-existing-concurrent',
      catalogRecordId: 'catalog-a101',
      sku: 'A101',
      building: 'A楼',
      quantity: 2,
      occurredAt: '2026-07-12T10:00:00.000Z',
    };

    const [first, retry] = await Promise.all([
      service.createMovement(request),
      service.createMovement(request),
    ]);

    expect(first).toEqual(retry);
    expect(
      gateway.createRecord.mock.calls.filter(
        (call) => call[1] === TABLES.inbound,
      ),
    ).toHaveLength(1);
  });

  it('serializes different strict new mutations in the same secondary category to avoid SKU collisions', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const secondRequest = {
      ...NEW_INBOUND_REQUEST,
      clientMutationId: 'manual-new-2',
      newItem: {
        ...(NEW_INBOUND_REQUEST.mode === 'new'
          ? NEW_INBOUND_REQUEST.newItem
          : {}),
        name: '新风滤芯二号',
      },
    } as InventoryMovementCreateRequest;

    const [first, second] = await Promise.all([
      service.createMovement(NEW_INBOUND_REQUEST),
      service.createMovement(secondRequest),
    ]);

    expect(
      recordsByTable[TABLES.catalog].map((record) => record.fields.物品类别号),
    ).toEqual(['A2001', 'A2002']);
    expect(first.movement?.sku).toBe('A2001');
    expect(second.movement?.sku).toBe('A2002');
  });

  it('shares the category lock between manual and trusted purchase new-item inbounds', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;
    const purchaseRequest = {
      type: 'inbound' as const,
      mode: 'new' as const,
      clientMutationId: 'purchase-transport-1',
      building: 'A楼' as const,
      quantity: 2,
      occurredAt: '2026-07-12T10:00:00.000Z',
      newItem: {
        primaryCategory: '机房耗材',
        secondaryCategory: '过滤器 A2',
        name: '采购滤芯',
        specification: 'MERV 9',
        location: 'A-1F-002',
        brand: '采购品牌',
        unit: '个',
        minimumQuantity: 2,
      },
    };

    const [purchase, manual] = await Promise.all([
      trusted.createTrustedInbound('采购:exec-shared-lock', purchaseRequest, {
        role: 'admin',
        purchaseBuilding: null,
      }),
      service.createMovement(NEW_INBOUND_REQUEST),
    ]);

    expect(
      recordsByTable[TABLES.catalog].map((record) => record.fields.物品类别号),
    ).toEqual(['A2001', 'A2002']);
    expect(purchase.response.movement.sku).toBe('A2001');
    expect(manual.movement?.sku).toBe('A2002');
    expect(recordsByTable[TABLES.catalog][0].fields).toEqual(
      expect.objectContaining({
        品牌: '采购品牌',
        计数单位: '个',
        最小库存量: 2,
      }),
    );
  });

  it('returns trusted persisted record ids and maps the current transport mutation id', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;
    const request = {
      type: 'inbound' as const,
      mode: 'new' as const,
      clientMutationId: 'purchase-transport-first',
      building: 'A楼' as const,
      quantity: 2,
      occurredAt: '2026-07-12T10:00:00.000Z',
      newItem: {
        primaryCategory: '机房耗材',
        secondaryCategory: '过滤器 A2',
        name: '采购滤芯',
        specification: 'MERV 9',
        location: 'A-1F-002',
        brand: '采购品牌',
        unit: '个',
        minimumQuantity: 2,
      },
    };

    const first = await trusted.createTrustedInbound(
      '采购:exec-trusted-result',
      request,
      { role: 'admin', purchaseBuilding: null },
    );
    const retry = await trusted.createTrustedInbound(
      '采购:exec-trusted-result',
      { ...request, clientMutationId: 'purchase-transport-retry' },
      { role: 'admin', purchaseBuilding: null },
    );

    expect(first).toEqual(
      expect.objectContaining({
        catalogRecordId: 'tbl_catalog-record-1',
        inventoryRecordId: 'tbl_inventory-record-1',
        inboundRecordId: 'tbl_inbound-record-1',
        alreadyProcessed: false,
        response: expect.objectContaining({
          movement: expect.objectContaining({
            clientMutationId: 'purchase-transport-first',
          }),
        }),
      }),
    );
    expect(retry).toEqual(
      expect.objectContaining({
        catalogRecordId: 'tbl_catalog-record-1',
        inventoryRecordId: 'tbl_inventory-record-1',
        inboundRecordId: 'tbl_inbound-record-1',
        alreadyProcessed: true,
        response: expect.objectContaining({
          movement: expect.objectContaining({
            clientMutationId: 'purchase-transport-retry',
          }),
        }),
      }),
    );
    expect(recordsByTable[TABLES.catalog]).toHaveLength(1);
    expect(recordsByTable[TABLES.inventory]).toHaveLength(1);
    expect(recordsByTable[TABLES.inbound]).toHaveLength(1);
  });

  it('maps each in-flight trusted retry to its own transport mutation id', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;
    const request = trustedNewRequest('purchase-transport-concurrent-first');

    const [first, retry] = await Promise.all([
      trusted.createTrustedInbound('采购:exec-transport-concurrent', request, {
        role: 'admin',
        purchaseBuilding: null,
      }),
      trusted.createTrustedInbound(
        '采购:exec-transport-concurrent',
        {
          ...request,
          clientMutationId: 'purchase-transport-concurrent-retry',
        },
        { role: 'admin', purchaseBuilding: null },
      ),
    ]);

    expect(first.response.movement.clientMutationId).toBe(
      'purchase-transport-concurrent-first',
    );
    expect(retry.response.movement.clientMutationId).toBe(
      'purchase-transport-concurrent-retry',
    );
    expect(recordsByTable[TABLES.catalog]).toHaveLength(1);
    expect(recordsByTable[TABLES.inventory]).toHaveLength(1);
    expect(recordsByTable[TABLES.inbound]).toHaveLength(1);
  });

  it.each([
    ['brand', { brand: '另一个品牌' }],
    ['unit', { unit: '箱' }],
    ['minimum quantity', { minimumQuantity: 9 }],
  ])(
    'rejects a trusted purchase source key reused with different %s',
    async (_label, changedFields) => {
      recordsByTable[TABLES.catalog] = [];
      recordsByTable[TABLES.inventory] = [];
      installStatefulGateway();
      const service = new InventoryMovementCommandService(
        { axiosRef: {} } as never,
        gateway as never,
      );
      const trusted = service as unknown as TrustedInboundTestService;
      const request = trustedNewRequest('purchase-extra-first');
      await trusted.createTrustedInbound('采购:exec-extra-conflict', request, {
        role: 'admin',
        purchaseBuilding: null,
      });
      gateway.createRecord.mockClear();

      await expect(
        trusted.createTrustedInbound(
          '采购:exec-extra-conflict',
          {
            ...request,
            clientMutationId: 'purchase-extra-retry',
            newItem: { ...request.newItem, ...changedFields },
          },
          { role: 'admin', purchaseBuilding: null },
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(gateway.createRecord).not.toHaveBeenCalled();
    },
  );

  it('rejects trusted recovery when persisted purchase catalog metadata changed', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;
    const request = trustedNewRequest('purchase-persisted-metadata-first');
    await trusted.createTrustedInbound(
      '采购:exec-persisted-metadata',
      request,
      { role: 'admin', purchaseBuilding: null },
    );
    recordsByTable[TABLES.catalog][0].fields.品牌 = '被篡改的品牌';
    gateway.createRecord.mockClear();

    await expect(
      trusted.createTrustedInbound(
        '采购:exec-persisted-metadata',
        {
          ...request,
          clientMutationId: 'purchase-persisted-metadata-retry',
        },
        { role: 'admin', purchaseBuilding: null },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('rejects recover-only trusted requests without a persisted inbound marker', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;

    await expect(
      trusted.createTrustedInbound(
        '采购:exec-recover-only-missing',
        trustedNewRequest('purchase-recover-only-missing'),
        { role: 'admin', purchaseBuilding: null },
        { recoverOnly: true },
      ),
    ).rejects.toThrow('未找到可恢复的采购入库记录');
    expect(gateway.ensureTextField).not.toHaveBeenCalled();
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('recovers a completed trusted purchase in read-only mode without field or record writes', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;
    const request = trustedNewRequest('purchase-recover-only-first');
    await trusted.createTrustedInbound(
      '采购:exec-recover-only-existing',
      request,
      { role: 'admin', purchaseBuilding: null },
    );
    gateway.ensureTextField.mockClear();
    gateway.createRecord.mockClear();

    const recovered = await trusted.createTrustedInbound(
      '采购:exec-recover-only-existing',
      { ...request, clientMutationId: 'purchase-recover-only-retry' },
      { role: 'admin', purchaseBuilding: null },
      { recoverOnly: true },
    );

    expect(recovered).toMatchObject({
      catalogRecordId: 'tbl_catalog-record-1',
      inventoryRecordId: 'tbl_inventory-record-1',
      inboundRecordId: 'tbl_inbound-record-1',
      alreadyProcessed: true,
      response: {
        movement: { clientMutationId: 'purchase-recover-only-retry' },
      },
    });
    expect(gateway.ensureTextField).not.toHaveBeenCalled();
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('rejects duplicate persisted purchase source markers', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;
    const request = trustedNewRequest('purchase-duplicate-marker-first');
    await trusted.createTrustedInbound('采购:exec-duplicate-marker', request, {
      role: 'admin',
      purchaseBuilding: null,
    });
    recordsByTable[TABLES.inbound].push({
      record_id: 'duplicate-purchase-inbound',
      fields: { ...recordsByTable[TABLES.inbound][0].fields },
    });
    gateway.createRecord.mockClear();

    await expect(
      trusted.createTrustedInbound(
        '采购:exec-duplicate-marker',
        {
          ...request,
          clientMutationId: 'purchase-duplicate-marker-retry',
        },
        { role: 'admin', purchaseBuilding: null },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('recovers a trusted purchase through its marker after a directed read failure', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const directedReadFailure = new Error('directed purchase read unavailable');
    gateway.getRecord.mockRejectedValueOnce(directedReadFailure);
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;
    const request = trustedNewRequest('purchase-directed-read-first');

    await expect(
      trusted.createTrustedInbound('采购:exec-directed-read', request, {
        role: 'admin',
        purchaseBuilding: null,
      }),
    ).rejects.toBe(directedReadFailure);
    const recovered = await trusted.createTrustedInbound(
      '采购:exec-directed-read',
      { ...request, clientMutationId: 'purchase-directed-read-retry' },
      { role: 'admin', purchaseBuilding: null },
    );

    expect(recovered.response.movement.clientMutationId).toBe(
      'purchase-directed-read-retry',
    );
    expect(recordsByTable[TABLES.catalog]).toHaveLength(1);
    expect(recordsByTable[TABLES.inventory]).toHaveLength(1);
    expect(recordsByTable[TABLES.inbound]).toHaveLength(1);
  });

  it('rejects malformed trusted source keys before reading or writing records', async () => {
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;

    await expect(
      trusted.createTrustedInbound(
        '来自HTTP的任意键',
        trustedNewRequest('purchase-invalid-source'),
        { role: 'admin', purchaseBuilding: null },
      ),
    ).rejects.toThrow('入库来源标识格式无效');
    expect(gateway.listRecords).not.toHaveBeenCalled();
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('does not accept a source key supplied in an HTTP movement payload', async () => {
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const request = {
      type: 'inbound',
      catalogRecordId: 'catalog-a101',
      sku: 'A101',
      building: 'A楼',
      quantity: 2,
      occurredAt: '2026-07-12T10:00:00.000Z',
      sourceKey: '采购:exec-forged',
    } as unknown as InventoryMovementCreateRequest;

    await expect(service.createMovement(request)).rejects.toThrow(
      'HTTP 请求不能指定入库来源标识',
    );
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it.each([
    [
      'payload',
      {
        ...NEW_INBOUND_REQUEST,
        quantity: 4,
      } as InventoryMovementCreateRequest,
    ],
    [
      'building',
      {
        ...NEW_INBOUND_REQUEST,
        building: 'B楼',
        newItem:
          NEW_INBOUND_REQUEST.mode === 'new'
            ? {
                ...NEW_INBOUND_REQUEST.newItem,
                location: 'B-1F-001',
              }
            : undefined,
      } as InventoryMovementCreateRequest,
    ],
  ])(
    'rejects an in-flight mutation reused with a different %s fingerprint',
    async (_label, conflictingRequest) => {
      recordsByTable[TABLES.catalog] = [];
      recordsByTable[TABLES.inventory] = [];
      installStatefulGateway();
      const service = new InventoryMovementCommandService(
        { axiosRef: {} } as never,
        gateway as never,
      );

      const first = service.createMovement(NEW_INBOUND_REQUEST);
      await expect(
        service.createMovement(conflictingRequest),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(first).resolves.toEqual(
        expect.objectContaining({ success: true }),
      );

      expect(recordsByTable[TABLES.catalog]).toHaveLength(1);
      expect(recordsByTable[TABLES.inventory]).toHaveLength(1);
      expect(recordsByTable[TABLES.inbound]).toHaveLength(1);
    },
  );

  it('recovers the same purchase source across authorized caller identities', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    const trusted = service as unknown as TrustedInboundTestService;
    const firstCaller: AccessPrincipal & { openId: string } = {
      role: 'admin',
      purchaseBuilding: null,
      openId: 'ou_caller_one',
    };
    const secondCaller: AccessPrincipal & { openId: string } = {
      ...firstCaller,
      openId: 'ou_caller_two',
    };

    const request = trustedNewRequest('purchase-cross-admin-first');
    const first = await trusted.createTrustedInbound(
      '采购:exec-cross-admin',
      request,
      firstCaller,
    );
    const second = await trusted.createTrustedInbound(
      '采购:exec-cross-admin',
      { ...request, clientMutationId: 'purchase-cross-admin-retry' },
      secondCaller,
    );

    expect(first.alreadyProcessed).toBe(false);
    expect(second.alreadyProcessed).toBe(true);
    expect(second.response.movement.clientMutationId).toBe(
      'purchase-cross-admin-retry',
    );
    expect(recordsByTable[TABLES.inbound]).toHaveLength(1);
  });

  it('stops before creating any stage when a persisted marker has another fingerprint', async () => {
    recordsByTable[TABLES.catalog] = [
      {
        record_id: 'catalog-conflicting-marker',
        fields: {
          物品类别号: 'A2001',
          名称: '新风滤芯',
          '规格型号、设备序列号': 'MERV 8',
          一级分类: '机房耗材',
          二级分类: '过滤器 A2',
          楼栋: 'A楼',
          入库创建标识: '手工:manual-new-1',
          入库请求指纹: 'another-request-fingerprint',
        },
      },
    ];
    recordsByTable[TABLES.inventory] = [];
    recordsByTable[TABLES.inbound] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );

    await expect(
      service.createMovement(NEW_INBOUND_REQUEST),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(gateway.ensureTextField).toHaveBeenCalled();
    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(recordsByTable[TABLES.inventory]).toHaveLength(0);
    expect(recordsByTable[TABLES.inbound]).toHaveLength(0);
  });

  it('rejects duplicate persisted markers instead of silently choosing the first record', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );
    await service.createMovement(NEW_INBOUND_REQUEST);
    const originalInbound = recordsByTable[TABLES.inbound][0];
    recordsByTable[TABLES.inbound].push({
      record_id: 'duplicate-inbound-marker',
      fields: { ...originalInbound.fields },
    });
    gateway.createRecord.mockClear();

    await expect(
      service.createMovement(NEW_INBOUND_REQUEST),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it.each([
    ['inbound SKU', TABLES.inbound, '物品类别号', undefined],
    ['inbound building', TABLES.inbound, '楼栋', 'B楼'],
    ['inbound quantity', TABLES.inbound, '入库数量', undefined],
    ['inbound occurredAt', TABLES.inbound, '入库日期', undefined],
    ['catalog name', TABLES.catalog, '名称', undefined],
    ['ledger SKU association', TABLES.inventory, '物品类别号', 'B9001'],
  ])(
    'rejects recovery when persisted %s is missing or inconsistent',
    async (_label, tableId, fieldName, replacement) => {
      recordsByTable[TABLES.catalog] = [];
      recordsByTable[TABLES.inventory] = [];
      installStatefulGateway();
      const service = new InventoryMovementCommandService(
        { axiosRef: {} } as never,
        gateway as never,
      );
      await service.createMovement(NEW_INBOUND_REQUEST);
      const record = recordsByTable[tableId][0];
      if (replacement === undefined) {
        delete record.fields[fieldName];
      } else {
        record.fields[fieldName] = replacement;
      }
      gateway.createRecord.mockClear();

      await expect(
        service.createMovement(NEW_INBOUND_REQUEST),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(gateway.createRecord).not.toHaveBeenCalled();
    },
  );

  it('rejects a strict new item when its secondary category belongs to another primary category', async () => {
    recordsByTable[TABLES.catalog] = [
      {
        record_id: 'catalog-a2001',
        fields: {
          物品类别号: 'A2001',
          一级分类: '其他耗材',
          二级分类: '过滤器 A2',
          楼栋: 'B楼',
        },
      },
    ];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );

    await expect(service.createMovement(NEW_INBOUND_REQUEST)).rejects.toThrow(
      '二级分类“过滤器 A2”已归属一级分类“其他耗材”',
    );
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it.each([
    {
      type: 'inbound',
      clientMutationId: 'strict-signal-without-mode',
      catalogRecordId: 'catalog-a101',
      sku: 'A101',
      building: 'A楼',
      quantity: 2,
      occurredAt: '2026-07-12T10:00:00.000Z',
      newItem: {
        primaryCategory: '机房耗材',
        secondaryCategory: '过滤器 A2',
        name: '新风滤芯',
        specification: 'MERV 8',
        location: 'A-1F-001',
      },
    },
    {
      type: 'inbound',
      mode: 'existing',
      catalogRecordId: 'catalog-a101',
      sku: 'A101',
      building: 'A楼',
      quantity: 2,
      occurredAt: '2026-07-12T10:00:00.000Z',
    },
  ])(
    'rejects incomplete strict HTTP payloads instead of downgrading to legacy',
    async (malformedRequest) => {
      const service = new InventoryMovementCommandService(
        { axiosRef: {} } as never,
        gateway as never,
      );

      await expect(
        service.createMovement(
          malformedRequest as unknown as InventoryMovementCreateRequest,
        ),
      ).rejects.toThrow('严格入库请求参数不完整');
      expect(gateway.createRecord).not.toHaveBeenCalled();
    },
  );

  it('recovers through persisted markers when a directed post-create read fails', async () => {
    recordsByTable[TABLES.catalog] = [];
    recordsByTable[TABLES.inventory] = [];
    installStatefulGateway();
    const directedReadFailure = new Error('directed read unavailable');
    gateway.getRecord.mockRejectedValueOnce(directedReadFailure);
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );

    await expect(service.createMovement(NEW_INBOUND_REQUEST)).rejects.toBe(
      directedReadFailure,
    );
    expect(recordsByTable[TABLES.catalog]).toHaveLength(1);
    expect(recordsByTable[TABLES.inventory]).toHaveLength(0);
    expect(recordsByTable[TABLES.inbound]).toHaveLength(0);

    const response = await service.createMovement(NEW_INBOUND_REQUEST);
    expect(response).toEqual(expect.objectContaining({ success: true }));
    expect(recordsByTable[TABLES.catalog]).toHaveLength(1);
    expect(recordsByTable[TABLES.inventory]).toHaveLength(1);
    expect(recordsByTable[TABLES.inbound]).toHaveLength(1);
  });

  it.each([
    ['过滤器', [] as TestRecord[], '末尾缺少类别代码'],
    [
      '过滤器 A2',
      [
        {
          record_id: 'catalog-a2999',
          fields: {
            物品类别号: 'A2999',
            二级分类: '过滤器 A2',
            楼栋: 'B楼',
          },
        },
      ] as TestRecord[],
      '已无可用编号',
    ],
  ])(
    'maps SKU rule failures for secondary category %s to BadRequestException',
    async (secondaryCategory, catalog, expectedMessage) => {
      recordsByTable[TABLES.catalog] = catalog;
      recordsByTable[TABLES.inventory] = [];
      installStatefulGateway();
      const service = new InventoryMovementCommandService(
        { axiosRef: {} } as never,
        gateway as never,
      );
      const request = {
        ...NEW_INBOUND_REQUEST,
        clientMutationId: `manual-rule-${secondaryCategory}`,
        newItem: {
          ...(NEW_INBOUND_REQUEST.mode === 'new'
            ? NEW_INBOUND_REQUEST.newItem
            : {}),
          secondaryCategory,
        },
      } as InventoryMovementCreateRequest;

      let failure: unknown;
      try {
        await service.createMovement(request);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(BadRequestException);
      expect((failure as Error).message).toContain(expectedMessage);
      expect(gateway.createRecord).not.toHaveBeenCalled();
    },
  );

  it('preserves gateway failures instead of reporting a false success', async () => {
    const networkFailure = new Error('gateway unavailable');
    gateway.searchRecords.mockRejectedValueOnce(networkFailure);
    const service = new InventoryMovementCommandService(
      { axiosRef: {} } as never,
      gateway as never,
    );

    await expect(service.createMovement(NEW_INBOUND_REQUEST)).rejects.toBe(
      networkFailure,
    );
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  function installStatefulGateway(
    failOnceTableId?: string,
    failure: Error = new Error('temporary write failure'),
  ): void {
    let failed = false;
    gateway.createRecord.mockImplementation(
      async (
        _appToken: string,
        tableId: string,
        fields: Record<string, unknown>,
      ) => {
        if (tableId === failOnceTableId && !failed) {
          failed = true;
          throw failure;
        }
        await Promise.resolve();
        const records =
          recordsByTable[tableId] || (recordsByTable[tableId] = []);
        const recordId = `${tableId}-record-${records.length + 1}`;
        records.push({ record_id: recordId, fields: { ...fields } });
        return recordId;
      },
    );
  }
});

interface TrustedInboundTestRequest {
  type: 'inbound';
  mode: 'new';
  clientMutationId: string;
  building: 'A楼';
  quantity: number;
  occurredAt: string;
  newItem: PurchaseInboundNewItemInput;
}

interface TrustedInboundTestResult {
  response: InventoryMovementCreateResponse & {
    movement: InventoryMovementItem;
  };
  catalogRecordId: string;
  inventoryRecordId: string;
  inboundRecordId: string;
  alreadyProcessed: boolean;
}

interface PreparedCatalogTestResult {
  catalogRecordId: string;
  sku: string;
  alreadyPrepared: boolean;
  preparedAt: string;
}

interface TrustedInboundTestService {
  prepareTrustedNewInboundCatalog(
    sourceKey: string,
    request: TrustedInboundTestRequest,
    principal: AccessPrincipal,
  ): Promise<PreparedCatalogTestResult>;
  createTrustedInbound(
    sourceKey: string,
    request: TrustedInboundTestRequest,
    principal: AccessPrincipal,
    options?: {
      recoverOnly?: boolean;
      requirePreparedCatalog?: boolean;
      expectedCatalogRecordId?: string;
      expectedSku?: string;
      assertOwnership?: () => Promise<void>;
    },
  ): Promise<TrustedInboundTestResult>;
}

function trustedNewRequest(
  clientMutationId: string,
): TrustedInboundTestRequest {
  return {
    type: 'inbound',
    mode: 'new',
    clientMutationId,
    building: 'A楼',
    quantity: 2,
    occurredAt: '2026-07-12T10:00:00.000Z',
    newItem: {
      primaryCategory: '机房耗材',
      secondaryCategory: '过滤器 A2',
      name: '采购滤芯',
      specification: 'MERV 9',
      location: 'A-1F-002',
      locationRecordId: 'location-a-002',
      brand: '采购品牌',
      unit: '个',
      minimumQuantity: 2,
    },
  };
}

function strictNewInboundFingerprint(
  request: TrustedInboundTestRequest,
): string {
  const locationRecordId = String(
    request.newItem.locationRecordId || '',
  ).trim();
  return createHash('sha256')
    .update(
      JSON.stringify({
        type: 'inbound',
        mode: 'new',
        building: request.building,
        quantity: request.quantity,
        occurredAt: new Date(request.occurredAt).toISOString(),
        applicantOpenId: '',
        operatorOpenId: '',
        reason: '',
        destinationBuilding: '',
        expectedReturnAt: '',
        newItem: {
          primaryCategory: String(request.newItem.primaryCategory || '').trim(),
          secondaryCategory: String(
            request.newItem.secondaryCategory || '',
          ).trim(),
          name: String(request.newItem.name || '').trim(),
          specification: String(request.newItem.specification || '').trim(),
          location: String(request.newItem.location || '').trim(),
          ...(locationRecordId ? { locationRecordId } : {}),
          brand: String(request.newItem.brand || '').trim(),
          unit: String(request.newItem.unit || '').trim(),
          minimumQuantity:
            request.newItem.minimumQuantity === undefined
              ? null
              : request.newItem.minimumQuantity,
        },
      }),
      'utf8',
    )
    .digest('hex');
}
