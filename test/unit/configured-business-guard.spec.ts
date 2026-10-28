import {Reflector} from '@nestjs/core';
import {UnifiedAccessGuard} from '../../server/common/access/unified-access.guard';
import {ProfessionalScoped} from '../../server/common/access/unified-access.decorators';
import type {AccessPrincipal} from '../../shared/access-control.interface';
import type {BusinessAction,BusinessModule,PersonalPermissionRule} from '../../shared/business-permissions';
import {canManageProfessionalRecord} from '../../shared/professional-access';
import {createBusinessPermissionEvaluator} from '../../shared/business-permissions';

class Endpoint {handle(){}}
ProfessionalScoped()(Endpoint.prototype,'handle',Object.getOwnPropertyDescriptor(Endpoint.prototype,'handle')!);
const rule=(module:BusinessModule,actions:BusinessAction[],building:'A楼'|'B楼'|null=null):PersonalPermissionRule=>({id:`${module}-${actions.join('-')}-${building?.slice(0,1)||'all'}`,module,actions,effect:'allow',buildings:building?[building]:null,specialties:null});
const actor=(rules:PersonalPermissionRule[]):AccessPrincipal=>({role:'guest',purchaseBuilding:null,accountId:'local-synthetic-person',authorizationVersion:1,effectiveAuthorization:{mode:'independent',baseline:{nativeRole:null,pages:[],rules},overrides:{rules:[],allowPages:[],denyPages:[]}}});
function checkedRequest(principal:AccessPrincipal,path:string,method='GET'){
  const guard=new UnifiedAccessGuard(new Reflector(),{cookieName:'synthetic',isAccessControlEnabled:()=>true,renew:()=>({principal,principalFingerprint:'synthetic'}),pagePermissions:()=>({paths:[],configured:true})} as never);
  const req:{method:string;originalUrl:string;url:string;query:object;headers:object;accessPrincipal?:AccessPrincipal}={method,originalUrl:path,url:path,query:{},headers:{}};
  const allowed=guard.canActivate({getClass:()=>Endpoint,getHandler:()=>Endpoint.prototype.handle,switchToHttp:()=>({getRequest:()=>req,getResponse:()=>({once:jest.fn()})})} as never);
  return {allowed,principal:req.accessPrincipal!};
}
function request(principal:AccessPrincipal,path:string,method='GET'){return checkedRequest(principal,path,method).allowed;}
describe('configured business guard direct API checks',()=>{
  it('blocks unknown APIs and fixed administrator APIs even with business grants',()=>{
    const principal=actor([rule('purchase',['read','create','delete','approve'])]);
    expect(request(principal,'/api/access/configuration/accounts','POST')).toBe(false);
    expect(request(principal,'/api/purchase-inventory/new-write','POST')).toBe(false);
    expect(request(principal,'/api/bitable/table-fields')).toBe(false);
  });
  it('create-only can load its application selector without list read',()=>{
    const principal=actor([rule('purchase',['create'])]);
    expect(request(principal,'/api/purchase-inventory/application-options')).toBe(true);
    expect(request(principal,'/api/purchase-inventory/dashboard')).toBe(false);
    expect(request(principal,'/api/purchase-inventory/records/recSynthetic','PATCH')).toBe(false);
  });
  it('confirm-only inventory can use shared choices without receiving create',()=>{
    const principal=actor([rule('inventory',['confirm'])]);
    expect(request(principal,'/api/inventory-management/movement-options')).toBe(true);
    expect(request(principal,'/api/inventory-management/movements','POST')).toBe(false);
  });
  it('upsert entry accepts one candidate but never an unrelated read grant',()=>{
    expect(request(actor([rule('schedule_assignments',['create'])]),'/api/duty-schedules/emergency-duty','POST')).toBe(true);
    expect(request(actor([rule('schedule_assignments',['read'])]),'/api/duty-schedules/emergency-duty','POST')).toBe(false);
  });
  it('basic application personnel dependency never opens private profiles',()=>{
    const principal=actor([rule('leave_requests',['create'])]);
    expect(request(principal,'/api/bitable/person-profiles')).toBe(true);
    expect(request(principal,'/api/bitable/person-profiles?forceRefresh=true')).toBe(false);
    expect(request(principal,'/api/bitable/person-profile-details')).toBe(false);
  });
  it('read and refresh require a common record scope, not independent somewhere grants',()=>{
    const principal=actor([rule('equipment_ledger',['read'],'A楼'),rule('equipment_ledger',['refresh'],'B楼')]);
    const checked=checkedRequest(principal,'/api/equipment-ledger/dashboard?refresh=true');
    expect(checked.allowed).toBe(true);
    expect(canManageProfessionalRecord(checked.principal,'电气','A楼')).toBe(false);
    expect(canManageProfessionalRecord(checked.principal,'电气','B楼')).toBe(false);
    expect(principal.permissionContext).toBeUndefined();
    expect(principal.permissionRequirements).toBeUndefined();
  });
  it('a personal deny still prevents the request even when the template grants it',()=>{
    const principal=actor([rule('certification',['notify'])]);
    principal.effectiveAuthorization!.overrides.rules=[{...rule('certification',['notify']),id:'deny-notify',effect:'deny'}];
    expect(request(principal,'/api/bitable/campus-certificate-dashboard/notify-expiring','POST')).toBe(false);
  });
  it('compiled previews freeze one policy snapshot and do not cache later authorizations',()=>{
    const principal=actor([rule('knowledge',['read'])]),before=createBusinessPermissionEvaluator(principal);
    principal.effectiveAuthorization!.baseline.rules=[];
    expect(before({module:'knowledge',action:'read'}).allowed).toBe(true);
    expect(createBusinessPermissionEvaluator(principal)({module:'knowledge',action:'read'}).allowed).toBe(false);
  });
  it('accepts the real UI context shape without cloning login callbacks',()=>{
    const principal={...actor([rule('knowledge',['read'])]),login:async()=>true,logout:async()=>true,requestLogin:()=>{}};
    expect(createBusinessPermissionEvaluator(principal)({module:'knowledge',action:'read'}).allowed).toBe(true);
  });
  it('V1 professional principals cannot use forced refresh to evade a read deny',()=>{
    const principal:AccessPrincipal={role:'professional_engineer',purchaseBuilding:'A楼',buildings:['A楼'],specialties:['电气'],personalRules:[{...rule('inventory',['read']),effect:'deny'}]};
    expect(request(principal,'/api/inventory-management/dashboard?refresh=1')).toBe(false);
  });
  it('purchase active polling remains read, but an additional explicit force flag still needs refresh',()=>{
    const principal=actor([rule('purchase',['read'])]);
    expect(request(principal,'/api/purchase-inventory/dashboard?refresh=active')).toBe(true);
    expect(request(principal,'/api/purchase-inventory/dashboard?refresh=active&forceRefresh=true')).toBe(false);
  });
});
