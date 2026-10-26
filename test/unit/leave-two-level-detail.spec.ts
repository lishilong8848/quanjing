jest.mock('../../server/common/feishu/bitable-direct-read', () => ({ ...jest.requireActual('../../server/common/feishu/bitable-direct-read'), readLatestPersistedBitableRecordSnapshot: jest.fn() }));
import { readLatestPersistedBitableRecordSnapshot } from '../../server/common/feishu/bitable-direct-read';
import { readCachedLeaveApprovalSnapshot } from '../../server/common/feishu/leave-approval-source';
import { LeaveWorkflowDetailGateway } from '../../server/modules/leave-workflow/leave-workflow.detail-gateway';
import { fixture } from './fixtures/leave-two-level';

function api() {
  const rows: any[] = [];
  let writes = 0;
  let tamper = false;
  const httpService = { axiosRef: {
    post: jest.fn(async (url: string, body: any) => {
      if (url.includes('/auth/')) return { data: { code: 0, tenant_access_token: 'synthetic-detail-token' } };
      if (url.endsWith('/search')) {
        const filter = body.filter.conditions[0];
        return { data: { code: 0, data: { items: rows.filter(row => row.fields[filter.field_name] === filter.value[0]), has_more: false } } };
      }
      if (!url.endsWith('/records')) throw Error('Unexpected synthetic request');
      writes++;
      const record = { record_id: `rec_detail_${writes}`, fields: structuredClone(body.fields) };
      rows.push(record); return { data: { code: 0, data: { record } } };
    }),
    put: jest.fn(async (url: string, body: any) => {
      writes++; const row = rows.find(item => url.endsWith(`/${item.record_id}`));
      if (!row) throw Error('Missing synthetic row'); row.fields = { ...row.fields, ...structuredClone(body.fields) };
      return { data: { code: 0, data: { record: row } } };
    }),
    get: jest.fn(async (url: string) => {
      const row = rows.find(item => url.endsWith(`/${item.record_id}`));
      if (!row) throw Error('Unexpected synthetic read');
      const record = structuredClone(row);
      if (tamper) record.fields['替班人员OpenID'] = 'ou_wrong_primary';
      return { data: { code: 0, data: { record } } };
    }),
  } };
  return { httpService, rows, writes: () => writes, tamper: (value: boolean) => { tamper = value; } };
}

describe('two-level leave external-detail adapter', () => {
  const saved: Record<string, string | undefined> = {};
  const configuration = { FEISHU_APP_ID: 'cli_two_level_detail', FEISHU_APP_SECRET: 'synthetic-only-not-a-credential', FEISHU_LEAVE_REQUEST_APP_TOKEN: 'app_synthetic_detail', FEISHU_LEAVE_REQUEST_TABLE_ID: 'tbl_synthetic_leave', FEISHU_LEAVE_SHIFT_DETAIL_TABLE_ID: 'tbl_synthetic_detail' };
  beforeEach(() => { for (const [key, value] of Object.entries(configuration)) { saved[key] = process.env[key]; process.env[key] = value; } });
  afterEach(() => { for (const key of Object.keys(configuration)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  it('writes only the existing primary columns while retaining full backup metadata locally', async () => {
    const fake = api(); const data = fixture();
    const gateway = new LeaveWorkflowDetailGateway(fake.httpService as never);
    await gateway.upsertCurrentAssignments(data.application.recordId, 0, data.assignments);
    expect(fake.rows[0].fields).not.toHaveProperty('原岗补位安排');
    expect((await gateway.readByLeaveRecordIds([data.application.recordId]))[0].assignment?.substituteOpenId).toBe(data.assignments[0].substituteOpenId);
    expect(data.assignments[0].originalPostBackfills).toHaveLength(1);
    const writes = fake.writes();
    await new LeaveWorkflowDetailGateway(fake.httpService as never).upsertCurrentAssignments(data.application.recordId, 0, data.assignments);
    expect(fake.writes()).toBe(writes);
  });
  it('rejects a mismatched primary identity on cloud readback then retries without duplicating a correct stored row', async () => {
    const fake = api(); const data = fixture(); fake.tamper(true);
    const gateway = new LeaveWorkflowDetailGateway(fake.httpService as never);
    await expect(gateway.upsertCurrentAssignments(data.application.recordId, 0, data.assignments)).rejects.toThrow(/回读|补位/);
    const writes = fake.writes(); fake.tamper(false);
    await gateway.upsertCurrentAssignments(data.application.recordId, 0, data.assignments);
    expect(fake.rows).toHaveLength(1); expect(fake.writes()).toBe(writes);
  });
  it('does not use legacy external JSON as a substitute for the authoritative local ledger', async () => {
    const data = fixture(); const now = Date.now();
    jest.mocked(readLatestPersistedBitableRecordSnapshot)
      .mockResolvedValueOnce({ fetchedAt: now, expiresAt: now + 60_000, records: [{ record_id: data.application.recordId, fields: { 系统审批完成标记: '审批结束', '休假人员（文本）': data.application.snapshot.applicantName, 替班调整版本: 0, 系统影响排班记录ID: data.assignments[0].scheduleRecordIds.join(',') } }] })
      .mockResolvedValueOnce({ fetchedAt: now, expiresAt: now + 60_000, records: [{ record_id: 'rec_external_detail', fields: { 状态: 'active', 请假记录ID: data.application.recordId, 班次键: data.assignments[0].shiftKey, 排班记录IDs: JSON.stringify(data.assignments[0].scheduleRecordIds), 替班人员姓名: data.assignments[0].substituteName, 替班安排版本: 0, 原岗补位安排: JSON.stringify({ version: 1, originalPostBackfills: data.assignments[0].originalPostBackfills, backfillPersonRecordId: data.assignments[0].backfillPersonRecordId, originalPostSignature: data.assignments[0].originalPostSignature }) } }] });
    const snapshot = await readCachedLeaveApprovalSnapshot();
    expect(snapshot.requests[0]).toMatchObject({ unavailableReason: expect.any(String), shiftDetails: [] });
  });
});
