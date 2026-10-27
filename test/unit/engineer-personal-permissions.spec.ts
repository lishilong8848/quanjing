import { canManageProfessionalRecord } from '../../shared/professional-access';
import { canPerformBusinessAction, decideBusinessPermission, validPersonalRules, type PersonalPermissionRule } from '../../shared/business-permissions';
import { buildSiteMemberDirectory } from '../../server/common/access/site-member-directory';
import { reconcileSiteMemberAccounts } from '../../server/common/access/site-member-accounts';

describe('工程师专业与楼栋的默认权限', () => {
  const canManage = canManageProfessionalRecord as (...args: unknown[]) => boolean;
  const engineer = { role: 'professional_engineer', purchaseBuilding: 'B楼', buildings: ['B楼'], specialties: ['电气'] };

  it('允许本人楼栋和专业的记录', () => {
    expect(canManage(engineer, '电气', 'B楼')).toBe(true);
  });
  it('拒绝跨楼栋、跨专业和未维护归属的记录', () => {
    expect(canManage(engineer, '电气', 'A楼')).toBe(false);
    expect(canManage(engineer, '暖通', 'B楼')).toBe(false);
    expect(canManage(engineer, '电气')).toBe(false);
  });
});

describe('角色默认与个人独立规则', () => {
  const base = { role: 'professional_engineer' as const, purchaseBuilding: 'B楼' as const, buildings: ['B楼'] as const, specialties: ['电气'] as const };
  const rule = (id: string, effect: 'allow' | 'deny', buildings: PersonalPermissionRule['buildings'], specialties: PersonalPermissionRule['specialties'], actions: PersonalPermissionRule['actions'] = ['read', 'update']): PersonalPermissionRule => ({ id, effect, module: 'inventory', actions, buildings, specialties });
  const check = (personalRules: PersonalPermissionRule[], building: string, specialty: string, action: 'read' | 'update' = 'read') => canPerformBusinessAction({ ...base, personalRules }, { module: 'inventory', action, building, specialty });
  it('知识交付默认全量，并允许单独限制动作', () => {
    expect(canPerformBusinessAction(base, { module: 'knowledge', action: 'delete' })).toBe(true);
    const personalRules: PersonalPermissionRule[] = [{ id: 'knowledge-deny', effect: 'deny', module: 'knowledge', actions: ['delete'], buildings: null, specialties: null }];
    expect(canPerformBusinessAction({ ...base, personalRules }, { module: 'knowledge', action: 'delete' })).toBe(false);
    expect(canPerformBusinessAction({ ...base, personalRules }, { module: 'knowledge', action: 'update' })).toBe(true);
  });
  it('A楼电气与C楼暖通分别允许，不产生A楼暖通或C楼电气', () => {
    const rules = [rule('a-electric', 'allow', ['A楼'], ['电气']), rule('c-hvac', 'allow', ['C楼'], ['暖通'])];
    expect(check(rules, 'A楼', '电气')).toBe(true);
    expect(check(rules, 'C楼', '暖通')).toBe(true);
    expect(check(rules, 'A楼', '暖通')).toBe(false);
    expect(check(rules, 'C楼', '电气')).toBe(false);
  });
  it('额外只读不开放修改', () => {
    const rules = [rule('a-read', 'allow', ['A楼'], ['电气'], ['read'])];
    expect(check(rules, 'A楼', '电气')).toBe(true);
    expect(check(rules, 'A楼', '电气', 'update')).toBe(false);
    expect(check(rules, 'B楼', '电气', 'update')).toBe(true);
  });
  it('限制优先于角色和显式允许，顺序不影响结果', () => {
    const rules = [rule('allow', 'allow', null, ['电气']), rule('deny', 'deny', ['B楼'], ['电气'])];
    expect(check(rules, 'B楼', '电气')).toBe(false);
    expect(check([...rules].reverse(), 'B楼', '电气')).toBe(false);
    expect(check(rules, 'A楼', '电气')).toBe(true);
    expect(decideBusinessPermission({ ...base, personalRules: rules }, { module: 'inventory', action: 'read', building: 'B楼', specialty: '电气' }).source).toBe('deny');
  });
  it('多楼栋或专业记录的每个组合都必须有权限', () => {
    const rules = [rule('a', 'allow', ['A楼'], ['电气']), rule('c', 'allow', ['C楼'], ['暖通'])];
    expect(canPerformBusinessAction({ ...base, personalRules: rules }, { module: 'inventory', action: 'read', building: ['A楼', 'C楼'], specialty: ['电气', '暖通'] })).toBe(false);
  });
  it('拒绝未知动作、空范围、重复id及不支持的模块操作', () => {
    expect(validPersonalRules([rule('valid', 'allow', ['A楼'], ['电气'])])).toBe(true);
    expect(validPersonalRules([rule('empty', 'allow', [], ['电气'])])).toBe(false);
    expect(validPersonalRules([rule('same', 'allow', null, null), rule('same', 'deny', null, null)])).toBe(false);
    expect(validPersonalRules([{ ...rule('wrong', 'allow', null, null), module: 'tools', actions: ['delete'] }])).toBe(false);
    expect(check([{ ...rule('invalid', 'allow', null, null), unexpected: true } as never], 'B楼', '电气')).toBe(false);
  });
  it('清空个人规则恢复继承，并保持专业主管旧范围', () => {
    expect(check([], 'B楼', '电气')).toBe(true);
    expect(check([], 'A楼', '电气')).toBe(false);
    expect(canManageProfessionalRecord({ role: 'professional_admin', specialties: ['电气'] }, '电气')).toBe(true);
    expect(canManageProfessionalRecord({ role: 'professional_admin', specialties: ['电气'] }, '电气、未知')).toBe(false);
  });
});

describe('工程师在职人员同步', () => {
  it('工程师范围未明确时，在职游客仍获得基地成员基础权限，不猜专业或楼栋', () => {
    const directory = buildSiteMemberDirectory([{ record_id: 'recUnscopedEngineer', fields: { 姓名: '合成在职工程师', 员工姓名: [{ id: 'ou_unscoped_engineer', name: '合成在职工程师' }], 岗位: '工程师', '离职/异动情况': false } }], 'cli_engineer_fixture', 'synthetic-base', 'tblSynthetic');
    expect(directory.members[0].engineerScopeInvalid).toBe(true);
    const id = directory.members[0].passwordAccountId;
    const accounts = { [id]: { id, kind: 'local' as const, name: '合成在职工程师', role: 'guest' as const, building: null, version: 1, enabled: true, deleted: false, source: 'configuration' as const, permissionSource: 'personnel' as const, personnelAppId: 'cli_engineer_fixture', loginMethod: 'personnel-password' as const } };
    reconcileSiteMemberAccounts(accounts, 'cli_engineer_fixture', directory.members);
    expect(accounts[id]).toMatchObject({ role: 'site_member', building: null, siteMember: true });
    expect(accounts[id]).not.toHaveProperty('specialties'); expect(accounts[id]).not.toHaveProperty('buildings');
  });
  const records = [{ record_id: 'recEngineer', fields: { 姓名: '杨浩浩', 员工姓名: [{ id: 'ou_engineer', name: '杨浩浩' }], 岗位: '电气工程师', 体系岗位: '电气专业工程师', '机楼/专业': ['B楼'], 楼栋: ['optUnreadable'] } }];
  it('从实际可读标签生成B楼电气范围，并关联稳定身份', () => {
    const { members } = buildSiteMemberDirectory(records, 'cli_test', 'app', 'table');
    const changes = reconcileSiteMemberAccounts({}, 'cli_test', members);
    expect(changes[0].after).toMatchObject({ role: 'professional_engineer', building: 'B楼', buildings: ['B楼'], specialties: ['电气'], personnelIdentity: members[0].passwordAccountId });
  });
  it('不把查找引用编号作为楼栋权限', () => {
    const { members } = buildSiteMemberDirectory([{ ...records[0], fields: { ...records[0].fields, '机楼/专业': [], 楼栋: ['optUnreadable'] } }], 'cli_test', 'app', 'table');
    expect(reconcileSiteMemberAccounts({}, 'cli_test', members)[0].after.role).toBe('site_member');
  });
});
