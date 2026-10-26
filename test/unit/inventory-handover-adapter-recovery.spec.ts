import {randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import type {HandoverContext,HandoverAdapter,PendingDuty} from '../../shared/personnel-handover.interface';
import {pendingHandoverSelection} from '../../server/common/access/personnel-handover.preview';
import {InventoryOutboundApprovalStore} from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.store';
import {InventoryOutboundApprovalService} from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.service';
import {InventoryPersonnelHandoverAdapter} from '../../server/modules/inventory-outbound-approval/inventory-personnel-handover.adapter';
import type {InventoryOutboundApprovalSnapshot} from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.types';
import * as configurations from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import {AccessConfigurationService} from '../../server/common/access/access-configuration.service';
import {feishuIdentityFingerprint} from '../../server/common/access/feishu-access-approved-grants';
import {handoverItemMutationId} from '../../server/common/access/personnel-handover.store';

const mutationId=`handover-${'a'.repeat(64)}`,recordId='recAdapterOutbound';
const person=(recordId:string,openId:string,marker:string,active:boolean)=>({id:`local-external-${marker.repeat(64)}`,recordId,openId,name:`合成人员${marker}`,active,type:'employee' as const,position:'库房负责人',systemPosition:'',buildings:['C楼' as const],specialties:[],permissionTags:[],dutyRecordIds:['recAdapterDuty']});
const context=():HandoverContext=>({from:person('recAdapterOld','ou_adapter_old','a',false),to:person('recAdapterNew','ou_adapter_new','b',true),directoryVersion:'synthetic-adapter',duties:[{recordId:'recAdapterDuty',name:'C楼库房审批',kind:'warehouse_approver',personnelIds:[`local-external-${'a'.repeat(64)}`],buildings:['C楼'],specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1}]});
const snapshot=():InventoryOutboundApprovalSnapshot=>({recordId,outboundNumber:'synthetic-adapter',version:1,policyVersion:'synthetic-v1',applicantOpenId:'ou_adapter_applicant',applicantName:'合成申请人',itemName:'合成物料',sku:'synthetic-adapter-sku',specification:'/',brand:'/',quantity:1,unit:'个',availableStock:8,building:'C楼',location:'合成库位',reason:'交接测试',appliedAt:'2026-10-15T00:00:00.000Z',approvers:[{openId:'ou_adapter_old',name:'合成人员a'}]});

describe('出库交接adapter真实账本恢复及覆盖门禁',()=>{
  let folder:string,parent:string,owner:string,file:string,store:InventoryOutboundApprovalStore,adapter:HandoverAdapter,eligible:boolean,savedApp:string|undefined;
  const make=()=>new InventoryPersonnelHandoverAdapter(store,{canUseFeishuBusinessIdentity:()=>eligible} as never,{isEnabled:()=>true} as never);
  beforeEach(async()=>{
    savedApp=process.env.FEISHU_APP_ID;process.env.FEISHU_APP_ID='cli_synthetic_inventory_adapter';eligible=true;
    parent=realpathSync(tmpdir());folder=mkdtempSync(join(parent,'nt-inventory-adapter-'));owner=randomUUID();writeFileSync(join(folder,'.test-owner'),owner,{flag:'wx'});file=join(folder,'ledger.json');store=new InventoryOutboundApprovalStore(file);
    await register(snapshot());adapter=make();
  });
  afterEach(()=>{
    jest.restoreAllMocks();
    if(savedApp===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=savedApp;
    if(dirname(resolve(folder)).toLowerCase()!==resolve(parent).toLowerCase()||!/^nt-inventory-adapter-[A-Za-z0-9]+$/.test(basename(folder))||!existsSync(folder)||lstatSync(folder).isSymbolicLink()||realpathSync(folder)!==folder||readFileSync(join(folder,'.test-owner'),'utf8')!==owner)throw Error('Owned fixture mismatch');
    for(const name of readdirSync(folder))if(!lstatSync(join(folder,name)).isFile()||lstatSync(join(folder,name)).isSymbolicLink())throw Error('Unsafe fixture entry');rmSync(folder,{recursive:true,force:false});
  });
  async function register(value:InventoryOutboundApprovalSnapshot){
    await store.registerPending(value);await store.confirmPendingRegistration(value.recordId,1);
    for(const approver of value.approvers){const ref={recordId:value.recordId,version:1,kind:'approvalCardDelivery' as const,recipientOpenId:approver.openId},claim=await store.claimWork(ref);if(!claim.claimed)throw Error('Fixture card not claimed');await store.completeWork({...ref,leaseToken:claim.leaseToken,messageId:`om_adapter_${value.recordId}_${approver.openId}`});}
  }
  const item=async()=>(await adapter.listPending(context()))[0];
  const notifyContext=()=>{const value=context();value.duties.push({...value.duties[0],recordId:'recNotifyDuty',name:'C楼库房知会',kind:'warehouse_notify'});return value;};
  it('同一岗位回执只恢复原交接错误步骤，立即可认领且保留原任务ID',async()=>{
    const ctx=context(),appId=process.env.FEISHU_APP_ID!,batchId=randomUUID(),config=new configurations.AccessConfigurationStore(join(folder,'configuration.json'));
    jest.spyOn(configurations,'getAccessConfigurationStore').mockReturnValue(config);jest.spyOn(defaults,'defaultAccessAccounts').mockReturnValue({});
    await config.mutate(0,randomUUID(),'synthetic-seed-recovery',state=>{
      for(const person of [ctx.from,ctx.to]){const identityHash=feishuIdentityFingerprint(appId,person.openId!),id=`feishu-${identityHash}`;state.accounts[id]={id,kind:'feishu',appId,openId:person.openId!,identityHash,name:person.name,role:person.id===ctx.from.id?'guest':'inventory_admin',building:person.id===ctx.from.id?null:'C楼',enabled:true,deleted:false,source:'configuration',version:1};}
      state.personnelDutyAssignments={recAdapterDuty:{appId,dutyRecordId:'recAdapterDuty',kind:'warehouse_approver',buildings:['C楼'],specialties:null,version:1,startsAt:0,endsAt:null,confirmedBatchId:batchId,members:[{personId:ctx.to.id,recordId:ctx.to.recordId,openId:ctx.to.openId!,name:ctx.to.name}]}};
    });
    const current=new InventoryPersonnelHandoverAdapter(store,new AccessConfigurationService(),{isEnabled:()=>true} as never),selected=(await current.listPending(ctx))[0],mutation=handoverItemMutationId(batchId,selected.key),receipt=await current.acceptTransfer(ctx,selected,mutation);
    const ref={recordId,version:1,kind:'cardPatch' as const,recipientOpenId:ctx.from.openId!},claimed=await store.claimWork(ref);expect(claimed.claimed).toBe(true);if(!claimed.claimed)throw Error('fixture claim missing');
    await store.failWork({...ref,leaseToken:claimed.leaseToken,error:'synthetic retry later',nextAttemptAt:new Date(Date.now()+86400_000).toISOString()});
    const before=readFileSync(file,'utf8');expect(await current.reconcile({...ctx,to:{...ctx.to,recordId:'recUnrelated'}},receipt,{retryFailed:true})).toMatchObject({status:'error'});expect(readFileSync(file,'utf8')).toBe(before);
    expect(await current.reconcile(ctx,receipt,{retryFailed:true})).toMatchObject({status:'syncing'});
    const resumed=await store.claimWork(ref);expect(resumed.claimed).toBe(true);if(resumed.claimed)expect(resumed.work.id).toBe(claimed.work.id);
  });
  it('同人审批和知会分别列项，通知先受理后审批，重启可复用两条原回执',async()=>{
    await register({...snapshot(),recordId:'recDualDuty',managerRecipients:[{openId:'ou_adapter_old',name:'合成人员a'}]});
    const ctx=notifyContext(),items=(await adapter.listPending(ctx)).filter(value=>value.recordId==='recDualDuty');
    expect(items).toHaveLength(2);const ordered=items.sort((a,b)=>a.key.localeCompare(b.key));expect(ordered[0].phase).toBe('notification');expect(ordered[0].dutyRecordId).toBe('recNotifyDuty');
    const note=await adapter.acceptTransfer(ctx,ordered[0],mutationId),approval=await adapter.acceptTransfer(ctx,ordered[1],`handover-${'b'.repeat(64)}`);
    expect((await store.find('recDualDuty',2))?.snapshot.managerRecipients).toEqual([{openId:'ou_adapter_new',name:'合成人员b'}]);
    store=new InventoryOutboundApprovalStore(file);adapter=make();expect(await adapter.preflight(ctx,ordered[0],mutationId)).toEqual({ready:true});expect(await adapter.acceptTransfer(ctx,ordered[0],mutationId)).toEqual(note);expect(await adapter.reconcile(ctx,note)).toEqual({status:'success'});expect((await adapter.reconcile(ctx,approval)).status).toBe('syncing');
  });
  it('仅知会岗位可以独立交接，旧审批角色不变，错误代际或人员不能重放',async()=>{
    await register({...snapshot(),recordId:'recOnlyNotify',approvers:[{openId:'ou_other_approver',name:'合成其他审批人'}],managerRecipients:[{openId:'ou_adapter_old',name:'合成人员a'}]});
    const ctx=notifyContext();ctx.duties=ctx.duties.filter(duty=>duty.kind==='warehouse_notify');const original=(await adapter.listPending(ctx)).find(value=>value.recordId==='recOnlyNotify')!;
    expect(original.phase).toBe('notification');const receipt=await adapter.acceptTransfer(ctx,original,mutationId),bytes=readFileSync(file,'utf8');expect(await adapter.reconcile(ctx,receipt)).toEqual({status:'success'});
    expect((await store.find('recOnlyNotify',1))?.snapshot.approvers[0].openId).toBe('ou_other_approver');expect(await store.find('recOnlyNotify',2)).toBeUndefined();
    expect((await adapter.preflight(ctx,original,`handover-${'c'.repeat(64)}`)).ready).toBe(false);await expect(adapter.acceptTransfer(ctx,{...original,recipients:[{openId:'ou_tampered',name:'错误'}]},mutationId)).rejects.toThrow();expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it('已有审批决定的知会交接须等接任者真实投递ACK，失败可恢复原代际任务',async()=>{
    await register({...snapshot(),recordId:'recNotifyAfterDecision',approvers:[{openId:'ou_other_approver',name:'合成其他审批人'}],managerRecipients:[{openId:'ou_adapter_old',name:'合成人员a'}]});
    await store.claimDecision({recordId:'recNotifyAfterDecision',version:1,actorOpenId:'ou_other_approver',messageId:'om_adapter_recNotifyAfterDecision_ou_other_approver',eventId:'synthetic_after_decision',action:'approve'});
    const ctx=notifyContext();ctx.duties=ctx.duties.filter(duty=>duty.kind==='warehouse_notify');const original=(await adapter.listPending(ctx)).find(value=>value.recordId==='recNotifyAfterDecision')!;
    const receipt=await adapter.acceptTransfer(ctx,original,mutationId);expect(await adapter.reconcile(ctx,receipt)).toEqual({status:'syncing'});
    const gateway={writeDecision:jest.fn().mockResolvedValue(undefined),patchInteractiveCard:jest.fn().mockResolvedValue(undefined),sendInteractiveCard:jest.fn(async(id:string)=>`om_notify_${id}`),writeApprovalResultDeliveryLedger:jest.fn().mockResolvedValue(undefined),writeFinalizationCompleted:jest.fn().mockResolvedValue(undefined)};
    const service=new InventoryOutboundApprovalService(store,gateway as never,{finalizeApprovedOutbound:jest.fn().mockResolvedValue(undefined)} as never,undefined,undefined,{canUseFeishuBusinessIdentity:()=>true} as never);expect((await service.runPending()).failed).toBe(0);
    expect(await adapter.reconcile(ctx,receipt)).toEqual({status:'success'});expect(gateway.sendInteractiveCard.mock.calls.map(call=>call[0])).toContain('ou_adapter_new');expect(gateway.sendInteractiveCard.mock.calls.map(call=>call[0])).not.toContain('ou_adapter_old');expect(gateway.writeApprovalResultDeliveryLedger.mock.calls.some(call=>call.length===4)).toBe(true);
  });
  const decide=()=>store.claimDecision({recordId,version:1,actorOpenId:'ou_adapter_old',messageId:`om_adapter_${recordId}_ou_adapter_old`,eventId:'synthetic-adapter-decision',action:'approve'});
  it('受理后重启，原mutation预检与受理复用native回执且不改字节',async()=>{
    const original=await item(),receipt=await adapter.acceptTransfer(context(),original,mutationId),bytes=readFileSync(file,'utf8');
    store=new InventoryOutboundApprovalStore(file);adapter=make();
    expect(await adapter.preflight(context(),original,mutationId)).toEqual({ready:true});expect(await adapter.acceptTransfer(context(),original,mutationId)).toEqual(receipt);expect(readFileSync(file,'utf8')).toBe(bytes);
    expect((await adapter.reconcile(context(),receipt)).status).toBe('syncing');
  });
  it('已受理回执不能冒用其他mutation、职责或目标稳定身份',async()=>{
    const original=await item();await adapter.acceptTransfer(context(),original,mutationId);const bytes=readFileSync(file,'utf8');
    expect((await adapter.preflight(context(),original,`handover-${'b'.repeat(64)}`)).ready).toBe(false);
    const other=context();other.to.recordId='recAnotherStableIdentity';expect((await adapter.preflight(other,original,mutationId)).ready).toBe(false);
    await expect(adapter.acceptTransfer(other,original,mutationId)).rejects.toThrow();expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it('原合法审批先受理，预检明确已完成，保原决议且不新建版本',async()=>{
    const original=await item();await decide();const bytes=readFileSync(file,'utf8');
    expect(await adapter.preflight(context(),original,mutationId)).toMatchObject({ready:false,alreadyCompleted:true});
    const receipt=await adapter.acceptTransfer(context(),original,mutationId);expect(receipt.status).toBe('already_completed');expect(await adapter.reconcile(context(),receipt)).toEqual({status:'success'});expect(readFileSync(file,'utf8')).toBe(bytes);expect(await store.find(recordId,2)).toBeUndefined();
  });
  it('已审批但外部执行和结果通知尚未完成，列待对账而非办结历史',async()=>{
    await decide();const [pending]=await adapter.listPending(context());expect(pending).toMatchObject({phase:'reconcile',status:'pending'});const selection=pendingHandoverSelection([pending]);expect(selection.pending).toHaveLength(0);expect(selection.excluded).toHaveLength(0);expect(selection.conflicts).toHaveLength(1);
  });
  it('清单接收人快照不可被篡改或重复，拒绝且不写账本',async()=>{
    const original=await item(),bytes=readFileSync(file,'utf8');
    for(const recipients of [[{name:'合成人员',openId:'ou_unrelated'}],[...original.recipients,...original.recipients]]){
      const changed:PendingDuty={...original,recipients};expect((await adapter.preflight(context(),changed,mutationId)).ready).toBe(false);await expect(adapter.acceptTransfer(context(),changed,mutationId)).rejects.toThrow();
    }
    expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it('前任兼任独立库房知会时明确阻断，不漏掉未开始结果接收职责',async()=>{
    const value={...snapshot(),recordId:'recIndependentNotify',managerRecipients:[{openId:'ou_adapter_old',name:'合成人员a'}]};await register(value);
    const bytes=readFileSync(file,'utf8');await expect(adapter.listPending(context())).rejects.toThrow('知会');expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it('接任者当前业务权限收回后，原回执也不能继续授予或接受新动作',async()=>{
    const original=await item();await adapter.acceptTransfer(context(),original,mutationId);const bytes=readFileSync(file,'utf8');eligible=false;
    expect((await adapter.preflight(context(),original,mutationId)).ready).toBe(false);await expect(adapter.acceptTransfer(context(),original,mutationId)).rejects.toThrow();expect((await adapter.reconcile(context(),{itemKey:original.key,mutationId,module:'inventory',recordId,version:'2',status:'accepted'})).status).toBe('error');expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it('真正完成回写、卡片终态与结果通知后只保留历史，不重复审批或通知',async()=>{
    await decide();
    const base={recordId,version:1,kind:'baseSync' as const},claimed=await store.claimWork(base);if(!claimed.claimed)throw Error('Fixture base not claimed');await store.completeWork({...base,leaseToken:claimed.leaseToken});
    for(const kind of ['cardPatch','resultNotification'] as const){
      const current=(await store.find(recordId,1))!,works=kind==='cardPatch'?current.cardPatches:current.resultNotifications;
      for(const work of works){const ref={recordId,version:1,kind,recipientOpenId:work.recipientOpenId},claim=await store.claimWork(ref);if(!claim.claimed)throw Error('Fixture terminal work not claimed');await store.completeWork({...ref,leaseToken:claim.leaseToken,...(kind==='resultNotification'?{messageId:`om_final_${work.recipientOpenId}`}:{})});}
    }
    const bytes=readFileSync(file,'utf8'),history=await adapter.listPending(context());expect(history[0].status).toBe('terminal');expect(pendingHandoverSelection(history)).toMatchObject({pending:[],conflicts:[],excluded:[{key:history[0].key,reason:'已办结历史保持'}]});expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it('前任仅在知会名单、未在审批名单，也不能漏过独立通知门禁',async()=>{
    await register({...snapshot(),recordId:'recNotifyOnly',approvers:[{openId:'ou_other_approver',name:'合成其他审批人'}],managerRecipients:[{openId:'ou_adapter_old',name:'合成人员a'}]});
    await expect(adapter.listPending(context())).rejects.toThrow('知会');
  });
  it('旧身份业务资格已收回时，实际卡片回调拒绝新动作且不写账本或网关',async()=>{
    const original=await item();await adapter.acceptTransfer(context(),original,mutationId);eligible=false;
    const gateway={sendInteractiveCard:jest.fn(),patchInteractiveCard:jest.fn()},workflow=new InventoryOutboundApprovalService(store,gateway as never,undefined,undefined,undefined,{canUseFeishuBusinessIdentity:()=>eligible} as never),bytes=readFileSync(file,'utf8');
    await expect(workflow.handleCardAction({event_type:'card.action.trigger',operator:{open_id:'ou_adapter_old'},context:{open_message_id:`om_adapter_${recordId}_ou_adapter_old`},action:{tag:'button',value:{workflowType:'inventory_outbound',action:'approve',recordId,version:1}}})).rejects.toThrow();
    expect(readFileSync(file,'utf8')).toBe(bytes);expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();expect(gateway.patchInteractiveCard).not.toHaveBeenCalled();
  });
});
