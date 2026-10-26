import {randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {InventoryOutboundApprovalStore} from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.store';
import {InventoryOutboundApprovalService} from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.service';
import type {InventoryOutboundApprovalSnapshot} from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.types';
const recordId='recNoticeHandover',mutationId=`handover-${'a'.repeat(64)}`;
const snapshot:InventoryOutboundApprovalSnapshot={recordId,outboundNumber:'synthetic-notice',version:1,policyVersion:'synthetic-policy',applicantOpenId:'ou_notice_applicant',applicantName:'合成申请人',itemName:'合成物料',sku:'synthetic-notice',specification:'/',brand:'/',quantity:1,unit:'个',availableStock:8,building:'C楼',location:'合成库位',reason:'合成岗位知会',appliedAt:'2026-10-15T00:00:00.000Z',approvers:[{openId:'ou_notice_approver',name:'合成审批人'}],managerRecipients:[{openId:'ou_notice_previous',name:'合成前任'}]};
const input=()=>({recordId,expectedVersion:1,expectedGeneration:1,mutationId,dutyRecordId:'recNoticeDuty',sourcePersonRecordId:'recNoticePrevious',sourceOpenId:'ou_notice_previous',target:{personRecordId:'recNoticeNext',openId:'ou_notice_next',name:'合成接任者'}});
type Port={acceptManagerNotificationHandover(value:ReturnType<typeof input>):Promise<{status:string;generation:number}>};
describe('出库未完成岗位知会：真实native账本与worker',()=>{
  let folder:string,parent:string,owner:string,file:string,store:InventoryOutboundApprovalStore,savedApp:string|undefined;
  beforeEach(async()=>{savedApp=process.env.FEISHU_APP_ID;process.env.FEISHU_APP_ID='cli_synthetic_inventory_notice';parent=realpathSync(tmpdir());folder=mkdtempSync(join(parent,'nt-inventory-notice-'));owner=randomUUID();writeFileSync(join(folder,'.test-owner'),owner,{flag:'wx'});file=join(folder,'ledger.json');store=new InventoryOutboundApprovalStore(file);await register(snapshot);});
  afterEach(()=>{if(savedApp===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=savedApp;if(dirname(resolve(folder)).toLowerCase()!==resolve(parent).toLowerCase()||!/^nt-inventory-notice-[A-Za-z0-9]+$/.test(basename(folder))||!existsSync(folder)||lstatSync(folder).isSymbolicLink()||realpathSync(folder)!==folder||readFileSync(join(folder,'.test-owner'),'utf8')!==owner)throw Error('Owned fixture mismatch');for(const name of readdirSync(folder))if(!lstatSync(join(folder,name)).isFile()||lstatSync(join(folder,name)).isSymbolicLink())throw Error('Unsafe fixture');rmSync(folder,{recursive:true,force:false});});
  async function register(value:InventoryOutboundApprovalSnapshot){await store.registerPending(value);await store.confirmPendingRegistration(value.recordId,1);const ref={recordId:value.recordId,version:1,kind:'approvalCardDelivery' as const,recipientOpenId:'ou_notice_approver'},claim=await store.claimWork(ref);if(!claim.claimed)throw Error('Fixture card unavailable');await store.completeWork({...ref,leaseToken:claim.leaseToken,messageId:`om_${value.recordId}`});}
  const accept=(value=input())=>(store as unknown as Port).acceptManagerNotificationHandover(value);
  it('交接证明接近外部字段容量时先拒绝，不能受理后才卡在结果台账写入',async()=>{
    let generation=1,sourceOpenId='ou_notice_previous',sourcePersonRecordId='recNoticePrevious',rejected=false;
    for(let index=0;index<100;index++){
      const bytes=readFileSync(file,'utf8');
      try {
        await accept({...input(),expectedGeneration:generation,sourceOpenId,sourcePersonRecordId,mutationId:`handover-${index.toString(16).padStart(64,'0')}`,target:{personRecordId:`recCapacity${index}`,openId:`ou_capacity_${index}`,name:'合成接任者'.repeat(20)}});
      } catch(error) {expect(String(error)).toContain('容量');expect(readFileSync(file,'utf8')).toBe(bytes);rejected=true;break;}
      generation++;sourceOpenId=`ou_capacity_${index}`;sourcePersonRecordId=`recCapacity${index}`;
    }
    expect(rejected).toBe(true);expect(generation).toBeLessThan(101);
  },30000);
  it('其他结果通知正在发送时不切岗位路由，避免旧工作快照覆盖新结果台账',async()=>{
    await approve();await finishBaseAndCard();
    const ref={recordId,version:1,kind:'resultNotification' as const,recipientOpenId:'ou_notice_applicant'};
    const claim=await store.claimWork(ref);expect(claim.claimed).toBe(true);
    const bytes=readFileSync(file,'utf8');await expect(accept()).rejects.toThrow();expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  const approve=(id=recordId)=>store.claimDecision({recordId:id,version:1,actorOpenId:'ou_notice_approver',messageId:`om_${id}`,eventId:`synthetic_approve_${id}`,action:'approve'});
  async function finishBaseAndCard(){for(const ref of [{recordId,version:1,kind:'baseSync' as const},{recordId,version:1,kind:'cardPatch' as const,recipientOpenId:'ou_notice_approver'}]){const claim=await store.claimWork(ref);if(!claim.claimed)throw Error('Fixture terminal work unavailable');await store.completeWork({...ref,leaseToken:claim.leaseToken});}}
  it('未开始结果前转岗位路由，不改审批快照；重启同mutation只复用回执',async()=>{
    const before=(await store.find(recordId,1))!,receipt=await accept();expect(receipt).toEqual({status:'accepted',generation:2});expect((await store.find(recordId,1))?.snapshot).toEqual(before.snapshot);
    const bytes=readFileSync(file,'utf8');store=new InventoryOutboundApprovalStore(file);expect(await accept()).toEqual(receipt);expect(readFileSync(file,'utf8')).toBe(bytes);
    await approve();const recipients=(await store.find(recordId,1))!.resultNotifications.filter(work=>work.status!=='cancelled').map(work=>work.recipientOpenId);expect(recipients).toContain('ou_notice_next');expect(recipients).not.toContain('ou_notice_previous');
  });
  it('已有决定只换未投递岗位通知，实际worker不重开审批、不发给前任',async()=>{
    await approve();const original=(await store.find(recordId,1))!.decision;await accept();const gateway={writeDecision:jest.fn().mockResolvedValue(undefined),patchInteractiveCard:jest.fn().mockResolvedValue(undefined),sendInteractiveCard:jest.fn(async(id:string)=>`om_result_${id}`),writeApprovalResultDeliveryLedger:jest.fn().mockResolvedValue(undefined),writeFinalizationCompleted:jest.fn().mockResolvedValue(undefined)};
    const service=new InventoryOutboundApprovalService(store,gateway as never,{finalizeApprovedOutbound:jest.fn().mockResolvedValue(undefined)} as never,undefined,undefined,{canUseFeishuBusinessIdentity:()=>true} as never);
    const result=await service.runPending();expect(result.failed).toBe(0);expect(gateway.sendInteractiveCard.mock.calls.map(call=>call[0])).toEqual(expect.arrayContaining(['ou_notice_applicant','ou_notice_next']));expect(gateway.sendInteractiveCard.mock.calls.some(([id])=>id==='ou_notice_previous')).toBe(false);expect((await store.find(recordId,1))?.decision).toEqual(original);
    await service.runPending();expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(2);
  });
  it('岗位通知发送在途先保原任务，原mutation无覆盖；已投递不补发新历史',async()=>{
    await approve();await finishBaseAndCard();const ref={recordId,version:1,kind:'resultNotification' as const,recipientOpenId:'ou_notice_previous'},claim=await store.claimWork(ref);if(!claim.claimed)throw Error('Fixture notice unavailable');const bytes=readFileSync(file,'utf8');await expect(accept()).rejects.toThrow();expect(readFileSync(file,'utf8')).toBe(bytes);await store.completeWork({...ref,leaseToken:claim.leaseToken,messageId:'om_notice_previous_completed'});
    const completed=readFileSync(file,'utf8');expect(await accept()).toEqual({status:'already_completed',generation:1});expect(readFileSync(file,'utf8')).toBe(completed);
  });
  it('申请人兼岗位知会，只移岗位；同OpenID的本人结果仍保留并去重',async()=>{
    const id='recNoticeDualRole';await register({...snapshot,recordId:id,applicantOpenId:'ou_notice_previous'});await approve(id);await accept({...input(),recordId:id});const works=(await store.find(id,1))!.resultNotifications.filter(work=>work.status!=='cancelled');expect(works.map(work=>work.recipientOpenId).sort()).toEqual(['ou_notice_next','ou_notice_previous']);expect(new Set(works.map(work=>work.recipientOpenId)).size).toBe(works.length);
  });
  it('旧代际/篡改稳定身份或mutation目标不允许覆盖已受理路由',async()=>{
    await accept();const bytes=readFileSync(file,'utf8');await expect(accept({...input(),target:{...input().target,personRecordId:'recWrongNativeIdentity'}})).rejects.toThrow();await expect(accept({...input(),mutationId:`handover-${'b'.repeat(64)}`})).rejects.toThrow();expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it('后续审批交接复制已确认岗位通知路由，不复活前任；岗位回任不重复结果收件人',async()=>{
    await accept();await store.acceptPendingHandover({...input(),mutationId:`handover-${'c'.repeat(64)}`,sourceOpenId:'ou_notice_approver',sourcePersonRecordId:'recNoticeApprover',target:{personRecordId:'recNoticeNewApprover',openId:'ou_notice_new_approver',name:'合成新审批人'}});
    expect((await store.find(recordId,2))?.snapshot.managerRecipients).toEqual([{openId:'ou_notice_next',name:'合成接任者'}]);
    const id='recNoticeReturn';await register({...snapshot,recordId:id});await accept({...input(),recordId:id});await accept({...input(),recordId:id,mutationId:`handover-${'d'.repeat(64)}`,expectedGeneration:2,sourceOpenId:'ou_notice_next',sourcePersonRecordId:'recNoticeNext',target:{personRecordId:'recNoticePrevious',openId:'ou_notice_previous',name:'合成前任'}});await approve(id);
    expect((await store.find(id,1))?.resultNotifications.filter(work=>work.status!=='cancelled').map(work=>work.recipientOpenId).sort()).toEqual(['ou_notice_applicant','ou_notice_previous']);
  });
  it('接任岗位在投递前被收权，不给其发通知，保留可恢复任务及原决定',async()=>{
    await approve();await finishBaseAndCard();await accept();const gateway={sendInteractiveCard:jest.fn(async(id:string)=>`om_withdraw_${id}`),writeApprovalResultDeliveryLedger:jest.fn().mockResolvedValue(undefined),writeFinalizationCompleted:jest.fn().mockResolvedValue(undefined)},service=new InventoryOutboundApprovalService(store,gateway as never,undefined,undefined,undefined,{canUseFeishuBusinessIdentity:()=>false} as never);
    const result=await service.runPending();expect(result.failed).toBe(1);expect(gateway.sendInteractiveCard.mock.calls.map(([id])=>id)).not.toContain('ou_notice_next');expect((await store.find(recordId,1))?.resultNotifications.find(work=>work.recipientOpenId==='ou_notice_next')).toMatchObject({status:'error'});
  });
});
