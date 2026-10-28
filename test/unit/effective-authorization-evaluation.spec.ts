import { decideBusinessPermission, personalPermissionPagePaths, validEffectiveAuthorization, businessModulesForPage } from '../../shared/business-permissions';
import type { PersonalPermissionRule, BusinessPermissionTarget } from '../../shared/business-permissions';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { AuthorizationGrantSnapshot, AuthorizationOverrides, EffectiveAuthorization } from '../../shared/authorization-profile';

const empty=():AuthorizationOverrides=>({rules:[],allowPages:[],denyPages:[]});
const rule=(id:string,effect:'allow'|'deny',building:'A楼'|'B楼'|null=null):PersonalPermissionRule=>({id,effect,module:'purchase',actions:['read','update'],buildings:building?[building]:null,specialties:null});
const profile=():EffectiveAuthorization=>({mode:'independent',baseline:{nativeRole:null,pages:[],rules:[]},overrides:empty()});
const principal=(policy=profile()):AccessPrincipal=>({role:'guest',purchaseBuilding:null,accountId:'synthetic-evaluation',effectiveAuthorization:policy});
const target=(building='A楼'):BusinessPermissionTarget=>({module:'purchase',action:'update',building,specialty:'电气'});
const grant=(rules:PersonalPermissionRule[]):AuthorizationGrantSnapshot=>({baseline:{nativeRole:null,pages:[],rules},overrides:empty(),scope:{building:null}});

describe('effective policy precedence and isolated handover sources',()=>{
  it('independent empty policy denies native-role capabilities and all business pages',()=>{
    const actor={...principal(),role:'editor' as const};
    expect(decideBusinessPermission(actor,target()).allowed).toBe(false);
    expect(personalPermissionPagePaths(actor,['/purchase-inventory-management'])).toEqual([]);
  });
  it('personal deny wins in the same layer; personal allow can override template deny',()=>{
    const policy=profile();policy.baseline.rules=[rule('base-deny','deny')];policy.overrides.rules=[rule('allow','allow','A楼')];
    expect(decideBusinessPermission(principal(policy),target()).allowed).toBe(true);
    policy.overrides.rules.push(rule('deny','deny','A楼'));
    expect(decideBusinessPermission(principal(policy),target())).toEqual({allowed:false,source:'deny'});
  });
  it('a cross-building grant does not authorize another module or a mixed record',()=>{
    const policy=profile();policy.overrides.rules=[rule('allow-b','allow','B楼')];
    expect(decideBusinessPermission(principal(policy),target('B楼')).allowed).toBe(true);
    expect(decideBusinessPermission(principal(policy),target('A楼、B楼')).allowed).toBe(false);
    expect(decideBusinessPermission(principal(policy),{...target('B楼'),module:'inventory'}).allowed).toBe(false);
  });
  it('union of independent sources retains each source scope, with final personal deny',()=>{
    const policy=profile();policy.baseline.grantSnapshots=[grant([rule('a','allow','A楼')]),grant([rule('b','allow','B楼')])];
    expect(decideBusinessPermission(principal(policy),target('A楼、B楼')).allowed).toBe(true);
    policy.overrides.rules=[rule('block-b','deny','B楼')];
    expect(decideBusinessPermission(principal(policy),target('A楼、B楼')).allowed).toBe(false);
    expect(decideBusinessPermission(principal(policy),target('A楼')).allowed).toBe(true);
  });
  it('a denial in one source never erases a separate valid source',()=>{
    const policy=profile();policy.baseline.grantSnapshots=[grant([rule('a','deny','A楼')]),grant([rule('a2','allow','A楼')])];
    expect(decideBusinessPermission(principal(policy),target()).allowed).toBe(true);
  });
  it('adding a scoped source cannot remove a separate full grant when a record specialty is missing',()=>{
    const policy=profile();policy.baseline.rules=[rule('all','allow')];
    const point={module:'purchase' as const,action:'read' as const,building:'A楼'};
    expect(decideBusinessPermission(principal(policy),point).allowed).toBe(true);
    policy.baseline.grantSnapshots=[grant([{...rule('specific','allow','A楼'),specialties:['电气']}])];
    expect(decideBusinessPermission(principal(policy),point).allowed).toBe(true);
    policy.overrides.rules=[{...rule('restrict','deny','A楼'),specialties:['电气']}];
    expect(decideBusinessPermission(principal(policy),point).allowed).toBe(false);
  });
  it('later handover layers override earlier layers without flattening scope',()=>{
    const source=grant([rule('original','allow')]);source.overrides.rules=[rule('earlier','deny','A楼')];
    source.overrideLayers=[{...empty(),rules:[rule('latest','allow','A楼')]}];
    const policy=profile();policy.baseline.grantSnapshots=[source];
    expect(decideBusinessPermission(principal(policy),target()).allowed).toBe(true);
    source.overrideLayers[0].rules.push(rule('latest-deny','deny','A楼'));
    expect(decideBusinessPermission(principal(policy),target()).allowed).toBe(false);
  });
  it('native-role snapshot uses the originating building and specialty',()=>{
    const policy=profile();policy.baseline.grantSnapshots=[{baseline:{nativeRole:'professional_engineer',pages:['/purchase-inventory-management'],rules:[]},overrides:empty(),scope:{building:'A楼',buildings:['A楼'],specialties:['电气']}}];
    expect(decideBusinessPermission(principal(policy),target()).allowed).toBe(true);
    expect(decideBusinessPermission(principal(policy),target('B楼')).allowed).toBe(false);
    expect(decideBusinessPermission(principal(policy),{...target(),specialty:'暖通'}).allowed).toBe(false);
  });
  it('page visibility never grants scoped records to an independent empty policy',()=>{
    const policy=profile();policy.overrides.allowPages=['/purchase-inventory-management'];
    expect(decideBusinessPermission(principal(policy),{...target(),action:'read'}).allowed).toBe(false);
    expect(personalPermissionPagePaths(principal(policy),[])).toEqual([]);
  });
  it('shared template rules respect each member scope while a personal exception can extend one module',()=>{
    const policy=profile();policy.baseline={nativeRole:'professional_engineer',pages:[],rules:[rule('template-all','allow')]};
    const actor={...principal(policy),role:'professional_engineer' as const,purchaseBuilding:'A楼' as const,buildings:['A楼' as const],specialties:['电气' as const]};
    expect(decideBusinessPermission(actor,target()).allowed).toBe(true);
    expect(decideBusinessPermission(actor,target('B楼')).allowed).toBe(false);
    expect(decideBusinessPermission(actor,{...target(),specialty:'暖通'}).allowed).toBe(false);
    policy.overrides.rules=[rule('personal-b','allow','B楼')];
    expect(decideBusinessPermission(actor,target('B楼')).allowed).toBe(true);
    expect(decideBusinessPermission(actor,{...target('B楼'),module:'inventory'}).allowed).toBe(false);
  });
  it('allowing submission does not grant read or parent-page listing data',()=>{
    const policy=profile();policy.overrides.rules=[{...rule('submit','allow'),module:'leave_requests',actions:['create']}];
    expect(decideBusinessPermission(principal(policy),{module:'leave_requests',action:'create'}).allowed).toBe(true);
    expect(decideBusinessPermission(principal(policy),{module:'leave_requests',action:'read'}).allowed).toBe(false);
    expect(personalPermissionPagePaths(principal(policy),[])).not.toContain('/monthly-schedule');
  });
  it('static page grants remain usable without granting a business data scope',()=>{
    const policy=profile();policy.baseline.pages=['/exhaust-valve-map','/nantong-base'];
    expect(personalPermissionPagePaths(principal(policy),[])).toEqual(expect.arrayContaining(policy.baseline.pages));
  });
  it('rejects nested, excess or administrator handover grants without partial allowance',()=>{
    const policy=profile();const source=grant([rule('allow','allow')]);policy.baseline.grantSnapshots=Array.from({length:9},()=>source);
    expect(validEffectiveAuthorization(policy)).toBe(false);
    policy.baseline.grantSnapshots=[{...source,baseline:{...source.baseline,nativeRole:'admin'}}];
    expect(decideBusinessPermission(principal(policy),target()).allowed).toBe(false);
    policy.baseline.grantSnapshots=[{...source,baseline:{...source.baseline,grantSnapshots:[]} as never}];
    expect(validEffectiveAuthorization(policy)).toBe(false);
  });
  it('parent pages include all independently authorized submodules',()=>{
    expect(businessModulesForPage('/inventory-management')).toEqual(['inventory','stocktake']);
    expect(businessModulesForPage('/training-certification-management')).toEqual(['training','certification']);
  });
});
