import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {LeaveWorkflowStore, type LeaveWorkflowStage} from '../../server/modules/leave-workflow/leave-workflow.store';
import {LeaveWorkflowService} from '../../server/modules/leave-workflow/leave-workflow.service';
import {LeavePersonnelHandoverAdapter} from '../../server/modules/leave-workflow/leave-personnel-handover.adapter';
import type {HandoverContext} from '../../shared/personnel-handover.interface';

const recordId='recFutureLeave',mutationId=`handover-${'e'.repeat(64)}`;
const supervisor={name:'合成主管',openId:'ou_future_supervisor',personRecordId:'recSupervisor',position:'设施主管',buildings:['C楼']};
const previous={name:'合成原经理',openId:'ou_future_previous',personRecordId:'recPreviousManager',position:'经理',buildings:['C楼']};
const next={name:'合成接任经理',openId:'ou_future_next',personRecordId:'recNextManager',position:'经理',buildings:['C楼']};
interface FutureInput{recordId:string;mutationId:string;dutyRecordId:string;sourceOpenId:string;sourcePersonRecordId:string;expectedRevision:number;expectedCurrentStage:LeaveWorkflowStage;expectedPlanHash:string;target:typeof next;}
interface FuturePort{acceptFutureManagerHandover(input:FutureInput):Promise<{status:string;revision:number;taskBusinessKey:string|null}>;}
const planHash=(plan:unknown)=>createHash('sha256').update(JSON.stringify(plan)).digest('hex');
const context=():HandoverContext=>({from:{id:`local-external-${'a'.repeat(64)}`,recordId:previous.personRecordId,name:previous.name,openId:previous.openId,active:false,type:'employee',position:'经理',systemPosition:'',buildings:['C楼'],specialties:[],permissionTags:[],dutyRecordIds:['recFutureDuty']},to:{id:`local-external-${'b'.repeat(64)}`,recordId:next.personRecordId,name:next.name,openId:next.openId,active:true,type:'employee',position:'经理',systemPosition:'',buildings:['C楼'],specialties:[],permissionTags:[],dutyRecordIds:['recFutureDuty']},directoryVersion:'synthetic-future',duties:[{recordId:'recFutureDuty',name:'请休假经理',kind:'leave_manager',personnelIds:[`local-external-${'a'.repeat(64)}`],buildings:null,specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1}]});

describe('请休假未来经理交接：真实账本与实际worker，外部受控',()=>{
  let folder:string,parent:string,owner:string,file:string,store:LeaveWorkflowStore,workflow:LeaveWorkflowService,adapter:LeavePersonnelHandoverAdapter;
  let saved:Record<string,string|undefined>,gateway:{updateLeaveRecord:jest.Mock;readLeaveRecord:jest.Mock;patchInteractiveCard:jest.Mock;sendInteractiveCard:jest.Mock};
  beforeEach(async()=>{
    saved=Object.fromEntries(['FEISHU_APP_ID','LEAVE_WORKFLOW_PROGRAM_ENABLED'].map(key=>[key,process.env[key]]));process.env.FEISHU_APP_ID='cli_future_fixture';process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED='true';
    parent=realpathSync(tmpdir());folder=mkdtempSync(join(parent,'nt-leave-future-'));owner=randomUUID();writeFileSync(join(folder,'.test-owner'),owner,{flag:'wx'});file=join(folder,'ledger.json');store=new LeaveWorkflowStore(file,file);
    await store.acceptApplication({recordId,clientMutationId:'synthetic-future-application',snapshot:{applicantName:'合成申请人',applicantOpenId:'ou_future_applicant',applicantPersonRecordId:'recFutureApplicant',building:'C楼',position:'运维值班员',leaveType:'年假',startAt:'2026-10-16T09:00:00+08:00',endAt:'2026-10-16T18:00:00+08:00',leaveHours:8,approvalDayCount:2,reason:'合成未来经理验收'}});
    const snapshot=(await store.getApplication(recordId))!.snapshot;
    await store.setApprovalPlan(recordId,{snapshot,approvalPlan:{approvalClass:'ordinary',discipline:null,approvalDayCount:2,stages:[{key:'supervisor',approvers:[supervisor],resolutionPolicy:'first_legal_action'},{key:'manager',approvers:[previous],resolutionPolicy:'first_legal_action'}],notificationPlan:{finalResultRecipients:[supervisor,previous],professionalRecipients:[],substituteRecipients:[]}},resultRecipients:[supervisor,previous]});
    await store.setPendingStage(recordId,{key:'supervisor',version:1,approverOpenIds:[supervisor.openId]});
    let task;while((task=await store.takeNextTask()))await store.completeTask(task.key,task.claimToken);
    await store.recordStageCardDelivery(recordId,{recipientOpenId:supervisor.openId,messageId:'om_future_supervisor',businessKey:`leave:${recordId}:stage:supervisor:1:${supervisor.openId}`});
    const cloud:Record<string,unknown>={};let sent=0;
    gateway={updateLeaveRecord:jest.fn(async(_id,fields)=>{Object.assign(cloud,fields);}),readLeaveRecord:jest.fn(async()=>({recordId,fields:{...cloud}})),patchInteractiveCard:jest.fn().mockResolvedValue(undefined),sendInteractiveCard:jest.fn(async()=>`om_future_${++sent}`)};
    const configuration={canUseFeishuBusinessIdentity:()=>true};
    workflow=new LeaveWorkflowService(store,gateway as never,{} as never,undefined,{canUseFeishuBusinessIdentity:()=>true} as never);
    adapter=new LeavePersonnelHandoverAdapter(store,configuration as never,workflow);
  });
  afterEach(()=>{
    for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    if(dirname(resolve(folder)).toLowerCase()!==resolve(parent).toLowerCase()||!existsSync(folder)||lstatSync(folder).isSymbolicLink()||realpathSync(folder)!==folder||readFileSync(join(folder,'.test-owner'),'utf8')!==owner)throw Error('Owned fixture mismatch');
    for(const name of readdirSync(folder))if(!lstatSync(join(folder,name)).isFile()||lstatSync(join(folder,name)).isSymbolicLink())throw Error('Unsafe fixture entry');rmSync(folder,{recursive:true,force:false});
  });
  async function input():Promise<FutureInput>{const current=(await store.getApplication(recordId))!;return {recordId,mutationId,dutyRecordId:'recFutureDuty',sourceOpenId:previous.openId,sourcePersonRecordId:previous.personRecordId,expectedRevision:current.revision,expectedCurrentStage:current.currentStage!,expectedPlanHash:planHash(current.approvalPlan),target:next};}
  const accept=(value:FutureInput)=>(store as unknown as FuturePort).acceptFutureManagerHandover(value);
  const approve=()=>store.claimStageAction({recordId,eventId:'synthetic-supervisor-approve',stageKey:'supervisor',stageVersion:1,actorOpenId:supervisor.openId,actorName:supervisor.name,messageId:'om_future_supervisor',action:'approve'});
  it('原子更新未来经理且不改当前阶段、卡片与已完成历史，重复/重启同请求不重写',async()=>{
    const request=await input(),before=(await store.getApplication(recordId))!;
    const result=await accept(request);expect(result.status).toBe('accepted');
    const current=(await store.getApplication(recordId))!;
    expect(current.currentStage).toEqual(before.currentStage);expect(current.stageCards).toEqual(before.stageCards);expect(current.status).toBe('supervisor_pending');
    expect(current.approvalPlan?.stages[1].approvers).toEqual([next]);expect(current.resultRecipients.map(person=>person.openId)).toEqual(expect.arrayContaining([supervisor.openId,next.openId]));expect(current.resultRecipients.some(person=>person.openId===previous.openId)).toBe(false);
    const bytes=readFileSync(file,'utf8');store=new LeaveWorkflowStore(file,file);expect(await accept(request)).toEqual(result);expect(readFileSync(file,'utf8')).toBe(bytes);
    await expect(accept({...request,target:{...next,personRecordId:'recOtherIdentity'}})).rejects.toThrow('重复');expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it('真实adapter列出未来阶段，实际worker进入经理时只发给接任人',async()=>{
    const [item]=await adapter.listPending(context());expect(item).toMatchObject({stageKey:'future_manager',phase:'approval',status:'pending',dutyRecordId:'recFutureDuty'});
    const receipt=await adapter.acceptTransfer(context(),item,mutationId);expect(await adapter.reconcile(context(),receipt)).toEqual({status:'syncing'});
    expect(await workflow.runPendingTasks(new Date(),1)).toEqual({processed:1,failed:0});expect(gateway.updateLeaveRecord).not.toHaveBeenCalled();expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();expect(await adapter.reconcile(context(),receipt)).toEqual({status:'success'});
    expect((await approve()).accepted).toBe(true);expect(await workflow.runPendingTasks(new Date(),1)).toEqual({processed:1,failed:0});
    expect((await store.getApplication(recordId))?.currentStage?.approverOpenIds).toEqual([next.openId]);
    await workflow.runPendingTasks(new Date(),1);expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(next.openId,expect.anything(),expect.any(String));expect(gateway.sendInteractiveCard.mock.calls.some(([id])=>id===previous.openId)).toBe(false);
    expect((await store.getStageAction(recordId,'supervisor',1))?.actorOpenId).toBe(supervisor.openId);
  });
  it('专业申请的未来经理单独交接，专业通知及当前主管保持原职责',async()=>{
    const current=(await store.getApplication(recordId))!,professional={...supervisor,name:'合成电气主管',openId:'ou_future_electrical',personRecordId:'recElectrical',position:'电气主管'};
    const plan={...current.approvalPlan!,discipline:'electrical' as const,notificationPlan:{...current.approvalPlan!.notificationPlan,managerRecipients:[previous],professionalRecipients:[professional],finalResultRecipients:[supervisor,previous,professional]}};
    await store.setApprovalPlan(recordId,{snapshot:{...current.snapshot,position:'电气工程师'},approvalPlan:plan,resultRecipients:[supervisor,previous,professional]});
    await store.setPendingStage(recordId,{key:'supervisor',version:1,approverOpenIds:[supervisor.openId]});
    const [item]=await adapter.listPending(context());const receipt=await adapter.acceptTransfer(context(),item,mutationId);
    expect(await workflow.runPendingTasks(new Date(),1)).toEqual({processed:1,failed:0});expect(await adapter.reconcile(context(),receipt)).toEqual({status:'success'});
    const after=(await store.getApplication(recordId))!;expect(after.approvalPlan?.notificationPlan.professionalRecipients).toEqual([professional]);expect(after.approvalPlan?.notificationPlan.managerRecipients).toEqual([next]);expect(after.currentStage?.approverOpenIds).toEqual([supervisor.openId]);
  });
  it('主管先受理则暂拒，正常进入经理后同一原请求可恢复为当前经理交接',async()=>{
    const request=await input();await approve();const before=readFileSync(file,'utf8');await expect(accept(request)).rejects.toThrow('同步');expect(readFileSync(file,'utf8')).toBe(before);
    await workflow.runPendingTasks(new Date(),1);expect((await store.getApplication(recordId))?.currentStage?.key).toBe('manager');
    expect((await accept(request)).status).toBe('accepted');expect((await store.getApplication(recordId))?.currentStage?.approverOpenIds).toEqual([next.openId]);
    await workflow.runPendingTasks(new Date(),10);expect(gateway.sendInteractiveCard.mock.calls.some(([id])=>id===previous.openId)).toBe(false);
  });
  it('计划被改或出现新的独立通知时保原字节，不以旧预览覆盖',async()=>{
    const request=await input();await store.enqueueTask({recordId,businessKey:'synthetic-independent-notice',kind:'deliver_result_cards'});const before=readFileSync(file,'utf8');await expect(accept(request)).rejects.toThrow(/通知|任务/);expect(readFileSync(file,'utf8')).toBe(before);
  });
  it('申请人身份不能因经理交接被替换，兼任通知职责明确阻断',async()=>{
    const current=(await store.getApplication(recordId))!;current.approvalPlan!.notificationPlan.professionalRecipients=[previous];await store.patchApplication(recordId,{approvalPlan:current.approvalPlan});const request=await input(),before=readFileSync(file,'utf8');await expect(accept(request)).rejects.toThrow(/兼任|通知/);expect(readFileSync(file,'utf8')).toBe(before);
  });
  it('未来交接完成后接任者被收权，进入经理阶段也不得投递可操作卡',async()=>{
    await accept(await input());await workflow.runPendingTasks(new Date(),1);await approve();await workflow.runPendingTasks(new Date(),1);
    const denied=new LeaveWorkflowService(store,gateway as never,{} as never,undefined,{canUseFeishuBusinessIdentity:()=>false} as never);
    expect(await denied.runPendingTasks(new Date(),1)).toEqual({processed:0,failed:1});expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(await workflow.runPendingTasks(Date.now()+60_000,1)).toEqual({processed:1,failed:0});expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);expect(gateway.sendInteractiveCard.mock.calls[0][0]).toBe(next.openId);
  });
  it('校验任务失败可重启恢复，本地计划和同mutation任务均不重复',async()=>{
    const [item]=await adapter.listPending(context()),receipt=await adapter.acceptTransfer(context(),item,mutationId);
    const denied=new LeaveWorkflowService(store,gateway as never,{} as never,undefined,{canUseFeishuBusinessIdentity:()=>false} as never);
    expect(await denied.runPendingTasks(new Date(),1)).toEqual({processed:0,failed:1});expect((await adapter.reconcile(context(),receipt)).status).toBe('error');
    const bytes=readFileSync(file,'utf8');expect(await adapter.acceptTransfer(context(),item,mutationId)).toEqual(receipt);expect(readFileSync(file,'utf8')).toBe(bytes);
    const restarted=new LeaveWorkflowService(new LeaveWorkflowStore(file,file),gateway as never,{} as never,undefined,{canUseFeishuBusinessIdentity:()=>true} as never);
    expect(await restarted.runPendingTasks(Date.now()+60_000,1)).toEqual({processed:1,failed:0});expect(await adapter.reconcile(context(),receipt)).toEqual({status:'success'});expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();expect(gateway.updateLeaveRecord).not.toHaveBeenCalled();
  });
  it('既有未来计划被改、接任自审批或scope未选经理职责均拒绝',async()=>{
    const request=await input(),before=readFileSync(file,'utf8');await expect(accept({...request,target:{...next,openId:'ou_future_applicant',personRecordId:'recFutureApplicant'}})).rejects.toThrow('自己的');expect(readFileSync(file,'utf8')).toBe(before);
    const wrong=context();wrong.duties[0].kind='leave_supervisor';await expect(adapter.listPending(wrong)).rejects.toThrow('尚未开始');expect(readFileSync(file,'utf8')).toBe(before);
    const current=(await store.getApplication(recordId))!;current.approvalPlan!.stages[1].approvers[0].name='合成变更';await store.patchApplication(recordId,{approvalPlan:current.approvalPlan});const changed=readFileSync(file,'utf8');await expect(accept(request)).rejects.toThrow('计划已变化');expect(readFileSync(file,'utf8')).toBe(changed);
  });
  it.each([true,false])('同时主管处理和未来交接：交接先入队=%s，合法审批仅生效一次',async(handoverFirst)=>{
    const request=await input();
    const operations=handoverFirst?[accept(request),approve()]:[approve(),accept(request)];
    const results=await Promise.allSettled(operations),handover=results[handoverFirst?0:1];
    if(handoverFirst)expect(handover.status).toBe('fulfilled');
    else {expect(handover.status).toBe('rejected');await workflow.runPendingTasks(new Date(),1);await accept(request);}
    await workflow.runPendingTasks(new Date(),20);
    expect((await store.getStageAction(recordId,'supervisor',1))?.actorOpenId).toBe(supervisor.openId);
    expect((await store.getApplication(recordId))?.currentStage?.approverOpenIds).toEqual([next.openId]);
    expect(gateway.sendInteractiveCard.mock.calls.filter(([id])=>id===next.openId)).toHaveLength(1);
    expect(gateway.sendInteractiveCard.mock.calls.some(([id])=>id===previous.openId)).toBe(false);
  });
  it('主管云同步在途不覆盖旧快照，原请求恢复后旧经理卡不能办理',async()=>{
    const [item]=await adapter.listPending(context()),request=await input();await approve();
    let release!:()=>void,entered!:()=>void;
    const waiting=new Promise<void>(resolve=>{entered=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});
    const normalUpdate=gateway.updateLeaveRecord.getMockImplementation()!;
    gateway.updateLeaveRecord.mockImplementationOnce(async(...args)=>{entered();await barrier;return normalUpdate(...args);});
    const worker=workflow.runPendingTasks(new Date(),1);await waiting;
    try {await expect(accept(request)).rejects.toThrow('同步');} finally {release();}
    expect(await worker).toEqual({processed:1,failed:0});
    expect(await adapter.preflight(context(),item,mutationId)).toEqual({ready:true});
    const receipt=await adapter.acceptTransfer(context(),item,mutationId);await workflow.runPendingTasks(new Date(),20);
    expect(await adapter.reconcile(context(),receipt)).toEqual({status:'success'});
    const stale=await store.claimStageAction({recordId,eventId:'synthetic-old-manager-action',stageKey:'manager',stageVersion:2,actorOpenId:previous.openId,actorName:previous.name,messageId:'om_old_manager',action:'approve'});
    expect(stale.accepted).toBe(false);
    const before=readFileSync(file,'utf8');expect(await adapter.acceptTransfer(context(),item,mutationId)).toEqual(receipt);expect(readFileSync(file,'utf8')).toBe(before);
  });
  it('经理先合法完成则保留其决议，原未来清单只收口不重开审批',async()=>{
    const [item]=await adapter.listPending(context());await approve();await workflow.runPendingTasks(new Date(),1);await workflow.runPendingTasks(new Date(),1);
    await store.claimStageAction({recordId,eventId:'synthetic-manager-approved',stageKey:'manager',stageVersion:2,actorOpenId:previous.openId,actorName:previous.name,messageId:'om_future_1',action:'approve'});
    expect(await adapter.preflight(context(),item,mutationId)).toMatchObject({ready:false,alreadyCompleted:true});
    const before=readFileSync(file,'utf8'),receipt=await adapter.acceptTransfer(context(),item,mutationId);
    expect(receipt.status).toBe('already_completed');expect(readFileSync(file,'utf8')).toBe(before);expect(await adapter.reconcile(context(),receipt)).toEqual({status:'success'});
    expect((await store.getStageAction(recordId,'manager',2))?.actorOpenId).toBe(previous.openId);
  });
  it('未来核对未收口时，不能经当前经理入口二次转给第三人',async()=>{
    await accept(await input());
    const denied=new LeaveWorkflowService(store,gateway as never,{} as never,undefined,{canUseFeishuBusinessIdentity:()=>false} as never);
    await denied.runPendingTasks(new Date(),1);await approve();await workflow.runPendingTasks(new Date(),1);
    const current=(await store.getApplication(recordId))!,before=readFileSync(file,'utf8');
    await expect(store.acceptPersonnelHandover({recordId,mutationId:`handover-${'f'.repeat(64)}`,dutyRecordId:'recFutureDuty',sourceOpenId:next.openId,expectedStage:current.currentStage!,target:{...next,openId:'ou_future_third',personRecordId:'recFutureThird'}})).rejects.toThrow('上一交接');
    expect(readFileSync(file,'utf8')).toBe(before);
  });
  it('旧经理卡发送在途时交接，迟到旧卡终态化且不能提交审批',async()=>{
    const request=await input();await approve();await workflow.runPendingTasks(new Date(),1);
    let release!:()=>void,entered!:()=>void;
    const waiting=new Promise<void>(resolve=>{entered=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});
    gateway.sendInteractiveCard.mockImplementationOnce(async()=>{entered();await barrier;return 'om_future_late_manager';});
    const delivery=workflow.runPendingTasks(new Date(),1);await waiting;
    try{await accept(request);}finally{release();}
    expect(await delivery).toEqual({processed:1,failed:0});
    await workflow.runPendingTasks(new Date(),20);
    expect(gateway.patchInteractiveCard).toHaveBeenCalledWith('om_future_late_manager',expect.any(Object));
    expect((await store.getApplication(recordId))?.terminalCardMessageIds).toContain('om_future_late_manager');
    const old=await store.claimStageAction({recordId,eventId:'synthetic-late-old-action',stageKey:'manager',stageVersion:2,actorOpenId:previous.openId,actorName:previous.name,messageId:'om_future_late_manager',action:'approve'});
    expect(old.accepted).toBe(false);expect(gateway.sendInteractiveCard.mock.calls.filter(([id])=>id===next.openId)).toHaveLength(1);
  });
});
