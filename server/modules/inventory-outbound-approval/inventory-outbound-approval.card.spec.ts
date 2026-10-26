import {
  buildInventoryOutboundAcceptedCard,
  buildInventoryOutboundApprovalCard,
  buildInventoryOutboundRejectionPromptCard,
  buildInventoryOutboundSupersededCard,
  buildInventoryOutboundTerminalCard,
} from './inventory-outbound-approval.card';
import type {
  InventoryOutboundApprovalDecision,
  InventoryOutboundApprovalSnapshot,
} from './inventory-outbound-approval.types';

const snapshot: InventoryOutboundApprovalSnapshot = {
  recordId: 'rec_outbound_001',
  outboundNumber: 'OUT-20260826-001',
  version: 1,
  policyVersion: 'warehouse-manager-v1',
  applicantOpenId: 'ou_applicant',
  applicantName: '刘小杏',
  itemName: '地磅秤',
  sku: 'B1056',
  specification: '0.6*0.8米1吨',
  brand: '正峰',
  quantity: 1,
  unit: '台',
  availableStock: 3,
  building: 'H楼',
  location: 'H-2F-226储存间01-0F',
  reason: '设备检修现场使用',
  appliedAt: '2026-08-26T10:30:00+08:00',
  approvers: [{ openId: 'ou_manager', name: '示例人员009' }],
};

const approvedDecision: InventoryOutboundApprovalDecision = {
  action: 'approve',
  actorOpenId: 'ou_manager',
  actorName: '示例人员009',
  messageId: 'om_outbound_approval_1',
  eventId: 'ws_inventory_outbound_approve',
  decidedAt: '2026-08-26T10:35:00+08:00',
  reason: '',
};

describe('inventory outbound approval cards', () => {
  it('shows the complete outbound snapshot and exact versioned approval actions', () => {
    const card = buildInventoryOutboundApprovalCard(snapshot);
    const serialized = JSON.stringify(card);
    const buttons = collectButtons(card);

    for (const expected of [
      '出库编号',
      'OUT-20260826-001',
      '地磅秤',
      'B1056',
      '正峰',
      '1 台',
      '3 台',
      'H楼',
      'H-2F-226储存间01-0F',
      '刘小杏',
      '设备检修现场使用',
      '2026-08-26 10:30',
    ]) {
      expect(serialized).toContain(expected);
    }
    expect(collectVisibleText(card)).toContain('0.6\\*0.8米1吨');
    expect(collectVisibleText(card)).not.toContain('rec_outbound_001');
    expect(buttons).toHaveLength(2);
    expect(buttons.map(callbackValue)).toEqual([
      {
        workflowType: 'inventory_outbound',
        action: 'approve',
        recordId: 'rec_outbound_001',
        version: 1,
      },
      {
        workflowType: 'inventory_outbound',
        action: 'open_reject',
        recordId: 'rec_outbound_001',
        version: 1,
      },
    ]);
  });

  it('opens a rejection form with a bound return action and no reject decision callback', () => {
    const card = buildInventoryOutboundRejectionPromptCard(snapshot);
    const serialized = JSON.stringify(card);
    const buttons = collectButtons(card);

    expect(serialized).toContain('尚未提交驳回');
    expect(serialized).toContain('inventory_outbound_rejection_reason');
    expect(serialized).toContain(
      'inventory_outbound_reject_submit:rec_outbound_001:1',
    );
    expect(serialized).toContain('确认驳回');
    expect(serialized).not.toContain('"action":"reject"');
    expect(buttons.map(buttonText)).toEqual(['确认驳回', '返回审批']);
    expect(callbackValue(buttons[1])).toEqual({
      workflowType: 'inventory_outbound',
      action: 'return_to_approval',
      recordId: 'rec_outbound_001',
      version: 1,
    });
  });

  it.each([
    ['accepted', buildInventoryOutboundAcceptedCard],
    ['terminal', buildInventoryOutboundTerminalCard],
  ] as const)(
    'renders the %s approval result with disabled choices and no callback',
    (_label, build) => {
      const card = build(snapshot, approvedDecision);
      const serialized = JSON.stringify(card);
      const buttons = collectButtons(card);

      expect(serialized).toContain('审批通过');
      if (_label === 'accepted') {
        expect(serialized).toContain('正在复核实时库存并办理正式出库');
      } else {
        expect(serialized).toContain('库存已扣减并完成正式出库');
      }
      expect(serialized).toContain('示例人员009');
      expect(buttons).toHaveLength(2);
      expect(buttons.map(buttonText)).toEqual(['同意', '驳回']);
      expect(buttons.every((button) => button.disabled === true)).toBe(true);
      expect(buttons.every((button) => !('behaviors' in button))).toBe(true);
      expect(serialized).not.toContain('callback');
    },
  );

  it('marks the final approval card as formally outbound with no second confirmation', () => {
    const card = buildInventoryOutboundTerminalCard(snapshot, approvedDecision);
    const serialized = JSON.stringify(card);

    expect(serialized).toContain('出库完成');
    expect(serialized).toContain('库存已扣减并完成正式出库');
    expect(serialized).not.toContain('待库房确认');
    expect(serialized).not.toContain('确认后才会扣减库存');
  });

  it('shows the required reason on accepted and final rejection cards', () => {
    const rejected: InventoryOutboundApprovalDecision = {
      ...approvedDecision,
      action: 'reject',
      eventId: 'ws_inventory_outbound_reject',
      reason: '当前库存需保留应急使用',
    };

    for (const card of [
      buildInventoryOutboundAcceptedCard(snapshot, rejected),
      buildInventoryOutboundTerminalCard(snapshot, rejected),
    ]) {
      const serialized = JSON.stringify(card);
      expect(serialized).toContain('审批驳回');
      expect(serialized).toContain('驳回原因');
      expect(serialized).toContain('当前库存需保留应急使用');
      expect(serialized).not.toContain('callback');
    }
  });

  it('uses the canonical multiline rejection reason rules in result cards', () => {
    const rejected: InventoryOutboundApprovalDecision = {
      ...approvedDecision,
      action: 'reject',
      reason: `  ${'😀'.repeat(497)}\r\n结束  `,
    };

    expect(() =>
      buildInventoryOutboundTerminalCard(snapshot, rejected),
    ).not.toThrow();
    expect(() =>
      buildInventoryOutboundTerminalCard(snapshot, {
        ...rejected,
        reason: '库存\t不足',
      }),
    ).toThrow('驳回原因需填写 2–500 字');
  });

  it('supports a positive safe approval version and renders an old card as invalidated', () => {
    expect(() =>
      buildInventoryOutboundApprovalCard({ ...snapshot, version: 2 }),
    ).not.toThrow();
    const serialized = JSON.stringify(
      buildInventoryOutboundSupersededCard(snapshot, 2),
    );
    expect(serialized).toContain('审批已失效');
    expect(serialized).toContain('已重新路由给当前库房示例人员019员');
    expect(serialized).not.toContain('callback');
  });
});

function collectButtons(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(collectButtons);
  const object = value as Record<string, unknown>;
  return [
    ...(object.tag === 'button' ? [object] : []),
    ...Object.values(object).flatMap(collectButtons),
  ];
}

function callbackValue(button: Record<string, unknown>): unknown {
  const behaviors = button.behaviors as Array<Record<string, unknown>>;
  return behaviors?.[0]?.value;
}

function buttonText(button: Record<string, unknown>): string {
  const text = button.text as Record<string, unknown> | undefined;
  return typeof text?.content === 'string' ? text.content : '';
}

function collectVisibleText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) return value.map(collectVisibleText).join(' ');
  const object = value as Record<string, unknown>;
  return [
    typeof object.content === 'string' ? object.content : '',
    ...Object.values(object).map(collectVisibleText),
  ].join(' ');
}
