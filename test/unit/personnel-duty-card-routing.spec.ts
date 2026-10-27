import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService, readConfiguredCardMembers } from '../../server/common/access/access-configuration.service';
import { LeaveWorkflowService } from '../../server/modules/leave-workflow/leave-workflow.service';
import { LeaveWorkflowStore } from '../../server/modules/leave-workflow/leave-workflow.store';
import type { LeaveApprovalPlan, LeaveApprovalRoutingInput } from '../../server/modules/leave-workflow/leave-workflow.types';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { OvertimeWorkflowService } from '../../server/modules/overtime-workflow/overtime-workflow.service';
import { OvertimeWorkflowStore, stableOvertimeMessageUuid } from '../../server/modules/overtime-workflow/overtime-workflow.store';
import { LeavePersonnelHandoverAdapter } from '../../server/modules/leave-workflow/leave-personnel-handover.adapter';
import { OvertimePersonnelHandoverAdapter } from '../../server/modules/overtime-workflow/overtime-personnel-handover.adapter';
import { handoverItemMutationId } from '../../server/common/access/personnel-handover.store';
import type { HandoverContext } from '../../shared/personnel-handover.interface';
const appId='cli_synthetic_unified_card';
describe('统一岗位与既有卡片人员入口',()=>{
  let folder:string,parent:string,owner:string,savedApp:string|undefined,savedSecret:string|undefined,store:stores.AccessConfigurationStore;
  beforeEach(async()=>{
    savedSecret=process.env.LOCAL_ACCESS_SESSION_SECRET;process.env.LOCAL_ACCESS_SESSION_SECRET=randomBytes(32).toString('base64');
    savedApp=process.env.FEISHU_APP_ID;process.env.FEISHU_APP_ID=appId;parent=realpathSync(tmpdir());folder=mkdtempSync(join(parent,'nt-duty-card-'));owner=randomUUID();writeFileSync(join(folder,'.test-owner'),owner,{flag:'wx'});store=new stores.AccessConfigurationStore(join(folder,'configuration.json'));jest.spyOn(stores,'getAccessConfigurationStore').mockReturnValue(store);jest.spyOn(defaults,'defaultAccessAccounts').mockReturnValue({});
    await store.mutate(0,'seed-unified-card-role','seed',state=>{
      state.cardRules['warehouse_responsible:B楼']={appId,code:'warehouse_responsible',building:'B楼',members:[{openId:'ou_old',name:'合成前任'}],version:1};
      state.cardRules['contract_notify:all']={appId,code:'contract_notify',building:null,members:[{openId:'ou_old',name:'合成前任'}],version:1};
      state.personnelDutyAssignments={recDuty:{appId,dutyRecordId:'recDuty',kind:'warehouse_approver',buildings:['B楼','C楼'],specialties:null,startsAt:0,endsAt:null,version:1,confirmedBatchId:'eb761f03-468f-4a86-b971-1f074fa695cc',members:[{personId:`local-external-${'a'.repeat(64)}`,recordId:'recPerson',openId:'ou_current',name:'合成现任'}]}};
    });
  });
  afterEach(()=>{
    if(savedSecret===undefined)delete process.env.LOCAL_ACCESS_SESSION_SECRET;else process.env.LOCAL_ACCESS_SESSION_SECRET=savedSecret;
    jest.restoreAllMocks();if(savedApp===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=savedApp;
    if(dirname(resolve(folder)).toLowerCase()!==resolve(parent).toLowerCase()||!/^nt-duty-card-[A-Za-z0-9]+$/.test(basename(folder))||lstatSync(folder).isSymbolicLink()||realpathSync(folder)!==folder||readFileSync(join(folder,'.test-owner'),'utf8')!==owner)throw Error('Owned fixture mismatch');for(const name of readdirSync(folder))if(!lstatSync(join(folder,name)).isFile()||lstatSync(join(folder,name)).isSymbolicLink())throw Error('Unsafe fixture');rmSync(folder,{recursive:true,force:false});
  });
  it('采购和出入库共用既有入口读取已确认人员，其他职责仍使用原人员',()=>{
    expect(readConfiguredCardMembers('warehouse_responsible','B楼')).toEqual([{openId:'ou_current',name:'合成现任'}]);
    expect(readConfiguredCardMembers('warehouse_responsible','C楼')).toEqual([{openId:'ou_current',name:'合成现任'}]);
    expect(readConfiguredCardMembers('contract_notify',null)).toEqual([{openId:'ou_old',name:'合成前任'}]);
    expect(readConfiguredCardMembers('warehouse_notify','B楼')).toBeNull();
  });
  it('管理员之后调整卡片人员立即生效，只覆盖所选楼栋，保留其他楼栋归属',async()=>{
    const service=new AccessConfigurationService();await service.saveCardRule({expectedRevision:1,clientMutationId:'synthetic-manual-card-rule',code:'warehouse_responsible',building:'B楼',members:[{openId:'ou_manual',name:'合成人工指定'}]}, {role:'admin',purchaseBuilding:null});
    expect(readConfiguredCardMembers('warehouse_responsible','B楼')).toEqual([{openId:'ou_manual',name:'合成人工指定'}]);
    expect(readConfiguredCardMembers('warehouse_responsible','C楼')).toEqual([{openId:'ou_current',name:'合成现任'}]);
    expect(store.read().personnelDutyAssignments?.recDuty.buildings).toEqual(['C楼']);
  });
  it('已保存岗位结构损坏必须拒绝读取，不能静默忽略恢复旧卡片名单',()=>{
    const state=store.read();state.personnelDutyAssignments!.recDuty.members[0].recordId='invalid';writeFileSync(store.filePath,JSON.stringify(state));expect(()=>readConfiguredCardMembers('warehouse_responsible','B楼')).toThrow('权限配置文件无效');
  });
  it('人员收权标记优先于残留岗位及旧卡片配置，不回退给已收权人员',async()=>{
    await store.mutate(store.read().revision,'synthetic-inactive-duty-members','seed',state=>{state.personnelEmployment={appId,snapshotAt:Date.now(),inactive:{[`feishu-${feishuIdentityFingerprint(appId,'ou_current')}`]:true,[`feishu-${feishuIdentityFingerprint(appId,'ou_old')}`]:true}};});
    expect(readConfiguredCardMembers('warehouse_responsible','B楼')).toEqual([]);expect(readConfiguredCardMembers('contract_notify',null)).toEqual([]);
    expect(new AccessConfigurationService().currentDutyRoutePeople('warehouse_approver',{building:'B楼'})).toEqual([]);
  });
  it('实际请休假服务使用同一权限配置生成主管和经理新路由，稳定记录ID不丢失',async()=>{
    await store.mutate(store.read().revision,'seed-current-leave-role','seed-leave',state=>{
      const rule=state.personnelDutyAssignments!.recDuty;rule.kind='leave_supervisor';
      state.personnelDutyAssignments!.recManager={...rule,dutyRecordId:'recManager',kind:'leave_manager',buildings:null,members:[{personId:`local-external-${'b'.repeat(64)}`,recordId:'recManagerPerson',openId:'ou_current_manager',name:'合成现任经理'}]};
    });
    const service=new LeaveWorkflowService({} as never,{} as never,{} as never,undefined,new AccessConfigurationService());
    const plan=(service as unknown as {buildCurrentApprovalPlan(input:LeaveApprovalRoutingInput):LeaveApprovalPlan}).buildCurrentApprovalPlan({applicant:{personRecordId:'recApplicant',name:'合成申请人',openId:'ou_applicant',position:'运维值班员',buildings:['C楼']},organizationRecords:[],approvalDayCount:4});
    expect(plan.stages.map(stage=>stage.approvers[0].openId)).toEqual(['ou_current','ou_current_manager']);expect(plan.stages[0].approvers[0].personRecordId).toBe('recPerson');
  });
  it('实际服务在岗位事务与任务迁移之间拒绝旧人，新卡迁移后接任者可处理，已受理结果不被后续转岗撤销',async()=>{
    const source={name:'合成前任',openId:'ou_old',personRecordId:'recOld',position:'设施主管',buildings:['C楼']};
    const target={...source,name:'合成现任',openId:'ou_current',personRecordId:'recPerson'};
    await store.mutate(store.read().revision,'seed-current-leave-actor','seed',state=>{Object.assign(state.personnelDutyAssignments!.recDuty,{kind:'leave_supervisor',buildings:['C楼']});});
    const file=join(folder,'leave.json'),native=new LeaveWorkflowStore(file,file),gateway={sendMessage:jest.fn()};
    await native.acceptApplication({clientMutationId:'synthetic-service-leave',recordId:'recLeave',snapshot:{applicantName:'合成申请人',applicantOpenId:'ou_applicant',applicantPersonRecordId:'recApplicant',building:'C楼',position:'运维值班员',leaveType:'年假',startAt:'2026-10-16T09:00:00+08:00',endAt:'2026-10-16T18:00:00+08:00',leaveHours:8,approvalDayCount:1,reason:'合成验收'}});
    await native.setApprovalPlan('recLeave',{snapshot:(await native.getApplication('recLeave'))!.snapshot,approvalPlan:{approvalClass:'ordinary',discipline:null,approvalDayCount:1,stages:[{key:'supervisor',approvers:[source],resolutionPolicy:'first_legal_action'}],notificationPlan:{finalResultRecipients:[source],professionalRecipients:[],substituteRecipients:[]}},resultRecipients:[source]});
    await native.setPendingStage('recLeave',{key:'supervisor',version:1,approverOpenIds:[source.openId]});
    await native.recordStageCardDelivery('recLeave',{recipientOpenId:source.openId,messageId:'om_old',businessKey:`leave:recLeave:stage:supervisor:1:${source.openId}`});
    const service=new LeaveWorkflowService(native,gateway as never,{} as never,undefined,new AccessConfigurationService());
    const action={eventId:'synthetic-service-action',recordId:'recLeave',stageKey:'supervisor' as const,stageVersion:1,actorOpenId:source.openId,action:'approve' as const,messageId:'om_old'};
    const before=readFileSync(file,'utf8');await expect(service.acceptApprovalAction(action)).rejects.toThrow('岗位负责人');expect(readFileSync(file,'utf8')).toBe(before);
    await native.acceptPersonnelHandover({recordId:'recLeave',mutationId:`handover-${'a'.repeat(64)}`,dutyRecordId:'recDuty',sourceOpenId:source.openId,expectedStage:{key:'supervisor',version:1,approverOpenIds:[source.openId]},target});
    await native.recordStageCardDelivery('recLeave',{recipientOpenId:target.openId,messageId:'om_new',businessKey:`leave:recLeave:stage:supervisor:2:${target.openId}`});
    const current={...action,stageVersion:2,actorOpenId:target.openId,messageId:'om_new'};
    expect((await service.acceptApprovalAction(current)).claimed).toBe(true);
    await store.mutate(store.read().revision,'seed-next-leave-actor','seed',state=>{state.personnelDutyAssignments!.recDuty.members=[];});
    const accepted=readFileSync(file,'utf8');expect((await service.acceptApprovalAction(current)).claimed).toBe(false);expect(readFileSync(file,'utf8')).toBe(accepted);expect(gateway.sendMessage).not.toHaveBeenCalled();
  });
  it('兼任当前主管和未来经理一次选择两个职责，保留未交接的专业通知身份',async()=>{
    await store.mutate(store.read().revision,'seed-multiple-leave-duties','seed',state=>{
      state.personnelDutyAssignments!.recDuty.kind='leave_supervisor';
      state.personnelDutyAssignments!.recManager={...structuredClone(state.personnelDutyAssignments!.recDuty),dutyRecordId:'recManager',kind:'leave_manager',buildings:null};
    });
    const source={name:'合成兼任',openId:'ou_old',personRecordId:'recOld',position:'设施主管',buildings:['B楼']},file=join(folder,'leave-multiple-duties.json'),native=new LeaveWorkflowStore(file,file);
    await native.acceptApplication({clientMutationId:'synthetic-multiple-leave-duties',recordId:'recMultiple',snapshot:{applicantName:'合成申请人',applicantOpenId:'ou_applicant',applicantPersonRecordId:'recApplicant',building:'B楼',position:'电气工程师',leaveType:'年假',startAt:'2026-10-16T09:00:00+08:00',endAt:'2026-10-20T18:00:00+08:00',leaveHours:32,approvalDayCount:4,reason:'合成验收'}});
    await native.setApprovalPlan('recMultiple',{snapshot:(await native.getApplication('recMultiple'))!.snapshot,approvalPlan:{approvalClass:'ordinary',discipline:'electrical',approvalDayCount:4,stages:[{key:'supervisor',approvers:[source],resolutionPolicy:'first_legal_action'},{key:'manager',approvers:[source],resolutionPolicy:'first_legal_action'}],notificationPlan:{managerRecipients:[source],finalResultRecipients:[source],professionalRecipients:[source],substituteRecipients:[]}},resultRecipients:[source]});
    await native.setPendingStage('recMultiple',{key:'supervisor',version:1,approverOpenIds:[source.openId]});let task;while((task=await native.takeNextTask()))await native.completeTask(task.key,task.claimToken);
    const from={id:`local-external-${'b'.repeat(64)}`,recordId:'recOld',name:source.name,openId:source.openId,active:true,type:'employee' as const,position:source.position,systemPosition:'',buildings:['B楼' as const],specialties:[],permissionTags:[],dutyRecordIds:['recDuty','recManager']};
    const context:HandoverContext={from,to:{...from,id:`local-external-${'a'.repeat(64)}`,recordId:'recPerson',name:'合成现任',openId:'ou_current'},directoryVersion:'c'.repeat(64),duties:[{recordId:'recDuty',name:'主管职责',kind:'leave_supervisor',personnelIds:[from.id],buildings:['B楼','C楼'],specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1},{recordId:'recManager',name:'经理职责',kind:'leave_manager',personnelIds:[from.id],buildings:null,specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1}]};
    const workflow=new LeaveWorkflowService(native,{} as never,{} as never,undefined,new AccessConfigurationService()),adapter=new LeavePersonnelHandoverAdapter(native,new AccessConfigurationService(),workflow);
    const items=await adapter.listPending(context),future=items.find(row=>row.stageKey==='future_manager')!,current=items.find(row=>row.stageKey==='supervisor')!;expect(future).toBeDefined();expect(current).toBeDefined();
    const batch='eb761f03-468f-4a86-b971-1f074fa695cc',receipt=await adapter.acceptTransfer(context,future,handoverItemMutationId(batch,future.key));
    expect(await workflow.runPendingTasks(new Date(),1)).toEqual({processed:1,failed:0});expect(await adapter.reconcile(context,receipt)).toEqual({status:'success'});
    const between=(await native.getApplication('recMultiple'))!;expect(between.currentStage?.approverOpenIds).toEqual(['ou_old']);expect(between.approvalPlan?.stages[1].approvers.map(row=>row.openId)).toEqual(['ou_current']);expect(between.resultRecipients.some(row=>row.openId==='ou_old')).toBe(true);
    await adapter.acceptTransfer(context,current,handoverItemMutationId(batch,current.key));
    const after=(await native.getApplication('recMultiple'))!;expect(after.currentStage?.approverOpenIds).toEqual(['ou_current']);expect(after.approvalPlan?.notificationPlan.professionalRecipients).toEqual([source]);
  });
  it('经理本人请假仍由原上级审批组办理，不误套普通经理岗位人员',async()=>{
    await store.mutate(store.read().revision,'seed-ordinary-manager-not-escalation','seed',state=>{Object.assign(state.personnelDutyAssignments!.recDuty,{kind:'leave_manager',buildings:null});});
    const file=join(folder,'leave-manager-escalation.json'),native=new LeaveWorkflowStore(file,file),actor={name:'合成上级',openId:'ou_escalation',personRecordId:'recEscalation',position:'上级审批人',buildings:['B楼']};
    await native.acceptApplication({clientMutationId:'synthetic-manager-escalation',recordId:'recEscalationLeave',snapshot:{applicantName:'合成经理',applicantOpenId:'ou_applicant',applicantPersonRecordId:'recApplicant',building:'B楼',position:'设施运维经理',leaveType:'年假',startAt:'2026-10-16T09:00:00+08:00',endAt:'2026-10-16T18:00:00+08:00',leaveHours:8,approvalDayCount:1,reason:'合成验收'}});
    await native.setApprovalPlan('recEscalationLeave',{snapshot:(await native.getApplication('recEscalationLeave'))!.snapshot,approvalPlan:{approvalClass:'manager',discipline:null,approvalDayCount:1,stages:[{key:'manager',approvers:[actor],resolutionPolicy:'first_legal_action'}],notificationPlan:{managerRecipients:[],finalResultRecipients:[actor],professionalRecipients:[],substituteRecipients:[]}},resultRecipients:[actor]});
    await native.setPendingStage('recEscalationLeave',{key:'manager',version:1,approverOpenIds:[actor.openId]});
    await native.recordStageCardDelivery('recEscalationLeave',{recipientOpenId:actor.openId,messageId:'om_escalation',businessKey:`leave:recEscalationLeave:stage:manager:1:${actor.openId}`});
    const workflow=new LeaveWorkflowService(native,{} as never,{} as never,undefined,new AccessConfigurationService());
    expect((await workflow.acceptApprovalAction({eventId:'synthetic-escalation-action',recordId:'recEscalationLeave',stageKey:'manager',stageVersion:1,actorOpenId:actor.openId,action:'approve',messageId:'om_escalation'})).claimed).toBe(true);
  });
  it('实际请休假独立经理通知读取现任，投递期间换岗保留原回执并补现任，不改历史快照',async()=>{
    await store.mutate(store.read().revision,'seed-notice-manager','seed',state=>{Object.assign(state.personnelDutyAssignments!.recDuty,{kind:'leave_manager',buildings:null});});
    const file=join(folder,'leave-notice.json'),native=new LeaveWorkflowStore(file,file);
    await native.acceptApplication({clientMutationId:'synthetic-service-notice',recordId:'recNotice',snapshot:{applicantName:'合成申请人',applicantOpenId:'ou_applicant',applicantPersonRecordId:'recApplicant',building:'B楼',position:'运维值班员',leaveType:'年假',startAt:'2026-10-16T09:00:00+08:00',endAt:'2026-10-16T18:00:00+08:00',leaveHours:8,approvalDayCount:1,reason:'合成验收'}});
    const source={name:'合成原经理',openId:'ou_old',position:'设施运维经理',buildings:['B楼']},applicant={...source,name:'合成申请人',openId:'ou_applicant',position:'运维值班员'},supervisor={...source,name:'合成原主管',openId:'ou_supervisor',position:'设施主管'};
    await native.setApprovalPlan('recNotice',{snapshot:(await native.getApplication('recNotice'))!.snapshot,approvalPlan:{approvalClass:'ordinary',discipline:null,approvalDayCount:1,stages:[{key:'supervisor',approvers:[supervisor],resolutionPolicy:'first_legal_action'}],notificationPlan:{finalResultRecipients:[applicant,supervisor,source],professionalRecipients:[],substituteRecipients:[]}},resultRecipients:[applicant,supervisor,source]});
    await native.patchApplication('recNotice',{status:'approved'});
    const gateway={patchInteractiveCard:jest.fn(async()=>{}),updateLeaveRecord:jest.fn(async()=>{}),sendInteractiveCard:jest.fn(async(recipient:string)=>{
      if(recipient==='ou_current')await store.mutate(store.read().revision,'synthetic-notice-next-manager','seed',state=>{state.personnelDutyAssignments!.recDuty.members=[{personId:`local-external-${'c'.repeat(64)}`,recordId:'recNext',openId:'ou_next',name:'合成接任经理'}];});
      return `om_${recipient.slice(3)}`;
    })};
    const service=new LeaveWorkflowService(native,gateway as never,{} as never,undefined,new AccessConfigurationService());
    await (service as unknown as {deliverResultCards(task:{recordId:string},now:Date):Promise<void>}).deliverResultCards({recordId:'recNotice'},new Date());
    expect(gateway.sendInteractiveCard.mock.calls.map(row=>row[0])).toEqual(['ou_applicant','ou_supervisor','ou_current','ou_next']);
    const saved=(await native.getApplication('recNotice'))!;expect(saved.resultRecipients.map(row=>row.openId)).toEqual(['ou_applicant','ou_supervisor','ou_old']);expect(saved.resultCards.map(row=>row.recipientOpenId)).toEqual(['ou_applicant','ou_supervisor','ou_current','ou_next']);
  });
  it.each(['approval','confirmation','confirmation_accepted','confirmation_expired'])('实际加班%s通知跟随现任，保留原受理与回执，超窗不能盲发',async mode=>{
    await store.mutate(store.read().revision,'seed-overtime-notice-manager','seed',state=>{Object.assign(state.personnelDutyAssignments!.recDuty,{kind:'overtime_manager',buildings:null});});
    const file=join(folder,'overtime-notice.json'),native=new OvertimeWorkflowStore(file,file),source={name:'合成原经理',openId:'ou_old',position:'设施运维经理',buildings:['B楼']},supervisor={...source,name:'合成原主管',openId:'ou_supervisor',position:'设施主管'};
    await native.acceptApplication({clientMutationId:'synthetic-overtime-notice',snapshot:{recordId:'recOvertimeNotice',applicantName:'合成申请人',applicantOpenId:'ou_applicant',building:'B楼',position:'运维值班员',plannedStartAt:'2026-10-16T09:00:00+08:00',plannedEndAt:'2026-10-16T10:00:00+08:00',plannedHours:1,reason:'合成验收'}});
    await native.patchApplication('recOvertimeNotice',{phase:'awaiting_confirmation',approvers:[supervisor],managerRecipients:[source],professionalRecipients:[],actualApproverOpenId:supervisor.openId,actualApproverName:supervisor.name});
    if(mode!=='approval')await native.claimConfirmationSubmission({mutationId:randomUUID(),recordId:'recOvertimeNotice',actorOpenId:supervisor.openId,draft:{actualStartAt:'2026-10-16T09:00:00+08:00',actualEndAt:'2026-10-16T10:00:00+08:00',actualHours:1,disposition:'调休'}});
    if(mode==='confirmation_accepted'||mode==='confirmation_expired'){
      const businessKey='overtime:recOvertimeNotice:confirmation-result:ou_old';
      await native.patchApplication('recOvertimeNotice',{confirmationResultIntents:[{businessKey,recipientOpenId:'ou_old',messageUuid:stableOvertimeMessageUuid(businessKey),createdAt:new Date(Date.now()-(mode==='confirmation_expired'?61*60_000:1000)).toISOString()}]});
    }
    const gateway={patchInteractiveCard:jest.fn(async()=>{}),updateOvertimeRecord:jest.fn(async()=>{}),sendInteractiveCard:jest.fn(async(recipient:string)=>{
      if(recipient==='ou_current')await store.mutate(store.read().revision,'synthetic-overtime-next-manager','seed',state=>{state.personnelDutyAssignments!.recDuty.members=[{personId:`local-external-${'c'.repeat(64)}`,recordId:'recNext',openId:'ou_next',name:'合成接任经理'}];});
      return `om_${recipient.slice(3)}`;
    })};
    const service=new OvertimeWorkflowService(native,gateway as never,{} as never,new AccessConfigurationService());
    const methods=service as unknown as {syncApprovalResults(task:{recordId:string},now:Date):Promise<void>;applyConfirmation(task:{recordId:string},now:Date):Promise<void>};
    const work=mode==='approval'?methods.syncApprovalResults({recordId:'recOvertimeNotice'},new Date()):methods.applyConfirmation({recordId:'recOvertimeNotice'},new Date());
    if(mode==='confirmation_expired')await expect(work).rejects.toThrow('一小时');else await work;
    const ids=gateway.sendInteractiveCard.mock.calls.map(row=>row[0]);const expected=['ou_applicant','ou_supervisor','ou_current','ou_next',...(mode==='confirmation_accepted'?['ou_old']:[])];expect(ids.sort()).toEqual(expected.sort());
    const saved=(await native.getApplication('recOvertimeNotice'))!;expect(saved.managerRecipients[0].openId).toBe('ou_old');expect((mode==='approval'?saved.managerNoticeCards:saved.confirmationResultCards).map(row=>row.recipientOpenId).sort()).toEqual(ids.sort());
  });
  it.each(['leave','overtime'] as const)('%s独立通知在同一岗位批次一次交接，原队列完成后才关闭当前通知进度',async module=>{
    await store.mutate(store.read().revision,`seed-${module}-independent-notify`,'seed',state=>{Object.assign(state.personnelDutyAssignments!.recDuty,{kind:`${module}_manager`,buildings:null});});
    const from={id:`local-external-${'b'.repeat(64)}`,recordId:'recOld',name:'合成前任',openId:'ou_old',active:false,type:'employee' as const,position:'设施运维经理',systemPosition:'',buildings:['B楼' as const],specialties:[],permissionTags:[],dutyRecordIds:['recDuty']};
    const context:HandoverContext={from,to:{...from,id:`local-external-${'a'.repeat(64)}`,recordId:'recPerson',name:'合成现任',openId:'ou_current',active:true},directoryVersion:'c'.repeat(64),duties:[{recordId:'recDuty',name:'合成经理职责',kind:`${module}_manager`,personnelIds:[from.id],buildings:null,specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1}]};
    const source={name:'合成前任',openId:'ou_old',position:'设施运维经理',buildings:['B楼']},supervisor={...source,name:'合成主管',openId:'ou_supervisor',position:'设施主管'},applicant={...source,name:'合成申请人',openId:'ou_applicant',position:'运维值班员'};
    const file=join(folder,`${module}-notify-transfer.json`),configuration=new AccessConfigurationService(),gateway={sendInteractiveCard:jest.fn(async(recipient:string)=>`om_${recipient.slice(3)}`),patchInteractiveCard:jest.fn(async()=>{}),updateLeaveRecord:jest.fn(async()=>{}),updateOvertimeRecord:jest.fn(async()=>{}),readOvertimeRecordIfExists:jest.fn(async()=>({recordId:'recIndependent',fields:{}}))};
    let native:any,workflow:any,adapter:any;
    if(module==='leave'){
      native=new LeaveWorkflowStore(file,file);await native.acceptApplication({clientMutationId:'synthetic-independent-leave',recordId:'recIndependent',snapshot:{applicantName:applicant.name,applicantOpenId:applicant.openId,applicantPersonRecordId:'recApplicant',building:'B楼',position:applicant.position,leaveType:'年假',startAt:'2026-10-16T09:00:00+08:00',endAt:'2026-10-16T18:00:00+08:00',leaveHours:8,approvalDayCount:1,reason:'合成验收'}});
      await native.setApprovalPlan('recIndependent',{snapshot:(await native.getApplication('recIndependent')).snapshot,approvalPlan:{approvalClass:'ordinary',discipline:null,approvalDayCount:1,stages:[{key:'supervisor',approvers:[supervisor],resolutionPolicy:'first_legal_action'}],notificationPlan:{finalResultRecipients:[applicant,supervisor,source],managerRecipients:[source],professionalRecipients:[],substituteRecipients:[]}},resultRecipients:[applicant,supervisor,source]});await native.setPendingStage('recIndependent',{key:'supervisor',version:1,approverOpenIds:[supervisor.openId]});
      workflow=new LeaveWorkflowService(native,gateway as never,{} as never,undefined,configuration);adapter=new LeavePersonnelHandoverAdapter(native,configuration,workflow);
    }else{
      native=new OvertimeWorkflowStore(file,file);await native.acceptApplication({clientMutationId:'synthetic-independent-overtime',snapshot:{recordId:'recIndependent',applicantName:applicant.name,applicantOpenId:applicant.openId,building:'B楼',position:applicant.position,plannedStartAt:'2026-10-16T09:00:00+08:00',plannedEndAt:'2026-10-16T10:00:00+08:00',plannedHours:1,reason:'合成验收'}});await native.patchApplication('recIndependent',{phase:'awaiting_confirmation',approvers:[supervisor],actualApproverOpenId:supervisor.openId,managerRecipients:[source],professionalRecipients:[]});
      workflow=new OvertimeWorkflowService(native,gateway as never,{} as never,configuration);adapter=new OvertimePersonnelHandoverAdapter(native,configuration,workflow);
    }
    let task;while((task=await native.takeNextTask()))await native.completeTask(task.key,task.claimToken);
    const items=await adapter.listPending(context),item=items.find((row:any)=>row.stageKey==='role_notifications');expect(item).toBeDefined();expect(items).toHaveLength(1);
    const mutation=handoverItemMutationId('eb761f03-468f-4a86-b971-1f074fa695cc',item.key);const receipt=await adapter.acceptTransfer(context,item,mutation);expect(await adapter.reconcile(context,receipt)).toEqual({status:'success'});
    const subsequent:HandoverContext={...context,from:context.to,to:{...context.to,id:`local-external-${'d'.repeat(64)}`,recordId:'recThird',openId:'ou_third',name:'合成再任'}};
    expect((await adapter.listPending(subsequent)).filter((row:any)=>row.stageKey==='role_notifications')).toHaveLength(1);
    expect(await adapter.listPending({...subsequent,from:{...subsequent.from,recordId:'recUnrelated'}})).toEqual([]);
    expect(await adapter.listPending({...subsequent,duties:subsequent.duties.map(duty=>({...duty,buildings:['A楼']}))})).toEqual([]);
    if(module==='leave')await native.patchApplication('recIndependent',{status:'approved'});
    await native.enqueueTask({businessKey:`synthetic-independent-${module}-result`,recordId:'recIndependent',kind:module==='leave'?'deliver_result_cards':'notify_managers',payload:{}});
    expect(await adapter.reconcile(context,receipt)).toEqual({status:'syncing'});
    gateway.sendInteractiveCard.mockRejectedValueOnce(new Error('synthetic transport unavailable'));
    expect(await workflow.runPendingTasks(new Date(),1)).toEqual({processed:0,failed:1});
    expect(await adapter.reconcile(context,receipt)).toMatchObject({status:'error'});
    const exhausted=await native.takeNextTask(new Date(Date.now()+31*60_000));expect(exhausted).toBeTruthy();
    await native.rescheduleTask(exhausted.key,exhausted.claimToken,'synthetic retries exhausted',new Date(),1);
    const exhaustedBytes=readFileSync(file,'utf8');
    expect(await adapter.reconcile(context,{...receipt,version:'0'.repeat(64)},{retryFailed:true})).toMatchObject({status:'error'});expect(readFileSync(file,'utf8')).toBe(exhaustedBytes);
    expect(await adapter.reconcile(context,receipt,{retryFailed:true})).toMatchObject({status:'syncing'});
    expect(await workflow.runPendingTasks(new Date(Date.now()+31*60_000),1)).toEqual({processed:1,failed:0});
    expect(await adapter.reconcile(context,receipt)).toEqual({status:'success'});expect(gateway.sendInteractiveCard.mock.calls.some(row=>row[0]==='ou_current')).toBe(true);expect(gateway.sendInteractiveCard.mock.calls.some(row=>row[0]==='ou_old')).toBe(false);
    expect(await adapter.reconcile(context,{...receipt,mutationId:randomUUID()})).toMatchObject({status:'error'});
  });
  it('已批准请假仍待调整替班时，旧岗位卡失效，现任新卡可办理，合法受理后收权不重做',async()=>{
    await store.mutate(store.read().revision,'seed-substitute-current-supervisor','seed',state=>{state.personnelDutyAssignments!.recDuty.kind='leave_supervisor';});
    const file=join(folder,'leave-adjustment-transfer.json'),native=new LeaveWorkflowStore(file,file),source={name:'合成前任',openId:'ou_old',personRecordId:'recOld',position:'设施主管',buildings:['B楼']},candidate={name:'合成替班',openId:'ou_substitute',personRecordId:'recSubstitute',position:'运维值班员',buildings:['B楼']};
    await native.acceptApplication({clientMutationId:'synthetic-adjustment-transfer',recordId:'recAdjustment',snapshot:{applicantName:'合成申请人',applicantOpenId:'ou_applicant',applicantPersonRecordId:'recApplicant',building:'B楼',position:'运维值班员',leaveType:'年假',startAt:new Date(Date.now()+24*60*60_000).toISOString(),endAt:new Date(Date.now()+48*60*60_000).toISOString(),leaveHours:8,approvalDayCount:1,reason:'合成验收',substituteRequired:true,substituteCandidates:[candidate]}});
    await native.setApprovalPlan('recAdjustment',{snapshot:(await native.getApplication('recAdjustment'))!.snapshot,approvalPlan:{approvalClass:'ordinary',discipline:null,approvalDayCount:1,stages:[{key:'supervisor',approvers:[source],resolutionPolicy:'first_legal_action'}],notificationPlan:{finalResultRecipients:[source],professionalRecipients:[],substituteRecipients:[]}},resultRecipients:[source]});
    await native.setPendingStage('recAdjustment',{key:'supervisor',version:1,approverOpenIds:[source.openId]});await native.patchApplication('recAdjustment',{status:'approved'});
    let task;while((task=await native.takeNextTask()))await native.completeTask(task.key,task.claimToken);
    await native.recordSubstituteAdjustmentCardDelivery('recAdjustment',{recipientOpenId:'ou_old',messageId:'om_old_adjustment',businessKey:'leave:recAdjustment:substitute-adjustment:0:ou_old'});
    const cloud:Record<string,unknown>={},gateway={patchInteractiveCard:jest.fn(async()=>{}),sendInteractiveCard:jest.fn(async(recipient:string,_card:unknown,_businessKey:string)=> `om_new_adjustment_${recipient}`),updateLeaveRecord:jest.fn(async(_id:string,fields:Record<string,unknown>)=>{Object.assign(cloud,fields);}),readLeaveRecord:jest.fn(async()=>({recordId:'recAdjustment',fields:{...cloud}}))};
    const configuration=new AccessConfigurationService(),workflow=new LeaveWorkflowService(native,gateway as never,{} as never,undefined,configuration),adapter=new LeavePersonnelHandoverAdapter(native,configuration,workflow);
    const input={eventId:'synthetic-old-adjustment',recordId:'recAdjustment',expectedRevision:0,actorOpenId:'ou_old',actorName:'合成前任',messageId:'om_old_adjustment',substitutePersonRecordId:'recSubstitute'};
    const bytes=readFileSync(file,'utf8');expect((await workflow.acceptSubstituteUpdateAction(input)).claimed).toBe(false);expect(readFileSync(file,'utf8')).toBe(bytes);
    const from={id:`local-external-${'b'.repeat(64)}`,recordId:'recOld',name:'合成前任',openId:'ou_old',active:true,type:'employee' as const,position:'设施主管',systemPosition:'',buildings:['B楼' as const],specialties:[],permissionTags:[],dutyRecordIds:['recDuty']};
    const context:HandoverContext={from,to:{...from,id:`local-external-${'a'.repeat(64)}`,recordId:'recPerson',name:'合成现任',openId:'ou_current'},directoryVersion:'c'.repeat(64),duties:[{recordId:'recDuty',name:'合成主管职责',kind:'leave_supervisor',personnelIds:[from.id],buildings:['B楼','C楼'],specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1}]};
    const item=(await adapter.listPending(context)).find(row=>row.stageKey==='role_notifications')!;expect(item).toBeDefined();
    const receipt=await adapter.acceptTransfer(context,item,handoverItemMutationId('eb761f03-468f-4a86-b971-1f074fa695cc',item.key));expect(await adapter.reconcile(context,receipt)).toEqual({status:'syncing'});
    expect(await workflow.runPendingTasks(new Date(),1)).toEqual({processed:1,failed:0});expect(gateway.patchInteractiveCard).toHaveBeenCalledWith('om_old_adjustment',expect.anything());expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);expect(gateway.sendInteractiveCard.mock.calls[0][0]).toBe('ou_current');expect(await adapter.reconcile(context,receipt)).toEqual({status:'success'});
    const nextContext:HandoverContext={...context,from:context.to,to:{...context.to,id:`local-external-${'d'.repeat(64)}`,recordId:'recThird',openId:'ou_third',name:'合成再任'}};
    const nextItem=(await adapter.listPending(nextContext)).find(row=>row.stageKey==='role_notifications');expect(nextItem).toBeDefined();
    const nextBatch='94294593-f41a-4bde-9cbc-e39036e267f6';
    await store.mutate(store.read().revision,'synthetic-second-adjustment-handover','seed',state=>{Object.assign(state.personnelDutyAssignments!.recDuty,{confirmedBatchId:nextBatch,members:[{personId:nextContext.to.id,recordId:nextContext.to.recordId,openId:nextContext.to.openId!,name:nextContext.to.name}]});});
    const nextReceipt=await adapter.acceptTransfer(nextContext,nextItem!,handoverItemMutationId(nextBatch,nextItem!.key));expect(await adapter.reconcile(nextContext,nextReceipt)).toEqual({status:'syncing'});
    expect(await workflow.runPendingTasks(new Date(),1)).toEqual({processed:1,failed:0});expect(gateway.patchInteractiveCard).toHaveBeenCalledWith('om_new_adjustment_ou_current',expect.anything());expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(2);expect(await adapter.reconcile(nextContext,nextReceipt)).toEqual({status:'success'});
    const current={...input,eventId:'synthetic-current-adjustment',actorOpenId:'ou_third',actorName:'合成再任',messageId:'om_new_adjustment_ou_third'};expect((await workflow.acceptSubstituteUpdateAction(current)).claimed).toBe(true);
    await store.mutate(store.read().revision,'synthetic-revoke-accepted-adjustment','seed',state=>{state.personnelEmployment={appId,snapshotAt:Date.now(),inactive:{[`feishu-${feishuIdentityFingerprint(appId,'ou_third')}`]:true}};});
    const accepted=readFileSync(file,'utf8');expect((await workflow.acceptSubstituteUpdateAction(current)).claimed).toBe(false);expect(readFileSync(file,'utf8')).toBe(accepted);expect(await workflow.runPendingTasks(new Date(),1)).toEqual({processed:1,failed:0});
    expect(gateway.updateLeaveRecord.mock.calls.filter(([,fields])=>Object.hasOwn(fields,'替班人员（填姓名）'))).toHaveLength(1);
    expect(gateway.updateLeaveRecord.mock.calls.filter(([,fields])=>Object.keys(fields).length===1&&fields.请假工作流错误==='')).toHaveLength(1);
  });
});
