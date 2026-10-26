import type {
  InventoryMovementCreateRequest,
  InventoryMovementCreateResponse,
  InventoryMovementItem,
  InventoryNewItemInput,
  PurchaseInboundConfirmRequest,
  PurchaseInboundConfirmResponse,
} from '../../shared/inventory-management.interface';
import * as ts from 'typescript';
import {
  buildInventoryCatalogFields,
  buildInventoryLedgerFields,
  generateInventorySku,
} from '../../server/modules/inventory-management/inventory-inbound-catalog.rules';

describe('inventory inbound catalog rules', () => {
  it('starts an empty A2 secondary category at A2001', () => {
    expect(
      generateInventorySku({
        secondaryCategory: '常备件A2',
        catalogRecords: [],
      }),
    ).toBe('A2001');
  });

  it('uses the global secondary-category maximum across buildings', () => {
    expect(
      generateInventorySku({
        secondaryCategory: '常备件A2',
        catalogRecords: [
          {
            building: 'A楼',
            secondaryCategory: '常备件A2',
            sku: 'A2008',
          },
          {
            building: 'B楼',
            secondaryCategory: '常备件A2',
            sku: 'A2189',
          },
        ],
      }),
    ).toBe('A2190');
  });

  it('ignores records from other categories and malformed category numbers', () => {
    expect(
      generateInventorySku({
        secondaryCategory: '常备件A2',
        catalogRecords: [
          {
            building: 'A楼',
            secondaryCategory: '常备件A2',
            sku: 'A2007',
          },
          {
            building: 'B楼',
            secondaryCategory: '检测工具B1',
            sku: 'A2999',
          },
          {
            building: 'C楼',
            secondaryCategory: '常备件A2',
            sku: 'B1999',
          },
          {
            building: 'D楼',
            secondaryCategory: '常备件A2',
            sku: 'A2010-extra',
          },
          {
            building: 'E楼',
            secondaryCategory: '常备件A2',
            sku: 'A299',
          },
          {
            building: 'H楼',
            secondaryCategory: '常备件A2',
            sku: ' A2888',
          },
        ],
      }),
    ).toBe('A2008');
  });

  it('throws a clear business error when the three-digit sequence is exhausted', () => {
    expect(() =>
      generateInventorySku({
        secondaryCategory: '常备件A2',
        catalogRecords: [
          {
            building: 'A楼',
            secondaryCategory: '常备件A2',
            sku: 'A2999',
          },
        ],
      }),
    ).toThrow('超过 999');
  });

  it('rejects a secondary category without the required trailing code', () => {
    expect(() =>
      generateInventorySku({
        secondaryCategory: '常备件',
        catalogRecords: [],
      }),
    ).toThrow('二级分类');
  });

  it('builds catalog fields and preserves the inbound location in a writable text field', () => {
    const newItem: InventoryNewItemInput = {
      primaryCategory: 'A备品备件类',
      secondaryCategory: '常备件A2',
      name: '新型滤芯',
      specification: 'MERV 8',
      location: 'A楼-01架',
    };

    const catalogFields = buildInventoryCatalogFields({
      building: 'A楼',
      sku: 'A2001',
      newItem,
    });
    const ledgerFields = buildInventoryLedgerFields({
      building: 'A楼',
      sku: 'A2001',
      location: newItem.location,
    });

    expect(catalogFields).toEqual({
      楼栋: 'A楼',
      物品类别号: 'A2001',
      一级分类: 'A备品备件类',
      二级分类: '常备件A2',
      名称: '新型滤芯',
      '规格型号、设备序列号': 'MERV 8',
    });
    expect(ledgerFields).toEqual({
      楼栋: 'A楼',
      物品类别号: 'A2001',
      初始化库存数量: 0,
      '存放位置（程序）': 'A楼-01架',
      入库存放位置: 'A楼-01架',
    });
    expect(ledgerFields).not.toHaveProperty('存放位置');
    expect(
      Object.values(catalogFields).every((value) => typeof value === 'string'),
    ).toBe(true);
    expect(ledgerFields.初始化库存数量).toBe(0);
  });

  it('writes a configured inventory location field without also mutating the legacy field', () => {
    const envName = 'FEISHU_WAREHOUSE_INVENTORY_LOCATION_FIELD_NAME';
    const original = process.env[envName];
    process.env[envName] = '迁移后存放位置';

    try {
      const ledgerFields = buildInventoryLedgerFields({
        building: 'A楼',
        sku: 'A2001',
        location: 'A楼-01架',
      });

      expect(ledgerFields).toMatchObject({
        迁移后存放位置: 'A楼-01架',
        入库存放位置: 'A楼-01架',
      });
      expect(ledgerFields).not.toHaveProperty('存放位置');
    } finally {
      if (original === undefined) delete process.env[envName];
      else process.env[envName] = original;
    }
  });

  it('expresses strict and legacy requests and returns canonical movements', () => {
    const newItem: InventoryNewItemInput = {
      primaryCategory: 'A备品备件类',
      secondaryCategory: '常备件A2',
      name: '新型滤芯',
      specification: 'MERV 8',
      location: 'A楼-01架',
    };
    const manualRequest: InventoryMovementCreateRequest = {
      type: 'inbound',
      building: 'A楼',
      quantity: 2,
      occurredAt: '2026-07-29T02:00:00.000Z',
      clientMutationId: 'manual-mutation-1',
      mode: 'new',
      newItem,
    };
    const purchaseRequest: PurchaseInboundConfirmRequest = {
      executionRecordId: 'execution-1',
      building: 'B楼',
      clientMutationId: 'purchase-mutation-1',
      mode: 'new',
      quantity: 2,
      occurredAt: '2026-07-29T02:00:00.000Z',
      preparedCatalogRecordId: 'catalog-b2001',
      generatedSku: 'A2001',
      newItem: { ...newItem, location: 'B楼-01架' },
    };
    const manualExistingRequest: InventoryMovementCreateRequest = {
      type: 'inbound',
      building: 'A楼',
      quantity: 2,
      occurredAt: '2026-07-29T02:00:00.000Z',
      clientMutationId: 'manual-existing-mutation-1',
      mode: 'existing',
      catalogRecordId: 'catalog-1',
      sku: 'A2001',
    };
    const purchaseExistingRequest: PurchaseInboundConfirmRequest = {
      executionRecordId: 'execution-existing-1',
      building: 'B楼',
      clientMutationId: 'purchase-existing-mutation-1',
      mode: 'existing',
      catalogRecordId: 'catalog-1',
      sku: 'A2001',
      quantity: 2,
      occurredAt: '2026-07-29T02:00:00.000Z',
    };
    const legacyManualRequest: InventoryMovementCreateRequest = {
      type: 'inbound',
      catalogRecordId: 'catalog-legacy-1',
      sku: 'A2001',
      building: 'A楼',
      quantity: 2,
      occurredAt: '2026-07-29T02:00:00.000Z',
    };
    const legacyPurchaseRequest: PurchaseInboundConfirmRequest = {
      executionRecordId: 'execution-legacy-1',
      mode: 'new',
      sku: 'A2001',
      quantity: 2,
      occurredAt: '2026-07-29T02:00:00.000Z',
      newItem: {
        primaryCategory: 'A备品备件类',
        secondaryCategory: '常备件A2',
        name: '旧页面新品',
        specification: 'MERV 8',
        brand: '旧品牌',
        unit: '件',
        minimumQuantity: 0,
      },
    };
    const movement: InventoryMovementItem = {
      recordId: 'inbound-1',
      type: 'inbound',
      sku: 'A2001',
      name: '新型滤芯',
      specification: 'MERV 8',
      quantity: 2,
      unit: '件',
      building: 'B楼',
      destinationBuilding: '',
      location: 'B楼-01架',
      reason: '',
      operator: '',
      applicant: '',
      status: '已入库',
      occurredAt: '2026-07-29T02:00:00.000Z',
      expectedReturnAt: null,
      overdue: false,
      clientMutationId: purchaseRequest.clientMutationId,
      pendingSync: false,
    };
    const movementResponse: InventoryMovementCreateResponse = {
      success: true,
      recordId: movement.recordId,
      type: 'inbound',
      message: '入库成功',
      movement,
    };
    const purchaseResponse: PurchaseInboundConfirmResponse = {
      success: true,
      executionRecordId: purchaseRequest.executionRecordId,
      catalogRecordId: 'catalog-1',
      inboundRecordId: movement.recordId,
      alreadyProcessed: false,
      message: '采购入库成功',
      notificationWarnings: [],
      movement,
    };

    expect(manualRequest).not.toHaveProperty('sku');
    expect(purchaseRequest).not.toHaveProperty('sku');
    expect(manualExistingRequest.catalogRecordId).toBe('catalog-1');
    expect(purchaseExistingRequest.sku).toBe('A2001');
    expect(legacyManualRequest).not.toHaveProperty('mode');
    expect(legacyPurchaseRequest.newItem).not.toHaveProperty('location');
    expect(movementResponse.movement).toBe(movement);
    expect(purchaseResponse.movement).toBe(movement);
  });

  it('rejects invalid strict request shapes at compile time', () => {
    const acceptMovementRequest = (_request: InventoryMovementCreateRequest) =>
      undefined;
    const acceptPurchaseRequest = (_request: PurchaseInboundConfirmRequest) =>
      undefined;
    const strictNewItem = {
      primaryCategory: 'A备品备件类',
      secondaryCategory: '常备件A2',
      name: '新型滤芯',
      specification: 'MERV 8',
      location: 'A楼-01架',
    } as const;
    const strictNewWithoutLocation = {
      type: 'inbound',
      building: 'A楼',
      quantity: 1,
      occurredAt: '2026-07-29T02:00:00.000Z',
      clientMutationId: 'manual-new-without-location',
      mode: 'new',
      newItem: {
        primaryCategory: 'A备品备件类',
        secondaryCategory: '常备件A2',
        name: '新型滤芯',
        specification: 'MERV 8',
      },
    } as const;
    const strictNewWithSku = {
      type: 'inbound',
      building: 'A楼',
      quantity: 1,
      occurredAt: '2026-07-29T02:00:00.000Z',
      clientMutationId: 'manual-new-with-sku',
      mode: 'new',
      sku: 'A2001',
      newItem: strictNewItem,
    } as const;
    const strictExistingWithoutCatalog = {
      type: 'inbound',
      building: 'A楼',
      quantity: 1,
      occurredAt: '2026-07-29T02:00:00.000Z',
      clientMutationId: 'manual-existing-without-catalog',
      mode: 'existing',
    } as const;
    const purchaseStrictWithoutBuilding = {
      executionRecordId: 'execution-without-building',
      clientMutationId: 'purchase-without-building',
      mode: 'new',
      quantity: 1,
      occurredAt: '2026-07-29T02:00:00.000Z',
      newItem: strictNewItem,
    } as const;
    const purchaseStrictWithoutMutation = {
      executionRecordId: 'execution-without-mutation',
      building: 'A楼',
      mode: 'new',
      quantity: 1,
      occurredAt: '2026-07-29T02:00:00.000Z',
      newItem: strictNewItem,
    } as const;
    const purchaseStrictNewWithSku = {
      executionRecordId: 'execution-new-with-sku',
      building: 'A楼',
      clientMutationId: 'purchase-new-with-sku',
      mode: 'new',
      sku: 'A2001',
      quantity: 1,
      occurredAt: '2026-07-29T02:00:00.000Z',
      newItem: strictNewItem,
    } as const;
    const purchaseStrictExistingWithoutCatalog = {
      executionRecordId: 'execution-existing-without-catalog',
      building: 'A楼',
      clientMutationId: 'purchase-existing-without-catalog',
      mode: 'existing',
      quantity: 1,
      occurredAt: '2026-07-29T02:00:00.000Z',
    } as const;

    // @ts-expect-error strict new inventory items require a storage location
    acceptMovementRequest(strictNewWithoutLocation);
    // @ts-expect-error strict new inventory requests cannot provide a SKU
    acceptMovementRequest(strictNewWithSku);
    // @ts-expect-error strict existing inventory requests require catalogRecordId and sku
    acceptMovementRequest(strictExistingWithoutCatalog);
    // @ts-expect-error strict purchase requests require a target building
    acceptPurchaseRequest(purchaseStrictWithoutBuilding);
    // @ts-expect-error strict purchase requests require a client mutation id
    acceptPurchaseRequest(purchaseStrictWithoutMutation);
    // @ts-expect-error strict new purchase requests cannot provide a SKU
    acceptPurchaseRequest(purchaseStrictNewWithSku);
    // @ts-expect-error strict existing purchase requests require catalogRecordId and sku
    acceptPurchaseRequest(purchaseStrictExistingWithoutCatalog);

    expect(true).toBe(true);
  });

  it('keeps the compile-time request assertions active', () => {
    const program = ts.createProgram({
      rootNames: [__filename],
      options: {
        noEmit: true,
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        esModuleInterop: true,
        skipLibCheck: true,
        types: ['jest', 'node'],
      },
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
      code: diagnostic.code,
      line:
        diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
              .line + 1
          : 0,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }));

    expect(diagnostics).toEqual([]);
  });
});
