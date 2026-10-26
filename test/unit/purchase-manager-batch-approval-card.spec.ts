import { BadRequestException } from '@nestjs/common';
import {
  buildPurchaseManagerBatchApprovalCard,
  buildPurchaseManagerBatchManualReconciliationCard,
  buildPurchaseManagerBatchPendingCard,
  buildPurchaseManagerBatchRejectEditorCard,
  buildResolvedPurchaseManagerBatchApprovalCard,
  parsePurchaseManagerBatchApprovalCardContext,
  serializePurchaseManagerBatchApprovalCardContext,
  type PurchaseManagerBatchApprovalCardInput,
} from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';

type JsonObject = Record<string, unknown>;

const baseInput: PurchaseManagerBatchApprovalCardInput = {
  version: 3,
  approvalBatchId: 'purchase-application-task-1',
  requesterName: '刘小杏',
  requesterOpenId: 'ou_requester_1',
  building: 'H楼',
  requestCode: 'CG260811-601',
  expectedDeliveryAt: '2026-08-11',
  createdAt: '2026-08-08 09:30',
  items: [
    {
      executionRecordId: 'rec_batch_1',
      title: '门牌',
      specification: '/',
      quantity: '60',
      unit: '套',
      amount: '834.00',
      status: 'pending',
      choice: '',
      rejectionReason: '',
    },
    {
      executionRecordId: 'rec_batch_2',
      title: '工具收纳盒',
      specification: '大号三层',
      quantity: '2',
      unit: '个',
      amount: '268.00',
      status: 'pending',
      choice: '',
      rejectionReason: '',
    },
  ],
};

function collectByTag(value: unknown, tag: string): JsonObject[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectByTag(item, tag));
  }
  if (!value || typeof value !== 'object') return [];
  const object = value as JsonObject;
  return [
    ...(object.tag === tag ? [object] : []),
    ...Object.values(object).flatMap((item) => collectByTag(item, tag)),
  ];
}

function collectContents(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectContents);
  if (!value || typeof value !== 'object') return [];
  const object = value as JsonObject;
  return [
    ...(typeof object.content === 'string' ? [object.content] : []),
    ...Object.values(object).flatMap(collectContents),
  ];
}

function callbackValues(card: unknown): JsonObject[] {
  return collectByTag(card, 'button').flatMap((button) => {
    const behaviors = button.behaviors;
    if (!Array.isArray(behaviors)) return [];
    return behaviors.flatMap((behavior) => {
      if (!behavior || typeof behavior !== 'object') return [];
      const object = behavior as JsonObject;
      return object.type === 'callback' && object.value
        ? [object.value as JsonObject]
        : [];
    });
  });
}

describe('purchase manager batch approval Card 2.0', () => {
  it.each([
    [
      '待审批',
      (input: PurchaseManagerBatchApprovalCardInput) =>
        buildPurchaseManagerBatchApprovalCard(input),
    ],
    [
      '同步中',
      (input: PurchaseManagerBatchApprovalCardInput) =>
        buildPurchaseManagerBatchPendingCard(input),
    ],
    [
      '需人工核对',
      (input: PurchaseManagerBatchApprovalCardInput) =>
        buildPurchaseManagerBatchManualReconciliationCard(input),
    ],
    [
      '已完成',
      (input: PurchaseManagerBatchApprovalCardInput) =>
        buildResolvedPurchaseManagerBatchApprovalCard(
          {
            ...input,
            items: input.items.map((item) => ({
              ...item,
              status: 'approved' as const,
              choice: 'comprehensive' as const,
            })),
          },
          { actorName: '示例人员020', processedAt: '2026-09-21T02:20:00.000Z' },
        ),
    ],
  ])('在%s卡片中仅为单一采购显示原因', (_label, buildCard) => {
    const card = buildCard({
      ...baseInput,
      items: [
        {
          ...baseInput.items[0],
          procurementForm: '单一采购',
          singleReason: '指定品牌设备需保持配件兼容',
        },
        {
          ...baseInput.items[1],
          procurementForm: '三方比价',
          singleReason: null,
        },
      ],
    });
    const content = collectContents(card).join('\n');

    expect(content).toContain('**申请采购方式**\n单一采购 / 三方比价');
    expect(content).not.toContain('可选采购方式');
    expect(content).toContain('单一采购原因');
    expect(content).toContain('指定品牌设备需保持配件兼容');
    expect(content).toContain('采购方式');
    expect(content).toContain('单一采购');
    expect(content).toContain('三方比价');
  });

  it('uses semantic terminal colors for rejected and partially rejected batches', () => {
    const rejected = buildResolvedPurchaseManagerBatchApprovalCard(
      {
        ...baseInput,
        items: baseInput.items.map((item) => ({
          ...item,
          status: 'rejected' as const,
          choice: 'reject' as const,
          rejectionReason: '预算不通过',
        })),
      },
      { actorName: '示例人员020', processedAt: '2026-09-21T06:45:00.000Z' },
    );
    const partial = buildResolvedPurchaseManagerBatchApprovalCard(
      {
        ...baseInput,
        items: [
          {
            ...baseInput.items[0],
            status: 'approved',
            choice: 'comprehensive',
          },
          {
            ...baseInput.items[1],
            status: 'rejected',
            choice: 'reject',
            rejectionReason: '规格不符',
          },
        ],
      },
      { actorName: '示例人员020', processedAt: '2026-09-21T06:46:00.000Z' },
    );

    expect(rejected).toMatchObject({
      header: {
        template: 'red',
        title: { content: '采购申请已驳回' },
        text_tag_list: [{ color: 'red' }],
      },
    });
    expect(partial).toMatchObject({
      header: {
        template: 'orange',
        text_tag_list: [{ color: 'orange' }],
      },
    });
  });

  it('shows H-building applications as comprehensive-only and omits building self-purchase', () => {
    const card = buildPurchaseManagerBatchApprovalCard(baseInput);

    expect(card).toMatchObject({
      schema: '2.0',
      config: { update_multi: true, enable_forward: false },
    });
    expect(collectByTag(card, 'note')).toHaveLength(0);
    expect(callbackValues(card)).toEqual([
      {
        version: 3,
        action: 'open_item_reject',
        approvalBatchId: baseInput.approvalBatchId,
        executionRecordId: 'rec_batch_1',
      },
      {
        version: 3,
        action: 'open_item_reject',
        approvalBatchId: baseInput.approvalBatchId,
        executionRecordId: 'rec_batch_2',
      },
      {
        version: 3,
        action: 'approve_pending_comprehensive',
        approvalBatchId: baseInput.approvalBatchId,
      },
    ]);
    const content = collectContents(card).join('\n');
    expect(content).toContain('共 2 项');
    expect(content).toContain('2 项待审批');
    expect(content).toContain('门牌');
    expect(content).toContain('60 套');
    expect(content).toContain('¥834.00');
    expect(content).toContain('申请采购方式');
    expect(content).toContain('综合采购');
    expect(content).not.toContain('楼内自采');
  });

  it('shows both procurement methods for non-H-building applications', () => {
    const card = buildPurchaseManagerBatchApprovalCard({
      ...baseInput,
      building: 'A楼',
    });

    expect(callbackValues(card)).toEqual(
      expect.arrayContaining([
        {
          version: 3,
          action: 'approve_pending_comprehensive',
          approvalBatchId: baseInput.approvalBatchId,
        },
        {
          version: 3,
          action: 'approve_pending_building_self',
          approvalBatchId: baseInput.approvalBatchId,
        },
      ]),
    );
    const content = collectContents(card).join('\n');
    expect(content).toContain('申请采购方式');
    expect(content).not.toContain('综合采购 / 楼内自采');
  });

  it.each([
    [['三方比价', '三方比价'], '三方比价'],
    [['单一采购', '单一采购'], '单一采购'],
    [['三方比价', '单一采购'], '三方比价 / 单一采购'],
    [[null, null], '未填写'],
    [['三方比价', null], '三方比价 / 未填写'],
  ] as const)('summarizes the submitted procurement forms %j', (forms, expected) => {
    const card = buildPurchaseManagerBatchApprovalCard({
      ...baseInput,
      building: 'A楼',
      items: baseInput.items.map((item, index) => ({
        ...item,
        procurementForm: forms[index],
        singleReason: null,
      })),
    });
    const content = collectContents(card).join('\n');
    expect(content).toContain(`**申请采购方式**\n${expected}`);
    expect(content).not.toContain('可选采购方式');
    expect(content).not.toContain('综合采购 / 楼内自采');
  });

  it('only offers rejection callbacks for pending items and approves the remainder', () => {
    const card = buildPurchaseManagerBatchApprovalCard({
      ...baseInput,
      items: [
        {
          ...baseInput.items[0],
          status: 'rejected',
          choice: 'reject',
          rejectionReason: '规格不符',
        },
        baseInput.items[1],
      ],
    });
    const callbacks = callbackValues(card);

    expect(
      callbacks.filter((value) => value.action === 'open_item_reject'),
    ).toEqual([
      {
        version: 3,
        action: 'open_item_reject',
        approvalBatchId: baseInput.approvalBatchId,
        executionRecordId: 'rec_batch_2',
      },
    ]);
    expect(collectContents(card).join('\n')).toContain(
      '通过剩余 1 项（综合采购）',
    );
  });

  it('renders a required item rejection editor without trusting a submitted record id', () => {
    const card = buildPurchaseManagerBatchRejectEditorCard(
      baseInput,
      'rec_batch_2',
      { rejectionReason: ' 规格不符\r\n请调整 ' },
    );
    const inputs = collectByTag(card, 'input');
    const submit = collectByTag(card, 'button').find(
      (button) => button.name === 'purchase_batch_item_reject_submit',
    );
    const cancel = collectByTag(card, 'button').find(
      (button) => button.name === 'purchase_batch_item_reject_cancel',
    );

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      name: 'rejection_reason',
      required: true,
      input_type: 'multiline_text',
      max_length: 500,
      default_value: '规格不符\n请调整',
    });
    expect(submit).toMatchObject({
      form_action_type: 'submit',
      type: 'danger_filled',
    });
    expect(submit?.behaviors).toBeUndefined();
    expect(cancel?.form_action_type).toBeUndefined();
    expect(cancel?.behaviors).toEqual([
      {
        type: 'callback',
        value: {
          version: 3,
          action: 'cancel_item_reject',
          approvalBatchId: baseInput.approvalBatchId,
        },
      },
    ]);
    expect(
      collectByTag(card, 'button').every(
        (button) => !button.form_action_type || button.behaviors === undefined,
      ),
    ).toBe(true);
    expect(collectContents(card).join('\n')).toContain('工具收纳盒');
  });

  it('removes every callback from pending and resolved cards', () => {
    const pending = buildPurchaseManagerBatchPendingCard(baseInput);
    const resolved = buildResolvedPurchaseManagerBatchApprovalCard(
      {
        ...baseInput,
        items: [
          {
            ...baseInput.items[0],
            status: 'approved',
            choice: 'comprehensive',
          },
          {
            ...baseInput.items[1],
            status: 'rejected',
            choice: 'reject',
            rejectionReason: '规格不符',
          },
        ],
      },
      {
        actorName: '示例人员020',
        processedAt: '2026-09-12T07:11:59.759Z',
      },
    );

    expect(callbackValues(pending)).toHaveLength(0);
    expect(callbackValues(resolved)).toHaveLength(0);
    expect(
      collectByTag(resolved, 'button').every(
        (button) => button.disabled === true && button.behaviors === undefined,
      ),
    ).toBe(true);
    expect(collectContents(resolved).join('\n')).toContain(
      '1 项通过 · 1 项驳回',
    );
    expect(collectContents(resolved).join('\n')).toContain('规格不符');
    expect(collectContents(resolved).join('\n')).toContain(
      '2026&#45;09&#45;12 15&#58;11',
    );
    expect(collectContents(resolved).join('\n')).not.toContain(
      '2026&#45;09&#45;12T07&#58;11&#58;59.759Z',
    );
  });

  it('round-trips a canonical context and rejects duplicates or extra keys', () => {
    const serialized =
      serializePurchaseManagerBatchApprovalCardContext(baseInput);
    expect(parsePurchaseManagerBatchApprovalCardContext(serialized)).toEqual(
      baseInput,
    );

    const inputWithPurchaseLinks: PurchaseManagerBatchApprovalCardInput = {
      ...baseInput,
      items: [
        {
          ...baseInput.items[0],
          purchaseLinks: [
            'https://item.jd.com/100000000001.html',
            'https://detail.tmall.com/item.htm?id=123456',
          ],
        },
        baseInput.items[1],
      ],
    };
    const serializedWithPurchaseLinks =
      serializePurchaseManagerBatchApprovalCardContext(inputWithPurchaseLinks);
    expect(
      parsePurchaseManagerBatchApprovalCardContext(serializedWithPurchaseLinks),
    ).toEqual(inputWithPurchaseLinks);

    const enrichedInput: PurchaseManagerBatchApprovalCardInput = {
      ...baseInput,
      items: [
        {
          ...baseInput.items[0],
          procurementForm: '单一采购',
          singleReason: '只能向原厂采购以保持兼容',
        },
        {
          ...baseInput.items[1],
          procurementForm: '三方比价',
          singleReason: null,
        },
      ],
    };
    const enrichedSerialized =
      serializePurchaseManagerBatchApprovalCardContext(enrichedInput);
    expect(
      parsePurchaseManagerBatchApprovalCardContext(enrichedSerialized),
    ).toEqual(enrichedInput);
    expect(
      serializePurchaseManagerBatchApprovalCardContext(
        parsePurchaseManagerBatchApprovalCardContext(serialized),
      ),
    ).toBe(serialized);

    expect(() =>
      serializePurchaseManagerBatchApprovalCardContext({
        ...baseInput,
        items: [...baseInput.items, baseInput.items[0]],
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      parsePurchaseManagerBatchApprovalCardContext(
        JSON.stringify({ ...JSON.parse(serialized), injected: true }),
      ),
    ).toThrow(BadRequestException);
  });
});
