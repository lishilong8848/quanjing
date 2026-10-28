import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { LeaveWorkflowStore } from '../../server/modules/leave-workflow/leave-workflow.store';
import { LeaveWorkflowService } from '../../server/modules/leave-workflow/leave-workflow.service';
import { buildLeaveSubstituteAdjustmentCard } from '../../server/modules/leave-workflow/leave-workflow.card';
import { parseLeaveLongConnectionCardAction } from '../../server/modules/leave-workflow/leave-workflow.callback';
import { FeishuCardActionRouter } from '../../server/modules/purchase-inventory/feishu-card-action.router';
import { currentHotfixActivation } from '../../server/common/hotfix-runtime-activation';
import { applicant, backup, fixture, primary, replacement, schedules } from './fixtures/leave-two-level';

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
function adjustmentEntryEvent() {
  const data = fixture();
  const card = buildLeaveSubstituteAdjustmentCard({ ...data.cardContext, shiftAssignments: data.assignments }, 3);
  const button = nodes(card).find(row => row.tag === 'button' && row.text?.content === '调整人员');
  return { ...event(''), action: { tag: 'button', value: button.behaviors[0].value } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(ready => { resolve = ready; });
  return { promise, resolve };
}

describe('optional leave adjustment empty-form contract', () => {
  it('starts with read-only shift details and opens selection through the existing versioned navigation', () => {
    const data = fixture();
    const card = buildLeaveSubstituteAdjustmentCard({ ...data.cardContext, shiftAssignments: data.assignments }, 3);
    expect(nodes(card).filter(row => ['form', 'select_static'].includes(row.tag))).toHaveLength(0);
    expect(nodes(card).filter(row => row.tag === 'button').map(row => row.text.content)).toEqual(['调整人员']);
    const text = JSON.stringify(card);
    expect(text).toContain(data.assignments[0].substituteName);
    expect(text).toContain(data.cardContext.shiftGroups[0].scheduleDate);
    expect(text).toContain('当前：');
    expect(text).not.toContain('提交替班调整');
    expect(text).not.toContain('重新选择');
    expect(parseLeaveLongConnectionCardAction(adjustmentEntryEvent())).toMatchObject({
      kind: 'adjustment_view', view: 'selection', recordId, expectedRevision: 3,
      actorOpenId: 'ou_supervisor', messageId,
    });
  });
  it.each([undefined, {}])('reviews the current assignments when the review form is untouched (%p)', formValue => {
    expect(parseLeaveLongConnectionCardAction(event(actionName(prefixes[0]), formValue))).toMatchObject({ kind: 'adjustment_view', view: 'review', shiftSelections: [], recordId, expectedRevision: 3, actorOpenId: 'ou_supervisor', messageId });
  });
  it.each([undefined, {}])('keeps an untouched final optional submission as no change (%p)', formValue => {
    expect(parseLeaveLongConnectionCardAction(event(actionName(prefixes[1]), formValue))).toMatchObject({ kind: 'adjustment_no_change', recordId, expectedRevision: 3, actorOpenId: 'ou_supervisor', messageId });
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
    const initial = buildLeaveSubstituteAdjustmentCard(context, 3, true);
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
  let gateway: { patchInteractiveCard: jest.Mock }, sync: any, background: jest.SpyInstance, claim: jest.SpyInstance, viewPatches: jest.SpyInstance, previousAppId: string | undefined;
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
    sync = { getCachedLeaveRequestImpactSchedules: jest.fn().mockResolvedValue(structuredClone(schedules)), getCachedActivePersonnelDirectory: jest.fn().mockResolvedValue({ personnel, selectablePersonnel: personnel }) };
    service = new LeaveWorkflowService(store, gateway as never, sync, {} as never, { canUseFeishuBusinessIdentity: () => true } as never);
    background = jest.spyOn(service, 'runPendingTasks').mockResolvedValue({ processed: 0, failed: 0 });
    claim = jest.spyOn(store, 'claimSubstituteUpdate');
    viewPatches = jest.spyOn(service, 'patchSubstituteAdjustmentCardView');
    const unused = { isEnabled: () => false } as never;
    router = new FeishuCardActionRouter(unused, service, unused, unused, unused, unused, unused, undefined, { canUseFeishuBusinessIdentity: () => true } as never);
  });
  afterEach(async () => {
    background.mockRestore(); claim.mockRestore(); viewPatches.mockRestore();
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
  async function prepareOtherLegalAdjustment() {
    const application = (await store.getApplication(recordId))!;
    const plan = structuredClone(application.approvalPlan!);
    const other = { ...plan.stages[0].approvers[0], openId: 'ou_other_supervisor', name: '另一审批人' };
    plan.stages[0].approvers.push(other);
    await store.patchApplication(recordId, { approvalPlan: plan });
    const otherMessageId = 'om_test_other_adjustment';
    await store.recordSubstituteAdjustmentCardDelivery(recordId, { recipientOpenId: other.openId, messageId: otherMessageId, businessKey: `leave:${recordId}:substitute-adjustment:3:${other.openId}` });
    return () => service.acceptSubstituteUpdateAction({ eventId: 'test-other-legal-adjustment', recordId, expectedRevision: 3,
      actorOpenId: other.openId, actorName: other.name, messageId: otherMessageId,
      shiftSelections: [{ shiftKey: fixture().selection.shiftKey, substitutePersonRecordId: replacement.personRecordId }] });
  }
  it('expands editing in place without changing the ledger or submitting substitute work', async () => {
    const before = await readFile(file);
    const response = await router.handle(adjustmentEntryEvent());
    expect(response.toast?.type).toBe('info');
    expect(response.card).toBeUndefined();
    expect(viewPatches).toHaveBeenCalledTimes(1);
    await Promise.all(viewPatches.mock.results.map(result => result.value));
    const [patchedMessageId, card] = gateway.patchInteractiveCard.mock.calls[0];
    expect(patchedMessageId).toBe(messageId);
    expect(nodes(card).some(row => row.tag === 'select_static')).toBe(true);
    expect(nodes(card).filter(row => row.tag === 'button').map(row => row.text.content)).toEqual(['提交替班调整', '重新选择']);
    expect(nodes(card).find(row => row.form_action_type === 'submit').name).toBe(actionName());
    expect(await readFile(file)).toEqual(before);
    expect(claim).not.toHaveBeenCalled();
    expect(background).not.toHaveBeenCalled();
  });
  it.each(['actor', 'message', 'revision', 'status'] as const)('rejects opening the editor with invalid %s', async kind => {
    const payload = adjustmentEntryEvent();
    if (kind === 'actor') payload.operator.open_id = 'ou_unauthorized';
    if (kind === 'message') payload.context.open_message_id = 'om_foreign';
    if (kind === 'revision') payload.action.value.expectedRevision = 2;
    if (kind === 'status') await store.patchApplication(recordId, { status: 'supervisor_pending' });
    const before = await readFile(file);
    const response = await router.handle(payload);
    expect(response.toast?.type).toBe('error');
    await expectNoSideEffects(before);
  });
  it.each([undefined, {}])('keeps a final untouched optional submission (%p) as no change with identical ledger bytes', async formValue => {
    const before = await readFile(file), payload = event(actionName(prefixes[1]), formValue);
    for (let index = 0; index < 2; index++) expect(await router.handle(payload)).toEqual({ toast: { type: 'info', content: '未选择调整人员，未提交变更' } });
    await expectNoSideEffects(before);
  });
  it.each([
    [undefined, primary.personRecordId],
    [{}, primary.personRecordId],
    [{ [field()]: replacement.personRecordId }, replacement.personRecordId],
  ] as const)('opens review for %p using the current or explicitly selected person', async (formValue, expectedPerson) => {
    const before = await readFile(file);
    const response = await router.handle(event(actionName(prefixes[0]), formValue));
    expect(response.toast?.type).toBe('info');
    expect(response.card).toBeUndefined();
    expect(viewPatches).toHaveBeenCalledTimes(1);
    await Promise.all(viewPatches.mock.results.map(result => result.value));
    expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(1);
    const [patchedMessageId, card] = gateway.patchInteractiveCard.mock.calls[0];
    expect(patchedMessageId).toBe(messageId);
    expect(nodes(card).find(row => row.tag === 'select_static' && row.name === field()).initial_option).toBe(expectedPerson);
    expect(nodes(card).find(row => row.form_action_type === 'submit').name).toBe(actionName(prefixes[1], 'g1:r1'));
    if (expectedPerson === primary.personRecordId) {
      expect(nodes(card).find(row => row.placeholder?.content === '选择原岗补位人员').initial_option).toBe(backup.personRecordId);
    }
    expect(await readFile(file)).toEqual(before);
    expect(claim).not.toHaveBeenCalled();
    expect(background).not.toHaveBeenCalled();
  });
  it('refuses the stale editor when another legal adjustment advances revision during the cache read', async () => {
    const adjust = await prepareOtherLegalAdjustment();
    const cacheStarted = deferred(), releaseCache = deferred();
    sync.getCachedLeaveRequestImpactSchedules.mockImplementationOnce(async () => {
      cacheStarted.resolve(); await releaseCache.promise; return structuredClone(schedules);
    });
    const reviewing = router.handle(event(actionName(prefixes[0]), {}));
    try {
      await Promise.race([cacheStarted.promise, reviewing.then(() => { throw new Error('Review finished before the controlled cache read'); })]);
      expect((await adjust()).claimed).toBe(true);
      const acceptedBytes = await readFile(file);
      releaseCache.resolve();
      const response = await reviewing;
      expect(response.card).toBeUndefined();
      expect(viewPatches).toHaveBeenCalledTimes(1);
      const outcomes = await Promise.allSettled(viewPatches.mock.results.map(result => result.value));
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ status: 'rejected', reason: { message: '该替班调整卡片已失效或无处理权限' } });
      expect(gateway.patchInteractiveCard).not.toHaveBeenCalled();
      expect(await readFile(file)).toEqual(acceptedBytes);
      expect((await store.getApplication(recordId))!.snapshot).toMatchObject({ assignmentRevision: 4,
        shiftAssignments: [{ substitutePersonRecordId: replacement.personRecordId }] });
      expect(claim).toHaveBeenCalledTimes(1);
      expect(background).not.toHaveBeenCalled();
    } finally {
      releaseCache.resolve(); await reviewing;
      await Promise.allSettled(viewPatches.mock.results.map(result => result.value));
    }
  });
  it('patches the latest readonly terminal after revision changes while the old review PATCH is in flight', async () => {
    const adjust = await prepareOtherLegalAdjustment();
    const patchStarted = deferred(), releasePatch = deferred();
    let displayedCard: unknown;
    gateway.patchInteractiveCard.mockImplementation(async (_messageId, card) => { displayedCard = card; });
    gateway.patchInteractiveCard.mockImplementationOnce(async (_messageId, card) => {
      patchStarted.resolve(); await releasePatch.promise; displayedCard = card;
    });
    const reviewing = router.handle(event(actionName(prefixes[0]), {}));
    try {
      await reviewing;
      expect(viewPatches).toHaveBeenCalledTimes(1);
      await Promise.race([patchStarted.promise, Promise.allSettled(viewPatches.mock.results.map(result => result.value)).then(() => { throw new Error('Review PATCH finished before the controlled gateway call'); })]);
      const accepted = await adjust();
      expect(accepted.claimed).toBe(true);
      const acceptedBytes = await readFile(file);
      releasePatch.resolve();
      await Promise.all(viewPatches.mock.results.map(result => result.value));
      expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(2);
      expect(gateway.patchInteractiveCard.mock.calls.map(call => call[0])).toEqual([messageId, messageId]);
      expect(JSON.stringify(gateway.patchInteractiveCard.mock.calls[0][1])).toContain('form_action_type');
      expect(displayedCard).toEqual(accepted.card);
      expect(JSON.stringify(displayedCard)).toContain('替班调整已提交');
      expect(JSON.stringify(displayedCard)).not.toContain('form_action_type');
      expect(await readFile(file)).toEqual(acceptedBytes);
      expect(claim).toHaveBeenCalledTimes(1);
      expect(background).not.toHaveBeenCalled();
    } finally {
      releasePatch.resolve(); await reviewing;
      await Promise.allSettled(viewPatches.mock.results.map(result => result.value));
    }
  });
  it('keeps primary and original-post backfill unchanged for concurrent duplicate empty reviews without creating tasks', async () => {
    const before = await readFile(file), original = (await store.getApplication(recordId))!.snapshot.shiftAssignments;
    const cacheStarted = deferred(), releaseCache = deferred();
    sync.getCachedLeaveRequestImpactSchedules.mockImplementation(async () => {
      cacheStarted.resolve(); await releaseCache.promise; return structuredClone(schedules);
    });
    const payload = event(actionName(prefixes[0]), {});
    const reviewing = [router.handle(payload), router.handle(payload)];
    const settled = [false, false];
    reviewing.forEach((review, index) => { void review.then(() => { settled[index] = true; }, () => { settled[index] = true; }); });
    try {
      await Promise.race([cacheStarted.promise, ...reviewing.map(review => review.then(() => { throw new Error('A review finished before the controlled cache read'); }))]);
      expect(settled).toEqual([false, false]);
      expect(sync.getCachedLeaveRequestImpactSchedules).toHaveBeenCalledTimes(1);
      releaseCache.resolve();
      const responses = await Promise.all(reviewing);
      expect(responses.every(response => response.toast?.type === 'info' && response.card === undefined)).toBe(true);
      expect(responses[0]).toEqual(responses[1]);
      expect(viewPatches).toHaveBeenCalledTimes(1);
      await Promise.all(viewPatches.mock.results.map(result => result.value));
      expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(1);
      expect(sync.getCachedLeaveRequestImpactSchedules).toHaveBeenCalledTimes(1);
      for (const [patchedMessageId, card] of gateway.patchInteractiveCard.mock.calls) {
        expect(patchedMessageId).toBe(messageId);
        expect(nodes(card).find(row => row.tag === 'select_static' && row.name === field()).initial_option).toBe(primary.personRecordId);
        expect(nodes(card).find(row => row.placeholder?.content === '选择原岗补位人员').initial_option).toBe(backup.personRecordId);
      }
      expect(await readFile(file)).toEqual(before);
      expect((await store.getApplication(recordId))!.snapshot.shiftAssignments).toEqual(original);
      expect(claim).not.toHaveBeenCalled();
      expect(background).not.toHaveBeenCalled();
    } finally {
      releaseCache.resolve(); await Promise.all(reviewing);
      await Promise.allSettled(viewPatches.mock.results.map(result => result.value));
    }
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
