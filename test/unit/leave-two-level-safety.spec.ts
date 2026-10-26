import { LeaveWorkflowService } from '../../server/modules/leave-workflow/leave-workflow.service';
import { applicant, backup, fixture, primary, replacement, schedules } from './fixtures/leave-two-level';

function runtime(rows = structuredClone(schedules)) {
  const data = fixture();
  const application: any = { ...data.application, key: `leave:${data.application.recordId}`, currentStage: { key: 'supervisor', version: 1, approverOpenIds: ['ou_supervisor'] }, status: 'approved', approvalPlan: data.plan, stageCards: [], resultRecipients: [], snapshot: { ...data.application.snapshot, applicantNotificationOpenIds: [], shiftAssignments: data.assignments } };
  const personnel = [applicant, primary, backup, replacement].map(person => ({ ...person, recordId: person.personRecordId, buildings: ['C'] }));
  const store = { getApplication: jest.fn(async () => application), claimStageAction: jest.fn(async () => ({ accepted: true, reason: 'accepted', entry: application, action: null })), getOriginalPostBackfillHistory: jest.fn().mockResolvedValue([]) };
  const sync = { getCachedLeaveRequestImpactSchedules: jest.fn(async () => rows), getCachedActivePersonnelDirectory: jest.fn(async () => ({ personnel, selectablePersonnel: personnel })), syncApprovedLeaveScheduleSnapshot: jest.fn().mockResolvedValue({}) };
  const detail = { assertOriginalPostFieldReady: jest.fn().mockResolvedValue(undefined), upsertCurrentAssignments: jest.fn().mockResolvedValue(undefined) };
  const service = new LeaveWorkflowService(store as never, {} as never, sync as never, detail as never, { canUseFeishuBusinessIdentity: () => true } as never);
  return { service: service as any, application, store, sync, detail, rows, data };
}

describe('two-level approved adjustment and readiness guards', () => {
  const previous: Record<string, string | undefined> = {};
  const env = { FEISHU_APP_ID: 'cli_two_level_safety', FEISHU_APP_SECRET: 'synthetic-only-not-a-credential', FEISHU_LEAVE_REQUEST_APP_TOKEN: 'app_synthetic_safety', FEISHU_LEAVE_SHIFT_DETAIL_TABLE_ID: 'tbl_synthetic_safety' };
  beforeEach(() => { for (const [key, value] of Object.entries(env)) { previous[key] = process.env[key]; process.env[key] = value; } });
  afterEach(() => { for (const key of Object.keys(env)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  it('restores its own already-written two posts only for adjustment eligibility, not as a second leave', async () => {
    const state = runtime(); state.rows[0].dutyStaffActual = [primary.name]; state.rows[1].dutyStaffActual = [backup.name, '同班同事'];
    const candidates = await state.service.refreshCandidateSets(state.application);
    const choice = candidates[0].twoLevelCandidates.find((row: any) => row.person.personRecordId === primary.personRecordId);
    expect(choice.originalGroups[0].scheduleRecordIds).toEqual(['rec_schedule_c']);
    expect(choice.backfillCandidates.map((person: any) => person.personRecordId)).toContain(backup.personRecordId);
    expect(state.rows[1].dutyStaffActual).toEqual([backup.name, '同班同事']);
  });
  it('handles partial writeback while preserving the old original post for candidate recheck', async () => {
    const state = runtime(); state.rows[0].dutyStaffActual = [primary.name];
    const candidates = await state.service.refreshCandidateSets(state.application);
    expect(candidates[0].twoLevelCandidates.find((row: any) => row.person.personRecordId === primary.personRecordId).originalGroups[0].scheduleRecordIds).toEqual(['rec_schedule_c']);
  });
  it('rejects an original post that was independently reassigned rather than erasing another person', async () => {
    const state = runtime(); state.rows[0].dutyStaffActual = [primary.name]; state.rows[1].dutyStaffActual = ['另一在岗人员'];
    await expect(state.service.refreshCandidateSets(state.application)).rejects.toThrow(/变化|原岗/);
  });
  it('rejects an unavailable local backup before a two-level approval is atomically accepted', async () => {
    const state = runtime(); state.application.status = 'supervisor_pending'; state.application.snapshot.shiftAssignments = [];
    await expect(state.service.acceptApprovalAction({ recordId: state.data.application.recordId, stageKey: 'supervisor', stageVersion: 1, actorOpenId: 'ou_supervisor', messageId: 'om_synthetic_safety', eventId: 'test_local_backup_unavailable', action: 'approve', shiftSelections: [{ ...state.data.selection, backfillPersonRecordId: 'rec_not_available' }] })).rejects.toThrow(/补位|可用/);
    expect(state.store.claimStageAction).not.toHaveBeenCalled();
  });
  it('passes previous original-post records from the durable adjustment decision to cleanup synchronization', async () => {
    const state = runtime(); state.application.snapshot.assignmentRevision = 1;
    state.application.snapshot.shiftAssignments = [{ ...state.data.assignments[0], substitutePersonRecordId: replacement.personRecordId, substituteName: replacement.name, substituteOpenId: replacement.openId, originalPostBackfills: undefined, backfillPersonRecordId: undefined, originalPostSignature: undefined }];
    state.store.getOriginalPostBackfillHistory.mockResolvedValue(state.data.assignments);
    await state.service.syncApprovedLeaveSchedule({ recordId: state.data.application.recordId, payload: { revision: 1 } });
    expect(state.sync.syncApprovedLeaveScheduleSnapshot.mock.calls[0][1].releasedOriginalPosts).toEqual([{ scheduleRecordIds: ['rec_schedule_c'], previousPrimaryName: primary.name, previousBackupName: backup.name }]);
  });
});
