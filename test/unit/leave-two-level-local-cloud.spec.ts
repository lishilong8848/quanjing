import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LeaveWorkflowDetailGateway } from '../../server/modules/leave-workflow/leave-workflow.detail-gateway';
import { fixture, primary } from './fixtures/leave-two-level';

describe('two-level cloud synchronization uses only existing primary-assignment columns', () => {
  const previous = { ...process.env };
  beforeEach(() => { Object.assign(process.env, { FEISHU_APP_ID: 'cli_synthetic_local_cloud', FEISHU_APP_SECRET: 'synthetic-local-test', FEISHU_LEAVE_REQUEST_APP_TOKEN: 'app_synthetic_local_cloud', FEISHU_LEAVE_SHIFT_DETAIL_TABLE_ID: 'tbl_synthetic_local_cloud' }); });
  afterEach(() => { process.env = { ...previous }; });
  it('writes and semantically rereads the primary assignment without a schema query or new-column payload', async () => {
    const records: Array<{ record_id: string; fields: Record<string, unknown> }> = [];
    const writes: Record<string, unknown>[] = [];
    const post = jest.fn(async (url: string, body: any) => {
      if (url.includes('/auth/')) return { data: { code: 0, tenant_access_token: 'synthetic-local-token' } };
      if (url.endsWith('/records/search')) return { data: { code: 0, data: { items: records, has_more: false } } };
      if (Object.prototype.hasOwnProperty.call(body.fields || {}, '原岗补位安排')) throw Error('No such cloud column');
      const record = { record_id: 'rec_synthetic_detail', fields: body.fields }; records.push(record); writes.push(body.fields);
      return { data: { code: 0, data: { record } } };
    });
    const get = jest.fn(async (url: string) => {
      if (!url.endsWith('/rec_synthetic_detail')) throw Error('Unexpected field/schema query');
      return { data: { code: 0, data: { record: records[0] } } };
    });
    const http = { axiosRef: { post, get, put: jest.fn().mockRejectedValue(new Error('Unexpected duplicate write')) } };
    const data = fixture();
    await new LeaveWorkflowDetailGateway(http as never).upsertCurrentAssignments(data.application.recordId, 0, data.assignments);
    await new LeaveWorkflowDetailGateway(http as never).upsertCurrentAssignments(data.application.recordId, 0, data.assignments);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ 替班人员记录ID: primary.personRecordId, 替班人员OpenID: primary.openId, 替班人员姓名: primary.name, 替班用户: [{ id: primary.openId }] });
    expect(writes[0]).not.toHaveProperty('原岗补位安排');
    expect(get.mock.calls.every(([url]) => !url.endsWith('/fields'))).toBe(true);
    expect(data.assignments[0].originalPostBackfills).toHaveLength(1);
  });
  it('does not declare a new cloud field in the existing schema migration', () => {
    const source = readFileSync(resolve('scripts/ensure-leave-workflow-fields.mjs'), 'utf8');
    expect(source).not.toContain("text('原岗补位安排')");
  });
});
