import { BadRequestException } from '@nestjs/common';
import { parseInventoryOutboundCardAction } from './inventory-outbound-approval.callback';

describe('parseInventoryOutboundCardAction', () => {
  it('parses approval and derives a stable event id from the complete binding', () => {
    const payload = directActionPayload('approve');
    const first = parseInventoryOutboundCardAction(payload);
    const replay = parseInventoryOutboundCardAction(payload);

    expect(first).toEqual({
      kind: 'decision',
      eventId: expect.stringMatching(/^ws_inventory_outbound_[a-f0-9]{64}$/u),
      actorOpenId: 'ou_inventory_manager',
      messageId: 'om_inventory_outbound_approval',
      action: 'approve',
      recordId: 'rec_inventory_outbound',
      version: 1,
    });
    expect(replay.eventId).toBe(first.eventId);
  });

  it('parses opening the rejection form without producing a decision', () => {
    const parsed = parseInventoryOutboundCardAction(
      directActionPayload('open_reject'),
    );

    expect(parsed).toMatchObject({
      kind: 'open_rejection',
      recordId: 'rec_inventory_outbound',
      version: 1,
      actorOpenId: 'ou_inventory_manager',
      messageId: 'om_inventory_outbound_approval',
    });
    expect(parsed).not.toHaveProperty('action');
  });

  it('parses returning to approval without producing a decision', () => {
    const parsed = parseInventoryOutboundCardAction(
      directActionPayload('return_to_approval'),
    );

    expect(parsed).toMatchObject({
      kind: 'return_to_approval',
      recordId: 'rec_inventory_outbound',
      version: 1,
      actorOpenId: 'ou_inventory_manager',
      messageId: 'om_inventory_outbound_approval',
    });
    expect(parsed).not.toHaveProperty('action');
  });

  it('parses the trimmed rejection reason only when the form is submitted', () => {
    const parsed = parseInventoryOutboundCardAction(
      rejectionSubmitPayload('  当前库存需保留应急使用  '),
    );

    expect(parsed).toMatchObject({
      kind: 'decision',
      action: 'reject',
      recordId: 'rec_inventory_outbound',
      version: 1,
      reason: '当前库存需保留应急使用',
    });
  });

  it('normalizes rejection reasons to NFC and LF while counting Unicode code points', () => {
    const multiline = parseInventoryOutboundCardAction(
      rejectionSubmitPayload('  e\u0301库存\r\n保留  '),
    );
    const emoji = parseInventoryOutboundCardAction(
      rejectionSubmitPayload('😀'.repeat(500)),
    );

    expect(multiline).toMatchObject({ reason: 'é库存\n保留' });
    expect(emoji).toMatchObject({ reason: '😀'.repeat(500) });
  });

  it.each([
    '',
    ' ',
    '仅',
    '超'.repeat(501),
    '😀'.repeat(501),
    '库存\t不足',
    '库存\u000b不足',
  ])('rejects an invalid rejection reason %#', (reason) => {
    expect(() =>
      parseInventoryOutboundCardAction(rejectionSubmitPayload(reason)),
    ).toThrow('驳回原因需填写 2–500 字');
  });

  it('rejects a direct reject callback so the rejection flow cannot be bypassed', () => {
    expect(() =>
      parseInventoryOutboundCardAction(directActionPayload('reject')),
    ).toThrow('出库审批卡片动作值无效');
  });

  it.each([
    [
      'another workflow',
      (payload: ReturnType<typeof directActionPayload>) => {
        payload.action.value.workflowType = 'leave';
      },
    ],
    [
      'an unknown action',
      (payload: ReturnType<typeof directActionPayload>) => {
        payload.action.value.action = 'unknown';
      },
    ],
    [
      'a non-positive version',
      (payload: ReturnType<typeof directActionPayload>) => {
        payload.action.value.version = 0;
      },
    ],
    [
      'a string version',
      (payload: ReturnType<typeof directActionPayload>) => {
        payload.action.value.version = '1';
      },
    ],
    [
      'an invalid record id',
      (payload: ReturnType<typeof directActionPayload>) => {
        payload.action.value.recordId = '../rec';
      },
    ],
    [
      'an extra action value field',
      (payload: ReturnType<typeof directActionPayload>) => {
        payload.action.value.extra = true;
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const payload = directActionPayload('approve');
    mutate(payload);

    expect(() => parseInventoryOutboundCardAction(payload)).toThrow(
      BadRequestException,
    );
  });

  it('rejects extra rejection form fields', () => {
    const payload = rejectionSubmitPayload('库存不足');
    payload.action.form_value.extra = 'forged';

    expect(() => parseInventoryOutboundCardAction(payload)).toThrow(
      '出库驳回表单包含未知字段',
    );
  });

  it.each([
    [
      'event type',
      (payload: ReturnType<typeof directActionPayload>) => {
        payload.event_type = 'message.receive';
      },
    ],
    [
      'actor open id',
      (payload: ReturnType<typeof directActionPayload>) => {
        payload.operator.open_id = '';
      },
    ],
    [
      'message id',
      (payload: ReturnType<typeof directActionPayload>) => {
        payload.context.open_message_id = 'invalid_message';
      },
    ],
  ])('rejects an invalid %s', (_label, mutate) => {
    const payload = directActionPayload('approve');
    mutate(payload);

    expect(() => parseInventoryOutboundCardAction(payload)).toThrow(
      BadRequestException,
    );
  });

  it('keeps a rerouted positive version in the callback binding', () => {
    const payload = directActionPayload('approve');
    payload.action.value.version = 2;

    expect(parseInventoryOutboundCardAction(payload)).toMatchObject({
      recordId: 'rec_inventory_outbound',
      version: 2,
      actorOpenId: 'ou_inventory_manager',
      messageId: 'om_inventory_outbound_approval',
    });
  });
});

function directActionPayload(action: string) {
  return {
    event_type: 'card.action.trigger' as string,
    operator: { open_id: 'ou_inventory_manager' as string },
    context: {
      open_message_id: 'om_inventory_outbound_approval' as string,
    },
    action: {
      tag: 'button',
      value: {
        workflowType: 'inventory_outbound' as string,
        action,
        recordId: 'rec_inventory_outbound' as string,
        version: 1 as string | number,
      } as Record<string, unknown> & {
        workflowType: string;
        action: string;
        recordId: string;
        version: string | number;
      },
    },
  };
}

function rejectionSubmitPayload(reason: string) {
  return {
    event_type: 'card.action.trigger',
    operator: { open_id: 'ou_inventory_manager' },
    context: { open_message_id: 'om_inventory_outbound_approval' },
    action: {
      tag: 'button',
      name: 'inventory_outbound_reject_submit:rec_inventory_outbound:1',
      form_value: {
        inventory_outbound_rejection_reason: reason,
      } as Record<string, unknown>,
    },
  };
}
