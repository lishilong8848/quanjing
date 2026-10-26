import { BadRequestException } from '@nestjs/common';
import {
  buildPurchaseManagerApprovalCard,
  buildPurchaseManagerManualReconciliationCard,
  buildPurchaseManagerPendingCard,
  buildPurchaseManagerRejectEditorCard,
  buildResolvedPurchaseManagerApprovalCard,
  parsePurchaseManagerApprovalCardContext,
  serializePurchaseManagerApprovalCardContext,
  type PurchaseManagerApprovalCardInput,
  type PurchaseManagerApprovalChoice,
} from '../../server/modules/purchase-inventory/purchase-manager-approval-card';

type JsonObject = Record<string, unknown>;

const baseInput: PurchaseManagerApprovalCardInput = {
  executionRecordId: 'rec_manager_approval_1',
  requester: '陶必亮',
  building: 'D楼',
  title: '直流屏绝缘监测仪',
  quantity: 1,
  unit: '台',
  amount: 1280.5,
  procurementForm: '三方比价',
  expectedDeliveryAt: '2026-08-08',
  requestCode: 'CG260730-402',
  createdAt: '2026-07-31 09:30',
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

function buttonLabels(card: unknown): string[] {
  return collectByTag(card, 'button').map((button) => {
    const text = button.text as JsonObject | undefined;
    return typeof text?.content === 'string' ? text.content : '';
  });
}

function callbackActions(card: unknown): unknown[] {
  return collectByTag(card, 'button').flatMap((button) => {
    const behaviors = button.behaviors;
    if (!Array.isArray(behaviors)) return [];
    return behaviors.flatMap((behavior) => {
      if (
        !behavior ||
        typeof behavior !== 'object' ||
        (behavior as JsonObject).type !== 'callback'
      ) {
        return [];
      }
      const value = (behavior as JsonObject).value as JsonObject | undefined;
      return value?.action === undefined ? [] : [value.action];
    });
  });
}

function collectContent(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectContent);
  if (!value || typeof value !== 'object') return [];
  const object = value as JsonObject;
  return [
    ...(typeof object.content === 'string' ? [object.content] : []),
    ...Object.values(object).flatMap(collectContent),
  ];
}

describe('purchase manager approval Card 2.0', () => {
  it('renders exactly three initial choices without a rejection input', () => {
    const card = buildPurchaseManagerApprovalCard(baseInput);

    expect(card).toMatchObject({
      schema: '2.0',
      config: {
        update_multi: true,
        enable_forward: false,
      },
    });
    expect(buttonLabels(card)).toEqual(['综合采购', '楼内自采', '驳回']);
    expect(callbackActions(card)).toEqual([
      'choose_comprehensive',
      'choose_building_self',
      'open_reject',
    ]);
    expect(collectByTag(card, 'input')).toHaveLength(0);
  });

  it('shows H-building applications as comprehensive-only', () => {
    const card = buildPurchaseManagerApprovalCard({
      ...baseInput,
      building: 'H楼',
    });

    expect(buttonLabels(card)).toEqual(['综合采购', '驳回']);
    expect(callbackActions(card)).toEqual([
      'choose_comprehensive',
      'open_reject',
    ]);
    const content = collectContent(card).join('\n');
    expect(content).toContain('可选采购方式');
    expect(content).toContain('综合采购');
    expect(content).not.toContain('楼内自采');
  });

  it('renders procurement details and only shows the single-procurement reason when applicable', () => {
    const singleCard = buildPurchaseManagerApprovalCard({
      ...baseInput,
      procurementForm: '单一采购',
      singleReason: '  原厂**独家**\u0000\r\n供应  ',
      requester: '  <陶必亮>  ',
    });
    const singleContent = collectContent(singleCard).join('\n');

    for (const expected of [
      '申请人',
      '&#60;陶必亮&#62;',
      '楼栋',
      'D楼',
      '物品',
      '直流屏绝缘监测仪',
      '数量',
      '1 台',
      '金额',
      '1280.5',
      '采购形式',
      '单一采购',
      '单一原因',
      '原厂&#42;&#42;独家&#42;&#42; 供应',
      '计划到货',
      '2026&#45;08&#45;08',
      '采购编码',
      'CG260730&#45;402',
      '申请时间',
      '2026&#45;07&#45;31 09&#58;30',
    ]) {
      expect(singleContent).toContain(expected);
    }
    expect(singleContent).not.toContain('\u0000');

    const comparisonContent = collectContent(
      buildPurchaseManagerApprovalCard({
        ...baseInput,
        singleReason: '不应显示',
      }),
    ).join('\n');
    expect(comparisonContent).not.toContain('单一原因');
    expect(comparisonContent).not.toContain('不应显示');
  });

  it('escapes untrusted lark_md text with a single HTML-entity pass', () => {
    const dangerousText =
      '<at id=all></at> [打开](https://evil.example/a_b): #_*~ > & \\' +
      '`{}!|+-()';
    const card = buildPurchaseManagerApprovalCard({
      ...baseInput,
      title: dangerousText,
    });
    const itemContent = collectContent(card).find((content) =>
      content.startsWith('**物品**\n'),
    );
    const renderedValue = itemContent?.slice('**物品**\n'.length);

    expect(renderedValue).toBe(
      '&#60;at id=all&#62;&#60;/at&#62; ' +
        '&#91;打开&#93;&#40;https&#58;//evil.example/a&#95;b&#41;&#58; ' +
        '&#35;&#95;&#42;&#126; &#62; &#38; ' +
        '&#92;&#96;&#123;&#125;&#33;&#124;&#43;&#45;&#40;&#41;',
    );
    expect(renderedValue).not.toContain('<at');
    expect(renderedValue).not.toContain('[打开]');
    expect(renderedValue).not.toContain('(https');
    expect(renderedValue).not.toContain('&#38;#60;');
    expect(renderedValue).not.toContain('\\');
  });

  it('renders the single-procurement reason as a full-width four-line field', () => {
    const card = buildPurchaseManagerApprovalCard({
      ...baseInput,
      procurementForm: '单一采购',
      singleReason: '原厂独家供应，无法进行三方比价',
    });
    const fields = collectByTag(card, 'div').flatMap((element) =>
      Array.isArray(element.fields) ? (element.fields as JsonObject[]) : [],
    );
    const singleReasonField = fields.find((field) => {
      const text = field.text as JsonObject | undefined;
      return (
        typeof text?.content === 'string' &&
        text.content.startsWith('**单一原因**\n')
      );
    });

    expect(singleReasonField).toMatchObject({
      is_short: false,
      text: {
        tag: 'lark_md',
        lines: 4,
      },
    });
  });

  it('reopens the initial choices with a safe synchronization error', () => {
    const card = buildPurchaseManagerApprovalCard(baseInput, {
      errorMessage: ' 多维表**同步失败**\u0000，请重试 ',
    });
    const content = collectContent(card).join('\n');

    expect(content).toContain('同步提示');
    expect(content).toContain('多维表&#42;&#42;同步失败&#42;&#42;，请重试');
    expect(content).not.toContain('\u0000');
    expect(callbackActions(card)).toEqual([
      'choose_comprehensive',
      'choose_building_self',
      'open_reject',
    ]);
  });

  it('renders the reject editor as a uniquely named root form with only one submit button', () => {
    const card = buildPurchaseManagerRejectEditorCard(baseInput, {
      rejectionReason: ' 预算超限\r\n请重新申请 ',
      errorMessage: ' 上次同步**失败**\u0000 ',
    });
    const body = card.body as JsonObject;
    const bodyElements = body.elements as JsonObject[];
    const form = bodyElements.find((element) => element.tag === 'form');
    const input = collectByTag(form, 'input')[0];
    const buttons = collectByTag(form, 'button');

    expect(form).toBeDefined();
    expect(collectByTag(card, 'form')).toHaveLength(1);
    expect(input).toMatchObject({
      tag: 'input',
      name: 'rejection_reason',
      required: true,
      input_type: 'multiline_text',
      max_length: 500,
      default_value: '预算超限\n请重新申请',
    });
    expect(buttonLabels(form)).toEqual(['综合采购', '楼内自采', '确认驳回']);
    expect(buttons[0]).toMatchObject({
      name: 'purchase_reject_comprehensive_disabled',
      disabled: true,
      form_action_type: 'reset',
    });
    expect(buttons[1]).toMatchObject({
      name: 'purchase_reject_building_self_disabled',
      disabled: true,
      form_action_type: 'reset',
    });
    expect(buttons[2]).toMatchObject({
      name: 'purchase_reject_submit',
      form_action_type: 'submit',
    });
    expect(buttons.every((button) => button.behaviors === undefined)).toBe(
      true,
    );
    expect(
      new Set([form?.name, input.name, ...buttons.map((button) => button.name)])
        .size,
    ).toBe(5);
    expect(collectContent(card).join('\n')).toContain(
      '上次同步&#42;&#42;失败&#42;&#42;',
    );
    expect(card.config).toMatchObject({ enable_forward: false });
  });

  it.each([
    ['comprehensive', 'primary_filled'],
    ['building_self', 'primary_filled'],
    ['reject', 'danger_filled'],
  ] as const)(
    'locks all three choices while %s is synchronizing',
    (choice, selectedType) => {
      const card = buildPurchaseManagerPendingCard(baseInput, choice);
      const buttons = collectByTag(card, 'button');
      const selectedIndex = (
        ['comprehensive', 'building_self', 'reject'] as const
      ).indexOf(choice);

      expect(buttonLabels(card)).toEqual(['综合采购', '楼内自采', '驳回']);
      expect(buttons).toHaveLength(3);
      expect(buttons.every((button) => button.disabled === true)).toBe(true);
      expect(buttons.every((button) => button.behaviors === undefined)).toBe(
        true,
      );
      expect(buttons[selectedIndex].type).toBe(selectedType);
      expect(collectByTag(card, 'input')).toHaveLength(0);
      expect(card.config).toMatchObject({ enable_forward: false });
    },
  );

  it('locks a manual-reconciliation card and only highlights an optional known choice', () => {
    const card = buildPurchaseManagerManualReconciliationCard(baseInput);
    const buttons = collectByTag(card, 'button');
    const content = collectContent(card).join('\n');

    expect(buttonLabels(card)).toEqual(['综合采购', '楼内自采', '驳回']);
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.disabled === true)).toBe(true);
    expect(buttons.every((button) => button.behaviors === undefined)).toBe(
      true,
    );
    expect(callbackActions(card)).toHaveLength(0);
    expect(buttons.map((button) => button.type)).toEqual([
      'default',
      'default',
      'default',
    ]);
    expect(content).toContain('需人工核对');
    expect(content).not.toContain('token');
    expect(card.config).toMatchObject({ enable_forward: false });

    const selectedButtons = collectByTag(
      buildPurchaseManagerManualReconciliationCard(baseInput, {
        choice: 'building_self',
        message: '请联系管理员核对审批记录',
      }),
      'button',
    );
    expect(selectedButtons.map((button) => button.type)).toEqual([
      'default',
      'primary_filled',
      'default',
    ]);
  });

  it.each([
    ['comprehensive', '综合采购', 'green'],
    ['building_self', '楼内自采', 'green'],
    ['reject', '驳回', 'red'],
  ] as ReadonlyArray<readonly [PurchaseManagerApprovalChoice, string, string]>)(
    'renders a terminal non-interactive %s result',
    (choice, choiceLabel, headerTemplate) => {
      const card = buildResolvedPurchaseManagerApprovalCard(baseInput, {
        choice,
        actorName: '示例人员020',
        processedAt: '2026-07-31 10:00',
        rejectionReason: '预算不符合要求',
      });
      const buttons = collectByTag(card, 'button');
      const content = collectContent(card).join('\n');

      expect((card.header as JsonObject).template).toBe(headerTemplate);
      expect(buttonLabels(card)).toEqual(['综合采购', '楼内自采', '驳回']);
      expect(buttons.every((button) => button.disabled === true)).toBe(true);
      expect(buttons.every((button) => button.behaviors === undefined)).toBe(
        true,
      );
      expect(content).toContain('处理结果');
      expect(content).toContain(choiceLabel);
      expect(content).toContain('处理人');
      expect(content).toContain('示例人员020');
      expect(content).toContain('处理时间');
      expect(content).toContain('2026&#45;07&#45;31 10&#58;00');
      if (choice === 'reject') {
        expect(content).toContain('驳回原因');
        expect(content).toContain('预算不符合要求');
      } else {
        expect(content).not.toContain('驳回原因');
        expect(content).not.toContain('预算不符合要求');
      }
      expect(collectByTag(card, 'input')).toHaveLength(0);
      expect(card.config).toMatchObject({ enable_forward: false });
    },
  );

  it('serializes a bounded whitelist-only card context and parses the canonical value', () => {
    const serialized = serializePurchaseManagerApprovalCardContext({
      ...baseInput,
      requester: '  陶\u0000必亮  ',
      singleReason: '不适用',
      rogueSecret: 'must-not-be-stored',
    } as PurchaseManagerApprovalCardInput & { rogueSecret: string });
    const raw = JSON.parse(serialized) as JsonObject;

    expect(Object.keys(raw).sort()).toEqual(
      [
        'amount',
        'building',
        'createdAt',
        'executionRecordId',
        'expectedDeliveryAt',
        'procurementForm',
        'quantity',
        'requestCode',
        'requester',
        'singleReason',
        'title',
        'unit',
        'version',
      ].sort(),
    );
    expect(raw).not.toHaveProperty('rogueSecret');
    expect(raw.requester).toBe('陶必亮');
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(12_000);
    expect(parsePurchaseManagerApprovalCardContext(serialized)).toEqual({
      executionRecordId: 'rec_manager_approval_1',
      requester: '陶必亮',
      building: 'D楼',
      title: '直流屏绝缘监测仪',
      quantity: '1',
      unit: '台',
      amount: '1280.5',
      procurementForm: '三方比价',
      singleReason: null,
      expectedDeliveryAt: '2026-08-08',
      requestCode: 'CG260730-402',
      createdAt: '2026-07-31 09:30',
    });
  });

  it.each([
    { description: 'invalid JSON', value: 'not json' },
    {
      description: 'extra key',
      value: JSON.stringify({
        version: 1,
        executionRecordId: 'rec_1',
        requester: '申请人',
        building: 'D楼',
        title: '物品',
        quantity: '1',
        unit: '台',
        amount: null,
        procurementForm: '三方比价',
        singleReason: null,
        expectedDeliveryAt: null,
        requestCode: null,
        createdAt: null,
        token: 'secret',
      }),
    },
    {
      description: 'control character',
      value: JSON.stringify({
        version: 1,
        executionRecordId: 'rec_1',
        requester: '申请人',
        building: 'D楼',
        title: `物${'\u0000'}品`,
        quantity: '1',
        unit: '台',
        amount: null,
        procurementForm: '三方比价',
        singleReason: null,
        expectedDeliveryAt: null,
        requestCode: null,
        createdAt: null,
      }),
    },
    {
      description: 'overlong field',
      value: JSON.stringify({
        version: 1,
        executionRecordId: 'rec_1',
        requester: '申请人',
        building: 'D楼',
        title: '物'.repeat(201),
        quantity: '1',
        unit: '台',
        amount: null,
        procurementForm: '三方比价',
        singleReason: null,
        expectedDeliveryAt: null,
        requestCode: null,
        createdAt: null,
      }),
    },
    { description: 'overlong context', value: 'x'.repeat(12_001) },
  ])('rejects a non-canonical card context: $description', ({ value }) => {
    expect(() => parsePurchaseManagerApprovalCardContext(value)).toThrow(
      BadRequestException,
    );
  });

  it('keeps every state below the 30 KB Feishu card limit with maximal dynamic text', () => {
    const maximalInput: PurchaseManagerApprovalCardInput = {
      ...baseInput,
      requester: '*'.repeat(200),
      building: '<'.repeat(200),
      title: '_'.repeat(200),
      quantity: '9'.repeat(40),
      unit: '`'.repeat(40),
      amount: '8'.repeat(200),
      procurementForm: '单一采购',
      singleReason: '!'.repeat(500),
      expectedDeliveryAt: '{'.repeat(200),
      requestCode: '['.repeat(200),
      createdAt: '~'.repeat(200),
    };
    const cards = [
      buildPurchaseManagerApprovalCard(maximalInput, {
        errorMessage: '*'.repeat(200),
      }),
      buildPurchaseManagerRejectEditorCard(maximalInput, {
        rejectionReason: '驳'.repeat(500),
        errorMessage: '!'.repeat(200),
      }),
      buildPurchaseManagerManualReconciliationCard(maximalInput, {
        choice: 'reject',
        message: '核'.repeat(200),
      }),
      ...(['comprehensive', 'building_self', 'reject'] as const).map((choice) =>
        buildPurchaseManagerPendingCard(maximalInput, choice),
      ),
      ...(['comprehensive', 'building_self', 'reject'] as const).map((choice) =>
        buildResolvedPurchaseManagerApprovalCard(maximalInput, {
          choice,
          actorName: '马'.repeat(200),
          processedAt: '时'.repeat(200),
          rejectionReason: '驳'.repeat(500),
        }),
      ),
    ];

    for (const card of cards) {
      expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThan(
        30 * 1024,
      );
      expect(collectContent(card).join('\n')).toContain('采购形式');
    }
  });
});
