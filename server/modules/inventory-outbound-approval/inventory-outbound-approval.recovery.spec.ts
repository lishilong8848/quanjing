import type { InventoryOutboundApprovalSnapshot } from './inventory-outbound-approval.types';
import { parseInventoryOutboundApprovalRecoveryRecord } from './inventory-outbound-approval.recovery';

const APPROVER_ONE_UUID = 'd93684e4-5d87-5e38-bed4-044b82a117dd';
const APPROVER_TWO_UUID = '25b5975f-0b1b-5229-98aa-97bf1ee98293';
const RESULT_APPLICANT_UUID = '997479e7-fa34-5e96-8fdc-102d1166052a';
const RESULT_APPROVER_ONE_UUID = 'c68676ae-8c06-5941-98f8-60d33fbb7f02';
const RESULT_APPROVER_TWO_UUID = '79351102-2624-54ee-8a30-ad6c91de7c2e';

describe('parseInventoryOutboundApprovalRecoveryRecord', () => {
  it('returns not_registered only for a waiting-route record without a snapshot', () => {
    expect(
      parseInventoryOutboundApprovalRecoveryRecord({
        recordId: 'rec_outbound_1',
        fields: { 出库工作流状态: { select: { name: '待路由' } } },
      }),
    ).toEqual({
      kind: 'not_registered',
      recordId: 'rec_outbound_1',
      workflowStatus: '待路由',
    });
  });

  it('parses wrapped pending fields and restores a complete, stable delivery ledger', () => {
    const inputSnapshot = snapshot({
      approvers: [
        { openId: 'ou_inventory_approver_2', name: '审批人二' },
        { openId: 'ou_inventory_approver_1', name: '审批人一' },
      ],
    });
    const result = parseInventoryOutboundApprovalRecoveryRecord(
      record({
        程序出库状态: [{ text: '待审批' }],
        出库工作流状态: { value: { name: '待审批' } },
        出库当前审批人: {
          users: [
            { open_id: 'ou_inventory_approver_2', name: '审批人二' },
            { id: 'ou_inventory_approver_1', name: '审批人一' },
          ],
        },
        出库审批策略版本: { text: inputSnapshot.policyVersion },
        出库审批快照: richTextJson({
          schemaVersion: 1,
          snapshot: inputSnapshot,
        }),
        出库审批投递台账: {
          value: JSON.stringify(deliveryLedger(inputSnapshot)),
        },
      }),
    );

    expect(result).toEqual({
      kind: 'pending',
      snapshot: snapshot(),
      deliveries: [deliveryOne(), deliveryTwo()],
    });
  });

  it('allows a pending snapshot before its delivery ledger is persisted', () => {
    expect(
      parseInventoryOutboundApprovalRecoveryRecord(
        record(pendingFields({ 出库审批投递台账: null })),
      ),
    ).toEqual({ kind: 'pending', snapshot: snapshot(), deliveries: [] });
  });

  it('parses a v2 pending snapshot with notification-only warehouse managers', () => {
    const inputSnapshot = snapshot({
      managerRecipients: [
        { openId: 'ou_inventory_manager', name: '库房管理人' },
      ],
    });

    expect(
      parseInventoryOutboundApprovalRecoveryRecord(
        record(
          pendingFields({
            出库审批快照: JSON.stringify({
              schemaVersion: 2,
              snapshot: inputSnapshot,
            }),
            出库审批投递台账: '',
          }),
        ),
      ),
    ).toEqual({ kind: 'pending', snapshot: inputSnapshot, deliveries: [] });
  });

  it('restores a partially delivered pending approval so remaining cards can resume after restart', () => {
    expect(
      parseInventoryOutboundApprovalRecoveryRecord(
        record(
          pendingFields({
            出库审批投递台账: ledgerJson({ deliveries: [deliveryOne()] }),
          }),
        ),
      ),
    ).toEqual({
      kind: 'pending',
      snapshot: snapshot(),
      deliveries: [deliveryOne()],
    });
  });

  it('reconstructs an approved decision from wrapped audit fields and the actor delivery', () => {
    const result = parseInventoryOutboundApprovalRecoveryRecord(
      record({
        ...pendingFields(),
        程序出库状态: { select: '待库房确认' },
        出库工作流状态: [{ text: '已通过' }],
        出库当前审批人: [],
        出库实际审批人: {
          users: [{ openId: 'ou_inventory_approver_1', name: '审批人一' }],
        },
        出库审批时间: { timestamp: 1787731506789 },
        出库审批动作标识: { value: 'ws_inventory_outbound_event_1' },
        出库驳回原因: [],
      }),
    );

    expect(result).toEqual({
      kind: 'decided',
      requiresBusinessFinalization: true,
      snapshot: snapshot(),
      deliveries: [deliveryOne(), deliveryTwo()],
      resultDeliveries: [],
      decision: {
        action: 'approve',
        actorOpenId: 'ou_inventory_approver_1',
        actorName: '审批人一',
        messageId: 'om_outbound_approval_1',
        eventId: 'ws_inventory_outbound_event_1',
        decidedAt: '2026-08-26T08:05:06.789Z',
        reason: '',
      },
    });
  });

  it('restores a partially delivered decision result ledger bound to the exact decision', () => {
    const result = parseInventoryOutboundApprovalRecoveryRecord(
      record({
        ...approvedFields(),
        出库审批结果投递台账: resultLedgerJson({
          deliveries: [resultApproverOne(), resultApplicant()],
        }),
      }),
    );

    expect(result).toMatchObject({
      kind: 'decided',
      resultDeliveries: [resultApplicant(), resultApproverOne()],
    });
  });

  it('deduplicates one Open ID shared by applicant and notification-only manager during recovery', () => {
    const inputSnapshot = snapshot({
      managerRecipients: [
        { openId: 'ou_inventory_applicant', name: '管理人展示名' },
      ],
    });

    expect(
      parseInventoryOutboundApprovalRecoveryRecord(
        record({
          ...approvedFields(),
          出库审批快照: JSON.stringify({
            schemaVersion: 2,
            snapshot: inputSnapshot,
          }),
          出库审批结果投递台账: resultLedgerJson({
            deliveries: [resultApplicant()],
          }),
        }),
      ),
    ).toMatchObject({
      kind: 'decided',
      snapshot: inputSnapshot,
      resultDeliveries: [resultApplicant()],
    });
  });

  it('allows an already finalized decision only for an explicit on-demand callback recovery', () => {
    expect(
      parseInventoryOutboundApprovalRecoveryRecord(
        record({
          ...approvedFields(),
          出库审批收尾状态: '已完成',
          出库审批结果投递台账: resultLedgerJson({
            deliveries: [resultApplicant(), resultApproverTwo()],
          }),
        }),
        { allowFinalized: true },
      ),
    ).toMatchObject({
      kind: 'decided',
      decision: { action: 'approve' },
      resultDeliveries: [resultApplicant(), resultApproverTwo()],
    });
  });

  it('restores a decision when only the actor card was delivered before the first legal action', () => {
    const result = parseInventoryOutboundApprovalRecoveryRecord(
      record({
        ...approvedFields(),
        出库审批投递台账: ledgerJson({ deliveries: [deliveryOne()] }),
      }),
    );

    expect(result).toMatchObject({
      kind: 'decided',
      deliveries: [deliveryOne()],
      decision: {
        action: 'approve',
        actorOpenId: 'ou_inventory_approver_1',
        messageId: 'om_outbound_approval_1',
      },
    });
  });

  it('reconstructs a rejected decision and normalizes its rejection reason', () => {
    const result = parseInventoryOutboundApprovalRecoveryRecord(
      record({
        ...pendingFields(),
        程序出库状态: '已驳回',
        出库工作流状态: { name: '已驳回' },
        出库当前审批人: [],
        出库实际审批人: [{ id: 'ou_inventory_approver_2' }],
        出库审批时间: { date: '2026-08-26T08:06:00.000Z' },
        出库审批动作标识: 'ws_inventory_outbound_event_2',
        出库驳回原因: { text: '  e\u0301用途不符合\r\n领用规则  ' },
      }),
    );

    expect(result).toMatchObject({
      kind: 'decided',
      decision: {
        action: 'reject',
        actorOpenId: 'ou_inventory_approver_2',
        actorName: '审批人二',
        messageId: 'om_outbound_approval_2',
        eventId: 'ws_inventory_outbound_event_2',
        decidedAt: '2026-08-26T08:06:00.000Z',
        reason: 'é用途不符合\n领用规则',
      },
    });
  });

  it.each([
    ['pending', '待审批', {}],
    [
      'approved',
      '待库房确认',
      {
        出库实际审批人: [{ id: 'ou_inventory_approver_1' }],
        出库审批时间: 1787731506789,
        出库审批动作标识: 'ws_inventory_outbound_event_1',
        出库驳回原因: '',
      },
    ],
    [
      'rejected',
      '已驳回',
      {
        出库实际审批人: [{ id: 'ou_inventory_approver_2' }],
        出库审批时间: 1787731560000,
        出库审批动作标识: 'ws_inventory_outbound_event_2',
        出库驳回原因: '库存用途不符合规则',
      },
    ],
  ])(
    'recovers a syncing-error record as %s from program status and decision evidence',
    (_label, programStatus, decisionFields) => {
      const result = parseInventoryOutboundApprovalRecoveryRecord(
        record({
          ...pendingFields(),
          程序出库状态: programStatus,
          出库工作流状态: '同步异常',
          ...(programStatus === '待审批' ? {} : { 出库当前审批人: [] }),
          ...decisionFields,
        }),
      );
      expect(result.kind).toBe(
        programStatus === '待审批' ? 'pending' : 'decided',
      );
      if (result.kind === 'decided') {
        expect(result.decision.action).toBe(
          programStatus === '已驳回' ? 'reject' : 'approve',
        );
      }
    },
  );

  it.each([
    ['unsupported workflow status', { 出库工作流状态: '未知状态' }],
    [
      'waiting approval without snapshot',
      { 出库工作流状态: '待审批', 出库审批快照: '' },
    ],
    [
      'snapshot schema version mismatch',
      pendingFields({
        出库审批快照: JSON.stringify({
          schemaVersion: 2,
          snapshot: snapshot(),
        }),
      }),
    ],
    [
      'snapshot record mismatch',
      pendingFields({
        出库审批快照: snapshotJson(
          snapshot({ recordId: 'rec_other_outbound' }),
        ),
      }),
    ],
    [
      'policy field mismatch',
      pendingFields({ 出库审批策略版本: 'inventory-outbound-v2' }),
    ],
    [
      'current approver mismatch',
      pendingFields({ 出库当前审批人: [{ id: 'ou_unknown_approver' }] }),
    ],
    [
      'delivery record mismatch',
      pendingFields({
        出库审批投递台账: ledgerJson({ recordId: 'rec_other_outbound' }),
      }),
    ],
    [
      'delivery version mismatch',
      pendingFields({ 出库审批投递台账: ledgerJson({ version: 2 }) }),
    ],
    [
      'delivery name mismatch',
      pendingFields({
        出库审批投递台账: ledgerJson({
          deliveries: [
            { ...deliveryOne(), recipientName: '错误姓名' },
            deliveryTwo(),
          ],
        }),
      }),
    ],
    [
      'delivery UUID is not bound to recipient',
      pendingFields({
        出库审批投递台账: ledgerJson({
          deliveries: [
            { ...deliveryOne(), deliveryUuid: APPROVER_TWO_UUID },
            { ...deliveryTwo(), deliveryUuid: APPROVER_ONE_UUID },
          ],
        }),
      }),
    ],
    [
      'duplicate delivery message ID',
      pendingFields({
        出库审批投递台账: ledgerJson({
          deliveries: [
            deliveryOne(),
            { ...deliveryTwo(), messageId: deliveryOne().messageId },
          ],
        }),
      }),
    ],
    [
      'approved workflow contradicts program status',
      {
        ...approvedFields(),
        程序出库状态: '已驳回',
      },
    ],
    [
      'decision actor is not a snapshot approver',
      {
        ...approvedFields(),
        出库实际审批人: [{ id: 'ou_unknown_approver' }],
      },
    ],
    [
      'decision has multiple actors',
      {
        ...approvedFields(),
        出库实际审批人: [
          { id: 'ou_inventory_approver_1' },
          { id: 'ou_inventory_approver_2' },
        ],
      },
    ],
    [
      'approval carries a rejection reason',
      { ...approvedFields(), 出库驳回原因: '不应存在' },
    ],
    ['rejection has no reason', { ...rejectedFields(), 出库驳回原因: '' }],
    [
      'decision lacks a persisted delivery ledger',
      { ...approvedFields(), 出库审批投递台账: '' },
    ],
    [
      'syncing error has incomplete decision evidence',
      {
        ...pendingFields(),
        程序出库状态: '待库房确认',
        出库工作流状态: '同步异常',
        出库实际审批人: [{ id: 'ou_inventory_approver_1' }],
      },
    ],
    [
      'completed finalization is not recoverable',
      { ...approvedFields(), 出库审批收尾状态: '已完成' },
    ],
    [
      'pending record contains result delivery evidence',
      {
        ...pendingFields(),
        出库审批结果投递台账: resultLedgerJson({
          deliveries: [resultApplicant()],
        }),
      },
    ],
    [
      'result ledger decision event mismatch',
      {
        ...approvedFields(),
        出库审批结果投递台账: resultLedgerJson({
          decisionEventId: 'ws_inventory_outbound_event_other',
          deliveries: [resultApplicant()],
        }),
      },
    ],
    [
      'result ledger recipient is not applicant or approver',
      {
        ...approvedFields(),
        出库审批结果投递台账: resultLedgerJson({
          deliveries: [
            {
              ...resultApplicant(),
              recipientOpenId: 'ou_inventory_unknown',
            },
          ],
        }),
      },
    ],
    [
      'result ledger UUID is not decision-bound',
      {
        ...approvedFields(),
        出库审批结果投递台账: resultLedgerJson({
          deliveries: [
            {
              ...resultApplicant(),
              deliveryUuid: RESULT_APPROVER_ONE_UUID,
            },
          ],
        }),
      },
    ],
  ])('fails closed for %s', (_label, fields) => {
    expect(() =>
      parseInventoryOutboundApprovalRecoveryRecord(record(fields)),
    ).toThrow();
  });

  it('fails closed when a semantic wrapper contains conflicting values', () => {
    expect(() =>
      parseInventoryOutboundApprovalRecoveryRecord(
        record({
          ...pendingFields(),
          出库工作流状态: { text: '待审批', value: '已通过' },
        }),
      ),
    ).toThrow(/冲突/u);
  });
});

function snapshot(
  overrides: Partial<InventoryOutboundApprovalSnapshot> = {},
): InventoryOutboundApprovalSnapshot {
  return {
    recordId: 'rec_outbound_1',
    outboundNumber: 'CK260826-001',
    version: 1,
    policyVersion: 'inventory-outbound-v1',
    applicantOpenId: 'ou_inventory_applicant',
    applicantName: '出库申请人',
    itemName: '地磅秤',
    sku: 'B1056',
    specification: '0.6×0.8米1吨',
    brand: '正峰',
    quantity: 1,
    unit: '台',
    availableStock: 1,
    building: 'H楼',
    location: 'H-2F-226储存间01-0F',
    reason: '项目现场领用',
    appliedAt: '2026-08-26T08:00:00.000Z',
    approvers: [
      { openId: 'ou_inventory_approver_1', name: '审批人一' },
      { openId: 'ou_inventory_approver_2', name: '审批人二' },
    ],
    ...overrides,
  };
}

function deliveryOne() {
  return {
    recipientOpenId: 'ou_inventory_approver_1',
    recipientName: '审批人一',
    deliveryUuid: APPROVER_ONE_UUID,
    messageId: 'om_outbound_approval_1',
  };
}

function deliveryTwo() {
  return {
    recipientOpenId: 'ou_inventory_approver_2',
    recipientName: '审批人二',
    deliveryUuid: APPROVER_TWO_UUID,
    messageId: 'om_outbound_approval_2',
  };
}

function resultApplicant() {
  return {
    recipientOpenId: 'ou_inventory_applicant',
    recipientName: '出库申请人',
    deliveryUuid: RESULT_APPLICANT_UUID,
    messageId: 'om_outbound_result_applicant',
  };
}

function resultApproverOne() {
  return {
    recipientOpenId: 'ou_inventory_approver_1',
    recipientName: '审批人一',
    deliveryUuid: RESULT_APPROVER_ONE_UUID,
    messageId: 'om_outbound_result_approver_1',
  };
}

function resultApproverTwo() {
  return {
    recipientOpenId: 'ou_inventory_approver_2',
    recipientName: '审批人二',
    deliveryUuid: RESULT_APPROVER_TWO_UUID,
    messageId: 'om_outbound_result_approver_2',
  };
}

function deliveryLedger(
  inputSnapshot: InventoryOutboundApprovalSnapshot = snapshot(),
) {
  return {
    schemaVersion: 1,
    recordId: inputSnapshot.recordId,
    version: inputSnapshot.version,
    deliveries: [deliveryTwo(), deliveryOne()],
  };
}

function snapshotJson(inputSnapshot = snapshot()): string {
  return JSON.stringify({ schemaVersion: 1, snapshot: inputSnapshot });
}

function ledgerJson(
  overrides: Partial<ReturnType<typeof deliveryLedger>> = {},
): string {
  return JSON.stringify({ ...deliveryLedger(), ...overrides });
}

function resultLedger(
  overrides: Partial<{
    schemaVersion: number;
    recordId: string;
    version: number;
    decisionEventId: string;
    decisionAction: 'approve' | 'reject';
    deliveries: ReturnType<typeof resultApplicant>[];
  }> = {},
) {
  return {
    schemaVersion: 1,
    recordId: 'rec_outbound_1',
    version: 1,
    decisionEventId: 'ws_inventory_outbound_event_1',
    decisionAction: 'approve' as const,
    deliveries: [resultApplicant()],
    ...overrides,
  };
}

function resultLedgerJson(
  overrides: Parameters<typeof resultLedger>[0] = {},
): string {
  return JSON.stringify(resultLedger(overrides));
}

function richTextJson(value: unknown): unknown[] {
  const serialized = JSON.stringify(value);
  const midpoint = Math.floor(serialized.length / 2);
  return [
    { text: serialized.slice(0, midpoint) },
    { text: serialized.slice(midpoint) },
  ];
}

function pendingFields(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const inputSnapshot = snapshot();
  return {
    程序出库状态: '待审批',
    出库工作流状态: '待审批',
    出库当前审批人: inputSnapshot.approvers.map(({ openId, name }) => ({
      id: openId,
      name,
    })),
    出库审批策略版本: inputSnapshot.policyVersion,
    出库审批快照: snapshotJson(inputSnapshot),
    出库审批投递台账: ledgerJson(),
    出库审批收尾状态: '',
    出库审批结果投递台账: '',
    ...overrides,
  };
}

function approvedFields(): Record<string, unknown> {
  return {
    ...pendingFields(),
    程序出库状态: '待库房确认',
    出库工作流状态: '已通过',
    出库当前审批人: [],
    出库实际审批人: [{ id: 'ou_inventory_approver_1' }],
    出库审批时间: 1787731506789,
    出库审批动作标识: 'ws_inventory_outbound_event_1',
    出库驳回原因: '',
    出库审批收尾状态: '待收尾',
  };
}

function rejectedFields(): Record<string, unknown> {
  return {
    ...pendingFields(),
    程序出库状态: '已驳回',
    出库工作流状态: '已驳回',
    出库当前审批人: [],
    出库实际审批人: [{ id: 'ou_inventory_approver_2' }],
    出库审批时间: 1787731560000,
    出库审批动作标识: 'ws_inventory_outbound_event_2',
    出库驳回原因: '库存用途不符合规则',
    出库审批收尾状态: '待收尾',
  };
}

function record(fields: Record<string, unknown>): {
  recordId: string;
  fields: Record<string, unknown>;
} {
  return { recordId: 'rec_outbound_1', fields };
}
