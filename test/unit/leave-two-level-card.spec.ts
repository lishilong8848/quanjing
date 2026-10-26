import { buildLeaveApprovalCard, buildLeaveSubstituteAdjustmentCard } from '../../server/modules/leave-workflow/leave-workflow.card';
import { parseLeaveLongConnectionCardAction } from '../../server/modules/leave-workflow/leave-workflow.callback';
import { fixture, primary, backup } from './fixtures/leave-two-level';

function nodes(value: any): any[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  return [value, ...Object.values(value).flatMap(nodes)];
}
const field = (key: string) => `leave_shift_substitute_${Buffer.from(key).toString('base64url')}`;
const backupField = (selection = fixture().selection) => `leave_shift_backfill_${Buffer.from(JSON.stringify([selection.shiftKey, selection.substitutePersonRecordId, selection.originalPostSignature])).toString('base64url')}`;
const event = (name: string, formValue: object) => ({ event_type: 'card.action.trigger', operator: { open_id: 'ou_supervisor' }, context: { open_message_id: 'om_test_two_level' }, action: { tag: 'button', name, form_value: formValue } });

describe('two-level leave approval card contract', () => {
  it.each(['approval', 'adjustment'] as const)('keeps review navigation outside the %s form', (mode) => {
    const data = fixture();
    const context = { ...data.cardContext, substitutionReview: [data.selection] };
    const card = mode === 'approval'
      ? buildLeaveApprovalCard(context)
      : buildLeaveSubstituteAdjustmentCard(context, 3);
    const form = nodes(card).find(row => row.tag === 'form');
    const buttons = nodes(form.elements).filter(row => row.tag === 'button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatchObject({ form_action_type: 'submit', name: expect.any(String) });
    expect(buttons[0].behaviors).toBeUndefined();
    const navigation = nodes(card).find(row => row.tag === 'button' && row.text?.content === '重新选择');
    expect(navigation).toBeDefined();
    expect(nodes(form).includes(navigation)).toBe(false);
    expect(navigation.behaviors[0].value).toMatchObject(mode === 'approval'
      ? { action: 'return_to_approval', recordId: context.recordId, stageKey: 'supervisor', stageVersion: 1 }
      : { action: 'return_to_substitute_adjustment', recordId: context.recordId, expectedRevision: 3 });
  });
  it('labels an on-duty first choice with its actual building and shift', () => {
    const card = buildLeaveApprovalCard(fixture().cardContext);
    const option = nodes(card).find(row => row.value === primary.personRecordId);
    expect(option.text.content).toMatch(/吴亚兵.*C楼.*白班/);
  });
  it('first reviews arrangements instead of approving before original posts are covered', () => {
    const card = buildLeaveApprovalCard(fixture().cardContext);
    const submit = nodes(card).find(row => row.tag === 'button' && row.form_action_type === 'submit');
    expect(submit.name).toMatch(/^leave_substitute_review_submit:/);
    expect(submit.text.content).toBe('核对替班安排');
  });
  it('parses review navigation without creating an approval action', () => {
    const data = fixture();
    const result = parseLeaveLongConnectionCardAction(event(`leave_substitute_review_submit:${data.application.recordId}:supervisor:1:g1:r1`, { [field(data.selection.shiftKey)]: primary.personRecordId }));
    expect(result).toMatchObject({ kind: 'view', view: 'substitute_review', shiftSelections: [{ shiftKey: data.selection.shiftKey, substitutePersonRecordId: primary.personRecordId }] });
  });
  it('shows the full original-post interval and a required free-person backup selector in review', () => {
    const data = fixture();
    const card = buildLeaveApprovalCard({ ...data.cardContext, substitutionReview: [data.selection] } as any);
    const content = JSON.stringify(card);
    expect(content).toContain('原岗补位');
    expect(content).toContain('C楼');
    expect(content).toContain('09:00');
    expect(content).toContain('18:00');
    const selector = nodes(card).find(row => row.tag === 'select_static' && row.placeholder?.content === '选择原岗补位人员');
    expect(selector).toMatchObject({ required: true });
    expect(selector.options.map((row: any) => row.value)).toContain(backup.personRecordId);
    expect(selector.options.map((row: any) => row.value)).not.toContain(primary.personRecordId);
    expect(nodes(card).find(row => row.tag === 'button' && row.form_action_type === 'submit').name).toMatch(/^leave_approve_submit:/);
  });
  it.each(['approval', 'adjustment'] as const)('uses platform-sized field names and round-trips the %s review identity', (mode) => {
    const data = fixture();
    const context = { ...data.cardContext, substitutionReview: [data.selection] };
    const card = mode === 'approval' ? buildLeaveApprovalCard(context) : buildLeaveSubstituteAdjustmentCard(context, 3);
    const form = nodes(card).find(row => row.tag === 'form');
    const inputs = nodes(form).filter(row => row.name);
    for (const input of inputs) expect(input.name.length).toBeLessThanOrEqual(100);
    const selector = nodes(form).find(row => row.placeholder?.content === '选择原岗补位人员');
    const submit = nodes(form).find(row => row.form_action_type === 'submit');
    const parsed = parseLeaveLongConnectionCardAction(event(submit.name, {
      [field(data.selection.shiftKey)]: primary.personRecordId, [selector.name]: backup.personRecordId,
    }));
    expect(parsed).toMatchObject({ kind: mode === 'approval' ? 'approval' : 'substitute_update', shiftSelections: [data.selection] });
    expect(() => parseLeaveLongConnectionCardAction(event(submit.name, {
      [field(data.selection.shiftKey)]: 'rec_other_primary', [selector.name]: backup.personRecordId,
    }))).toThrow();
    expect(() => parseLeaveLongConnectionCardAction(event(submit.name, {
      [field(data.selection.shiftKey)]: primary.personRecordId,
      [selector.name]: backup.personRecordId, [backupField()]: backup.personRecordId,
    }))).toThrow();
  });
  it('carries a stable primary identity and original-post signature with the backup selection', () => {
    const data = fixture();
    const result = parseLeaveLongConnectionCardAction(event(`leave_approve_submit:${data.application.recordId}:supervisor:1:g1:r1`, { [field(data.selection.shiftKey)]: primary.personRecordId, [backupField()]: backup.personRecordId }));
    expect(result).toMatchObject({ kind: 'approval', shiftSelections: [data.selection] });
  });
  it('keeps the new field within the platform limit for a maximum-length primary record ID', () => {
    const data = fixture();
    const primaryId = 'r'.repeat(100);
    const context = JSON.parse(JSON.stringify(data.cardContext));
    context.candidateSets[0].candidates = context.candidateSets[0].candidates.map((person: any) => person.personRecordId === primary.personRecordId ? { ...person, personRecordId: primaryId } : person);
    context.candidateSets[0].twoLevelCandidates[0].person.personRecordId = primaryId;
    context.substitutionReview = [{ ...data.selection, substitutePersonRecordId: primaryId }];
    const card = buildLeaveApprovalCard(context);
    const selector = nodes(card).find(row => row.placeholder?.content === '选择原岗补位人员');
    expect(selector.name.length).toBe(97);
    const submit = nodes(card).find(row => row.form_action_type === 'submit');
    expect(parseLeaveLongConnectionCardAction(event(submit.name, {
      [field(data.selection.shiftKey)]: primaryId, [selector.name]: backup.personRecordId,
    }))).toMatchObject({ shiftSelections: [{ ...data.selection, substitutePersonRecordId: primaryId }] });
    expect(() => parseLeaveLongConnectionCardAction(event(submit.name, {
      [field(data.selection.shiftKey)]: primaryId,
      [selector.name.slice(0, -1) + '!']: backup.personRecordId,
    }))).toThrow();
  });
  it('rejects a backup tied to a different selected primary', () => {
    const data = fixture();
    expect(() => parseLeaveLongConnectionCardAction(event(`leave_approve_submit:${data.application.recordId}:supervisor:1:g1:r1`, { [field(data.selection.shiftKey)]: 'rec_other', [backupField()]: backup.personRecordId }))).toThrow();
  });
  it('does not allow unbounded or malformed backup signatures', () => {
    const data = fixture();
    const malformed = backupField({ ...data.selection, originalPostSignature: 'not-a-sha256' });
    expect(() => parseLeaveLongConnectionCardAction(event(`leave_approve_submit:${data.application.recordId}:supervisor:1:g1:r1`, { [field(data.selection.shiftKey)]: primary.personRecordId, [malformed]: backup.personRecordId }))).toThrow();
  });
});
