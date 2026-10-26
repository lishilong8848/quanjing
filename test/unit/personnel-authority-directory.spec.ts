import { buildSiteMemberDirectory } from '../../server/common/access/site-member-directory';

const source = ['cli_authority_fixture', 'synthetic-base', 'tblSynthetic'] as const;
const person = (record_id: string, name: string, openId: string, fields = {}) => ({ record_id, fields: { 姓名: name, 员工姓名: [{ id: openId, name }], ...fields } });

describe('统一人员目录只读影子快照', () => {
  it('保留离职人员用于交接，但不加入在职成员授权', () => {
    const result = buildSiteMemberDirectory([
      person('recFormer', '原示例人员001', 'ou_former', { 岗位: '设施运维示例人员001', '机楼/专业': ['C楼'], '离职/异动情况': '已离职' }),
      person('recNew', '接任示例人员001', 'ou_new', { 岗位: '设施运维示例人员001', 体系岗位: '运维示例人员001', '机楼/专业': ['C楼'], 权限身份: ['楼栋管理员'] }),
    ], ...source);
    expect(result.members).toHaveLength(1);
    expect(result).toMatchObject({ authorityPeople: [
      { recordId: 'recFormer', name: '原示例人员001', active: false, buildings: ['C楼'] },
      { recordId: 'recNew', name: '接任示例人员001', active: true, buildings: ['C楼'], position: '设施运维示例人员001', permissionTags: ['楼栋管理员'] },
    ] });
  });
  it('值班账号和协作人员单独分类；关联只保留record ID且不读取凭据', () => {
    const result = buildSiteMemberDirectory([
      person('recDuty', '楼栋值班', 'ou_duty', { 人员类型: '值班账号', 任职职责: ['recDutyRole'], 密码: 'synthetic-private-value', 身份证号: 'synthetic-id-value' }),
      person('recCollab', '协作验收', 'ou_collab', { 人员类型: '协作人员', '机楼/专业': ['A楼', '电气'] }),
    ], ...source);
    expect(result).toMatchObject({ authorityPeople: [
      { recordId: 'recDuty', type: 'duty_account', dutyRecordIds: ['recDutyRole'] },
      { recordId: 'recCollab', type: 'collaborator', buildings: ['A楼'], specialties: ['电气'] },
    ] });
    const authority = (result as unknown as { authorityPeople: unknown[] }).authorityPeople;
    expect(JSON.stringify(authority)).not.toMatch(/synthetic-private-value|synthetic-id-value|passwordHash|密码|身份证/);
  });
  it('同名人员不合并，两个在职记录关联同一Open ID阻断统一目录激活', () => {
    const sameName = buildSiteMemberDirectory([person('recOne', '同名', 'ou_one'), person('recTwo', '同名', 'ou_two')], ...source);
    expect(sameName).toMatchObject({ authorityPeople: [{ recordId: 'recOne' }, { recordId: 'recTwo' }], authorityProblems: [] });
    const duplicate = buildSiteMemberDirectory([person('recOne', '甲', 'ou_one'), person('recTwo', '乙', 'ou_one')], ...source);
    expect(duplicate).toMatchObject({ authorityProblems: expect.arrayContaining(['在职人员飞书身份重复']) });
  });
  it('未知楼栋、错误职责关联和多人员关联有明确问题，不猜测有效职责', () => {
    const result = buildSiteMemberDirectory([person('recBad', '异常验收', 'ou_bad', { '机楼/专业': ['F楼'], 任职职责: ['姓名字符串'] })], ...source);
    expect(result).toMatchObject({ authorityProblems: expect.arrayContaining(['人员楼栋范围无效', '人员职责关联无效']) });
  });
  it('未知人员类型不能通过对象原型属性伪装成有效枚举', () => {
    const result = buildSiteMemberDirectory([person('recType', '类型验收', 'ou_type', { 人员类型: '__proto__' })], ...source);
    expect(result).toMatchObject({ authorityProblems: expect.arrayContaining(['人员类型无效']) });
  });
});
