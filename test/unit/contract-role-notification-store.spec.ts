import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContractWorkflowStore } from '../../server/modules/contract-management/contract-workflow.store';
interface Input {key:string;kind:'card'|'text';content:Record<string,unknown>|string;fallbackRecipients:string[];specialty?:string;}
interface Delivery {key:string;receiverOpenId:string;uuid:string;claimToken:string;kind:'card'|'text';content:Record<string,unknown>|string;}
interface Job extends Input {completedAt?:string;deliveries:Record<string,{status:string;messageId?:string}>;}
interface Port {enqueueRoleNotification(input:Input):Promise<Job>;claimRoleNotification(resolve:(job:Job)=>string[],now?:Date,key?:string):Promise<Delivery|undefined>;settleRoleNotification(delivery:Delivery,messageId:string|null,resolve:(job:Job)=>string[]):Promise<void>;listRoleNotifications():Promise<Job[]>;}
describe('合同通知复用原生账本与公共岗位解析',()=>{
  let parent:string,folder:string,owner:string,file:string,store:Port,savedApp:string|undefined;
  const input=():Input=>({key:'synthetic-contract-renewal',kind:'card',content:{header:{title:{content:'合成合同续期'}}},fallbackRecipients:['ou_old']});
  const open=()=>new ContractWorkflowStore(file) as unknown as Port;
  beforeEach(()=>{savedApp=process.env.FEISHU_APP_ID;process.env.FEISHU_APP_ID='cli_synthetic_contract_notify';parent=realpathSync(tmpdir());folder=mkdtempSync(join(parent,'nt-contract-notify-'));owner=randomUUID();writeFileSync(join(folder,'.test-owner'),owner,{flag:'wx'});file=join(folder,'contract-workflow-ledger.json');store=open();});
  afterEach(()=>{if(savedApp===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=savedApp;});
  afterEach(()=>{const canonical=(value:string)=>resolve(value).toLowerCase();if(canonical(dirname(folder))!==canonical(parent)||!/^nt-contract-notify-[A-Za-z0-9]+$/.test(basename(folder))||lstatSync(folder).isSymbolicLink()||canonical(realpathSync(folder))!==canonical(folder)||readFileSync(join(folder,'.test-owner'),'utf8')!==owner)throw Error('Owned fixture mismatch');for(const name of readdirSync(folder))if(!lstatSync(join(folder,name)).isFile()||lstatSync(join(folder,name)).isSymbolicLink())throw Error('Unsafe fixture');rmSync(folder,{recursive:true,force:false});});
  it('业务事件先持久，锁内解析现任；同事件和已送达历史不因重新任职重复发送',async()=>{
    await store.enqueueRoleNotification(input());const delivery=await store.claimRoleNotification(()=>['ou_current']);expect(delivery!.receiverOpenId).toBe('ou_current');expect(delivery!.uuid).toMatch(/^[a-f0-9-]{36}$/);
    expect(await store.claimRoleNotification(()=>['ou_current'])).toBeUndefined();await store.settleRoleNotification(delivery!,'om_confirmed',()=>['ou_current']);
    const before=readFileSync(file,'utf8');await open().enqueueRoleNotification(input());expect(await open().claimRoleNotification(()=>['ou_newer'])).toBeUndefined();expect(readFileSync(file,'utf8')).toBe(before);
    await expect(store.enqueueRoleNotification({...input(),content:{changed:'payload'}})).rejects.toThrow('重复');
  });
  it('岗位事务前合法受理的旧投递保留，尚未受理通知直接找现任，同岗其他人员不被覆盖',async()=>{
    let recipients=['ou_old','ou_colleague'];await store.enqueueRoleNotification(input());const old=await store.claimRoleNotification(()=>recipients);expect(old!.receiverOpenId).toBe('ou_old');
    recipients=['ou_new','ou_colleague'];await store.settleRoleNotification(old!,'om_old_history',()=>recipients);
    const next=await store.claimRoleNotification(()=>recipients);expect(next!.receiverOpenId).toBe('ou_new');await store.settleRoleNotification(next!,'om_new',()=>recipients);
    const colleague=await store.claimRoleNotification(()=>recipients);expect(colleague!.receiverOpenId).toBe('ou_colleague');await store.settleRoleNotification(colleague!,'om_colleague',()=>recipients);
    const [job]=await open().listRoleNotifications();expect(job.completedAt).toBeTruthy();expect(job.deliveries.ou_old.messageId).toBe('om_old_history');expect(job.deliveries.ou_new.messageId).toBe('om_new');
  });
  it('失败重试复用原UUID，超出去重安全窗口不盲发；显式空名单不回退旧人',async()=>{
    await store.enqueueRoleNotification(input());expect(await store.claimRoleNotification(()=>[])).toBeUndefined();
    const now=new Date(),first=await store.claimRoleNotification(()=>['ou_old'],now);await store.settleRoleNotification(first!,null,()=>['ou_old']);
    const retry=await open().claimRoleNotification(()=>['ou_old'],new Date(now.getTime()+1000));expect(retry!.uuid).toBe(first!.uuid);await store.settleRoleNotification(retry!,null,()=>['ou_old']);
    expect(await open().claimRoleNotification(()=>['ou_old'],new Date(now.getTime()+60*60_000))).toBeUndefined();expect((await store.listRoleNotifications())[0].completedAt).toBeUndefined();
  });
  it('原应用通知不能用另一飞书应用的身份发送',async()=>{
    await store.enqueueRoleNotification(input());const bytes=readFileSync(file,'utf8');process.env.FEISHU_APP_ID='cli_foreign_contract';await expect(store.claimRoleNotification(()=>['ou_old'])).rejects.toThrow('应用');expect(readFileSync(file,'utf8')).toBe(bytes);
  });
});
