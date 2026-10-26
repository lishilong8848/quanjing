import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PurchaseWorkflowService } from '../../server/modules/purchase-inventory/purchase-workflow.service';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

const recordId='recWarehouseDelivery';
const notice={recordId,businessEventId:`warehouse-inbound:${recordId}`,recipientOpenId:'ou_synthetic_keeper',kind:'warehouse_inbound' as const};
const record:PurchaseWorkflowRecord={recordId,requestCode:'SYNTHETIC',status:'到货已签收（待入库）',itemName:'合成物料',building:'C楼',requesterOpenId:'ou_synthetic_applicant',requesterName:'合成申请人',purchaserOpenId:'ou_synthetic_purchaser',purchaserName:'合成采购人',purchaseMethod:'综合采购',requestedQuantity:1,actualQuantity:1,actualAmount:1,paymentAttachmentTokens:[],approvalCompleted:true,warehouseConfirmed:true,purchaseCompleted:true,receiptConfirmed:true,signer:'合成签收人',signerOpenId:'ou_synthetic_applicant',receiptTime:1792022400000,receiptPhotoTokens:[],invoiceTokens:[]};
describe('待入库提醒原生投递凭据',()=>{
  let parent:string,folder:string,owner:string,file:string,store:PurchaseWorkflowStore,savedPublicBase:string|undefined;
  beforeEach(async()=>{savedPublicBase=process.env.PUBLIC_BASE_URL;process.env.PUBLIC_BASE_URL='https://ops.example.com/';parent=realpathSync(tmpdir());folder=mkdtempSync(join(parent,'nt-warehouse-delivery-'));owner=randomUUID();writeFileSync(join(folder,'.test-owner'),owner,{flag:'wx'});file=join(folder,'ledger.json');store=new PurchaseWorkflowStore(file);await store.onModuleInit();});
  afterEach(async()=>{if(savedPublicBase===undefined)delete process.env.PUBLIC_BASE_URL;else process.env.PUBLIC_BASE_URL=savedPublicBase;jest.restoreAllMocks();await store.onModuleDestroy();if(dirname(resolve(folder)).toLowerCase()!==resolve(parent).toLowerCase()||!/^nt-warehouse-delivery-[A-Za-z0-9]+$/.test(basename(folder))||!existsSync(folder)||lstatSync(folder).isSymbolicLink()||realpathSync(folder)!==folder||readFileSync(join(folder,'.test-owner'),'utf8')!==owner)throw Error('Owned fixture mismatch');for(const name of readdirSync(folder))if(!lstatSync(join(folder,name)).isFile()||lstatSync(join(folder,name)).isSymbolicLink())throw Error('Unsafe fixture');rmSync(folder,{recursive:true,force:false});});
  it('超时后重启复用同一持久UUID及发送凭据，结果确认后不再次投递',async()=>{
    const now=new Date();const [{entry}]=await store.enqueueNotifications([notice],now);
    const send=jest.fn().mockRejectedValueOnce(new Error('synthetic-send-timeout')).mockResolvedValue('om_synthetic_warehouse');
    const gateway={getExecutionRecordAsApp:jest.fn().mockResolvedValue(record),sendInteractiveCard:send};
    const make=()=>{const service=new PurchaseWorkflowService(gateway as never,store);jest.spyOn(service,'isEnabled').mockReturnValue(true);return service;};
    expect(await make().runPendingTasks(1,now)).toMatchObject({failed:1,errors:[expect.stringContaining('synthetic-send-timeout')]});expect((await store.listNotifications({recordId}))[0]).toMatchObject({sendOutcome:'unknown'});
    await store.onModuleDestroy();store=new PurchaseWorkflowStore(file);await store.onModuleInit();expect((await make().runPendingTasks(1,new Date(now.getTime()+120000))).failed).toBe(0);
    expect(send.mock.calls).toHaveLength(2);expect(send.mock.calls[0][2]).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);expect(send.mock.calls[1][2]).toBe(send.mock.calls[0][2]);
    expect((await store.listNotifications({recordId}))[0]).toMatchObject({deliveryUuid:send.mock.calls[0][2],messageId:'om_synthetic_warehouse',status:'completed',sendOutcome:'delivered'});expect(await store.takeNextNotification(new Date(now.getTime()+240000),60000,['warehouse_inbound'])).toBeNull();expect(entry.key).toBe((await store.listNotifications({recordId}))[0].key);
  });
  it('旧提醒已尝试发送却没有幂等凭据时转人工核对，不能当从未发送自动重发',async()=>{
    await store.enqueueNotifications([notice]);const raw=JSON.parse(readFileSync(file,'utf8'));Object.assign(raw.notifications[0],{attempts:1,deliveryUuid:'',messageId:'',firstSendAttemptAt:'',sendOutcome:'unattempted'});writeFileSync(file,JSON.stringify(raw),'utf8');
    expect(await store.takeNextNotification(new Date(),60000,['warehouse_inbound'])).toBeNull();expect((await store.listNotifications({recordId}))[0]).toMatchObject({status:'manual_reconciliation',sendOutcome:'manual_reconciliation'});
  });
  it('旧提醒从未发送可补稳定UUID，未知结果超过既有窗口后停止自动重发',async()=>{
    const now=new Date();await store.enqueueNotifications([notice],now);const claim=(await store.takeNextNotification(now,60000,['warehouse_inbound']))!;
    expect(claim.deliveryUuid).toBeTruthy();await store.markInboundCompletedSendStarted(claim.key,claim.claimToken,now);await store.rescheduleNotification(claim.key,claim.claimToken,new Error('synthetic-unknown'),new Date(now.getTime()+120000),now);
    expect(await store.takeNextNotification(new Date(now.getTime()+3600001),60000,['warehouse_inbound'])).toBeNull();expect((await store.listNotifications({recordId}))[0]).toMatchObject({status:'manual_reconciliation',sendOutcome:'manual_reconciliation'});
  });
  it('业务已办结仍保留先前未知投递状态，不能把未核对结果记成通知成功',async()=>{
    const now=new Date();await store.enqueueNotifications([notice],now);const claim=(await store.takeNextNotification(now,60000,['warehouse_inbound']))!;await store.markInboundCompletedSendStarted(claim.key,claim.claimToken,now);await store.rescheduleNotification(claim.key,claim.claimToken,new Error('synthetic-unknown'),new Date(now.getTime()+120000),now);
    const gateway={getExecutionRecordAsApp:jest.fn().mockResolvedValue({...record,status:'物品签收已入库'}),sendInteractiveCard:jest.fn()};const service=new PurchaseWorkflowService(gateway as never,store);jest.spyOn(service,'isEnabled').mockReturnValue(true);
    expect((await service.runPendingTasks(1,new Date(now.getTime()+120000))).failed).toBe(1);expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();expect((await store.listNotifications({recordId}))[0]).toMatchObject({status:'pending',sendOutcome:'unknown'});
  });
});
