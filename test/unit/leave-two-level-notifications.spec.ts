import { LeaveWorkflowService } from '../../server/modules/leave-workflow/leave-workflow.service';
import { buildLeaveTerminalCard } from '../../server/modules/leave-workflow/leave-workflow.card';
import { fixedLeaveNotificationIds } from '../../server/modules/leave-workflow/leave-workflow.rules';
import { applicant, backup, fixture, primary, replacement } from './fixtures/leave-two-level';

const application = () => {
  const data = fixture();
  return { ...data.application, key: `leave:${data.application.recordId}`, currentStage: null, status: 'approved', approvalPlan: data.plan, stageCards: [], resultCards: [] as any[], substituteAdjustmentCards: [], terminalCardMessageIds: [], resultRecipients: [applicant, primary, backup, replacement], snapshot: { ...data.application.snapshot, applicantNotificationOpenIds: [], shiftAssignments: data.assignments } };
};

describe('two-level backup notifications and final card visibility', () => {
  it('keeps the current backup as a fixed business recipient even when personnel roles are refreshed', () => {
    expect(fixedLeaveNotificationIds(application() as any).has(backup.openId)).toBe(true);
  });
  it('shows both posts in the read-only final card rather than only the first substitute', () => {
    const data = fixture();
    const card = buildLeaveTerminalCard({ ...data.cardContext, shiftAssignments: data.assignments, outcome: 'approved', actorName: '主管', message: '审批通过' });
    const text = JSON.stringify(card);
    expect(text).toContain('原岗补位'); expect(text).toContain(backup.name); expect(text).toContain('C楼');
    expect(text).not.toContain('form_action_type');
  });
  it('notifies the previous and new backups with the correct cancellation and assignment instead of empty primary-change summaries', async () => {
    const app = application(); const data = fixture();
    const current = structuredClone(data.assignments);
    current[0].originalPostBackfills![0] = { ...current[0].originalPostBackfills![0], substitutePersonRecordId: replacement.personRecordId, substituteName: replacement.name, substituteOpenId: replacement.openId };
    current[0].backfillPersonRecordId = replacement.personRecordId;
    app.snapshot.shiftAssignments = current;
    const sent: Array<{ recipient: string; card: Record<string, unknown> }> = [];
    const store = { getApplication: jest.fn(async () => app), recordResultCardDelivery: jest.fn(async (_recordId, delivery) => { app.resultCards.push(delivery); return app; }) };
    const gateway = { sendInteractiveCard: jest.fn(async (recipient: string, card: Record<string, unknown>) => { sent.push({ recipient, card }); return `om_two_level_notice_${sent.length}`; }) };
    const sync = { getCachedActivePersonnelDirectory: jest.fn(async () => ({ personnel: [applicant, primary, backup, replacement] })) };
    const service: any = new LeaveWorkflowService(store as never, gateway as never, sync as never);
    await service.deliverSubstituteChangeNotifications(app, { previousSubstituteOpenId: '', previousSubstitutePersonRecordId: '', previousSubstituteName: '', substituteOpenId: '', substitutePersonRecordId: '', substituteName: '', previousShiftAssignments: data.assignments, shiftAssignments: current, actorName: '主管' }, 'test-two-level-backup-change');
    const old = sent.find(row => row.recipient === backup.openId)!.card;
    const next = sent.find(row => row.recipient === replacement.openId)!.card;
    expect(JSON.stringify(old)).toContain('原替班安排已取消');
    expect(JSON.stringify(next)).toContain('新的替班安排');
    expect(JSON.stringify(next)).toContain('原岗补位');
    expect(JSON.stringify(next)).toContain(backup.name);
    expect(JSON.stringify(next)).toContain(replacement.name);
    const count = sent.length;
    await service.deliverSubstituteChangeNotifications(app, { previousSubstituteOpenId: '', previousSubstitutePersonRecordId: '', previousSubstituteName: '', substituteOpenId: '', substitutePersonRecordId: '', substituteName: '', previousShiftAssignments: data.assignments, shiftAssignments: current, actorName: '主管' }, 'test-two-level-backup-change');
    expect(sent).toHaveLength(count);
  });
});
