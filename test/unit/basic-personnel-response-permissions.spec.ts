import {BitableSyncController} from '../../server/modules/bitable-sync/bitable-sync.controller';
import type {AccessPrincipal} from '../../shared/access-control.interface';
const actor=(privateAccess=false):AccessPrincipal=>({role:'guest',purchaseBuilding:null,accountId:'local-synthetic',effectiveAuthorization:{mode:'independent',baseline:{nativeRole:null,pages:[],rules:privateAccess?[{id:'private',module:'personnel_profile',actions:['read'],effect:'allow',buildings:null,specialties:null}]:[]},overrides:{rules:[],allowPages:[],denyPages:[]}}});
describe('basic personnel selectors keep private details behind separate grants',()=>{
  const profile={supervisorText:'合成人员',position:'合成岗位',buildingsSpecialties:['A楼'],shift:'白',phone:'synthetic-private-phone',photoUrl:'private-photo',openId:'ou_synthetic_private'};
  const person={id:'recSynthetic',appName:'合成人员',position:'合成岗位',buildingProfessional:['A楼'],shift:'白',phone:'synthetic-private-phone',photoUrl:'private-photo',email:'private@example.invalid'};
  function controller(){return Object.assign(Object.create(BitableSyncController.prototype),{bitableSyncService:{getPersonProfiles:jest.fn().mockResolvedValue({organizations:[profile],changeRequestSubmitters:['合成人员']}),getDutyStaff:jest.fn().mockResolvedValue({staff:[{building:'A楼',shifts:[{shift:'白',leader:person,staff:person}]}]})}}) as BitableSyncController;}
  it('public/application people selectors whitelist basic fields even if the source returns extra details',async()=>{
    const value=await controller().getPersonProfiles(undefined,'leave');
    expect(value.organizations[0]).toEqual({supervisorText:'合成人员',position:'合成岗位',buildingsSpecialties:['A楼'],shift:'白'});
    expect(JSON.stringify(value)).not.toMatch(/synthetic-private|private-photo|ou_synthetic/);
  });
  it('a basic dependency grant does not return private duty-staff contact fields',async()=>{
    const value=await controller().getDutyStaff({accessPrincipal:actor()} as never);
    expect(value.staff[0].shifts[0].leader?.appName).toBe('合成人员');
    expect(JSON.stringify(value)).not.toMatch(/synthetic-private|private-photo|private@example/);
  });
  it('the separate private grant preserves the existing private response',async()=>{
    const value=await controller().getDutyStaff({accessPrincipal:actor(true)} as never);
    expect(value.staff[0].shifts[0].leader).toEqual(person);
  });
});
