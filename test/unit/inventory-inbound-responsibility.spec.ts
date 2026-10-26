import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { InventoryInboundTaskLedgerStore, buildInventoryInboundTaskRequestFingerprint, type InventoryInboundTaskLedgerEntry } from '../../server/modules/inventory-management/inventory-inbound-task-ledger.store';
import { InventoryInboundTaskService } from '../../server/modules/inventory-management/inventory-inbound-task.service';

const recordId='recInboundResponsibility',mutationId=`handover-${'a'.repeat(64)}`;
const assignment=()=>({recordId,expectedGeneration:1,recordFingerprint:'b'.repeat(64),mutationId,dutyRecordId:'recInboundDuty',
  source:{personRecordId:'recInboundOld',openId:'ou_inbound_old',name:'合成前任',accountIds:[`feishu-${'a'.repeat(64)}`]},
  target:{personRecordId:'recInboundNew',openId:'ou_inbound_new',name:'合成接任者',accountIds:[`feishu-${'b'.repeat(64)}`,`local-external-${'c'.repeat(64)}`]}});
type Port=InventoryInboundTaskLedgerStore & {handoverPurchaseResponsibility(value:ReturnType<typeof assignment>):Promise<{status:string;generation:number}>;purchaseResponsibility(recordId:string):Promise<{generation:number;target:ReturnType<typeof assignment>['target']}|undefined>};
function candidate(accountId:string,generation?:number):InventoryInboundTaskLedgerEntry {
  const request={executionRecordId:recordId,mode:'existing' as const,clientMutationId:'synthetic-inbound-responsibility',catalogRecordId:'recInboundCatalog',sku:'SYNTHETIC',building:'C楼' as const,quantity:1,occurredAt:'2026-10-15T00:00:00.000Z',...(generation===undefined?{}:{responsibilityGeneration:generation})};
  return {kind:'purchase',principal:{role:'inventory_admin',purchaseBuilding:'C楼',accountId},principalFingerprint:'synthetic-principal',requestFingerprint:buildInventoryInboundTaskRequestFingerprint('purchase',request),request,attemptCount:0,task:{id:'inventory-inbound-purchase-synthetic',kind:'purchase',status:'pending',message:'合成任务',createdAt:request.occurredAt,updatedAt:request.occurredAt}};
}
describe('入库责任与真实受理任务共用原生CAS',()=>{
  let parent:string,folder:string,owner:string,file:string,store:Port;
  beforeEach(()=>{parent=realpathSync(tmpdir());folder=mkdtempSync(join(parent,'nt-inbound-duty-'));owner=randomUUID();writeFileSync(join(folder,'.test-owner'),owner,{flag:'wx'});file=join(folder,'ledger.json');store=new InventoryInboundTaskLedgerStore(file) as Port;});
  afterEach(()=>{if(dirname(resolve(folder)).toLowerCase()!==resolve(parent).toLowerCase()||!/^nt-inbound-duty-[A-Za-z0-9]+$/.test(basename(folder))||!existsSync(folder)||lstatSync(folder).isSymbolicLink()||realpathSync(folder)!==folder||readFileSync(join(folder,'.test-owner'),'utf8')!==owner)throw Error('Owned fixture mismatch');for(const name of readdirSync(folder))if(!lstatSync(join(folder,name)).isFile()||lstatSync(join(folder,name)).isSymbolicLink())throw Error('Unsafe fixture');rmSync(folder,{recursive:true,force:false});});
  it('交接先CAS，旧账号和旧代际拒绝；飞书及姓名账号复用接任身份，原mutation不重复入库',async()=>{
    expect(await store.handoverPurchaseResponsibility(assignment())).toEqual({status:'accepted',generation:2});
    const bytes=readFileSync(file,'utf8');store=new InventoryInboundTaskLedgerStore(file) as Port;expect(await store.handoverPurchaseResponsibility(assignment())).toEqual({status:'accepted',generation:2});expect(readFileSync(file,'utf8')).toBe(bytes);
    await expect(store.reserveInbound(candidate(assignment().source.accountIds[0],2))).rejects.toThrow();await expect(store.reserveInbound(candidate(assignment().target.accountIds[0],1))).rejects.toThrow();expect(readFileSync(file,'utf8')).toBe(bytes);
    const reserved=await store.reserveInbound(candidate(assignment().target.accountIds[1],2),()=>true);expect(reserved.created).toBe(true);
    expect((await store.reserveInbound(candidate(assignment().target.accountIds[0],2),()=>true)).created).toBe(false);expect((await store.purchaseResponsibility(recordId))?.generation).toBe(2);
  });
  it('任务先受理，交接保持已受理执行及历史，不覆盖原principal',async()=>{
    await store.reserveInbound(candidate(assignment().source.accountIds[0]));const bytes=readFileSync(file,'utf8');
    expect(await store.handoverPurchaseResponsibility(assignment())).toEqual({status:'already_completed',generation:1});expect(readFileSync(file,'utf8')).toBe(bytes);expect((await store.findInboundByTaskId('inventory-inbound-purchase-synthetic'))?.principal.accountId).toBe(assignment().source.accountIds[0]);
  });
  it('同mutation冒用目标、职责或版本拒绝，责任记录损坏不能静默清空',async()=>{
    await store.handoverPurchaseResponsibility(assignment());const bytes=readFileSync(file,'utf8');
    for(const value of [{...assignment(),dutyRecordId:'recWrongDuty'},{...assignment(),target:{...assignment().target,personRecordId:'recWrongPerson'}},{...assignment(),expectedGeneration:2}])await expect(store.handoverPurchaseResponsibility(value)).rejects.toThrow();
    expect(readFileSync(file,'utf8')).toBe(bytes);const raw=JSON.parse(bytes);raw.extensions.purchaseInboundResponsibilities={invalid:true};writeFileSync(file,JSON.stringify(raw),'utf8');await expect(store.reserveInbound(candidate(assignment().target.accountIds[0],2))).rejects.toThrow();
  });
  it('不同store实例同时受理任务和交接，只能由先取得原生锁的一方生效',async()=>{
    const other=new InventoryInboundTaskLedgerStore(file) as Port;
    const [handover,reservation]=await Promise.allSettled([store.handoverPurchaseResponsibility(assignment()),other.reserveInbound(candidate(assignment().source.accountIds[0],1))]);
    expect(handover.status).toBe('fulfilled');if(handover.status!=='fulfilled')throw Error('Missing handover result');
    if(handover.value.status==='accepted'){
      expect(reservation.status).toBe('rejected');expect(await store.findInboundByTaskId('inventory-inbound-purchase-synthetic')).toBeNull();
    }else{
      expect(reservation.status).toBe('fulfilled');expect(await store.purchaseResponsibility(recordId)).toBeUndefined();
    }
  });
  it('任务worker的原生认领和更新保留责任链；后续任务不具名或缺代际时拒绝',async()=>{
    await store.handoverPurchaseResponsibility(assignment());
    await expect(store.reserveInbound(candidate(assignment().target.accountIds[0]))).rejects.toThrow();const anonymous=candidate(assignment().target.accountIds[0],2);delete anonymous.principal.accountId;await expect(store.reserveInbound(anonymous)).rejects.toThrow();
    const reserved=await store.reserveInbound(candidate(assignment().target.accountIds[0],2),()=>true);const claim=await store.claimPendingInbound(reserved.entry.task.id);expect(claim.claimed).toBe(true);
    await store.updateInboundTask(claim.entry.task.id,{...claim.entry.task,message:'合成处理进度'},claim.entry.owner!.token);
    const restarted=new InventoryInboundTaskLedgerStore(file) as Port;expect((await restarted.purchaseResponsibility(recordId))?.generation).toBe(2);expect((await restarted.findInboundByTaskId(claim.entry.task.id))?.task.message).toBe('合成处理进度');
  });
  it('保留其他任职权限的人可按当前授权办理，责任交接不额外收回其合法业务权限',async()=>{
    await store.handoverPurchaseResponsibility(assignment());
    const anotherQualifiedAccount=`feishu-${'d'.repeat(64)}`;expect((await store.reserveInbound(candidate(anotherQualifiedAccount,2),()=>true)).created).toBe(true);
  });
  it('原生CAS内再次校验当前授权，不能用在排队前通过的旧session接受新任务',async()=>{
    await store.handoverPurchaseResponsibility(assignment());let authorized=true;
    const operation=store.reserveInbound(candidate(assignment().target.accountIds[0],2),()=>authorized);authorized=false;
    await expect(operation).rejects.toThrow();expect(await store.findInboundByTaskId('inventory-inbound-purchase-synthetic')).toBeNull();
  });
  it('实际任务服务将当前会话校验放入原生受理，失效会话不产生任务',async()=>{
    await store.handoverPurchaseResponsibility(assignment());let authorized=false;
    const configuration={validateSession:jest.fn(()=>authorized)};
    const service=new InventoryInboundTaskService(store,{} as never,{} as never,{} as never,{} as never,{},configuration as never);
    const entry=candidate(assignment().target.accountIds[0],2);entry.principal.authorizationVersion=2;
    try {
      await expect(service.acceptPurchase(entry.request as never,entry.principal,entry.principalFingerprint)).rejects.toThrow();expect(await store.listRecoverableInbounds()).toHaveLength(0);
      authorized=true;const accepted=await service.acceptPurchase(entry.request as never,entry.principal,entry.principalFingerprint);expect(accepted.accepted).toBe(true);expect(await store.listRecoverableInbounds()).toHaveLength(1);
      expect(configuration.validateSession).toHaveBeenCalledWith(entry.principal.accountId,2,'inventory_admin','C楼',undefined,undefined);
    } finally {await service.onModuleDestroy();}
  });
  it('原任务明确未写入且失败时可交接后重提，原失败任务和mutation历史保留',async()=>{
    const old=await store.reserveInbound(candidate(assignment().source.accountIds[0]));const claim=await store.claimPendingInbound(old.entry.task.id);
    await store.updateInboundTask(old.entry.task.id,{...claim.entry.task,status:'failed',message:'合成明确未写入',definitelyNotWritten:true},claim.entry.owner!.token);
    expect(await store.handoverPurchaseResponsibility(assignment())).toEqual({status:'accepted',generation:2});
    const next=candidate(assignment().target.accountIds[0],2);next.request={...next.request,clientMutationId:'synthetic-inbound-retry-after-handover'};next.requestFingerprint=buildInventoryInboundTaskRequestFingerprint('purchase',next.request);next.task={...next.task,id:'inventory-inbound-purchase-retry'};
    expect((await store.reserveInbound(next,()=>true)).created).toBe(true);expect((await store.findInboundByTaskId(old.entry.task.id))?.task).toMatchObject({status:'failed',definitelyNotWritten:true});
  });
  it('锁内复核的是将要持久化的身份快照，排队期间修改调用方对象不能替旧身份过鉴权',async()=>{
    await store.handoverPurchaseResponsibility(assignment());const configuration={validateSession:jest.fn((_id:unknown,version:unknown)=>version===3)};
    const service=new InventoryInboundTaskService(store,{} as never,{} as never,{} as never,{} as never,{},configuration as never),entry=candidate(assignment().target.accountIds[0],2);entry.principal.authorizationVersion=2;
    try {const operation=service.acceptPurchase(entry.request as never,entry.principal,entry.principalFingerprint);entry.principal.authorizationVersion=3;await expect(operation).rejects.toThrow();expect(await store.listRecoverableInbounds()).toHaveLength(0);}
    finally {await service.onModuleDestroy();}
  });
});
