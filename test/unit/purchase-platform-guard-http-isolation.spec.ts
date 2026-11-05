// Business isolation tests run after release activation. Release gating is tested separately.
jest.mock('../../server/common/hotfix-runtime-activation', () => ({
  currentHotfixActivation: () => ({ isAcceptingNewWork: () => true }),
  runHotfixInitialization: (_owner: object, initialize: () => unknown) => initialize(),
  cancelHotfixInitialization: async () => {},
}));
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { migrateAuthorizationState, reprojectAuthorizationState } from '../../server/common/access/authorization-profile.configuration';
import { hashAccessPassword, UnifiedAccessService } from '../../server/common/access/unified-access.service';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { PurchaseInventoryController } from '../../server/modules/purchase-inventory/purchase-inventory.controller';
import { PurchaseInventoryService } from '../../server/modules/purchase-inventory/purchase-inventory.service';
import { PurchaseAccessPolicyService } from '../../server/modules/purchase-inventory/purchase-access-policy.service';
import { PurchaseRecordDeletionService } from '../../server/modules/purchase-inventory/purchase-record-deletion.service';
import { PurchaseRecordEditService } from '../../server/modules/purchase-inventory/purchase-record-edit.service';
import { PurchaseOnlineApprovalService } from '../../server/modules/purchase-inventory/purchase-online-approval.service';
import { PurchaseApplicationService } from '../../server/modules/purchase-inventory/purchase-application.service';
import { PurchaseWorkflowReceiptTaskService } from '../../server/modules/purchase-inventory/purchase-workflow-receipt-task.service';
import { PurchaseWorkflowScheduler } from '../../server/modules/purchase-inventory/purchase-workflow.scheduler';
import { PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import { PurchaseWorkflowService } from '../../server/modules/purchase-inventory/purchase-workflow.service';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PURCHASE_PLATFORM_SESSION_BINDING, PurchasePlatformSessionBinding } from '../../server/modules/purchase-inventory/purchase-platform-session-binding';
import { PurchasePlatformApprovalRuntime } from '../../server/modules/purchase-inventory/purchase-platform-approval-runtime';
import { createHash } from 'node:crypto';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

jest.mock('../../server/common/config/external-services.config', () => ({ ...jest.requireActual('../../server/common/config/external-services.config'),
  readEnv:(key:string, aliases:string[]=[])=>[key,...aliases].map(k=>process.env[k]||'').find(Boolean)||'' }));

describe('隔离 HTTP: signed procurement session + real guard + controller + ledger', () => {
  const appId='cli_synthetic_http', userId=`local-external-${'e'.repeat(64)}`;
  let env:NodeJS.ProcessEnv, folder:string, owner:string, access:UnifiedAccessService, config:AccessConfigurationService;
  let configStore:stores.AccessConfigurationStore, store:PurchaseWorkflowStore, workflow:PurchaseWorkflowService, app:INestApplication, url:string, token:string, live:PurchaseWorkflowRecord, gateway:any;
  const otherId=`local-external-${'f'.repeat(64)}`;
  beforeEach(async () => {
    env=process.env; process.env={SystemRoot:env.SystemRoot,TEMP:env.TEMP,TMP:env.TMP};
    folder=mkdtempSync(join(realpathSync(tmpdir()),'nt-guard-http-')); owner=randomUUID(); writeFileSync(join(folder,'.owner'),owner,{flag:'wx'});
    process.env.ACCESS_CONFIGURATION_FILE=join(folder,'configuration.json'); process.env.LOCAL_ACCESS_SESSION_SECRET=Buffer.alloc(32,41).toString('base64');
    process.env.LOCAL_ACCESS_CONTROL_ENABLED='true'; process.env.FEISHU_APP_ID=appId; process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED='false'; process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED='false';
    const hash=hashAccessPassword('synthetic-http-password');
    const accounts:Record<string,stores.StoredAccount>={
      'local-admin-all':{id:'local-admin-all',kind:'local',name:'合成管理员',role:'admin',building:null,enabled:true,deleted:false,version:1,source:'default',passwordHash:hash},
      'local-admin-other':{id:'local-admin-other',kind:'local',name:'另一管理员',role:'admin',building:null,enabled:true,deleted:false,version:1,source:'configuration',passwordHash:hash},
      [otherId]:{id:otherId,kind:'local',name:'另一合成用户',role:'purchase_admin',building:null,enabled:true,deleted:false,version:1,source:'configuration',passwordHash:hash,loginMethod:'personnel-password',personnelActive:true,personnelAppId:appId},
      [userId]:{id:userId,kind:'local',name:'合成用户',role:'purchase_admin',building:null,enabled:true,deleted:false,version:1,source:'configuration',passwordHash:hash,loginMethod:'personnel-password',personnelActive:true,personnelAppId:appId,
        personalRules:[{id:'deny-a-order',effect:'deny',module:'purchase',actions:['order'],buildings:['A楼'],specialties:null}]},
    };
    configStore=new stores.AccessConfigurationStore(process.env.ACCESS_CONFIGURATION_FILE); jest.spyOn(stores,'getAccessConfigurationStore').mockReturnValue(configStore);
    jest.spyOn(defaults,'defaultAccessAccounts').mockImplementation(()=>structuredClone(accounts));
    await configStore.mutate(0,`seed-${randomUUID()}`,'synthetic',state=>{state.accounts=structuredClone(accounts);migrateAuthorizationState(state,accounts);});
    config=new AccessConfigurationService(); access=new UnifiedAccessService(config); token=access.issueTrustedSession(config.currentPrincipal(userId,1)! as never,Date.now()).token;
    live={recordId:'rec_http',requestCode:'CG-TEST',status:'审批通过（待下单）',itemName:'合成物品',building:'C楼',specialty:'电气',requesterOpenId:'ou_requester',requesterName:'申请人',purchaserOpenId:'ou_purchaser',purchaserName:'原采购人',purchaseMethod:'综合采购',requestedQuantity:1,actualQuantity:null,actualAmount:null,approvalCompleted:true,warehouseConfirmed:true,purchaseCompleted:false,receiptConfirmed:false,signer:'',receiptTime:null,receiptPhotoTokens:[],invoiceTokens:[]};
    gateway={getTenantAccessTokenAsApp:jest.fn(async()=> 'synthetic-token'),getExecutionRecordAsApp:jest.fn(async()=>structuredClone(live)),getExecutionRecord:jest.fn(async()=>structuredClone(live)),
      updateExecutionRecord:jest.fn(async(_id:string,patch:Record<string,unknown>)=>{live={...live,status:String(patch['采购流程']),actualQuantity:Number(patch['实际采购数量']),actualAmount:Number(patch['实际付款金额']),purchaseCompleted:true};})};
    store=new PurchaseWorkflowStore(join(folder,'ledger.json')); await store.onModuleInit(); workflow=new PurchaseWorkflowService(gateway,store,undefined,config);
    const unused=[PurchaseInventoryService,PurchaseAccessPolicyService,PurchaseRecordDeletionService,PurchaseRecordEditService,PurchaseApplicationService,PurchaseWorkflowReceiptTaskService,PurchaseWorkflowScheduler];
    const module=await Test.createTestingModule({controllers:[PurchaseInventoryController],providers:[...unused.map(provide=>({provide,useValue:{}})),
      {provide:PurchaseWorkflowService,useValue:workflow},{provide:PurchaseWorkflowGateway,useValue:gateway},{provide:AccessConfigurationService,useValue:config},
      {provide:PurchaseOnlineApprovalService,useValue:new PurchaseOnlineApprovalService(gateway,workflow)},
      {provide:PURCHASE_PLATFORM_SESSION_BINDING,useValue:new PurchasePlatformSessionBinding(access,config)},
      {provide:APP_GUARD,useFactory:(reflector:Reflector)=>new UnifiedAccessGuard(reflector,access),inject:[Reflector]},
    ]}).compile();
    app=module.createNestApplication(); app.useLogger(false); await app.listen(0,'127.0.0.1'); url=`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterEach(async()=>{await app?.close();workflow?.onModuleDestroy();await store?.onModuleDestroy();jest.restoreAllMocks();process.env=env;
    if(dirname(resolve(folder)).toLowerCase()!==realpathSync(tmpdir()).toLowerCase()||!basename(folder).startsWith('nt-guard-http-')||readFileSync(join(folder,'.owner'),'utf8')!==owner) throw new Error('Synthetic fixture ownership mismatch');
    rmSync(folder,{recursive:true,force:false});});
  async function order(cookie=token) {return fetch(`${url}/api/purchase-inventory/workflows/rec_http/order`,{method:'POST',headers:{Cookie:`${access.cookieName}=${encodeURIComponent(cookie)}`,'Content-Type':'application/json'},body:JSON.stringify({payload:JSON.stringify({actualQuantity:2,actualAmount:5,note:''})})});}
  async function enableTestRuntime(mode:'stopped'|'success'|'unknown'='stopped') {
    live.status='未开始（待审批）';live.approvalCompleted=false;live.approvalBatchId='';live.approvalActionId='';
    await store.recordReminder('synthetic-http-fixture');
    const fingerprint=createHash('sha256').update('synthetic-source').digest('hex'); let verifyCount=0;
    const source={sourceIdentity:()=>({appId,sourceFingerprint:fingerprint}),verifyMarker:jest.fn(async()=>{if(++verifyCount>1 && mode==='stopped')throw Error('synthetic worker unavailable');}),
      readSnapshot:jest.fn(async()=>({record:structuredClone(live),markerPresent:true})),writeDecision:jest.fn(async(_id:string,patch:Record<string,string>)=>{
        if(mode==='stopped') throw Error('synthetic write prohibited');
        live={...live,status:patch['采购流程'],purchaseMethod:patch['1️⃣物品采购方式'] as PurchaseWorkflowRecord['purchaseMethod'],approvalActionId:patch['采购审批动作标识']};
        if(mode==='unknown') throw Error('synthetic response lost');
      })};
    (app.get(PurchaseOnlineApprovalService) as any).platformRuntime=new PurchasePlatformApprovalRuntime(store,source);
    return source;
  }
  it('真实签名的姓名账号经过 guard、DI 与真实权限校验后只写一次且保留原采购人',async()=>{
    const result=await order();expect(result.status).toBe(201);expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
    expect(live.purchaserOpenId).toBe('ou_purchaser');expect(gateway.updateExecutionRecord.mock.calls[0][1]['采购人']).toBeUndefined();
    expect((await store.findCommand('order:rec_http'))?.platformIdentity).toMatchObject({actorAccountId:userId,subjectAccountId:userId});
  });
  it('管理员代登录经过真实 guard 时记录实际管理员和目标账号',async()=>{
    const admin=access.issueTrustedSession(config.currentPrincipal('local-admin-all',1)! as never,Date.now()).token;
    const delegated=await access.startImpersonation(admin,{accountId:userId,clientMutationId:`delegate-${randomUUID()}`},Date.now());
    expect((await order(delegated.token)).status).toBe(201);
    expect((await store.findCommand('order:rec_http'))?.platformIdentity).toMatchObject({source:'impersonation',actorAccountId:'local-admin-all',subjectAccountId:userId});
    expect(live.purchaserOpenId).toBe('ou_purchaser');
  });
  it('个人禁止楼栋和错误阶段均在真实链路中拒绝且不写入',async()=>{
    live.building='A楼';expect((await order()).status).toBeGreaterThanOrEqual(400);expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();
    live.building='C楼';live.status='驳回申请';expect((await order()).status).toBeGreaterThanOrEqual(400);expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
  it('没有合法签名的请求无法通过真实 guard',async()=>{expect((await order('forged-cookie')).status).toBeGreaterThanOrEqual(400);expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();});
  it('记录当前尚未接通的姓名账号网页审批：拒绝而不回退旧写入',async()=>{
    live.status='未开始（待审批）';live.approvalCompleted=false;
    const checked=jest.spyOn(workflow,'prepareWebApprovalAuthority');
    const response=await fetch(`${url}/api/purchase-inventory/records/rec_http/approval`,{method:'POST',headers:{Cookie:`${access.cookieName}=${encodeURIComponent(token)}`,'Content-Type':'application/json'},body:JSON.stringify({decision:'approved'})});
    expect(response.status).toBe(403);expect(checked).not.toHaveBeenCalled();expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
  it('测试专用 runtime 受理后本人可查，其他人及错误代登录身份不可读取',async()=>{
    const source=await enableTestRuntime();
    const headers={Cookie:`${access.cookieName}=${encodeURIComponent(token)}`,'Content-Type':'application/json'};
    const submitted=await fetch(`${url}/api/purchase-inventory/records/rec_http/approval`,{method:'POST',headers,body:JSON.stringify({decision:'rejected'})});
    const body:any=await submitted.json();expect({status:submitted.status,error:body.message}).toEqual({status:201,error:'审批已受理，正在同步'});expect(body.taskId).toMatch(/^platform_/);
    const status=(cookie:string)=>fetch(`${url}/api/purchase-inventory/approval/tasks/${body.taskId}`,{headers:{Cookie:`${access.cookieName}=${encodeURIComponent(cookie)}`}});
    expect((await status(token)).status).toBe(200);
    const other=access.issueTrustedSession(config.currentPrincipal(otherId,1)! as never,Date.now()).token;
    expect((await status(other)).status).toBe(403);
    const admin=access.issueTrustedSession(config.currentPrincipal('local-admin-all',1)! as never,Date.now()).token;
    const delegated=await access.startImpersonation(admin,{accountId:userId,clientMutationId:`delegate-${randomUUID()}`},Date.now());
    expect((await status(delegated.token)).status).toBe(403);
    expect((await status('forged-cookie')).status).toBeGreaterThanOrEqual(400);
    expect((await status('')).status).toBeGreaterThanOrEqual(400);
    await configStore.mutate(configStore.read().revision,`restrict-${randomUUID()}`,'synthetic',state=>{
      const account=state.accounts[userId]!;account.authorizationOverrides!.rules.push({id:'deny-c-approve',module:'purchase',effect:'deny',actions:['approve'],buildings:['C楼'],specialties:['电气']});
      account.version++;reprojectAuthorizationState(state);
    });
    const restricted=access.issueTrustedSession(config.currentPrincipal(userId,2)! as never,Date.now()).token;
    expect((await status(restricted)).status).toBeGreaterThanOrEqual(400);
    await configStore.mutate(configStore.read().revision,`disable-${randomUUID()}`,'synthetic',state=>{state.accounts[userId]!.enabled=false;state.accounts[userId]!.version++;});
    expect((await status(token)).status).toBeGreaterThanOrEqual(400);
    expect(source.writeDecision).not.toHaveBeenCalled();expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
  it('代登录受理的状态仅允许相同真实管理员和目标会话查询，结束代登录后拒绝',async()=>{
    await enableTestRuntime();
    const admin=access.issueTrustedSession(config.currentPrincipal('local-admin-all',1)! as never,Date.now()).token;
    const delegated=await access.startImpersonation(admin,{accountId:userId,clientMutationId:`delegate-${randomUUID()}`},Date.now());
    const cookie=(value:string)=>({Cookie:`${access.cookieName}=${encodeURIComponent(value)}`});
    const submitted=await fetch(`${url}/api/purchase-inventory/records/rec_http/approval`,{method:'POST',headers:{...cookie(delegated.token),'Content-Type':'application/json'},body:JSON.stringify({decision:'rejected'})});
    const result:any=await submitted.json();expect(submitted.status).toBe(201);
    const status=(value:string)=>fetch(`${url}/api/purchase-inventory/approval/tasks/${result.taskId}`,{headers:cookie(value)});
    expect((await status(delegated.token)).status).toBe(200);
    expect((await status(token)).status).toBe(403);
    const otherAdmin=access.issueTrustedSession(config.currentPrincipal('local-admin-other',1)! as never,Date.now()).token;
    const other=await access.startImpersonation(otherAdmin,{accountId:userId,clientMutationId:`delegate-${randomUUID()}`},Date.now());
    expect((await status(other.token)).status).toBe(403);
    await access.stopImpersonation(delegated.token,admin,`stop-${randomUUID()}`,Date.now());
    expect((await status(delegated.token)).status).toBeGreaterThanOrEqual(400);
    expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
  it('非管理员真实授权可完成审批，保持旧网页的三字段语义和原人员',async()=>{
    const source=await enableTestRuntime('success');const originalPurchaser=live.purchaserOpenId;
    const headers={Cookie:`${access.cookieName}=${encodeURIComponent(token)}`,'Content-Type':'application/json'};
    const response=await fetch(`${url}/api/purchase-inventory/records/rec_http/approval`,{method:'POST',headers,body:JSON.stringify({decision:'rejected'})});
    expect(response.status).toBe(201);const result:any=await response.json();
    let state:any;
    for(let i=0;i<100;i++){const res=await fetch(`${url}/api/purchase-inventory/approval/tasks/${result.taskId}`,{headers});state=await res.json();if(state.task?.status==='completed')break;await new Promise(resolve=>setTimeout(resolve,10));}
    expect(state.task?.status).toBe('completed');expect(source.writeDecision).toHaveBeenCalledTimes(1);
    const patch=source.writeDecision.mock.calls[0][1];
    expect(Object.keys(patch).sort()).toEqual(['1️⃣物品采购方式','采购流程','采购审批动作标识'].sort());
    expect(patch).toMatchObject({'1️⃣物品采购方式':'驳回','采购流程':'驳回申请'});expect(live.purchaserOpenId).toBe(originalPurchaser);
    expect(patch['驳回原因']).toBeUndefined();expect(patch['采购实际审批人']).toBeUndefined();
  });
  it('审批远端结果不明时保留待核对并且查询不重复发送',async()=>{
    const source=await enableTestRuntime('unknown');const headers={Cookie:`${access.cookieName}=${encodeURIComponent(token)}`,'Content-Type':'application/json'};
    const response=await fetch(`${url}/api/purchase-inventory/records/rec_http/approval`,{method:'POST',headers,body:JSON.stringify({decision:'rejected'})});
    expect(response.status).toBe(201);const result:any=await response.json();let state:any;
    for(let i=0;i<100;i++){const res=await fetch(`${url}/api/purchase-inventory/approval/tasks/${result.taskId}`,{headers});state=await res.json();if(state.task?.status==='failed')break;await new Promise(resolve=>setTimeout(resolve,10));}
    expect(state.task?.status).toBe('failed');expect(state.task?.message).toContain('待核对');
    for(let i=0;i<3;i++)expect((await fetch(`${url}/api/purchase-inventory/approval/tasks/${result.taskId}`,{headers})).status).toBe(200);
    expect(source.writeDecision).toHaveBeenCalledTimes(1);
  });
  it('撤销审批操作或楼栋权限后，真实 guard 与账本受理不产生写入',async()=>{
    const source=await enableTestRuntime('success');
    await configStore.mutate(configStore.read().revision,`deny-${randomUUID()}`,'synthetic',state=>{
      const account=state.accounts[userId]!;account.authorizationOverrides!.rules.push({id:'deny-c-approval',module:'purchase',effect:'deny',actions:['approve'],buildings:['C楼'],specialties:['电气']});
      account.version++;reprojectAuthorizationState(state);
    });
    const restricted=access.issueTrustedSession(config.currentPrincipal(userId,2)! as never,Date.now()).token;
    const response=await fetch(`${url}/api/purchase-inventory/records/rec_http/approval`,{method:'POST',headers:{Cookie:`${access.cookieName}=${encodeURIComponent(restricted)}`,'Content-Type':'application/json'},body:JSON.stringify({decision:'approved'})});
    expect(response.status).toBeGreaterThanOrEqual(400);expect(source.writeDecision).not.toHaveBeenCalled();expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
  it('流程弹窗经过真实 guard 使用统一账本并保留所选采购方式，重新登录重放不再写入',async()=>{
    const source=await enableTestRuntime('success');
    const send=(cookie:string)=>fetch(`${url}/api/purchase-inventory/workflows/rec_http/approve`,{method:'POST',headers:{Cookie:`${access.cookieName}=${encodeURIComponent(cookie)}`,'Content-Type':'application/json'},body:JSON.stringify({decision:'approved',purchaseMethod:'需求自采',comment:''})});
    const response=await send(token);const accepted:any=await response.json();expect(response.status).toBe(201);expect(accepted.pending).toBe(true);
    let state:any;
    for(let index=0;index<100;index++){
      state=await (await fetch(`${url}/api/purchase-inventory/approval/tasks/${accepted.taskId}`,{headers:{Cookie:`${access.cookieName}=${encodeURIComponent(token)}`}})).json();
      if(state.task?.status==='completed')break;await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(state.task?.status).toBe('completed');expect(live.purchaseMethod).toBe('需求自采');
    const next=access.issueTrustedSession(config.currentPrincipal(userId,1)! as never,Date.now()).token;
    const replay=await send(next);expect(replay.status).toBe(201);expect((await replay.json() as any).taskId).toBe(accepted.taskId);
    expect(source.writeDecision).toHaveBeenCalledTimes(1);expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();
    expect(source.writeDecision.mock.calls[0][1]['采购人']).toBeUndefined();
  });
});
