import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import * as configuration from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PurchaseWorkflowService, type PurchaseWorkflowSession } from '../../server/modules/purchase-inventory/purchase-workflow.service';
import { resolvePurchaseWorkflowSession } from '../../server/modules/purchase-inventory/purchase-workflow-session';
import { PurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
import { serializePurchaseManagerApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-approval-card';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';
import { Test } from '@nestjs/testing';
import { PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import { PurchasePersonnelHandoverAdapter } from '../../server/modules/purchase-inventory/purchase-personnel-handover.adapter';
import type { HandoverContext } from '../../shared/personnel-handover.interface';
import { handoverItemMutationId } from '../../server/common/access/personnel-handover.store';

const appId='cli_synthetic_purchase_current';
const sourceId=`feishu-${feishuIdentityFingerprint(appId,'ou_source')}`;
const targetId=`feishu-${feishuIdentityFingerprint(appId,'ou_target')}`;
describe('采购原命令受理使用当前权限',()=>{
  let folder:string,parent:string,owner:string,savedApp:string|undefined,config:configuration.AccessConfigurationStore,native:PurchaseWorkflowStore,access:AccessConfigurationService;
  beforeEach(async()=>{
    savedApp=process.env.FEISHU_APP_ID;process.env.FEISHU_APP_ID=appId;
    parent=realpathSync(tmpdir());folder=mkdtempSync(join(parent,'nt-purchase-authority-'));owner=randomUUID();writeFileSync(join(folder,'.test-owner'),owner,{flag:'wx'});
    config=new configuration.AccessConfigurationStore(join(folder,'configuration.json'));jest.spyOn(configuration,'getAccessConfigurationStore').mockReturnValue(config);jest.spyOn(defaults,'defaultAccessAccounts').mockReturnValue({});
    await config.mutate(0,randomUUID(),'synthetic-seed',state=>{for(const [id,openId]of[[sourceId,'ou_source'],[targetId,'ou_target']])state.accounts[id]={id,kind:'feishu',name:'合成采购员',role:'purchase_admin',building:null,enabled:true,deleted:false,version:1,source:'configuration',appId,openId,identityHash:feishuIdentityFingerprint(appId,openId)};});
    access=new AccessConfigurationService();native=new PurchaseWorkflowStore(join(folder,'purchase.json'));
  });
  afterEach(async()=>{
    await native.onModuleDestroy();jest.restoreAllMocks();if(savedApp===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=savedApp;
    if(dirname(resolve(folder)).toLowerCase()!==resolve(parent).toLowerCase()||!/^nt-purchase-authority-[A-Za-z0-9]+$/.test(basename(folder))||lstatSync(folder).isSymbolicLink()||realpathSync(folder)!==folder||readFileSync(join(folder,'.test-owner'),'utf8')!==owner)throw Error('Owned fixture mismatch');
    for(const name of readdirSync(folder))if(!lstatSync(join(folder,name)).isFile()||lstatSync(join(folder,name)).isSymbolicLink())throw Error('Unsafe fixture');rmSync(folder,{recursive:true,force:false});
  });
  const session=(id=sourceId):PurchaseWorkflowSession=>({accessToken:'synthetic-not-a-real-token',openId:id===sourceId?'ou_source':'ou_target',userName:'合成采购员',accessRole:'purchase_admin',authenticationMode:'delegated-app',permissionPrincipal:access.currentPrincipal(id,1)!});
  const record=():PurchaseWorkflowRecord=>({recordId:'recSyntheticOrder',requestCode:'SYNTHETIC',status:'审批通过（待下单）',itemName:'合成备件',building:'B楼',specialty:'电气',requesterOpenId:'ou_requester',requesterName:'合成申请人',purchaserOpenId:'ou_source',purchaserName:'合成采购员',purchaseMethod:'综合采购',requestedQuantity:2,actualQuantity:null,actualAmount:null,paymentAttachmentTokens:[],receiptPhotoTokens:[],invoiceTokens:[],approvalCompleted:true,warehouseConfirmed:true,purchaseCompleted:false,receiptConfirmed:false,signer:'',receiptTime:null});
  async function revoke(){await config.mutate(config.read().revision,randomUUID(),'synthetic-revoke',state=>{state.accounts[sourceId].role='guest';state.accounts[sourceId].version++;});}
  function fixture(onResolve?:()=>Promise<void>,onWrite?:()=>Promise<void>){
    const current=record(),gateway={getTenantAccessTokenAsApp:jest.fn(async()=>'synthetic-not-a-real-token'),getExecutionRecordAsApp:jest.fn(async()=>structuredClone(current)),getExecutionRecord:jest.fn(async()=>structuredClone(current)),resolveUser:jest.fn(async(openId:string)=>{await onResolve?.();return{openId,name:'合成采购员',positions:['设施运维经理'],buildings:['B楼']};}),updateExecutionRecord:jest.fn(async(_id:string,fields:Record<string,unknown>)=>{await onWrite?.();Object.assign(current,{status:fields.采购流程,actualQuantity:fields.实际采购数量,actualAmount:fields.实际付款金额,purchaseCompleted:fields.采购完成,paymentAttachmentTokens:[]});}),sendTextNotification:jest.fn(async()=>{})};
    return{gateway,workflow:new PurchaseWorkflowService(gateway as never,native,undefined,access)};
  }
  const input={actualQuantity:2,actualAmount:100,paymentAttachmentTokens:[],note:'合成验收'};
  it.each(['purchase_executor','building_executor'] as const)('%s新流程按记录楼栋和专业找现任，不查旧组织负责人',async kind=>{
    await config.mutate(config.read().revision,randomUUID(),'synthetic-scoped-executor',state=>{state.personnelDutyAssignments={recExecutor:{appId,dutyRecordId:'recExecutor',kind,buildings:['B楼'],specialties:['电气'],version:1,startsAt:0,endsAt:null,confirmedBatchId:randomUUID(),members:[{personId:`local-external-${'a'.repeat(64)}`,recordId:'recTarget',openId:'ou_target',name:'合成现任'}]}};});
    const gateway=new PurchaseWorkflowGateway({} as never),scope={building:'B楼',specialty:'电气'};
    const scoped=gateway as unknown as {resolvePurchaseAdminAsApp(scope:{building:string;specialty:string}):Promise<{openId:string}>;resolveBuildingSupervisorAsApp(building:string,specialty:string):Promise<{openId:string}>;findComprehensivePurchaser(token:string,scope:{building:string;specialty:string}):Promise<{openId:string}>};
    expect((await(kind==='purchase_executor'?scoped.resolvePurchaseAdminAsApp(scope):scoped.resolveBuildingSupervisorAsApp('B楼','电气'))).openId).toBe('ou_target');
    if(kind==='purchase_executor')expect((await scoped.findComprehensivePurchaser('synthetic-not-a-real-token',scope)).openId).toBe('ou_target');
    const workflow=new PurchaseManagerApprovalService(gateway,native,undefined,undefined,undefined,access);
    expect((await(workflow as unknown as {resolveManagerDecisionPurchaser(record:PurchaseWorkflowRecord,choice:'comprehensive'|'building_self'):Promise<{openId:string}>}).resolveManagerDecisionPurchaser(record(),kind==='purchase_executor'?'comprehensive':'building_self')).openId).toBe('ou_target');
  });
  it('生产采购服务DI缺权限端口拒绝，显式端口与实际Config为同一实例',async()=>{
    const providers=[PurchaseWorkflowService,{provide:PurchaseWorkflowGateway,useValue:{}},{provide:PurchaseWorkflowStore,useValue:native}];
    await expect(Test.createTestingModule({providers}).compile()).rejects.toThrow();
    const module=await Test.createTestingModule({providers:[...providers,{provide:AccessConfigurationService,useValue:access}]}).compile();
    try{expect((module.get(PurchaseWorkflowService) as unknown as {accessConfiguration:AccessConfigurationService}).accessConfiguration).toBe(access);}finally{await module.close();}
  });
  it('普通角色的委托操作也携带实际登录账号和授权版本，不以应用操作人替代',async()=>{
    const saved=process.env.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID;process.env.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID='ou_app_operator';
    try{const value=await resolvePurchaseWorkflowSession({principal:access.currentPrincipal(sourceId,1)!,getTenantAccessToken:async()=>'synthetic-not-a-real-token'});expect(value.openId).toBe('ou_app_operator');expect(value.permissionPrincipal).toMatchObject({accountId:sourceId,authorizationVersion:1,role:'purchase_admin'});}
    finally{if(saved===undefined)delete process.env.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID;else process.env.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID=saved;}
  });
  it('异步人员读取期间收权，原账本认领之前拒绝旧人写入',async()=>{
    const before=session(),{gateway,workflow}=fixture(revoke);
    await expect(workflow.order('recSyntheticOrder',before,input)).rejects.toThrow('当前采购操作权限');
    expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();expect(await native.findCommand('order:recSyntheticOrder')).toBeNull();
  });
  it('原合法命令先认领后收权，保留原写入与回执，不重做采购',async()=>{
    const before=session(),{gateway,workflow}=fixture(undefined,revoke);
    await expect(workflow.order('recSyntheticOrder',before,input)).resolves.toMatchObject({idempotent:false});
    expect((await native.findCommand('order:recSyntheticOrder'))?.completedAt).toBeTruthy();
    await expect(workflow.order('recSyntheticOrder',before,input)).resolves.toMatchObject({idempotent:true});expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });
  it('新任可继续原采购记录，单独收权的旧人不能开启新命令',async()=>{
    await revoke();const {gateway,workflow}=fixture();
    await expect(workflow.order('recSyntheticOrder',session(targetId),input)).resolves.toMatchObject({idempotent:false});expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });
  it.each(['single','batch'] as const)('%s审批卡读取后岗位已交接，原受理锁拒绝旧卡新动作',async mode=>{
    const batchId='synthetic-current-manager-batch',messageId='om_synthetic_manager',recordId='recSyntheticOrder';
    const context=mode==='batch'?serializePurchaseManagerBatchApprovalCardContext({version:3,approvalBatchId:batchId,requesterName:'合成申请人',requesterOpenId:'ou_requester',building:'B楼',requestCode:'SYNTHETIC',expectedDeliveryAt:'2026-10-20',createdAt:'2026-10-16 09:00',items:[{executionRecordId:recordId,title:'合成备件',specification:'/',quantity:'1',unit:'件',amount:'100',status:'pending',choice:'',rejectionReason:''}]}):serializePurchaseManagerApprovalCardContext({executionRecordId:recordId,requester:'合成申请人',building:'B楼',title:'合成备件',quantity:1});
    if(mode==='batch')await native.registerManagerApprovalBatch({approvalBatchId:batchId,requesterOpenId:'ou_requester',recipientOpenId:'ou_source',recordIds:[recordId]});
    else await native.enqueueNotification({businessEventId:'synthetic-manager-single',recordId,recipientOpenId:'ou_source',kind:'manager_approval_requested',cardContext:context});
    const task=(await native.takeNextManagerApprovalNotification())!;expect(task).toBeTruthy();
    if(mode==='batch'){await native.markManagerApprovalBatchSendStarted(task.key,task.claimToken,context);await native.completeManagerApprovalBatchRequestAndRegisterCard(task.key,task.claimToken,{messageId});}
    else{await native.markManagerApprovalSendStarted(task.key,task.claimToken,context);await native.completeManagerApprovalRequestAndRegisterCard(task.key,task.claimToken,{messageId});}
    const transfer=async()=>config.mutate(config.read().revision,randomUUID(),'synthetic-manager-transfer',state=>{state.personnelDutyAssignments={recManager:{appId,dutyRecordId:'recManager',kind:'purchase_manager',buildings:null,specialties:null,version:1,startsAt:0,endsAt:null,confirmedBatchId:randomUUID(),members:[{personId:`local-external-${'a'.repeat(64)}`,recordId:'recTarget',openId:'ou_target',name:'合成现任'}]}};});
    let restoreRead=()=>{};
    if(mode==='batch'){const original=native.findManagerApprovalBatchCard.bind(native),intercept=jest.spyOn(native,'findManagerApprovalBatchCard').mockImplementation(async(...args)=>{const card=await original(...args);await transfer();return card;});restoreRead=()=>intercept.mockRestore();}
    else{const original=native.findManagerApprovalCard.bind(native),intercept=jest.spyOn(native,'findManagerApprovalCard').mockImplementation(async(...args)=>{const card=await original(...args);await transfer();return card;});restoreRead=()=>intercept.mockRestore();}
    const before=readFileSync(join(folder,'purchase.json'),'utf8'),service=new PurchaseManagerApprovalService({} as never,native,undefined,undefined,undefined,access);jest.spyOn(service,'isEnabled').mockReturnValue(true);
    const action={eventId:`synthetic-${mode}-stale-action`,operatorOpenId:'ou_source',messageId};
    const work=mode==='batch'?service.handleManagerBatchCardAction({...action,kind:'manager_batch_action',action:'approve_pending_comprehensive',approvalBatchId:batchId}):service.handleManagerCardAction({...action,kind:'manager_action',action:'choose_comprehensive',executionRecordId:recordId});
    await expect(work).rejects.toThrow('当前采购岗位');expect(readFileSync(join(folder,'purchase.json'),'utf8')).toBe(before);
    restoreRead();
    await config.mutate(config.read().revision,randomUUID(),'synthetic-manager-original-current',state=>{state.personnelDutyAssignments!.recManager.members=[{personId:`local-external-${'b'.repeat(64)}`,recordId:'recSource',openId:'ou_source',name:'合成原经理'}];});
    const legalAction={...action,eventId:`synthetic-${mode}-accepted-action`};
    const submit=()=>mode==='batch'?service.handleManagerBatchCardAction({...legalAction,kind:'manager_batch_action',action:'approve_pending_comprehensive',approvalBatchId:batchId}):service.handleManagerCardAction({...legalAction,kind:'manager_action',action:'choose_comprehensive',executionRecordId:recordId});
    const response=await submit(),acceptedBytes=readFileSync(join(folder,'purchase.json'),'utf8');await transfer();
    expect(await submit()).toEqual(response);expect(readFileSync(join(folder,'purchase.json'),'utf8')).toBe(acceptedBytes);
  });
  it.each(['normal','failure','return','scope_conflict'] as const)('%s旧单条经理审批纳入同一批次，旧卡停用且现任新卡实际投递后才完成',async mode=>{
    const recordId='recSyntheticOrder',messageId='om_single_old',batch='771941c4-170e-45cd-ab18-dbc60c5e38e4';
    const cardContext=serializePurchaseManagerApprovalCardContext({executionRecordId:recordId,requester:'合成申请人',building:'B楼',title:'合成备件',quantity:2,requestCode:'SYNTHETIC'});
    await native.enqueueNotification({businessEventId:'synthetic-old-single',recordId,recipientOpenId:'ou_source',kind:'manager_approval_requested',cardContext});
    const task=(await native.takeNextManagerApprovalNotification())!;await native.markManagerApprovalSendStarted(task.key,task.claimToken,cardContext);await native.completeManagerApprovalRequestAndRegisterCard(task.key,task.claimToken,{messageId});
    const from={id:`local-external-${'b'.repeat(64)}`,recordId:'recSource',name:'合成前任',openId:'ou_source',active:true,type:'employee' as const,position:'设施运维经理',systemPosition:'',buildings:['B楼' as const],specialties:[],permissionTags:[],dutyRecordIds:['recManager']};
    const context:HandoverContext={from,to:{...from,id:`local-external-${'a'.repeat(64)}`,recordId:'recTarget',name:'合成现任',openId:'ou_target'},directoryVersion:'c'.repeat(64),duties:[{recordId:'recManager',name:'采购经理审批',kind:'purchase_manager',personnelIds:[from.id],buildings:null,specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1}]};
    await config.mutate(config.read().revision,randomUUID(),'synthetic-single-manager-transfer',state=>{state.personnelDutyAssignments={recManager:{appId,dutyRecordId:'recManager',kind:'purchase_manager',buildings:null,specialties:null,version:1,startsAt:0,endsAt:null,confirmedBatchId:batch,members:[{personId:context.to.id,recordId:context.to.recordId,openId:'ou_target',name:context.to.name}]}};});
    const gateway={getExecutionRecordAsApp:jest.fn(async()=>({...record(),status:'未开始（待审批）',approvalCompleted:false})),sendInteractiveCard:jest.fn(async(_recipient:string,_card:unknown,_uuid?:string)=> 'om_single_new'),updateInteractiveCard:jest.fn(async()=>{})};
    let workflow=new PurchaseManagerApprovalService(gateway as never,native,undefined,undefined,undefined,access);jest.spyOn(workflow,'isEnabled').mockReturnValue(true);
    let adapter=new PurchasePersonnelHandoverAdapter(native,access,workflow);const item=(await adapter.listPending(context)).find(row=>row.stageKey==='single_manager')!;expect(item).toBeDefined();
    const mutation=handoverItemMutationId(batch,item.key),receipt=await adapter.acceptTransfer(context,item,mutation);expect(await adapter.reconcile(context,receipt)).toEqual({status:'syncing'});
    const bytes=readFileSync(join(folder,'purchase.json'),'utf8');expect(await adapter.acceptTransfer(context,item,mutation)).toEqual(receipt);expect(readFileSync(join(folder,'purchase.json'),'utf8')).toBe(bytes);
    await native.onModuleDestroy();native=new PurchaseWorkflowStore(join(folder,'purchase.json'));workflow=new PurchaseManagerApprovalService(gateway as never,native,undefined,undefined,undefined,access);jest.spyOn(workflow,'isEnabled').mockReturnValue(true);adapter=new PurchasePersonnelHandoverAdapter(native,access,workflow);
    expect(await adapter.acceptTransfer(context,item,mutation)).toEqual(receipt);expect(readFileSync(join(folder,'purchase.json'),'utf8')).toBe(bytes);
    expect(await adapter.reconcile({...context,to:{...context.to,recordId:'recDifferent'}},receipt)).toMatchObject({status:'error'});expect(await adapter.reconcile(context,{...receipt,version:'f'.repeat(64)})).toMatchObject({status:'error'});
    if(mode==='failure')gateway.updateInteractiveCard.mockRejectedValueOnce(new Error('synthetic old card patch failed'));
    if(mode==='scope_conflict')gateway.getExecutionRecordAsApp.mockResolvedValueOnce({...record(),status:'未开始（待审批）',approvalCompleted:false,building:'A楼'});
    const result=await workflow.runPendingTasks(5);
    if(mode==='failure'||mode==='scope_conflict'){
      expect(result.failed).toBe(1);expect(await adapter.reconcile(context,receipt)).toMatchObject({status:'error'});
      if(mode==='failure')expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);else expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
      if(mode==='failure'){
        const exhausted=(await native.takeNextManagerApprovalNotification(new Date(Date.now()+31*60_000)))!;
        expect(exhausted.kind).toBe('manager_approval_transferred');await native.failNotification(exhausted.key,exhausted.claimToken,'synthetic retries exhausted');
        const failedBytes=readFileSync(join(folder,'purchase.json'),'utf8');
        expect(await adapter.reconcile({...context,to:{...context.to,recordId:'recDifferent'}},receipt,{retryFailed:true})).toMatchObject({status:'error'});expect(readFileSync(join(folder,'purchase.json'),'utf8')).toBe(failedBytes);
        expect(await adapter.reconcile(context,receipt,{retryFailed:true})).toMatchObject({status:'syncing'});
      }
      expect((await workflow.runPendingTasks(5,new Date(Date.now()+31*60_000))).errors).toEqual([]);
    }else expect(result.errors).toEqual([]);
    expect(gateway.updateInteractiveCard).toHaveBeenCalledWith(messageId,expect.anything());expect(gateway.sendInteractiveCard.mock.calls[0][0]).toBe('ou_target');expect(await adapter.reconcile(context,receipt)).toEqual({status:'success'});expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    if(mode==='normal'){
      const file=join(folder,'purchase.json'),original=readFileSync(file,'utf8');
      try{const tampered=JSON.parse(original),source=tampered.managerApprovalCards.find((card:{recipientOpenId:string})=>card.recipientOpenId==='ou_source');source.personnelHandover.targetPersonRecordId='recForeign';writeFileSync(file,JSON.stringify(tampered));expect(await adapter.reconcile(context,receipt)).toMatchObject({status:'error'});source.personnelHandover.mutationId='invalid';writeFileSync(file,JSON.stringify(tampered));await expect(native.singleManagerHandoverSnapshot()).rejects.toThrow();}finally{writeFileSync(file,original);}
      const ledger=JSON.parse(readFileSync(file,'utf8')),sample=ledger.notifications[0];
      ledger.notifications.push(...Array.from({length:600},(_,index)=>({...structuredClone(sample),kind:'purchase_completed',businessEventId:`synthetic-unrelated-history-${index}`,recordId:`recHistory${index}`,recipientOpenId:'ou_unrelated',deliveryAudit:[],cardContext:''})));writeFileSync(file,JSON.stringify(ledger));
      expect(await adapter.reconcile(context,receipt)).toEqual({status:'success'});
    }
    const beforeOld=readFileSync(join(folder,'purchase.json'),'utf8'),old=await workflow.handleManagerCardAction({kind:'manager_action',action:'choose_comprehensive',executionRecordId:recordId,messageId,operatorOpenId:'ou_source',eventId:'synthetic-superseded-single-action'});expect(JSON.stringify(old)).toContain('已转交');expect(JSON.stringify(old)).not.toContain('"type":"callback"');expect(readFileSync(join(folder,'purchase.json'),'utf8')).toBe(beforeOld);
    if(mode==='return'){
      const returned:HandoverContext={...context,from:context.to,to:context.from,duties:context.duties.map(duty=>({...duty,personnelIds:[context.to.id]}))},nextBatch='dffed6f2-24d8-4ce9-9d91-c66fb7e6282a',nextItem=(await adapter.listPending(returned)).find(row=>row.stageKey==='single_manager')!;expect(nextItem).toBeDefined();
      await config.mutate(config.read().revision,randomUUID(),'synthetic-manager-return',state=>{Object.assign(state.personnelDutyAssignments!.recManager,{confirmedBatchId:nextBatch,members:[{personId:from.id,recordId:from.recordId,openId:from.openId,name:from.name}]});});
      const returnedReceipt=await adapter.acceptTransfer(returned,nextItem,handoverItemMutationId(nextBatch,nextItem.key));gateway.sendInteractiveCard.mockResolvedValueOnce('om_single_return');expect((await workflow.runPendingTasks(5)).errors).toEqual([]);expect(await adapter.reconcile(returned,returnedReceipt)).toEqual({status:'success'});
      const returnedBytes=readFileSync(join(folder,'purchase.json'),'utf8');await expect(workflow.handleManagerCardAction({kind:'manager_action',action:'choose_comprehensive',executionRecordId:recordId,messageId,operatorOpenId:'ou_source',eventId:'synthetic-superseded-original-return'})).rejects.toThrow();expect(readFileSync(join(folder,'purchase.json'),'utf8')).toBe(returnedBytes);
    }
    const actor=mode==='return'?'ou_source':'ou_target',activeMessage=mode==='return'?'om_single_return':'om_single_new';
    await workflow.handleManagerCardAction({kind:'manager_action',action:'choose_comprehensive',executionRecordId:recordId,messageId:activeMessage,operatorOpenId:actor,eventId:'synthetic-new-single-action'});expect((await native.singleManagerHandoverSnapshot()).actions.find(action=>action.eventId==='synthetic-new-single-action')?.actorOpenId).toBe(actor);
  });
  it.each([['comprehensive',true,false],['building_self',true,false],['comprehensive',false,false],['comprehensive',true,true]] as const)('%s采购执行卡查验期间改岗，原受理锁不让旧执行人新下单（应用绑定：%s，专业限定：%s）',async(choice,bound,scoped)=>{
    const batchId='synthetic-fulfillment-current',recordId='recSyntheticOrder';
    await native.registerManagerApprovalBatch({approvalBatchId:batchId,requesterOpenId:'ou_requester',recipientOpenId:'ou_source',recordIds:[recordId]});
    let task=(await native.takeNextManagerApprovalNotification())!;
    const context=serializePurchaseManagerBatchApprovalCardContext({version:3,approvalBatchId:batchId,requesterName:'合成申请人',requesterOpenId:'ou_requester',building:'B楼',requestCode:'SYNTHETIC',expectedDeliveryAt:'2026-10-20',createdAt:'2026-10-16 09:00',items:[{executionRecordId:recordId,title:'合成备件',specification:'/',quantity:'1',unit:'件',amount:'100',status:'pending',choice:'',rejectionReason:''}]});
    await native.markManagerApprovalBatchSendStarted(task.key,task.claimToken,context);await native.completeManagerApprovalBatchRequestAndRegisterCard(task.key,task.claimToken,{messageId:'om_approved_manager'});
    await native.claimManagerApprovalBatchPendingApproval({eventId:'synthetic-fulfillment-approved',approvalBatchId:batchId,choice,messageId:'om_approved_manager',actorOpenId:'ou_source'});
    const action=(await native.takeNextManagerApprovalBatchAction())!,purchaser={purchaserOpenId:'ou_source',purchaserName:'合成采购员',...(scoped?{authorityTarget:{building:'B楼' as const,specialty:'电气' as const}}:{})};await native.completeManagerApprovalBatchActionRecord(action.key,action.claimToken,recordId,purchaser);
    for(;;){task=(await native.takeNextManagerApprovalNotification())!;expect(task).toBeTruthy();if(task.kind==='manager_batch_purchase_assigned')break;await native.completeNotification(task.key,task.claimToken,{messageId:'om_synthetic_result'});}
    await native.markManagerApprovalBatchSendStarted(task.key,task.claimToken,(await native.findManagerApprovalBatch(batchId))!.cardContext);await native.completeNotification(task.key,task.claimToken,{messageId:'om_purchase_assignment'});
    const original=native.getPurchaseBatchForFulfillmentCard.bind(native),intercept=jest.spyOn(native,'getPurchaseBatchForFulfillmentCard').mockImplementation(async(...args)=>{const value=await original(...args);await config.mutate(config.read().revision,randomUUID(),'synthetic-executor-transfer',state=>{state.personnelDutyAssignments={recExecutor:{appId,dutyRecordId:'recExecutor',kind:choice==='comprehensive'?'purchase_executor':'building_executor',buildings:['B楼'],specialties:scoped?['电气']:null,version:1,startsAt:0,endsAt:null,confirmedBatchId:randomUUID(),members:[{personId:`local-external-${'a'.repeat(64)}`,recordId:'recTarget',openId:'ou_target',name:'合成现任'}]}};});return value;});
    const before=readFileSync(join(folder,'purchase.json'),'utf8'),service=new PurchaseManagerApprovalService({} as never,native,undefined,undefined,undefined,access);jest.spyOn(service,'isEnabled').mockReturnValue(true);
    await expect(service.handlePurchaseBatchFulfillmentCardAction({kind:'purchase_batch_fulfillment_action',action:'submit_order',approvalBatchId:batchId,executionRecordId:recordId,eventId:'synthetic-old-executor-order',operatorOpenId:'ou_source',messageId:'om_purchase_assignment',actualQuantity:1,actualAmount:100,note:'合成验收'})).rejects.toThrow('当前采购岗位');
    expect(readFileSync(join(folder,'purchase.json'),'utf8')).toBe(before);
    intercept.mockRestore();await config.mutate(config.read().revision,randomUUID(),'synthetic-executor-accepted-first',state=>{state.personnelDutyAssignments!.recExecutor.members=[{personId:`local-external-${'b'.repeat(64)}`,recordId:'recSource',openId:'ou_source',name:'合成原执行人'}];});
    expect((await service.handlePurchaseBatchFulfillmentCardAction({kind:'purchase_batch_fulfillment_action',action:'submit_order',approvalBatchId:batchId,executionRecordId:recordId,eventId:'synthetic-accepted-executor-order',operatorOpenId:'ou_source',messageId:'om_purchase_assignment',actualQuantity:2,actualAmount:100,note:'合成验收'})).claimed).toBe(true);
    await config.mutate(config.read().revision,randomUUID(),'synthetic-revoke-accepted-card-command',state=>{state.accounts[sourceId].enabled=false;state.accounts[sourceId].version++;});
    if(!bound){await native.onModuleDestroy();const file=join(folder,'purchase.json'),ledger=JSON.parse(readFileSync(file,'utf8'));for(const notification of ledger.notifications)if(notification.kind==='manager_batch_order_command')delete notification.acceptedAppId;writeFileSync(file,JSON.stringify(ledger));native=new PurchaseWorkflowStore(file);}
    let queued=(await native.takeNextManagerApprovalNotification())!;expect(queued.kind).toBe('manager_batch_order_command');expect(queued.acceptedAppId).toBe(bound?appId:undefined);
    const {gateway,workflow}=fixture();jest.spyOn(workflow,'isEnabled').mockReturnValue(true);
    if(!bound){
      const proof={notificationKey:queued.key,claimToken:queued.claimToken},beforeBinding=readFileSync(join(folder,'purchase.json'),'utf8');
      for(const changed of[{...record(),purchaserOpenId:'ou_other_application'},{...record(),building:'A楼'},{...record(),recordId:'recOther'}])await expect(native.bindLegacyFulfillmentApplication(proof,changed,appId)).rejects.toThrow('未核对');
      await expect(native.bindLegacyFulfillmentApplication(proof,record(),'cli_synthetic_other')).rejects.toThrow('应用身份');
      await expect(native.bindLegacyFulfillmentApplication({...proof,claimToken:'synthetic-wrong-claim'},record(),appId)).rejects.toThrow('领取凭证');
      expect(readFileSync(join(folder,'purchase.json'),'utf8')).toBe(beforeBinding);
    }
    if(bound){
    const proof={notificationKey:queued.key,claimToken:queued.claimToken},acceptedInput={actualQuantity:2,actualAmount:100,paymentAttachmentTokens:[],note:'合成验收'};
    await expect(workflow.orderFromCard(recordId,'ou_source',acceptedInput,{...proof,notificationKey:'synthetic-not-a-real-command'})).rejects.toThrow('原采购受理命令');
    await expect(workflow.orderFromCard(recordId,'ou_source',acceptedInput,{...proof,claimToken:'synthetic-not-a-real-lease'})).rejects.toThrow('领取凭证');
    await expect(workflow.orderFromCard(recordId,'ou_target',acceptedInput,proof)).rejects.toThrow('身份不一致');
    await expect(workflow.orderFromCard(recordId,'ou_source',{...acceptedInput,actualAmount:101},proof)).rejects.toThrow('不能替换原命令');
    try{process.env.FEISHU_APP_ID='cli_synthetic_other';await expect(workflow.orderFromCard(recordId,'ou_source',acceptedInput,proof)).rejects.toThrow('应用身份');}finally{process.env.FEISHU_APP_ID=appId;}
    gateway.getExecutionRecord.mockResolvedValueOnce({...record(),building:'A楼'});await expect(workflow.orderFromCard(recordId,'ou_source',acceptedInput,proof)).rejects.toThrow('原受理采购范围');
    if(scoped){gateway.getExecutionRecord.mockResolvedValueOnce({...record(),specialty:'暖通'});await expect(workflow.orderFromCard(recordId,'ou_source',acceptedInput,proof)).rejects.toThrow('原受理采购范围');}
    gateway.getExecutionRecord.mockImplementationOnce(async()=>{await native.rescheduleNotification(queued.key,queued.claimToken,'synthetic lease changed',new Date());return record();});
    await expect(workflow.orderFromCard(recordId,'ou_source',acceptedInput,proof)).rejects.toThrow('领取凭证');expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();expect(await native.findCommand(`order:${recordId}`)).toBeNull();
    queued=(await native.takeNextManagerApprovalNotification())!;expect(queued.claimToken).not.toBe(proof.claimToken);
    }
    gateway.resolveUser.mockRejectedValue(new Error('synthetic source is no longer in directory'));
    const worker=new PurchaseManagerApprovalService(gateway as never,native,undefined,workflow,undefined,access),result={processed:0,failed:0,manualReconciliation:0,alerts:[] as string[],errors:[] as string[]};
    const processed=await (worker as unknown as {processPurchaseBatchFulfillmentCommand(task:unknown,now:Date,state:typeof result):Promise<boolean>}).processPurchaseBatchFulfillmentCommand(queued,new Date(),result);expect(result.errors).toEqual([]);expect(processed).toBe(true);
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);expect(gateway.resolveUser).not.toHaveBeenCalled();expect((await native.findCommand(`order:${recordId}`))?.completedAt).toBeTruthy();
  });
  it.each(['normal','building_self','failed_write','write_unknown','accepted_before','return'] as const)('%s按楼栋专业批量接办未下单明细，原队列恢复且旧卡保留其他职责',async mode=>{
    const batchId='synthetic-executor-handover',recordId='recSyntheticOrder',otherId='recOtherSpecialty',batch='88f09d32-0cff-429d-b7a9-918e401180eb';
    const choice=mode==='building_self'?'building_self':'comprehensive',kind=mode==='building_self'?'building_executor':'purchase_executor';
    await native.registerManagerApprovalBatch({approvalBatchId:batchId,requesterOpenId:'ou_requester',recipientOpenId:'ou_manager',recordIds:[recordId,otherId]});
    const contextText=serializePurchaseManagerBatchApprovalCardContext({version:3,approvalBatchId:batchId,requesterName:'合成申请人',requesterOpenId:'ou_requester',building:'B楼',requestCode:'SYNTHETIC',expectedDeliveryAt:'2026-10-20',createdAt:'2026-10-16 09:00',items:[recordId,otherId].map(executionRecordId=>({executionRecordId,title:'合成备件',specification:'/',quantity:'2',unit:'件',amount:'100',status:'pending',choice:'',rejectionReason:''}))});
    let task=(await native.takeNextManagerApprovalNotification())!;await native.markManagerApprovalBatchSendStarted(task.key,task.claimToken,contextText);await native.completeManagerApprovalBatchRequestAndRegisterCard(task.key,task.claimToken,{messageId:'om_synthetic_manager'});
    await native.claimManagerApprovalBatchPendingApproval({eventId:'synthetic-approved',approvalBatchId:batchId,choice,messageId:'om_synthetic_manager',actorOpenId:'ou_manager'});
    const action=(await native.takeNextManagerApprovalBatchAction())!;
    for(const id of[recordId,otherId])await native.completeManagerApprovalBatchActionRecord(action.key,action.claimToken,id,{purchaserOpenId:'ou_source',purchaserName:'合成前任',authorityTarget:{building:'B楼',specialty:id===recordId?'电气':'暖通'}});
    for(;;){task=(await native.takeNextManagerApprovalNotification())!;expect(task).toBeTruthy();if(task.kind==='manager_batch_purchase_assigned')break;await native.completeNotification(task.key,task.claimToken,{messageId:'om_synthetic_result'});}
    await native.markManagerApprovalBatchSendStarted(task.key,task.claimToken,(await native.findManagerApprovalBatch(batchId))!.cardContext);await native.completeNotification(task.key,task.claimToken,{messageId:'om_synthetic_old_executor'});
    const from={id:`local-external-${'b'.repeat(64)}`,recordId:'recSource',name:'合成前任',openId:'ou_source',active:true,type:'employee' as const,position:'综合管理',systemPosition:'',buildings:['B楼' as const],specialties:['电气' as const],permissionTags:[],dutyRecordIds:['recExecutor']};
    const context:HandoverContext={from,to:{...from,id:`local-external-${'a'.repeat(64)}`,recordId:'recTarget',name:'合成现任',openId:'ou_target'},directoryVersion:'c'.repeat(64),duties:[{recordId:'recExecutor',name:'B楼电气采购执行',kind,personnelIds:[from.id],buildings:['B楼'],specialties:['电气'],enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1}]};
    const records=new Map<string,PurchaseWorkflowRecord>([recordId,otherId].map(id=>[id,{...record(),recordId:id,purchaseMethod:choice==='building_self'?'需求自采':'综合采购',specialty:id===recordId?'电气':'暖通'}]));
    const gateway=new PurchaseWorkflowGateway({} as never);
    jest.spyOn(gateway,'getExecutionRecordAsApp').mockImplementation(async id=>({...records.get(id)!}));
    const write=jest.spyOn(gateway,'updateExecutionRecordAsApp').mockImplementation(async(id,fields)=>{Object.assign(records.get(id)!,{purchaserOpenId:(fields.采购人 as {id:string}[])[0].id,purchaserName:'合成现任'});if(mode==='write_unknown'&&write.mock.calls.length===1)throw new Error('synthetic response lost after write');});
    const send=jest.spyOn(gateway,'sendInteractiveCard').mockResolvedValue('om_synthetic_new_executor');jest.spyOn(gateway,'updateInteractiveCard').mockResolvedValue(undefined);
    const ports={getExecutionRecordAsApp:gateway.getExecutionRecordAsApp.bind(gateway),writePurchaseExecutorHandover:gateway.writePurchaseExecutorHandover.bind(gateway),sendInteractiveCard:gateway.sendInteractiveCard.bind(gateway),updateInteractiveCard:gateway.updateInteractiveCard.bind(gateway)};
    let worker=new PurchaseManagerApprovalService(ports as never,native,undefined,undefined,undefined,access);jest.spyOn(worker,'isEnabled').mockReturnValue(true);
    let adapter=new PurchasePersonnelHandoverAdapter(native,access,worker,ports as never);
    const items=await adapter.listPending(context);expect(items.filter(row=>row.stageKey===kind).map(row=>row.recordId)).toEqual([recordId]);const item=items.find(row=>row.stageKey===kind)!;
    expect(await adapter.preflight(context,item)).toEqual({ready:true});
    const command=(id=recordId,actorOpenId='ou_source')=>({version:4 as const,workflowType:'purchase_batch_fulfillment' as const,action:'order' as const,approvalBatchId:batchId,executionRecordId:id,actorOpenId,actualQuantity:2,actualAmount:100,paymentAttachmentTokens:[],note:''});
    if(mode==='accepted_before')await native.claimPurchaseBatchFulfillmentCommand({approvalBatchId:batchId,messageId:'om_synthetic_old_executor',actorOpenId:'ou_source',role:'purchaser'},command(),'synthetic-legal-before-transfer',new Date(),()=>{});
    await config.mutate(config.read().revision,randomUUID(),'synthetic-executor-handover',state=>{state.personnelDutyAssignments={recExecutor:{appId,dutyRecordId:'recExecutor',kind,buildings:['B楼'],specialties:['电气'],version:1,startsAt:0,endsAt:null,confirmedBatchId:batch,members:[{personId:context.to.id,recordId:context.to.recordId,openId:context.to.openId!,name:context.to.name}]}};});
    const mutation=handoverItemMutationId(batch,item.key),receipt=await adapter.acceptTransfer(context,item,mutation);
    if(mode==='accepted_before'){expect(receipt.status).toBe('already_completed');expect(await adapter.reconcile(context,receipt)).toEqual({status:'success'});expect((await native.findManagerApprovalBatch(batchId))!.items[0].purchaserOpenId).toBe('ou_source');expect(write).not.toHaveBeenCalled();return;}
    expect(await adapter.reconcile(context,receipt)).toEqual({status:'syncing'});
    await expect(native.claimPurchaseBatchFulfillmentCommand({approvalBatchId:batchId,messageId:'om_synthetic_old_executor',actorOpenId:'ou_source',role:'purchaser'},command(),'synthetic-old-action')).rejects.toThrow('已转交');
    await native.onModuleDestroy();native=new PurchaseWorkflowStore(join(folder,'purchase.json'));worker=new PurchaseManagerApprovalService(ports as never,native,undefined,undefined,undefined,access);jest.spyOn(worker,'isEnabled').mockReturnValue(true);adapter=new PurchasePersonnelHandoverAdapter(native,access,worker,ports as never);
    const bytes=readFileSync(join(folder,'purchase.json'),'utf8');expect(await adapter.acceptTransfer(context,item,mutation)).toEqual(receipt);expect(readFileSync(join(folder,'purchase.json'),'utf8')).toBe(bytes);
    if(mode==='failed_write')write.mockRejectedValueOnce(new Error('synthetic write rejected before persistence'));
    const run=await worker.runPendingTasks(10);if(mode==='failed_write'){expect(run.failed).toBe(1);expect(await adapter.reconcile(context,receipt)).toMatchObject({status:'error'});expect(send).not.toHaveBeenCalled();expect((await worker.runPendingTasks(10,new Date(Date.now()+31*60_000))).errors).toEqual([]);}else expect(run.errors).toEqual([]);
    expect(await adapter.reconcile(context,receipt)).toEqual({status:'success'});
    expect(write).toHaveBeenCalledTimes(mode==='failed_write'?2:1);expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][0]).toBe('ou_target');expect(gateway.updateInteractiveCard).toHaveBeenCalledWith('om_synthetic_old_executor',expect.anything());
    expect((await native.findManagerApprovalBatch(batchId))!.items.map(row=>[row.executionRecordId,row.purchaserOpenId])).toEqual([[recordId,'ou_target'],[otherId,'ou_source']]);
    if(mode==='return'){
      const returned={...context,from:context.to,to:context.from,duties:context.duties.map(duty=>({...duty,personnelIds:[context.to.id]}))},nextBatch='6a4f25a7-99be-4ddb-a7b0-8e9502d8b970',next=(await adapter.listPending(returned)).find(row=>row.recordId===recordId)!;
      await config.mutate(config.read().revision,randomUUID(),'synthetic-executor-return',state=>{Object.assign(state.personnelDutyAssignments!.recExecutor,{confirmedBatchId:nextBatch,members:[{personId:from.id,recordId:from.recordId,openId:from.openId,name:from.name}]});});
      send.mockResolvedValueOnce('om_synthetic_returned_executor');const returnedReceipt=await adapter.acceptTransfer(returned,next,handoverItemMutationId(nextBatch,next.key));
      expect((await worker.runPendingTasks(10)).errors).toEqual([]);expect(await adapter.reconcile(returned,returnedReceipt)).toEqual({status:'success'});
      await expect(native.claimPurchaseBatchFulfillmentCommand({approvalBatchId:batchId,messageId:'om_synthetic_old_executor',actorOpenId:'ou_source',role:'purchaser'},command(),'synthetic-stale-returned-card')).rejects.toThrow('已转交');
      const oldView=await worker.handlePurchaseBatchFulfillmentCardAction({kind:'purchase_batch_fulfillment_action',eventId:'synthetic-return-list',operatorOpenId:'ou_source',messageId:'om_synthetic_old_executor',action:'return_purchase_list',approvalBatchId:batchId,executionRecordId:otherId});expect(JSON.stringify(oldView.card)).not.toContain(recordId);expect(JSON.stringify(oldView.card)).toContain(otherId);
      const terminal=jest.mocked(gateway.updateInteractiveCard).mock.calls.find(([id])=>id==='om_synthetic_new_executor')![1];expect(JSON.stringify(terminal)).toContain('采购任务已转交');expect(JSON.stringify(terminal)).not.toContain('"type":"callback"');
    }
    if(mode==='normal'){
      const file=join(folder,'purchase.json'),ledger=JSON.parse(readFileSync(file,'utf8')),sample=ledger.notifications[0];ledger.notifications.push(...Array.from({length:600},(_,index)=>({...structuredClone(sample),kind:'purchase_completed',businessEventId:`synthetic-executor-history-${index}`,recordId:`recHistory${index}`,recipientOpenId:'ou_unrelated',deliveryAudit:[],cardContext:''})));writeFileSync(file,JSON.stringify(ledger));
      await native.enqueueNotification({businessEventId:'synthetic-trigger-native-trim',recordId:'recSyntheticTrim',recipientOpenId:'ou_unrelated',kind:'purchase_completed'});expect(await adapter.reconcile(context,receipt)).toEqual({status:'success'});
      const original=readFileSync(file,'utf8');try{const changed=JSON.parse(original);changed.managerApprovalBatches[0].items[0].executorHandover.recordId='recForeign';writeFileSync(file,JSON.stringify(changed));await expect(native.executorHandoverSnapshot()).rejects.toThrow('标记与明细不一致');}finally{writeFileSync(file,original);}
    }
    const currentActor=mode==='return'?'ou_source':'ou_target',messageId=mode==='return'?'om_synthetic_returned_executor':'om_synthetic_new_executor';
    expect((await worker.handlePurchaseBatchFulfillmentCardAction({kind:'purchase_batch_fulfillment_action',eventId:'synthetic-current-new-command',operatorOpenId:currentActor,messageId,action:'submit_order',approvalBatchId:batchId,executionRecordId:recordId,actualQuantity:2,actualAmount:100,note:''})).claimed).toBe(true);
    expect((await worker.handlePurchaseBatchFulfillmentCardAction({kind:'purchase_batch_fulfillment_action',eventId:'synthetic-other-duty-command',operatorOpenId:'ou_source',messageId:'om_synthetic_old_executor',action:'submit_order',approvalBatchId:batchId,executionRecordId:otherId,actualQuantity:2,actualAmount:100,note:''})).claimed).toBe(true);
  });
  it.each(['race','accepted','handover','lost_write','co_role','send_retry','return'] as const)('%s旧版审批新动作核当前岗位，已受理动作在收权后仍沿原队列执行',async mode=>{
    const recordId='recSyntheticOrder',current={...record(),status:'未开始（待审批）',approvalCompleted:false,warehouseConfirmed:false,purchaserOpenId:'',purchaserName:''};
    await native.enqueueNotification({businessEventId:'synthetic-legacy-approval',recordId,recipientOpenId:'ou_source',kind:'approval_requested'});
    const notification=(await native.takeNextNotification())!;await native.completeNotification(notification.key,notification.claimToken,{messageId:'om_synthetic_legacy'});
    const handoverBatch='1cbe42ea-ef02-4b2c-ab18-84d47c0fcaa1';
    async function transfer(){await config.mutate(config.read().revision,randomUUID(),'synthetic-legacy-role-transfer',state=>{state.personnelDutyAssignments={recApprover:{appId,dutyRecordId:'recApprover',kind:'purchase_approver',buildings:['B楼'],specialties:['电气'],version:1,startsAt:0,endsAt:null,confirmedBatchId:handoverBatch,members:[{personId:`local-external-${'a'.repeat(64)}`,recordId:'recTarget',openId:'ou_target',name:'合成现任'}]}};});}
    let moved=false;
    let responseLost=false;
    const gateway={getExecutionRecordAsApp:jest.fn(async()=>structuredClone(current)),resolveConfiguredApproversAsApp:jest.fn(async()=>{if(mode==='race'&&!moved){moved=true;await transfer();}return[{openId:'ou_source',name:'合成前任',positions:[],buildings:[]}];}),resolvePurchaseAdminAsApp:jest.fn(async()=>({openId:'ou_buyer',name:'合成采购员',positions:['综合管理'],buildings:['B楼']})),updateExecutionRecordAsApp:jest.fn(async(_id:string,fields:Record<string,unknown>)=>{Object.assign(current,{status:fields.采购流程,approvalCompleted:fields.审批完成,warehouseConfirmed:fields.库房确认,purchaserOpenId:(fields.采购人 as {id:string}[]|undefined)?.[0].id||'',purchaserName:'合成采购员'});if(mode==='lost_write'&&!responseLost){responseLost=true;throw new Error('synthetic write completed but response lost');}}),listExecutionRecordsAsApp:jest.fn(async()=>[]),sendInteractiveCard:jest.fn(async()=> 'om_synthetic_legacy_new'),updateInteractiveCard:jest.fn(async()=>{})};
    let workflow=new PurchaseWorkflowService(gateway as never,native,undefined,access);jest.spyOn(workflow,'isEnabled').mockReturnValue(true);
    const input={eventId:'synthetic-legacy-fresh',recordId,action:'approve' as const,actorOpenId:'ou_source',deliveryMessageId:'om_synthetic_legacy'},before=readFileSync(join(folder,'purchase.json'),'utf8');
    if(mode==='race'){await expect(workflow.acceptApprovalCardAction(input)).rejects.toThrow('当前采购审批岗位');expect(readFileSync(join(folder,'purchase.json'),'utf8')).toBe(before);expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();return;}
    if(['handover','co_role','send_retry','return'].includes(mode)){
      if(mode==='co_role'){await native.enqueueNotification({businessEventId:'synthetic-other-approver-duty',recordId,recipientOpenId:'ou_target',kind:'approval_requested'});const task=(await native.takeNextNotification())!;await native.completeNotification(task.key,task.claimToken,{messageId:'om_synthetic_legacy_new'});}
      const from={id:`local-external-${'b'.repeat(64)}`,recordId:'recSource',name:'合成前任',openId:'ou_source',active:true,type:'employee' as const,position:'综合管理',systemPosition:'',buildings:['B楼' as const],specialties:['电气' as const],permissionTags:[],dutyRecordIds:['recApprover']};
      const context:HandoverContext={from,to:{...from,id:`local-external-${'a'.repeat(64)}`,recordId:'recTarget',name:'合成现任',openId:'ou_target'},directoryVersion:'c'.repeat(64),duties:[{recordId:'recApprover',name:'B楼电气采购审批',kind:'purchase_approver',personnelIds:[from.id],buildings:['B楼'],specialties:['电气'],enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1}]};
      let adapter=new PurchasePersonnelHandoverAdapter(native,access,{isEnabled:()=>false} as never,gateway as never,workflow);
      const item=(await adapter.listPending(context)).find(row=>row.stageKey==='legacy_approver')!;expect(item).toBeDefined();expect(await adapter.preflight(context,item)).toEqual({ready:true});await transfer();
      const receipt=await adapter.acceptTransfer(context,item,handoverItemMutationId(handoverBatch,item.key));expect(await adapter.reconcile(context,receipt)).toEqual({status:'syncing'});
      await expect(native.claimCardAction(input)).rejects.toThrow('已转交');
      if(mode==='send_retry')gateway.sendInteractiveCard.mockRejectedValueOnce(new Error('synthetic send response lost'));
      const first=await workflow.runPendingTasks(2);
      if(mode==='send_retry'){
        expect(first.failed).toBe(1);expect(await adapter.reconcile(context,receipt)).toMatchObject({status:'error'});current.itemName='合成更名备件';
        await native.onModuleDestroy();native=new PurchaseWorkflowStore(join(folder,'purchase.json'));workflow=new PurchaseWorkflowService(gateway as never,native,undefined,access);jest.spyOn(workflow,'isEnabled').mockReturnValue(true);adapter=new PurchasePersonnelHandoverAdapter(native,access,{isEnabled:()=>false} as never,gateway as never,workflow);
        const bytes=readFileSync(join(folder,'purchase.json'),'utf8');expect(await adapter.acceptTransfer(context,item,receipt.mutationId)).toEqual(receipt);expect(readFileSync(join(folder,'purchase.json'),'utf8')).toBe(bytes);
        expect((await workflow.runPendingTasks(2,new Date(Date.now()+2*60_000))).errors).toEqual([]);expect(gateway.sendInteractiveCard.mock.calls[0]).toEqual(gateway.sendInteractiveCard.mock.calls[1]);
      }else expect(first.errors).toEqual([]);
      expect(await adapter.reconcile(context,receipt)).toEqual({status:'success'});
      expect(gateway.updateInteractiveCard).toHaveBeenCalledWith('om_synthetic_legacy',expect.anything());expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(mode==='co_role'?0:mode==='send_retry'?2:1);
      if(mode==='return'){
        const returned={...context,from:context.to,to:context.from,duties:context.duties.map(duty=>({...duty,personnelIds:[context.to.id]}))},nextBatch='49954723-d5ea-423d-a4f9-4996680e5840',next=(await adapter.listPending(returned)).find(row=>row.stageKey==='legacy_approver')!;
        await config.mutate(config.read().revision,randomUUID(),'synthetic-legacy-return',state=>{Object.assign(state.personnelDutyAssignments!.recApprover,{confirmedBatchId:nextBatch,members:[{personId:from.id,recordId:from.recordId,openId:from.openId,name:from.name}]});});
        const returnedReceipt=await adapter.acceptTransfer(returned,next,handoverItemMutationId(nextBatch,next.key));gateway.sendInteractiveCard.mockResolvedValueOnce('om_synthetic_legacy_returned');expect((await workflow.runPendingTasks(2)).errors).toEqual([]);expect(await adapter.reconcile(returned,returnedReceipt)).toEqual({status:'success'});
        await expect(workflow.acceptApprovalCardAction({...input,eventId:'synthetic-old-returned-card'})).rejects.toThrow('已转交');await expect(workflow.acceptApprovalCardAction({...input,eventId:'synthetic-no-message-returned-card',deliveryMessageId:undefined})).rejects.toThrow('已转交');
      }
      const actor=mode==='return'?'ou_source':'ou_target',messageId=mode==='return'?'om_synthetic_legacy_returned':'om_synthetic_legacy_new';
      expect((await workflow.acceptApprovalCardAction({...input,eventId:'synthetic-legacy-new-actor',actorOpenId:actor,deliveryMessageId:messageId})).claimed).toBe(true);expect((await workflow.runPendingTasks(1)).errors).toEqual([]);expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledTimes(1);return;
    }
    expect((await workflow.acceptApprovalCardAction(input)).claimed).toBe(true);
    if(mode==='accepted'){
      const file=join(folder,'purchase.json'),ledger=JSON.parse(readFileSync(file,'utf8')),sample=ledger.notifications[0];ledger.notifications.push(...Array.from({length:600},(_,index)=>({...structuredClone(sample),approvalAuthority:undefined,approvalHandover:undefined,kind:'purchase_completed',businessEventId:`synthetic-approval-history-${index}`,recordId:`recApprovalHistory${index}`,recipientOpenId:'ou_unrelated',deliveryAudit:[],cardContext:''})));writeFileSync(file,JSON.stringify(ledger));await native.enqueueNotification({businessEventId:'synthetic-approval-trigger-trim',recordId:'recApprovalTrim',recipientOpenId:'ou_unrelated',kind:'purchase_completed'});
      const trigger=(await native.takeNextNotification())!;expect(trigger.recordId).toBe('recApprovalTrim');await native.completeNotification(trigger.key,trigger.claimToken,{});
    }
    await transfer();await config.mutate(config.read().revision,randomUUID(),'synthetic-legacy-disabled',state=>{state.accounts[sourceId].enabled=false;state.accounts[sourceId].version++;});
    if(mode==='lost_write'){
      expect((await workflow.runPendingTasks(1)).failed).toBe(1);gateway.resolvePurchaseAdminAsApp.mockResolvedValue({openId:'ou_other_buyer',name:'合成另任采购员',positions:['综合管理'],buildings:['B楼']});
      await native.onModuleDestroy();native=new PurchaseWorkflowStore(join(folder,'purchase.json'));const restarted=new PurchaseWorkflowService(gateway as never,native,undefined,access);jest.spyOn(restarted,'isEnabled').mockReturnValue(true);
      expect((await restarted.runPendingTasks(1,new Date(Date.now()+2*60_000))).errors).toEqual([]);expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledTimes(1);expect((await native.getCardAction(`approval:${recordId}`))?.completedAt).toBeTruthy();return;
    }
    expect((await workflow.runPendingTasks(1)).errors).toEqual([]);expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledTimes(1);expect((await native.getCardAction(`approval:${recordId}`))?.completedAt).toBeTruthy();
  });
});
