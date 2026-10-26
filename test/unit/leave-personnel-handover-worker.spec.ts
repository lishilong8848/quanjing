import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { LeaveWorkflowStore, type LeavePersonnelHandoverInput } from '../../server/modules/leave-workflow/leave-workflow.store';
import { LeaveWorkflowService } from '../../server/modules/leave-workflow/leave-workflow.service';

const source={name:'合成前任',openId:'ou_synthetic_old',personRecordId:'rec_old',position:'设施示例人员001',buildings:['C楼']};
const target={name:'合成接任',openId:'ou_synthetic_new',personRecordId:'rec_new',position:'设施示例人员001',buildings:['C楼']};
const input=():LeavePersonnelHandoverInput=>({recordId:'rec_synthetic_leave',mutationId:`handover-${'a'.repeat(64)}`,dutyRecordId:'rec_synthetic_duty',sourceOpenId:source.openId,expectedStage:{key:'supervisor',version:1,approverOpenIds:[source.openId]},target});

describe('请休假交接后台任务（实际本地账本、合成外部端口）',()=>{
  let directory:string,temporaryRoot:string,owner:string,file:string,store:LeaveWorkflowStore,service:LeaveWorkflowService;
  let savedApp:string|undefined,savedEnabled:string|undefined;
  let gateway:{patchInteractiveCard:jest.Mock;updateLeaveRecord:jest.Mock;readLeaveRecord:jest.Mock;sendInteractiveCard:jest.Mock};
  beforeEach(async()=>{
    savedApp=process.env.FEISHU_APP_ID;savedEnabled=process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED;
    process.env.FEISHU_APP_ID='cli_synthetic_leave_worker';process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED='true';
    temporaryRoot=realpathSync(tmpdir());owner=randomUUID();directory=mkdtempSync(join(temporaryRoot,'nt-leave-worker-'));
    writeFileSync(join(directory,'.test-owner'),owner,{flag:'wx'});file=join(directory,'ledger.json');store=new LeaveWorkflowStore(file,file);
    await store.acceptApplication({clientMutationId:'synthetic-request',recordId:input().recordId,snapshot:{applicantName:'合成申请人',applicantOpenId:'ou_synthetic_applicant',building:'C楼',position:'运维值班员',leaveType:'年假',startAt:'2026-10-13T09:00:00+08:00',endAt:'2026-10-13T18:00:00+08:00',leaveHours:8,approvalDayCount:1,reason:'合成验收'}});
    const snapshot=(await store.getApplication(input().recordId))!.snapshot;
    await store.setApprovalPlan(input().recordId,{snapshot,approvalPlan:{approvalClass:'ordinary',discipline:null,approvalDayCount:1,stages:[{key:'supervisor',approvers:[source],resolutionPolicy:'first_legal_action'}],notificationPlan:{finalResultRecipients:[source],professionalRecipients:[],substituteRecipients:[]}},resultRecipients:[source]});
    await store.setPendingStage(input().recordId,input().expectedStage);
    let task;while((task=await store.takeNextTask())) await store.completeTask(task.key,task.claimToken);
    await store.recordStageCardDelivery(input().recordId,{recipientOpenId:source.openId,messageId:'om_synthetic_old',businessKey:`leave:${input().recordId}:stage:supervisor:1:${source.openId}`});
    gateway={patchInteractiveCard:jest.fn().mockResolvedValue(undefined),updateLeaveRecord:jest.fn().mockResolvedValue(undefined),readLeaveRecord:jest.fn().mockResolvedValue({recordId:input().recordId,fields:{请假当前审批人:[{id:target.openId,name:'合成显示别名'}],请假工作流状态:'待示例人员001审批'}}),sendInteractiveCard:jest.fn().mockResolvedValue('om_synthetic_new')};
    service=new LeaveWorkflowService(store,gateway as never,{} as never,undefined,{canUseFeishuBusinessIdentity:()=>true} as never);
  });
  afterEach(()=>{
    if(savedApp===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=savedApp;
    if(savedEnabled===undefined)delete process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED;else process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED=savedEnabled;
    const canonical=(value:string)=>resolve(value).toLowerCase();
    if(canonical(dirname(directory))!==canonical(temporaryRoot)||!/^nt-leave-worker-[A-Za-z0-9]+$/u.test(basename(directory))||!existsSync(directory)||lstatSync(directory).isSymbolicLink()||canonical(realpathSync(directory))!==canonical(directory))throw new Error('测试目录归属异常，已保留');
    for(const name of readdirSync(directory))if(!lstatSync(join(directory,name)).isFile()||lstatSync(join(directory,name)).isSymbolicLink())throw new Error('测试目录条目异常，已保留');
    if(readFileSync(join(directory,'.test-owner'),'utf8')!==owner)throw new Error('测试目录归属标记异常，已保留');rmSync(directory,{recursive:true,force:false});
  });
  it('先终态旧卡再写入并回读审批人，随后持久排队新卡；迟到旧副本只补终态',async()=>{
    await store.acceptPersonnelHandover(input());
    expect(await service.runPendingTasks(new Date(),1)).toEqual({processed:1,failed:0});
    expect(gateway.patchInteractiveCard).toHaveBeenCalledWith('om_synthetic_old',expect.any(Object));
    expect(gateway.patchInteractiveCard.mock.invocationCallOrder[0]).toBeLessThan(gateway.updateLeaveRecord.mock.invocationCallOrder[0]);
    expect(gateway.updateLeaveRecord).toHaveBeenCalledWith(input().recordId,expect.objectContaining({请假当前审批人:[{id:target.openId}]}));
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect((await store.getPersonnelHandover(input().recordId,input().mutationId))?.status).toBe('completed');
    expect(await service.runPendingTasks(new Date(),1)).toEqual({processed:1,failed:0});
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(gateway.sendInteractiveCard.mock.calls[0][0]).toBe(target.openId);
    await store.recordStageCardDelivery(input().recordId,{recipientOpenId:source.openId,messageId:'om_synthetic_late',businessKey:`leave:${input().recordId}:stage:supervisor:1:${source.openId}:late`});
    const writes=gateway.updateLeaveRecord.mock.calls.length;
    expect(await service.runPendingTasks(new Date(),1)).toEqual({processed:1,failed:0});
    expect(gateway.patchInteractiveCard).toHaveBeenLastCalledWith('om_synthetic_late',expect.any(Object));
    expect(gateway.updateLeaveRecord).toHaveBeenCalledTimes(writes);
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
  });
  it('姓名不能代替人员ID回读；失败保任务、不发新卡，重启重试不重复旧卡',async()=>{
    await store.acceptPersonnelHandover(input());
    gateway.readLeaveRecord.mockResolvedValueOnce({recordId:input().recordId,fields:{请假当前审批人:[{name:target.name}],请假工作流状态:'待示例人员001审批'}});
    expect(await service.runPendingTasks(new Date(),1)).toEqual({processed:0,failed:1});
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect((await store.listTasks()).some(task=>task.businessKey==='leave:rec_synthetic_leave:deliver:supervisor:2')).toBe(false);
    const restarted=new LeaveWorkflowService(new LeaveWorkflowStore(file,file),gateway as never,{} as never,undefined,{canUseFeishuBusinessIdentity:()=>true} as never);
    expect(await restarted.runPendingTasks(Date.now()+60_000,1)).toEqual({processed:1,failed:0});
    expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(1);
    expect((await store.listTasks()).filter(task=>task.businessKey==='leave:rec_synthetic_leave:deliver:supervisor:2')).toHaveLength(1);
  });
  it('上一交接未同步完成时拒绝第二次覆盖，不推进两个有效阶段',async()=>{
    await store.acceptPersonnelHandover(input());const before=readFileSync(file,'utf8');
    await expect(store.acceptPersonnelHandover({...input(),mutationId:`handover-${'b'.repeat(64)}`,sourceOpenId:target.openId,expectedStage:{key:'supervisor',version:2,approverOpenIds:[target.openId]},target:{...target,openId:'ou_synthetic_third',personRecordId:'rec_third'}})).rejects.toThrow('上一交接尚未同步完成');
    expect(readFileSync(file,'utf8')).toBe(before);
  });
});
