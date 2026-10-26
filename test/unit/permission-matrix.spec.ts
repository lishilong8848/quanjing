import { buildPermissionMatrix, matrixAccountSubject, matrixRoleSubject } from '../../shared/permission-matrix';
import type { ManagedAccount } from '../../shared/access-configuration.interface';

const account = (patch: Partial<ManagedAccount> = {}): ManagedAccount => ({ id: 'synthetic-engineer', kind: 'feishu', name: '示例工程师', role: 'professional_engineer', building: 'B楼', buildings: ['B楼'], specialties: ['电气'], enabled: true, deleted: false, version: 3, source: 'configuration', appId: 'cli_synthetic', openId: 'ou_synthetic', ...patch });
const cell = (patch: Partial<ManagedAccount>, path: string, options = {}) => buildPermissionMatrix(matrixAccountSubject(account(patch)), options).find(item => item.path === path)!;

describe('权限矩阵与当前有效策略一致', () => {
  it('收回权限后的矩阵按游客显示，保留公開读取而不套用原管理员和个人增补', () => {
    const subject=matrixAccountSubject(account({role:'admin',building:null,buildings:undefined,specialties:undefined,enabled:false,permissionsRevoked:true,guestLoginAllowed:true,pagePaths:['/operations-kb'],personalRules:[{id:'synthetic-extra',module:'purchase',effect:'allow',actions:['update'],buildings:['B楼'],specialties:['电气']}]}));
    expect(subject.enabled).toBe(true);expect(subject.principal.role).toBe('guest');expect(subject.principal.personalRules).toBeUndefined();
    const matrix=buildPermissionMatrix(subject);
    expect(matrix.find(item=>item.path==='/nantong-base')).toMatchObject({read:'all',operations:'none'});
    expect(matrix.find(item=>item.path==='/operations-kb')?.read).toBe('none');
    expect(matrix.find(item=>item.path==='/purchase-inventory-management')?.operations).toBe('none');
  });
  it('角色页面增补只表示可读，不把游客变成业务操作人', () => {
    const result = cell({ role: 'guest', building: null, buildings: undefined, specialties: undefined }, '/contract-management', { pageRules: { guest: ['/contract-management'] } });
    expect(result.read).toBe('all'); expect(result.operations).toBe('none'); expect(result.approval).toBe('unknown');
  });
  it('工程师角色和个人独立规则没有楼栋专业交叉扩权', () => {
    const patch: Partial<ManagedAccount> = { personalRules: [{ id: 'extra', effect: 'allow', module: 'purchase', actions: ['update'], buildings: ['A楼'], specialties: ['暖通'] }] };
    const result = cell(patch, '/purchase-inventory-management');
    const update = result.actions.find(item => item.action === 'update')!;
    expect(update.state).toBe('partial');
    expect(update.allowed).toEqual(expect.arrayContaining([{ building: 'B楼', specialty: '电气' }, { building: 'A楼', specialty: '暖通' }]));
    expect(update.allowed).not.toEqual(expect.arrayContaining([{ building: 'B楼', specialty: '暖通' }]));
    expect(update.allowed).not.toEqual(expect.arrayContaining([{ building: 'A楼', specialty: '电气' }]));
  });
  it('同一楼栋专业的个人限制覆盖角色允许，筛选就地生效', () => {
    const result = cell({ personalRules: [{ id: 'deny', effect: 'deny', module: 'purchase', actions: ['delete'], buildings: ['B楼'], specialties: ['电气'] }] }, '/purchase-inventory-management', { building: 'B楼', specialty: '电气' });
    const action = result.actions.find(item => item.action === 'delete')!;
    expect(action).toMatchObject({ state: 'none', denied: [{ building: 'B楼', specialty: '电气' }], sources: ['个人限制'] });
    expect(result.actions.find(item => item.action === 'update')!.state).toBe('all');
  });
  it('已停用人员不显示有效页面或操作，既有卡片需要单独交接', () => {
    const result = cell({ enabled: false, role: 'admin', building: null }, '/purchase-inventory-management');
    expect(result.read).toBe('disabled'); expect(result.operations).toBe('disabled');
    expect(result.approval).toBe('unknown'); expect(result.notes.join('')).toContain('既有卡片');
  });
  it('角色视角缺少楼栋专业时标明需要范围，不假定全基地全专业', () => {
    const result = buildPermissionMatrix(matrixRoleSubject('professional_engineer', '工程师')).find(item => item.path === '/purchase-inventory-management')!;
    expect(result.operations).toBe('conditional'); expect(result.notes.join('')).toContain('楼栋');
  });
  it('通知与审批分别匹配同应用Open ID，不能因为管理员就拥有卡片审批', () => {
    const rules = [{ appId: 'cli_synthetic', code: 'warehouse_notify' as const, building: 'B楼' as const, members: [{ name: '示例工程师', openId: 'ou_synthetic' }], version: 7 }];
    const result = cell({}, '/inventory-management', { cardRules: rules, appId: 'cli_synthetic', building: 'B楼' });
    expect(result.notification).toBe('all'); expect(result.approval).toBe('unknown');
    expect(result.cardDuties).toEqual([{ name: '库房知会', building: 'B楼', version: 7 }]);
    const foreign = cell({ appId: 'cli_other' }, '/inventory-management', { cardRules: rules, appId: 'cli_synthetic', building: 'B楼' });
    expect(foreign.notification).toBe('unknown');
  });
  it('旧业务未逐动作接入时不把宽泛角色默认规则画成全量可修改', () => {
    const result = cell({ role: 'building_admin', specialties: undefined }, '/equipment-ledger-management');
    expect(result.read).toBe('all'); expect(result.operations).toBe('unknown');
  });
  it('知识交付不受工程师楼栋专业限制；管理员仍显示全量页面和业务动作', () => {
    expect(cell({}, '/operations-kb').operations).toBe('all');
    const result = cell({ role: 'admin', building: null, buildings: undefined, specialties: undefined }, '/purchase-inventory-management');
    expect(result.read).toBe('all'); expect(result.operations).toBe('all'); expect(result.approval).toBe('unknown');
  });
  it('页面可打开与其业务数据范围区别显示，库存和盘点动作保留不同模块身份', () => {
    const result = cell({}, '/inventory-management');
    expect(result.read).toBe('partial');
    expect(result.actions.filter(item => item.action === 'confirm').map(item => item.module)).toEqual(['inventory','stocktake']);
    expect(cell({}, '/inventory-management', { building:'B楼', specialty:'电气' }).read).toBe('all');
    expect(cell({}, '/inventory-management', { building:'A楼', specialty:'电气' }).read).toBe('none');
  });
  it('关闭页面读取不擅自撤销原业务操作规则，两类鉴权独立展示', () => {
    const result = cell({}, '/purchase-inventory-management', { pageRules:{ professional_engineer:[] },building:'B楼',specialty:'电气' });
    expect(result.read).toBe('none'); expect(result.actions.find(item=>item.action==='update')!.state).toBe('all');
  });
});
