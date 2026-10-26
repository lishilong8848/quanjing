import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { LeaveWorkflowStore } from '../../server/modules/leave-workflow/leave-workflow.store';
import { LeaveWorkflowService } from '../../server/modules/leave-workflow/leave-workflow.service';
import { buildLeaveSubstituteAdjustmentCard } from '../../server/modules/leave-workflow/leave-workflow.card';
import { parseLeaveLongConnectionCardAction } from '../../server/modules/leave-workflow/leave-workflow.callback';
import { FeishuCardActionRouter } from '../../server/modules/purchase-inventory/feishu-card-action.router';
import { currentHotfixActivation } from '../../server/common/hotfix-runtime-activation';
import { applicant, backup, fixture, primary, replacement } from './fixtures/leave-two-level';

const recordId = fixture().application.recordId;
const messageId = 'om_test_empty_adjustment';
const prefixes = ['leave_substitute_review_update_submit', 'leave_substitute_update_submit'];
const field = (key = fixture().selection.shiftKey) => `leave_shift_substitute_${Buffer.from(key).toString('base64url')}`;
const actionName = (prefix = prefixes[0], suffix = 'g1:r0') => `${prefix}:${recordId}:3:${suffix}`;
function event(name: string, formValue?: unknown) {
  return { event_type: 'card.action.trigger', operator: { open_id: 'ou_supervisor' }, context: { open_message_id: messageId }, action: { tag: 'button', name, ...(formValue === undefined ? {} : { form_value: formValue }) } };
}
function nodes(value: any): any[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  return [value, ...Object.values(value).flatMap(nodes)];
}

describe('optional leave adjustment empty-form contract', () => {
  it.each(prefixes.flatMap(prefix => [undefined, {}].map(formValue => [prefix, formValue] as const)))('treats an untouched %s form (%p) as no change', (prefix, formValue) => {
    expect(parseLeaveLongConnectionCardAction(event(actionName(prefix), formValue))).toMatchObject({ kind: 'adjustment_no_change', recordId, expectedRevision: 3, actorOpenId: 'ou_supervisor', messageId });
  });
  it.each(prefixes)('preserves actual selections in legacy r0 %s forms', prefix => {
    const parsed = parseLeaveLongConnectionCardAction(event(actionName(prefix, 'g2:r0'), { [field()]: replacement.personRecordId }));
    expect(parsed).toMatchObject({ kind: prefix === prefixes[0] ? 'adjustment_view' : 'substitute_update', shiftSelections: [{ shiftKey: fixture().selection.shiftKey, substitutePersonRecordId: replacement.personRecordId }] });
  });
  it.each([null, [], '', 'bad', 0])('rejects malformed optional form %p', formValue => {
    for (const prefix of prefixes) expect(() => parseLeaveLongConnectionCardAction(event(actionName(prefix), formValue))).toThrow();
  });
  it.each(['g0:r0', 'g65:r0', 'g9007199254740992:r0'])('rejects invalid group count %s even without input', suffix => {
    expect(() => parseLeaveLongConnectionCardAction(event(actionName(prefixes[0], suffix)))).toThrow();
  });
  it('does not hide unknown or blank selected fields as no change', () => {
    for (const formValue of [{ unknown: 'rec_other' }, { [field()]: '' }]) expect(() => parseLeaveLongConnectionCardAction(event(actionName(), formValue))).toThrow();
  });
  it('still requires input for legacy single-person adjustments', () => {
    for (const formValue of [undefined, {}]) expect(() => parseLeaveLongConnectionCardAction(event(`leave_substitute_update_submit:${recordId}:3`, formValue))).toThrow();
  });
  it('marks final review as required r1 while initial selection stays optional r0', () => {
    const data = fixture(), context = { ...data.cardContext, shiftAssignments: data.assignments };
    const initial = buildLeaveSubstituteAdjustmentCard(context, 3);
    const final = buildLeaveSubstituteAdjustmentCard({ ...context, substitutionReview: [data.selection] }, 3);
    expect(nodes(initial).find(row => row.form_action_type === 'submit').name).toBe(actionName());
    const submit = nodes(final).find(row => row.form_action_type === 'submit');
    expect(submit.name).toBe(actionName(prefixes[1], 'g1:r1'));
    expect(nodes(final).filter(row => row.tag === 'select_static').every(row => row.required === true)).toBe(true);
    const backupSelector = nodes(final).find(row => row.placeholder?.content === '选择原岗补位人员');
    expect(parseLeaveLongConnectionCardAction(event(submit.name, { [field()]: primary.personRecordId, [backupSelector.name]: backup.personRecordId }))).toMatchObject({ kind: 'substitute_update', shiftSelections: [data.selection] });
  });
  it.each([undefined, {}, { [field()]: primary.personRecordId }])('rejects absent or partial r1 required mappings (%p)', formValue => {
    expect(() => parseLeaveLongConnectionCardAction(event(actionName(prefixes[1], 'g2:r1'), formValue))).toThrow();
  });
});

describe('empty adjustment real Router/Service/Store isolation', () => {
  let directory: string, file: string, store: LeaveWorkflowStore, service: LeaveWorkflowService, router: FeishuCardActionRouter;
  let gateway: { patchInteractiveCard: jest.Mock }, sync: any, background: jest.SpyInstance, claim: jest.SpyInstance, previousAppId: string | undefined;
  beforeEach(async () => {
    previousAppId = process.env.FEISHU_APP_ID;
    process.env.FEISHU_APP_ID = 'cli_empty_adjustment_synthetic';
    const activation = currentHotfixActivation(); activation.completeBootstrap(); await activation.refresh();
    directory = await mkdtemp(join(tmpdir(), 'leave-empty-adjustment-owned-')); file = join(directory, 'ledger.json');
    store = new LeaveWorkflowStore(file);
    const data = fixture();
    await store.acceptApplication(data.application);
    await store.patchApplication(recordId, { approvalPlan: data.plan, status: 'approved', snapshot: { ...data.application.snapshot, shiftAssignments: data.assignments, assignmentRevision: 3 } });
    await store.recordSubstituteAdjustmentCardDelivery(recordId, { recipientOpenId: 'ou_supervisor', messageId, businessKey: `leave:${recordId}:substitute-adjustment:3:ou_supervisor` });
    gateway = { patchInteractiveCard: jest.fn().mockResolvedValue(undefined) };
    const personnel = [applicant, primary, backup, replacement].map(person => ({ ...person, recordId: person.personRecordId, employeeNo: null, systemPosition: '', supervisorNames: [] }));
    sync = { getCachedLeaveRequestImpactSchedules: jest.fn(), getCachedActivePersonnelDirectory: jest.fn().mockResolvedValue({ personnel, selectablePersonnel: personnel }) };
    service = new LeaveWorkflowService(store, gateway as never, sync, {} as never, { canUseFeishuBusinessIdentity: () => true } as never);
    background = jest.spyOn(service, 'runPendingTasks').mockResolvedValue({ processed: 0, failed: 0 });
    claim = jest.spyOn(store, 'claimSubstituteUpdate');
    const unused = { isEnabled: () => false } as never;
    router = new FeishuCardActionRouter(unused, service, unused, unused, unused, unused, unused, undefined, { canUseFeishuBusinessIdentity: () => true } as never);
  });
  afterEach(async () => {
    background.mockRestore(); claim.mockRestore();
    if (previousAppId === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = previousAppId;
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.includes('leave-empty-adjustment-owned-')) throw Error('Unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  });
  async function expectNoSideEffects(before: Buffer) {
    expect(await readFile(file)).toEqual(before);
    expect(claim).not.toHaveBeenCalled(); expect(background).not.toHaveBeenCalled();
    expect(gateway.patchInteractiveCard).not.toHaveBeenCalled();
    expect(sync.getCachedLeaveRequestImpactSchedules).not.toHaveBeenCalled();
    expect(sync.getCachedActivePersonnelDirectory).not.toHaveBeenCalled();
  }
  it.each(prefixes.flatMap(prefix => [undefined, {}].map(formValue => [prefix, formValue] as const)))('returns no-change info for %s (%p) with identical ledger bytes', async (prefix, formValue) => {
    const before = await readFile(file), payload = event(actionName(prefix), formValue);
    for (let index = 0; index < 2; index++) expect(await router.handle(payload)).toEqual({ toast: { type: 'info', content: '未选择调整人员，未提交变更' } });
    await expectNoSideEffects(before);
  });
  it.each(['revision', 'actor', 'message', 'status', 'terminal', 'delivery'] as const)('rejects empty submissions with invalid %s without any mutation', async kind => {
    const payload = event(actionName(), {});
    if (kind === 'revision') payload.action.name = actionName().replace(':3:g', ':2:g');
    if (kind === 'actor') payload.operator.open_id = 'ou_unauthorized';
    if (kind === 'message') payload.context.open_message_id = 'om_foreign';
    if (kind === 'status') await store.patchApplication(recordId, { status: 'supervisor_pending' });
    if (kind === 'terminal') await store.markTerminalCardPatched(recordId, messageId);
    if (kind === 'delivery') payload.context.open_message_id = 'om_never_delivered';
    const before = await readFile(file);
    expect(await router.handle(payload)).toMatchObject({ toast: { type: 'error', content: '该替班调整卡片已失效或无处理权限' } });
    await expectNoSideEffects(before);
  });
  it('still durably accepts a valid required r1 adjustment and returns a readonly card', async () => {
    const response = await router.handle(event(actionName(prefixes[1], 'g1:r1'), { [field()]: replacement.personRecordId }));
    expect(response.toast).toEqual({ type: 'info', content: '审批操作已受理' });
    expect(response.card?.type).toBe('raw');
    expect(JSON.stringify(response.card)).not.toContain('form_action_type');
    const current = (await store.getApplication(recordId))!;
    expect(current.snapshot.assignmentRevision).toBe(4);
    expect(current.snapshot.shiftAssignments![0].substitutePersonRecordId).toBe(replacement.personRecordId);
    expect(claim).toHaveBeenCalledTimes(1); expect(background).toHaveBeenCalledTimes(1);
  });
});
