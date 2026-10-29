import { parseFollowUpCardAction } from './today-operations-follow-up-card.callback';

const batchId = 'b'.repeat(32);
function payload(action: Record<string, unknown>): {
  event_type: string; event_id: string; operator: { open_id: string };
  context: { open_message_id: string }; action: Record<string, unknown>;
} {
  return { event_type: 'card.action.trigger', event_id: 'event-fixture', operator: { open_id: 'ou_fixture' }, context: { open_message_id: 'om_fixture' }, action: { tag: 'button', ...action } };
}
function view(action: string, extra: Record<string, unknown> = {}) {
  return payload({ value: { workflowType: 'today_operations_followup', version: 1, batchId, action, ...extra } });
}
function form(status: unknown = 'completed', measure: unknown = '已完成检查', name = `today_followup_submit:${batchId}:7:3`) {
  return payload({ name, form_value: { follow_up_status: status, follow_up_measure: measure } });
}

describe('daily follow-up card callback boundary', () => {
  it.each([['list', { page: 0 }], ['list', { page: 1000 }], ['edit', { index: 999 }], ['summary', {}]] as const)(
    'parses %s navigation using only the bound batch index', (action, extra) => {
      expect(parseFollowUpCardAction(view(action, extra))).toMatchObject({ kind: 'view', action, batchId, actorOpenId: 'ou_fixture', messageId: 'om_fixture', ...extra });
    },
  );

  it.each([
    ['pending', '', false, false], ['acknowledged', '', true, false], ['completed', '完成检查', true, true],
  ])('parses the %s state without accepting caller-supplied record IDs', (status, measure, acknowledged, completed) => {
    const result = parseFollowUpCardAction(form(status, measure));
    expect(result).toMatchObject({ kind: 'submit', index: 7, revision: 3, acknowledged, completed, treatmentMeasure: measure });
    expect(result).not.toHaveProperty('recordId');
  });

  it('accepts an omitted optional empty measure for pending work and preserves multiline text', () => {
    const input = form('pending'); delete (input.action.form_value as Record<string, unknown>).follow_up_measure;
    expect(parseFollowUpCardAction(input)).toMatchObject({ treatmentMeasure: '' });
    expect(parseFollowUpCardAction(form('acknowledged', ' 第一步\r\n第二步 '))).toMatchObject({ treatmentMeasure: '第一步\n第二步' });
  });

  it('uses a stable callback ID, including the full business action when event_id is absent', () => {
    const a = form('acknowledged', '已检查') as Record<string, any>; delete a.event_id;
    const b = form('acknowledged', '已检查') as Record<string, any>; delete b.event_id;
    expect(parseFollowUpCardAction(a).eventId).toBe(parseFollowUpCardAction(b).eventId);
    b.action.form_value.follow_up_measure = '另一个处理结果';
    expect(parseFollowUpCardAction(a).eventId).not.toBe(parseFollowUpCardAction(b).eventId);
    expect(parseFollowUpCardAction(form()).eventId).toMatch(/^ws_today_followup_[a-f0-9]{64}$/u);
  });

  it.each([
    null, [], Object.create({ action: {} }),
    { ...view('list', { page: 0 }), event_type: 'message.received' },
    { ...view('list', { page: 0 }), operator: { open_id: {} } },
    { ...view('list', { page: 0 }), context: { open_message_id: 'wrong' } },
    { ...view('list', { page: 0 }), event_id: {} },
    payload({ tag: 'input', value: {} }),
    view('list', { page: -1 }), view('list', { page: '0' }), view('list', { page: 1001 }),
    view('edit', { index: 1000 }), view('edit', { index: 0.5 }), view('unknown'),
    view('list', { page: 0, recordId: 'recForged' }),
    view('list', { page: 0, workflowType: 'purchase' }), view('list', { page: 0, version: '1' }),
    view('list', { page: 0, batchId: 'A'.repeat(32) }),
    form({}, '措施'), form('completed', {}), form('completed', null),
    form('completed', ''), form('completed', '一'), form('completed', '字'.repeat(501)),
    form('pending', '字'.repeat(501)), form('pending', '\u0000'),
    form('completed', '措施', `today_followup_submit:${batchId}:1000:0`),
    form('completed', '措施', `today_followup_submit:${batchId}:0:9007199254740992`),
    form('completed', '措施', `today_followup_submit:${batchId}:0:-1`),
  ])('rejects malformed or untrusted action %#', input => {
    expect(() => parseFollowUpCardAction(input)).toThrow();
  });

  it('rejects injected form keys rather than trusting a supplied record or actor', () => {
    const input = form() as Record<string, any>;
    input.action.form_value.recordId = 'recForged';
    expect(() => parseFollowUpCardAction(input)).toThrow();
  });

  it('rejects a submit form with a conflicting workflow value and accepts only empty platform metadata', () => {
    const input = form();
    input.action.value = { workflowType: 'purchase' };
    expect(() => parseFollowUpCardAction(input)).toThrow();
    input.action.value = {};
    expect(parseFollowUpCardAction(input)).toMatchObject({ kind: 'submit', batchId });
  });
});
