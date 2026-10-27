import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { OvertimeWorkflowStore, type OvertimeWorkflowMessageDelivery } from '../../server/modules/overtime-workflow/overtime-workflow.store';
import { OvertimeWorkflowService } from '../../server/modules/overtime-workflow/overtime-workflow.service';
import { OvertimePersonnelHandoverAdapter } from '../../server/modules/overtime-workflow/overtime-personnel-handover.adapter';
import type { HandoverContext } from '../../shared/personnel-handover.interface';

interface Input { recordId: string; mutationId: string; dutyRecordId: string; sourceOpenId: string; sourcePersonRecordId: string; expectedRevision: number; target: { name: string; openId: string; personRecordId: string; position: string; buildings: string[] }; }
interface Receipt { status: 'accepted' | 'already_completed'; generation: number; taskBusinessKey: string | null; }
type Port = OvertimeWorkflowStore & { acceptApprovalHandover(input: Input): Promise<Receipt>; recordApprovalCardDelivery(recordId: string, delivery: OvertimeWorkflowMessageDelivery, generation: number): Promise<void> };
const source = { name:'合成前任',openId:'ou_synthetic_old',position:'设施主管',buildings:['C楼'] };
const target = { name:'合成接任',openId:'ou_synthetic_new',personRecordId:'recNewFixture',position:'设施主管',buildings:['C楼'] };
const snapshot = { recordId:'recOvertimeFixture',applicantName:'合成申请人',applicantOpenId:'ou_synthetic_applicant',building:'C楼',position:'运维值班员',plannedStartAt:'2026-10-13T09:00:00+08:00',plannedEndAt:'2026-10-13T17:00:00+08:00',plannedHours:8,reason:'合成验收' };
const oldCard = { recipientOpenId:source.openId,messageId:'om_synthetic_old',businessKey:`overtime:${snapshot.recordId}:approval:${source.openId}` };
describe('加班未决议审批的真实账本转交',()=>{
  it('岗位事务已更新时原生受理拒绝旧人，已受理动作按原事件回放',async()=>{
    const action={recordId:input.recordId,eventId:'synthetic-role-fence',actorOpenId:source.openId,messageId:oldCard.messageId,action:'approve' as const},before=readFileSync(file,'utf8');
    await expect(store.claimApprovalAction(action,new Date(),()=>false)).rejects.toThrow('岗位');expect(readFileSync(file,'utf8')).toBe(before);expect((await store.claimApprovalAction(action,new Date(),()=>true)).claimed).toBe(true);
    const check=jest.fn(()=>false);expect((await store.claimApprovalAction(action,new Date(),check)).claimed).toBe(false);expect(check).not.toHaveBeenCalled();
  });
  let directory:string, temporaryRoot:string, owner:string, file:string, store:Port, input:Input, originalApp:string|undefined, originalEnabled:string|undefined;
  beforeEach(async()=>{
    originalApp=process.env.FEISHU_APP_ID; originalEnabled=process.env.OVERTIME_WORKFLOW_PROGRAM_ENABLED; process.env.FEISHU_APP_ID='cli_synthetic_handover'; process.env.OVERTIME_WORKFLOW_PROGRAM_ENABLED='true';
    temporaryRoot=realpathSync(tmpdir()); owner=randomUUID(); directory=mkdtempSync(join(temporaryRoot,'nt-overtime-handover-')); writeFileSync(join(directory,'.test-owner'),owner,{flag:'wx'}); file=join(directory,'ledger.json'); store=new OvertimeWorkflowStore(file,file) as Port;
    await store.acceptApplication({clientMutationId:'synthetic-overtime-request',snapshot}); await store.patchApplication(snapshot.recordId,{phase:'approval_pending',approvers:[source],approvalCards:[oldCard]});
    input={recordId:snapshot.recordId,mutationId:`handover-${'a'.repeat(64)}`,dutyRecordId:'recDutyFixture',sourceOpenId:source.openId,sourcePersonRecordId:'recOldFixture',expectedRevision:(await store.getApplication(snapshot.recordId))!.revision,target};
  });
  it('独立经理通知人员不能只替换审批人后就当作全部交接',async()=>{
    await store.enqueueTask({businessKey:'synthetic-manager-route',recordId:input.recordId,kind:'deliver_approval_cards',payload:{routeKind:'building_supervisor'}});
    const member=(value:typeof source,id:string,recordId:string)=>({id,recordId,name:value.name,openId:value.openId,active:true,type:'employee' as const,position:value.position,systemPosition:'',buildings:['C楼' as const],specialties:[],permissionTags:[],dutyRecordIds:[]});
    const context:HandoverContext={from:member(source,'local-old','recOldFixture'),to:member(target,'local-new','recNewFixture'),directoryVersion:'fixture',duties:[{recordId:input.dutyRecordId,name:'C楼主管',kind:'building_supervisor',personnelIds:['local-new'],buildings:['C楼'],specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1}]};
    const adapter=new OvertimePersonnelHandoverAdapter(store,{canUseFeishuBusinessIdentity:()=>true} as never,{isEnabled:()=>true} as never),[item]=await adapter.listPending(context);
    await store.patchApplication(input.recordId,{managerRecipients:[source]});const before=readFileSync(file,'utf8');
    await expect(adapter.listPending(context)).rejects.toThrow('独立');expect((await adapter.preflight(context,item)).ready).toBe(false);
    await expect(adapter.acceptTransfer(context,item,input.mutationId)).rejects.toThrow('独立');expect(readFileSync(file,'utf8')).toBe(before);
  });
  it('原子审批CAS内拒绝新增独立通知，原合法审批先受理则保留其结果',async()=>{
    const native=store.acceptApprovalHandover.bind(store);
    await store.patchApplication(input.recordId,{managerRecipients:[source]});input.expectedRevision=(await store.getApplication(input.recordId))!.revision;
    const before=readFileSync(file,'utf8');await expect(native(input)).rejects.toThrow('独立');expect(readFileSync(file,'utf8')).toBe(before);
    await store.claimApprovalAction({recordId:input.recordId,eventId:'synthetic-priority-action',actorOpenId:source.openId,messageId:oldCard.messageId,action:'approve'});
    const acted=readFileSync(file,'utf8');expect((await native(input)).status).toBe('already_completed');expect(readFileSync(file,'utf8')).toBe(acted);
  });
  it('真实审批adapter按保存routeKind与职责预览/CAS，已批准未确认不得被默默遗漏或改写', async () => {
    await store.enqueueTask({businessKey:'synthetic-route-evidence',recordId:input.recordId,kind:'deliver_approval_cards',payload:{routeKind:'building_supervisor'}});
    const person=(value:typeof source,recordId:string,marker:string,active:boolean)=>({id:`local-external-${marker.repeat(64)}`,recordId,name:value.name,openId:value.openId,active,type:'employee' as const,position:value.position,systemPosition:'',buildings:['C楼' as const],specialties:[],permissionTags:[],dutyRecordIds:[input.dutyRecordId]});
    const context:HandoverContext={from:person(source,input.sourcePersonRecordId,'a',false),to:person(target,target.personRecordId,'b',true),directoryVersion:'synthetic-directory',duties:[{recordId:input.dutyRecordId,name:'C楼主管',kind:'overtime_supervisor',personnelIds:[`local-external-${'a'.repeat(64)}`],buildings:['C楼'],specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1}]};
    const adapter=new OvertimePersonnelHandoverAdapter(store,{canUseFeishuBusinessIdentity:()=>true} as never,{isEnabled:()=>true} as never);
    const [item]=await adapter.listPending(context); expect(item).toMatchObject({module:'overtime',recordId:input.recordId,dutyRecordId:input.dutyRecordId,phase:'approval',status:'pending'});
    expect(await adapter.preflight(context,item)).toEqual({ready:true});
    const receipt=await adapter.acceptTransfer(context,item,input.mutationId); expect(receipt).toMatchObject({status:'accepted',version:'2'});
    expect((await adapter.preflight(context,item,input.mutationId)).ready).toBe(true);
    expect((await adapter.preflight({...context,to:{...context.to,recordId:'recWrongTarget'}},item,input.mutationId)).ready).toBe(false);
    expect(await adapter.reconcile(context,receipt)).toEqual({status:'syncing'});
    expect((await adapter.reconcile({...context,to:{...context.to,recordId:'recWrongTarget'}},receipt)).status).toBe('error');
    await store.patchApplication(input.recordId,{phase:'awaiting_confirmation',actualApproverOpenId:source.openId,actualApproverName:source.name});
    const before=readFileSync(file,'utf8'); expect(await adapter.listPending(context)).toEqual([expect.objectContaining({stageKey:'confirmation',phase:'execution',status:'pending'})]); expect(readFileSync(file,'utf8')).toBe(before);
  });
  afterEach(()=>{
    if(originalApp===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=originalApp;
    if(originalEnabled===undefined)delete process.env.OVERTIME_WORKFLOW_PROGRAM_ENABLED;else process.env.OVERTIME_WORKFLOW_PROGRAM_ENABLED=originalEnabled;
    const canonical=(value:string)=>resolve(value).toLowerCase();
    if(canonical(dirname(directory))!==canonical(temporaryRoot)||!/^nt-overtime-handover-[A-Za-z0-9]+$/u.test(basename(directory))||!existsSync(directory)||lstatSync(directory).isSymbolicLink()||canonical(realpathSync(directory))!==canonical(directory)) throw new Error('测试目录归属异常，已保留');
    for(const name of readdirSync(directory))if(!lstatSync(join(directory,name)).isFile()||lstatSync(join(directory,name)).isSymbolicLink())throw new Error('测试目录条目异常，已保留');
    if(readFileSync(join(directory,'.test-owner'),'utf8')!==owner)throw new Error('测试目录归属标记异常，已保留'); rmSync(directory,{recursive:true,force:false});
  });
  it('真实worker先补终态并持久每张回执，部分失败重启只重失败卡，再投新代际且不改已批准字段', async () => {
    while(true){const task=await store.takeNextTask(new Date(Date.now()+60_000));if(!task)break;await store.completeTask(task.key,task.claimToken);}
    const second={...oldCard,messageId:'om_synthetic_second',businessKey:`${oldCard.businessKey}:second`};
    const current=await store.patchApplication(input.recordId,{approvalCards:[oldCard,second]});
    const receipt=await store.acceptApprovalHandover({...input,expectedRevision:current.revision});
    const order:string[]=[]; let failSecond=true;
    const gateway={readOvertimeRecordIfExists:jest.fn(async()=>({recordId:input.recordId,fields:{}})),updateOvertimeRecord:jest.fn(async(_id:string,fields:Record<string,unknown>)=>{expect(fields).not.toHaveProperty('加班审批人');order.push('pending-state');}),patchInteractiveCard:jest.fn(async(messageId:string,card:Record<string,unknown>)=>{
      order.push(messageId); expect(JSON.stringify(card)).toContain('审批已转交'); expect(JSON.stringify(card)).not.toContain('callback');
      if(messageId===second.messageId&&failSecond){failSecond=false;throw new Error('synthetic-second-patch');}
    }),sendInteractiveCard:jest.fn(async(openId:string,_card:unknown,key:string)=>{expect(openId).toBe(target.openId);expect(key).toContain(':approval:v2:');order.push('new-card');return 'om_synthetic_new';})};
    const configuration={canUseFeishuBusinessIdentity:jest.fn(()=>true)};
    const service=new OvertimeWorkflowService(store,gateway as never,{} as never,configuration as never);
    expect(await service.runPendingTasks(new Date(),1)).toEqual({processed:0,failed:1}); expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    const task=(await store.listTasks()).find(task=>task.businessKey===receipt.taskBusinessKey)!; expect(task.payload.patchedMessageIds).toEqual([oldCard.messageId]);
    const restarted=new OvertimeWorkflowService(new OvertimeWorkflowStore(file,file),gateway as never,{} as never,configuration as never);
    expect(await restarted.runPendingTasks(new Date(Date.now()+60_000),2)).toEqual({processed:2,failed:0});
    expect(gateway.patchInteractiveCard.mock.calls.filter(([id])=>id===oldCard.messageId)).toHaveLength(1); expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(order.indexOf('new-card')).toBeGreaterThan(order.lastIndexOf(second.messageId));
    expect((await store.getApplication(input.recordId))).toMatchObject({actualApproverOpenId:'',approvedAt:'',approvalCards:[expect.objectContaining({recipientOpenId:target.openId,messageId:'om_synthetic_new'})]});
  });
  it('原子更新审批代际与角色，持久补卡任务并保留原批准字段；重启幂等不改字节',async()=>{
    const receipt=await store.acceptApprovalHandover(input); expect(receipt).toMatchObject({status:'accepted',generation:2});
    const current=await store.getApplication(input.recordId); expect(current).toMatchObject({approvers:[expect.objectContaining({openId:target.openId})],approvalCards:[],actualApproverOpenId:'',approvedAt:'',approvalGeneration:2});
    await expect(store.claimApprovalAction({eventId:'synthetic-old-action',recordId:input.recordId,action:'approve',actorOpenId:source.openId,messageId:oldCard.messageId})).rejects.toThrow();
    const before=readFileSync(file,'utf8'), restarted=new OvertimeWorkflowStore(file,file) as Port;
    expect(await restarted.acceptApprovalHandover(input)).toEqual(receipt); expect(readFileSync(file,'utf8')).toBe(before);
    expect((await store.listTasks()).filter(task=>task.businessKey===receipt.taskBusinessKey)).toHaveLength(1);
  });
  it('合法原审批先受理时只跳过，原批准人、动作及字节不改',async()=>{
    await store.claimApprovalAction({eventId:'synthetic-before-transfer',recordId:input.recordId,action:'approve',actorOpenId:source.openId,messageId:oldCard.messageId});
    const before=readFileSync(file,'utf8'); expect((await store.acceptApprovalHandover(input)).status).toBe('already_completed');
    expect((await store.getApplication(input.recordId))?.actualApproverOpenId).toBe(source.openId); expect(readFileSync(file,'utf8')).toBe(before);
  });
  it('旧代际投递迟到只补终态，不成为新阶段审批卡',async()=>{
    await store.acceptApprovalHandover(input);
    await store.recordApprovalCardDelivery(input.recordId,{...oldCard,messageId:'om_synthetic_late',businessKey:`${oldCard.businessKey}:late`},1);
    expect((await store.getApplication(input.recordId))?.approvalCards).toEqual([]);
    expect((await store.listTasks()).some(task=>task.kind==='sync_approval_handover'&&task.payload.patchOnly===true&&JSON.stringify(task.payload).includes('om_synthetic_late'))).toBe(true);
  });
  it('过期版本、篡改接任人和自审批拒绝且不覆盖',async()=>{
    const before=readFileSync(file,'utf8'); await expect(store.acceptApprovalHandover({...input,expectedRevision:1})).rejects.toThrow(); expect(readFileSync(file,'utf8')).toBe(before);
    await expect(store.acceptApprovalHandover({...input,target:{...target,openId:snapshot.applicantOpenId}})).rejects.toThrow(); expect(readFileSync(file,'utf8')).toBe(before);
    await store.acceptApprovalHandover(input); const accepted=readFileSync(file,'utf8');
    await expect(store.acceptApprovalHandover({...input,target:{...target,openId:'ou_synthetic_other'}})).rejects.toThrow(); expect(readFileSync(file,'utf8')).toBe(accepted);
  });
});
