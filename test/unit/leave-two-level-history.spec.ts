import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { LeaveWorkflowStore } from '../../server/modules/leave-workflow/leave-workflow.store';
import { fixture, replacement } from './fixtures/leave-two-level';

it('retains old original-post coverage in the existing durable ledger after later free-person adjustments and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leave-two-level-history-owned-'));
  try {
    const store: any = new LeaveWorkflowStore(join(directory, 'ledger.json')); const data = fixture();
    await store.acceptApplication(data.application); await store.patchApplication(data.application.recordId, { approvalPlan: data.plan });
    await store.setPendingStage(data.application.recordId, { key: 'supervisor', version: 1, approverOpenIds: ['ou_supervisor'] });
    await store.claimStageAction({ eventId: 'test-history-approved', recordId: data.application.recordId, stageKey: 'supervisor', stageVersion: 1, actorOpenId: 'ou_supervisor', action: 'approve', shiftAssignments: data.assignments });
    await store.patchApplication(data.application.recordId, { status: 'approved' });
    const free = { ...data.assignments[0], substitutePersonRecordId: replacement.personRecordId, substituteName: replacement.name, substituteOpenId: replacement.openId, originalPostBackfills: undefined, backfillPersonRecordId: undefined, originalPostSignature: undefined };
    await store.claimSubstituteUpdate({ eventId: 'test-history-free-1', recordId: data.application.recordId, expectedRevision: 0, actorOpenId: 'ou_supervisor', shiftAssignments: [free] });
    await store.claimSubstituteUpdate({ eventId: 'test-history-free-2', recordId: data.application.recordId, expectedRevision: 1, actorOpenId: 'ou_supervisor', shiftAssignments: [free] });
    const recovered: any = new LeaveWorkflowStore(join(directory, 'ledger.json'));
    expect(typeof recovered.getOriginalPostBackfillHistory).toBe('function');
    const history = await recovered.getOriginalPostBackfillHistory(data.application.recordId);
    expect(history.some((row: any) => row.originalPostBackfills?.some((backup: any) => backup.group.scheduleRecordIds.includes('rec_schedule_c')))).toBe(true);
  } finally {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.includes('leave-two-level-history-owned-')) throw Error('Unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});
