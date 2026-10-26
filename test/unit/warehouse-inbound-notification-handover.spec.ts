import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PurchaseWorkflowService } from '../../server/modules/purchase-inventory/purchase-workflow.service';
const recordId='recWarehouseHandover',mutationId=`handover-${'a'.repeat(64)}`;
const input=()=>({recordId,expectedGeneration:1,mutationId,dutyRecordId:'recWarehouseDuty',sourcePersonRecordId:'recWarehousePrevious',sourceOpenId:'ou_warehouse_previous',target:{personRecordId:'recWarehouseNext',openId:'ou_warehouse_next',name:'合成接任者'}});
type Job=ReturnType<typeof input>&{status:string;targetGeneration:number;oldMessageIds:string[];patchedMessageIds:string[];claimToken:string;notificationKey:string;deliveredMessageId?:string};
type Port=PurchaseWorkflowStore&{acceptWarehouseInboundHandover(value:ReturnType<typeof input>):Promise<{status:string;generation:number}>;takeNextWarehouseInboundHandover(now?:Date,leaseMs?:number):Promise<Job|null>;recordWarehouseInboundCardPatched(id:string,token:string,messageId:string,now?:Date):Promise<void>;completeWarehouseInboundHandover(id:string,token:string,now?:Date):Promise<void>;findWarehouseInboundHandover(id:string):Promise<Job|undefined>};
describe('待入库岗位提醒交接原生CAS及持久进度',()=>{
  let parent:string,folder:string,owner:string,file:string,store:Port,savedEnv:Record<string,string|undefined>;
  beforeEach(async()=>{savedEnv={PUBLIC_BASE_URL:process.env.PUBLIC_BASE_URL,FEISHU_APP_ID:process.env.FEISHU_APP_ID};process.env.PUBLIC_BASE_URL='https://ops.example.com/';process.env.FEISHU_APP_ID='cli_synthetic_warehouse_handover';parent=realpathSync(tmpdir());folder=mkdtempSync(join(parent,'nt-warehouse-handover-'));owner=randomUUID();writeFileSync(join(folder,'.test-owner'),owner,{flag:'wx'});file=join(folder,'ledger.json');store=new PurchaseWorkflowStore(file) as Port;await store.onModuleInit();await enqueue(input().sourceOpenId);});
  afterEach(async()=>{jest.restoreAllMocks();for(const [key,value] of Object.entries(savedEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await store.onModuleDestroy();if(dirname(resolve(folder)).toLowerCase()!==resolve(parent).toLowerCase()||!/^nt-warehouse-handover-[A-Za-z0-9]+$/.test(basename(folder))||!existsSync(folder)||lstatSync(folder).isSymbolicLink()||realpathSync(folder)!==folder||readFileSync(join(folder,'.test-owner'),'utf8')!==owner)throw Error('Owned fixture mismatch');for(const name of readdirSync(folder))if(!lstatSync(join(folder,name)).isFile()||lstatSync(join(folder,name)).isSymbolicLink())throw Error('Unsafe fixture');rmSync(folder,{recursive:true,force:false});});
  const enqueue=(recipientOpenId:string)=>store.enqueueNotifications([{recordId,businessEventId:`warehouse-inbound:${recordId}`,recipientOpenId,kind:'warehouse_inbound'}]);
  it('未发送原提醒关闭；旧卡处理结束前接任提醒不可认领，后续旧人员解析也按已确认岗位路由去重',async()=>{
    expect(await store.acceptWarehouseInboundHandover(input())).toEqual({status:'accepted',generation:2});expect(await store.takeNextNotification(new Date(),60000,['warehouse_inbound'])).toBeNull();
    const job=(await store.takeNextWarehouseInboundHandover())!;expect(job.oldMessageIds).toEqual([]);await store.completeWarehouseInboundHandover(mutationId,job.claimToken);
    const next=(await store.takeNextNotification(new Date(),60000,['warehouse_inbound']))!;expect(next.recipientOpenId).toBe(input().target.openId);expect(next.deliveryUuid).toBeTruthy();const [duplicate]=await enqueue(input().sourceOpenId);expect(duplicate.enqueued).toBe(false);expect(duplicate.entry.key).toBe(next.key);
  });
  it('已送达的旧卡全部确认后才开放新提醒，原消息和原投递凭据保持历史',async()=>{
    const old=(await store.takeNextNotification())!;await store.markInboundCompletedSendStarted(old.key,old.claimToken);await store.completeNotification(old.key,old.claimToken,{messageId:'om_old_warehouse'});
    await store.acceptWarehouseInboundHandover(input());const job=(await store.takeNextWarehouseInboundHandover())!;expect(job.oldMessageIds).toEqual(['om_old_warehouse']);const bytes=readFileSync(file,'utf8');
    await expect(store.completeWarehouseInboundHandover(mutationId,job.claimToken)).rejects.toThrow();await expect(store.recordWarehouseInboundCardPatched(mutationId,'invalid-token','om_old_warehouse')).rejects.toThrow();expect(readFileSync(file,'utf8')).toBe(bytes);
    await store.recordWarehouseInboundCardPatched(mutationId,job.claimToken,'om_old_warehouse');await store.completeWarehouseInboundHandover(mutationId,job.claimToken);expect((await store.takeNextNotification(new Date(),60000,['warehouse_inbound']))?.recipientOpenId).toBe(input().target.openId);expect((await store.listNotifications({recordId,recipientOpenId:input().sourceOpenId}))[0]).toMatchObject({status:'completed',messageId:'om_old_warehouse',deliveryUuid:old.deliveryUuid});
  });
  it('发送先认领则先完成原发送再接受交接，处理中不覆盖原lease或假造回执',async()=>{
    const old=(await store.takeNextNotification())!,bytes=readFileSync(file,'utf8');await expect(store.acceptWarehouseInboundHandover(input())).rejects.toThrow();expect(readFileSync(file,'utf8')).toBe(bytes);
    await store.markInboundCompletedSendStarted(old.key,old.claimToken);await store.completeNotification(old.key,old.claimToken,{messageId:'om_legal_original'});await store.acceptWarehouseInboundHandover(input());expect((await store.findWarehouseInboundHandover(mutationId))?.oldMessageIds).toEqual(['om_legal_original']);
  });
  it('原发送结果未知时先对账，不能重新分配并发出重复提醒',async()=>{
    const now=new Date(),old=(await store.takeNextNotification(now))!;await store.markInboundCompletedSendStarted(old.key,old.claimToken,now);await store.rescheduleNotification(old.key,old.claimToken,new Error('synthetic-unknown'),new Date(now.getTime()+120000),now);const bytes=readFileSync(file,'utf8');
    await expect(store.acceptWarehouseInboundHandover(input())).rejects.toThrow('核对');expect(readFileSync(file,'utf8')).toBe(bytes);expect(await store.findWarehouseInboundHandover(mutationId)).toBeUndefined();
  });
  it('重启原mutation复用回执，不能重定向人员或职责；旧工作租约不能提交给新工作',async()=>{
    await store.acceptWarehouseInboundHandover(input());const now=new Date(),old=(await store.takeNextWarehouseInboundHandover(now,1000))!;await store.onModuleDestroy();store=new PurchaseWorkflowStore(file) as Port;await store.onModuleInit();
    expect(await store.acceptWarehouseInboundHandover(input())).toEqual({status:'accepted',generation:2});await expect(store.acceptWarehouseInboundHandover({...input(),target:{...input().target,personRecordId:'recWrongTarget'}})).rejects.toThrow();
    const next=(await store.takeNextWarehouseInboundHandover(new Date(now.getTime()+1001),1000))!;expect(next.claimToken).not.toBe(old.claimToken);await expect(store.completeWarehouseInboundHandover(mutationId,old.claimToken)).rejects.toThrow();await store.completeWarehouseInboundHandover(mutationId,next.claimToken,new Date(now.getTime()+1001));
  });
  it('接任者本来已收到同事项提醒时复用真实回执，不重复生成第二条消息',async()=>{
    const old=(await store.takeNextNotification())!;await store.completeNotification(old.key,old.claimToken,{messageId:'om_old_already'});await enqueue(input().target.openId);const next=(await store.takeNextNotification())!;await store.markInboundCompletedSendStarted(next.key,next.claimToken);await store.completeNotification(next.key,next.claimToken,{messageId:'om_next_already'});
    await store.acceptWarehouseInboundHandover(input());const job=(await store.takeNextWarehouseInboundHandover())!;await store.recordWarehouseInboundCardPatched(mutationId,job.claimToken,'om_old_already');await store.completeWarehouseInboundHandover(mutationId,job.claimToken);expect((await store.findWarehouseInboundHandover(mutationId))?.deliveredMessageId).toBe('om_next_already');expect(await store.takeNextNotification(new Date(),60000,['warehouse_inbound'])).toBeNull();
  });
  it('交接新提醒的发送开始在原生CAS内复核授权，拒绝时不产生发送凭据',async()=>{
    await store.acceptWarehouseInboundHandover(input());const job=(await store.takeNextWarehouseInboundHandover())!;await store.completeWarehouseInboundHandover(mutationId,job.claimToken);const notice=(await store.takeNextNotification())!,bytes=readFileSync(file,'utf8');
    await expect(store.markInboundCompletedSendStarted(notice.key,notice.claimToken,new Date(),()=>false)).rejects.toThrow();expect(readFileSync(file,'utf8')).toBe(bytes);expect((await store.markInboundCompletedSendStarted(notice.key,notice.claimToken,new Date(),()=>true))?.sendOutcome).toBe('unknown');
  });
  it('实际后台旧卡更新失败后重启续办，原卡终态后实际发送新卡并保存ACK',async()=>{
    const Worker=require('../../server/modules/purchase-inventory/warehouse-inbound-handover.service').WarehouseInboundHandoverService;
    const old=(await store.takeNextNotification())!;await store.completeNotification(old.key,old.claimToken,{messageId:'om_worker_old'});await store.acceptWarehouseInboundHandover(input());
    let fail=true;const order:string[]=[];const gateway={updateInteractiveCard:jest.fn(async(_id:string,card:unknown)=>{expect(JSON.stringify(card)).not.toContain('behaviors');order.push('old');if(fail){fail=false;throw Error('synthetic-patch-failure');}}),getExecutionRecordAsApp:jest.fn().mockResolvedValue({recordId,status:'到货已签收（待入库）',itemName:'合成物料',actualQuantity:1,requestedQuantity:1,building:'C楼',requesterName:'合成申请人',purchaserName:'合成采购人',signer:'合成收货人',receiptTime:1792022400000,requestCode:'SYNTHETIC'}),sendInteractiveCard:jest.fn(async()=>{order.push('new');return 'om_worker_new';})},configuration={canUseFeishuBusinessIdentity:()=>true};
    const now=new Date();expect((await new Worker(store,gateway,{isEnabled:()=>true},configuration).runPending(1,now)).failed).toBe(1);expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();await store.onModuleDestroy();store=new PurchaseWorkflowStore(file) as Port;await store.onModuleInit();
    expect((await new Worker(store,gateway,{isEnabled:()=>true},configuration).runPending(1,new Date(now.getTime()+120000))).failed).toBe(0);
    const service=new PurchaseWorkflowService(gateway as never,store,undefined,configuration as never);jest.spyOn(service,'isEnabled').mockReturnValue(true);expect((await service.runPendingTasks(1,new Date(now.getTime()+120001))).failed).toBe(0);expect(order).toEqual(['old','old','new']);expect((await store.findWarehouseInboundHandover(mutationId))?.deliveredMessageId).toBe('om_worker_new');
  });
  it('业务先办结时只终态旧卡，回执明确无需新提醒，不伪造已投递',async()=>{
    const Worker=require('../../server/modules/purchase-inventory/warehouse-inbound-handover.service').WarehouseInboundHandoverService;await store.acceptWarehouseInboundHandover(input());
    const gateway={updateInteractiveCard:jest.fn(),getExecutionRecordAsApp:jest.fn().mockResolvedValue({recordId,status:'物品签收已入库',itemName:'合成物料'}),sendInteractiveCard:jest.fn()},configuration={canUseFeishuBusinessIdentity:()=>true},now=new Date();
    await new Worker(store,gateway,{isEnabled:()=>true},configuration).runPending(1,now);const service=new PurchaseWorkflowService(gateway as never,store,undefined,configuration as never);jest.spyOn(service,'isEnabled').mockReturnValue(true);await service.runPendingTasks(1,new Date(now.getTime()+1000));expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();expect(await store.findWarehouseInboundHandover(mutationId)).toMatchObject({status:'completed',deliveryDisposition:'business_completed',deliveredMessageId:''});
  });
});
