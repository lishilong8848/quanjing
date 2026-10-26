import { enrichScheduleRecordsWithLeaveApproval, SYSTEM_APPROVED_LEAVE_STAFF_FIELD, SYSTEM_APPROVED_LEAVE_ASSIGNMENTS_FIELD } from '../../server/common/feishu/leave-approval-source';
import { resolveApprovalAwareDutyStaffFromFields } from '../../server/modules/duty-schedule/approved-leave-visibility';
import { applicant, backup, fixture, group, primary, replacement } from './fixtures/leave-two-level';

const records = () => [
  { record_id: 'rec_schedule_d', fields: { 排班日期: group.scheduleDate, 楼栋: 'D楼', 班次: '白班', 人员文本: applicant.name, '值班人员（实际）': applicant.name, 请假人员: applicant.name } },
  { record_id: 'rec_schedule_c', fields: { 排班日期: group.scheduleDate, 楼栋: 'C楼', 班次: '白班', 人员文本: `${primary.name}、同班同事`, '值班人员（实际）': `${primary.name}、同班同事` } },
];
const snapshot = (): any => ({ verified: true, requests: [{ recordId: fixture().application.recordId, leaveStaff: [applicant.name], substituteStaff: [primary.name], startAt: group.startAt, endAt: group.endAt, building: 'D楼', team: '', shift: '白班', impactedScheduleRecordIds: group.scheduleRecordIds, assignmentRevision: 0, shiftDetails: [{ shiftKey: group.shiftKey, scheduleRecordIds: group.scheduleRecordIds, substituteStaff: [primary.name], revision: 0, originalPostBackfills: fixture().assignments[0].originalPostBackfills }] }] });

describe('two-level leave projection without inventing another leave request', () => {
  it('moves the primary from C to D and backfills C while retaining coworkers', () => {
    const enriched = enrichScheduleRecordsWithLeaveApproval(records(), snapshot());
    expect(resolveApprovalAwareDutyStaffFromFields(enriched[0].fields).dutyStaff).toEqual([primary.name]);
    expect(resolveApprovalAwareDutyStaffFromFields(enriched[1].fields).dutyStaff).toEqual(['同班同事', backup.name]);
    expect(enriched[1].fields[SYSTEM_APPROVED_LEAVE_STAFF_FIELD]).toEqual([]);
    expect(enriched[1].fields[SYSTEM_APPROVED_LEAVE_ASSIGNMENTS_FIELD]).toEqual([]);
  });
  it('does not overlay a transfer from an unverified approval snapshot', () => {
    const data = snapshot(); data.verified = false;
    const [_, original] = enrichScheduleRecordsWithLeaveApproval(records(), data);
    expect(resolveApprovalAwareDutyStaffFromFields(original.fields).dutyStaff).toEqual([primary.name, '同班同事']);
  });
  it('recomputes an adjusted backup from the planned post rather than accumulating the old backup', () => {
    const data = snapshot();
    data.requests[0].shiftDetails[0].originalPostBackfills[0] = { ...data.requests[0].shiftDetails[0].originalPostBackfills[0], substitutePersonRecordId: replacement.personRecordId, substituteName: replacement.name, substituteOpenId: replacement.openId };
    const source = records(); source[1].fields['值班人员（实际）'] = `同班同事、${backup.name}`;
    const [_, original] = enrichScheduleRecordsWithLeaveApproval(source, data);
    expect(resolveApprovalAwareDutyStaffFromFields(original.fields).dutyStaff).toEqual(['同班同事', replacement.name]);
  });
  it('only overlays the original schedule ids and preserves historical one-level projections', () => {
    const data = snapshot();
    const unrelated = { record_id: 'rec_unrelated', fields: { ...records()[1].fields } };
    const [_, original, unchanged] = enrichScheduleRecordsWithLeaveApproval([...records(), unrelated], data);
    expect(resolveApprovalAwareDutyStaffFromFields(original.fields).dutyStaff).toContain(backup.name);
    expect(resolveApprovalAwareDutyStaffFromFields(unchanged.fields).dutyStaff).toEqual([primary.name, '同班同事']);
    delete data.requests[0].shiftDetails[0].originalPostBackfills;
    expect(resolveApprovalAwareDutyStaffFromFields(enrichScheduleRecordsWithLeaveApproval(records(), data)[1].fields).dutyStaff).toEqual([primary.name, '同班同事']);
  });
});
