jest.mock('../../server/common/feishu/bitable-direct-read', () => ({ ...jest.requireActual('../../server/common/feishu/bitable-direct-read'), fetchBitableRecords: jest.fn(), resolveBitableAppToken: jest.fn().mockResolvedValue('app_synthetic_optional_field') }));
import { fetchBitableRecords } from '../../server/common/feishu/bitable-direct-read';
import { fetchLeaveApprovalSnapshot } from '../../server/common/feishu/leave-approval-source';
import { fixture } from './fixtures/leave-two-level';
import { writeOriginalPostBackfillMetadata } from '../../shared/leave-original-post-backfill';

describe('optional backfill column and historical leave-source compatibility', () => {
  const previous: Record<string, string | undefined> = {};
  const env = { FEISHU_LEAVE_REQUEST_APP_TOKEN: 'app_synthetic_optional_field', FEISHU_LEAVE_REQUEST_TABLE_ID: 'tbl_synthetic_optional_leave', FEISHU_LEAVE_SHIFT_DETAIL_TABLE_ID: 'tbl_synthetic_optional_detail' };
  let fieldExists = false;
  beforeEach(() => {
    for (const [key, value] of Object.entries(env)) { previous[key] = process.env[key]; process.env[key] = value; }
    fieldExists = false;
    jest.mocked(fetchBitableRecords).mockImplementation(async (_http, options) => {
      const data = fixture();
      if (options.tableName === '请休假审批状态') return [{ record_id: data.application.recordId, fields: { 系统审批完成标记: '审批结束', '休假人员（文本）': data.application.snapshot.applicantName, '替班人员（填姓名）': data.assignments[0].substituteName, 替班调整版本: 0 } }];
      if (!fieldExists && options.fieldNames?.includes('原岗补位安排')) throw Error('synthetic upstream: optional field does not exist');
      return [{ record_id: 'rec_optional_detail', fields: { 状态: 'active', 请假记录ID: data.application.recordId, 班次键: data.assignments[0].shiftKey, 排班记录IDs: JSON.stringify(data.assignments[0].scheduleRecordIds), 替班人员姓名: data.assignments[0].substituteName, 替班安排版本: 0, ...(fieldExists ? { 原岗补位安排: writeOriginalPostBackfillMetadata(data.assignments[0]) } : {}) } }];
    });
  });
  afterEach(() => { jest.clearAllMocks(); for (const key of Object.keys(env)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  it('keeps historical one-level detail readable when the new cloud column is absent', async () => {
    const snapshot = await fetchLeaveApprovalSnapshot({} as never, { forceRefresh: true, strict: true });
    expect(snapshot.verified).toBe(true);
    expect(snapshot.requests[0].shiftDetails?.[0].substituteStaff).toEqual([fixture().assignments[0].substituteName]);
    expect(snapshot.requests[0].shiftDetails?.[0].originalPostBackfills).toBeUndefined();
  });
  it('recognizes optional legacy cloud data but refuses to infer a missing local decision from it', async () => {
    fieldExists = true;
    const snapshot = await fetchLeaveApprovalSnapshot({} as never, { forceRefresh: true, strict: true });
    expect(snapshot.requests[0]).toMatchObject({ unavailableReason: expect.any(String), shiftDetails: [] });
  });
});
