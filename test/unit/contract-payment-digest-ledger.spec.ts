import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContractWorkflowStore } from '../../server/modules/contract-management/contract-workflow.store';
import type { ContractWorkflowRecord } from '../../server/modules/contract-management/contract-workflow.rules';
interface Candidate {dedupeKey:string;record:ContractWorkflowRecord;fallbackRecipients:string[];}
interface Input {key:string;candidates:Candidate[];sourceUrl:string;}
interface Dispatch {key:string;uuid:string;claimToken:string;receiverOpenId:string;content:Record<string,unknown>;candidateKeys:string[];}
type Resolver=(candidate:Candidate)=>string[];
type Renderer=(records:ContractWorkflowRecord[],sourceUrl:string)=>Record<string,unknown>;
interface Port {enqueuePaymentDigest(input:Input):Promise<unknown>;claimPaymentDigest(resolve:Resolver,render:Renderer,now?:Date):Promise<Dispatch|undefined>;settlePaymentDigest(dispatch:Dispatch,messageId:string|null,resolve:Resolver):Promise<void>;recoverPaymentDigests():Promise<void>;processedKeys():Promise<Set<string>>;}
const candidate=(number:number,recipients=['ou_manager','ou_owner']):Candidate=>({dedupeKey:`payment_due_reminder:recPayment${number}:2026-10-17`,record:{recordId:`recPayment${number}`,kind:'payment',name:`合成付款${number}`,code:'SYNTHETIC',ownerNames:['合成跟进人'],ownerOpenIds:['ou_owner'],specialty:'电气',specialtyManagerOpenIds:[],amount:100,startDate:null,endDate:'2026-10-17',attachmentCount:0,paymentPlanCount:0,createdAt:'2026-10-16T00:00:00.000Z',paymentStatus:'未付款'},fallbackRecipients:recipients});
const render:Renderer=records=>({records:records.map(record=>record.recordId)});
describe('付款汇总复用原逐记录投递回执',()=>{
  let parent:string,folder:string,owner:string,file:string,store:Port,savedApp:string|undefined;
  const open=()=>new ContractWorkflowStore(file) as unknown as Port;
  beforeEach(()=>{savedApp=process.env.FEISHU_APP_ID;process.env.FEISHU_APP_ID='cli_synthetic_payment_digest';parent=realpathSync(tmpdir());folder=mkdtempSync(join(parent,'nt-contract-digest-'));owner=randomUUID();writeFileSync(join(folder,'.test-owner'),owner,{flag:'wx'});file=join(folder,'contract-workflow-ledger.json');store=open();});
  afterEach(()=>{if(savedApp===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=savedApp;const canonical=(value:string)=>resolve(value).toLowerCase();if(canonical(dirname(folder))!==canonical(parent)||!/^nt-contract-digest-[A-Za-z0-9]+$/.test(basename(folder))||lstatSync(folder).isSymbolicLink()||canonical(realpathSync(folder))!==canonical(folder)||readFileSync(join(folder,'.test-owner'),'utf8')!==owner)throw Error('Owned fixture mismatch');for(const name of readdirSync(folder))if(!lstatSync(join(folder,name)).isFile()||lstatSync(join(folder,name)).isSymbolicLink())throw Error('Unsafe fixture');rmSync(folder,{recursive:true,force:false});});
  it('每人一张含其全部未送达记录的卡，部分失败和重启不重发经理、不丢跟进人',async()=>{
    const input:Input={key:'synthetic-payment-batch',candidates:[candidate(1),candidate(2)],sourceUrl:'https://synthetic.invalid/contracts'};await store.enqueuePaymentDigest(input);const recipients:Resolver=row=>row.fallbackRecipients;
    const manager=await store.claimPaymentDigest(recipients,render);expect(manager!.receiverOpenId).toBe('ou_manager');expect(manager!.content).toEqual({records:['recPayment1','recPayment2']});await store.settlePaymentDigest(manager!,'om_manager',recipients);
    const owner=await store.claimPaymentDigest(recipients,render);expect(owner!.receiverOpenId).toBe('ou_owner');await store.settlePaymentDigest(owner!,null,recipients);
    const restarted=open();await restarted.recoverPaymentDigests();const retry=await restarted.claimPaymentDigest(recipients,render);expect(retry!.receiverOpenId).toBe('ou_owner');expect(retry!.uuid).toBe(owner!.uuid);expect(retry!.content).toEqual(owner!.content);await restarted.settlePaymentDigest(retry!,'om_owner',recipients);
    expect((await restarted.processedKeys()).size).toBe(2);expect(await restarted.claimPaymentDigest(recipients,render)).toBeUndefined();
  });
  it('重叠批次按原逐记录回执剪去已送达记录，不因组合不同重复通知',async()=>{
    const recipients:Resolver=()=>['ou_current'];await store.enqueuePaymentDigest({key:'synthetic-first-batch',candidates:[candidate(1),candidate(2)],sourceUrl:'https://synthetic.invalid/contracts'});const first=await store.claimPaymentDigest(recipients,render);await store.settlePaymentDigest(first!,'om_first',recipients);
    await store.enqueuePaymentDigest({key:'synthetic-next-batch',candidates:[candidate(1),candidate(2),candidate(3)],sourceUrl:'https://synthetic.invalid/contracts'});const next=await store.claimPaymentDigest(recipients,render);expect(next!.content).toEqual({records:['recPayment3']});expect(next!.candidateKeys).toEqual([candidate(3).dedupeKey]);await store.settlePaymentDigest(next!,'om_next',recipients);expect((await store.processedKeys()).size).toBe(3);
  });
  it('应用变更不能重放原汇总；伪造执行回执不写盘',async()=>{
    const recipients:Resolver=()=>['ou_current'];await store.enqueuePaymentDigest({key:'synthetic-app-batch',candidates:[candidate(1)],sourceUrl:'https://synthetic.invalid/contracts'});const first=await store.claimPaymentDigest(recipients,render),bytes=readFileSync(file,'utf8');await expect(store.settlePaymentDigest({...first!,claimToken:'forged'},'om_forged',recipients)).rejects.toThrow('归属');expect(readFileSync(file,'utf8')).toBe(bytes);
    process.env.FEISHU_APP_ID='cli_foreign_digest';await expect(store.claimPaymentDigest(recipients,render)).rejects.toThrow('应用');expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it('进程中断后的未知发送只用原UUID和原卡恢复，超过去重窗口不盲发',async()=>{
    const recipients:Resolver=()=>['ou_current'],now=new Date();await store.enqueuePaymentDigest({key:'synthetic-restart-batch',candidates:[candidate(1)],sourceUrl:'https://synthetic.invalid/contracts'});const first=await store.claimPaymentDigest(recipients,render,now);await open().recoverPaymentDigests();const retry=await open().claimPaymentDigest(recipients,render,new Date(now.getTime()+1000));expect(retry!.uuid).toBe(first!.uuid);expect(retry!.content).toEqual(first!.content);await store.settlePaymentDigest(retry!,null,recipients);expect(await store.claimPaymentDigest(recipients,render,new Date(now.getTime()+60*60_000))).toBeUndefined();expect((await store.processedKeys()).size).toBe(0);
  });
  it('超长汇总分段，每条候选只进入一个已确认消息，不越过卡片大小限制',async()=>{
    const rows=Array.from({length:6},(_,index)=>{const row=candidate(index+1);row.record.name='x'.repeat(5000);return row;}),recipients:Resolver=()=>['ou_current'];await store.enqueuePaymentDigest({key:'synthetic-chunk-batch',candidates:rows,sourceUrl:'https://synthetic.invalid/contracts'});
    const renderNames:Renderer=records=>({names:records.map(record=>record.name)}),keys:string[]=[];
    for(let count=0;count<6;count++){const next=await store.claimPaymentDigest(recipients,renderNames);if(!next)break;expect(Buffer.byteLength(JSON.stringify(next.content),'utf8')).toBeLessThanOrEqual(28_000);keys.push(...next.candidateKeys);await store.settlePaymentDigest(next,`om_chunk_${count}`,recipients);}
    expect(keys).toHaveLength(6);expect(new Set(keys).size).toBe(6);expect((await store.processedKeys()).size).toBe(6);
  });
});
