import {
  buildPurchaseBatchPurchaserCard,
  buildPurchaseBatchReceiptCompletedCard,
  buildPurchaseBatchReceiptCard,
  parsePurchaseBatchFulfillmentSubmitName,
  purchaseBatchFulfillmentSubmitName,
} from '../../server/modules/purchase-inventory/purchase-batch-fulfillment-card';

describe('purchase batch fulfillment cards', () => {
  it.each(['processing', 'manual_reconciliation'] as const)('does not label %s orders or receipts as completed', (state) => {
    const summary = { approvalBatchId: 'purchase-application-test-state', requesterName: '申请人', building: 'H楼', requestCode: 'CG-TEST' };
    const receipt = buildPurchaseBatchReceiptCard({
      ...summary, requesterOpenId: 'ou_requester',
      items: [{ executionRecordId: 'rec_state', title: '测试物品', specification: '/', requestedQuantity: '1', actualQuantity: 1, unit: '件', requestedAmount: '10', actualAmount: 10, purchaserName: '采购员', purchaseMethod: '综合采购', receiptState: state, signerName: '', receiptTime: null, receiptPhotoCount: 1, invoiceCount: 0 }],
    });
    const order = buildPurchaseBatchPurchaserCard({
      ...summary, purchaserOpenId: 'ou_purchaser', purchaserName: '采购员', expectedDeliveryAt: null,
      items: [{ executionRecordId: 'rec_state', title: '测试物品', specification: '/', quantity: '1', unit: '件', amount: '10', orderState: state, actualQuantity: 1, actualAmount: 10, orderNote: '', orderedAt: null }],
    });
    const expected = state === 'processing' ? '同步中' : '需核对';
    for (const card of [receipt, order]) {
      expect(JSON.stringify(card.header)).toContain(expected);
      expect(JSON.stringify(card.header)).not.toContain('完成');
      expect(JSON.stringify(card.header)).not.toContain('已处理');
      expect(JSON.stringify(card)).not.toContain('behaviors');
    }
  });
  it('renders a read-only receipt completion notice for the purchaser', () => {
    const card = buildPurchaseBatchReceiptCompletedCard({
      requestCode: 'CG260922-601',
      requesterName: '杨浩浩',
      building: 'B楼',
      itemTitle: '一次性屏障消毒面膜',
      purchaseMethod: '综合采购',
      purchaserName: '陈继猛',
      signerName: '杨浩浩',
      receiptTime: '2026-09-22 11:42',
    });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain('采购签收完成');
    expect(serialized).toContain('CG260922&#45;601');
    expect(serialized).toContain('B楼');
    expect(serialized).toContain('杨浩浩');
    expect(serialized).toContain('陈继猛');
    expect(serialized).toContain('一次性屏障消毒面膜');
    expect(serialized).toContain('综合采购');
    expect(serialized).toContain('2026&#45;09&#45;22 11&#58;42');
    expect(serialized).not.toContain('behaviors');
    expect(serialized).not.toContain('button');
  });

  it('renders a compact receipt list before one item is selected', () => {
    const card = buildPurchaseBatchReceiptCard({
      approvalBatchId: 'purchase-application-task-1',
      requesterOpenId: 'ou_requester',
      requesterName: '申请人',
      building: 'H楼',
      requestCode: 'CG260917-601',
      items: [
        {
          executionRecordId: 'rec-1',
          title: 'U盘',
          specification: '金属防水',
          requestedQuantity: '5',
          actualQuantity: 5,
          unit: '个',
          requestedAmount: '300.00',
          actualAmount: 300,
          purchaserName: '采购管理员',
          purchaseMethod: '综合采购',
          receiptState: 'waiting',
          signerName: '',
          receiptTime: null,
          receiptPhotoCount: 1,
          invoiceCount: 0,
        },
      ],
    });
    const elements = (card.body as { elements: Array<Record<string, unknown>> })
      .elements;
    expect(elements.some((element) => element.tag === 'form')).toBe(false);
    expect(JSON.stringify(card)).toContain('填写签收信息');
    expect(JSON.stringify(card)).toContain('"action":"open_receipt"');
    expect(JSON.stringify(card)).not.toContain('刷新材料上传入口');
  });

  it('keeps production receipt form names within the Feishu 100-character limit', () => {
    const approvalBatchId =
      'purchase-application-6c2b09a7-b6d2-4290-b854-655f58f86144';
    const executionRecordId = 'recvvQzdiU7DOl';
    const card = buildPurchaseBatchReceiptCard(
      {
        approvalBatchId,
        requesterOpenId: 'ou_requester',
        requesterName: 'Requester',
        building: 'H',
        requestCode: 'CG260921-001',
        items: [
          {
            executionRecordId,
            title: 'Ladder',
            specification: 'Standard',
            requestedQuantity: '1',
            actualQuantity: 1,
            unit: 'item',
            requestedAmount: '100.00',
            actualAmount: 100,
            purchaserName: 'Purchaser',
            purchaseMethod: '综合采购',
            receiptState: 'waiting',
            signerName: '',
            receiptTime: null,
            receiptPhotoCount: 1,
            invoiceCount: 0,
          },
        ],
      },
      { selectedRecordId: executionRecordId },
    );

    expect(collectElementNames(card).every((name) => name.length <= 100)).toBe(
      true,
    );
    const submitName = purchaseBatchFulfillmentSubmitName(
      'submit_receipt',
      approvalBatchId,
      executionRecordId,
    );
    expect(submitName.length).toBeLessThanOrEqual(100);
    expect(parsePurchaseBatchFulfillmentSubmitName(submitName)).toEqual({
      action: 'submit_receipt',
      approvalBatchId,
      executionRecordId,
    });
  });

  it('keeps two waiting receipt items in one compact list without expiring upload links', () => {
    const item = {
      executionRecordId: 'rec-1',
      title: '门磁开关',
      specification: '/',
      requestedQuantity: '6',
      actualQuantity: 6,
      unit: '个',
      requestedAmount: '300.00',
      actualAmount: 300,
      purchaserName: '采购管理员',
      purchaseMethod: '综合采购',
      receiptState: 'waiting' as const,
      signerName: '',
      receiptTime: null,
      receiptPhotoCount: 1,
      invoiceCount: 0,
    };
    const card = buildPurchaseBatchReceiptCard({
      approvalBatchId: 'purchase-application-task-1',
      requesterOpenId: 'ou_requester',
      requesterName: '申请人',
      building: 'H楼',
      requestCode: 'CG260917-601',
      items: [item, { ...item, executionRecordId: 'rec-2', title: '灭火器' }],
    });
    const elements = (card.body as { elements: Array<Record<string, unknown>> })
      .elements;
    expect(elements.filter((element) => element.tag === 'form')).toEqual([]);
    expect(JSON.stringify(card).match(/填写签收信息/gu)).toHaveLength(2);
    expect(JSON.stringify(card)).not.toContain('https://example.com/receipt-1');
    expect(JSON.stringify(card)).not.toContain('https://example.com/receipt-2');
    expect(JSON.stringify(card)).not.toContain('刷新材料上传入口');
  });

  it('keeps all twenty receipt items actionable within Card 2.0 limits', () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      executionRecordId: `rec-${index + 1}`,
      title: `签收物品 ${index + 1}`,
      specification: '标准规格',
      requestedQuantity: '1',
      actualQuantity: 1,
      unit: '件',
      requestedAmount: '10.00',
      actualAmount: 10,
      purchaserName: '采购管理员',
      receiptState: 'waiting' as const,
      signerName: '',
      receiptTime: null,
      receiptPhotoCount: 0,
      invoiceCount: 0,
    }));
    const card = buildPurchaseBatchReceiptCard({
      approvalBatchId: 'purchase-application-task-20-items',
      requesterOpenId: 'ou_requester',
      requesterName: '申请人',
      building: 'H楼',
      requestCode: 'CG260917-620',
      items,
    });
    const serialized = JSON.stringify(card);
    const elements = (
      card.body as {
        elements: Array<Record<string, unknown>>;
      }
    ).elements;

    expect(countCardElements(elements)).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(
      30 * 1024,
    );
    for (const item of items) {
      expect(serialized).toContain(
        `\"executionRecordId\":\"${item.executionRecordId}\"`,
      );
    }
  });

  it('keeps twenty maximum-length multibyte receipt items actionable within Card 2.0 limits', () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      executionRecordId: `rec-max-${index + 1}`,
      title: `物品${String(index + 1).padStart(2, '0')}${'签'.repeat(196)}`,
      specification: '规格'.repeat(100),
      requestedQuantity: '一'.repeat(200),
      actualQuantity: 1,
      unit: '件'.repeat(200),
      requestedAmount: '十'.repeat(200),
      actualAmount: 10,
      purchaserName: '采购'.repeat(100),
      receiptState: 'waiting' as const,
      signerName: '',
      receiptTime: null,
      receiptPhotoCount: 0,
      invoiceCount: 0,
    }));

    const card = buildPurchaseBatchReceiptCard({
      approvalBatchId: 'purchase-application-task-20-max-items',
      requesterOpenId: 'ou_requester',
      requesterName: '申请'.repeat(100),
      building: '楼栋'.repeat(100),
      requestCode: '单号'.repeat(100),
      items,
    });
    const serialized = JSON.stringify(card);
    const elements = (
      card.body as {
        elements: Array<Record<string, unknown>>;
      }
    ).elements;

    expect(countCardElements(elements)).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(
      30 * 1024,
    );
    expect(collectOpenReceiptRecordIds(card)).toEqual(
      items.map((item) => item.executionRecordId),
    );
    for (const item of items) {
      expect(serialized).toContain(item.title);
    }
  });

  it('keeps maximum-length callback identifiers actionable within the receipt card byte limit', () => {
    const approvalBatchId = `batch-${'a'.repeat(154)}`;
    const items = Array.from({ length: 20 }, (_, index) => {
      const prefix = `rec-${String(index + 1).padStart(2, '0')}-`;
      return {
        executionRecordId: `${prefix}${'x'.repeat(100 - prefix.length)}`,
        title: '📦'.repeat(200),
        specification: '🛠'.repeat(200),
        requestedQuantity: '🔢'.repeat(200),
        actualQuantity: 1,
        unit: '📦'.repeat(200),
        requestedAmount: '💰'.repeat(200),
        actualAmount: 10,
        purchaserName: '🧑'.repeat(200),
        receiptState: 'waiting' as const,
        signerName: '',
        receiptTime: null,
        receiptPhotoCount: 0,
        invoiceCount: 0,
      };
    });

    const card = buildPurchaseBatchReceiptCard({
      approvalBatchId,
      requesterOpenId: 'ou_requester',
      requesterName: '🧑'.repeat(200),
      building: '🏢'.repeat(200),
      requestCode: '🧾'.repeat(200),
      items,
    });
    const serialized = JSON.stringify(card);
    const elements = (
      card.body as {
        elements: Array<Record<string, unknown>>;
      }
    ).elements;

    expect(countCardElements(elements)).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(
      30 * 1024,
    );
    expect(collectElementNames(card).every((name) => name.length <= 100)).toBe(
      true,
    );
    const submitName = purchaseBatchFulfillmentSubmitName(
      'submit_receipt',
      approvalBatchId,
      items[0]!.executionRecordId,
    );
    expect(parsePurchaseBatchFulfillmentSubmitName(submitName)).toEqual({
      action: 'submit_receipt',
      approvalBatchId,
      executionRecordId: items[0]!.executionRecordId,
    });
    expect(collectOpenReceiptRecordIds(card)).toEqual(
      items.map((item) => item.executionRecordId),
    );
  });

  it('rejects execution record identifiers that the callback protocol cannot accept', () => {
    expect(() =>
      buildPurchaseBatchReceiptCard({
        approvalBatchId: 'purchase-application-task-1',
        requesterOpenId: 'ou_requester',
        requesterName: '申请人',
        building: 'H楼',
        requestCode: 'CG260917-601',
        items: [
          {
            executionRecordId: 'r'.repeat(101),
            title: 'U盘',
            specification: '金属防水',
            requestedQuantity: '5',
            actualQuantity: 5,
            unit: '个',
            requestedAmount: '300.00',
            actualAmount: 300,
            purchaserName: '采购管理员',
            receiptState: 'waiting',
            signerName: '',
            receiptTime: null,
            receiptPhotoCount: 1,
            invoiceCount: 0,
          },
        ],
      }),
    ).toThrow('采购签收卡片明细无效');
  });

  it('keeps the receipt submit control disabled and inert in the completed state', () => {
    const card = buildPurchaseBatchReceiptCard({
      approvalBatchId: 'purchase-application-task-1',
      requesterOpenId: 'ou_requester',
      requesterName: '申请人',
      building: 'H楼',
      requestCode: 'CG260917-601',
      items: [
        {
          executionRecordId: 'rec-1',
          title: 'U盘',
          specification: '金属防水',
          requestedQuantity: '5',
          actualQuantity: 5,
          unit: '个',
          requestedAmount: '300.00',
          actualAmount: 300,
          purchaserName: '采购管理员',
          receiptState: 'completed',
          signerName: '现场签收人',
          receiptTime: '2026-09-19 10:00',
          receiptPhotoCount: 1,
          invoiceCount: 0,
        },
      ],
    });
    const elements = (
      card.body as {
        elements: Array<Record<string, unknown>>;
      }
    ).elements;
    const terminalButton = elements.find(
      (element) =>
        element.tag === 'button' &&
        (element.text as { content?: string } | undefined)?.content ===
          '确认签收',
    );

    expect(terminalButton).toMatchObject({
      tag: 'button',
      disabled: true,
      text: { tag: 'plain_text', content: '确认签收' },
    });
    expect(terminalButton).not.toHaveProperty('behaviors');
    expect(terminalButton).not.toHaveProperty('form_action_type');
    expect(terminalButton).not.toHaveProperty('name');
  });

  it('shows one purchaser order form with quantity, amount and note fields', () => {
    const card = buildPurchaseBatchPurchaserCard(
      {
        approvalBatchId: 'purchase-application-task-1',
        purchaserOpenId: 'ou_purchase_admin',
        purchaserName: '采购管理员',
        requesterName: '申请人',
        building: 'H楼',
        requestCode: 'CG260908-001',
        expectedDeliveryAt: '2026-09-20',
        items: [
          {
            executionRecordId: 'rec-1',
            title: '尖嘴钳',
            specification: '8寸',
            quantity: '60',
            unit: '套',
            amount: '834.00',
            orderState: 'waiting',
            actualQuantity: null,
            actualAmount: null,
            orderNote: '',
            orderedAt: null,
            ...({
              purchaseLinks: ['https://item.jd.com/100000000001.html'],
            } as Record<string, unknown>),
          },
        ],
      },
      {
        selectedRecordId: 'rec-1',
        paymentAttachmentUrl:
          'https://www.sm.sjhl.online:3001/purchase-card-attachments?t=signed',
      },
    );
    const text = JSON.stringify(card);
    const elements = (card.body as { elements: Array<Record<string, unknown>> })
      .elements;
    const form = elements.find((element) => element.tag === 'form') as Record<
      string,
      unknown
    >;
    const formElements = form.elements as Array<Record<string, unknown>>;
    const quantityInput = formElements.find(
      (element) => element.name === 'actual_quantity',
    );
    const amountInput = formElements.find(
      (element) => element.name === 'actual_amount',
    );
    const purchaseLinkButton = elements.find((element) =>
      JSON.stringify(element).includes('https://item.jd.com/100000000001.html'),
    );
    expect(text).toContain('actual_quantity');
    expect(text).toContain('actual_amount');
    expect(text).toContain('order_note');
    expect(text).toContain(
      'purchase_batch_order_submit:purchase-application-task-1:rec-1',
    );
    expect(text).toContain('补充付款附件');
    expect(quantityInput).not.toHaveProperty('default_value');
    expect(amountInput).not.toHaveProperty('default_value');
    expect(purchaseLinkButton).toMatchObject({
      tag: 'button',
      behaviors: [
        {
          type: 'open_url',
          default_url: 'https://item.jd.com/100000000001.html',
        },
      ],
    });
    expect(JSON.stringify(form)).not.toContain(
      'https://item.jd.com/100000000001.html',
    );
    expect(JSON.stringify(form)).not.toContain('"behaviors"');
    expect(form).toMatchObject({
      tag: 'form',
      direction: 'vertical',
      vertical_spacing: '12px',
    });
    expect(
      (form.elements as Array<Record<string, unknown>>).filter(
        (element) => element.tag === 'button',
      ),
    ).toEqual([
      expect.objectContaining({
        name: 'purchase_batch_order_submit:purchase-application-task-1:rec-1',
        form_action_type: 'submit',
      }),
    ]);
    expect(
      elements.some((element) =>
        JSON.stringify(element).includes('return_purchase_list'),
      ),
    ).toBe(true);
  });

  it('preserves explicit retry values without inventing initial order defaults', () => {
    const card = buildPurchaseBatchPurchaserCard(
      {
        approvalBatchId: 'purchase-application-task-1',
        purchaserOpenId: 'ou_purchase_admin',
        purchaserName: '采购管理员',
        requesterName: '申请人',
        building: 'H楼',
        requestCode: 'CG260908-001',
        expectedDeliveryAt: '2026-09-20',
        items: [
          {
            executionRecordId: 'rec-1',
            title: '尖嘴钳',
            specification: '8寸',
            quantity: '60',
            unit: '套',
            amount: '834.00',
            orderState: 'waiting',
            actualQuantity: 2,
            actualAmount: 0,
            orderNote: '失败后保留草稿',
            orderedAt: null,
          },
        ],
      },
      { selectedRecordId: 'rec-1' },
    );
    const form = (
      card.body as { elements: Array<Record<string, unknown>> }
    ).elements.find((element) => element.tag === 'form') as {
      elements: Array<Record<string, unknown>>;
    };

    expect(
      form.elements.find((element) => element.name === 'actual_quantity'),
    ).toMatchObject({ default_value: '2' });
    expect(
      form.elements.find((element) => element.name === 'actual_amount'),
    ).toMatchObject({ default_value: '0' });
    expect(
      form.elements.find((element) => element.name === 'order_note'),
    ).toMatchObject({ default_value: '失败后保留草稿' });
  });

  it('requires both receipt photo and invoice for self purchase', () => {
    const base = {
      approvalBatchId: 'purchase-application-task-1',
      requesterOpenId: 'ou_requester',
      requesterName: '申请人',
      building: 'H楼',
      requestCode: 'CG260908-001',
      items: [
        {
          executionRecordId: 'rec-1',
          title: '尖嘴钳',
          specification: '8寸',
          requestedQuantity: '60',
          actualQuantity: 60,
          unit: '套',
          requestedAmount: '834.00',
          actualAmount: 828.46,
          purchaserName: '采购管理员',
          purchaseMethod: '需求自采（楼内）',
          receiptState: 'waiting' as const,
          signerName: '',
          receiptTime: null,
          receiptPhotoCount: 0,
          invoiceCount: 0,
        },
      ],
    };
    const blockedCard = buildPurchaseBatchReceiptCard(base, {
      selectedRecordId: 'rec-1',
    });
    const blocked = JSON.stringify(blockedCard);
    const blockedElements = (
      blockedCard.body as { elements: Array<Record<string, unknown>> }
    ).elements;
    const blockedForm = blockedElements.find(
      (element) => element.tag === 'form',
    ) as Record<string, unknown>;
    expect(blocked).toContain('签收照片、发票未上传');
    expect(blocked).toContain('"disabled":true');
    expect(blocked).not.toContain('http://');
    expect(blocked).not.toContain('https://');
    expect(collectFulfillmentActions(blockedCard)).toEqual(
      expect.arrayContaining(['prepare_receipt_photo', 'prepare_invoice']),
    );
    expect(JSON.stringify(blockedForm)).not.toContain('"behaviors"');
    expect(blockedForm).toMatchObject({
      tag: 'form',
      direction: 'vertical',
      vertical_spacing: '12px',
    });
    expect(
      (blockedForm.elements as Array<Record<string, unknown>>).filter(
        (element) => element.tag === 'button',
      ),
    ).toEqual([
      expect.objectContaining({
        name: 'purchase_batch_receipt_submit:purchase-application-task-1:rec-1',
        form_action_type: 'submit',
      }),
    ]);
    expect(
      blockedElements.some((element) =>
        JSON.stringify(element).includes('return_receipt_list'),
      ),
    ).toBe(true);

    const ready = JSON.stringify(
      buildPurchaseBatchReceiptCard(
        {
          ...base,
          items: [{ ...base.items[0], receiptPhotoCount: 1, invoiceCount: 1 }],
        },
        { selectedRecordId: 'rec-1' },
      ),
    );
    expect(ready).toContain('确认签收');
    expect(ready).toContain('"disabled":false');
    expect(ready).toContain('"tag":"select_person"');
    expect(ready).toMatch(/"name":"signer_open_id_[a-f0-9]{16}"/);
    expect(ready).toContain('"initial_option":"ou_requester"');
    expect(ready).toContain('"required":true');
  });

  it('allows a comprehensive purchase to submit with a receipt photo only', () => {
    const card = buildPurchaseBatchReceiptCard(
      {
        approvalBatchId: 'purchase-application-task-1',
        requesterOpenId: 'ou_requester',
        requesterName: '申请人',
        building: 'H楼',
        requestCode: 'CG260908-002',
        items: [
          {
            executionRecordId: 'rec-1',
            title: '梯子',
            specification: '2.5米',
            requestedQuantity: '1',
            actualQuantity: 1,
            unit: '个',
            requestedAmount: '300.00',
            actualAmount: 300,
            purchaserName: '采购管理员',
            purchaseMethod: '综合采购',
            receiptState: 'waiting',
            signerName: '',
            receiptTime: null,
            receiptPhotoCount: 1,
            invoiceCount: 0,
          },
        ],
      },
      { selectedRecordId: 'rec-1' },
    );
    const serialized = JSON.stringify(card);

    expect(serialized).toContain('发票：无需上传');
    expect(serialized).toContain('确认签收');
    expect(serialized).toContain('"disabled":false');
    expect(collectFulfillmentActions(card)).toContain('prepare_receipt_photo');
    expect(collectFulfillmentActions(card)).not.toContain('prepare_invoice');
  });
});

function collectFulfillmentActions(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectFulfillmentActions(entry));
  }
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.action === 'string' ? [record.action] : []),
    ...Object.values(record).flatMap((entry) =>
      collectFulfillmentActions(entry),
    ),
  ];
}

function countCardElements(elements: Array<Record<string, unknown>>): number {
  return elements.reduce((count, element) => {
    const children = Array.isArray(element.elements)
      ? (element.elements as Array<Record<string, unknown>>)
      : [];
    return count + 1 + countCardElements(children);
  }, 0);
}

function collectOpenReceiptRecordIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectOpenReceiptRecordIds(entry));
  }
  if (!value || typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  return [
    ...(record.action === 'open_receipt' &&
    typeof record.executionRecordId === 'string'
      ? [record.executionRecordId]
      : []),
    ...Object.values(record).flatMap((entry) =>
      collectOpenReceiptRecordIds(entry),
    ),
  ];
}

function collectElementNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectElementNames(entry));
  }
  if (!value || typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.name === 'string' ? [record.name] : []),
    ...Object.values(record).flatMap((entry) => collectElementNames(entry)),
  ];
}
