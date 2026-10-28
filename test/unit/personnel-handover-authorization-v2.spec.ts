import { accountPermissionTemplate, copyAccountPermissionTemplate, previewPermissionInheritance } from '../../server/common/access/personnel-handover.preview';
import { handoverAuthorizationGrants, mergeHandoverAuthorization, uniqueAuthorizationGrants } from '../../server/common/access/personnel-handover.authorization';
import { capturePersonnelPermission, validPersonnelPermissionArchives } from '../../server/common/access/personnel-permission-archive';
import { permissionTemplateFingerprint } from '../../server/common/access/personnel-handover.baseline';
import { canPerformBusinessAction } from '../../shared/business-permissions';
import type { AccountPermissionTemplate } from '../../shared/personnel-handover.interface';
import type { EffectiveAuthorization, AuthorizationGrantSnapshot } from '../../shared/authorization-profile';
import type { ManagedAccount } from '../../shared/access-configuration.interface';

const profile=(id='source'):EffectiveAuthorization=>({mode:'independent',baseline:{nativeRole:null,pages:['/operations-kb'],rules:[{id:`${id}-read`,module:'knowledge',actions:['read'],effect:'allow',buildings:null,specialties:null},
  {id:`${id}-deny-update`,module:'knowledge',actions:['update'],effect:'deny',buildings:null,specialties:null}]},
  overrides:{rules:[{id:`${id}-allow-update`,module:'knowledge',actions:['update'],effect:'allow',buildings:null,specialties:null}],allowPages:[],denyPages:[]}});
const template=(effective=profile()):AccountPermissionTemplate=>({role:'guest',building:null,pagePaths:['/operations-kb'],sourceVersion:3,effectiveAuthorization:effective,personalRules:effective.overrides.rules});
const principal=(value:AccountPermissionTemplate)=>({role:value.role,purchaseBuilding:value.building,buildings:value.buildings,specialties:value.specialties,personalRules:value.personalRules,effectiveAuthorization:value.effectiveAuthorization});

describe('V2 personnel handover preserves frozen authorization layers',()=>{
  it('archives both baseline and personal exceptions and binds the full snapshot fingerprint',()=>{
    const account:ManagedAccount={id:'feishu-synthetic',kind:'feishu',name:'合成来源',role:'guest',building:null,enabled:true,deleted:false,version:3,source:'configuration',appId:'cli_synthetic',effectiveAuthorization:profile()};
    const archive=capturePersonnelPermission(account,undefined,4)!;
    expect(archive.template.effectiveAuthorization).toEqual(profile());expect(validPersonnelPermissionArchives({[account.id]:archive})).toBe(true);
    const changed=copyAccountPermissionTemplate(archive.template);changed.effectiveAuthorization!.baseline.rules=[];
    expect(permissionTemplateFingerprint(changed)).not.toBe(permissionTemplateFingerprint(archive.template));
    expect(accountPermissionTemplate(account).effectiveAuthorization).toEqual(profile());
  });
  it('a full transfer to an empty account becomes independent without losing allow-over-baseline-deny',()=>{
    const source=template();const before:AccountPermissionTemplate={role:'guest',building:null,pagePaths:[],sourceVersion:8};
    const result=previewPermissionInheritance(source,before);
    expect(result.conflicts).toEqual([]);expect(result.after.sourceVersion).toBe(8);expect(result.after.effectiveAuthorization).toEqual(profile());
    expect(canPerformBusinessAction(principal(result.after),{module:'knowledge',action:'update'})).toBe(true);
  });
  it('retains two separate snapshots without merging a source deny into the receiver exceptions',()=>{
    const target=profile('target');target.baseline.rules=[{id:'target-delete',module:'knowledge',actions:['delete'],effect:'allow',buildings:null,specialties:null}];target.overrides.rules=[];
    const result=previewPermissionInheritance(template(),template(target));expect(result.conflicts).toEqual([]);
    for(const action of ['read','update','delete'] as const)expect(canPerformBusinessAction(principal(result.after),{module:'knowledge',action})).toBe(true);
    expect(result.after.effectiveAuthorization!.baseline.grantSnapshots).toHaveLength(1);
    expect(result.after.effectiveAuthorization!.overrides.rules).toEqual([]);
  });
  it('a repeated handover preserves later overriding layers and deduplicates identical snapshots',()=>{
    const source=profile();const child:AuthorizationGrantSnapshot={baseline:{nativeRole:null,pages:['/operations-kb'],rules:[]},overrides:{rules:[{id:'inner-deny',effect:'deny',module:'knowledge',actions:['update'],buildings:null,specialties:null}],allowPages:[],denyPages:[]},scope:{building:null}};
    source.baseline.grantSnapshots=[child];const grants=handoverAuthorizationGrants(template(source));
    const inherited=grants.find(item=>item.overrides.rules[0]?.id==='inner-deny')!;expect(inherited.overrideLayers).toEqual([source.overrides]);
    const target=template({mode:'independent',baseline:{nativeRole:null,pages:[],rules:[{id:'target-read',effect:'allow',module:'knowledge',actions:['read'],buildings:null,specialties:null}]},overrides:{rules:[],allowPages:[],denyPages:[]}});
    const first=mergeHandoverAuthorization(template(source),target,false),second=mergeHandoverAuthorization(template(source),first,false);
    expect(second.effectiveAuthorization!.baseline.grantSnapshots).toEqual(first.effectiveAuthorization!.baseline.grantSnapshots);
    expect(canPerformBusinessAction(principal(second),{module:'knowledge',action:'update'})).toBe(true);
  });
  it('rejects overflow and nested/admin grants without mutating the source',()=>{
    const original=handoverAuthorizationGrants(template())[0],before=JSON.stringify(original);
    const nine=Array.from({length:9},(_,index)=>({...structuredClone(original),baseline:{...structuredClone(original.baseline),rules:[{...original.baseline.rules[0],id:`distinct-${index}`}]}}));
    expect(()=>uniqueAuthorizationGrants(nine)).toThrow('超过8份');
    expect(()=>uniqueAuthorizationGrants([{...original,baseline:{...original.baseline,nativeRole:'admin'}}])).toThrow();
    expect(()=>uniqueAuthorizationGrants([{...original,baseline:{...original.baseline,grantSnapshots:[]} } as never])).toThrow();
    expect(JSON.stringify(original)).toBe(before);
  });
});
