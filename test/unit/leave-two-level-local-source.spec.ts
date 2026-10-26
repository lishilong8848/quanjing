jest.mock('../../server/common/feishu/bitable-direct-read', () => ({ ...jest.requireActual('../../server/common/feishu/bitable-direct-read'), fetchBitableRecords: jest.fn(), resolveBitableAppToken: jest.fn().mockResolvedValue('app_local_only_test'), readLatestPersistedBitableRecordSnapshot: jest.fn() }));
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fetchBitableRecords, readLatestPersistedBitableRecordSnapshot } from '../../server/common/feishu/bitable-direct-read';
import { enrichScheduleRecordsWithLeaveApproval, fetchLeaveApprovalSnapshot, readCachedLeaveApprovalSnapshot, SYSTEM_LEAVE_APPROVAL_VERIFIED_FIELD } from '../../server/common/feishu/leave-approval-source';
import { resolveApprovalAwareDutyStaffFromFields } from '../../server/modules/duty-schedule/approved-leave-visibility';
import { BitableSyncService } from '../../server/modules/bitable-sync/bitable-sync.service';
import { applicant, backup, fixture, group, primary, replacement } from './fixtures/leave-two-level';

describe('local-authoritative two-level approval source', () => {
  let directory: string;
  let previous: NodeJS.ProcessEnv;
  let main: any[];
  let details: any[];
  const data = () => fixture();
  const writeLedger = (revision = 0) => writeFile(process.env.LEAVE_WORKFLOW_LEDGER_PATH!, JSON.stringify({ version: 4, applications: [{ ...data().application, status: 'approved', resolvedAction: 'approve', snapshot: { ...data().application.snapshot, assignmentRevision: revision, shiftAssignments: data().assignments } }], actions: [], substituteUpdates: [], tasks: [] }), 'utf8');
  beforeEach(async () => {
    previous = { ...process.env }; directory = await mkdtemp(join(tmpdir(), 'leave-two-level-source-local-owned-'));
    Object.assign(process.env, { LEAVE_WORKFLOW_LEDGER_PATH: join(directory, 'ledger.json'), FEISHU_LEAVE_REQUEST_APP_TOKEN: 'app_local_only_test', FEISHU_LEAVE_REQUEST_TABLE_ID: 'tbl_local_only_main', FEISHU_LEAVE_SHIFT_DETAIL_TABLE_ID: 'tbl_local_only_details' });
    main = [{ record_id: data().application.recordId, fields: { 系统审批完成标记: '审批结束', '休假人员（文本）': applicant.name, '替班人员（填姓名）': primary.name, 系统影响排班记录ID: 'rec_schedule_d', 替班调整版本: 0, 替班安排: `原岗补位 C楼：${backup.name}` } }, { record_id: 'rec_ordinary_history', fields: { 系统审批完成标记: '审批结束', '休假人员（文本）': '普通请假', '替班人员（填姓名）': '普通替班', 系统影响排班记录ID: 'rec_ordinary_schedule', 替班调整版本: 0 } }];
    details = [{ record_id: 'rec_local_detail', fields: { 状态: 'active', 请假记录ID: data().application.recordId, 班次键: data().selection.shiftKey, 排班记录IDs: JSON.stringify(['rec_schedule_d']), 替班人员姓名: primary.name, 替班人员记录ID: primary.personRecordId, 替班人员OpenID: primary.openId, 替班安排版本: 0 } }];
    const rows = (name?: string) => name === '请休假审批状态' ? main : details;
    jest.mocked(fetchBitableRecords).mockImplementation(async (_http, options) => rows(options.tableName));
    const fetchedAt = Date.now();
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockImplementation(async options => ({ records: rows(options.tableName), fetchedAt, expiresAt: fetchedAt + 60_000 }) as never);
  });
  afterEach(async () => { process.env = previous; jest.clearAllMocks(); if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.includes('leave-two-level-source-local-owned-')) throw Error('Unsafe cleanup'); await rm(directory, { recursive: true, force: true }); });
  it('reads and projects both posts with no new cloud column', async () => {
    await writeLedger(); const snapshot = await fetchLeaveApprovalSnapshot({} as never, { strict: true, forceRefresh: true });
    expect(snapshot.verified).toBe(true);
    expect(snapshot.requests[0].shiftDetails?.[0].originalPostBackfills).toEqual(data().assignments[0].originalPostBackfills);
    const [original] = enrichScheduleRecordsWithLeaveApproval([{ record_id: 'rec_schedule_c', fields: { 人员文本: primary.name, '值班人员（实际）': primary.name } }], snapshot);
    expect(resolveApprovalAwareDutyStaffFromFields(original.fields).dutyStaff).toEqual([backup.name]);
    expect(jest.mocked(fetchBitableRecords).mock.calls.every(([, options]) => !options.fieldNames?.includes('原岗补位安排'))).toBe(true);
  });
  it('keeps a missing two-level ledger local to its request rather than failing ordinary requests', async () => {
    const snapshot = await fetchLeaveApprovalSnapshot({} as never, { strict: true, forceRefresh: true });
    expect(snapshot.verified).toBe(true);
    expect(snapshot.requests.find(row => row.recordId === 'rec_ordinary_history')?.substituteStaff).toEqual(['普通替班']);
    expect(snapshot.requests[0]).toMatchObject({ unavailableReason: expect.any(String), substituteStaff: [], shiftDetails: [] });
  });
  it('invalidates parsed cached approval data after restoring the ledger without a cloud refresh', async () => {
    const first = await readCachedLeaveApprovalSnapshot();
    expect((first.requests[0] as any).unavailableReason).toEqual(expect.any(String));
    await writeLedger(); const next = await readCachedLeaveApprovalSnapshot();
    expect(next.requests[0].shiftDetails?.[0].originalPostBackfills).toEqual(data().assignments[0].originalPostBackfills);
    expect(fetchBitableRecords).not.toHaveBeenCalled();
  });
  it('fails closed on conflicting cloud identity while preserving other approvals and current actual staff', async () => {
    await writeLedger(); details[0].fields.替班人员OpenID = 'ou_wrong_cloud_identity';
    const snapshot = await fetchLeaveApprovalSnapshot({} as never, { strict: true, forceRefresh: true });
    const [target] = enrichScheduleRecordsWithLeaveApproval([{ record_id: 'rec_schedule_d', fields: { 人员文本: applicant.name, 请假人员: applicant.name, '值班人员（实际）': primary.name } }], snapshot);
    expect(target.fields[SYSTEM_LEAVE_APPROVAL_VERIFIED_FIELD]).toBe(false);
    expect((target.fields as any).__systemLeaveApprovalError).toEqual(expect.any(String));
    expect(resolveApprovalAwareDutyStaffFromFields(target.fields).dutyStaff).toEqual([primary.name]);
    expect(snapshot.requests.find(row => row.recordId === 'rec_ordinary_history')).not.toHaveProperty('unavailableReason');
  });
  it('does not resurrect an unapproved cloud record from an approved local decision', async () => {
    await writeLedger(); main[0].fields.系统审批完成标记 = '待审批';
    expect((await fetchLeaveApprovalSnapshot({} as never, { strict: true, forceRefresh: true })).requests.map(row => row.recordId)).toEqual(['rec_ordinary_history']);
  });
  it.each(['request', 'detail'])('does not coerce a malformed cloud %s version into version zero', async kind => {
    await writeLedger();
    if (kind === 'request') main[0].fields.替班调整版本 = 'invalid-revision'; else details[0].fields.替班安排版本 = 'invalid-revision';
    const snapshot = await fetchLeaveApprovalSnapshot({} as never, { strict: true, forceRefresh: true });
    expect(snapshot.requests[0]).toMatchObject({ unavailableReason: expect.any(String), shiftDetails: [] });
  });
  it('writes both actual posts and later releases the old original post from the same ledger without adding cloud fields', async () => {
    await writeLedger();
    const target: any = { record_id: 'rec_schedule_d', fields: { 排班日期: group.scheduleDate, 楼栋: 'D楼', 班次: '白班', 人员文本: applicant.name, 请假人员: applicant.name, '值班人员（实际）程序修改': applicant.name } };
    const original: any = { record_id: 'rec_schedule_c', fields: { 排班日期: group.scheduleDate, 楼栋: 'C楼', 班次: '白班', 人员文本: `${primary.name}、同班同事`, '值班人员（实际）程序修改': `${primary.name}、同班同事` } };
    const writes: string[] = [];
    const sync: any = Object.create(BitableSyncService.prototype);
    const snapshot = () => fetchLeaveApprovalSnapshot({} as never, { strict: true, forceRefresh: true });
    Object.assign(sync, {
      NON_DUTY_APP_TOKEN: 'app_synthetic_local_nonduty', NON_DUTY_TABLE_ID: 'tbl_synthetic_local_nonduty', SCHEDULE_APP_TOKEN: 'app_synthetic_local_schedule', SCHEDULE_TABLE_ID: 'tbl_synthetic_local_schedule',
      fetchFeishuNonDutyRecords: jest.fn(async () => enrichScheduleRecordsWithLeaveApproval([structuredClone(original)], await snapshot())),
      fetchFeishuScheduleRecords: jest.fn(async () => enrichScheduleRecordsWithLeaveApproval([structuredClone(target)], await snapshot())),
      getTenantAccessToken: jest.fn().mockResolvedValue('synthetic-local-sync-token'),
      httpService: { axiosRef: { post: jest.fn(async (_url: string, body: any) => {
        for (const update of body.records) {
          expect(Object.keys(update.fields)).toEqual(['值班人员（实际）程序修改']);
          const record = [target, original].find(row => row.record_id === update.record_id);
          if (!record) throw Error('Unexpected synthetic record');
          writes.push(update.record_id); Object.assign(record.fields, update.fields);
        }
        return { data: { code: 0 } };
      }) } },
    });
    const scope = { applicantName: applicant.name, startAt: data().application.snapshot.startAt, endAt: data().application.snapshot.endAt };
    await sync.syncApprovedLeaveScheduleSnapshot(data().assignments, scope);
    expect(target.fields['值班人员（实际）程序修改']).toBe(primary.name);
    expect(original.fields['值班人员（实际）程序修改']).toContain(backup.name);
    const free = { ...data().assignments[0], substituteName: replacement.name, substituteOpenId: replacement.openId, substitutePersonRecordId: replacement.personRecordId, originalPostBackfills: undefined, backfillPersonRecordId: undefined, originalPostSignature: undefined };
    main[0].fields = { ...main[0].fields, 替班调整版本: 1, 替班安排: replacement.name, '替班人员（填姓名）': replacement.name };
    Object.assign(details[0].fields, { 替班安排版本: 1, 替班人员姓名: replacement.name, 替班人员OpenID: replacement.openId, 替班人员记录ID: replacement.personRecordId });
    await writeFile(process.env.LEAVE_WORKFLOW_LEDGER_PATH!, JSON.stringify({ version: 4, applications: [{ ...data().application, status: 'approved', resolvedAction: 'approve', snapshot: { ...data().application.snapshot, assignmentRevision: 1, shiftAssignments: [free] } }], actions: [], substituteUpdates: [{ recordId: data().application.recordId, expectedRevision: 0, revision: 1, previousShiftAssignments: data().assignments, shiftAssignments: [free] }], tasks: [] }), 'utf8');
    const releaseScope = { ...scope, releasedOriginalPosts: [{ scheduleRecordIds: ['rec_schedule_c'], previousPrimaryName: primary.name, previousBackupName: backup.name }] };
    await sync.syncApprovedLeaveScheduleSnapshot([free], releaseScope);
    expect(target.fields['值班人员（实际）程序修改']).toBe(replacement.name);
    expect(new Set(original.fields['值班人员（实际）程序修改'].split(/[、\s]+/u))).toEqual(new Set([primary.name, '同班同事']));
    const count = writes.length;
    await sync.syncApprovedLeaveScheduleSnapshot([free], releaseScope);
    expect(writes).toHaveLength(count);
  });
  it('waits for matching primary detail revision rather than mixing a newer decision with old cloud rows', async () => {
    await writeLedger(1); main[0].fields.替班调整版本 = 1;
    const stale = await fetchLeaveApprovalSnapshot({} as never, { strict: true, forceRefresh: true });
    expect(stale.requests[0]).toHaveProperty('unavailableReason');
    details[0].fields.替班安排版本 = 1;
    const ready = await fetchLeaveApprovalSnapshot({} as never, { strict: true, forceRefresh: true });
    expect(ready.requests[0].shiftDetails?.[0].originalPostBackfills).toEqual(data().assignments[0].originalPostBackfills);
  });
});
