import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { LeaveWorkflowStore } from '../../server/modules/leave-workflow/leave-workflow.store';
import { backup, fixture, primary, replacement } from './fixtures/leave-two-level';

describe('two-level leave decisions in the durable ledger', () => {
  let directory: string;
  let store: LeaveWorkflowStore;
  const claim = (eventId = 'test-two-level-approve') => store.claimStageAction({ eventId, recordId: fixture().application.recordId, stageKey: 'supervisor', stageVersion: 1, actorOpenId: 'ou_supervisor', action: 'approve', shiftAssignments: fixture().assignments });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'leave-two-level-owned-'));
    store = new LeaveWorkflowStore(join(directory, 'ledger.json'));
    const data = fixture();
    await store.acceptApplication(data.application);
    await store.patchApplication(data.application.recordId, { approvalPlan: data.plan });
    await store.setPendingStage(data.application.recordId, { key: 'supervisor', version: 1, approverOpenIds: ['ou_supervisor'] });
  });
  afterEach(async () => {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.includes('leave-two-level-owned-')) throw Error('Unsafe test cleanup path');
    await rm(directory, { recursive: true, force: true });
  });
  it('retains original posts and available backup identities in the frozen candidate snapshot', async () => {
    const recovered = new LeaveWorkflowStore(join(directory, 'ledger.json'));
    const application = await recovered.getApplication(fixture().application.recordId);
    expect(application?.snapshot.candidateSets?.[0].twoLevelCandidates).toEqual(fixture().candidateSets[0].twoLevelCandidates);
  });
  it('commits both positions in one action and restores them unchanged after restart', async () => {
    const result = await claim();
    expect(result.accepted).toBe(true);
    expect(result.action?.shiftAssignments[0].originalPostBackfills).toEqual(fixture().assignments[0].originalPostBackfills);
    const recovered = new LeaveWorkflowStore(join(directory, 'ledger.json'));
    const application = await recovered.getApplication(fixture().application.recordId);
    expect(application?.snapshot.shiftAssignments?.[0].originalPostBackfills).toEqual(fixture().assignments[0].originalPostBackfills);
    expect(application?.resultRecipients.map(person => person.openId)).toContain(backup.openId);
    expect(application?.resultRecipients.map(person => person.openId)).toContain(primary.openId);
  });
  it('rejects an incomplete on-duty arrangement before accepting any action', async () => {
    const assignment = fixture().assignments[0];
    const { originalPostBackfills: _backfills, backfillPersonRecordId: _person, originalPostSignature: _signature, ...incomplete } = assignment;
    await expect(store.claimStageAction({ eventId: 'test-incomplete', recordId: fixture().application.recordId, stageKey: 'supervisor', stageVersion: 1, actorOpenId: 'ou_supervisor', action: 'approve', shiftAssignments: [incomplete] })).rejects.toThrow(/补位|原岗/);
    expect((await store.getApplication(fixture().application.recordId))?.currentStage).not.toBeNull();
  });
  it('accepts only one full decision for duplicate concurrent callbacks', async () => {
    const results = await Promise.all([claim(), claim()]);
    expect(results.filter(result => result.accepted)).toHaveLength(1);
    expect(results[1].action?.shiftAssignments[0].originalPostBackfills).toEqual(fixture().assignments[0].originalPostBackfills);
  });
  it('does not accept a new two-level decision from a legacy application without stable applicant identity', async () => {
    const current = (await store.getApplication(fixture().application.recordId))!;
    await store.patchApplication(current.recordId, { snapshot: { ...current.snapshot, applicantPersonRecordId: undefined } });
    await expect(claim()).rejects.toThrow(/申请人.*身份|身份.*申请人/);
    expect((await store.getApplication(current.recordId))?.currentStage).not.toBeNull();
  });
  it('marks the parent shift changed when only its original-post backup changes', async () => {
    await claim();
    const data = fixture();
    await store.patchApplication(data.application.recordId, { status: 'approved' });
    const assignment = structuredClone(data.assignments[0]);
    assignment.backfillPersonRecordId = replacement.personRecordId;
    assignment.originalPostBackfills![0] = { ...assignment.originalPostBackfills![0], substitutePersonRecordId: replacement.personRecordId, substituteName: replacement.name, substituteOpenId: replacement.openId };
    const result = await store.claimSubstituteUpdate({ eventId: 'test-backup-only-update', recordId: data.application.recordId, expectedRevision: 0, actorOpenId: 'ou_supervisor', shiftAssignments: [assignment] });
    expect(result.accepted).toBe(true);
    expect(result.update?.changedShiftKeys).toEqual([assignment.shiftKey]);
    expect(result.entry.resultRecipients.map(person => person.openId)).toContain(replacement.openId);
  });
  it('does not let another application reserve a backup already committed to an overlapping post', async () => {
    await claim();
    const data = fixture();
    const secondId = 'rec_leave_second';
    await store.acceptApplication({ ...data.application, clientMutationId: 'test-second-client', recordId: secondId, snapshot: { ...data.application.snapshot, applicantName: '另一申请人' } });
    await store.setPendingStage(secondId, { key: 'supervisor', version: 1, approverOpenIds: ['ou_supervisor'] });
    await expect(store.claimStageAction({ eventId: 'test-second-approve', recordId: secondId, stageKey: 'supervisor', stageVersion: 1, actorOpenId: 'ou_supervisor', action: 'approve', shiftAssignments: data.assignments })).rejects.toThrow(/占用|冲突|安排/);
  });
});
