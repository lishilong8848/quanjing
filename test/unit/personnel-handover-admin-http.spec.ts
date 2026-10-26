import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { AccessConfigurationDirectory } from '../../server/common/access/access-configuration.directory';
import { AccessConfigurationCardDirectory } from '../../server/common/access/access-configuration.card-directory';
import { AccessConfigurationController } from '../../server/common/access/access-configuration.controller';
import { UnifiedAccessService } from '../../server/common/access/unified-access.service';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { PersonnelHandoverAdminService } from '../../server/common/access/personnel-handover.admin.service';
import { PERSONNEL_PREVIEW_READERS } from '../../server/common/access/personnel-preview.ports';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { capturePersonnelPermission } from '../../server/common/access/personnel-permission-archive';
import { PersonnelHandoverStore } from '../../server/common/access/personnel-handover.store';
import type { ConfigurationDirectorySnapshot } from '../../server/common/access/access-configuration.directory';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import { handoverPermissionGrantKeys } from '../../server/common/access/personnel-handover.ownership';
import { accountPermissionTemplate } from '../../server/common/access/personnel-handover.preview';
import type { PersonnelRecoveryActor, PersonnelRecoveryRequest, PersonnelRecoveryTask } from '../../shared/personnel-task-recovery.interface';

describe('岗位交接真实管理HTTP（合成本地来源）',()=>{
  const appId='cli_http_handover',oldId='local-external-'+'a'.repeat(64),newId='local-external-'+'b'.repeat(64);
  const request={fromPersonId:oldId,toPersonId:newId,dutyRecordIds:['recDuty'],mode:'offboarding'};
  let app:INestApplication,base:string,cookie:string,folder:string,root:string,owner:string,store:stores.AccessConfigurationStore;
  let admin:stores.StoredAccount,other:stores.StoredAccount,directory:ConfigurationDirectorySnapshot,previous:NodeJS.ProcessEnv;
  let usePending=false,failReconcile=false,acceptedTransfers=0;
  let recoveryRows:PersonnelRecoveryTask[],recoveryCalls:number,recoveryActor:PersonnelRecoveryActor|undefined;
  beforeEach(async()=>{
    previous={...process.env};process.env.FEISHU_APP_ID=appId;process.env.LOCAL_ACCESS_SESSION_SECRET=randomBytes(32).toString('base64');delete process.env.PUBLIC_BASE_URL;
    usePending=false;failReconcile=false;acceptedTransfers=0;
    recoveryRows=[];recoveryCalls=0;recoveryActor=undefined;
    root=realpathSync(tmpdir());folder=mkdtempSync(join(root,'nt-handover-http-'));owner=randomUUID();writeFileSync(join(folder,'.test-owner'),owner,{flag:'wx'});
    store=new stores.AccessConfigurationStore(join(folder,'configuration.json'));jest.spyOn(stores,'getAccessConfigurationStore').mockReturnValue(store);jest.spyOn(defaults,'defaultAccessAccounts').mockReturnValue({});
    const person=(id:string,name:string,openId:string,active:boolean)=>({id,recordId:id===oldId?'recOld':'recNew',name,openId,active,type:'employee' as const,position:'C楼示例人员001',systemPosition:'',buildings:['C楼' as const],specialties:[],permissionTags:[],dutyRecordIds:['recDuty']});
    const from=person(oldId,'合成前任','ou_http_old',false),to=person(newId,'合成接任','ou_http_new',true);
    const account=(openId:string,name:string):stores.StoredAccount=>({id:'feishu-'+feishuIdentityFingerprint(appId,openId),kind:'feishu',appId,openId,name,identityHash:feishuIdentityFingerprint(appId,openId),role:'site_member',building:null,enabled:true,deleted:false,source:'configuration',version:1});
    const source={...account(from.openId,from.name),personnelIdentity:from.id,role:'building_admin' as const,building:'C楼' as const};
    const target=account(to.openId,to.name);admin={...account('ou_http_admin','合成管理员'),role:'admin'};other={...account('ou_http_other','另一管理员'),role:'admin'};
    await store.mutate(0,'synthetic-http-seed','seed',state=>{state.accounts={[source.id]:{...source,enabled:false,personnelSuspended:true,version:2},[target.id]:target,[admin.id]:admin,[other.id]:other};state.personnelPermissionArchives={[source.id]:capturePersonnelPermission(source,undefined,0)!};state.personnelEmployment={appId,snapshotAt:Date.now(),inactive:{[source.id]:true,[oldId]:true,[target.id]:false,[newId]:false}};});
    directory={appId,people:[],employees:[],snapshotAt:Date.now(),personnelComplete:true,employmentState:{complete:true,entries:[{personnelIdentity:oldId,openId:from.openId,inactive:true},{personnelIdentity:newId,openId:to.openId,inactive:false}]},personnelAuthority:{mode:'shadow',version:'c'.repeat(64),snapshotAt:Date.now(),source:{appId,appToken:'fixture',tableId:'tblPeople'},people:[from,to],duties:[{recordId:'recDuty',name:'C楼请休假示例人员001',kind:'leave_supervisor',personnelIds:[newId],buildings:['C楼'],specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1}],problems:[],issues:[]}};
    const adapter=(module:string)=>({module,listPending:async()=>usePending&&module==='leave'?[{key:'leave:recWork:supervisor:1',module:'leave',recordId:'recWork',title:'合成请休假',dutyRecordId:'recDuty',phase:'approval',status:'pending',stageKey:'supervisor',version:'1',recipients:[{name:from.name,openId:from.openId}]}]:[],preflight:async()=>({ready:true}),acceptTransfer:async(_context:unknown,item:{key:string;recordId:string},mutationId:string)=>{acceptedTransfers++;return {itemKey:item.key,mutationId,module,recordId:item.recordId,version:'2',status:'accepted'};},reconcile:async()=>({status:failReconcile?'error':'success'})});
    const recoveryAdapter=(name:string)=>({...adapter(name),listRecoveryTasks:async()=>recoveryRows.filter(row=>row.module===name),
      previewRecoveryTask:async(input:PersonnelRecoveryRequest)=>({task:recoveryRows.find(row=>row.id===input.taskId),version:input.expectedVersion,facts:[],choices:[],canConfirm:true,acknowledgement:'合成核对确认'}),
      recoverTask:async(_input:PersonnelRecoveryRequest,actor:PersonnelRecoveryActor,authorize:()=>void)=>{authorize();recoveryCalls++;recoveryActor=actor;return{status:'completed',message:'合成原任务已核对'};}});
    const module=await Test.createTestingModule({controllers:[AccessConfigurationController],providers:[AccessConfigurationService,UnifiedAccessService,PersonnelHandoverAdminService,{provide:AccessConfigurationDirectory,useValue:{read:async()=>structuredClone(directory)}},{provide:AccessConfigurationCardDirectory,useValue:{}},...Object.entries(PERSONNEL_PREVIEW_READERS).map(([name,token])=>({provide:token,useValue:recoveryAdapter(name)})),{provide:APP_GUARD,useClass:UnifiedAccessGuard}]}).compile();
    app=module.createNestApplication({logger:false});await app.listen(0,'127.0.0.1');base=await app.getUrl();cookie=issue(admin);
  },30000);
  afterEach(async()=>{
    await app?.close();jest.restoreAllMocks();for(const key of Object.keys(process.env))if(previous[key]===undefined)delete process.env[key];Object.assign(process.env,previous);
    if(resolve(dirname(folder)).toLowerCase()!==resolve(root).toLowerCase()||realpathSync(folder)!==folder||lstatSync(folder).isSymbolicLink()||readFileSync(join(folder,'.test-owner'),'utf8')!==owner)throw new Error('测试目录归属异常');
    for(const name of readdirSync(folder))if(lstatSync(join(folder,name)).isSymbolicLink()||!lstatSync(join(folder,name)).isFile())throw new Error('测试文件归属异常');
    rmSync(folder,{recursive:true,force:false});
  });
  function issue(account:stores.StoredAccount,role=account.role){const principal:AccessPrincipal={role,purchaseBuilding:null,accountId:account.id,displayName:account.name,authorizationVersion:account.version};const access=app.get(UnifiedAccessService);return `${access.cookieName}=${access.issueTrustedSession(principal as never).token}`;}
  const post=(path:string,body:unknown,session=cookie,origin?:string)=>fetch(`${base}/api/access/configuration/personnel-handover/${path}`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:session,Origin:origin||base},body:JSON.stringify(body)});
  it('原任务恢复清单与核对、提交共用真实管理员、本站和会话版本保护',async()=>{
    recoveryRows=[{module:'contracts',id:'contract-expiry-'+randomUUID(),recordId:'rec-contract',title:'合成合同续期',actorName:'合成经办人',createdAt:new Date().toISOString(),status:'failed',message:'结果待核对',version:'d'.repeat(64),actionLabel:'核对结果',available:true,hint:''}];
    const endpoint=`${base}/api/access/configuration/personnel-handover/recovery`;
    expect((await fetch(endpoint)).status).toBe(403);
    const list=await fetch(endpoint,{headers:{Cookie:cookie}});expect(list.status).toBe(200);expect(list.headers.get('cache-control')).toBe('private, no-store');expect(await list.json()).toEqual(recoveryRows);
    const input={module:'contracts',taskId:recoveryRows[0].id,expectedVersion:recoveryRows[0].version,clientMutationId:randomUUID()};
    expect((await post('recovery/preview',input,'')).status).toBe(403);
    expect((await post('recovery/preview',input,cookie,'https://untrusted.example')).status).toBe(403);
    const preview=await post('recovery/preview',input);expect(preview.status).toBe(201);expect((await preview.json()).canConfirm).toBe(true);
    expect((await post('recovery',{...input,actorId:admin.id})).status).toBe(400);
    expect((await post('recovery',{...input,module:'leave'})).status).toBe(400);
    expect(recoveryCalls).toBe(0);
    expect((await post('recovery',input)).status).toBe(201);expect(recoveryCalls).toBe(1);expect(recoveryActor?.id).toBe(admin.id);
    await store.mutate(store.read().revision,'synthetic-recovery-admin-change','version',state=>{state.accounts[admin.id].version++;});
    expect((await post('recovery',input)).status).toBe(403);expect(recoveryCalls).toBe(1);
  });
  it('原恢复端口缺失明确失败，不返回空成功清单',async()=>{
    app.get(PERSONNEL_PREVIEW_READERS.contracts).previewRecoveryTask=undefined;
    expect((await fetch(`${base}/api/access/configuration/personnel-handover/recovery`,{headers:{Cookie:cookie}})).status).toBe(503);
  });
  it('匿名、游客和子管理员不能访问；本站管理员能预览，跨源拒绝',async()=>{
    expect((await post('preview',request,'')).status).toBe(403);
    const access=app.get(UnifiedAccessService),configuration=app.get(AccessConfigurationService);
    const guest=configuration.feishuPrincipal('ou_http_old',appId);
    expect((await post('preview',request,`${access.cookieName}=${access.issueTrustedSession(guest!).token}`)).status).toBe(403);
    const editor={...other,role:'editor' as const,version:2};await store.mutate(store.read().revision,'synthetic-seed-editor','editor',state=>{state.accounts[editor.id]=editor;});
    expect((await post('preview',request,issue(editor))).status).toBe(403);
    expect((await post('preview',request,cookie,'https://untrusted.example')).status).toBe(403);
    const result=await post('preview',request);expect(result.status).toBe(201);expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(JSON.stringify(await result.json())).not.toMatch(/passwordHash|appToken/);
  });
  it('原会话版本失效拒绝，不用当前snapshot版本替代旧会话',async()=>{
    await store.mutate(store.read().revision,'synthetic-update-admin','version',state=>{state.accounts[admin.id].version++;});
    expect((await post('preview',request)).status).toBe(403);
  });
  it('范围、人员状态不符的轮岗、专业限定和伪造操作者字段拒绝，不写正式批次',async()=>{
    expect((await post('preview',{...request,mode:'rotation'})).status).toBe(409);
    expect((await post('preview',{...request,actorId:admin.id})).status).toBe(400);
    directory.personnelAuthority!.duties[0].specialties=['电气'];expect((await post('preview',request)).status).toBe(409);
    directory.personnelAuthority!.duties[0].specialties=null;directory.personnelAuthority!.duties[0].kind='contract_action';expect((await post('preview',request)).status).toBe(201);
  });
  it.each(['warehouse_approver','warehouse_notify','purchase_manager','purchase_approver','purchase_executor','building_executor','contract_action','contract_notify','professional_supervisor','professional_engineer'] as const)('%s通过同一真实管理员入口预览，服务端决定范围',async kind=>{
    const duty=directory.personnelAuthority!.duties[0];duty.kind=kind;
    duty.specialties=['professional_supervisor','professional_engineer','purchase_approver','purchase_executor','building_executor','contract_notify'].includes(kind)?['电气']:null;
    const response=await post('preview',request);expect(response.status).toBe(201);
    const preview=await response.json();expect(preview.requested.dutyRecordIds).toEqual(['recDuty']);expect(preview.baseline.duties).toHaveLength(1);
  });
  it('持久受理与重复确认，同请求另一管理员拒绝；取消后重新查询仍为取消',async()=>{
    const preview=await (await post('preview',request)).json();
    const input={request,expectedFingerprint:preview.fingerprint,clientMutationId:'synthetic-http-confirm-001'};
    const accepted=await (await post('confirm',input)).json();expect(accepted.status).toBe('accepted');
    const ledger=new PersonnelHandoverStore(join(folder,'personnel-handover.json'));
    await expect(ledger.accept(ledger.read().revision,{clientMutationId:'synthetic-concurrent-002',actorId:admin.id,actorName:admin.name,preview})).rejects.toThrow('已有未收口');
    expect((await (await post('confirm',input)).json()).id).toBe(accepted.id);
    expect((await post('confirm',input,issue(other))).status).toBe(409);
    const cancelled=await (await post('cancel',{id:accepted.id,version:accepted.version})).json();expect(cancelled.status).toBe('cancelled');
    expect((await (await post('progress',{id:accepted.id})).json()).status).toBe('cancelled');
    const records=await (await fetch(`${base}/api/access/configuration/personnel-handover?clientMutationId=${input.clientMutationId}`,{headers:{Cookie:cookie}})).json();
    expect(records).toHaveLength(1);expect(JSON.stringify(records)).not.toMatch(/passwordHash|appToken/);
  });
  it('在职轮岗先确认归属再一次提交，真实HTTP持久保留选择并复用原请求',async()=>{
    directory.personnelAuthority!.people.find(person=>person.id===oldId)!.active=true;directory.employmentState!.entries.find(person=>person.personnelIdentity===oldId)!.inactive=false;
    const sourceId='feishu-'+feishuIdentityFingerprint(appId,'ou_http_old');await store.mutate(store.read().revision,'fixture-http-rotation','rotation',state=>{state.accounts[sourceId].enabled=true;delete state.accounts[sourceId].personnelSuspended;state.personnelEmployment!.inactive[sourceId]=false;state.personnelEmployment!.inactive[oldId]=false;});
    const current={...request,mode:'rotation'};const pending=await (await post('preview',current)).json();expect(pending.conflicts.join('')).toContain('归属');
    const source=accountPermissionTemplate(app.get(AccessConfigurationService).snapshot().accounts.find(account=>account.id===sourceId)!);
    const ownership=[{sourceAccountId:sourceId,grants:handoverPermissionGrantKeys(source).map(key=>({key,disposition:'transfer',dutyRecordId:'recDuty'}))}];
    const resolved=await post('preview',{...current,ownership});expect(resolved.status).toBe(201);const preview=await resolved.json();expect(preview.conflicts).toEqual([]);
    const input={request:{...current,ownership},expectedFingerprint:preview.fingerprint,clientMutationId:'synthetic-http-rotation-confirm'};
    const first=await post('confirm',input);expect(first.status).toBe(201);const accepted=await first.json(),again=await (await post('confirm',input)).json();expect(again.id).toBe(accepted.id);expect(accepted.preview.requested.ownership).toEqual(ownership);
  });
  it('真实权限已应用而分项失败，HTTP恢复只重失败步骤，不重复加权或业务受理',async()=>{
    usePending=true;failReconcile=true;
    const preview=await (await post('preview',request)).json(),input={request,expectedFingerprint:preview.fingerprint,clientMutationId:'synthetic-http-partial-001'};
    const accepted=await (await post('confirm',input)).json();
    const service=app.get(PersonnelHandoverAdminService) as unknown as {service():{process(id:string):Promise<{version:number;status:string;permissionStatus:string}>}};
    const partial=await service.service().process(accepted.id);expect(partial).toMatchObject({status:'error',permissionStatus:'success'});expect(acceptedTransfers).toBe(1);
    expect((await post('cancel',{id:accepted.id,version:partial.version})).status).toBe(409);
    const before=readFileSync(store.filePath,'utf8');failReconcile=false;
    expect((await post('retry',{id:accepted.id,version:partial.version})).status).toBe(201);
    let progress;for(let count=0;count<20;count++){progress=await (await post('progress',{id:accepted.id})).json();if(progress.status==='success')break;await new Promise(resolve=>setTimeout(resolve,25));}
    expect(progress.status).toBe('success');expect(acceptedTransfers).toBe(1);expect(readFileSync(store.filePath,'utf8')).toBe(before);
  });
  it('恢复请求先持久化，响应后进程尚未执行也保留恢复意图',async()=>{
    usePending=true;failReconcile=true;
    const preview=await (await post('preview',request)).json(),input={request,expectedFingerprint:preview.fingerprint,clientMutationId:'synthetic-http-durable-retry'};
    const accepted=await (await post('confirm',input)).json();
    const service=app.get(PersonnelHandoverAdminService) as unknown as {launch(id:string):void;service():{process(id:string):Promise<{version:number;status:string}>}};
    const failed=await service.service().process(accepted.id);expect(failed.status).toBe('error');
    jest.spyOn(service,'launch').mockImplementation(()=>{});
    const response=await post('retry',{id:accepted.id,version:failed.version});expect(response.status).toBe(201);
    const resumed=await response.json();expect(resumed.status).toBe('syncing');
    const persisted=new PersonnelHandoverStore(join(folder,'personnel-handover.json')).read().batches[accepted.id];
    expect(persisted.items[0].status).toBe('accepted');expect(persisted.items[0].receipt?.mutationId).toBe(resumed.items[0].receipt.mutationId);
    failReconcile=false;expect((await service.service().process(accepted.id)).status).toBe('success');expect(acceptedTransfers).toBe(1);
  });
});
