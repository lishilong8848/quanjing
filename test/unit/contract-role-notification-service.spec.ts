import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as configuration from '../../server/common/access/access-configuration.store';
import { ContractWorkflowStore } from '../../server/modules/contract-management/contract-workflow.store';
import { ContractWorkflowService } from '../../server/modules/contract-management/contract-workflow.service';

type Service=ContractWorkflowService&{flushRoleNotifications(key?:string):Promise<{sent:number;failed:number}>};
describe('实际合同通知服务读取同一岗位配置',()=>{
  let folder:string,parent:string,owner:string,savedApp:string|undefined,store:ContractWorkflowStore,config:configuration.AccessConfigurationStore;
  beforeEach(async()=>{savedApp=process.env.FEISHU_APP_ID;process.env.FEISHU_APP_ID='cli_synthetic_contract';parent=realpathSync(tmpdir());folder=mkdtempSync(join(parent,'nt-contract-notify-service-'));owner=randomUUID();writeFileSync(join(folder,'.test-owner'),owner,{flag:'wx'});store=new ContractWorkflowStore(join(folder,'contract-ledger.json'));config=new configuration.AccessConfigurationStore(join(folder,'configuration.json'));jest.spyOn(configuration,'getAccessConfigurationStore').mockReturnValue(config);await config.mutate(0,'seed-synthetic-contract-notify','seed',state=>{state.personnelDutyAssignments={recDuty:{appId:process.env.FEISHU_APP_ID!,dutyRecordId:'recDuty',kind:'contract_notify',buildings:null,specialties:null,startsAt:0,endsAt:null,version:1,confirmedBatchId:'49fc5aa6-867b-4f15-b540-df2cebd5f646',members:[{personId:`local-external-${'a'.repeat(64)}`,recordId:'recOld',name:'合成前任',openId:'ou_old'}]}};});});
  afterEach(()=>{jest.restoreAllMocks();if(savedApp===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=savedApp;const canonical=(value:string)=>resolve(value).toLowerCase();if(canonical(dirname(folder))!==canonical(parent)||!/^nt-contract-notify-service-[A-Za-z0-9]+$/.test(basename(folder))||lstatSync(folder).isSymbolicLink()||canonical(realpathSync(folder))!==canonical(folder)||readFileSync(join(folder,'.test-owner'),'utf8')!==owner)throw Error('Owned fixture mismatch');for(const name of readdirSync(folder))if(!lstatSync(join(folder,name)).isFile()||lstatSync(join(folder,name)).isSymbolicLink())throw Error('Unsafe fixture');rmSync(folder,{recursive:true,force:false});});
  async function current(openId:string){await config.mutate(config.read().revision,`synthetic-current-${openId}`,'seed',state=>{state.personnelDutyAssignments!.recDuty.members=[{personId:`local-external-${'b'.repeat(64)}`,recordId:'recNew',name:'合成接任',openId}];});}
  it('尚未受理通知转现任，已完成历史保持；实际发送携带账本UUID并先落发送状态',async()=>{
    await store.enqueueRoleNotification({key:'synthetic-contract-event',kind:'text',content:'合成合同通知',fallbackRecipients:['ou_old']});await current('ou_new');
    const gateway={sendText:jest.fn(async(receiver:string,_text:string,uuid:string)=>{const [job]=await store.listRoleNotifications();expect(job.deliveries[receiver]).toMatchObject({status:'sending',uuid});return 'om_new';})},service=new ContractWorkflowService(gateway as never,store) as Service;
    expect(await service.flushRoleNotifications()).toMatchObject({sent:1,failed:0});expect(gateway.sendText).toHaveBeenCalledWith('ou_new','合成合同通知',expect.stringMatching(/^[a-f0-9-]{36}$/));
    await current('ou_newer');expect(await service.flushRoleNotifications()).toMatchObject({sent:0,failed:0});expect(gateway.sendText).toHaveBeenCalledTimes(1);
  });
  it('配置在旧合法投递期间变化，原回执保留且同一轮给接任者补齐，不要求逐消息迁移',async()=>{
    await store.enqueueRoleNotification({key:'synthetic-contract-concurrent-event',kind:'text',content:'合成合同通知',fallbackRecipients:['ou_old']});
    const gateway={sendText:jest.fn(async(receiver:string)=>{if(receiver==='ou_old')await current('ou_new');return `om_${receiver.slice(3)}`;})},service=new ContractWorkflowService(gateway as never,store) as Service;
    expect(await service.flushRoleNotifications()).toMatchObject({sent:2,failed:0});expect(gateway.sendText.mock.calls.map(call=>call[0])).toEqual(['ou_old','ou_new']);
    const [job]=await store.listRoleNotifications();expect(job.completedAt).toBeTruthy();expect(job.deliveries.ou_old.messageId).toBe('om_old');expect(job.deliveries.ou_new.messageId).toBe('om_new');
  });
  it('续期或作废先落正式通知任务再返回已受理，发送在后台且不重复执行合同动作',async()=>{
    const gateway={readSource:jest.fn(async()=>({sourceUrl:'https://synthetic.invalid/contracts',organization:[],contracts:[],payments:[]})),sendInteractiveCard:jest.fn(async()=> 'om_lifecycle')};
    const service=new ContractWorkflowService(gateway as never,store) as Service&{enqueueContractLifecycleChanged(input:unknown):Promise<{sent:number;failed:number}>;onModuleDestroy():Promise<void>};
    const result=await service.enqueueContractLifecycleChanged({action:'void',recordId:'recSyntheticContract',name:'合成合同',code:'SYNTHETIC',endDate:'2026-10-16',ownerNames:['合成前任'],ownerOpenIds:['ou_old']});
    expect(result).toMatchObject({sent:0,failed:0});expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();const jobs=await store.listRoleNotifications();expect(jobs).toHaveLength(1);
    await service.flushRoleNotifications(jobs[0].key);await service.onModuleDestroy();expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);expect((await store.listRoleNotifications())[0].completedAt).toBeTruthy();
  });
  it.each(['created','payment'] as const)('%s通知实际业务入口也必须使用同一正式队列与固定投递编号',async(kind)=>{
    const gateway={readSource:jest.fn(async()=>({sourceUrl:'https://synthetic.invalid/contracts',organization:[],contracts:[],payments:[]})),sendInteractiveCard:jest.fn(async()=> 'om_created'),sendText:jest.fn(async()=> 'om_payment')};
    const service=new ContractWorkflowService(gateway as never,store);
    const result=kind==='created'
      ? await service.notifyContractCreated({kind:'execution',recordId:'recSyntheticContract',name:'合成合同',code:'SYNTHETIC',supplier:'合成供应商',ownerNames:['合成前任'],ownerOpenIds:['ou_old'],specialty:'电气',amount:100,startDate:'2026-10-16',endDate:'2027-10-16',selfTest:true})
      : await service.notifyPaymentFollowUpChanged({action:'confirm',contractRecordId:'recSyntheticContract',contractCode:'SYNTHETIC',contractName:'合成合同',paymentRecordId:'recSyntheticPayment',paymentLabel:'合成付款计划',period:'一期',plannedAmount:100,actualAmount:100,plannedPaymentDate:'2026-10-16',paymentDate:'2026-10-16',ownerNames:['合成前任'],ownerOpenIds:['ou_old']});
    expect(result).toMatchObject({sent:1,failed:0});const [job]=await store.listRoleNotifications();expect(job.completedAt).toBeTruthy();
    const calls=(kind==='created'?gateway.sendInteractiveCard:gateway.sendText).mock.calls as unknown[][];expect(calls[0][2]).toMatch(/^[a-f0-9-]{36}$/);await service.onModuleDestroy();
  });
  it('合同到期提醒也先持久通知，完整回执后才关闭原业务事件，历史不重复发送',async()=>{
    jest.useFakeTimers().setSystemTime(new Date('2026-10-16T01:00:00.000Z'));
    const gateway={readSource:jest.fn(async()=>({sourceUrl:'https://synthetic.invalid/contracts',organization:[],payments:[],contracts:[{record_id:'recSyntheticContract',fields:{合同编号:'SYNTHETIC',合同名称:'合成合同',合同金额:100,合同开始日期:'2026-01-01',合同结束日期:'2026-10-17',专业类别:'电气',付款计划:[{record_ids:['recSyntheticPayment']}],跟进人:[{id:'ou_old',name:'合成前任'}]}}]})),sendInteractiveCard:jest.fn(async()=> 'om_expiry')};
    const service=new ContractWorkflowService(gateway as never,store);
    try{
      expect(await service.run('contract_expiry_reminder',{trigger:'manual'})).toMatchObject({matched:1,sent:1,failed:0});
      const [job]=await store.listRoleNotifications();expect(job.completedAt).toBeTruthy();expect((await store.processedKeys()).size).toBe(1);
      await service.run('contract_expiry_reminder',{trigger:'manual'});expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    }finally{await service.onModuleDestroy();jest.useRealTimers();}
  });
  it('付款到期实际入口以原逐记录回执构造一人一张持久汇总卡',async()=>{
    jest.useFakeTimers().setSystemTime(new Date('2026-10-16T01:00:00.000Z'));
    const gateway={readSource:jest.fn(async()=>({sourceUrl:'https://synthetic.invalid/contracts',organization:[],contracts:[{record_id:'recSyntheticContract',fields:{合同编号:'SYNTHETIC',合同名称:'合成合同',跟进人:[{id:'ou_old',name:'合成前任'}]}}],payments:[1,2].map(number=>({record_id:`recSyntheticPayment${number}`,fields:{合同编号:{link_record_ids:['recSyntheticContract']},付款计划:`合成付款${number}`,计划付款金额:100,计划付款日期:'2026-10-17',付款状态:'未付款'}}))})),sendInteractiveCard:jest.fn(async()=> 'om_payment_due')};
    const service=new ContractWorkflowService(gateway as never,store);
    const reads=jest.spyOn(config,'read');
    try{
      expect(await service.run('payment_due_reminder',{trigger:'manual'})).toMatchObject({matched:2,sent:1,failed:0});
      expect(await store.listPaymentDigests()).toHaveLength(1);expect((await store.processedKeys()).size).toBe(2);expect((gateway.sendInteractiveCard.mock.calls as unknown[][])[0][2]).toMatch(/^[a-f0-9-]{36}$/);
      expect(reads.mock.calls.length).toBeLessThanOrEqual(2);
      await service.run('payment_due_reminder',{trigger:'manual'});expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    }finally{await service.onModuleDestroy();jest.useRealTimers();}
  });
  it('付款原卡已合法受理时发生改岗，回执后使用新岗位快照给接任者补齐',async()=>{
    await store.enqueuePaymentDigest({key:'synthetic-handover-digest',sourceUrl:'https://synthetic.invalid/contracts',candidates:[1,2].map(number=>({dedupeKey:`payment_due_reminder:recPayment${number}:2026-10-17`,fallbackRecipients:['ou_old'],record:{recordId:`recPayment${number}`,kind:'payment',name:`合成付款${number}`,code:'SYNTHETIC',ownerNames:['合成前任'],ownerOpenIds:['ou_old'],specialty:'电气',specialtyManagerOpenIds:[],amount:100,startDate:null,endDate:'2026-10-17',attachmentCount:0,paymentPlanCount:0,createdAt:''}}))});
    const gateway={sendInteractiveCard:jest.fn(async(receiver:string)=>{if(receiver==='ou_old')await current('ou_new');return `om_${receiver.slice(3)}`;})},service=new ContractWorkflowService(gateway as never,store);
    try{expect(await service.flushPaymentDigests()).toEqual({sent:2,failed:0});expect(gateway.sendInteractiveCard.mock.calls.map(call=>call[0])).toEqual(['ou_old','ou_new']);expect((await store.processedKeys()).size).toBe(2);const [job]=await store.listPaymentDigests();expect(job.completedAt).toBeTruthy();}finally{await service.onModuleDestroy();}
  });
});
