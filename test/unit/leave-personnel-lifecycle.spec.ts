import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { LeaveWorkflowService } from '../../server/modules/leave-workflow/leave-workflow.service';
import { LeaveWorkflowStore } from '../../server/modules/leave-workflow/leave-workflow.store';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
const actor={name:'合成前任',openId:'ou_synthetic_retired',position:'设施示例人员001',buildings:['C楼']};
const action=()=>({eventId:'synthetic-action-001',recordId:'rec_synthetic_leave',stageKey:'supervisor' as const,stageVersion:1,actorOpenId:actor.openId,actorName:actor.name,messageId:'om_synthetic_lifecycle',action:'reject' as const,rejectionReason:'合成验收'});
describe('请休假卡片生命周期门禁（合成端口）',()=>{
  let directory:string,temporaryRoot:string,owner:string,file:string,store:LeaveWorkflowStore,originalApp:string|undefined,originalEnabled:string|undefined;
  beforeEach(async()=>{
    originalApp=process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID='cli_synthetic_leave'; originalEnabled=process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED; process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED='true';
    temporaryRoot=realpathSync(tmpdir()); owner=randomUUID(); directory=mkdtempSync(join(temporaryRoot,'nt-leave-lifecycle-')); writeFileSync(join(directory,'.test-owner'),owner,{flag:'wx'}); file=join(directory,'ledger.json'); store=new LeaveWorkflowStore(file,file);
    await store.acceptApplication({clientMutationId:'synthetic-leave-request',recordId:'rec_synthetic_leave',snapshot:{applicantName:'合成申请人',applicantOpenId:'ou_synthetic_applicant',building:'C楼',position:'运维值班员',leaveType:'年假',startAt:'2026-10-13T09:00:00+08:00',endAt:'2026-10-13T18:00:00+08:00',leaveHours:8,approvalDayCount:1,reason:'合成验收'}});
    const snapshot=(await store.getApplication('rec_synthetic_leave'))!.snapshot;
    await store.setApprovalPlan('rec_synthetic_leave',{snapshot,approvalPlan:{approvalClass:'ordinary',discipline:null,approvalDayCount:1,stages:[{key:'supervisor',approvers:[actor],resolutionPolicy:'first_legal_action'}],notificationPlan:{finalResultRecipients:[actor],professionalRecipients:[],substituteRecipients:[]}},resultRecipients:[actor]});
    await store.setPendingStage('rec_synthetic_leave',{key:'supervisor',version:1,approverOpenIds:[actor.openId]});
  });
  afterEach(()=>{
    if(originalApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID=originalApp;
    if(originalEnabled === undefined) delete process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED; else process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED=originalEnabled;
    const canonical=(value:string)=>resolve(value).toLowerCase();
    if(canonical(dirname(directory)) !== canonical(temporaryRoot) || !/^nt-leave-lifecycle-[A-Za-z0-9]+$/u.test(basename(directory)) || !existsSync(directory) || lstatSync(directory).isSymbolicLink() || canonical(realpathSync(directory)) !== canonical(directory)) throw new Error('测试目录归属异常，已保留');
    for(const name of readdirSync(directory)) if(!lstatSync(join(directory,name)).isFile() || lstatSync(join(directory,name)).isSymbolicLink()) throw new Error('测试目录条目异常，已保留');
    if(readFileSync(join(directory,'.test-owner'),'utf8') !== owner) throw new Error('测试目录归属标记异常，已保留'); rmSync(directory,{recursive:true,force:false});
  });
  it('明确离职的新审批拒绝，原账本不变且不访问外部系统',async()=>{
    const configuration={canUseFeishuBusinessIdentity:jest.fn().mockReturnValue(false)},gateway={updateLeaveRecord:jest.fn()},before=readFileSync(file,'utf8');
    const service=Reflect.construct(LeaveWorkflowService,[store,gateway,{},undefined,configuration]) as LeaveWorkflowService;
    await expect(service.acceptApprovalAction(action())).rejects.toThrow('当前人员不可办理');
    expect(readFileSync(file,'utf8')).toBe(before); expect(gateway.updateLeaveRecord).not.toHaveBeenCalled(); expect(configuration.canUseFeishuBusinessIdentity).toHaveBeenCalledWith(`feishu-${feishuIdentityFingerprint('cli_synthetic_leave',actor.openId)}`,'cli_synthetic_leave');
  });
  it('缺少状态依赖明确拒绝新办理，不以旧测试兼容为由放行',async()=>{
    const service=new LeaveWorkflowService(store,{} as never,{} as never),before=readFileSync(file,'utf8');
    await expect(service.acceptApprovalAction(action())).rejects.toThrow('人员权限状态未就绪');
    expect(readFileSync(file,'utf8')).toBe(before);
  });
  it('离职前已合法决议的重放保留原终态，不再次办理或改写历史',async()=>{
    expect((await store.claimStageAction(action())).accepted).toBe(true);
    const before=readFileSync(file,'utf8'),configuration={canUseFeishuBusinessIdentity:jest.fn().mockReturnValue(false)};
    const service=Reflect.construct(LeaveWorkflowService,[store,{}, {},undefined,configuration]) as LeaveWorkflowService;
    const replay=await service.acceptApprovalAction(action()); expect(replay.claimed).toBe(false); expect(readFileSync(file,'utf8')).toBe(before);
  });
});
