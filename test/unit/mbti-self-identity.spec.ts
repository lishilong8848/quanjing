import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import { ATTACHED_BANK } from '../../shared/mbti-attached-bank-model';
import { MbtiAssessmentService } from '../../server/modules/bitable-sync/mbti-assessment.service';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { DEFAULT_ACTIVE_PERSONNEL_TABLE_ID } from '../../server/modules/bitable-sync/active-personnel-directory';

jest.mock('../../server/modules/bitable-sync/employee-onboarding.config', () => ({
  readEmployeeOnboardingConfig: () => ({ appToken: 'fixturePersonnelBase', wikiToken: '', tableId: 'tblOu75UtJTDNHIM', tableName: '在职人员' }),
}));
jest.mock('../../server/common/config/external-services.config', () => ({
  ...jest.requireActual('../../server/common/config/external-services.config'),
  readEnv: (name: string) => name === 'FEISHU_APP_ID' ? 'cli_fixture' : '',
}));
jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  readLatestPersistedBitableRecordSnapshot: jest.fn(),
  resolveBitableAppToken: jest.fn(async () => 'fixturePersonnelBase'),
}));
const { readLatestPersistedBitableRecordSnapshot } = require('../../server/common/feishu/bitable-direct-read');
const fields = { 姓名: '验收员工甲', 员工姓名: [{ id: 'ou_fixture', name: '验收员工甲' }], '机楼/专业': 'A楼', 岗位: '值班员' };
const recordId = 'recFixtureSelf';
const principals: AccessPrincipal[] = [
  { role: 'admin', purchaseBuilding: null, displayName: fields.姓名, accountId: `feishu-${feishuIdentityFingerprint('cli_fixture', 'ou_fixture')}` },
  { role: 'guest', purchaseBuilding: null, displayName: fields.姓名, accountId: 'local-external-' + createHash('sha256').update(JSON.stringify(['cli_fixture', 'fixturePersonnelBase', DEFAULT_ACTIVE_PERSONNEL_TABLE_ID, recordId])).digest('hex') },
];

describe('MBTI 登录本人记录', () => {
  let folder: string;
  let service: MbtiAssessmentService;
  const oldPath = process.env.MBTI_ASSESSMENT_LEDGER_PATH;
  const update = jest.fn();
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'mbti-self-'));
    process.env.MBTI_ASSESSMENT_LEDGER_PATH = join(folder, 'ledger.json');
    readLatestPersistedBitableRecordSnapshot.mockResolvedValue({ records: [{ record_id: recordId, fields }], fetchedAt: Date.now(), expiresAt: Date.now() + 60000 });
    update.mockReset();
    service = new MbtiAssessmentService({ readRecord: async () => fields, updateMbti: update } as never, {} as never);
    await new Promise(resolve => setImmediate(resolve));
  });
  afterEach(async () => {
    if (oldPath === undefined) delete process.env.MBTI_ASSESSMENT_LEDGER_PATH;
    else process.env.MBTI_ASSESSMENT_LEDGER_PATH = oldPath;
    await rm(folder, { recursive: true, force: true });
  });
  it.each(principals)('自动匹配 $accountId，不要求客户端选择姓名', async principal => {
    await expect((service as any).currentPerson(principal, true)).resolves.toMatchObject({ recordId, name: fields.姓名 });
  });
  it.each(principals)('提交前拒绝 $accountId 伪造人员记录', async principal => {
    await expect(service.submit({ clientMutationId: '52d87ff0-0e9f-4ae8-a39f-8af1c91d97db', audience: 'active', recordId: 'recOtherPerson', name: fields.姓名, version: 'short', answers: Array(60).fill(7), sourceSha256: ATTACHED_BANK.sourceSha256 }, principal))
      .rejects.toThrow('当前登录本人');
    expect(update).not.toHaveBeenCalled();
  });

  const payload = () => ({ clientMutationId: '52d87ff0-0e9f-4ae8-a39f-8af1c91d97db', audience: 'active', recordId, name: fields.姓名, version: 'short', answers: Array(60).fill(7), sourceSha256: ATTACHED_BANK.sourceSha256 });
  const waitForState = async (state: string) => {
    for (let i = 0; i < 80; i++) {
      if ((await service.status(payload().clientMutationId)).syncState === state) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('fixture background sync timed out');
  };
  it.each(principals)('本人 $accountId 提交、同步和重复提交只写一次', async principal => {
    await expect(service.submit(payload(), principal)).resolves.toMatchObject({ recordId, syncState: 'accepted' });
    await waitForState('success');
    await expect(service.submit(payload(), principal)).resolves.toMatchObject({ syncState: 'success' });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toBe(recordId);
    await expect(service.submit(payload(), { ...principal, accountId: 'feishu-other', displayName: fields.姓名 })).rejects.toThrow('未唯一匹配');
    expect(update).toHaveBeenCalledTimes(1);
  });
  it('人员 Open ID 在后台同步前变更时拒绝写入并保留明确失败状态', async () => {
    service = new MbtiAssessmentService({ readRecord: async () => ({ ...fields, 员工姓名: [{ id: 'ou_other', name: fields.姓名 }] }), updateMbti: update } as never, {} as never);
    await service.submit(payload(), principals[0]);
    await waitForState('error');
    expect((await service.status(payload().clientMutationId)).message).toContain('未唯一匹配');
    expect(update).not.toHaveBeenCalled();
  });
  it('冲突 Open ID、重复记录和离职记录都不会自动匹配', async () => {
    for (const records of [
      [{ record_id: recordId, fields: { ...fields, open_id: 'ou_other' } }],
      [{ record_id: recordId, fields }, { record_id: 'recDuplicate', fields }],
      [{ record_id: recordId, fields: { ...fields, '离职/异动情况': '离职' } }],
    ]) {
      service = new MbtiAssessmentService({ readRecord: async () => fields, updateMbti: update } as never, {} as never);
      readLatestPersistedBitableRecordSnapshot.mockResolvedValue({ records, fetchedAt: Date.now(), expiresAt: Date.now() + 60000 });
      await expect(service.currentPerson(principals[0], true)).rejects.toThrow('未唯一匹配');
    }
  });
});
