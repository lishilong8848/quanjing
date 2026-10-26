import { createHash, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { UnifiedAccessService } from '../../server/common/access/unified-access.service';
import { FeishuAccessService } from '../../server/common/access/feishu-access.service';
import { UnifiedAccessController } from '../../server/common/access/unified-access.controller';
import { createAccessPasswordHash } from '../../server/common/access/access-password';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import type { ConfigurationDirectorySnapshot } from '../../server/common/access/access-configuration.directory';
import { buildExternalEmployeeCredentials } from '../../server/common/access/external-employee-directory';
import { effectivePagePaths } from '../../shared/page-access';
import { BUSINESS_PERMISSION_CATALOG } from '../../shared/business-permissions';
import { LeaveWorkflowStore } from '../../server/modules/leave-workflow/leave-workflow.store';
import { LeaveWorkflowService } from '../../server/modules/leave-workflow/leave-workflow.service';

const appId='cli_retirement_synthetic', openId='ou_retirement_synthetic';
const identity=feishuIdentityFingerprint(appId,openId), personnelId=`local-external-${createHash('sha256').update(JSON.stringify([appId,'synthetic-base','tblSynthetic','recPwdFixture'])).digest('hex')}`;
const account:stores.StoredAccount={id:`feishu-${identity}`,kind:'feishu',appId,openId,identityHash:identity,name:'合成在职人员',role:'site_member',building:null,version:3,enabled:true,deleted:false,source:'configuration',permissionSource:'personnel',siteMember:true,personnelIdentity:personnelId};
function directory(active=true):ConfigurationDirectorySnapshot {
  return {appId,people:[],employees:[{name:account.name,openId,position:'设施示例人员001',specialties:'C楼',inactive:!active}],snapshotAt:Date.now(),personnelComplete:true,
    activeMembers:active?[{name:account.name,openId,passwordAccountId:personnelId}]:[],
    ...{ employmentState:{complete:true,entries:[{personnelIdentity:personnelId,openId,inactive:!active}]} } };
}
describe('人员状态与基础成员资格分开判定',()=>{
  let root:string, temporaryRoot:string, owner:string, store:stores.AccessConfigurationStore, service:AccessConfigurationService, access:UnifiedAccessService;
  let saved:Record<string,string|undefined>;
  beforeEach(async()=>{
    saved=Object.fromEntries(['FEISHU_APP_ID','FEISHU_APP_SECRET','LOCAL_ACCESS_SESSION_SECRET','LOCAL_ACCESS_CONTROL_ENABLED'].map(key=>[key,process.env[key]]));
    process.env.FEISHU_APP_ID=appId; process.env.FEISHU_APP_SECRET='synthetic-retirement-only'; process.env.LOCAL_ACCESS_SESSION_SECRET=randomBytes(32).toString('base64'); process.env.LOCAL_ACCESS_CONTROL_ENABLED='true';
    temporaryRoot=realpathSync(tmpdir()); root=mkdtempSync(join(temporaryRoot,'nt-retirement-sync-')); owner=randomUUID(); writeFileSync(join(root,'.test-owner'),owner,{flag:'wx'});
    store=new stores.AccessConfigurationStore(join(root,'configuration.json')); jest.spyOn(stores,'getAccessConfigurationStore').mockReturnValue(store); jest.spyOn(defaults,'defaultAccessAccounts').mockReturnValue({});
    await store.mutate(0,'synthetic-retirement-seed','synthetic-seed',state=>{
      state.accounts[account.id]={...account};
      state.accounts[personnelId]={id:personnelId,kind:'local',name:account.name,role:'site_member',building:null,version:3,enabled:true,deleted:false,source:'configuration',permissionSource:'personnel',siteMember:true,personnelIdentity:personnelId,loginMethod:'personnel-password',personnelAppId:appId,personnelActive:true};
    });
    await store.mutate(1,'synthetic-password-seed','synthetic-password',async state=>{state.accounts[personnelId].passwordHash=await createAccessPasswordHash('synthetic-retirement-only');});
    service=new AccessConfigurationService(); access=new UnifiedAccessService(service);
  });
  afterEach(()=>{
    jest.restoreAllMocks(); for(const [key,value] of Object.entries(saved)) { if(value===undefined) delete process.env[key]; else process.env[key]=value; }
    const canonical=(value:string)=>resolve(value).toLowerCase();
    if(!isAbsolute(root)||canonical(dirname(root))!==canonical(temporaryRoot)||!/^nt-retirement-sync-[A-Za-z0-9]+$/u.test(basename(root))||!existsSync(root)||lstatSync(root).isSymbolicLink()||!lstatSync(root).isDirectory()||canonical(realpathSync(root))!==canonical(root)) throw new Error('离职同步测试目录归属异常，已保留');
    for(const name of readdirSync(root)) { const item=lstatSync(join(root,name)); if(!item.isFile()||item.isSymbolicLink()) throw new Error('离职同步测试目录异常，已保留'); }
    if(readFileSync(join(root,'.test-owner'),'utf8')!==owner) throw new Error('离职同步测试目录所有权异常，已保留');
    rmSync(root,{recursive:true,force:false});
  });
  it('主表仍在职但完整成员视图移出：双身份变游客、保留登录姓名及链接，不授予成员页面',async()=>{
    const old=access.issueTrustedSession(service.feishuPrincipal(openId,appId)!);
    const next=directory(); next.activeMembers=[]; await service.synchronizePersonnel(next);
    expect(access.readSession(old.token).expiresAt).toBeNull();
    const principal=service.feishuPrincipal(openId,appId)!;
    expect(principal).toMatchObject({role:'guest',displayName:account.name});
    const signed=access.issueTrustedSession(principal); expect(access.readSession(signed.token).principal).toEqual(signed.principal);
    expect((await access.login({employeeName:account.name,password:'synthetic-retirement-only'},'synthetic')).principal.role).toBe('guest');
    expect(service.snapshot().accounts.every(item=>item.personnelIdentity===personnelId)).toBe(true);
  });
  it('勾选收回手工管理员权限：旧会话失效，两种登录都只取得实名游客',async()=>{
    await store.mutate(store.read().revision,'synthetic-manual-admin','synthetic-admin',state=>{for(const value of Object.values(state.accounts)){value.role='admin';value.permissionSource='manual';}});
    const feishu=access.issueTrustedSession(service.feishuPrincipal(openId,appId)!);
    const local=await access.login({employeeName:account.name,password:'synthetic-retirement-only'},'synthetic');
    await service.synchronizePersonnel(directory(false));
    expect(service.feishuPrincipal(openId,appId)).toMatchObject({role:'guest',displayName:account.name});
    expect(service.employeeTargets(account.name)[0]?.principal).toMatchObject({role:'guest',displayName:account.name});
    expect(access.readSession(feishu.token).expiresAt).toBeNull(); expect(access.readSession(local.token).expiresAt).toBeNull();
    const guest=await access.login({employeeName:account.name,password:'synthetic-retirement-only'},'synthetic-revoked');
    expect(guest.principal).toMatchObject({role:'guest',displayName:account.name});
    expect(access.readSession(guest.token).principal).toEqual(guest.principal);
    const config={FEISHU_APP_ID:appId,FEISHU_APP_SECRET:'synthetic-only',PUBLIC_BASE_URL:'https://fixture.example.test'};
    const oauth=new FeishuAccessService({get:(key:keyof typeof config)=>config[key]} as never,{axiosRef:{post:jest.fn().mockResolvedValue({data:{code:0,access_token:'synthetic-only'}}),get:jest.fn().mockResolvedValue({data:{code:0,data:{open_id:openId,name:account.name}}})}} as never,service);
    await expect(oauth.exchangeAuthorizationCode('synthetic-code')).resolves.toMatchObject({role:'guest',displayName:account.name});
  });
  it('主表状态证据不完整不按部分inactive记录撤权，原配置原字节保留',async()=>{
    const before=readFileSync(store.filePath,'utf8'); const incomplete=directory(false);
    Object.assign(incomplete,{employmentState:{complete:false,entries:[]}});
    await expect(service.synchronizePersonnel(incomplete)).rejects.toThrow('人员状态快照不完整');
    expect(readFileSync(store.filePath,'utf8')).toBe(before);
  });
  it('实际姓名凭据适配保留PBKDF2密码，勾选同步后可实名游客登录并使旧成员会话失效',async()=>{
    const salt=randomBytes(16),password='synthetic-retirement-only';
    const encoded=`pbkdf2_sha256$600000$${salt.toString('base64')}$${pbkdf2Sync(password,salt,600000,32,'sha256').toString('base64')}`;
    const credentials=await buildExternalEmployeeCredentials([{record_id:'recPwdFixture',fields:{姓名:account.name,密码:encoded,'离职/异动情况':true}}],appId,'synthetic-base','tblSynthetic');
    expect(credentials[0]).toMatchObject({id:personnelId,active:true});
    const old=await access.login({employeeName:account.name,password},'synthetic-before-check');
    await service.synchronizePersonnel({...directory(false),externalEmployees:credentials});
    expect(access.readSession(old.token).expiresAt).toBeNull();
    const guest=await access.login({employeeName:account.name,password},'synthetic-after-check');
    expect(guest.principal).toMatchObject({role:'guest',displayName:account.name});
    expect(access.readSession(guest.token).principal).toEqual(guest.principal);
  });
  it('收回权限后的实名游客不携带原个人规则或个人页面增补',async()=>{
    await store.mutate(store.read().revision,'synthetic-extra-pages','synthetic-extra',state=>{
      for(const current of Object.values(state.accounts)) {
        current.role='guest';current.pagePaths=['/operations-kb'];
        current.personalRules=[{id:'synthetic-rule',module:BUSINESS_PERMISSION_CATALOG[0].id,effect:'allow',actions:['read'],buildings:null,specialties:null}];
      }
    });
    await service.synchronizePersonnel(directory(false));
    const principal=service.feishuPrincipal(openId,appId)!;
    expect(principal.personalRules).toBeUndefined();
    expect(service.pagePermissions('guest',principal.accountId,principal.authorizationVersion).paths).toEqual(effectivePagePaths('guest'));
    const guest=access.issueTrustedSession(principal);
    expect(access.readSession(guest.token).principal.personalRules).toBeUndefined();
  });
  it('实际收回状态仍可游客登录，但不能通过原请休假卡片办理新审批',async()=>{
    const leaveFile=join(root,'leave-ledger.json'),leaveStore=new LeaveWorkflowStore(leaveFile,leaveFile);
    const actor={name:account.name,openId,position:'设施示例人员001',buildings:['C楼']};
    await leaveStore.acceptApplication({clientMutationId:'synthetic-revoke-leave',recordId:'recRevokeLeave',snapshot:{applicantName:'合成申请人',applicantOpenId:'ou_synthetic_applicant',building:'C楼',position:'运维值班员',leaveType:'年假',startAt:'2026-10-13T09:00:00+08:00',endAt:'2026-10-13T18:00:00+08:00',leaveHours:8,approvalDayCount:1,reason:'合成验收'}});
    const snapshot=(await leaveStore.getApplication('recRevokeLeave'))!.snapshot;
    await leaveStore.setApprovalPlan('recRevokeLeave',{snapshot,approvalPlan:{approvalClass:'ordinary',discipline:null,approvalDayCount:1,stages:[{key:'supervisor',approvers:[actor],resolutionPolicy:'first_legal_action'}],notificationPlan:{finalResultRecipients:[actor],professionalRecipients:[],substituteRecipients:[]}},resultRecipients:[actor]});
    await leaveStore.setPendingStage('recRevokeLeave',{key:'supervisor',version:1,approverOpenIds:[openId]});
    await service.synchronizePersonnel(directory(false));
    const gateway={updateLeaveRecord:jest.fn()},before=readFileSync(leaveFile,'utf8');
    const workflow=new LeaveWorkflowService(leaveStore,gateway as never,{} as never,undefined,service);
    await expect(workflow.acceptApprovalAction({eventId:'synthetic-revoked-action',recordId:'recRevokeLeave',stageKey:'supervisor',stageVersion:1,actorOpenId:openId,actorName:account.name,messageId:'om_synthetic_revoke',action:'reject',rejectionReason:'合成验收'})).rejects.toThrow('当前人员不可办理');
    expect(readFileSync(leaveFile,'utf8')).toBe(before);expect(gateway.updateLeaveRecord).not.toHaveBeenCalled();
    const guest=await access.login({employeeName:account.name,password:'synthetic-retirement-only'},'synthetic-revoked-card');
    expect(guest.principal).toMatchObject({role:'guest',displayName:account.name});
  });
  it('配置只展示派生的收回状态，不能用启用原角色绕过，也不能伪造展示标记',async()=>{
    await backupActor();
    await service.synchronizePersonnel(directory(false));
    const actor=service.feishuPrincipal('ou_synthetic_backup',appId)!;
    expect(service.snapshot().accounts.find(item=>item.id===account.id)).toMatchObject({enabled:false,permissionsRevoked:true,guestLoginAllowed:true});
    const body={clientMutationId:'synthetic-reenable-revoked',expectedRevision:store.read().revision,id:account.id,kind:'feishu' as const,name:account.name,role:'admin' as const,building:null,openId,enabled:true};
    await service.saveAccount(body,actor);
    expect(service.feishuPrincipal(openId,appId)?.role).toBe('guest');
    const before=readFileSync(store.filePath,'utf8');
    await expect(service.saveAccount({...body,expectedRevision:store.read().revision,permissionsRevoked:false} as never,actor)).rejects.toThrow();
    expect(readFileSync(store.filePath,'utf8')).toBe(before);
  });
  it('已收回权限的人不能被计入最后一个可用管理员',async()=>{
    await backupActor();await service.synchronizePersonnel(directory(false));
    const actor=service.feishuPrincipal('ou_synthetic_backup',appId)!;
    await service.saveAccount({clientMutationId:'synthetic-count-revoked',expectedRevision:store.read().revision,id:account.id,kind:'feishu',name:account.name,role:'admin',building:null,openId,enabled:true},actor);
    const before=readFileSync(store.filePath,'utf8');
    await expect(service.saveAccount({clientMutationId:'synthetic-last-admin',expectedRevision:store.read().revision,id:actor.accountId,kind:'feishu',name:actor.displayName!,role:'admin',building:null,openId:'ou_synthetic_backup',enabled:false},actor)).rejects.toThrow('必须保留至少一个可用管理员');
    expect(readFileSync(store.filePath,'utf8')).toBe(before);
  });
  it('勾选不收回游客读取，但必须阻断其原业务卡片办理',async()=>{
    const unknown='ou_synthetic_unknown';
    const signed=access.issueTrustedSession({role:'guest',purchaseBuilding:null,feishuAppId:appId,accountId:`feishu-${feishuIdentityFingerprint(appId,unknown)}`,displayName:'合成未知访客'});
    const other=access.issueTrustedSession({role:'guest',purchaseBuilding:null,feishuAppId:appId,accountId:`feishu-${feishuIdentityFingerprint(appId,'ou_synthetic_other')}`,displayName:'合成其他访客'});
    const snapshot=directory(); Object.assign(snapshot,{employmentState:{complete:true,entries:[{personnelIdentity:personnelId,openId,inactive:false},{personnelIdentity:`local-external-${'2'.repeat(64)}`,openId:unknown,inactive:true}]}});
    await service.synchronizePersonnel(snapshot);
    expect(access.readSession(signed.token).principal).toMatchObject({role:'guest',displayName:'合成未知访客'});
    expect(access.renew(signed.token)?.principal.role).toBe('guest');
    expect((service as unknown as {canUseFeishuBusinessIdentity:(id:string,app:string)=>boolean}).canUseFeishuBusinessIdentity(`feishu-${feishuIdentityFingerprint(appId,unknown)}`,appId)).toBe(false);
    expect(access.readSession(other.token).principal).toMatchObject({role:'guest',displayName:'合成其他访客'}); expect(access.readSession(other.token).expiresAt).not.toBeNull();
  });
  it('系统按离职停用的两身份在完整复岗后恢复，保留同一人员链接',async()=>{
    await service.synchronizePersonnel(directory(false)); await service.synchronizePersonnel(directory(true));
    for(const current of service.snapshot().accounts) expect(current).toMatchObject({enabled:true,role:'site_member',personnelIdentity:personnelId});
    expect(service.feishuPrincipal(openId,appId)?.role).toBe('site_member'); expect(service.employeeTargets(account.name)).toHaveLength(1);
  });
  it('已启用的在职成员及手工楼栋示例人员001能完成实际OAuth回调、签发并读取实名会话',async()=>{
    await service.synchronizePersonnel(directory(true));
    for(const role of ['site_member','building_admin'] as const){
      await store.mutate(store.read().revision,`synthetic-enabled-${role}`,'synthetic-enabled',state=>{const current=state.accounts[account.id];current.role=role;current.building=role==='building_admin'?'C楼':null;current.permissionSource=role==='building_admin'?'manual':'personnel';current.version++;});
      const config={FEISHU_APP_ID:appId,FEISHU_APP_SECRET:'synthetic-only',PUBLIC_BASE_URL:'https://fixture.example.test'};
      const oauth=new FeishuAccessService({get:(key:keyof typeof config)=>config[key]} as never,{axiosRef:{post:jest.fn().mockResolvedValue({data:{code:0,access_token:'synthetic-only'}}),get:jest.fn().mockResolvedValue({data:{code:0,data:{open_id:openId,name:account.name}}})}} as never,service);
      const controller=new UnifiedAccessController(access,oauth),response={setHeader:jest.fn(),cookie:jest.fn(),clearCookie:jest.fn(),redirect:jest.fn()};
      const request={headers:{cookie:'vnet_feishu_oauth_state=synthetic-state-1234567890123456; vnet_feishu_oauth_return_to=%2Fnantong-base'},socket:{}};
      await controller.feishuCallback({state:'synthetic-state-1234567890123456',code:'synthetic-code'},request as never,response as never);
      expect(response.redirect).toHaveBeenCalledWith(302,'/nantong-base?feishu_auth=success');
      const token=response.cookie.mock.calls.find(([name])=>name===access.cookieName)?.[1];
      expect(access.readSession(token).principal).toMatchObject({role,displayName:account.name,accountId:account.id});
    }
  });
  async function backupActor() {
    const backupIdentity=feishuIdentityFingerprint(appId,'ou_synthetic_backup'); const id=`feishu-${backupIdentity}`;
    await store.mutate(store.read().revision,`synthetic-backup-${randomUUID()}`,'synthetic-backup',state=>{
      state.accounts[id]={id,kind:'feishu',appId,openId:'ou_synthetic_backup',identityHash:backupIdentity,name:'合成配置管理员',role:'admin',building:null,version:1,enabled:true,deleted:false,source:'configuration',permissionSource:'manual'};
    });
    return {role:'admin' as const,purchaseBuilding:null,accountId:id,authorizationVersion:1,displayName:'合成配置管理员'};
  }
  it('可选密码目录未返回时保留旧凭据，有效在职双身份从游客获得基地成员权限', async () => {
    await store.mutate(store.read().revision,'synthetic-directory-isolation','synthetic-directory-isolation',state => {
      for (const id of [account.id,personnelId]) { state.accounts[id].role='guest'; state.accounts[id].siteMember=false; }
    });
    const before=store.read().accounts[personnelId].passwordHash;
    const snapshot=directory(true); snapshot.externalEmployees=undefined; snapshot.personnelWarnings=['姓名登录资料暂时无法同步，原有登录资料保留'];
    await service.synchronizePersonnel(snapshot);
    expect(store.read().accounts[personnelId].passwordHash).toBe(before);
    expect(service.feishuPrincipal(openId,appId)).toMatchObject({ role:'site_member',displayName:account.name });
    expect((await access.login({ employeeName:account.name,password:'synthetic-retirement-only' },'synthetic')).principal).toMatchObject({ role:'site_member',displayName:account.name });
    expect(service.snapshot().personnelSync?.warning).toContain('原有登录资料保留');
  });
  it('先被管理员手工停用的姓名身份不会因离职再复岗而自动启用',async()=>{
    const actor=await backupActor();
    await service.saveAccount({clientMutationId:'synthetic-manual-disabled',expectedRevision:store.read().revision,id:personnelId,kind:'local',name:account.name,role:'site_member',building:null,enabled:false},actor);
    await service.synchronizePersonnel(directory(false)); await service.synchronizePersonnel(directory(true));
    expect(service.snapshot().accounts.find(item=>item.id===personnelId)?.enabled).toBe(false); expect(service.employeeTargets(account.name)).toEqual([]);
  });
  it.each(['local','feishu'] as const)('系统停用期间再手工停用%s身份，复岗也不能覆盖管理员决定',async kind=>{
    await backupActor(); await service.synchronizePersonnel(directory(false));
    const actor=service.feishuPrincipal('ou_synthetic_backup',appId)!;
    const id=kind==='local'?personnelId:account.id;
    await service.saveAccount({clientMutationId:`synthetic-disable-${kind}`,expectedRevision:store.read().revision,id,kind,name:account.name,role:'guest',building:null,enabled:false,...(kind==='feishu'?{openId}:{})},actor);
    await service.synchronizePersonnel(directory(true));
    expect(service.snapshot().accounts.find(item=>item.id===id)?.enabled).toBe(false);
    if(kind==='feishu') expect(service.feishuPrincipal(openId,appId)).toBeNull(); else expect(service.employeeTargets(account.name)).toEqual([]);
  });
});
