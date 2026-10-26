import { BitableSyncService } from '../../server/modules/bitable-sync/bitable-sync.service';
import { enrichScheduleRecordsWithLeaveApproval } from '../../server/common/feishu/leave-approval-source';
import { applicant, backup, fixture, group, primary } from './fixtures/leave-two-level';

function setup() {
  const data = fixture();
  const primaryRow = { record_id: 'rec_schedule_d', fields: { 排班日期: group.scheduleDate, 楼栋: 'D楼', 班次: '白班', 人员文本: applicant.name, 请假人员: applicant.name, '值班人员（实际）程序修改': applicant.name } };
  const originalRow = { record_id: 'rec_schedule_c', fields: { 排班日期: group.scheduleDate, 楼栋: 'C楼', 班次: '白班', 人员文本: `${primary.name}、同班同事`, '值班人员（实际）程序修改': `${primary.name}、同班同事` } };
  const snapshot: any = { verified: true, requests: [{ recordId: data.application.recordId, leaveStaff: [applicant.name], substituteStaff: [primary.name], startAt: group.startAt, endAt: group.endAt, building: 'D楼', team: '', shift: '白班', impactedScheduleRecordIds: group.scheduleRecordIds, assignmentRevision: 0, shiftDetails: [{ shiftKey: group.shiftKey, scheduleRecordIds: group.scheduleRecordIds, substituteStaff: [primary.name], revision: 0, originalPostBackfills: data.assignments[0].originalPostBackfills }] }] };
  const writes: string[] = [];
  let failOriginal = false;
  const service: any = Object.create(BitableSyncService.prototype);
  Object.assign(service, {
    NON_DUTY_APP_TOKEN: 'app_synthetic_nonduty', NON_DUTY_TABLE_ID: 'tbl_synthetic_nonduty', SCHEDULE_APP_TOKEN: 'app_synthetic_schedule', SCHEDULE_TABLE_ID: 'tbl_synthetic_schedule',
    fetchFeishuNonDutyRecords: jest.fn(async () => enrichScheduleRecordsWithLeaveApproval([structuredClone(originalRow)], snapshot)),
    fetchFeishuScheduleRecords: jest.fn(async () => enrichScheduleRecordsWithLeaveApproval([structuredClone(primaryRow)], snapshot)),
    getTenantAccessToken: jest.fn(async () => 'synthetic-only-token'),
    httpService: { axiosRef: { post: jest.fn(async (_url: string, body: any) => {
      for (const update of body.records) {
        writes.push(update.record_id);
        if (update.record_id === originalRow.record_id && failOriginal) return { data: { code: 999, msg: 'synthetic original-post failure' } };
        const row = [primaryRow, originalRow].find(item => item.record_id === update.record_id);
        if (!row) throw Error('Unknown synthetic write');
        Object.assign(row.fields, update.fields);
      }
      return { data: { code: 0 } };
    }) } },
  });
  const sync = () => service.syncApprovedLeaveScheduleSnapshot(data.assignments, { applicantName: applicant.name, startAt: data.application.snapshot.startAt, endAt: data.application.snapshot.endAt });
  return { sync, writes, primaryRow, originalRow, fail: (value: boolean) => { failOriginal = value; } };
}

describe('two-level actual schedule writeback and recovery', () => {
  it('writes and rereads both posts without requiring the moving primary to be marked as on leave', async () => {
    const state = setup(); await state.sync();
    expect(state.primaryRow.fields['值班人员（实际）程序修改']).toBe(primary.name);
    expect(state.originalRow.fields['值班人员（实际）程序修改']).toContain(backup.name);
    expect(state.originalRow.fields['值班人员（实际）程序修改']).not.toContain(primary.name);
    expect(state.originalRow.fields).not.toHaveProperty('请假人员');
    expect(new Set(state.writes)).toEqual(new Set(['rec_schedule_c', 'rec_schedule_d']));
  });
  it('retries only the failed post after partial success and never duplicates the successful write', async () => {
    const state = setup(); state.fail(true);
    await expect(state.sync()).rejects.toThrow(/失败|回读/);
    expect(state.primaryRow.fields['值班人员（实际）程序修改']).toBe(primary.name);
    const successfulWrites = state.writes.filter(id => id === 'rec_schedule_d').length;
    state.fail(false); await state.sync();
    expect(state.originalRow.fields['值班人员（实际）程序修改']).toContain(backup.name);
    expect(state.writes.filter(id => id === 'rec_schedule_d')).toHaveLength(successfulWrites);
  });
});
