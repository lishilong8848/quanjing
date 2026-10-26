import { buildSiteMemberDirectory } from '../../server/common/access/site-member-directory';
import { buildAuthorityPeople } from '../../server/common/access/personnel-authority.people';
import { buildExternalEmployeeCredentials, readExternalEmployeeCredentials } from '../../server/common/access/external-employee-directory';
import { reconcileSiteMemberAccounts } from '../../server/common/access/site-member-accounts';
import { randomBytes } from 'node:crypto';
import type { StoredAccount } from '../../server/common/access/access-configuration.store';
import { AccessConfigurationDirectory } from '../../server/common/access/access-configuration.directory';
import { fetchBitableRecords } from '../../server/common/feishu/bitable-direct-read';
import { buildPersonnelEmploymentEvidence } from '../../server/common/access/personnel-employment-evidence';

jest.mock('../../server/common/access/external-employee-directory', () => ({
  ...jest.requireActual('../../server/common/access/external-employee-directory'), readExternalEmployeeCredentials: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'), fetchBitableRecords: jest.fn(),
  resolveBitableAppToken: jest.fn().mockResolvedValue('synthetic-base'), getTenantAccessToken: jest.fn().mockResolvedValue('synthetic-token'),
}));

const source = ['cli_employment_fixture', 'synthetic-base', 'tblSynthetic'] as const;
const row = (state: unknown) => ({ record_id: 'recEmploymentFixture', fields: {
  姓名: '合成人员', 员工姓名: [{ id: 'ou_employment_fixture', name: '合成人员' }],
  '离职/异动情况': state,
} });

describe('人员勾选收回权限的来源边界', () => {
  it.each([7,1,undefined])('按已验证字段类型%s处理API省略的复选框，不把未知字段当未勾选',async type=>{
    const original=process.env.FEISHU_APP_ID;process.env.FEISHU_APP_ID=source[0];
    const metadata=['姓名','员工姓名','岗位','机楼/专业','离职/异动情况'].map(field_name=>({field_name,type:field_name==='离职/异动情况'?type:1}));
    const http={axiosRef:{get:jest.fn().mockResolvedValue({data:{code:0,data:{items:metadata,has_more:false}}})}};
    const omitted={record_id:'recUnchecked',fields:{姓名:'合成在职人员',员工姓名:[{id:'ou_unchecked',name:'合成在职人员'}]}};
    (fetchBitableRecords as jest.Mock).mockResolvedValue([omitted,row(true)]);
    try{
      const snapshot=await new AccessConfigurationDirectory(http as never).read();
      expect(snapshot.employmentState?.entries.some(entry=>entry.openId==='ou_unchecked'&&entry.inactive===false)).toBe(type===7);
      expect(snapshot.employmentState?.entries).toContainEqual(expect.objectContaining({openId:'ou_employment_fixture',inactive:true}));
      expect(snapshot.activeMembers).toContainEqual(expect.objectContaining({openId:'ou_unchecked'}));
      expect(snapshot.activeMembers?.some(member=>member.openId==='ou_employment_fixture')).toBe(false);
      expect(Object.hasOwn(omitted.fields,'离职/异动情况')).toBe(false);
    }finally{if(original===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=original;jest.clearAllMocks();}
  });
  it('在职姓名账号无飞书身份也能生成基地成员目录，不把缺 Open ID 当整表失败', async () => {
    const original = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = source[0];
    const metadata = ['姓名','岗位','机楼/专业','离职/异动情况'].map(field_name => ({ field_name, type: field_name === '离职/异动情况' ? 7 : 1 }));
    const http = { axiosRef: { get: jest.fn().mockResolvedValue({ data: { code: 0, data: { items: metadata, has_more: false } } }) } };
    (fetchBitableRecords as jest.Mock).mockResolvedValue([{ record_id: 'recNameOnlyFixture', fields: { 姓名: '合成姓名账号', 岗位: '运维值班员', '机楼/专业': ['A楼'], '离职/异动情况': false } }]);
    try {
      const result = await new AccessConfigurationDirectory(http as never).read();
      expect(result.personnelComplete).toBe(true); expect(result.employees).toEqual([]);
      expect(result.activeMembers).toHaveLength(1); expect(result.activeMembers?.[0]).toMatchObject({ name: '合成姓名账号' });
      expect(result.activeMembers?.[0].openId).toBeUndefined(); expect(result.employmentState?.entries).toHaveLength(1);
    } finally { if (original === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = original; jest.clearAllMocks(); }
  });
  it('姓名账号坏行只隔离该行，完整合法凭据继续同步并提示', async () => {
    const original = process.env.LOCAL_ACCESS_SESSION_SECRET; process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    const password = `pbkdf2_sha256$600000$${randomBytes(16).toString('base64')}$${randomBytes(32).toString('base64')}`;
    const warnings: string[] = [];
    try {
      const valid = { ...row(false), fields: { ...row(false).fields, 密码: password } };
      const missing = { record_id: 'recMissingCredentialName', fields: { 姓名: '', 密码: password } };
      const result = await buildExternalEmployeeCredentials([missing, valid], ...source, warning => warnings.push(warning));
      expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ name: '合成人员', active: true, passwordHash: password });
      expect(warnings.join('')).toContain('姓名未维护');
    } finally { if (original === undefined) delete process.env.LOCAL_ACCESS_SESSION_SECRET; else process.env.LOCAL_ACCESS_SESSION_SECRET = original; }
  });
  it('缺稳定记录或重复记录仍拒绝完整性，冲突飞书身份不猜映射', () => {
    expect(buildPersonnelEmploymentEvidence([{ ...row(false), record_id: '' }], ...source).complete).toBe(false);
    expect(buildPersonnelEmploymentEvidence([row(false), row(false)], ...source).complete).toBe(false);
    const other = { ...row(true), record_id: 'recOtherFixture' };
    const repeated = buildPersonnelEmploymentEvidence([row(false), other], ...source);
    expect(repeated.complete).toBe(true); expect(repeated.entries).toHaveLength(2);
    expect(repeated.entries.every(entry => entry.openId === undefined)).toBe(true); expect(repeated.warnings.join('')).toContain('身份重复');
    const inconsistent = buildPersonnelEmploymentEvidence([{ ...row(true), fields: { ...row(true).fields, open_id: 'ou_synthetic_conflict' } }], ...source);
    expect(inconsistent.entries[0]).toMatchObject({ inactive: true }); expect(inconsistent.entries[0].openId).toBeUndefined(); expect(inconsistent.warnings.join('')).toContain('关联不一致');
  });
  it('缺姓名的单行不阻断其他成员，勾选状态仍按稳定身份收回', async () => {
    const original = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = source[0];
    const metadata = ['姓名','员工姓名','岗位','机楼/专业','离职/异动情况'].map(field_name => ({ field_name, type: field_name === '离职/异动情况' ? 7 : 1 }));
    const http = { axiosRef: { get: jest.fn().mockResolvedValue({ data: { code: 0, data: { items: metadata, has_more: false } } }) } };
    const missing = { record_id: 'recMissingName', fields: { 姓名: '', 员工姓名: [{ id: 'ou_synthetic_missing_name', name: '' }], '离职/异动情况': true } };
    (fetchBitableRecords as jest.Mock).mockResolvedValue([row(false), missing]);
    try {
      const result = await new AccessConfigurationDirectory(http as never).read();
      expect(result.employmentState?.complete).toBe(true);
      expect(result.employmentState?.entries).toHaveLength(2);
      expect(result.employmentState?.entries).toContainEqual(expect.objectContaining({ openId: 'ou_synthetic_missing_name', inactive: true }));
      expect(result.activeMembers?.map(person => person.name)).toEqual(['合成人员']);
      expect(result.personnelWarnings?.join('')).toContain('姓名');
    } finally { if (original === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = original; jest.clearAllMocks(); }
  });
  it('密码目录失败独立提示并保留旧凭据，不阻断在职成员同步或暴露错误内容', async () => {
    const original = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = source[0];
    const metadata = ['姓名','员工姓名','岗位','机楼/专业','离职/异动情况'].map(field_name => ({ field_name, type: field_name === '离职/异动情况' ? 7 : 1 }));
    const http = { axiosRef: { get: jest.fn().mockResolvedValue({ data: { code: 0, data: { items: metadata, has_more: false } } }) } };
    (fetchBitableRecords as jest.Mock).mockResolvedValue([row(false)]);
    (readExternalEmployeeCredentials as jest.Mock).mockRejectedValueOnce(new Error('synthetic-private-placeholder'));
    try {
      const result = await new AccessConfigurationDirectory(http as never).read();
      expect(result.externalEmployees).toBeUndefined(); expect(result.personnelComplete).toBe(true);
      expect(result.activeMembers).toHaveLength(1); expect(result.personnelWarnings?.join('')).toContain('姓名登录资料');
      expect(JSON.stringify(result)).not.toContain('synthetic-private-placeholder');
    } finally { if (original === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = original; jest.clearAllMocks(); }
  });
  it('已勾选即排除成员资格，不因仍出现在在职视图而恢复', () => {
    const directory = buildSiteMemberDirectory([row(true)], ...source);
    expect(directory.members).toHaveLength(0);
    expect(directory.authorityPeople[0]).toMatchObject({ active: false });
  });
  it('勾选后撤销自动成员身份；账号全局停用由同步事务另行处理', () => {
    const directory = buildSiteMemberDirectory([row(false)], ...source);
    const accounts: Record<string, StoredAccount> = {};
    reconcileSiteMemberAccounts(accounts, source[0], directory.members);
    expect(Object.values(accounts)[0]?.role).toBe('site_member');
    reconcileSiteMemberAccounts(accounts, source[0], buildSiteMemberDirectory([row(true)], ...source).members, true);
    expect(Object.values(accounts)[0]).toMatchObject({ role: 'guest', enabled: true });
  });
  it('明确已离职的文本证据阻止加入成员，并保留原人员身份供交接', () => {
    const directory = buildSiteMemberDirectory([row('已离职')], ...source);
    expect(directory.members).toHaveLength(0);
    expect(buildAuthorityPeople([row('已离职')], ...source).people[0]).toMatchObject({ active: false });
  });
  it('勾选不删除姓名密码登录凭据，授权状态由同步事务另行控制', async () => {
    const original = process.env.LOCAL_ACCESS_SESSION_SECRET;
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    const password = `pbkdf2_sha256$600000$${randomBytes(16).toString('base64')}$${randomBytes(32).toString('base64')}`;
    try {
      const credential = (state: unknown) => [{ ...row(state), fields: { ...row(state).fields, 密码: password } }];
      expect((await buildExternalEmployeeCredentials(credential(false), ...source))[0]).toMatchObject({ active: true, passwordHash: password });
      expect((await buildExternalEmployeeCredentials(credential(true), ...source))[0]).toMatchObject({ active: true, passwordHash: password });
      expect((await buildExternalEmployeeCredentials(credential('已离职'), ...source))[0]).toMatchObject({ active: true, passwordHash: password });
    } finally {
      if (original === undefined) delete process.env.LOCAL_ACCESS_SESSION_SECRET;
      else process.env.LOCAL_ACCESS_SESSION_SECRET = original;
    }
  });
  it('真实目录适配将勾选映射为收回授权，未知值不覆盖原状态且可见提示', async () => {
    const original = process.env.FEISHU_APP_ID;
    process.env.FEISHU_APP_ID = source[0];
    const metadata = ['姓名','员工姓名','岗位','机楼/专业','离职/异动情况'].map(field_name => ({ field_name, type: field_name === '离职/异动情况' ? 7 : 1 }));
    const http = { axiosRef: { get: jest.fn().mockResolvedValue({ data: { code: 0, data: { items: metadata, has_more: false } } }) } };
    (fetchBitableRecords as jest.Mock).mockResolvedValue([row(true)]);
    try {
      const snapshot = await new AccessConfigurationDirectory(http as never).read();
      expect(snapshot.employmentState).toMatchObject({ complete: true, entries: [expect.objectContaining({ inactive: true })] });
      expect(snapshot.activeMembers).toHaveLength(0);
      (fetchBitableRecords as jest.Mock).mockResolvedValue([row(undefined)]);
      const unknown = await new AccessConfigurationDirectory(http as never).read();
      expect(unknown.employmentState).toMatchObject({ complete: true, entries: [] });
      expect(unknown.personnelWarnings?.join('')).toContain('未明确');
    } finally {
      if (original === undefined) delete process.env.FEISHU_APP_ID;
      else process.env.FEISHU_APP_ID = original;
      jest.clearAllMocks();
    }
  });
});
