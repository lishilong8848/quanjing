import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { LeaveWorkflowStore, type LeavePersonnelHandoverInput } from '../../server/modules/leave-workflow/leave-workflow.store';
const source={name:'合成前任',openId:'ou_synthetic_old',personRecordId:'rec_old',position:'设施示例人员001',buildings:['C楼']};
const target={name:'合成接任',openId:'ou_synthetic_new',personRecordId:'rec_new',position:'设施示例人员001',buildings:['C楼']};
const input=():LeavePersonnelHandoverInput=>({recordId:'rec_synthetic_leave',mutationId:`handover-${'a'.repeat(64)}`,dutyRecordId:'rec_synthetic_duty',sourceOpenId:source.openId,expectedStage:{key:'supervisor',version:1,approverOpenIds:[source.openId]},target});
const action=()=>({eventId:'synthetic-action-001',recordId:'rec_synthetic_leave',stageKey:'supervisor' as const,stageVersion:1,actorOpenId:source.openId,actorName:source.name,action:'approve' as const});
describe('请休假模块内岗位转交CAS（合成数据）',()=>{
  let directory:string,temporaryRoot:string,owner:string,store:LeaveWorkflowStore,file:string;
  beforeEach(async()=>{
    temporaryRoot=realpathSync(tmpdir()); owner=randomUUID(); directory=mkdtempSync(join(temporaryRoot,'nt-leave-handover-')); writeFileSync(join(directory,'.test-owner'),owner,{flag:'wx'}); file=join(directory,'ledger.json'); store=new LeaveWorkflowStore(file,file);
    const snapshot={applicantName:'合成申请人',applicantOpenId:'ou_synthetic_applicant',applicantPersonRecordId:'rec_applicant',building:'C楼',position:'运维值班员',leaveType:'年假',startAt:'2026-10-13T09:00:00+08:00',endAt:'2026-10-13T18:00:00+08:00',leaveHours:8,approvalDayCount:1,reason:'合成验收'};
    await store.acceptApplication({clientMutationId:'synthetic-leave-request',recordId:'rec_synthetic_leave',snapshot});
    await store.setApprovalPlan('rec_synthetic_leave',{snapshot: (await store.getApplication('rec_synthetic_leave'))!.snapshot,approvalPlan:{approvalClass:'ordinary',discipline:null,approvalDayCount:1,stages:[{key:'supervisor',approvers:[source],resolutionPolicy:'first_legal_action'}],notificationPlan:{finalResultRecipients:[source],professionalRecipients:[],substituteRecipients:[]}},resultRecipients:[source]});
    await store.setPendingStage('rec_synthetic_leave',input().expectedStage);
  });
  afterEach(()=>{
    const canonical=(value:string)=>resolve(value).toLowerCase();
    if(canonical(dirname(directory)) !== canonical(temporaryRoot) || !/^nt-leave-handover-[A-Za-z0-9]+$/u.test(basename(directory)) || !existsSync(directory) || lstatSync(directory).isSymbolicLink() || canonical(realpathSync(directory)) !== canonical(directory)) throw new Error('测试目录归属异常，已保留');
    for(const name of readdirSync(directory)) if(!lstatSync(join(directory,name)).isFile() || lstatSync(join(directory,name)).isSymbolicLink()) throw new Error('测试目录条目异常，已保留');
    if(readFileSync(join(directory,'.test-owner'),'utf8') !== owner) throw new Error('测试目录归属标记异常，已保留'); rmSync(directory,{recursive:true,force:false});
  });
  it('权限事务先转岗但原任务尚未迁移时，CAS内拒绝旧人；已合法受理回放不重复鉴权',async()=>{
    const before=readFileSync(file,'utf8');await expect(store.claimStageAction(action(),new Date(),()=>false)).rejects.toThrow('岗位');expect(readFileSync(file,'utf8')).toBe(before);
    expect((await store.claimStageAction(action(),new Date(),()=>true)).accepted).toBe(true);const check=jest.fn(()=>false),accepted=readFileSync(file,'utf8');expect((await store.claimStageAction(action(),new Date(),check)).reason).toBe('already_processed');expect(check).not.toHaveBeenCalled();expect(readFileSync(file,'utf8')).toBe(accepted);
  });
  it('原子增加阶段版本并保存恢复任务，旧卡不能继续审批；幂等重启不再变更',async()=>{
    const receipt=await store.acceptPersonnelHandover(input());
    expect(receipt).toMatchObject({status:'accepted',stage:{key:'supervisor',version:2,approverOpenIds:[target.openId]}});
    expect((await store.claimStageAction(action())).reason).toBe('stale_stage');
    const restarted=new LeaveWorkflowStore(file,file); expect(await restarted.acceptPersonnelHandover(input())).toEqual(receipt);
    const tasks=await restarted.listTasks(); expect(tasks.filter(task=>task.businessKey === receipt.taskBusinessKey)).toHaveLength(1);
    expect(tasks.find(task=>task.businessKey === receipt.taskBusinessKey)?.payload).toMatchObject({sourceStageVersion:1,targetStageVersion:2,sourceOpenId:source.openId,target:{openId:target.openId,personRecordId:target.personRecordId}});
    expect(tasks.some(task=>task.businessKey === 'leave:rec_synthetic_leave:deliver:supervisor:2')).toBe(false);
  });
  it('已决议单据保持历史和执行，不产生交接任务',async()=>{
    expect((await store.claimStageAction(action())).accepted).toBe(true);
    const before=await store.getApplication('rec_synthetic_leave'),receipt=await store.acceptPersonnelHandover(input());
    expect(receipt.status).toBe('already_completed'); expect(receipt.taskBusinessKey).toBeNull(); expect(await store.getApplication('rec_synthetic_leave')).toEqual(before);
    expect((await store.listTasks()).some(task=>task.kind === ('sync_personnel_handover' as never))).toBe(false);
  });
  it('姓名登录申请的接任人native身份与申请人相同，即使OU不同也拒绝自审批', async () => {
    const before = readFileSync(file,'utf8');
    await expect(store.acceptPersonnelHandover({ ...input(), target: { ...target, personRecordId: 'rec_applicant' } })).rejects.toThrow('接任人不能审批自己的申请');
    expect(readFileSync(file,'utf8')).toBe(before);
  });
  it('阶段变化或同幂等键指定不同接任人拒绝，不覆盖原字节',async()=>{
    await expect(store.acceptPersonnelHandover({...input(),expectedStage:{...input().expectedStage,version:2}})).rejects.toThrow('审批阶段已变化');
    await store.acceptPersonnelHandover(input()); const before=readFileSync(file,'utf8');
    await expect(store.acceptPersonnelHandover({...input(),target:{...target,openId:'ou_synthetic_other',personRecordId:'rec_other'}})).rejects.toThrow('重复交接请求内容不一致');
    expect(readFileSync(file,'utf8')).toBe(before);
  });
  it('审批和交接并发只让第一个合法动作生效',async()=>{
    const [handover,approval]=await Promise.all([store.acceptPersonnelHandover(input()),store.claimStageAction(action())]);
    expect(handover.status).toBe('accepted'); expect(approval.accepted).toBe(false); expect(approval.reason).toBe('stale_stage');
    expect((await store.getApplication('rec_synthetic_leave'))?.resolvedAction).toBeNull();
  });
  it('旧卡投递迟到时持久排队补终态，不留下可操作旧副本',async()=>{
    const receipt=await store.acceptPersonnelHandover(input());
    const ledger=JSON.parse(readFileSync(file,'utf8'));
    const task=ledger.tasks.find((item:{businessKey:string})=>item.businessKey === receipt.taskBusinessKey);
    task.status='completed'; task.completedAt=new Date().toISOString(); writeFileSync(file,JSON.stringify(ledger));
    await store.recordStageCardDelivery('rec_synthetic_leave',{recipientOpenId:source.openId,messageId:'om_synthetic_late',businessKey:`leave:rec_synthetic_leave:stage:supervisor:1:${source.openId}`});
    const patches=(await store.listTasks()).filter(task=>task.payload.patchOnly === true);
    expect(patches).toHaveLength(1); expect(patches[0].payload).toMatchObject({sourceStageVersion:1,targetStageVersion:2});
    await store.recordStageCardDelivery('rec_synthetic_leave',{recipientOpenId:source.openId,messageId:'om_synthetic_late',businessKey:`leave:rec_synthetic_leave:stage:supervisor:1:${source.openId}`});
    expect((await store.listTasks()).filter(task=>task.payload.patchOnly === true)).toHaveLength(1);
  });
});
