import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { UnifiedAccessService, hashAccessPassword } from '../../server/common/access/unified-access.service';
import { FeishuAccessService } from '../../server/common/access/feishu-access.service';
import { assertFeishuBusinessIdentity } from '../../server/common/access/feishu-business-identity';
import { LeaveWorkflowStore } from '../../server/modules/leave-workflow/leave-workflow.store';
import { LeaveWorkflowService } from '../../server/modules/leave-workflow/leave-workflow.service';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import type { AccountMutation } from '../../shared/access-configuration.interface';
import type { AuthorizationRoleMutation, AuthorizationOverrides, AuthorizationPolicy } from '../../shared/authorization-profile';
import { detachAuthorization } from '../../shared/authorization-profile';

describe('authorization profiles V2 durable configuration', () => {
  const appId='cli_profiles_synthetic', openId='ou_profiles_synthetic', otherOpenId='ou_profiles_other';
  const accountId=`feishu-${feishuIdentityFingerprint(appId,openId)}`, otherId=`feishu-${feishuIdentityFingerprint(appId,otherOpenId)}`;
  let root:string, owner:string, store:stores.AccessConfigurationStore, service:AccessConfigurationService, access:UnifiedAccessService;
  let saved:Record<string,string|undefined>, actor:ReturnType<AccessConfigurationService['localTargets']>[number]['principal'];
  const overrides=():AuthorizationOverrides=>({rules:[],allowPages:[],denyPages:[]});
  const policy=():AuthorizationPolicy=>({nativeRole:null,pages:['/operations-kb'],rules:[{id:'role-read',module:'knowledge',actions:['read'],effect:'allow',buildings:null,specialties:null}]});
  const roleRequest=(extra:Partial<AuthorizationRoleMutation>={}):AuthorizationRoleMutation=>({clientMutationId:`synthetic-role-${randomUUID()}`,expectedRevision:store.read().revision,name:'合成只读角色',description:'隔离验收',enabled:true,policy:policy(),...extra});
  const accountRequest=(id=accountId,extra:Partial<AccountMutation>={}):AccountMutation=>{
    const account=service.snapshot().accounts.find(item=>item.id===id)!;
    return {clientMutationId:`synthetic-account-${randomUUID()}`,expectedRevision:store.read().revision,id,kind:account.kind,name:account.name,role:account.role,building:account.building,enabled:account.enabled,...extra};
  };
  beforeEach(()=>{
    saved=Object.fromEntries(['FEISHU_APP_ID','FEISHU_APP_SECRET','LOCAL_ACCESS_SESSION_SECRET','LOCAL_ACCESS_CONTROL_ENABLED','LEAVE_WORKFLOW_PROGRAM_ENABLED'].map(key=>[key,process.env[key]]));
    process.env.FEISHU_APP_ID=appId;process.env.FEISHU_APP_SECRET='synthetic-only';process.env.LOCAL_ACCESS_SESSION_SECRET=randomBytes(32).toString('base64');process.env.LOCAL_ACCESS_CONTROL_ENABLED='true';
    process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED='true';
    root=mkdtempSync(join(realpathSync(tmpdir()),'nt-profile-v2-'));owner=randomUUID();writeFileSync(join(root,'.owner'),owner,{flag:'wx'});
    store=new stores.AccessConfigurationStore(join(root,'configuration.json'));jest.spyOn(stores,'getAccessConfigurationStore').mockReturnValue(store);
    const native:Record<string,stores.StoredAccount>={
      'local-admin-all':{id:'local-admin-all',kind:'local',name:'合成管理员',role:'admin',building:null,enabled:true,deleted:false,version:1,source:'default',passwordHash:hashAccessPassword('synthetic-profile-admin')},
    };
    for(const [id,oid] of [[accountId,openId],[otherId,otherOpenId]]) native[id]={id,kind:'feishu',name:id===accountId?'合成人员甲':'合成人员乙',role:'editor',building:null,enabled:true,deleted:false,version:1,source:'default',appId,openId:oid,identityHash:feishuIdentityFingerprint(appId,oid),permissionSource:'manual'};
    jest.spyOn(defaults,'defaultAccessAccounts').mockReturnValue(native);
    service=new AccessConfigurationService();access=new UnifiedAccessService(service);actor=service.localTargets()[0].principal;
  });
  afterEach(()=>{
    jest.restoreAllMocks();for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    if(resolve(dirname(root)).toLowerCase()!==resolve(realpathSync(tmpdir())).toLowerCase() || readFileSync(join(root,'.owner'),'utf8')!==owner)throw new Error('fixture ownership mismatch');
    rmSync(root,{recursive:true,force:false});
  });
  async function createRole(){const request=roleRequest();await service.saveAuthorizationRole(request,actor);return service.authorizationRoles().roles.find(item=>!item.builtin)!;}
  async function follow(templateId:string,id=accountId,personal=overrides()){
    return service.saveAccount(accountRequest(id,{authorizationBinding:{mode:'follow',templateId},authorizationOverrides:personal}),actor);
  }
  it('GET and previews never persist; first mutation backs up exact V1 and materializes defaults',async()=>{
    expect(service.snapshot().schemaVersion).toBe(1);service.authorizationRoles();service.effectiveAuthorization(accountId);service.previewAuthorizationRole(roleRequest());
    expect(existsSync(store.filePath)).toBe(false);
    const before=JSON.stringify(store.read());await createRole();const state=store.read();
    expect(state.schemaVersion).toBe(2);expect(Object.keys(state.accounts)).toHaveLength(3);
    expect(readFileSync(state.authorizationMigration!.backupFile,'utf8')).toBe(before);
    expect(createHash('sha256').update(before).digest('hex')).toBe(state.authorizationMigration!.backupSha256);
    expect(store.inspectAuthorizationRollback().allowed).toBe(false);
  });
  it('startup keeps V1 intact; an explicit unchanged migration alone may be rolled back',async()=>{
    await service.onModuleInit();expect(store.read().schemaVersion).toBe(1);expect(existsSync(store.filePath)).toBe(false);
    expect(service.previewAuthorizationMigration()).toMatchObject({requiresMigration:true,accountCount:3});
    const request={clientMutationId:'synthetic-explicit-migration',expectedRevision:0};
    await service.migrateAuthorizationConfiguration(request,actor);const first=store.read();expect(first.schemaVersion).toBe(2);
    expect(store.inspectAuthorizationRollback().allowed).toBe(true);
    await service.migrateAuthorizationConfiguration(request,actor);await service.onModuleInit();expect(store.read()).toEqual(first);
    await createRole();expect(store.inspectAuthorizationRollback()).toMatchObject({allowed:false});
  });
  it('default password rotation preserves V2 policy, revokes old sessions, and never re-enables a missing credential',async()=>{
    await createRole();const old=access.issueTrustedSession(service.localTargets()[0].principal);
    const current=jest.mocked(defaults.defaultAccessAccounts).mock.results[0].value as Record<string,stores.StoredAccount>;
    const originalPolicy=store.read().accounts['local-admin-all'].effectiveAuthorization;
    current['local-admin-all'].passwordHash=hashAccessPassword('synthetic-rotated-password');
    const rotated=new AccessConfigurationService(),rotatedAccess=new UnifiedAccessService(rotated);
    await rotated.onModuleInit();expect(rotatedAccess.renew(old.token)).toBeNull();
    expect(rotated.localTargets()[0].hash).toBe(current['local-admin-all'].passwordHash);
    expect(store.read().accounts['local-admin-all'].effectiveAuthorization).toEqual(originalPolicy);
    current['local-admin-all'].enabled=false;current['local-admin-all'].passwordHash='';await new AccessConfigurationService().onModuleInit();
    expect(store.read().accounts['local-admin-all'].enabled).toBe(false);
    current['local-admin-all'].enabled=true;current['local-admin-all'].passwordHash=hashAccessPassword('synthetic-restored-password');
    const restored=new AccessConfigurationService();await restored.onModuleInit();expect(restored.localTargets()).toEqual([]);
  });
  it('a shared password account keeps its original entry while an empty independent policy stays guest',async()=>{
    const current=jest.mocked(defaults.defaultAccessAccounts).mock.results[0].value as Record<string,stores.StoredAccount>;
    current['local-editor-all']={id:'local-editor-all',kind:'local',name:'合成共享入口',role:'editor',building:null,enabled:true,deleted:false,version:1,source:'default',passwordHash:hashAccessPassword('synthetic-editor-login')};
    await createRole();await service.saveAccount(accountRequest('local-editor-all',{authorizationBinding:{mode:'independent',policy:{nativeRole:null,pages:[],rules:[]}},authorizationOverrides:overrides()}),actor);
    const target=service.localTargets().find(item=>item.principal.accountId==='local-editor-all')!;
    expect(target).toMatchObject({credentialRole:'editor',credentialBuilding:null,principal:{role:'guest',accountId:'local-editor-all'}});
    const login=await access.login({password:'synthetic-editor-login',accountType:'editor'},'synthetic-shared');
    expect(login.principal.role).toBe('guest');expect(access.renew(login.token)?.principal.role).toBe('guest');
    expect(login.principal.effectiveAuthorization?.baseline).toEqual({nativeRole:null,pages:[],rules:[]});
  });
  it('following updates atomically revoke affected sessions, keep personal overrides, and leave independent accounts alone',async()=>{
    const role=await createRole();const personal={...overrides(),rules:[{id:'personal-update',module:'knowledge' as const,actions:['update' as const],effect:'allow' as const,buildings:null,specialties:null}]};
    await follow(role.id,accountId,personal);await follow(role.id,otherId);
    const independent=detachAuthorization(service.effectiveAuthorization(otherId).after);
    await service.saveAccount(accountRequest(otherId,independent),actor);
    const token=access.issueTrustedSession(service.feishuPrincipal(openId,appId)!);const before=store.read();
    const request=roleRequest({id:role.id,policy:{...policy(),pages:[],rules:[]}});await service.saveAuthorizationRole(request,actor);
    const after=store.read();expect(after.accounts[accountId].version).toBe(before.accounts[accountId].version+1);
    expect(after.accounts[accountId].authorizationOverrides).toEqual(personal);expect(after.accounts[otherId]).toEqual(before.accounts[otherId]);
    expect(access.renew(token.token)).toBeNull();
    await service.saveAuthorizationRole(request,actor);expect(store.read()).toEqual(after);
  });
  it('role rename refreshes display metadata without changing follower authorization versions',async()=>{
    const role=await createRole();await follow(role.id);const before=store.read().accounts[accountId];
    await service.saveAuthorizationRole(roleRequest({id:role.id,name:'合成新名称'}),actor);
    const after=store.read().accounts[accountId];expect(after.version).toBe(before.version);
    expect(after.effectiveAuthorization!.templateVersion).toBeGreaterThan(before.effectiveAuthorization!.templateVersion!);
    expect(after.effectiveAuthorization!.baseline).toEqual(before.effectiveAuthorization!.baseline);
  });
  it('stop-assignment does not remove followers; referenced and built-in roles cannot be deleted',async()=>{
    const role=await createRole();await follow(role.id);
    await service.saveAuthorizationRole(roleRequest({id:role.id,enabled:false}),actor);
    await expect(follow(role.id,otherId)).rejects.toThrow('停止新增分配');
    await expect(follow(role.id)).resolves.toBeDefined();
    await expect(service.saveAuthorizationRole(roleRequest({id:role.id,enabled:false,deleted:true}),actor)).rejects.toThrow('仍被账号引用');
    const builtin=service.authorizationRoles().roles.find(item=>item.id==='builtin-editor')!;
    await expect(service.saveAuthorizationRole(roleRequest({id:builtin.id,name:builtin.name,description:builtin.description,policy:builtin.policy,deleted:true}),actor)).rejects.toThrow('内置角色不能删除');
  });
  it('custom templates cannot import an implicit native administrator identity',async()=>{
    await expect(service.saveAuthorizationRole(roleRequest({policy:{...policy(),nativeRole:'admin'}}),actor)).rejects.toThrow();
    expect(existsSync(store.filePath)).toBe(false);
  });
  it('stale saves fail without partial role or account updates',async()=>{
    const role=await createRole();const stale=roleRequest({id:role.id});await follow(role.id);const before=readFileSync(store.filePath);
    await expect(service.saveAuthorizationRole(stale,actor)).rejects.toThrow('配置已更新');expect(readFileSync(store.filePath)).toEqual(before);
  });
  it('departure blocks old and fresh identities; confirmed return still needs administrator reactivation',async()=>{
    await createRole();const old=access.issueTrustedSession(service.feishuPrincipal(openId,appId)!);
    const snapshot=(inactive:boolean)=>({appId,people:[],snapshotAt:Date.now(),personnelComplete:true,employees:[{openId,name:'合成人员甲',position:'设施主管',specialties:'电气',inactive}]});
    await service.synchronizePersonnel(snapshot(true));expect(service.feishuPrincipal(openId,appId)).toBeNull();
    expect(service.canUseFeishuGuestIdentity(accountId,appId)).toBe(false);expect(service.canUseFeishuBusinessIdentity(accountId,appId)).toBe(false);expect(access.renew(old.token)).toBeNull();
    await service.synchronizePersonnel(snapshot(false));expect(service.feishuPrincipal(openId,appId)).toBeNull();
    await expect(service.saveAccount(accountRequest(accountId,{enabled:true}),actor)).rejects.toThrow('管理员明确确认');
    await service.saveAccount(accountRequest(accountId,{enabled:true,confirmReactivation:true}),actor);
    expect(service.feishuPrincipal(openId,appId)?.role).toBe('editor');expect(service.canUseFeishuGuestIdentity(accountId,appId)).toBe(true);
  });
  it('unconfigured identities cannot return through legacy OAuth guest fallback after departure',async()=>{
    const unknown='ou_profiles_unknown',id=`feishu-${feishuIdentityFingerprint(appId,unknown)}`;
    const old=access.issueTrustedSession({role:'guest',purchaseBuilding:null,feishuAppId:appId,accountId:id,displayName:'合成未知人员'});
    const values:Record<string,string>={FEISHU_APP_ID:appId,FEISHU_APP_SECRET:'synthetic-only',FEISHU_ACCESS_APPROVED_GRANTS_ENABLED:'false',PUBLIC_BASE_URL:'https://fixture.example.test'};
    const http={axiosRef:{post:jest.fn().mockResolvedValue({data:{code:0,access_token:'synthetic-token'}}),get:jest.fn().mockResolvedValue({data:{code:0,data:{open_id:unknown,name:'合成未知人员'}}})}};
    const oauth=new FeishuAccessService({get:(key:string)=>values[key]} as never,http as never,service);
    await expect(oauth.exchangeAuthorizationCode('synthetic-before')).resolves.toMatchObject({role:'guest',accountId:id});
    const snapshot=(inactive:boolean)=>({appId,people:[],snapshotAt:Date.now(),personnelComplete:true,employees:[{openId:unknown,name:'合成未知人员',position:'',specialties:'',inactive}]});
    await service.synchronizePersonnel(snapshot(true));expect(service.canUseFeishuGuestIdentity(id,appId)).toBe(false);
    expect(access.renew(old.token)).toBeNull();await expect(oauth.exchangeAuthorizationCode('synthetic-retired')).rejects.toMatchObject({code:'identity_inactive'});
    await service.synchronizePersonnel(snapshot(false));expect(service.canUseFeishuGuestIdentity(id,appId)).toBe(false);
    await expect(oauth.exchangeAuthorizationCode('synthetic-returned')).rejects.toMatchObject({code:'identity_inactive'});
  });
  it('name-password and mapped Feishu logins both fail after departure and require explicit reactivation',async()=>{
    const personnelId=`local-external-${'a'.repeat(64)}`,passwordHash=hashAccessPassword('synthetic-person-password');
    const snapshot=(inactive:boolean)=>({appId,people:[],snapshotAt:Date.now(),personnelComplete:true,employees:[{openId,name:'合成人员甲',position:'设施主管',specialties:'电气',inactive}],
      externalEmployees:[{id:personnelId,name:'合成人员甲',passwordHash,active:true}],activeMembers:inactive?[]:[{name:'合成人员甲',openId,passwordAccountId:personnelId}],
      employmentState:{complete:true,entries:[{personnelIdentity:personnelId,openId,inactive}]}});
    await service.synchronizePersonnel(snapshot(false));const old=await access.login({employeeName:'合成人员甲',password:'synthetic-person-password'},'synthetic-person-before');
    const values:Record<string,string>={FEISHU_APP_ID:appId,FEISHU_APP_SECRET:'synthetic-only',FEISHU_ACCESS_APPROVED_GRANTS_ENABLED:'false',PUBLIC_BASE_URL:'https://fixture.example.test'};
    const oauth=new FeishuAccessService({get:(key:string)=>values[key]} as never,{axiosRef:{post:jest.fn().mockResolvedValue({data:{code:0,access_token:'synthetic-token'}}),get:jest.fn().mockResolvedValue({data:{code:0,data:{open_id:openId,name:'合成人员甲'}}})}} as never,service);
    await service.synchronizePersonnel(snapshot(true));expect(access.renew(old.token)).toBeNull();
    await expect(access.login({employeeName:'合成人员甲',password:'synthetic-person-password'},'synthetic-person-retired')).rejects.toThrow();
    await expect(oauth.exchangeAuthorizationCode('synthetic-mapped-retired')).rejects.toMatchObject({code:'identity_inactive'});
    await service.synchronizePersonnel(snapshot(false));await expect(access.login({employeeName:'合成人员甲',password:'synthetic-person-password'},'synthetic-person-returned')).rejects.toThrow();
    await service.saveAccount(accountRequest(accountId,{enabled:true,confirmReactivation:true}),actor);
    await expect(access.login({employeeName:'合成人员甲',password:'synthetic-person-password'},'synthetic-person-confirmed')).resolves.toMatchObject({principal:{accountId:personnelId}});
    await expect(oauth.exchangeAuthorizationCode('synthetic-mapped-confirmed')).resolves.toMatchObject({accountId});
  });
  it('departure blocks the actual callback entry before any new approval or external write',async()=>{
    await service.synchronizePersonnel({appId,people:[],snapshotAt:Date.now(),personnelComplete:true,employees:[{openId,name:'合成人员甲',position:'设施主管',specialties:'电气',inactive:true}]});
    expect(()=>assertFeishuBusinessIdentity(service,openId)).toThrow('当前人员不可办理');
    const path=join(root,'leave-ledger.json'),leaveStore=new LeaveWorkflowStore(path,path);
    await leaveStore.acceptApplication({clientMutationId:'synthetic-retirement-callback',recordId:'recRetirementCallback',snapshot:{applicantName:'合成申请人',applicantOpenId:'ou_synthetic_applicant',building:'C楼',position:'运维值班员',leaveType:'年假',startAt:'2026-10-28T09:00:00+08:00',endAt:'2026-10-28T18:00:00+08:00',leaveHours:8,approvalDayCount:1,reason:'合成验证'}});
    const before=readFileSync(path),gateway={updateLeaveRecord:jest.fn()};
    const workflow=new LeaveWorkflowService(leaveStore,gateway as never,{} as never,undefined,service);
    await expect(workflow.acceptApprovalAction({eventId:'synthetic-blocked-event',recordId:'recRetirementCallback',stageKey:'supervisor',stageVersion:1,actorOpenId:openId,actorName:'合成人员甲',messageId:'om_synthetic_retired',action:'reject',rejectionReason:'合成验证'})).rejects.toThrow('当前人员不可办理');
    expect(readFileSync(path)).toEqual(before);expect(gateway.updateLeaveRecord).not.toHaveBeenCalled();
  });
  it('manual template assignments survive personnel role synchronization',async()=>{
    const role=await createRole();await follow(role.id);
    await service.synchronizePersonnel({appId,people:[],snapshotAt:Date.now(),personnelComplete:true,employees:[{openId,name:'合成人员甲',position:'电气工程师',specialties:'电气',inactive:false}],activeMembers:[{name:'合成人员甲',openId,passwordAccountId:`local-external-${'a'.repeat(64)}`,engineerScope:{buildings:['B楼'],specialties:['电气']}}]});
    expect(store.read().accounts[accountId]).toMatchObject({role:'guest',authorizationBinding:{mode:'follow',templateId:role.id},permissionSource:'manual'});
  });
  it('editing exceptions alone marks an existing personnel-derived role as manual',async()=>{
    const current=jest.mocked(defaults.defaultAccessAccounts).mock.results[0].value as Record<string,stores.StoredAccount>;
    current[accountId].permissionSource='personnel';
    await createRole();
    const personal={...overrides(),rules:[{id:'personal-deny',module:'knowledge' as const,actions:['read' as const],effect:'deny' as const,buildings:null,specialties:null}]};
    await follow('builtin-editor',accountId,personal);
    expect(store.read().accounts[accountId]).toMatchObject({role:'editor',permissionSource:'manual',authorizationOverrides:personal});
    await service.synchronizePersonnel({appId,people:[],snapshotAt:Date.now(),personnelComplete:true,employees:[{openId,name:'合成人员甲',position:'电气工程师',specialties:'电气',inactive:false}],activeMembers:[{name:'合成人员甲',openId,passwordAccountId:`local-external-${'a'.repeat(64)}`,engineerScope:{buildings:['B楼'],specialties:['电气']}}]});
    expect(store.read().accounts[accountId]).toMatchObject({role:'editor',permissionSource:'manual',authorizationOverrides:personal});
  });
});
