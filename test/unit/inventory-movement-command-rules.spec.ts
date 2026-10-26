import { BadRequestException } from '@nestjs/common';
import type {
  InventoryMovementCreateRequest,
  InventoryMovementOptionItem,
  InventoryOutboundMovementItem,
  InventoryOutboundMovementCreateRequest,
} from '../../shared/inventory-management.interface';
import {
  buildMovementCreateFields,
  buildMovementOptions,
  validateMovementCreateRequest,
} from '../../server/modules/inventory-management/inventory-movement-command.rules';

const OPTION: InventoryMovementOptionItem = {
  catalogRecordId: 'catalog-a101',
  inventoryRecordId: 'inventory-a101',
  sku: 'A101',
  name: '测试滤芯',
  specification: 'MERV 8',
  brand: '测试品牌',
  primaryCategory: '耗材',
  secondaryCategory: '过滤器',
  building: 'A楼',
  location: 'A-1F-001',
  unit: '个',
  availableQuantity: 5,
};

const BASE_REQUEST: InventoryOutboundMovementCreateRequest = {
  type: 'outbound',
  clientMutationId: 'outbound-create-1',
  catalogRecordId: 'catalog-a101',
  sku: 'A101',
  building: 'A楼',
  quantity: 2,
  occurredAt: '2026-07-12T10:00:00.000Z',
  applicantOpenId: 'ou_applicant',
  reason: 'B楼现场更换',
};

describe('inventory movement command rules', () => {
  it('narrows outbound movement type and status', () => {
    const movementType: InventoryOutboundMovementItem['type'] = 'outbound';
    const routingStatus: InventoryOutboundMovementItem['status'] = '待路由';
    const approvalStatus: InventoryOutboundMovementItem['status'] = '待审批';
    const pendingStatus: InventoryOutboundMovementItem['status'] = '待库房确认';
    const rejectedStatus: InventoryOutboundMovementItem['status'] = '已驳回';
    const completedStatus: InventoryOutboundMovementItem['status'] = '已出库';
    if (false) {
      // @ts-expect-error 出库状态只能是审批工作流的五个业务状态
      const legacyStatus: InventoryOutboundMovementItem['status'] =
        '跨楼栋待确认';
      void legacyStatus;
    }

    expect([
      movementType,
      routingStatus,
      approvalStatus,
      pendingStatus,
      rejectedStatus,
      completedStatus,
    ]).toEqual([
      'outbound',
      '待路由',
      '待审批',
      '待库房确认',
      '已驳回',
      '已出库',
    ]);
  });

  it('uses the writable inbound-location text field before the legacy select field', () => {
    const [option] = buildMovementOptions({
      type: 'inbound',
      building: 'A楼',
      catalog: [
        {
          record_id: 'catalog-a101',
          fields: {
            物品类别号: 'A101',
            名称: '测试滤芯',
            楼栋: 'A楼',
          },
        },
      ],
      inventory: [
        {
          record_id: 'inventory-a101',
          fields: {
            物品类别号: 'A101',
            楼栋: 'A楼',
            存放位置: '旧单选库位',
            入库存放位置: 'A-1F-001',
          },
        },
      ],
    });

    expect(option).toMatchObject({
      inventoryRecordId: 'inventory-a101',
      location: 'A-1F-001',
    });
  });

  it('reads the configured inventory location before the legacy field and falls back when absent', () => {
    const envName = 'FEISHU_WAREHOUSE_INVENTORY_LOCATION_FIELD_NAME';
    const original = process.env[envName];
    process.env[envName] = '迁移后存放位置';

    try {
      const options = buildMovementOptions({
        type: 'inbound',
        building: 'A楼',
        catalog: [
          {
            record_id: 'catalog-a101',
            fields: { 物品类别号: 'A101', 名称: '配置字段', 楼栋: 'A楼' },
          },
          {
            record_id: 'catalog-a102',
            fields: { 物品类别号: 'A102', 名称: '旧字段', 楼栋: 'A楼' },
          },
        ],
        inventory: [
          {
            record_id: 'inventory-a101',
            fields: {
              物品类别号: 'A101',
              楼栋: 'A楼',
              迁移后存放位置: 'A-NEW',
              存放位置: 'A-LEGACY',
            },
          },
          {
            record_id: 'inventory-a102',
            fields: {
              物品类别号: 'A102',
              楼栋: 'A楼',
              存放位置: 'A-FALLBACK',
            },
          },
        ],
      });

      expect(options.map(({ sku, location }) => ({ sku, location }))).toEqual([
        { sku: 'A101', location: 'A-NEW' },
        { sku: 'A102', location: 'A-FALLBACK' },
      ]);
    } finally {
      if (original === undefined) delete process.env[envName];
      else process.env[envName] = original;
    }
  });

  it('keeps zero-stock outbound options searchable within the source building', () => {
    const options = buildMovementOptions({
      type: 'outbound',
      building: 'A楼',
      catalog: [
        {
          record_id: 'catalog-a101',
          fields: { 物品类别号: 'A101', 名称: '有库存', 楼栋: 'A楼' },
        },
        {
          record_id: 'catalog-a102',
          fields: { 物品类别号: 'A102', 名称: '无库存', 楼栋: 'A楼' },
        },
        {
          record_id: 'catalog-b101',
          fields: { 物品类别号: 'B101', 名称: '其它楼栋', 楼栋: 'B楼' },
        },
      ],
      inventory: [
        {
          record_id: 'inventory-a101',
          fields: { 物品类别号: 'A101', 楼栋: 'A楼', 剩余库存: 2 },
        },
        {
          record_id: 'inventory-a102',
          fields: { 物品类别号: 'A102', 楼栋: 'A楼', 剩余库存: 0 },
        },
        {
          record_id: 'inventory-b101',
          fields: { 物品类别号: 'B101', 楼栋: 'B楼', 剩余库存: 3 },
        },
      ],
    });

    expect(options).toEqual([
      expect.objectContaining({
        catalogRecordId: 'catalog-a101',
        building: 'A楼',
        availableQuantity: 2,
      }),
      expect.objectContaining({
        catalogRecordId: 'catalog-a102',
        building: 'A楼',
        availableQuantity: 0,
      }),
    ]);
  });

  it('fails closed instead of summing duplicate inventory rows for the same building and sku', () => {
    const [option] = buildMovementOptions({
      type: 'outbound',
      building: 'A楼',
      catalog: [
        {
          record_id: 'catalog-a2026',
          fields: { 物品类别号: 'A2026', 名称: '二次熔断器', 楼栋: 'A楼' },
        },
      ],
      inventory: [
        {
          record_id: 'inventory-a2026-zero',
          fields: { 物品类别号: 'A2026', 楼栋: 'A楼', 剩余库存: 0 },
        },
        {
          record_id: 'inventory-a2026-stale',
          fields: { 物品类别号: 'A2026', 楼栋: 'A楼', 剩余库存: 36 },
        },
      ],
    });

    expect(option).toEqual(
      expect.objectContaining({
        sku: 'A2026',
        availableQuantity: 0,
        inventoryRecordId: '',
        stockConsistencyError:
          '当前楼栋存在重复库存台账，请先合并或清理后再办理库存操作',
      }),
    );
    expect(() =>
      validateMovementCreateRequest(BASE_REQUEST, {
        ...option,
        catalogRecordId: BASE_REQUEST.catalogRecordId,
        sku: BASE_REQUEST.sku,
      }),
    ).toThrow(
      new BadRequestException(
        '当前楼栋存在重复库存台账，请先合并或清理后再办理库存操作',
      ),
    );
  });

  it('does not truncate an explicitly requested complete building snapshot', () => {
    const catalog = Array.from({ length: 10_001 }, (_, index) => ({
      record_id: `catalog-${index}`,
      fields: {
        物品类别号: `A${String(index).padStart(4, '0')}`,
        名称: `物品 ${index}`,
        楼栋: 'A楼',
      },
    }));

    expect(
      buildMovementOptions({
        type: 'outbound',
        building: 'A楼',
        catalog,
        inventory: [],
        limit: 0,
      }),
    ).toHaveLength(10_001);
  });

  it('rejects incomplete, fractional, and excessive outbound requests', () => {
    const { clientMutationId: omittedClientMutationId, ...missingMutationId } =
      BASE_REQUEST;
    void omittedClientMutationId;

    expect(() =>
      validateMovementCreateRequest(
        missingMutationId as unknown as InventoryMovementCreateRequest,
        OPTION,
        new Date('2026-07-12T09:00:00.000Z'),
      ),
    ).toThrow(new BadRequestException('请求标识不能为空'));

    expect(() =>
      validateMovementCreateRequest(
        { ...BASE_REQUEST, applicantOpenId: '' },
        OPTION,
        new Date('2026-07-12T09:00:00.000Z'),
      ),
    ).toThrow(new BadRequestException('请选择物品申请人'));

    expect(() =>
      validateMovementCreateRequest(
        { ...BASE_REQUEST, reason: '   ' },
        OPTION,
        new Date('2026-07-12T09:00:00.000Z'),
      ),
    ).toThrow(new BadRequestException('请填写出库原因或使用地点'));

    expect(() =>
      validateMovementCreateRequest(
        { ...BASE_REQUEST, quantity: 1.5 },
        OPTION,
        new Date('2026-07-12T09:00:00.000Z'),
      ),
    ).toThrow(new BadRequestException('数量必须为正整数'));

    expect(() =>
      validateMovementCreateRequest(
        { ...BASE_REQUEST, quantity: 6 },
        OPTION,
        new Date('2026-07-12T09:00:00.000Z'),
      ),
    ).toThrow(new BadRequestException('当前可用库存为 5 个，不能办理 6 个'));
  });

  it('rejects quantities outside the safe integer range', () => {
    expect(() =>
      validateMovementCreateRequest(
        { ...BASE_REQUEST, quantity: Number.MAX_SAFE_INTEGER + 1 },
        OPTION,
      ),
    ).toThrow(new BadRequestException('数量必须为安全的正整数'));
  });

  it.each([
    ['null request', null],
    ['array request', []],
    ['primitive request', 1],
    ['numeric mutation id', { ...BASE_REQUEST, clientMutationId: 123 }],
    [
      'null new item',
      {
        type: 'inbound',
        mode: 'new',
        clientMutationId: 'manual-new-1',
        building: 'A楼',
        quantity: 1,
        occurredAt: BASE_REQUEST.occurredAt,
        newItem: null,
      },
    ],
    ['numeric sku', { ...BASE_REQUEST, sku: 123 }],
    ['numeric reason', { ...BASE_REQUEST, reason: 123 }],
    ['numeric applicant', { ...BASE_REQUEST, applicantOpenId: 123 }],
    ['numeric occurredAt', { ...BASE_REQUEST, occurredAt: 123 }],
  ])('rejects malformed runtime JSON: %s', (_label, request) => {
    expect(() =>
      validateMovementCreateRequest(
        request as unknown as InventoryMovementCreateRequest,
        OPTION,
      ),
    ).toThrow(BadRequestException);
  });

  it.each(['2026-07-12', '2026-07-12 18:00:00+08:00', '2026-07-12T18:00:00'])(
    'rejects ambiguous outbound business time %s',
    (occurredAt) => {
      expect(() =>
        validateMovementCreateRequest({ ...BASE_REQUEST, occurredAt }, OPTION),
      ).toThrow(new BadRequestException('请选择有效 ISO 8601 业务时间'));
    },
  );

  it('accepts an outbound business time with an explicit offset', () => {
    expect(() =>
      validateMovementCreateRequest(
        { ...BASE_REQUEST, occurredAt: '2026-07-12T18:00:00+08:00' },
        OPTION,
      ),
    ).not.toThrow();
  });

  it('rejects a stale catalog/building selection', () => {
    expect(() =>
      validateMovementCreateRequest(
        { ...BASE_REQUEST, building: 'B楼' },
        OPTION,
        new Date('2026-07-12T09:00:00.000Z'),
      ),
    ).toThrow(new BadRequestException('所选物品不属于当前楼栋，请重新选择'));
  });

  it('rejects an invalid source building', () => {
    expect(() =>
      validateMovementCreateRequest(
        {
          ...BASE_REQUEST,
          building: 'Z楼',
        } as unknown as InventoryMovementCreateRequest,
        OPTION,
        new Date('2026-07-12T09:00:00.000Z'),
      ),
    ).toThrow(new BadRequestException('请选择有效楼栋'));
  });

  it('rejects an outbound payload containing the legacy destination field', () => {
    expect(() =>
      validateMovementCreateRequest(
        {
          ...BASE_REQUEST,
          destinationBuilding: '',
        } as unknown as InventoryMovementCreateRequest,
        OPTION,
        new Date('2026-07-12T09:00:00.000Z'),
      ),
    ).toThrow(new BadRequestException('出库申请不允许包含去向楼栋'));
  });

  it('rejects a strict inbound runtime payload without clientMutationId', () => {
    const request = {
      type: 'inbound',
      mode: 'existing',
      catalogRecordId: OPTION.catalogRecordId,
      sku: OPTION.sku,
      building: 'A楼',
      quantity: 3,
      occurredAt: '2026-07-12T10:00:00.000Z',
    } as unknown as InventoryMovementCreateRequest;

    expect(() => validateMovementCreateRequest(request, OPTION)).toThrow(
      new BadRequestException('请求标识不能为空'),
    );
  });

  it('requires a same-building inventory ledger and a configured location for strict existing inbound', () => {
    const request: InventoryMovementCreateRequest = {
      type: 'inbound',
      mode: 'existing',
      clientMutationId: 'manual-existing-1',
      catalogRecordId: OPTION.catalogRecordId,
      sku: OPTION.sku,
      building: 'A楼',
      quantity: 3,
      occurredAt: '2026-07-12T10:00:00.000Z',
    };

    expect(() =>
      validateMovementCreateRequest(request, {
        ...OPTION,
        inventoryRecordId: '',
      }),
    ).toThrow(new BadRequestException('当前楼栋未配置库存台账，请先配置库位'));
    expect(() =>
      validateMovementCreateRequest(request, {
        ...OPTION,
        location: '',
      }),
    ).toThrow(
      new BadRequestException('当前楼栋库存台账缺少存放位置，请先配置库位'),
    );
    expect(() =>
      validateMovementCreateRequest(request, { ...OPTION, building: 'B楼' }),
    ).toThrow(new BadRequestException('所选物品不属于当前楼栋，请重新选择'));
  });

  it('rejects outbound stock whose inventory ledger has no storage location', () => {
    expect(() =>
      validateMovementCreateRequest(BASE_REQUEST, {
        ...OPTION,
        location: '  ',
      }),
    ).toThrow(
      new BadRequestException('当前楼栋库存台账缺少存放位置，请先配置库位'),
    );
  });

  it('accepts a complete strict new inbound without trusting client catalog identity', () => {
    const request = {
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
        locationRecordId: 'rec-location-a-001',
      },
    } as unknown as InventoryMovementCreateRequest;

    expect(() =>
      validateMovementCreateRequest(request, undefined),
    ).not.toThrow();
  });

  it.each([
    ['clientMutationId', { clientMutationId: ' ' }, '请求标识不能为空'],
    [
      'primary category',
      { newItem: { primaryCategory: '' } },
      '请选择完整物品分类',
    ],
    [
      'secondary category',
      { newItem: { secondaryCategory: '' } },
      '请选择完整物品分类',
    ],
    ['name', { newItem: { name: '' } }, '请填写物品名称'],
    ['specification', { newItem: { specification: '' } }, '请填写规格型号'],
    ['location', { newItem: { location: '' } }, '请配置存放位置'],
  ])('rejects strict new inbound with missing %s', (_label, patch, message) => {
    const { newItem: newItemPatch, ...requestPatch } = patch as {
      clientMutationId?: string;
      newItem?: Partial<{
        primaryCategory: string;
        secondaryCategory: string;
        name: string;
        specification: string;
        location: string;
        locationRecordId: string;
      }>;
    };
    const newItem = {
      primaryCategory: '机房耗材',
      secondaryCategory: '过滤器 A2',
      name: '新风滤芯',
      specification: 'MERV 8',
      location: 'A-1F-001',
      locationRecordId: 'rec-location-a-001',
      ...(newItemPatch || {}),
    };
    const request = {
      type: 'inbound',
      mode: 'new',
      clientMutationId: 'manual-new-1',
      building: 'A楼',
      quantity: 3,
      occurredAt: '2026-07-12T10:00:00.000Z',
      newItem,
      ...requestPatch,
    } as InventoryMovementCreateRequest;

    expect(() => validateMovementCreateRequest(request, undefined)).toThrow(
      new BadRequestException(message),
    );
  });

  it('requires a future expected return and an operator for borrowing', () => {
    const borrow: InventoryMovementCreateRequest = {
      type: 'borrow',
      catalogRecordId: BASE_REQUEST.catalogRecordId,
      sku: BASE_REQUEST.sku,
      building: BASE_REQUEST.building,
      quantity: BASE_REQUEST.quantity,
      occurredAt: BASE_REQUEST.occurredAt,
      applicantOpenId: BASE_REQUEST.applicantOpenId,
      reason: BASE_REQUEST.reason,
      operatorOpenId: '',
      expectedReturnAt: '2026-07-12T08:00:00.000Z',
    };

    expect(() =>
      validateMovementCreateRequest(
        borrow,
        OPTION,
        new Date('2026-07-12T09:00:00.000Z'),
      ),
    ).toThrow(new BadRequestException('请选择经办人'));

    expect(() =>
      validateMovementCreateRequest(
        { ...borrow, operatorOpenId: 'ou_operator' },
        OPTION,
        new Date('2026-07-12T09:00:00.000Z'),
      ),
    ).toThrow(new BadRequestException('预计归还时间必须晚于当前时间'));
  });

  it.each(['2026-07-20', '2026-07-20 18:00:00+08:00', '2026-07-20T18:00:00'])(
    'rejects ambiguous borrow return time %s',
    (expectedReturnAt) => {
      const borrow = {
        type: 'borrow',
        catalogRecordId: BASE_REQUEST.catalogRecordId,
        sku: BASE_REQUEST.sku,
        building: BASE_REQUEST.building,
        quantity: BASE_REQUEST.quantity,
        occurredAt: BASE_REQUEST.occurredAt,
        applicantOpenId: BASE_REQUEST.applicantOpenId,
        reason: BASE_REQUEST.reason,
        operatorOpenId: 'ou_operator',
        expectedReturnAt,
      } as InventoryMovementCreateRequest;

      expect(() =>
        validateMovementCreateRequest(
          borrow,
          OPTION,
          new Date('2026-07-12T09:00:00.000Z'),
        ),
      ).toThrow(new BadRequestException('请选择有效 ISO 8601 预计归还时间'));
    },
  );

  it('maps exact inbound Base fields', () => {
    const request: InventoryMovementCreateRequest = {
      type: 'inbound',
      catalogRecordId: OPTION.catalogRecordId,
      sku: OPTION.sku,
      building: 'A楼',
      quantity: 3,
      occurredAt: '2026-07-12T10:00:00.000Z',
    };

    expect(buildMovementCreateFields(request, OPTION)).toEqual({
      物品类别号: 'A101',
      入库数量: 3,
      楼栋: 'A楼',
      入库日期: Date.parse('2026-07-12T10:00:00.000Z'),
    });
  });

  it('maps an outbound application to routing without writing formal quantity, native Stage, or destination fields', () => {
    const request: InventoryOutboundMovementCreateRequest = {
      ...BASE_REQUEST,
      occurredAt: '2026-07-12T18:00:00+08:00',
    };
    if (false) {
      // @ts-expect-error 出库字段映射必须显式提供请求指纹
      buildMovementCreateFields(request, OPTION);
    }
    const fields = buildMovementCreateFields(
      request,
      OPTION,
      'sha256-fingerprint',
    );

    expect(fields).toEqual({
      物品类别号: ['catalog-a101'],
      物品申请人: [{ id: 'ou_applicant' }],
      楼栋: 'A楼',
      '出库原因/出库后使用地点': 'B楼现场更换',
      程序出库状态: '待审批',
      出库工作流状态: '待路由',
      程序出库申请数量: 2,
      程序出库申请时间: '2026-07-12T10:00:00.000Z',
      出库创建标识: 'outbound-create-1',
      出库请求指纹: 'sha256-fingerprint',
    });
    expect(fields).not.toHaveProperty('出库数量');
    expect(fields).not.toHaveProperty('出库时间');
    expect(fields).not.toHaveProperty('流程');
    expect(fields).not.toHaveProperty('楼栋（东西去到的楼栋）');
    expect(fields).not.toHaveProperty('是否借出本楼栋');
  });

  it('maps exact borrow fields and initializes the status', () => {
    const request: InventoryMovementCreateRequest = {
      type: 'borrow',
      catalogRecordId: BASE_REQUEST.catalogRecordId,
      sku: BASE_REQUEST.sku,
      building: BASE_REQUEST.building,
      quantity: BASE_REQUEST.quantity,
      occurredAt: BASE_REQUEST.occurredAt,
      applicantOpenId: BASE_REQUEST.applicantOpenId,
      reason: BASE_REQUEST.reason,
      operatorOpenId: 'ou_operator',
      expectedReturnAt: '2026-07-20T10:00:00.000Z',
    };

    expect(buildMovementCreateFields(request, OPTION)).toEqual({
      物品类别号: ['catalog-a101'],
      物品申请人: [{ id: 'ou_applicant' }],
      经办人: [{ id: 'ou_operator' }],
      借调数量: 2,
      借出楼栋: 'A楼',
      借调时间: Date.parse('2026-07-12T10:00:00.000Z'),
      预期归还时间: Date.parse('2026-07-20T10:00:00.000Z'),
      借调原因: 'B楼现场更换',
      物品状态: '借调中',
    });
  });
});
