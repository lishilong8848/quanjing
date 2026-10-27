jest.mock('../../server/common/feishu/bitable-direct-read', () => ({ ...jest.requireActual('../../server/common/feishu/bitable-direct-read'), fetchBitableRecords: jest.fn(), readLatestPersistedBitableRecordSnapshot: jest.fn(), resolveBitableAppToken: jest.fn().mockResolvedValue('app_synthetic_required_metadata') }));
import { fetchBitableRecords, readLatestPersistedBitableRecordSnapshot } from '../../server/common/feishu/bitable-direct-read';
import { fetchLeaveApprovalSnapshot, readCachedLeaveApprovalSnapshot } from '../../server/common/feishu/leave-approval-source';
import { fixture } from './fixtures/leave-two-level';
import { writeOriginalPostBackfillMetadata } from '../../shared/leave-original-post-backfill';

describe('known two-level approvals must not silently downgrade when metadata is unavailable', () => {
  const previous: Record<string, string | undefined> = {};
  const env = { FEISHU_LEAVE_REQUEST_APP_TOKEN: 'app_synthetic_required_metadata', FEISHU_LEAVE_REQUEST_TABLE_ID: 'tbl_synthetic_required_leave', FEISHU_LEAVE_SHIFT_DETAIL_TABLE_ID: 'tbl_synthetic_required_detail' };
  let metadataPresent = false;
  const main = () => [{ record_id: fixture().application.recordId, fields: { 系统审批完成标记: '审批结束', '休假人员（文本）': fixture().application.snapshot.applicantName, '替班人员（填姓名）': fixture().assignments[0].substituteName, 替班调整版本: 0, 替班安排: '2026-10-16 白班 09:00–18:00：吴亚兵\n原岗补位 C楼 2026-10-16 白班 09:00–18:00：张三' } }];
  const details = () => [{ record_id: 'rec_required_detail', fields: { 状态: 'active', 请假记录ID: fixture().application.recordId, 班次键: fixture().selection.shiftKey, 排班记录IDs: JSON.stringify(fixture().assignments[0].scheduleRecordIds), 替班人员姓名: fixture().assignments[0].substituteName, 替班安排版本: 0, ...(metadataPresent ? { 原岗补位安排: writeOriginalPostBackfillMetadata(fixture().assignments[0]) } : {}) } }];
  beforeEach(() => {
    for (const [key, value] of Object.entries(env)) { previous[key] = process.env[key]; process.env[key] = value; }
    metadataPresent = false;
    jest.mocked(fetchBitableRecords).mockImplementation(async (_http, options) => options.tableName === '请休假审批状态' ? main() : details());
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockImplementation(async options => options.tableName === '请休假审批状态' ? { fetchedAt: Date.now(), expiresAt: Date.now() + 60_000, records: main() } : null);
  });
  afterEach(() => { jest.clearAllMocks(); for (const key of Object.keys(env)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  it('marks an explicitly two-level request unavailable without globally rejecting strict reads', async () => {
    const snapshot = await fetchLeaveApprovalSnapshot({} as never, { forceRefresh: true, strict: true });
    expect(snapshot.verified).toBe(true);
    expect(snapshot.requests[0]).toMatchObject({ unavailableReason: expect.any(String), shiftDetails: [], substituteStaff: [] });
  });
  it('does not treat cloud metadata as authority when the local decision is missing', async () => {
    metadataPresent = true;
    const snapshot = await fetchLeaveApprovalSnapshot({} as never, { forceRefresh: true, strict: true });
    expect(snapshot.verified).toBe(true); expect(snapshot.requests[0]).toMatchObject({ unavailableReason: expect.any(String), shiftDetails: [] });
  });
  it('returns an explicitly unverified cached source instead of a false one-level success when detail cache is missing', async () => {
    const snapshot = await readCachedLeaveApprovalSnapshot();
    expect(snapshot.verified).toBe(false);
  });
});
