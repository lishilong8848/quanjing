import { BitableSyncService } from '../../server/modules/bitable-sync/bitable-sync.service';
import { enrichScheduleRecordsWithLeaveApproval } from '../../server/common/feishu/leave-approval-source';
import { applicant, backup, fixture, group, primary, replacement } from './fixtures/leave-two-level';

function runtime() {
  const data = fixture();
  const target = { record_id: 'rec_schedule_d', fields: { 排班日期: group.scheduleDate, 楼栋: 'D楼', 班次: '白班', 人员文本: applicant.name, 请假人员: applicant.name, '值班人员（实际）程序修改': primary.name } };
  const original = { record_id: 'rec_schedule_c', fields: { 排班日期: group.scheduleDate, 楼栋: 'C楼', 班次: '白班', 人员文本: `${primary.name}、同班同事`, '值班人员（实际）程序修改': `${backup.name}、同班同事` } };
  const snapshot: any = { verified: true, requests: [{ recordId: data.application.recordId, leaveStaff: [applicant.name], substituteStaff: [replacement.name], startAt: group.startAt, endAt: group.endAt, building: 'D楼', team: '', shift: '白班', impactedScheduleRecordIds: group.scheduleRecordIds, assignmentRevision: 1, shiftDetails: [{ shiftKey: group.shiftKey, scheduleRecordIds: group.scheduleRecordIds, substituteStaff: [replacement.name], revision: 1 }] }] };
  const service: any = Object.create(BitableSyncService.prototype);
  const writes: string[] = [];
  Object.assign(service, {
    NON_DUTY_APP_TOKEN: 'app_synthetic_restore_nonduty', NON_DUTY_TABLE_ID: 'tbl_synthetic_restore_nonduty', SCHEDULE_APP_TOKEN: 'app_synthetic_restore_schedule', SCHEDULE_TABLE_ID: 'tbl_synthetic_restore_schedule',
    fetchFeishuNonDutyRecords: jest.fn(async () => enrichScheduleRecordsWithLeaveApproval([structuredClone(original)], snapshot)),
    fetchFeishuScheduleRecords: jest.fn(async () => enrichScheduleRecordsWithLeaveApproval([structuredClone(target)], snapshot)),
    getTenantAccessToken: jest.fn(async () => 'synthetic-restore-token'),
    httpService: { axiosRef: { post: jest.fn(async (_url: string, body: any) => {
      for (const update of body.records) { const row = [target, original].find(item => item.record_id === update.record_id); if (!row) throw Error('Unknown synthetic restoration'); writes.push(update.record_id); Object.assign(row.fields, update.fields); }
      return { data: { code: 0 } };
    }) } },
  });
  const sync = () => service.syncApprovedLeaveScheduleSnapshot([{ shiftKey: group.shiftKey, scheduleRecordIds: group.scheduleRecordIds, substituteName: replacement.name }], { applicantName: applicant.name, startAt: data.application.snapshot.startAt, endAt: data.application.snapshot.endAt, releasedOriginalPosts: [{ scheduleRecordIds: ['rec_schedule_c'], previousPrimaryName: primary.name, previousBackupName: backup.name }] });
  return { original, target, writes, sync };
}
describe('restoring original posts when an on-duty substitution is replaced by a free person', () => {
  it('restores the old original post and removes the obsolete backup idempotently', async () => {
    const state = runtime(); await state.sync();
    expect(state.target.fields['值班人员（实际）程序修改']).toBe(replacement.name);
    expect(state.original.fields['值班人员（实际）程序修改']).toContain(primary.name);
    expect(state.original.fields['值班人员（实际）程序修改']).not.toContain(backup.name);
    expect(state.original.fields['值班人员（实际）程序修改']).toContain('同班同事');
    const writes = state.writes.length; await state.sync(); expect(state.writes).toHaveLength(writes);
  });
  it('rejects an independently changed planned original post before writing either position', async () => {
    const state = runtime(); state.original.fields.人员文本 = '新的排班人员'; state.original.fields['值班人员（实际）程序修改'] = '新的排班人员';
    await expect(state.sync()).rejects.toThrow(/原岗.*变化|原岗.*不一致/);
    expect(state.writes).toHaveLength(0);
  });
});
