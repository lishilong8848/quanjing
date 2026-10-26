import {randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {InventoryOutboundApprovalStore} from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.store';
import {InventoryOutboundApprovalService} from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.service';
import {InventoryOutboundWorkflowService} from '../../server/modules/inventory-management/inventory-outbound-workflow.service';
import type {InventoryOutboundApprovalDecision,InventoryOutboundApprovalSnapshot} from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.types';
const snapshot:InventoryOutboundApprovalSnapshot={recordId:'recAcceptedProof',outboundNumber:'synthetic-proof',version:1,policyVersion:'synthetic-policy',applicantOpenId:'ou_proof_applicant',applicantName:'合成申请人',itemName:'合成物料',sku:'synthetic-proof',specification:'/',brand:'/',quantity:1,unit:'个',availableStock:8,building:'C楼',location:'合成库位',reason:'合成受理验证',appliedAt:'2026-10-15T00:00:00.000Z',approvers:[{openId:'ou_proof_previous',name:'合成原审批人'}]};
type ProofPort={assertAcceptedDecision(snapshot:InventoryOutboundApprovalSnapshot,decision:InventoryOutboundApprovalDecision):Promise<void>};
describe('出库持久合法决定消费证明',()=>{
  let folder:string,parent:string,owner:string,file:string,store:InventoryOutboundApprovalStore,service:InventoryOutboundApprovalService,decision:InventoryOutboundApprovalDecision;
  beforeEach(async()=>{
    parent=realpathSync(tmpdir());folder=mkdtempSync(join(parent,'nt-accepted-proof-'));owner=randomUUID();writeFileSync(join(folder,'.test-owner'),owner,{flag:'wx'});file=join(folder,'ledger.json');store=new InventoryOutboundApprovalStore(file);
    await store.registerPending(snapshot);await store.confirmPendingRegistration(snapshot.recordId,1);
    const ref={recordId:snapshot.recordId,version:1,kind:'approvalCardDelivery' as const,recipientOpenId:'ou_proof_previous'},claim=await store.claimWork(ref);if(!claim.claimed)throw Error('Fixture card unavailable');await store.completeWork({...ref,leaseToken:claim.leaseToken,messageId:'om_proof_accepted'});
    decision=(await store.claimDecision({recordId:snapshot.recordId,version:1,actorOpenId:'ou_proof_previous',messageId:'om_proof_accepted',eventId:'synthetic-accepted-proof',action:'approve'})).decision;
    service=new InventoryOutboundApprovalService(store,{} as never,undefined,undefined,undefined,{canUseFeishuBusinessIdentity:()=>false} as never);
  });
  afterEach(()=>{
    if(dirname(resolve(folder)).toLowerCase()!==resolve(parent).toLowerCase()||!/^nt-accepted-proof-[A-Za-z0-9]+$/.test(basename(folder))||!existsSync(folder)||lstatSync(folder).isSymbolicLink()||realpathSync(folder)!==folder||readFileSync(join(folder,'.test-owner'),'utf8')!==owner)throw Error('Owned fixture mismatch');for(const name of readdirSync(folder))if(!lstatSync(join(folder,name)).isFile()||lstatSync(join(folder,name)).isSymbolicLink())throw Error('Unsafe fixture');rmSync(folder,{recursive:true,force:false});
  });
  const proof=()=>service as unknown as ProofPort;
  it('收权后原合法受理仍可消费，重启/重复核验不改账本',async()=>{
    const current=(await store.find(snapshot.recordId,1))!,bytes=readFileSync(file,'utf8');
    await expect(proof().assertAcceptedDecision(current.snapshot,decision)).resolves.toBeUndefined();service=new InventoryOutboundApprovalService(new InventoryOutboundApprovalStore(file),{} as never);
    await expect(proof().assertAcceptedDecision(current.snapshot,decision)).resolves.toBeUndefined();expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it.each(['actorOpenId','eventId','messageId','decidedAt','action'] as const)('篡改已受理决定字段%s拒绝且无写入',async(field)=>{
    const bytes=readFileSync(file,'utf8'),value={...decision,[field]:field==='action'?'reject':`synthetic_changed_${field}`};await expect(proof().assertAcceptedDecision((await store.find(snapshot.recordId,1))!.snapshot,value as InventoryOutboundApprovalDecision)).rejects.toThrow();expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it('篡改快照数量/版本不能用原合法决定获得库存执行',async()=>{
    for(const value of [{...snapshot,quantity:2},{...snapshot,version:2}])await expect(proof().assertAcceptedDecision(value,decision)).rejects.toThrow();
  });
  it('实际执行入口先核持久决定，目录已换人仍沿原事件继续，不改原审批',async()=>{
    const directory={resolveApprovers:jest.fn(async()=>[{openId:'ou_proof_new',name:'合成接任者'}])};
    const workflow=new InventoryOutboundWorkflowService({} as never,{} as never,service,directory as never,{} as never,undefined,{} as never);
    const confirm=jest.spyOn(workflow as unknown as {confirmRecord(...args:unknown[]):Promise<void>},'confirmRecord').mockResolvedValue(undefined),current=(await store.find(snapshot.recordId,1))!;
    await workflow.finalizeApprovedOutbound(current.snapshot,decision);
    expect(confirm).toHaveBeenCalledWith(snapshot.recordId,decision.eventId,{role:'admin',purchaseBuilding:null},{snapshot:current.snapshot,decision});expect(directory.resolveApprovers).not.toHaveBeenCalled();
    const bytes=readFileSync(file,'utf8');await expect(workflow.finalizeApprovedOutbound({...current.snapshot,quantity:2},decision)).rejects.toThrow();expect(confirm).toHaveBeenCalledTimes(1);expect(readFileSync(file,'utf8')).toBe(bytes);
  });
});
