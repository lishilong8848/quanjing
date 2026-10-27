import { AccessConfigurationDirectory } from '../../server/common/access/access-configuration.directory';
import { fetchBitableRecords } from '../../server/common/feishu/bitable-direct-read';
import { authorityDutyMatchesTarget } from '../../server/common/access/personnel-authority.duties';

jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(), getTenantAccessToken: jest.fn(async () => 'synthetic-token'), resolveBitableAppToken: jest.fn(async () => 'synthetic-base'),
}));
jest.mock('../../server/common/access/external-employee-directory', () => ({ readExternalEmployeeCredentials: jest.fn(async () => []) }));

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; jest.clearAllMocks(); });
const people = [
  { record_id: 'recFormer', fields: { 姓名: '原主管', '飞书 open_id': 'ou_former', 岗位: '设施运维主管', '机楼/专业': ['C楼'], '离职/异动情况': '已离职' } },
  { record_id: 'recNew', fields: { 姓名: '接任主管', '飞书 open_id': 'ou_new', 岗位: '设施运维主管', '机楼/专业': ['C楼'], 权限身份: ['楼栋管理员'], 任职职责: ['recCChief'] } },
];
const duty = { record_id: 'recCChief', fields: { 职责名称: 'C楼主管', 职责类型: '楼栋主管', 在任人员: ['recNew'], 楼栋范围: ['C楼'], 专业范围: ['全部专业'], 权限角色: '楼栋主管', 启用: true, 任职版本: 1 } };
function setup(duties = [duty]) {
  process.env.FEISHU_APP_ID = 'cli_authority_fixture';
  const master = people.map(person => ({ ...person, fields: { ...person.fields, 任职职责: duties.filter(item => item.fields.在任人员.includes(person.record_id)).map(item => item.record_id) } }));
  (fetchBitableRecords as jest.Mock).mockImplementation(async (_http, options) => options.tableId === 'tblAuthorityFixture' ? duties : options.viewId ? master.filter(person => person.record_id !== 'recFormer') : master);
  const names = ['姓名','飞书 open_id','岗位','机楼/专业','权限身份','任职职责','离职/异动情况'];
  const http = { axiosRef: { get: jest.fn(async (url: string) => ({ data: { code: 0, data: { has_more: false, items: url.endsWith('/tables')
    ? [{ table_id: 'tblAuthorityFixture', name: '01-4 岗位职责与授权' }]
    : url.includes('tblAuthorityFixture') ? Object.keys(duty.fields).map(field_name => ({ field_name }))
    : names.map(field_name => ({ field_name })) } } })) } };
  return new AccessConfigurationDirectory(http as never);
}

describe('配置目录人员职责只读接入', () => {
  it('读取完整主表供离职交接，登录候选仍仅在职；不会回读密码和身份证', async () => {
    const result = await setup().read();
    expect(result.people).toEqual([{ name: '接任主管', openId: 'ou_new' }]);
    expect(result).toMatchObject({ personnelAuthority: { mode: 'shadow', problems: [], people: [
      { recordId: 'recFormer', active: false }, { recordId: 'recNew', active: true, permissionTags: ['楼栋管理员'] },
    ], duties: expect.arrayContaining([{ recordId: 'recCChief', name:'C楼主管',kind: 'building_supervisor',personnelIds:expect.any(Array), buildings: ['C楼'],specialties:null,role:'building_admin',enabled:true,startsAt:0,endsAt:null,parentDutyIds:[], version: 1 }]) } });
    for (const [, options] of (fetchBitableRecords as jest.Mock).mock.calls) expect(options.fieldNames).not.toEqual(expect.arrayContaining(['密码','身份证号']));
  });
  it('角色引用缺失的人员时保留问题而不是按显示姓名匹配', async () => {
    const result = await setup([{ ...duty, fields: { ...duty.fields, 在任人员: ['recUnknown'] } }]).read();
    expect(result).toMatchObject({ personnelAuthority: { mode: 'shadow', problems: expect.arrayContaining(['职责关联人员不存在']) } });
  });
  it('异常信息包含职责记录ID，可定位坏关联而不暴露完整记录', async () => {
    const result = await setup([{ ...duty, fields: { ...duty.fields, 在任人员: ['recUnknown'] } }]).read();
    expect(result).toMatchObject({ personnelAuthority: { issues: expect.arrayContaining([{ recordId: 'recCChief', message: '职责关联人员不存在' }]) } });
  });
  it('同一人在不同楼栋专业的职责独立匹配，不产生交叉组合', async () => {
    const result = await setup([
      { ...duty, record_id: 'recElectricA', fields: { ...duty.fields, 职责类型: '工程师', 楼栋范围: ['A楼'], 专业范围: ['电气'], 权限角色: '专业工程师' } },
      { ...duty, record_id: 'recHvacC', fields: { ...duty.fields, 职责类型: '工程师', 楼栋范围: ['C楼'], 专业范围: ['暖通'], 权限角色: '专业工程师' } },
    ]).read();
    const entries = result.personnelAuthority!.duties.filter(duty=>duty.kind==='professional_engineer');
    expect(result.personnelAuthority!.problems).toEqual([]);
    expect(entries.some(item => authorityDutyMatchesTarget(item, { building: 'A楼', specialty: '电气' }))).toBe(true);
    expect(entries.some(item => authorityDutyMatchesTarget(item, { building: 'C楼', specialty: '暖通' }))).toBe(true);
    expect(entries.some(item => authorityDutyMatchesTarget(item, { building: 'A楼', specialty: '暖通' }))).toBe(false);
    expect(entries.some(item => authorityDutyMatchesTarget(item, { building: 'C楼', specialty: '电气' }))).toBe(false);
  });
  it('同一主管席位在任时间重叠和非法角色枚举阻断源激活', async () => {
    const result = await setup([duty, { ...duty, record_id: 'recDuplicate', fields: { ...duty.fields, 权限角色: '__proto__' } }]).read();
    expect(result).toMatchObject({ personnelAuthority: { problems: expect.arrayContaining(['职责任职范围重叠','职责权限角色无效']) } });
  });
  it('影子职责表读取失败不阻断现有人员目录，错误明确保留供管理员处理', async () => {
    const directory = setup();
    const original = (fetchBitableRecords as jest.Mock).getMockImplementation()!;
    (fetchBitableRecords as jest.Mock).mockImplementation(async (http, options) => {
      if (options.tableId === 'tblAuthorityFixture') throw new Error('synthetic external failure');
      return original(http, options);
    });
    const result = await directory.read();
    expect(result.people).toEqual([{ name: '接任主管', openId: 'ou_new' }]);
    expect(result).toMatchObject({ personnelAuthority: { duties: [], problems: expect.arrayContaining(['职责目录读取失败，现有人员授权保留']) } });
  });
  it('混合非法专业或无效时钟不能以部分合法数据匹配职责', async () => {
    const result = await setup().read();
    const entry = result.personnelAuthority!.duties[0];
    expect(authorityDutyMatchesTarget(entry, { building: 'C楼', specialty: ['电气','invalid'] })).toBe(false);
    expect(authorityDutyMatchesTarget(entry, { building: 'C楼', specialty: '电气' }, Number.NaN)).toBe(false);
  });
});
