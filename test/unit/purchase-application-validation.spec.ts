import type {
  PurchaseApplicationBatchRequest,
  PurchaseApplicationItemInput,
} from '../../shared/purchase-application.interface';
import {
  batchTotals,
  buildPurchaseApplicationFields,
  buildPurchaseExecutionFields,
  validatePurchaseApplication,
} from '../../server/modules/purchase-inventory/purchase-application.validation';

function existingItem(
  overrides: Partial<PurchaseApplicationItemInput> = {},
): PurchaseApplicationItemInput {
  return {
    lineId: 'line-existing',
    mode: 'existing',
    catalogRecordId: 'rec-catalog-a4',
    sku: 'D2089',
    primaryCategory: 'D消耗类',
    secondaryCategory: '办公耗材D2',
    itemName: 'A4纸',
    specification: '80g 500张',
    brand: '晨光',
    quantity: 2,
    unit: '包',
    unitPrice: 25.5,
    shippingFee: 5,
    discount: 1,
    onlineUrls: ['https://item.example.com/a4'],
    ...overrides,
  };
}

function newItem(
  overrides: Partial<PurchaseApplicationItemInput> = {},
): PurchaseApplicationItemInput {
  return {
    lineId: 'line-new',
    mode: 'new',
    catalogRecordId: '',
    sku: '',
    primaryCategory: 'A备品备件类',
    secondaryCategory: '应急件A1',
    itemName: '新型绝缘垫',
    specification: '1m x 10m',
    brand: '测试品牌',
    quantity: 1,
    unit: '卷',
    unitPrice: 120,
    shippingFee: 0,
    discount: 0,
    onlineUrls: ['https://item.example.com/insulation'],
    ...overrides,
  };
}

function validRequest(): PurchaseApplicationBatchRequest {
  return {
    shared: {
      applicantRecordId: 'rec-employee-ma',
      applicantOpenId: 'ou_applicant_ma',
      applicantName: '马金玉',
      applicantEmployeeNo: 'NT-001',
      applicantPosition: '值班主管',
      applicantBuilding: 'H楼',
      building: 'H楼',
      specialty: '电气',
      purchaseMethod: '综合采购',
      purchaseChannel: '线上',
      supplier: '京东',
      onlineUrl: 'https://item.example.com/a4',
      procurementForm: '三方比价',
      comparisonSatisfied: '是',
      singleReason: '',
      requirementSummary: '补充办公耗材和应急备件',
      expectedDeliveryDate: '2026-07-15',
      immediateOutbound: false,
      notes: '',
    },
    items: [existingItem()],
  };
}

describe('purchase application validation', () => {
  it('maps existing and new items to API-compatible Feishu fields', () => {
    const request = validRequest();
    request.items = [existingItem(), newItem()];

    const result = validatePurchaseApplication(request, '2026-07-10');

    expect(result.issues).toEqual([]);
    const existingFields = buildPurchaseApplicationFields(
      result.value!,
      result.value!.items[0],
      [],
      'CG260710-601',
    );
    const newFields = buildPurchaseApplicationFields(
      result.value!,
      result.value!.items[1],
      [],
      'CG260710-601',
    );
    const existingExecutionFields = buildPurchaseExecutionFields(
      result.value!,
      result.value!.items[0],
      [],
      'TEST-001',
    );
    expect(existingFields).toMatchObject({
      业务申请人: [{ id: 'ou_applicant_ma' }],
      新增物品名称: 'A4纸',
      '线上链接（仅线上需填写）': {
        link: 'https://item.example.com/a4',
        text: '采购链接1',
      },
      '提交成功（无需点击🚫）': true,
      采购编码: 'CG260710-601',
    });
    expect(existingFields).not.toHaveProperty('非新增物品名称');
    expect(existingFields).not.toHaveProperty('一级分类');
    expect(existingFields).not.toHaveProperty('二级分类');
    expect(existingFields).not.toHaveProperty('物品规格型号、设备序列号');
    expect(existingFields).not.toHaveProperty('物品品牌');
    expect(existingExecutionFields).toMatchObject({
      物品名称: 'A4纸',
      '物品规格型号、设备序列号': '80g 500张',
      物品品牌: '晨光',
      '需求备注（提交人)': '',
      '线上链接（仅线上需填写）': {
        link: 'https://item.example.com/a4',
        text: '采购链接1',
      },
    });
    expect(existingExecutionFields).not.toHaveProperty(
      '2️⃣审批已完成（无需点击）',
    );
    expect(existingExecutionFields).not.toHaveProperty(
      '2️⃣审批通过（无需点击）',
    );
    expect(existingExecutionFields).not.toHaveProperty(
      '2️⃣审批驳回（无需点击）',
    );
    expect(newFields).toMatchObject({
      新增物品名称: '新型绝缘垫',
      规格型号: '1m x 10m',
      品牌: '测试品牌',
    });
    expect(newFields).not.toHaveProperty('非新增物品名称');
    expect(newFields).not.toHaveProperty('一级分类');
    expect(newFields).not.toHaveProperty('二级分类');
    expect(existingFields).not.toHaveProperty('需求人');
    expect(existingFields).not.toHaveProperty('总价');
  });

  it('requires a selected active employee applicant', () => {
    const request = validRequest();
    request.shared.applicantRecordId = '';
    request.shared.applicantOpenId = '';
    request.shared.applicantName = '';

    const result = validatePurchaseApplication(request, '2026-07-10');

    expect(result.value).toBeNull();
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MISSING_APPLICANT',
          path: 'shared.applicantName',
        }),
      ]),
    );
  });

  it.each(['', '其他形式'])(
    'rejects missing or unknown procurement form %p',
    (procurementForm) => {
      const request = validRequest();
      request.shared.procurementForm =
        procurementForm as PurchaseApplicationBatchRequest['shared']['procurementForm'];

      const result = validatePurchaseApplication(request, '2026-07-10');

      expect(result.value).toBeNull();
      expect(result.issues).toEqual(
        expect.arrayContaining([
          {
            code: 'INVALID_OPTION',
            path: 'shared.procurementForm',
            message: '请选择采购形式',
          },
        ]),
      );
    },
  );

  it.each([undefined, '   '])(
    'requires a reason for single-source procurement %p',
    (singleReason) => {
      const request = validRequest();
      request.shared.procurementForm = '单一采购';
      request.shared.singleReason = singleReason as string;

      const result = validatePurchaseApplication(request, '2026-07-10');

      expect(result.value).toBeNull();
      expect(result.issues).toEqual(
        expect.arrayContaining([
          {
            code: 'REQUIRED',
            path: 'shared.singleReason',
            message: '请填写单一采购原因',
          },
        ]),
      );
    },
  );

  it('normalizes a single-source request from procurement form', () => {
    const request = validRequest();
    request.shared.procurementForm =
      '  单一采购  ' as PurchaseApplicationBatchRequest['shared']['procurementForm'];
    request.shared.comparisonSatisfied = '是';
    request.shared.singleReason = '  原厂备件只能从原厂采购  ';

    const result = validatePurchaseApplication(request, '2026-07-10');

    expect(result.issues).toEqual([]);
    expect(result.value?.shared).toMatchObject({
      procurementForm: '单一采购',
      comparisonSatisfied: '否',
      singleReason: '原厂备件只能从原厂采购',
    });
  });

  it('normalizes a comparison request from procurement form', () => {
    const request = validRequest();
    request.shared.procurementForm = '三方比价';
    request.shared.comparisonSatisfied = '否';
    request.shared.singleReason = '不应保留的单一采购原因';

    const result = validatePurchaseApplication(request, '2026-07-10');

    expect(result.issues).toEqual([]);
    expect(result.value?.shared).toMatchObject({
      procurementForm: '三方比价',
      comparisonSatisfied: '是',
      singleReason: '',
    });
  });

  it.each([
    ['legacy application', buildPurchaseApplicationFields],
    ['execution', buildPurchaseExecutionFields],
  ])('%s builder rejects an unknown procurement form', (_name, buildFields) => {
    const request = validRequest();
    request.shared.procurementForm =
      '  未知形式  ' as PurchaseApplicationBatchRequest['shared']['procurementForm'];

    expect(() =>
      buildFields(request, request.items[0], [], 'CG260710-601'),
    ).toThrow('采购形式无效');
  });

  it('builds single-source execution fields without comparison attachments', () => {
    const request = validRequest();
    request.shared.procurementForm = '单一采购';
    request.shared.comparisonSatisfied = '是';
    request.shared.singleReason = '  原厂备件只能从原厂采购  ';

    const fields = buildPurchaseExecutionFields(
      request,
      request.items[0],
      ['token-should-not-be-written'],
      'CG260710-601',
    );

    expect(fields).toMatchObject({
      '是否满足三家比价（线下）': '否',
      单一原因: '原厂备件只能从原厂采购',
    });
    expect(fields).not.toHaveProperty('三方比价依据（邮件/报价单）');
  });

  it('builds comparison execution fields with comparison attachments', () => {
    const request = validRequest();
    request.shared.procurementForm = '三方比价';
    request.shared.comparisonSatisfied = '否';
    request.shared.singleReason = '不应写入执行表的原因';

    const fields = buildPurchaseExecutionFields(
      request,
      request.items[0],
      ['comparison-token'],
      'CG260710-601',
    );

    expect(fields).toMatchObject({
      '是否满足三家比价（线下）': '是',
      单一原因: '',
      '三方比价依据（邮件/报价单）': [
        { file_token: 'comparison-token' },
      ],
    });
  });

  it('builds legacy single-source application fields without unsupported fields', () => {
    const request = validRequest();
    request.shared.procurementForm = '单一采购';
    request.shared.comparisonSatisfied = '是';
    request.shared.singleReason = '原厂备件只能从原厂采购';

    const fields = buildPurchaseApplicationFields(
      request,
      request.items[0],
      ['token-should-not-be-written'],
      'CG260710-601',
    );

    expect(fields).toMatchObject({
      是否满足三方比价: '否',
    });
    expect(fields).not.toHaveProperty(
      '三方比价依据（邮件及报价单）线下填写即可',
    );
    expect(fields).not.toHaveProperty('单一原因');
  });

  it('builds legacy comparison application fields with comparison attachments', () => {
    const request = validRequest();
    request.shared.procurementForm = '三方比价';
    request.shared.comparisonSatisfied = '否';
    request.shared.singleReason = '不应写入提交表的原因';

    const fields = buildPurchaseApplicationFields(
      request,
      request.items[0],
      ['comparison-token'],
      'CG260710-601',
    );

    expect(fields).toMatchObject({
      是否满足三方比价: '是',
      '三方比价依据（邮件及报价单）线下填写即可': [
        { file_token: 'comparison-token' },
      ],
    });
    expect(fields).not.toHaveProperty('单一原因');
  });

  it('maps up to three item-specific online links into separate Base URL fields', () => {
    const request = validRequest();
    request.items[0].onlineUrls = [
      ' https://shop.example.com/first ',
      'https://shop.example.com/second',
      'https://shop.example.com/third',
    ];

    const result = validatePurchaseApplication(request, '2026-07-10');
    const fields = buildPurchaseExecutionFields(
      result.value!,
      result.value!.items[0],
      [],
      'CG260710-601',
    );

    expect(result.issues).toEqual([]);
    expect(result.value!.items[0].onlineUrls).toEqual([
      'https://shop.example.com/first',
      'https://shop.example.com/second',
      'https://shop.example.com/third',
    ]);
    expect(fields).toMatchObject({
      '线上链接（仅线上需填写）': {
        link: 'https://shop.example.com/first',
        text: '采购链接1',
      },
      线上链接2: {
        link: 'https://shop.example.com/second',
        text: '采购链接2',
      },
      线上链接3: {
        link: 'https://shop.example.com/third',
        text: '采购链接3',
      },
    });
  });

  it('stamps every accepted application row with its durable approval batch id', () => {
    const request = validRequest();
    const fields = buildPurchaseExecutionFields(
      request,
      request.items[0],
      [],
      'CG260912-601',
      'purchase-application-task-aggregate-1',
    );

    expect(fields).toMatchObject({
      采购编码: 'CG260912-601',
      采购审批批次号: 'purchase-application-task-aggregate-1',
    });
  });

  it('rejects missing, invalid, or more than three links on each online item', () => {
    const request = validRequest();
    request.items = [
      existingItem({ lineId: 'missing-links', onlineUrls: [''] }),
      existingItem({
        lineId: 'invalid-link',
        onlineUrls: ['javascript:alert(1)'],
      }),
      existingItem({
        lineId: 'too-many-links',
        onlineUrls: [
          'https://shop.example.com/1',
          'https://shop.example.com/2',
          'https://shop.example.com/3',
          'https://shop.example.com/4',
        ],
      }),
    ];

    const result = validatePurchaseApplication(request, '2026-07-10');

    expect(result.value).toBeNull();
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lineId: 'missing-links',
          path: 'onlineUrls',
          code: 'MISSING_ONLINE_URL',
        }),
        expect.objectContaining({
          lineId: 'invalid-link',
          path: 'onlineUrls',
          code: 'INVALID_ONLINE_URL',
        }),
        expect.objectContaining({
          lineId: 'too-many-links',
          path: 'onlineUrls',
          code: 'TOO_MANY_ONLINE_URLS',
        }),
      ]),
    );
  });

  it('uses the legacy shared link only when an old item has no link array', () => {
    const request = validRequest();
    delete (request.items[0] as Partial<PurchaseApplicationItemInput>).onlineUrls;
    request.shared.onlineUrl = 'https://legacy.example.com/item';

    const result = validatePurchaseApplication(request, '2026-07-10');

    expect(result.issues).toEqual([]);
    expect(result.value!.items[0].onlineUrls).toEqual([
      'https://legacy.example.com/item',
    ]);
  });

  it('returns row-specific issues and enforces the 20-row limit', () => {
    const request = validRequest();
    request.items = Array.from({ length: 21 }, (_, index) =>
      existingItem({
        lineId: `line-${index}`,
        quantity: index === 0 ? 0 : 1,
      }),
    );

    const result = validatePurchaseApplication(request, '2026-07-10');

    expect(result.value).toBeNull();
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'items', code: 'TOO_MANY_ITEMS' }),
        expect.objectContaining({
          lineId: 'line-0',
          path: 'quantity',
          code: 'INVALID_QUANTITY',
        }),
      ]),
    );
  });

  it('calculates goods, shipping, discount, and payable totals', () => {
    expect(batchTotals([existingItem(), newItem()])).toEqual({
      itemKinds: 2,
      quantity: 3,
      goodsAmount: 171,
      shippingFee: 5,
      discount: 1,
      total: 175,
    });
  });
});
