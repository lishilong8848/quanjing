jest.mock(
  '@server/common/config/external-services.config',
  () => ({
    assertBitableTableConfig: jest.fn(),
    getFeishuAuthPayload: jest.fn(() => ({
      app_id: 'app',
      app_secret: 'secret',
    })),
  }),
  { virtual: true },
);

import type { PurchaseInventoryResponse } from '../../shared/purchase-inventory.interface';
import {
  buildPurchaseInventoryView,
  derivePurchaseStage,
} from '../../server/modules/purchase-inventory/purchase-inventory.mapper';

const record = (recordId: string, fields: Record<string, unknown>) => ({
  record_id: recordId,
  fields,
});

const timedRecord = (
  recordId: string,
  createdTime: number,
  fields: Record<string, unknown>,
) => ({
  ...record(recordId, fields),
  created_time: createdTime,
});

const sectionStatus: PurchaseInventoryResponse['sectionStatus'] = {
  submissions: { configured: true, count: 1 },
  executions: { configured: true, count: 1 },
  catalog: { configured: true, count: 0 },
  inventory: { configured: true, count: 0 },
  inbound: { configured: true, count: 0 },
  outbound: { configured: true, count: 0 },
};

function mapProcurementRequest(input: {
  submissionFields?: Record<string, unknown>;
  executionFields?: Record<string, unknown>;
}) {
  const requestCode = 'PR-PROCUREMENT-FORM-001';
  return buildPurchaseInventoryView({
    generatedAt: '2026-07-30T05:00:00.000Z',
    submissions: [
      record('submission-procurement-form', {
        采购编码: requestCode,
        新增物品名称: '采购形式测试物品',
        采购数量: 1,
        ...input.submissionFields,
      }),
    ],
    executions:
      input.executionFields === undefined
        ? []
        : [
            record('execution-procurement-form', {
              采购编码: requestCode,
              物品名称: '采购形式测试物品',
              ...input.executionFields,
            }),
          ],
    catalog: [],
    inventory: [],
    inbound: [],
    outbound: [],
    sectionStatus,
  }).requests[0];
}

describe('purchase inventory mapper', () => {
  it.each([
    ['未开始（待审批）', 'approval', '未开始（待审批）'],
    ['审批通过（待下单）', 'executing', '审批通过（待下单）'],
    ['下单完成（待签收）', 'receiving', '下单完成（待签收）'],
    ['到货已签收（待入库）', 'inbound', '到货已签收（待入库）'],
    ['物品签收（待入库）', 'inbound', '到货已签收（待入库）'],
    ['采购完成（已入库）', 'stocked', '采购完成（已入库）'],
    ['驳回申请', 'rejected', '驳回申请'],
  ] as const)(
    'uses the manually added purchase process %s as the source of truth',
    (workflowStatus, stage, statusLabel) => {
      expect(
        derivePurchaseStage({
          hasExecution: true,
          submitted: true,
          approvalCompleted: false,
          orderedAt: null,
          receiptConfirmed: false,
          warehouseRequired: true,
          warehouseConfirmed: false,
          workflowStatus,
        }),
      ).toEqual({ stage, statusLabel });
    },
  );

  it('keeps records with an unsynchronised Base process out of pending approval', () => {
    expect(
      derivePurchaseStage({
        hasExecution: true,
        submitted: true,
        approvalCompleted: false,
        orderedAt: null,
        receiptConfirmed: false,
        warehouseRequired: true,
        warehouseConfirmed: false,
      }),
    ).toEqual({ stage: 'executing', statusLabel: '采购流程待同步' });
  });

  it('uses the purchase process instead of the legacy approval checkbox', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-21T05:00:00.000Z',
      submissions: [
        record('submission-approved', {
          采购编码: 'CG260721-601',
          新增物品名称: '羊角锤',
          提交成功: true,
        }),
      ],
      executions: [
        record('execution-approved', {
          采购编码: 'CG260721-601',
          物品名称: '羊角锤',
          '2️⃣审批已完成（无需点击）': false,
          采购流程: '审批通过（待下单）',
        }),
      ],
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests[0]).toMatchObject({
      stage: 'executing',
      statusLabel: '审批通过（待下单）',
    });
  });

  it('maps application and execution list fields from an execution-only record', () => {
    const expectedArrival = Date.parse('2026-07-28T00:00:00+08:00');
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-22T05:00:00.000Z',
      submissions: [],
      executions: [
        record('execution-only', {
          采购编码: 'CG260722-301',
          需求人: [{ id: 'ou_requester_contact_123', name: '张文豪' }],
          采购人: [{ id: 'ou_purchase_contact_123', name: '采购负责人' }],
          申请楼栋: ['C楼'],
          专业: '弱电',
          一级分类: 'A备品备件类',
          二级分类: '弱电备件',
          '1️⃣物品采购方式': '需求自采',
          供应商: '测试供应商',
          采购申请数量: 2,
          计数单位: '块',
          物品名称: '服务器硬盘',
          '物品规格型号、设备序列号': 'SAS 1.92TB',
          '线上链接（仅线上需填写）': {
            link: 'https://shop.example.com/first',
            text: '采购链接1',
          },
          线上链接2: 'https://shop.example.com/second',
          线上链接3: {
            url: 'https://shop.example.com/third',
          },
          期望交付时间: expectedArrival,
          '需求备注（提交人）': '用于服务器扩容',
          采购流程: '未开始（待审批）',
        }),
      ],
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests).toEqual([
      expect.objectContaining({
        recordId: 'execution-only',
        submissionRecordId: null,
        executionRecordId: 'execution-only',
        requestCode: 'CG260722-301',
        title: '服务器硬盘',
        requester: '张文豪',
        requesterChatUrl:
          'https://example.feishu.cn/client/PUBLIC_EXAMPLE_SOURCE',
        purchaser: '采购负责人',
        purchaserChatUrl:
          'https://example.feishu.cn/client/PUBLIC_EXAMPLE_SOURCE',
        building: 'C楼',
        specialty: '弱电',
        primaryCategory: 'A备品备件类',
        secondaryCategory: '弱电备件',
        purchaseMethod: '需求自采',
        supplier: '测试供应商',
        specification: 'SAS 1.92TB',
        purchaseLinks: [
          'https://shop.example.com/first',
          'https://shop.example.com/second',
          'https://shop.example.com/third',
        ],
        quantity: 2,
        unit: '块',
        expectedArrival: '2026-07-27T16:00:00.000Z',
        notes: '用于服务器扩容',
        stage: 'approval',
        statusLabel: '未开始（待审批）',
      }),
    ]);
  });

  it('maps an execution comparison rejection to single procurement and trims its reason', () => {
    expect(
      mapProcurementRequest({
        executionFields: {
          '是否满足三家比价（线下）': '否',
          单一原因: '  原厂授权渠道，只能单一采购  ',
        },
      }),
    ).toMatchObject({
      procurementForm: '单一采购',
      singleReason: '原厂授权渠道，只能单一采购',
    });
  });

  it('clears a dirty single-source reason for comparison procurement', () => {
    expect(
      mapProcurementRequest({
        executionFields: {
          '是否满足三家比价（线下）': '是',
          单一原因: '历史脏数据不应返回',
        },
      }),
    ).toMatchObject({
      procurementForm: '三方比价',
      singleReason: '',
    });
  });

  it('migrates a legacy submission comparison rejection when execution lacks the field', () => {
    expect(
      mapProcurementRequest({
        submissionFields: {
          是否满足三方比价: '否',
        },
        executionFields: {},
      }),
    ).toMatchObject({
      procurementForm: '单一采购',
      singleReason: '',
    });
  });

  it('does not fall back to a legacy rejection when the execution comparison field is present but empty', () => {
    expect(
      mapProcurementRequest({
        submissionFields: {
          是否满足三方比价: '否',
        },
        executionFields: {
          '是否满足三家比价（线下）': '',
        },
      }),
    ).toMatchObject({
      procurementForm: '三方比价',
      singleReason: '',
    });
  });

  it.each([
    ['an empty array', []],
    ['an empty object', {}],
    ['an unparseable object', { unsupported: '否' }],
  ])(
    'does not fall back to a legacy rejection when the execution comparison field contains %s',
    (_description, executionValue) => {
      expect(
        mapProcurementRequest({
          submissionFields: {
            是否满足三方比价: '否',
          },
          executionFields: {
            '是否满足三家比价（线下）': executionValue,
          },
        }),
      ).toMatchObject({
        procurementForm: '三方比价',
        singleReason: '',
      });
    },
  );

  it('maps structured Base comparison and single-reason values', () => {
    expect(
      mapProcurementRequest({
        submissionFields: {
          是否满足三方比价: '是',
        },
        executionFields: {
          '是否满足三家比价（线下）': [{ text: '否' }],
          单一原因: { value: '  原厂授权渠道  ' },
        },
      }),
    ).toMatchObject({
      procurementForm: '单一采购',
      singleReason: '原厂授权渠道',
    });
  });

  it('defaults missing and unknown comparison values to comparison procurement', () => {
    expect(mapProcurementRequest({})).toMatchObject({
      procurementForm: '三方比价',
      singleReason: '',
    });
    expect(
      mapProcurementRequest({
        submissionFields: {
          是否满足三方比价: '否',
        },
        executionFields: {
          '是否满足三家比价（线下）': '未知',
          单一原因: '未知值不能启用单一原因',
        },
      }),
    ).toMatchObject({
      procurementForm: '三方比价',
      singleReason: '',
    });
  });

  it('maps a rejected approval to a terminal rejected stage before downstream checks', () => {
    expect(
      derivePurchaseStage({
        hasExecution: true,
        submitted: true,
        approvalCompleted: true,
        orderedAt: null,
        receiptConfirmed: false,
        warehouseRequired: true,
        warehouseConfirmed: false,
        rejected: true,
      }),
    ).toEqual({ stage: 'rejected', statusLabel: '已驳回' });
  });

  it('keeps a Base-workflow rejection out of pending approval and purchase execution', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-21T05:00:00.000Z',
      submissions: [
        record('submission-rejected', {
          采购编码: 'PR-REJECTED-001',
          新增物品名称: '测试物品',
          采购数量: 1,
          提交成功: true,
        }),
      ],
      executions: [
        record('execution-rejected', {
          采购编码: 'PR-REJECTED-001',
          物品名称: '测试物品',
          '1️⃣物品采购方式': '驳回',
          '3️⃣审批已完成（无需点击）': true,
          采购流程: '驳回申请',
        }),
      ],
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests[0]).toMatchObject({
      stage: 'rejected',
      statusLabel: '驳回申请',
      purchaseMethod: '驳回',
      approvalTarget: '',
    });
    expect(result.summary.pendingApprovals).toBe(0);
    expect(result.summary.executingOrders).toBe(0);
    expect(result.summary.stageCounts).toMatchObject({
      approval: 0,
      executing: 0,
      rejected: 1,
    });
  });

  it('uses the purchase process when legacy warehouse flags are true', () => {
    expect(
      derivePurchaseStage({
        hasExecution: true,
        submitted: true,
        approvalCompleted: true,
        orderedAt: '2026-07-10T03:13:00.000Z',
        receiptConfirmed: false,
        warehouseRequired: true,
        warehouseConfirmed: true,
        workflowStatus: '下单完成（待签收）',
      }),
    ).toEqual({ stage: 'receiving', statusLabel: '下单完成（待签收）' });
  });

  it('does not let a legacy inbound checkbox override the purchase process', () => {
    const buildView = (inboundCompleted: boolean) =>
      buildPurchaseInventoryView({
        generatedAt: '2026-07-16T06:00:00.000Z',
        submissions: [
          record('submission-inbound-authority', {
            采购编码: 'PR-INBOUND-AUTHORITY',
            新增物品名称: '绝缘手套',
            采购数量: 2,
            '是否需要录入 库房台账': false,
          }),
        ],
        executions: [
          record('execution-inbound-authority', {
            采购编码: 'PR-INBOUND-AUTHORITY',
            物品名称: '绝缘手套',
            '3️⃣审批已完成（无需点击）': true,
            下单时间: 1783647987000,
            '到货签收确认（签收内容填写完成后点击）': true,
            库房确认: true,
            是否已入库: inboundCompleted,
            采购流程: '下单完成（待签收）',
          }),
        ],
        catalog: [],
        inventory: [],
        inbound: [],
        outbound: [],
        sectionStatus,
      });

    expect(buildView(false).requests[0]).toMatchObject({
      stage: 'receiving',
      statusLabel: '下单完成（待签收）',
      warehouseConfirmed: false,
    });
    expect(buildView(true).requests[0]).toMatchObject({
      stage: 'receiving',
      statusLabel: '下单完成（待签收）',
      warehouseConfirmed: true,
    });
  });

  it('keeps a signed purchase pending inbound until the warehouse confirms it', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-17T12:00:00.000Z',
      submissions: [
        record('submission-legacy-stocked', {
          采购编码: '陶必亮-润滑油-2025/11/27 10:27',
          新增物品名称: '润滑油',
          提交成功: true,
        }),
      ],
      executions: [
        record('execution-legacy-stocked', {
          采购编码: '陶必亮-润滑油-2025/11/27 10:27',
          物品名称: '润滑油',
          采购流程: '物品签收（待入库）',
          库房确认: true,
        }),
      ],
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests[0]).toMatchObject({
      stage: 'inbound',
      statusLabel: '到货已签收（待入库）',
      warehouseConfirmed: false,
    });
  });

  it('keeps a submitted request without an execution row in pending approval', () => {
    expect(
      derivePurchaseStage({
        hasExecution: false,
        submitted: true,
        approvalCompleted: false,
        orderedAt: null,
        receiptConfirmed: false,
        warehouseRequired: true,
        warehouseConfirmed: false,
      }),
    ).toEqual({ stage: 'approval', statusLabel: '待审批' });
  });

  it('merges submission and execution rows by purchase code', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-10T06:00:00.000Z',
      submissions: [
        record('submission-1', {
          采购编码: '示例人员018-UPVC电动球阀-2026/07/09 17:44',
          新增物品名称: 'UPVC电动球阀',
          采购数量: 1,
          总价: 508.75,
          '提交成功（无需点击🚫）': true,
          '是否需要录入 库房台账': true,
          创建日期: 1783590262000,
        }),
      ],
      executions: [
        record('execution-1', {
          采购编码: '示例人员018-UPVC电动球阀-2026/07/09 17:44',
          物品名称: 'UPVC电动球阀',
          '3️⃣审批已完成（无需点击）': true,
          下单时间: 1783647987000,
          库房确认: true,
          采购完成: true,
          采购流程: '下单完成（待签收）',
          实际付款金额: 450.79,
        }),
      ],
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({
      requestCode: '示例人员018-UPVC电动球阀-2026/07/09 17:44',
      title: 'UPVC电动球阀',
      stage: 'receiving',
      statusLabel: '下单完成（待签收）',
      actualAmount: 450.79,
    });
  });

  it('retains every purchase item when a purchase code is shared by a batch', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-21T06:00:00.000Z',
      submissions: [
        record('submission-batch-a', {
          采购编码: 'CG260721-601',
          新增物品名称: '羊角锤',
          采购数量: 1,
          提交成功: true,
        }),
        record('submission-batch-b', {
          采购编码: 'CG260721-601',
          新增物品名称: '绝缘胶带',
          采购数量: 3,
          提交成功: true,
        }),
      ],
      executions: [
        record('execution-batch-a', {
          采购编码: 'CG260721-601',
          物品名称: '羊角锤',
          采购申请数量: 1,
          采购流程: '未开始（待审批）',
        }),
        record('execution-batch-b', {
          采购编码: 'CG260721-601',
          物品名称: '绝缘胶带',
          采购申请数量: 3,
          采购流程: '未开始（待审批）',
        }),
      ],
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests).toHaveLength(2);
    expect(result.requests.map((item) => item.requestCode)).toEqual([
      'CG260721-601',
      'CG260721-601',
    ]);
    expect(result.requests.map((item) => item.title).sort()).toEqual([
      '绝缘胶带',
      '羊角锤',
    ]);
  });

  it('reconciles a program-created execution when the submission formula keeps the bot prefix', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-20T11:02:00.000Z',
      submissions: [
        timedRecord('submission-program', 1784545273000, {
          采购编码: '南通运维小帮手-便携式电导率检测仪-2026/07/20 19:01',
          业务申请人: [{ id: 'ou_bot', name: '南通运维小帮手' }],
          '申请楼栋（多楼请选H楼，备注里填写详情）': 'H楼',
          新增物品名称: '便携式电导率检测仪',
          采购数量: 1,
          单位: '个',
          供应商: '本地审批回归测试',
          '需求简述（采购原因、目的等）': 'CODEX本地审批回归-20260720-1901',
          '提交成功（无需点击🚫）': false,
        }),
      ],
      executions: [
        timedRecord('execution-program', 1784545274000, {
          采购编码: '刘小杏-便携式电导率检测仪-2026-07-20',
          需求人: [{ id: 'ou_liu', name: '刘小杏' }],
          申请楼栋: ['H楼'],
          物品名称: '便携式电导率检测仪',
          采购申请数量: 1,
          计数单位: '个',
          供应商: '本地审批回归测试',
          '需求简述（采购原因、目的等）': 'CODEX本地审批回归-20260720-1901',
          采购流程: '未开始（待审批）',
        }),
      ],
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({
      requestCode: '刘小杏-便携式电导率检测仪-2026-07-20',
      submissionRecordId: 'submission-program',
      executionRecordId: 'execution-program',
      requester: '刘小杏',
      stage: 'approval',
      statusLabel: '未开始（待审批）',
      approvalTarget: '运维经理（示例人员020 / 示例人员014，任一审批）',
    });
  });

  it('uses the execution purchase process when historical linked rows have different purchase codes', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-21T08:30:00.000Z',
      submissions: [
        timedRecord(
          'submission-historical-code-mismatch',
          Date.parse('2026-07-15T12:53:46.000Z'),
          {
            采购编码: 'CG260715-601',
            需求人: '刘小杏',
            申请楼栋: 'H楼',
            新增物品名称: '投篮网篮框网兜',
            采购数量: 2,
            单位: '对',
            供应商: '京东',
            提交成功: true,
          },
        ),
      ],
      executions: [
        timedRecord(
          'execution-historical-code-mismatch',
          Date.parse('2026-07-17T07:52:39.000Z'),
          {
            采购编码: 'CG260717-601',
            需求人: '刘小杏',
            申请楼栋: 'H楼',
            物品名称: '投篮网篮框网兜',
            采购申请数量: 2,
            计数单位: '对',
            供应商: '京东',
            采购流程: '采购完成（已入库）',
            采购完成: true,
          },
        ),
      ],
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({
      requestCode: 'CG260715-601',
      submissionRecordId: 'submission-historical-code-mismatch',
      executionRecordId: 'execution-historical-code-mismatch',
      stage: 'stocked',
      statusLabel: '采购完成（已入库）',
    });
  });

  it('reconciles a historical row when its execution code is occupied by another submission item', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-21T09:30:00.000Z',
      submissions: [
        timedRecord('submission-mask', Date.parse('2026-06-04T08:04:18.000Z'), {
          采购编码: 'CG260604-302',
          需求人: '示例人员010',
          申请楼栋: 'C楼',
          新增物品名称: '消防呼吸面罩',
          采购数量: 60,
          单位: '个',
          供应商: '京东',
          '需求简述（采购原因、目的等）': 'C楼消防呼吸面罩即将到期',
          提交成功: true,
        }),
        timedRecord(
          'submission-code-owner',
          Date.parse('2026-06-05T01:30:00.000Z'),
          {
            采购编码: 'CG260605-301',
            需求人: '其他申请人',
            申请楼栋: 'C楼',
            新增物品名称: '其他物品',
            采购数量: 1,
            单位: '个',
            提交成功: true,
          },
        ),
      ],
      executions: [
        timedRecord('execution-mask', Date.parse('2026-06-05T01:38:45.000Z'), {
          采购编码: 'CG260605-301',
          需求人: '示例人员010',
          申请楼栋: 'C楼',
          物品名称: '消防呼吸面罩',
          采购申请数量: 60,
          计数单位: '个',
          供应商: '京东',
          '需求简述（采购原因、目的等）': 'C楼消防呼吸面罩即将到期',
          采购流程: '采购完成（已入库）',
          采购完成: true,
        }),
      ],
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests).toHaveLength(2);
    expect(
      result.requests.find((item) => item.title === '消防呼吸面罩'),
    ).toMatchObject({
      requestCode: 'CG260604-302',
      submissionRecordId: 'submission-mask',
      executionRecordId: 'execution-mask',
      stage: 'stocked',
      statusLabel: '采购完成（已入库）',
    });
  });

  it('reconciles duplicate historical items as one cross-code batch', () => {
    const submissions = Array.from({ length: 3 }, (_, index) =>
      timedRecord(
        `submission-pad-${index}`,
        Date.parse(`2026-06-01T02:00:${47 + index}.000Z`),
        {
          采购编码: 'CG260601-601',
          需求人: '示例人员018',
          申请楼栋: 'H楼',
          新增物品名称: 'U型垫片',
          采购数量: 20,
          单位: '片',
          供应商: '京东',
          '需求简述（采购原因、目的等）':
            '园区内水泵同心度校准需请购一批工具及耗材',
          提交成功: true,
        },
      ),
    );
    const executions = Array.from({ length: 3 }, (_, index) =>
      timedRecord(
        `execution-pad-${index}`,
        Date.parse(`2026-06-01T02:32:${51 + index}.000Z`),
        {
          采购编码: 'CG260601-602',
          需求人: '示例人员018',
          申请楼栋: 'H楼',
          物品名称: 'U型垫片',
          采购申请数量: 20,
          计数单位: '片',
          供应商: '京东',
          '需求简述（采购原因、目的等）':
            '园区内水泵同心度校准需请购一批工具及耗材',
          采购流程: '采购完成（已入库）',
          采购完成: true,
        },
      ),
    );
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-21T09:30:00.000Z',
      submissions,
      executions,
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests).toHaveLength(3);
    expect(result.requests).toEqual(
      expect.arrayContaining(
        submissions.map((_, index) =>
          expect.objectContaining({
            requestCode: 'CG260601-601',
            submissionRecordId: `submission-pad-${index}`,
            executionRecordId: expect.any(String),
            stage: 'stocked',
          }),
        ),
      ),
    );
  });

  it('reconciles an approved quantity adjustment when strong identity fields agree', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-21T09:30:00.000Z',
      submissions: [
        timedRecord(
          'submission-valve',
          Date.parse('2026-06-11T08:28:28.000Z'),
          {
            采购编码: 'CG260611-201',
            需求人: '陈继猛',
            申请楼栋: 'B楼',
            新增物品名称: 'UPVC球阀',
            采购数量: 1,
            单位: '只',
            供应商: '京东',
            '需求简述（采购原因、目的等）': 'B楼加药装置检修更换',
            提交成功: true,
          },
        ),
      ],
      executions: [
        timedRecord('execution-valve', Date.parse('2026-06-11T08:41:14.000Z'), {
          采购编码: 'CG260611-202',
          需求人: '陈继猛',
          申请楼栋: 'B楼',
          物品名称: 'UPVC球阀',
          采购申请数量: 2,
          计数单位: '只',
          供应商: '京东',
          '需求简述（采购原因、目的等）': 'B楼加药装置检修更换',
          采购流程: '采购完成（已入库）',
          采购完成: true,
        }),
      ],
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({
      requestCode: 'CG260611-201',
      submissionRecordId: 'submission-valve',
      executionRecordId: 'execution-valve',
      quantity: 2,
      stage: 'stocked',
      statusLabel: '采购完成（已入库）',
    });
  });

  it('fills a missing request building from the active employee table', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-12T01:00:00.000Z',
      submissions: [
        record('submission-1', {
          采购编码: '孙婷婷-粘鼠板-2026/06/30 09:28',
          需求人: '孙婷婷',
          新增物品名称: '粘鼠板',
          采购数量: 1,
        }),
      ],
      executions: [],
      employees: [
        record('employee-1', {
          姓名: '孙婷婷',
          '机楼/专业': ['C楼'],
        }),
      ],
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests[0]).toMatchObject({
      requester: '孙婷婷',
      building: 'C楼',
    });
  });

  it('keeps the building explicitly selected on the purchase request', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-12T01:00:00.000Z',
      submissions: [
        record('submission-1', {
          采购编码: '孙婷婷-跨楼申请',
          需求人: '孙婷婷',
          申请楼栋: 'E楼',
          新增物品名称: '粘鼠板',
          采购数量: 1,
        }),
      ],
      executions: [],
      employees: [
        record('employee-1', {
          姓名: '孙婷婷',
          '机楼/专业': ['C楼'],
        }),
      ],
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests[0]?.building).toBe('E楼');
  });

  it('falls back to requester and building fields from the execution row', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-13T01:00:00.000Z',
      submissions: [
        record('submission-1', {
          采购编码: '示例人员018-UPVC电动球阀-2026/07/09 17:44',
          新增物品名称: 'UPVC电动球阀',
          采购数量: 1,
        }),
      ],
      executions: [
        record('execution-1', {
          采购编码: '示例人员018-UPVC电动球阀-2026/07/09 17:44',
          需求人: [{ id: 'ou_requester', name: '示例人员018' }],
          申请楼栋: ['H楼'],
          物品名称: 'UPVC电动球阀',
        }),
      ],
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests[0]).toMatchObject({
      requester: '示例人员018',
      building: 'H楼',
    });
  });

  it('reads the historical H-building field name from the submission row', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-13T01:00:00.000Z',
      submissions: [
        record('submission-1', {
          采购编码: '示例人员018-UPVC电动球阀-2026/07/09 17:44',
          需求人: { id: 'ou_requester', name: '示例人员018' },
          '申请楼栋（多楼请选H楼，备注里填写详情）': 'H楼',
          新增物品名称: 'UPVC电动球阀',
          采购数量: 1,
        }),
      ],
      executions: [],
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests[0]).toMatchObject({
      requester: '示例人员018',
      building: 'H楼',
    });
  });

  it('keeps supplier and unit values from a submission before execution exists', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-12T01:00:00.000Z',
      submissions: [
        record('submission-1', {
          采购编码: 'PR-UNIT-001',
          需求人: '孙婷婷',
          新增物品名称: '粘鼠板',
          采购数量: 1,
          单位: '盒',
          供应商: '京东',
        }),
      ],
      executions: [],
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests[0]).toMatchObject({
      supplier: '京东',
      unit: '盒',
    });
  });

  it('maps the purchase method and current approver for a pending submission', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-16T06:00:00.000Z',
      submissions: [
        record('submission-approval-1', {
          采购编码: 'PR-APPROVAL-001',
          新增物品名称: '绝缘手套',
          采购数量: 2,
          采购方式: '综合采购',
          当前审批人: [{ id: 'ou_manager', name: '王经理' }],
          提交成功: true,
        }),
      ],
      executions: [],
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests[0]).toMatchObject({
      stage: 'approval',
      statusLabel: '待审批',
      purchaseMethod: '综合采购',
      approvalTarget: '王经理',
    });
  });

  it('uses the operations managers when a pending submission has no named approver', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-16T06:00:00.000Z',
      submissions: [
        record('submission-approval-role-1', {
          采购编码: 'PR-APPROVAL-ROLE-001',
          新增物品名称: '防护目镜',
          采购数量: 1,
          提交成功: true,
        }),
      ],
      executions: [],
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests[0]).toMatchObject({
      stage: 'approval',
      approvalTarget: '运维经理（示例人员020 / 示例人员014，任一审批）',
    });
  });

  it('fills a missing unit from the unique same-building catalog match', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-16T06:00:00.000Z',
      submissions: [
        record('submission-unit-by-name', {
          采购编码: 'PR-UNIT-NAME-001',
          新增物品名称: '毛巾',
          采购数量: 2,
          申请楼栋: 'H楼',
        }),
      ],
      executions: [],
      catalog: [
        record('catalog-h', {
          物品类别号: 'D-H',
          名称: '毛巾',
          楼栋: 'H楼',
          计数单位: '条',
        }),
        record('catalog-c', {
          物品类别号: 'D-C',
          名称: '毛巾',
          楼栋: 'C楼',
          计数单位: '个',
        }),
      ],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests[0]?.unit).toBe('条');
  });

  it('uses a unique same-name catalog unit when the matching sku row is blank', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-16T06:00:00.000Z',
      submissions: [
        record('submission-unit-by-sku', {
          采购编码: 'PR-UNIT-SKU-001',
          新增物品名称: '电动扳手',
          采购数量: 1,
          申请楼栋: 'B楼',
        }),
      ],
      executions: [
        record('execution-unit-by-sku', {
          采购编码: 'PR-UNIT-SKU-001',
          物品名称: '电动扳手',
          物品类别码: 'B2100',
        }),
      ],
      catalog: [
        record('catalog-empty-unit', {
          物品类别号: 'B2100',
          名称: '电动扳手',
          楼栋: 'B楼',
          计数单位: '',
        }),
        record('catalog-known-unit', {
          物品类别号: 'B2086',
          名称: '电动扳手',
          楼栋: 'B楼',
          计数单位: '把',
        }),
      ],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests[0]?.unit).toBe('把');
  });

  it('falls back to 件 when catalog units are ambiguous', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-16T06:00:00.000Z',
      submissions: [
        record('submission-ambiguous-unit', {
          采购编码: 'PR-UNIT-AMBIGUOUS-001',
          新增物品名称: '粘鼠板',
          采购数量: 1,
          申请楼栋: 'C楼',
        }),
      ],
      executions: [],
      catalog: [
        record('catalog-unit-sheet', {
          物品类别号: 'D1117',
          名称: '粘鼠板',
          楼栋: 'C楼',
          计数单位: '张',
        }),
        record('catalog-unit-piece', {
          物品类别号: 'D1118',
          名称: '粘鼠板',
          楼栋: 'C楼',
          计数单位: '片',
        }),
      ],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests[0]?.unit).toBe('件');
  });

  it('reads an edited note back from the field used by record editing', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-13T01:00:00.000Z',
      submissions: [
        record('submission-note', {
          采购编码: 'PR-NOTE-001',
          新增物品名称: '温度传感器',
          采购数量: 1,
          其他备注: '管理员补充后的备注',
        }),
      ],
      executions: [],
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(result.requests[0]?.notes).toBe('管理员补充后的备注');
  });

  it('fills historical records from a single consistent building for the same requester', () => {
    const result = buildPurchaseInventoryView({
      generatedAt: '2026-07-12T01:00:00.000Z',
      submissions: [
        record('submission-known', {
          采购编码: '曾娜娜-已知楼栋',
          需求人: '曾娜娜',
          申请楼栋: 'H楼',
          新增物品名称: '毛巾',
          采购数量: 1,
        }),
        record('submission-missing', {
          采购编码: '曾娜娜-历史缺失楼栋',
          需求人: '曾娜娜',
          新增物品名称: '口哨',
          采购数量: 1,
        }),
      ],
      executions: [],
      employees: [],
      catalog: [],
      inventory: [],
      inbound: [],
      outbound: [],
      sectionStatus,
    });

    expect(
      result.requests.find((item) => item.requestCode === '曾娜娜-历史缺失楼栋')
        ?.building,
    ).toBe('H楼');
  });
});
