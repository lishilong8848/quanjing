import { cardActionDiagnosticName } from '../../server/common/feishu-card-action-diagnostics';

describe('card action timing labels', () => {
  it('recognizes only fixed action labels for both transports', () => {
    expect(cardActionDiagnosticName({ action: 'submit_order' })).toBe('submit_order');
    expect(cardActionDiagnosticName({ event: { action: { value: { action: 'approve' } } } })).toBe('approve');
    expect(cardActionDiagnosticName({ action: { name: 'leave_approve_submit:rec_synthetic:private', form_value: { token: 'PRIVATE_FORM' } } })).toBe('leave_approve_submit');
  });
  it.each([null, 'PRIVATE_FORM', { action: 'PRIVATE_FORM' }, { action: { name: 'private_person_name:token', value: { action: 'SECRET_VALUE' } } }])('never uses arbitrary callback content as a log label', payload => {
    expect(cardActionDiagnosticName(payload)).toBe('unknown');
  });
});
