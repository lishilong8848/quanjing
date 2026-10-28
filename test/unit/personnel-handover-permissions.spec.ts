import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { PersonnelHandoverStore, handoverItemMutationId } from '../../server/common/access/personnel-handover.store';
import { buildHandoverAuthoritySnapshot, PersonnelHandoverAuthority } from '../../server/common/access/personnel-handover.authority';
import { handoverFingerprint } from '../../server/common/access/personnel-handover.baseline';
import { capturePersonnelPermission } from '../../server/common/access/personnel-permission-archive';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { createAccessPasswordHash } from '../../server/common/access/access-password';
import { accountPermissionTemplate, previewPermissionInheritance } from '../../server/common/access/personnel-handover.preview';
import type { ConfigurationDirectorySnapshot } from '../../server/common/access/access-configuration.directory';
import type { AuthorityPerson } from '../../shared/personnel-authority.interface';
import type { HandoverBatch } from '../../shared/personnel-handover.interface';
import { handoverPermissionGrantKeys } from '../../server/common/access/personnel-handover.ownership';
import { canPerformBusinessAction } from '../../shared/business-permissions';

const appId='cli_handover_transaction_fixture';
describe('实际配置交接事务',()=>{
  let root:string, folder:string, owner:string, file:string, store:stores.AccessConfigurationStore, service:AccessConfigurationService, batch:HandoverBatch;
  let from:AuthorityPerson, to:AuthorityPerson, source:stores.StoredAccount, target:stores.StoredAccount, originalApp:string|undefined;
  let directory:ConfigurationDirectorySnapshot;
  beforeEach(async()=>{
    originalApp=process.env.FEISHU_APP_ID;process.env.FEISHU_APP_ID=appId;
    root=realpathSync(tmpdir());folder=mkdtempSync(join(root,'nt-handover-permissions-'));owner=randomUUID();writeFileSync(join(folder,'.test-owner'),owner,{flag:'wx'});file=join(folder,'configuration.json');
    store=new stores.AccessConfigurationStore(file);jest.spyOn(stores,'getAccessConfigurationStore').mockReturnValue(store);jest.spyOn(defaults,'defaultAccessAccounts').mockReturnValue({});
    from={id:'local-external-'+ 'a'.repeat(64),recordId:'recOld',name:'合成前任',openId:'ou_old',active:false,type:'employee',position:'C楼主管',systemPosition:'',buildings:['C楼'],specialties:[],permissionTags:[],dutyRecordIds:[]};
    to={...from,id:'local-external-'+ 'b'.repeat(64),recordId:'recNew',name:'合成接任',openId:'ou_new',active:true};
    const account=(person:AuthorityPerson):stores.StoredAccount=>({id:'feishu-'+feishuIdentityFingerprint(appId,person.openId!),kind:'feishu',appId,name:person.name,openId:person.openId,role:'site_member',building:null,version:1,enabled:true,deleted:false,source:'configuration',personnelIdentity:person.id,identityHash:feishuIdentityFingerprint(appId,person.openId!)});
    source={...account(from),role:'building_admin',building:'C楼',buildings:['C楼']};target=account(to);
    await store.mutate(0,'seed-handover-permissions','seed',state=>{
      state.accounts[source.id]={...source,version:2,enabled:false,personnelSuspended:true};state.accounts[target.id]=target;
      state.personnelPermissionArchives={[source.id]:capturePersonnelPermission(source,undefined,0)!};
      state.personnelEmployment={appId,snapshotAt:Date.now(),inactive:{[source.id]:true,[from.id]:true,[target.id]:false,[to.id]:false}};
    });
    service=new AccessConfigurationService();
    directory={appId,people:[],employees:[],snapshotAt:Date.now(),personnelComplete:true,employmentState:{complete:true,entries:[{personnelIdentity:from.id,openId:from.openId,inactive:true},{personnelIdentity:to.id,openId:to.openId,inactive:false}]},personnelAuthority:{mode:'shadow',version:'c'.repeat(64),snapshotAt:Date.now(),source:{appId,appToken:'fixture',tableId:'tblPeople'},people:[from,to],duties:[{recordId:'recDuty',name:'C楼请休假主管',kind:'leave_supervisor',personnelIds:[to.id],buildings:['C楼'],specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1}],problems:[],issues:[]}};
    const {content}=buildHandoverAuthoritySnapshot(directory,service.snapshot(),service.permissionArchives(),{fromPersonId:from.id,toPersonId:to.id,dutyRecordIds:['recDuty'],mode:'offboarding'});
    batch=await new PersonnelHandoverStore(join(folder,'handover.json')).accept(0,{clientMutationId:'synthetic-confirm-001',actorId:'local-fixture-admin',actorName:'合成管理员',preview:{...content,fingerprint:handoverFingerprint(content),createdAt:new Date().toISOString()}});
  });
  afterEach(()=>{
    jest.restoreAllMocks();if(originalApp===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=originalApp;
    const canonical=(value:string)=>resolve(value).toLowerCase();
    if(canonical(dirname(folder))!==canonical(root)||!/^nt-handover-permissions-[A-Za-z0-9]+$/.test(basename(folder))||canonical(realpathSync(folder))!==canonical(folder)||lstatSync(folder).isSymbolicLink()||readFileSync(join(folder,'.test-owner'),'utf8')!==owner)throw new Error('测试目录归属异常，已保留');
    for(const name of readdirSync(folder)){const info=lstatSync(join(folder,name));if(!info.isFile()||info.isSymbolicLink())throw new Error('测试目录异常，已保留');}
    rmSync(folder,{recursive:true,force:false});
  });
  const apply=(service:AccessConfigurationService,batch:HandoverBatch,mutation=handoverItemMutationId(batch.id,'permissions'))=>service.applyPersonnelHandoverPermissions(batch,mutation);
  it('已受理批次按选定职责恢复，其他人员资料更新不阻断；重新确认仍核全局版本',async()=>{
    const authority=new PersonnelHandoverAuthority(service,{read:async()=>structuredClone(directory)});
    directory.personnelAuthority!.version='d'.repeat(64);
    await expect(authority.restoreContext(batch.preview,batch)).resolves.toMatchObject({from:{id:from.id},to:{id:to.id}});
    await expect(authority.restoreContext(batch.preview)).rejects.toThrow('人员职责已变化');
  });
  it('未人工递增任职版本也不能改变已确认职责的楼栋范围',async()=>{
    const authority=new PersonnelHandoverAuthority(service,{read:async()=>structuredClone(directory)});
    directory.personnelAuthority!.duties[0].buildings=['A楼'];
    await expect(authority.restoreContext(batch.preview,batch)).rejects.toThrow('人员职责已变化');
  });
  async function acceptCurrentPreview(preview=structuredClone(batch.preview)){
    preview.baseline.configurationRevision=store.read().revision;preview.fingerprint=handoverFingerprint(preview);
    batch=await new PersonnelHandoverStore(join(folder,'current-handover.json')).accept(0,{clientMutationId:'synthetic-confirm-current',actorId:batch.actorId,actorName:batch.actorName,preview});
  }
  it('岗位归属与账号权限同一事务落盘，重启原mutation不重复变更',async()=>{
    expect(batch.preview.dutyRouting).toHaveLength(1);
    const beforeRevision=store.read().revision;
    await apply(service,batch);
    const state=store.read();expect(state.revision).toBe(beforeRevision+1);
    expect(state.personnelDutyAssignments?.recDuty).toMatchObject({appId,dutyRecordId:'recDuty',kind:'leave_supervisor',buildings:['C楼'],confirmedBatchId:batch.id,members:[{personId:to.id,recordId:to.recordId,openId:to.openId,name:to.name}]});
    expect(state.accounts[target.id].role).toBe('building_admin');
    const bytes=readFileSync(file,'utf8');await apply(new AccessConfigurationService(),batch);expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it('轮岗同一事务转交C楼默认权限，保留前任H楼额外任职；原mutation和实际authority可恢复',async()=>{
    from.active=true;directory.employmentState!.entries[0].inactive=false;
    await store.mutate(store.read().revision,'fixture-active-rotation','active-rotation',state=>{
      const account=state.accounts[source.id];account.enabled=true;delete account.personnelSuspended;account.personalRules=[{id:'other-H-duty',effect:'allow',module:'inventory',actions:['read','confirm'],buildings:['H楼'],specialties:null}];
      state.personnelEmployment!.inactive[source.id]=false;state.personnelEmployment!.inactive[from.id]=false;
    });
    const original=accountPermissionTemplate(service.snapshot().accounts.find(account=>account.id===source.id)!);
    const ownership=[{sourceAccountId:source.id,grants:handoverPermissionGrantKeys(original).map(key=>({key,disposition:key==='rule:other-H-duty'?'retain' as const:'transfer' as const,...(key==='rule:other-H-duty'?{}:{dutyRecordId:'recDuty'})}))}];
    const {content}=buildHandoverAuthoritySnapshot(directory,service.snapshot(),service.permissionArchives(),{fromPersonId:from.id,toPersonId:to.id,dutyRecordIds:['recDuty'],mode:'rotation',ownership});
    await acceptCurrentPreview({...content,fingerprint:handoverFingerprint(content),createdAt:new Date().toISOString()});
    await apply(service,batch);
    const state=store.read(),retained=state.accounts[source.id],transferred=state.accounts[target.id];
    expect(retained.role).toBe('site_member');expect(retained.personalRules?.map(rule=>rule.id)).toContain('other-H-duty');expect(transferred.role).toBe('building_admin');expect(transferred.personalRules?.map(rule=>rule.id)||[]).not.toContain('other-H-duty');
    expect(canPerformBusinessAction({role:retained.role,purchaseBuilding:retained.building,personalRules:retained.personalRules},{module:'inventory',action:'confirm',building:'H楼',specialty:'电气'})).toBe(true);
    expect(accountPermissionTemplate(service.snapshot().accounts.find(account=>account.id===target.id)!)).toEqual({...batch.preview.permissions[0].after,sourceVersion:target.version+1});
    const bytes=readFileSync(file,'utf8');await authority().applyPermissions(batch,handoverItemMutationId(batch.id,'permissions'));expect(readFileSync(file,'utf8')).toBe(bytes);expect((await authority().restoreContext(batch.preview,batch)).from.active).toBe(true);
  });
  it('仅继承权限，保留接任身份；离职前任禁止登录，审计不含凭证',async()=>{
    const before=store.read();await apply(service,batch);const after=store.read();
    expect(after.accounts[target.id]).toMatchObject({...target,role:'building_admin',building:'C楼',buildings:['C楼'],version:2,permissionSource:'manual'});
    expect(after.accounts[source.id]).toEqual(before.accounts[source.id]);expect(after.personnelEmployment).toEqual(before.personnelEmployment);
    expect(service.snapshot().accounts.find(a=>a.id===source.id)).toMatchObject({permissionsRevoked:true,guestLoginAllowed:false});
    expect(service.feishuPrincipal(from.openId!,appId)).toBeNull();
    expect(after.audit).toHaveLength(1);expect(JSON.stringify(after.audit)).not.toMatch(/passwordHash|appToken/);
  });
  it('轮岗前任的姓名登录没有同类接任账号时，仍与飞书同步保留其他任职权限',async()=>{
    from.active=true;directory.employmentState!.entries[0].inactive=false;
    const passwordHash=await createAccessPasswordHash('synthetic-rotation-fixture-only');
    await store.mutate(store.read().revision,'fixture-dual-source-rotation','seed',state=>{
      const account=state.accounts[source.id];account.enabled=true;delete account.personnelSuspended;
      account.personalRules=[{id:'retain-H-duty',effect:'allow',module:'inventory',actions:['read','confirm'],buildings:['H楼'],specialties:null}];
      state.accounts[from.id]={id:from.id,kind:'local',name:from.name,role:account.role,building:account.building,buildings:account.buildings,personalRules:account.personalRules,version:7,enabled:true,deleted:false,source:'configuration',loginMethod:'personnel-password',personnelAppId:appId,personnelActive:true,personnelIdentity:from.id,passwordHash};
      state.personnelEmployment!.inactive[source.id]=false;state.personnelEmployment!.inactive[from.id]=false;
    });
    const ownership=[source.id,from.id].map(id=>({sourceAccountId:id,grants:handoverPermissionGrantKeys(accountPermissionTemplate(service.snapshot().accounts.find(account=>account.id===id)!)).map(key=>({key,disposition:key==='rule:retain-H-duty'?'retain' as const:'transfer' as const,...(key==='rule:retain-H-duty'?{}:{dutyRecordId:'recDuty'})}))}));
    const {content}=buildHandoverAuthoritySnapshot(directory,service.snapshot(),service.permissionArchives(),{fromPersonId:from.id,toPersonId:to.id,dutyRecordIds:['recDuty'],mode:'rotation',ownership});
    expect(content.conflicts).toEqual([]);expect(content.permissionOwnership).toHaveLength(2);expect(content.permissions).toHaveLength(1);
    await acceptCurrentPreview({...content,fingerprint:handoverFingerprint(content),createdAt:new Date().toISOString()});await apply(service,batch);
    const state=store.read();for(const id of [source.id,from.id]){expect(state.accounts[id].role).toBe('site_member');expect(state.accounts[id].personalRules?.map(rule=>rule.id)).toContain('retain-H-duty');}
    expect(state.accounts[from.id].passwordHash).toBe(passwordHash);expect(state.accounts[from.id].version).toBe(8);
    const bytes=readFileSync(file,'utf8');await expect(authority().restoreContext(batch.preview,batch)).resolves.toMatchObject({from:{id:from.id}});await authority().applyPermissions(batch,handoverItemMutationId(batch.id,'permissions'));expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it('同一事务重启重试不重复加权、不重复审计、不改已写字节',async()=>{
    await apply(service,batch);const before=readFileSync(file,'utf8');await apply(new AccessConfigurationService(),batch);
    expect(readFileSync(file,'utf8')).toBe(before);expect(store.read().accounts[target.id].version).toBe(2);
  });
  it.each([{enabled:false},{deleted:true},{permissionsRevoked:true}])('接任账号不可用时拒绝，保持原字节 %j',async flags=>{
    await store.mutate(store.read().revision,'fixture-block-target','block',state=>{Object.assign(state.accounts[target.id],flags);});
    await acceptCurrentPreview();const before=readFileSync(file,'utf8');await expect(apply(service,batch)).rejects.toThrow('当前不可授予权限');expect(readFileSync(file,'utf8')).toBe(before);
  });
  async function addPasswordAccount(active=true){
    const hash=await createAccessPasswordHash('synthetic-fixture-only');
    const local:stores.StoredAccount={id:to.id,kind:'local',name:to.name,role:'site_member',building:null,version:1,enabled:true,deleted:false,source:'configuration',loginMethod:'personnel-password',personnelAppId:appId,personnelActive:active,personnelIdentity:to.id,passwordHash:hash};
    await store.mutate(store.read().revision,'fixture-add-password','add',state=>{state.accounts[local.id]=local;});
    const preview=structuredClone(batch.preview),before=accountPermissionTemplate(local);
    preview.baseline.configurationRevision=store.read().revision;preview.baseline.accounts.push({id:local.id,version:1});
    preview.permissions.push({...previewPermissionInheritance(preview.permissions[0].source,before),sourceAccountId:source.id,targetAccountId:local.id,sourceArchive:preview.permissions[0].sourceArchive});
    preview.fingerprint=handoverFingerprint(preview);
    batch=await new PersonnelHandoverStore(join(folder,'dual-handover.json')).accept(0,{clientMutationId:'synthetic-confirm-dual',actorId:batch.actorId,actorName:batch.actorName,preview});
    return local;
  }
  it('飞书和姓名密码身份一起继承，密码字节与身份字段保留',async()=>{
    const local=await addPasswordAccount();await apply(service,batch);const after=store.read();
    expect(after.accounts[local.id]).toMatchObject({...local,role:'building_admin',building:'C楼',buildings:['C楼'],version:2});
    expect(after.accounts[target.id].version).toBe(2);expect(after.audit).toHaveLength(2);
    expect(JSON.stringify(service.snapshot())).not.toContain(local.passwordHash);expect(JSON.stringify(after.audit)).not.toContain(local.passwordHash);
  });
  it('第二个登录身份停用时全事务不落盘，不出现单身份先加权',async()=>{
    await addPasswordAccount(false);const before=readFileSync(file,'utf8');await expect(apply(service,batch)).rejects.toThrow('当前不可授予权限');
    expect(readFileSync(file,'utf8')).toBe(before);expect(store.read().accounts[target.id].version).toBe(1);
  });
  it('先前授权后人员撤权，原事务恢复也不会再次授予业务权限',async()=>{
    await apply(service,batch);await store.mutate(store.read().revision,'fixture-revoke-target','revoke',state=>{state.personnelEmployment!.inactive[target.id]=true;state.personnelEmployment!.inactive[to.id]=true;state.accounts[target.id].enabled=false;state.accounts[target.id].personnelSuspended=true;state.accounts[target.id].version++;});
    const before=readFileSync(file,'utf8');await apply(new AccessConfigurationService(),batch);expect(readFileSync(file,'utf8')).toBe(before);
    expect(service.snapshot().accounts.find(a=>a.id===target.id)).toMatchObject({enabled:false,permissionsRevoked:true,guestLoginAllowed:false});
    expect(service.feishuPrincipal(to.openId!,appId)).toBeNull();
  });
  it('未执行前账号版本变化拒绝，不把旧预览写到新版本上',async()=>{
    await store.mutate(store.read().revision,'fixture-change-account','change',state=>{state.accounts[target.id].version++;});
    const before=readFileSync(file,'utf8');await expect(apply(service,batch)).rejects.toThrow();expect(readFileSync(file,'utf8')).toBe(before);
  });
  it('前任存档变化即使配置修订已对齐也拒绝，不用新归档替换已确认清单',async()=>{
    await store.mutate(store.read().revision,'fixture-change-archive','archive',state=>{state.personnelPermissionArchives![source.id].template.pagePaths=['/nantong-base'];});
    await acceptCurrentPreview();const before=readFileSync(file,'utf8');await expect(apply(service,batch)).rejects.toThrow('授权存档已变化');expect(readFileSync(file,'utf8')).toBe(before);
  });
  it('错误分项mutation、改写模板与管理员升级均不写入',async()=>{
    const before=readFileSync(file,'utf8');await expect(apply(service,batch,'fixture-wrong-mutation')).rejects.toThrow();
    const changed=structuredClone(batch);changed.preview.permissions[0].after.role='admin';changed.preview.permissions[0].after.building=null;delete changed.preview.permissions[0].after.buildings;
    changed.preview.fingerprint=handoverFingerprint(changed.preview);changed.fingerprint=changed.preview.fingerprint;
    await expect(apply(service,changed)).rejects.toThrow();expect(readFileSync(file,'utf8')).toBe(before);
  });
  const authority=()=>new PersonnelHandoverAuthority(service,{read:async()=>structuredClone(directory)});
  it('实际authority恢复绑定原清单；权限已写但进度未写时用持久mutation恢复',async()=>{
    expect((await authority().restoreContext(batch.preview,batch)).to.recordId).toBe(to.recordId);
    await authority().applyPermissions(batch,handoverItemMutationId(batch.id,'permissions'));
    const before=readFileSync(file,'utf8');expect((await authority().restoreContext(batch.preview,batch)).to.openId).toBe(to.openId);
    await authority().applyPermissions(batch,handoverItemMutationId(batch.id,'permissions'));expect(readFileSync(file,'utf8')).toBe(before);
  });
  it('受理后目标撤权或职责版本变化阻断实际authority恢复',async()=>{
    await apply(service,batch);await store.mutate(store.read().revision,'fixture-authority-revoke','revoke',state=>{state.personnelEmployment!.inactive[target.id]=true;});
    const before=readFileSync(file,'utf8');await expect(authority().restoreContext(batch.preview,batch)).rejects.toThrow();expect(readFileSync(file,'utf8')).toBe(before);
  });
  it('没有本批权限mutation时不能把任意权限更新当作交接已应用',async()=>{
    await store.mutate(store.read().revision,'fixture-unrelated-permissions','unrelated',state=>{state.accounts[target.id].version++;});
    await expect(authority().restoreContext(batch.preview,batch)).rejects.toThrow('账号权限已变化');
  });
  it('岗位职责变动或人员主表缺项使原交接停止',async()=>{
    directory.personnelAuthority!.duties[0].version++;await expect(authority().restoreContext(batch.preview,batch)).rejects.toThrow('职责已变化');
    directory.personnelAuthority!.duties[0].version--;directory.employmentState!.entries.pop();await expect(authority().restoreContext(batch.preview,batch)).rejects.toThrow();
  });
  it('实际管理员校验拒绝游客、业务账号和未知身份',async()=>{
    await expect(authority().assertAdministrator({id:target.id,name:target.name})).rejects.toThrow();
    await expect(authority().assertAdministrator({id:'local-fixture-unknown',name:'合成未知'})).rejects.toThrow();
    const admin={...target,id:'feishu-'+feishuIdentityFingerprint(appId,'ou_admin'),openId:'ou_admin',identityHash:feishuIdentityFingerprint(appId,'ou_admin'),name:'合成管理员',role:'admin' as const};
    await store.mutate(store.read().revision,'fixture-authority-admin','admin',state=>{state.accounts[admin.id]=admin;});
    await expect(authority().assertAdministrator({id:admin.id,name:admin.name,authorizationVersion:admin.version})).resolves.toBeUndefined();
    await expect(authority().assertAdministrator({id:admin.id,name:'其他管理员',authorizationVersion:admin.version})).rejects.toThrow();
    await expect(authority().assertAdministrator({id:admin.id,name:admin.name})).rejects.toThrow();
    await store.mutate(store.read().revision,'fixture-admin-version','admin-version',state=>{state.accounts[admin.id].version++;});
    await expect(authority().assertAdministrator({id:admin.id,name:admin.name,authorizationVersion:admin.version})).rejects.toThrow();
    await expect(authority().assertAdministrator({id:admin.id,name:admin.name,authorizationVersion:admin.version+1})).resolves.toBeUndefined();
    await store.mutate(store.read().revision,'fixture-admin-revocation','admin-revoke',state=>{state.accounts[admin.id].role='site_member';state.accounts[admin.id].version++;});
    await expect(authority().assertAdministrator({id:admin.id,name:admin.name,authorizationVersion:admin.version+2})).rejects.toThrow();
  });
});
