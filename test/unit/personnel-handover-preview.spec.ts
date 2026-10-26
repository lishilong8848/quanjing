import { accountPermissionTemplate, previewPermissionInheritance, pendingHandoverSelection } from '../../server/common/access/personnel-handover.preview';
import type { ManagedAccount } from '../../shared/access-configuration.interface';
import type { PendingDuty } from '../../shared/personnel-handover.interface';

const person = (patch: Partial<ManagedAccount> = {}): ManagedAccount => ({ id:'synthetic-chief',kind:'feishu',name:'原示例人员001样例',role:'building_admin',building:'C楼',buildings:['C楼'],enabled:true,deleted:false,version:5,source:'configuration',...patch });
const entry = (patch: Partial<PendingDuty> = {}): PendingDuty => ({ key:'leave:synthetic-record:supervisor',module:'leave',recordId:'synthetic-record',title:'合成待办',dutyRecordId:'synthetic-duty',phase:'approval',status:'pending',stageKey:'supervisor',version:'stage-3',recipients:[{ name:'原示例人员001样例',openId:'ou_synthetic_former' }],...patch });
describe('岗位交接完整权限预览', () => {
  it('权限模板使用明确白名单，凭证、身份和私人字段不会进入继承', () => {
    const original = { ...person(),passwordHash:'synthetic-never-copy',password:'synthetic-never-copy',identityNumber:'synthetic-never-copy',openId:'ou_synthetic_former' };
    const template = accountPermissionTemplate(original);
    expect(template).toMatchObject({ role:'building_admin',building:'C楼',buildings:['C楼'],sourceVersion:5 });
    expect(JSON.stringify(template)).not.toContain('synthetic-never-copy'); expect(template).not.toHaveProperty('openId');
  });
  it('前任页面默认、配置读取与个人允许限制完整复制，已离职不把模板降为游客', () => {
    const source = accountPermissionTemplate(person({ enabled:false, personalRules:[{ id:'extra-knowledge',effect:'allow',module:'knowledge',actions:['read','update'],buildings:null,specialties:null }] }),{ building_admin:['/inventory-management','/operations-kb'] });
    const before = accountPermissionTemplate(person({ id:'synthetic-new',role:'site_member',building:null,buildings:undefined }));
    const result = previewPermissionInheritance(source,before,{ replacePersonnelDefault:true });
    expect(result.conflicts).toEqual([]); expect(result.after.role).toBe('building_admin'); expect(result.after.pagePaths).toEqual(source.pagePaths); expect(result.after.personalRules).toEqual(source.personalRules);
    expect(result.after.buildings).toEqual(['C楼']);
  });
  it('同角色楼栋示例人员001保留新人原有楼栋，不删除已有任职', () => {
    const result = previewPermissionInheritance(accountPermissionTemplate(person()),accountPermissionTemplate(person({ building:'B楼',buildings:['B楼'] })));
    expect(result.conflicts).toEqual([]); expect(result.after.buildings).toEqual(['B楼','C楼']);
  });
  it('两名不同楼栋专业工程师继承用独立规则表达，不生成楼栋专业笛卡尔扩权', () => {
    const source = accountPermissionTemplate(person({ role:'professional_engineer',building:'A楼',buildings:['A楼'],specialties:['暖通'] }));
    const target = accountPermissionTemplate(person({ role:'professional_engineer',building:'B楼',buildings:['B楼'],specialties:['电气'] }));
    const result = previewPermissionInheritance(source,target);
    expect(result.conflicts).toEqual([]); expect(result.after.buildings).toEqual(['B楼']); expect(result.after.specialties).toEqual(['电气']);
    expect(result.after.personalRules).toEqual(expect.arrayContaining([expect.objectContaining({ module:'purchase',effect:'allow',buildings:['A楼'],specialties:['暖通'] })]));
  });
  it('新人其他当前任职无法安全表达时阻断确认，不覆盖后假装全继承', () => {
    const source = accountPermissionTemplate(person());
    const target = accountPermissionTemplate(person({ role:'professional_engineer',building:'B楼',buildings:['B楼'],specialties:['电气'] }));
    const result = previewPermissionInheritance(source,target);
    expect(result.conflicts).toContain('不同角色的现有任职不能安全合并，请先明确保留的岗位授权');
    expect(result.after).toEqual(target);
  });
  it('目标管理员更高权限不降级；模板与调用方数组不会共享可变对象', () => {
    const source = accountPermissionTemplate(person()), target = accountPermissionTemplate(person({ role:'admin',building:null,buildings:undefined }));
    const result = previewPermissionInheritance(source,target);
    expect(result.after.role).toBe('admin'); expect(result.removedPages).toEqual([]);
    result.after.pagePaths.push('/synthetic-mutation'); expect(target.pagePaths).not.toContain('/synthetic-mutation');
  });
});
describe('在途职责筛选不改写历史或重放业务', () => {
  it('已完成历史排除，批准后待执行保留执行阶段，外部未知写入必须先对账', () => {
    const result = pendingHandoverSelection([entry(),entry({ key:'purchase:exec',module:'purchase',phase:'execution',stageKey:'approved-execution' }),entry({ key:'finished',status:'terminal' }),entry({ key:'unknown',phase:'reconcile',status:'in_progress' })]);
    expect(result.pending.map(item=>item.key)).toEqual(['leave:synthetic-record:supervisor','purchase:exec']);
    expect(result.excluded).toContainEqual({ key:'finished',reason:'已办结历史保持' });
    expect(result.conflicts).toContain('unknown：外部执行结果尚未确认，需先对账');
  });
  it('相同待办重复键或无版本明确报冲突，不能悄悄去重或丢弃', () => {
    expect(pendingHandoverSelection([entry(),entry()]).conflicts).toContain('待办身份重复');
    expect(pendingHandoverSelection([entry({ version:'' })]).conflicts).toContain('待办版本缺失');
  });
});
