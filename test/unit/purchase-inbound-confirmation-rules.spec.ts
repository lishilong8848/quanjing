import {
  buildNewCatalogFields,
  buildPendingPurchaseInbounds,
  buildPurchaseInboundCompletionFields,
  buildPurchaseInboundFields,
  validatePurchaseInboundCategoryPreparation,
  validatePurchaseInboundConfirmation,
} from '../../server/modules/inventory-management/purchase-inbound-confirmation.rules';
import type {
  PurchaseInboundCategoryPrepareRequest,
  PurchaseInboundConfirmRequest,
  PurchasePendingInboundItem,
} from '../../shared/inventory-management.interface';

describe('purchase inbound confirmation rules', () => {
  it('keeps only signed, positive, not-rejected and not-yet-inbound purchases', () => {
    const submissions = [
      record('sub-1', {
        采购编码: 'PR-001',
        新增物品名称: '新型滤芯',
        一级分类: 'A备品备件类',
        二级分类: '常备件A2',
        规格型号: 'MERV 8',
        品牌: '测试品牌',
        单位: '个',
      }),
    ];
    const executions = [
      execution('exec-1'),
      execution('exec-not-signed', {
        '到货签收确认（签收内容填写完成后点击）': false,
      }),
      execution('exec-rejected', { '1️⃣物品采购方式': '驳回' }),
      execution('exec-inbound', { 是否已入库: true }),
      execution('exec-zero', { 实际采购数量: 0 }),
    ];

    expect(buildPendingPurchaseInbounds({ submissions, executions })).toEqual([
      {
        executionRecordId: 'exec-1',
        submissionRecordId: 'sub-1',
        requestCode: 'PR-001',
        mode: null,
        sku: '',
        itemName: '新型滤芯',
        specification: 'MERV 8',
        brand: '测试品牌',
        primaryCategory: 'A备品备件类',
        secondaryCategory: '常备件A2',
        building: 'A楼',
        quantity: 2,
        unit: '个',
        signedAt: '2026-07-13T02:00:00.000Z',
        action: 'needs_selection',
        catalogRecordId: '',
        actionReason: '请在确认入库时选择新增或已有',
      },
    ]);
  });

  it('keeps signed purchases pending when the purchase completion flag is false', () => {
    const items = buildPendingPurchaseInbounds({
      submissions: [
        record('sub-1', {
          采购编码: 'PR-001',
          新增物品名称: '新型滤芯',
        }),
      ],
      executions: [execution('exec-warehouse', { 采购完成: false })],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      executionRecordId: 'exec-warehouse',
      action: 'needs_selection',
    });
  });

  it('uses the current purchase workflow as the signed inbound source of truth', () => {
    const pending = buildPendingPurchaseInbounds({
      submissions: [
        record('sub-1', {
          采购编码: 'PR-001',
          新增物品名称: '新型滤芯',
        }),
      ],
      executions: [
        execution('exec-current', {
          '到货签收确认（签收内容填写完成后点击）': false,
          采购流程: '到货已签收（待入库）',
        }),
        execution('exec-completed', {
          '到货签收确认（签收内容填写完成后点击）': true,
          采购流程: '采购完成（已入库）',
          是否已入库: false,
        }),
      ],
    });

    expect(pending.map((item) => item.executionRecordId)).toEqual([
      'exec-current',
    ]);
  });

  it('excludes completed sibling entries even when the legacy purchase status is stale', () => {
    const pending = buildPendingPurchaseInbounds({
      submissions: [],
      executions: [
        execution('exec-scale', {
          采购编码: 'CG260723-601',
          物品名称: '地磅秤',
          采购流程: '到货已签收（待入库）',
          是否已入库: true,
          '到货签收确认（签收内容填写完成后点击）': true,
        }),
        execution('exec-slope', {
          采购编码: 'CG260723-601',
          物品名称: '橡胶斜坡',
          采购流程: '下单完成（待签收）',
          程序采购状态: '物品签收已入库',
          '到货签收确认（签收内容填写完成后点击）': true,
        }),
      ],
    });

    expect(pending).toEqual([]);
  });

  it('keeps an execution-only purchase inbound unselected and uses execution fields', () => {
    const [pending] = buildPendingPurchaseInbounds({
      submissions: [],
      executions: [
        execution('exec-new-only', {
          采购编码: 'CG-NEW-001',
          采购流程: '到货已签收（待入库）',
          物品名称: '新风滤网',
          一级分类: '耗材类',
          二级分类: '过滤耗材A2',
          '物品规格型号、设备序列号': '592×592',
          物品品牌: '测试品牌二',
          计数单位: '片',
          实际采购数量: 3,
          申请楼栋: ['E楼'],
        }),
      ],
      catalog: [],
    });

    expect(pending).toMatchObject({
      executionRecordId: 'exec-new-only',
      requestCode: 'CG-NEW-001',
      mode: null,
      action: 'needs_selection',
      actionReason: '请在确认入库时选择新增或已有',
      itemName: '新风滤网',
      primaryCategory: '耗材类',
      secondaryCategory: '过滤耗材A2',
      specification: '592×592',
      brand: '测试品牌二',
      unit: '片',
      quantity: 3,
      building: 'E楼',
    });
  });

  it('restores a durable prepared category for the matching execution record', () => {
    const preparedRequest = {
      type: 'inbound',
      mode: 'new',
      clientMutationId: 'purchase-prepare-restore-1',
      building: 'E楼',
      quantity: 3,
      occurredAt: '2026-08-07T03:00:00.000Z',
      newItem: {
        primaryCategory: '耗材类',
        secondaryCategory: '过滤耗材A2',
        name: '新风滤网',
        specification: '592×592',
        location: 'E-1F-001',
        locationRecordId: 'location-e-001',
        brand: '测试品牌二',
        unit: '片',
        minimumQuantity: 1,
      },
    };
    const [pending] = buildPendingPurchaseInbounds({
      submissions: [],
      executions: [
        execution('exec-prepared', {
          采购编码: 'CG-PREPARED-001',
          采购流程: '到货已签收（待入库）',
          物品名称: '新风滤网',
          一级分类: '耗材类',
          二级分类: '过滤耗材A2',
          '物品规格型号、设备序列号': '592×592',
          物品品牌: '测试品牌二',
          计数单位: '片',
          实际采购数量: 3,
          申请楼栋: ['E楼'],
        }),
      ],
      catalog: [
        record('catalog-prepared', {
          入库创建标识: '采购:exec-prepared',
          入库请求指纹: 'f'.repeat(64),
          采购入库准备参数: JSON.stringify({
            version: 1,
            preparedAt: '2026-08-07T02:50:00.000Z',
            request: preparedRequest,
          }),
          物品类别号: 'A2008',
          楼栋: 'E楼',
          一级分类: '耗材类',
          二级分类: '过滤耗材A2',
          名称: '新风滤网',
          '规格型号、设备序列号': '592×592',
          品牌: '测试品牌二',
          计数单位: '片',
          最小库存量: 1,
        }),
      ],
    });

    expect(pending.preparedCategory).toEqual({
      catalogRecordId: 'catalog-prepared',
      sku: 'A2008',
      preparedAt: '2026-08-07T02:50:00.000Z',
      clientMutationId: 'purchase-prepare-restore-1',
      building: 'E楼',
      quantity: 3,
      occurredAt: '2026-08-07T03:00:00.000Z',
      newItem: preparedRequest.newItem,
    });
  });

  it('keeps legacy prepared category payloads without a location record id readable', () => {
    const preparedRequest = {
      type: 'inbound',
      mode: 'new',
      clientMutationId: 'purchase-prepare-legacy-location',
      building: 'E楼',
      quantity: 1,
      occurredAt: '2026-08-07T03:00:00.000Z',
      newItem: {
        primaryCategory: '耗材类',
        secondaryCategory: '过滤耗材A2',
        name: '旧版滤网',
        specification: '592×592',
        location: 'E-1F-009',
      },
    };
    const [pending] = buildPendingPurchaseInbounds({
      submissions: [],
      executions: [
        execution('exec-legacy-location', {
          采购编码: 'CG-LEGACY-LOCATION',
          采购流程: '到货已签收（待入库）',
          物品名称: '旧版滤网',
          实际采购数量: 1,
          申请楼栋: ['E楼'],
        }),
      ],
      catalog: [
        record('catalog-legacy-location', {
          入库创建标识: '采购:exec-legacy-location',
          入库请求指纹: 'a'.repeat(64),
          采购入库准备参数: JSON.stringify({
            version: 1,
            preparedAt: '2026-08-07T02:50:00.000Z',
            request: preparedRequest,
          }),
          物品类别号: 'A2007',
          楼栋: 'E楼',
          一级分类: '耗材类',
          二级分类: '过滤耗材A2',
          名称: '旧版滤网',
          '规格型号、设备序列号': '592×592',
        }),
      ],
    });

    expect(pending.preparedCategory?.newItem).toEqual(preparedRequest.newItem);
    expect(pending.preparedCategory?.newItem).not.toHaveProperty(
      'locationRecordId',
    );
  });

  it('rejects duplicate prepared categories for one purchase execution', () => {
    const fields = {
      入库创建标识: '采购:exec-duplicate-prepare',
      入库请求指纹: 'f'.repeat(64),
      采购入库准备参数: JSON.stringify({
        version: 1,
        preparedAt: '2026-08-07T02:50:00.000Z',
        request: {
          type: 'inbound',
          mode: 'new',
          clientMutationId: 'duplicate-prepare',
          building: 'A楼',
          quantity: 2,
          occurredAt: '2026-08-07T03:00:00.000Z',
          newItem: {
            primaryCategory: 'A备品备件类',
            secondaryCategory: '常备件A2',
            name: '新型滤芯',
            specification: 'MERV 8',
            location: 'A-1F-001',
          },
        },
      }),
      物品类别号: 'A2008',
      楼栋: 'A楼',
      一级分类: 'A备品备件类',
      二级分类: '常备件A2',
      名称: '新型滤芯',
      '规格型号、设备序列号': 'MERV 8',
    };

    expect(() =>
      buildPendingPurchaseInbounds({
        submissions: [],
        executions: [execution('exec-duplicate-prepare')],
        catalog: [
          record('catalog-prepare-1', fields),
          record('catalog-prepare-2', fields),
        ],
      }),
    ).toThrow('同一采购执行存在重复的预备物品类别');
  });

  it('prefers each execution row over ambiguous legacy submissions sharing one request code', () => {
    const items = buildPendingPurchaseInbounds({
      submissions: [
        record('sub-first', {
          采购编码: 'CG-BATCH-001',
          新增物品名称: '不应串入的第一项',
          规格型号: 'WRONG-1',
        }),
        record('sub-second', {
          采购编码: 'CG-BATCH-001',
          新增物品名称: '不应串入的第二项',
          规格型号: 'WRONG-2',
        }),
      ],
      executions: [
        execution('exec-batch-a', {
          采购编码: 'CG-BATCH-001',
          物品名称: '执行明细甲',
          '物品规格型号、设备序列号': 'EXEC-A',
        }),
        execution('exec-batch-b', {
          采购编码: 'CG-BATCH-001',
          物品名称: '执行明细乙',
          '物品规格型号、设备序列号': 'EXEC-B',
        }),
      ],
    });

    expect(items.map((item) => [item.itemName, item.specification])).toEqual([
      ['执行明细甲', 'EXEC-A'],
      ['执行明细乙', 'EXEC-B'],
    ]);
  });

  it('does not auto-select existing even when one warehouse category matches', () => {
    const items = buildPendingPurchaseInbounds({
      submissions: [
        record('sub-1', {
          采购编码: 'PR-001',
          非新增物品名称: '塑料外壳式断路器附件',
        }),
      ],
      executions: [
        execution('exec-existing', {
          '物品类别码（库房）': { text: 'A1001' },
        }),
      ],
      catalog: [
        record('catalog-a1001', {
          物品类别号: 'A1001',
          名称: '塑料外壳式断路器附件',
          楼栋: ['A楼'],
        }),
      ],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      mode: null,
      sku: 'A1001',
      action: 'needs_selection',
      catalogRecordId: '',
      actionReason: '请在确认入库时选择新增或已有',
    });
  });

  it('keeps the execution item name without auto-selecting a type when SKU exists', () => {
    const items = buildPendingPurchaseInbounds({
      submissions: [
        record('sub-1', {
          采购编码: 'PR-001',
          新增物品名称: '塑料外壳式断路器附件',
        }),
      ],
      executions: [
        execution('exec-existing', {
          物品类别码: 'A1001',
          物品名称: '塑料外壳式断路器附件',
        }),
      ],
      catalog: [
        record('catalog-a1001', {
          物品类别号: 'A1001',
          名称: '塑料外壳式断路器附件',
          楼栋: ['A楼'],
        }),
      ],
    });

    expect(items[0]).toMatchObject({
      mode: null,
      action: 'needs_selection',
      catalogRecordId: '',
      itemName: '塑料外壳式断路器附件',
    });
  });

  it('requires manual type selection regardless of old category mapping signals', () => {
    const base = {
      submissions: [
        record('sub-1', {
          采购编码: 'PR-001',
          非新增物品名称: '塑料外壳式断路器附件',
        }),
      ],
      executions: [execution('exec-existing', { 物品类别码: 'A1001' })],
    };

    expect(
      buildPendingPurchaseInbounds({ ...base, catalog: [] })[0],
    ).toMatchObject({
      mode: null,
      action: 'needs_selection',
      catalogRecordId: '',
      actionReason: '请在确认入库时选择新增或已有',
    });
    expect(
      buildPendingPurchaseInbounds({
        ...base,
        catalog: [
          record('catalog-1', { 物品类别号: 'A1001', 楼栋: ['A楼'] }),
          record('catalog-2', { 物品类别号: 'a1001', 楼栋: ['A楼'] }),
        ],
      })[0],
    ).toMatchObject({
      mode: null,
      action: 'needs_selection',
      catalogRecordId: '',
      actionReason: '请在确认入库时选择新增或已有',
    });
  });

  it('indexes warehouse categories once instead of rescanning them per execution', () => {
    const catalogSize = 12;
    const executionSize = 30;
    let catalogFieldReads = 0;
    const catalog = Array.from(
      { length: catalogSize },
      (_, index) =>
        new Proxy(
          record(`catalog-${index}`, {
            物品类别号: `SKU-${index}`,
            楼栋: ['A楼'],
          }),
          {
            get(target, property, receiver) {
              if (property === 'fields') catalogFieldReads += 1;
              return Reflect.get(target, property, receiver);
            },
          },
        ),
    );
    const submissions = Array.from({ length: executionSize }, (_, index) =>
      record(`submission-${index}`, {
        采购编码: `PR-${index}`,
        非新增物品名称: `物品-${index}`,
      }),
    );
    const executions = Array.from({ length: executionSize }, (_, index) =>
      record(`execution-${index}`, {
        采购编码: `PR-${index}`,
        物品类别码: `SKU-${index % catalogSize}`,
        申请楼栋: ['A楼'],
        实际采购数量: 1,
        是否已入库: false,
        '到货签收确认（签收内容填写完成后点击）': true,
      }),
    );

    const items = buildPendingPurchaseInbounds({
      submissions,
      executions,
      catalog,
    });

    expect(items).toHaveLength(executionSize);
    expect(items.every((item) => item.action === 'needs_selection')).toBe(true);
    expect(items.map((item) => item.executionRecordId)).toEqual(
      executions.map((item) => item.record_id),
    );
    expect(catalogFieldReads).toBeLessThanOrEqual(catalogSize * 2);
  });

  it('excludes the completed receipt status for records without the legacy checkbox', () => {
    const items = buildPendingPurchaseInbounds({
      submissions: [
        record('sub-1', { 采购编码: 'PR-001', 新增物品名称: '新型滤芯' }),
      ],
      executions: [
        execution('exec-legacy', {
          采购完成: false,
          '到货签收确认（签收内容填写完成后点击）': false,
          程序采购状态: '物品签收已入库',
        }),
      ],
    });

    expect(items).toHaveLength(0);
  });

  it('builds target-building fields with a server-generated SKU and scalar select values', () => {
    const pending = buildPendingPurchaseInbounds({
      submissions: [
        record('sub-1', {
          采购编码: 'PR-001',
          新增物品名称: '新型滤芯',
          一级分类: 'A备品备件类',
          二级分类: '常备件A2',
          规格型号: 'MERV 8',
          品牌: '测试品牌',
          单位: '个',
        }),
      ],
      executions: [execution('exec-1')],
    })[0];
    const request = {
      executionRecordId: 'exec-1',
      mode: 'new' as const,
      building: 'B楼' as const,
      clientMutationId: 'purchase-new-fields-1',
      quantity: 3,
      occurredAt: '2026-07-13T03:00:00.000Z',
      newItem: {
        name: '新型滤芯',
        primaryCategory: 'A备品备件类',
        secondaryCategory: '常备件A2',
        specification: 'MERV 8',
        location: 'B-1F-009',
        brand: '测试品牌',
        unit: '个',
        minimumQuantity: 1,
      },
    };

    const buildCatalog = buildNewCatalogFields as unknown as (
      input: PurchaseInboundConfirmRequest,
      source: PurchasePendingInboundItem,
      generatedSku: string,
    ) => Record<string, unknown>;
    const buildInbound = buildPurchaseInboundFields as unknown as (
      input: PurchaseInboundConfirmRequest,
      source: PurchasePendingInboundItem,
      generatedSku: string,
    ) => Record<string, unknown>;

    expect(buildCatalog(request, pending, 'A2009')).toEqual({
      物品类别号: 'A2009',
      名称: '新型滤芯',
      楼栋: 'B楼',
      一级分类: 'A备品备件类',
      二级分类: '常备件A2',
      '规格型号、设备序列号': 'MERV 8',
      品牌: '测试品牌',
      计数单位: '个',
      最小库存量: 1,
    });
    expect(buildInbound(request, pending, 'A2009')).toEqual({
      物品类别号: 'A2009',
      入库数量: 3,
      楼栋: 'B楼',
      入库日期: Date.parse('2026-07-13T03:00:00.000Z'),
      入库来源: '采购:exec-1',
    });
    const buildCompletion =
      buildPurchaseInboundCompletionFields as unknown as (input: {
        sku: string;
        quantity: number;
      }) => Record<string, unknown>;
    expect(buildCompletion({ sku: 'A2009', quantity: 3 })).toEqual({
      物品类别码: 'A2009',
      实际采购数量: 3,
      是否已入库: true,
      采购流程: '采购完成（已入库）',
      程序采购状态: '物品签收已入库',
    });
  });

  it('accepts a strict new-item request with a prepared category', () => {
    const pending = buildPendingPurchaseInbounds({
      submissions: [
        record('sub-1', {
          采购编码: 'PR-001',
          新增物品名称: '新品',
        }),
      ],
      executions: [execution('exec-1')],
    })[0];
    const request: PurchaseInboundConfirmRequest = {
      executionRecordId: 'exec-1',
      mode: 'new',
      building: 'B楼',
      clientMutationId: 'purchase-new-valid-1',
      preparedCatalogRecordId: 'catalog-prepared-1',
      generatedSku: 'A2009',
      quantity: 2,
      occurredAt: '2026-07-13T03:00:00.000Z',
      newItem: {
        name: '新品',
        primaryCategory: 'A备品备件类',
        secondaryCategory: '常备件A2',
        specification: 'MERV 8',
        location: 'B-1F-001',
        brand: '测试品牌',
        unit: '个',
        minimumQuantity: 0,
      },
    };

    expect(() =>
      validatePurchaseInboundConfirmation(request, pending, []),
    ).not.toThrow();
  });

  it('requires a selected bottom-table location before preparing a new category', () => {
    const pending = buildPendingPurchaseInbounds({
      submissions: [record('sub-1', { 采购编码: 'PR-001' })],
      executions: [execution('exec-1')],
    })[0];
    const request: PurchaseInboundCategoryPrepareRequest = {
      executionRecordId: 'exec-1',
      building: 'B楼',
      clientMutationId: 'purchase-prepare-location-required',
      quantity: 2,
      occurredAt: '2026-07-13T03:00:00.000Z',
      newItem: {
        name: '新品',
        primaryCategory: 'A备品备件类',
        secondaryCategory: '常备件A2',
        specification: 'MERV 8',
        location: 'B-1F-001',
      },
    };

    expect(() =>
      validatePurchaseInboundCategoryPreparation(request, pending),
    ).toThrow('请选择底表中的存放位置');
  });

  it('rejects a strict new-item request before a category number is prepared', () => {
    const pending = buildPendingPurchaseInbounds({
      submissions: [record('sub-1', { 采购编码: 'PR-001' })],
      executions: [execution('exec-1')],
    })[0];
    const request = {
      executionRecordId: 'exec-1',
      mode: 'new',
      building: 'B楼',
      clientMutationId: 'purchase-new-without-prepared-category',
      quantity: 2,
      occurredAt: '2026-07-13T03:00:00.000Z',
      newItem: {
        name: '新品',
        primaryCategory: 'A备品备件类',
        secondaryCategory: '常备件A2',
        specification: 'MERV 8',
        location: 'B-1F-001',
      },
    } as PurchaseInboundConfirmRequest;

    expect(() =>
      validatePurchaseInboundConfirmation(request, pending, []),
    ).toThrow('请先生成新的物品类别号');
  });

  it.each([
    ['target building', 'building', '请选择目标楼栋'],
    ['client mutation id', 'clientMutationId', '请求标识不能为空'],
  ])(
    'requires a strict purchase request %s',
    (_label, missingField, expectedMessage) => {
      const pending = buildPendingPurchaseInbounds({
        submissions: [
          record('sub-1', {
            采购编码: 'PR-001',
            新增物品名称: '新品',
          }),
        ],
        executions: [execution('exec-1')],
      })[0];
      const request: Record<string, unknown> = {
        executionRecordId: 'exec-1',
        mode: 'new',
        building: 'B楼',
        clientMutationId: 'purchase-new-required-fields',
        quantity: 2,
        occurredAt: '2026-07-13T03:00:00.000Z',
        newItem: {
          name: '新品',
          primaryCategory: 'A备品备件类',
          secondaryCategory: '常备件A2',
          specification: 'MERV 8',
          location: 'B-1F-001',
        },
      };
      delete request[missingField];

      expect(() =>
        validatePurchaseInboundConfirmation(
          request as unknown as PurchaseInboundConfirmRequest,
          pending,
          [],
        ),
      ).toThrow(expectedMessage);
    },
  );

  it.each([
    ['name', 'name', '请填写物品名称'],
    ['primary category', 'primaryCategory', '请选择完整物品分类'],
    ['secondary category', 'secondaryCategory', '请选择完整物品分类'],
    ['specification', 'specification', '请填写规格型号'],
    ['location', 'location', '请填写目标库位'],
  ])(
    'requires the strict new-item base field %s',
    (_label, missingField, expectedMessage) => {
      const pending = buildPendingPurchaseInbounds({
        submissions: [
          record('sub-1', {
            采购编码: 'PR-001',
            新增物品名称: '新品',
          }),
        ],
        executions: [execution('exec-1')],
      })[0];
      const newItem: Record<string, unknown> = {
        name: '新品',
        primaryCategory: 'A备品备件类',
        secondaryCategory: '常备件A2',
        specification: 'MERV 8',
        location: 'B-1F-001',
      };
      newItem[missingField] = '';

      expect(() =>
        validatePurchaseInboundConfirmation(
          {
            executionRecordId: 'exec-1',
            mode: 'new',
            building: 'B楼',
            clientMutationId: `purchase-new-missing-${missingField}`,
            quantity: 2,
            occurredAt: '2026-07-13T03:00:00.000Z',
            newItem,
          } as unknown as PurchaseInboundConfirmRequest,
          pending,
          [],
        ),
      ).toThrow(expectedMessage);
    },
  );

  it('rejects a client-provided SKU for a strict new-item request', () => {
    const pending = buildPendingPurchaseInbounds({
      submissions: [
        record('sub-1', {
          采购编码: 'PR-001',
          新增物品名称: '新品',
        }),
      ],
      executions: [execution('exec-1')],
    })[0];
    const request = {
      executionRecordId: 'exec-1',
      mode: 'new',
      building: 'B楼',
      clientMutationId: 'purchase-new-manual-sku',
      sku: 'A2999',
      quantity: 2,
      occurredAt: '2026-07-13T03:00:00.000Z',
      newItem: {
        name: '新品',
        primaryCategory: 'A备品备件类',
        secondaryCategory: '常备件A2',
        specification: 'MERV 8',
        location: 'B-1F-001',
      },
    } as unknown as PurchaseInboundConfirmRequest;

    expect(() =>
      validatePurchaseInboundConfirmation(request, pending, []),
    ).toThrow('新增物品类别号由服务端生成');
  });

  it('validates an existing catalog against the requested target building', () => {
    const pending = buildPendingPurchaseInbounds({
      submissions: [
        record('sub-1', {
          采购编码: 'PR-001',
          非新增物品名称: '已有物品',
        }),
      ],
      executions: [execution('exec-1', { 物品类别码: 'A2001' })],
    })[0];
    const request: PurchaseInboundConfirmRequest = {
      executionRecordId: 'exec-1',
      mode: 'existing',
      building: 'B楼',
      clientMutationId: 'purchase-existing-b-building',
      catalogRecordId: 'catalog-b',
      sku: 'A2001',
      quantity: 2,
      occurredAt: '2026-07-13T03:00:00.000Z',
    };

    expect(() =>
      validatePurchaseInboundConfirmation(request, pending, [
        record('catalog-b', { 物品类别号: 'A2001', 楼栋: 'B楼' }),
      ]),
    ).not.toThrow();
  });

  it('accepts an operator-selected existing mode even when the legacy pending hint is new', () => {
    const pending = buildPendingPurchaseInbounds({
      submissions: [
        record('sub-new-hint', {
          采购编码: 'PR-001',
          新增物品名称: '旧数据提示为新品',
        }),
      ],
      executions: [execution('exec-manual-existing')],
    })[0];
    const request: PurchaseInboundConfirmRequest = {
      executionRecordId: 'exec-manual-existing',
      mode: 'existing',
      building: 'A楼',
      clientMutationId: 'purchase-manual-existing',
      catalogRecordId: 'catalog-a',
      sku: 'A2001',
      quantity: 2,
      occurredAt: '2026-07-13T03:00:00.000Z',
    };

    expect(() =>
      validatePurchaseInboundConfirmation(request, pending, [
        record('catalog-a', { 物品类别号: 'A2001', 楼栋: 'A楼' }),
      ]),
    ).not.toThrow();
  });

  it('rejects legacy new-item requests instead of accepting a hand-written SKU path', () => {
    const pending = buildPendingPurchaseInbounds({
      submissions: [
        record('sub-1', {
          采购编码: 'PR-001',
          新增物品名称: '新品',
        }),
      ],
      executions: [execution('exec-1')],
    })[0];
    const request: PurchaseInboundConfirmRequest = {
      executionRecordId: 'exec-1',
      mode: 'new',
      sku: 'A2999',
      quantity: 2,
      occurredAt: '2026-07-13T03:00:00.000Z',
      newItem: {
        name: '新品',
        primaryCategory: 'A备品备件类',
        secondaryCategory: '常备件A2',
        specification: 'MERV 8',
        location: 'A-1F-001',
        brand: '测试品牌',
        unit: '个',
        minimumQuantity: 0,
      },
    };

    expect(() =>
      validatePurchaseInboundConfirmation(request, pending, []),
    ).toThrow('请刷新页面后提供目标楼栋和请求标识');
  });

  it('rejects an inbound quantity above the signed purchase quantity', () => {
    const pending = buildPendingPurchaseInbounds({
      submissions: [
        record('sub-1', { 采购编码: 'PR-001', 新增物品名称: '新品' }),
      ],
      executions: [execution('exec-1', { 实际采购数量: 2 })],
    })[0];

    expect(() =>
      validatePurchaseInboundConfirmation(
        {
          executionRecordId: 'exec-1',
          mode: 'new',
          building: 'A楼',
          clientMutationId: 'purchase-over-quantity',
          quantity: 3,
          occurredAt: '2026-07-13T03:00:00.000Z',
          newItem: {
            name: '新品',
            primaryCategory: 'A备品备件类',
            secondaryCategory: '常备件A2',
            specification: 'MERV 8',
            location: 'A-1F-001',
            brand: '',
            unit: '个',
            minimumQuantity: 0,
          },
        },
        pending,
        [],
      ),
    ).toThrow('确认入库数量不能超过实际签收数量（2）');
  });

  it('rejects a negative optional minimum quantity for a strict new item', () => {
    const pending = buildPendingPurchaseInbounds({
      submissions: [
        record('sub-1', { 采购编码: 'PR-001', 新增物品名称: '新品' }),
      ],
      executions: [execution('exec-1')],
    })[0];

    expect(() =>
      validatePurchaseInboundConfirmation(
        {
          executionRecordId: 'exec-1',
          mode: 'new',
          building: 'A楼',
          clientMutationId: 'purchase-negative-minimum',
          quantity: 2,
          occurredAt: '2026-07-13T03:00:00.000Z',
          newItem: {
            name: '新品',
            primaryCategory: 'A备品备件类',
            secondaryCategory: '常备件A2',
            specification: 'MERV 8',
            location: 'A-1F-001',
            brand: '',
            unit: '个',
            minimumQuantity: -1,
          },
        },
        pending,
        [],
      ),
    ).toThrow('最小库存量不得为负数');
  });
});

function execution(recordId: string, overrides: Record<string, unknown> = {}) {
  return record(recordId, {
    采购编码: 'PR-001',
    物品名称: '新型滤芯',
    申请楼栋: ['A楼'],
    一级分类: 'A备品备件类',
    二级分类: '常备件A2',
    '物品规格型号、设备序列号': 'MERV 8',
    物品品牌: '测试品牌',
    计数单位: '个',
    实际采购数量: 2,
    采购完成: true,
    是否已入库: false,
    '到货签收确认（签收内容填写完成后点击）': true,
    签收时间: Date.parse('2026-07-13T02:00:00.000Z'),
    ...overrides,
  });
}

function record(recordId: string, fields: Record<string, unknown>) {
  return { record_id: recordId, fields };
}
