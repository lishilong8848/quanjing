import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  parsePurchaseLongConnectionCardAction,
  type PurchaseCardCallbackConfig,
} from './purchase-workflow-callback';

const config: PurchaseCardCallbackConfig = {
  verificationToken: 'verify_purchase_long_connection',
  encryptKey: '',
  legacyApproverOpenIds: ['ou_legacy_approver'],
  managerApproverOpenId: 'ou_manager_approver',
};

function legacyPayload(
  action: 'approve' | 'reject' = 'approve',
): Record<string, unknown> {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    event_id: 'evt_purchase_legacy_01',
    operator: { open_id: 'ou_legacy_approver' },
    action: {
      tag: 'button',
      value: {
        version: 1,
        action,
        executionRecordId: 'rec_purchase_legacy_01',
      },
    },
  };
}

type ManagerInitialAction =
  | 'choose_comprehensive'
  | 'choose_building_self'
  | 'open_reject';

function managerPayload(
  action: ManagerInitialAction = 'choose_comprehensive',
): Record<string, unknown> {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    event_id: 'evt_purchase_manager_01',
    operator: { open_id: 'ou_manager_approver' },
    context: { open_message_id: 'om_purchase_manager_01' },
    action: {
      tag: 'button',
      value: {
        version: 2,
        action,
        executionRecordId: 'rec_purchase_manager_01',
      },
    },
  };
}

function managerRejectPayload(): Record<string, unknown> {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    event_id: 'evt_purchase_manager_reject_01',
    operator: { open_id: 'ou_manager_approver' },
    context: { open_message_id: 'om_purchase_manager_01' },
    action: {
      tag: 'button',
      name: 'purchase_reject_submit',
      form_value: { rejection_reason: '  供应方案不符合要求  ' },
    },
  };
}

describe('parsePurchaseLongConnectionCardAction', () => {
  it.each(['approve', 'reject'] as const)(
    'parses a legacy %s action and derives a stable event id',
    (action) => {
      const payload = legacyPayload(action);
      const first = parsePurchaseLongConnectionCardAction(payload, config);
      const replay = parsePurchaseLongConnectionCardAction(payload, config);

      expect(first).toEqual({
        kind: 'legacy_action',
        eventId: expect.stringMatching(/^ws_[a-f0-9]{64}$/u),
        operatorOpenId: 'ou_legacy_approver',
        action,
        executionRecordId: 'rec_purchase_legacy_01',
      });
      expect(replay.eventId).toBe(first.eventId);
    },
  );

  it('includes event_id when deriving the stable event id and supports its absence', () => {
    const firstPayload = legacyPayload();
    const secondPayload = {
      ...legacyPayload(),
      event_id: 'evt_purchase_other',
    };
    const withoutEventId = legacyPayload();
    delete withoutEventId.event_id;

    const first = parsePurchaseLongConnectionCardAction(firstPayload, config);
    const second = parsePurchaseLongConnectionCardAction(secondPayload, config);
    const fallback = parsePurchaseLongConnectionCardAction(
      withoutEventId,
      config,
    );

    expect(second.eventId).not.toBe(first.eventId);
    expect(fallback.eventId).toMatch(/^ws_[a-f0-9]{64}$/u);
    expect(
      parsePurchaseLongConnectionCardAction(withoutEventId, config).eventId,
    ).toBe(fallback.eventId);
  });

  it.each<ManagerInitialAction>([
    'choose_comprehensive',
    'choose_building_self',
    'open_reject',
  ])('parses manager action %s', (action) => {
    expect(
      parsePurchaseLongConnectionCardAction(managerPayload(action), config),
    ).toEqual({
      kind: 'manager_action',
      eventId: expect.stringMatching(/^ws_[a-f0-9]{64}$/u),
      operatorOpenId: 'ou_manager_approver',
      messageId: 'om_purchase_manager_01',
      action,
      executionRecordId: 'rec_purchase_manager_01',
    });
  });

  it('parses and normalizes a manager reject submission', () => {
    expect(
      parsePurchaseLongConnectionCardAction(managerRejectPayload(), config),
    ).toEqual({
      kind: 'manager_action',
      eventId: expect.stringMatching(/^ws_[a-f0-9]{64}$/u),
      operatorOpenId: 'ou_manager_approver',
      messageId: 'om_purchase_manager_01',
      action: 'submit_reject',
      rejectionReason: '供应方案不符合要求',
    });
  });

  it('reuses the distinct legacy and manager authorization rules', () => {
    const managerAsLegacy = legacyPayload();
    managerAsLegacy.operator = { open_id: 'ou_manager_approver' };
    const legacyAsManager = managerPayload();
    legacyAsManager.operator = { open_id: 'ou_legacy_approver' };

    expect(() =>
      parsePurchaseLongConnectionCardAction(managerAsLegacy, config),
    ).toThrow(ForbiddenException);
    expect(() =>
      parsePurchaseLongConnectionCardAction(legacyAsManager, config),
    ).toThrow(ForbiddenException);
  });

  it.each([
    [
      'missing event type',
      (payload: Record<string, unknown>) => delete payload.event_type,
    ],
    [
      'wrong event type',
      (payload: Record<string, unknown>) => {
        payload.event_type = 'im.message.receive_v1';
      },
    ],
    [
      'invalid event id',
      (payload: Record<string, unknown>) => {
        payload.event_id = ' event-with-space ';
      },
    ],
    [
      'mixed event id aliases',
      (payload: Record<string, unknown>) => {
        payload.eventId = 'evt_camel_case_alias';
      },
    ],
    [
      'mixed purchase and overtime record ids',
      (payload: Record<string, unknown>) => {
        const action = payload.action as {
          value: Record<string, unknown>;
        };
        action.value.recordId = 'rec_overtime_injected';
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const payload = legacyPayload();
    mutate(payload);

    expect(() =>
      parsePurchaseLongConnectionCardAction(payload, config),
    ).toThrow(BadRequestException);
  });

  it('rejects a reject submission carrying a mixed client record identifier', () => {
    const payload = managerRejectPayload();
    const action = payload.action as Record<string, unknown>;
    action.value = {
      version: 2,
      action: 'open_reject',
      executionRecordId: 'rec_client_injected',
    };

    expect(() =>
      parsePurchaseLongConnectionCardAction(payload, config),
    ).toThrow(BadRequestException);
  });
});
