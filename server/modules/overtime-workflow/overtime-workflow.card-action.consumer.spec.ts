import { BadRequestException } from '@nestjs/common';
import { parseOvertimeLongConnectionCardAction } from './overtime-workflow.callback';

function cardActionPayload(
  action: 'approve' | 'reject' = 'approve',
): Record<string, unknown> {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    operator: { open_id: 'ou_overtime_approver' },
    context: { open_message_id: 'om_overtime_approval_card' },
    action: {
      tag: 'button',
      value: {
        version: 1,
        action,
        recordId: 'rec_overtime_application',
      },
    },
  };
}

describe('parseOvertimeLongConnectionCardAction', () => {
  it.each(['approve', 'reject'] as const)(
    'parses a %s card action and derives a stable idempotency event id',
    (action) => {
      const payload = cardActionPayload(action);
      const first = parseOvertimeLongConnectionCardAction(payload);
      const replay = parseOvertimeLongConnectionCardAction(payload);

      expect(first).toEqual({
        kind: 'overtime_action',
        eventId: expect.stringMatching(/^ws_[a-f0-9]{64}$/u),
        actorOpenId: 'ou_overtime_approver',
        messageId: 'om_overtime_approval_card',
        action,
        recordId: 'rec_overtime_application',
      });
      expect(replay.eventId).toBe(first.eventId);
    },
  );

  it('uses the action value in the derived event id', () => {
    const approve = parseOvertimeLongConnectionCardAction(
      cardActionPayload('approve'),
    );
    const reject = parseOvertimeLongConnectionCardAction(
      cardActionPayload('reject'),
    );

    expect(approve.eventId).not.toBe(reject.eventId);
  });

  it.each([
    ['operator', (payload: Record<string, unknown>) => delete payload.operator],
    [
      'message context',
      (payload: Record<string, unknown>) => delete payload.context,
    ],
    [
      'action value',
      (payload: Record<string, unknown>) => {
        payload.action = { tag: 'button' };
      },
    ],
  ])('rejects a card action without %s', (_label, removeRequiredValue) => {
    const payload = cardActionPayload();
    removeRequiredValue(payload);

    expect(() => parseOvertimeLongConnectionCardAction(payload)).toThrow(
      BadRequestException,
    );
  });
});
