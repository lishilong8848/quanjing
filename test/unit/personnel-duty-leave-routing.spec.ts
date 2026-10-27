import { buildLeaveApprovalPlan } from '../../server/modules/leave-workflow/leave-workflow.rules';
import type { LeaveRoutePerson } from '../../server/modules/leave-workflow/leave-workflow.types';
import { resolveOvertimeApprovalRoute } from '../../server/modules/overtime-workflow/overtime-workflow.rules';
const person=(name:string,openId:string):LeaveRoutePerson=>({name,openId,position:'运维值班员',buildings:['C楼']});
describe('请休假复用统一岗位解析',()=>{
  it('加班审批按原业务分支选择当前岗位，不要求旧组织记录仍保留前任',()=>{
    const calls:string[]=[];
    const resolveDuty=(kind:string,_fallback:()=>LeaveRoutePerson[])=>{calls.push(kind);return [person('合成现任','ou_current')];};
    expect(resolveOvertimeApprovalRoute({applicant:person('合成申请人','ou_applicant'),organizationRecords:[],resolveDuty}).approvers[0].openId).toBe('ou_current');
    expect(resolveOvertimeApprovalRoute({applicant:{...person('合成主管申请人','ou_leader'),position:'设施运维主管'},organizationRecords:[],resolveDuty}).kind).toBe('manager_group');
    expect(calls).toEqual(['overtime_supervisor','overtime_manager']);
  });
  it('已确认主管和经理可直接生成新流程，不再依赖旧主管表中的名单',()=>{
    const requested:string[]=[];
    const plan=buildLeaveApprovalPlan({applicant:person('合成申请人','ou_applicant'),organizationRecords:[],approvalDayCount:4,
      resolveDuty:(kind:string,_fallback:()=>LeaveRoutePerson[])=>{requested.push(kind);return [person(kind==='leave_manager'?'合成经理':'合成主管',kind==='leave_manager'?'ou_current_manager':'ou_current_supervisor')];}});
    expect(plan.stages.map(stage=>stage.approvers.map(value=>value.openId))).toEqual([['ou_current_supervisor'],['ou_current_manager']]);
    expect(plan.notificationPlan.finalResultRecipients.map(value=>value.openId).sort()).toEqual(['ou_applicant','ou_current_manager','ou_current_supervisor']);
    expect(requested).toEqual(['leave_manager','leave_supervisor']);
  });
  it('岗位显式清空或仅本人可审批时拒绝路由，不能回退使用旧人',()=>{
    for(const recipients of [[],[person('合成申请人','ou_applicant')]]) expect(()=>buildLeaveApprovalPlan({applicant:person('合成申请人','ou_applicant'),organizationRecords:[],approvalDayCount:1,
      resolveDuty:()=>recipients})).toThrow('可用审批人');
  });
});
