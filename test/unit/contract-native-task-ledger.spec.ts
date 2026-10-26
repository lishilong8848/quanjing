import { mkdtempSync, realpathSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { ContractWorkflowStore } from '../../server/modules/contract-management/contract-workflow.store';
import { ContractExpiryDispositionService } from '../../server/modules/contract-management/contract-expiry-disposition.service';

interface Entry {task:{id:string;recordId:string;status:string;message:string};request:{action:'void';idempotencyKey:string};fingerprint:string;claimToken?:string;}
interface Port {acceptDispositionTask(input:{recordId:string;request:{action:'void';idempotencyKey:string};now:string;principal:{role:'admin';purchaseBuilding:null;accountId:string}},guard?:()=>boolean):Promise<Entry>;getDispositionTask(id:string):Promise<Entry|undefined>;claimDispositionTask(id:string):Promise<Entry|undefined>;settleDispositionTask(id:string,token:string,result:{status:'completed'|'failed';message:string}):Promise<void>;recoverDispositionTasks():Promise<Entry[]>;}
describe('合同原生任务复用现有账本',()=>{
  let parent:string,folder:string,owner:string,file:string,store:Port,savedApp:string|undefined;
  const input=()=>({recordId:'recSyntheticContract',request:{action:'void' as const,idempotencyKey:'6d667cdf-1b02-450f-95b1-3c927b3115a8'},now:'2026-10-16T00:00:00.000Z',principal:{role:'admin' as const,purchaseBuilding:null,accountId:'synthetic-admin'}});
  const open=()=>new (ContractWorkflowStore as unknown as new(file:string)=>Port)(file);
  beforeEach(()=>{savedApp=process.env.FEISHU_APP_ID;process.env.FEISHU_APP_ID='cli_synthetic_contract_task';parent=realpathSync(tmpdir());folder=mkdtempSync(join(parent,'nt-contract-task-'));owner=randomUUID();writeFileSync(join(folder,'.test-owner'),owner,{flag:'wx'});file=join(folder,'contract-workflow-ledger.json');store=open();});
  afterEach(()=>{if(savedApp===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=savedApp;});
  afterEach(()=>{const clean=(value:string)=>resolve(value).toLowerCase();if(clean(dirname(folder))!==clean(parent)||!/^nt-contract-task-[A-Za-z0-9]+$/.test(basename(folder))||lstatSync(folder).isSymbolicLink()||clean(realpathSync(folder))!==clean(folder)||readFileSync(join(folder,'.test-owner'),'utf8')!==owner)throw Error('Owned fixture mismatch');for(const name of readdirSync(folder))if(!lstatSync(join(folder,name)).isFile()||lstatSync(join(folder,name)).isSymbolicLink())throw Error('Unsafe fixture');rmSync(folder,{recursive:true,force:false});});
  it('受理后才返回，重复及重启使用同一正式任务，不覆盖通知历史',async()=>{
    writeFileSync(file,JSON.stringify({version:2,baselineAt:null,processed:{history:{completedAt:'2026-10-15',messageIds:['om_history']}},deliveries:{},logs:[]}));
    const first=await store.acceptDispositionTask(input(),()=>true),bytes=readFileSync(file,'utf8');expect(first.task.status).toBe('pending');expect(JSON.parse(bytes).processed.history.messageIds).toEqual(['om_history']);
    expect(await open().acceptDispositionTask(input(),()=>false)).toEqual(first);expect(readFileSync(file,'utf8')).toBe(bytes);
    await expect(store.acceptDispositionTask({...input(),recordId:'recOtherContract'},()=>true)).rejects.toThrow('重复');expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it('原受理锁内再次校验，新操作拒绝后不写盘；首个执行唯一领取',async()=>{
    await expect(store.acceptDispositionTask(input(),()=>false)).rejects.toThrow('权限');
    const entry=await store.acceptDispositionTask(input(),()=>true),claims=await Promise.all([store.claimDispositionTask(entry.task.id),store.claimDispositionTask(entry.task.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);const claimed=claims.find(Boolean)!;expect(claimed.task.status).toBe('running');expect(claimed.claimToken).toBeTruthy();
    await expect(store.settleDispositionTask(entry.task.id,'wrong-token',{status:'completed',message:'合成完成'})).rejects.toThrow('执行');
    await store.settleDispositionTask(entry.task.id,claimed.claimToken!,{status:'completed',message:'合成完成'});expect((await open().getDispositionTask(entry.task.id))!.task.status).toBe('completed');
  });
  it('重启保留待执行；已开始而结果未知的任务不自动重做，也不允许另一个请求越过核对',async()=>{
    const first=await store.acceptDispositionTask(input(),()=>true);expect((await open().recoverDispositionTasks()).map(entry=>entry.task.id)).toEqual([first.task.id]);await store.claimDispositionTask(first.task.id);
    expect(await open().recoverDispositionTasks()).toEqual([]);const unknown=await open().getDispositionTask(first.task.id);expect(unknown!.task.status).toBe('failed');expect(unknown!.task.message).toContain('核对');
    await expect(store.acceptDispositionTask({...input(),request:{...input().request,idempotencyKey:randomUUID()}},()=>true)).rejects.toThrow('核对');
  });
  it('实际服务恢复原合法待执行任务，不因前任后来撤权丢失，也不在第二次重启重复合同操作',async()=>{
    const entry=await store.acceptDispositionTask(input(),()=>true),gateway={getContract:jest.fn(async()=>({record_id:input().recordId,fields:{合同结束日期:Date.parse('2026-10-20T00:00:00.000Z')}})),updateContract:jest.fn(async()=>{})};
    const currentPrincipal=jest.fn(()=>undefined),workflow={enqueueContractLifecycleChanged:jest.fn(async()=>({attempted:true,recipients:0,sent:0,failed:0,message:'合成通知完成'}))};
    const create=()=>new ContractExpiryDispositionService(gateway as never,{} as never,workflow as never,open() as unknown as ContractWorkflowStore,{currentPrincipal} as never);
    const resumed=create();await resumed.onModuleInit();
    await (resumed as unknown as {work:Promise<void>}).work;expect((await resumed.getTaskStatus(entry.task.id)).task?.status).toBe('completed');
    await resumed.onModuleDestroy();expect(gateway.updateContract).toHaveBeenCalledTimes(1);expect(currentPrincipal).not.toHaveBeenCalled();
    const restarted=create();await restarted.onModuleInit();expect((await restarted.getTaskStatus(entry.task.id)).task?.status).toBe('completed');await restarted.onModuleDestroy();expect(gateway.updateContract).toHaveBeenCalledTimes(1);
  });
  it('损坏的原任务身份不能静默忽略或恢复为一条新任务',async()=>{
    await store.acceptDispositionTask(input(),()=>true);const ledger=JSON.parse(readFileSync(file,'utf8'));Object.values(ledger.dispositionTasks as Record<string,any>)[0].task.recordId='recCorruptedContract';writeFileSync(file,JSON.stringify(ledger));const bytes=readFileSync(file,'utf8');await expect(open().recoverDispositionTasks()).rejects.toThrow('台账无效');expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it('应用身份变化时拒绝重放旧应用的原生合同任务，保持原字节',async()=>{
    const entry=await store.acceptDispositionTask(input(),()=>true),bytes=readFileSync(file,'utf8');process.env.FEISHU_APP_ID='cli_foreign_contract';await expect(open().claimDispositionTask(entry.task.id)).rejects.toThrow('应用');expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it('原页面通过后账号已退为实名游客，实际提交不能因仍可登录而受理合同修改',async()=>{
    const service=new ContractExpiryDispositionService({} as never,{} as never,{} as never,store as unknown as ContractWorkflowStore,{currentPrincipal:()=>({role:'guest',accountId:'synthetic-admin',purchaseBuilding:null,authorizationVersion:1})} as never);
    try{await expect(service.submit(input().recordId,input().request,new Date(input().now),{...input().principal,authorizationVersion:1})).rejects.toThrow('权限');expect(readdirSync(folder)).toEqual(['.test-owner']);}finally{await service.onModuleDestroy();}
  });
});
