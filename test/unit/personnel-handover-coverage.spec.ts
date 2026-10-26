import { assertLeaveHandoverCoverage, assertOvertimeHandoverCoverage, assertPriorHandoverClosed } from '../../server/common/access/personnel-handover.coverage';
import type { HandoverContext } from '../../shared/personnel-handover.interface';

const person=(id:string,openId:string)=>({id,openId,recordId:'rec'+id,name:id,active:true,type:'employee' as const,position:'示例人员001',systemPosition:'',buildings:['C楼' as const],specialties:[],permissionTags:[],dutyRecordIds:[]});
const from=person('old','ou_old'),to=person('new','ou_new');
const context:HandoverContext={from,to,directoryVersion:'fixture',duties:[{recordId:'recDuty',name:'C楼示例人员001',kind:'building_supervisor',personnelIds:[to.id],buildings:['C楼'],specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1}]};
const source={name:from.name,openId:from.openId!,position:'示例人员001',buildings:['C楼']},other={...source,name:'其他',openId:'ou_other'};
type Leave=Parameters<typeof assertLeaveHandoverCoverage>[1];
type Overtime=Parameters<typeof assertOvertimeHandoverCoverage>[1];
const leave=():Leave=>({recordId:'recLeave',snapshot:{building:'C楼'},status:'supervisor_pending',currentStage:{key:'supervisor',version:1,approverOpenIds:[source.openId]},approvalPlan:{approvalClass:'ordinary',discipline:null,approvalDayCount:1,stages:[{key:'supervisor',approvers:[source],resolutionPolicy:'first_legal_action'}],notificationPlan:{finalResultRecipients:[source],professionalRecipients:[],substituteRecipients:[]}},resultRecipients:[source]});
const overtime=():Overtime=>({recordId:'recOvertime',snapshot:{building:'C楼'},phase:'approval_pending',approvers:[source],managerRecipients:[],actualApproverOpenId:''});
describe('实际两模块交接范围闭合门禁',()=>{
  it('上一交接未收口不能再给第三人加权；自身恢复和补旧卡任务保留',()=>{
    const task={recordId:'recLeave',kind:'sync_personnel_handover',status:'failed',payload:{sourceOpenId:'ou_previous',target:{openId:from.openId},patchOnly:false}};
    expect(()=>assertPriorHandoverClosed(context,'leave',[leave()],[task])).toThrow('上一交接尚未收口');
    expect(()=>assertPriorHandoverClosed(context,'leave',[leave()],[{...task,payload:{...task.payload,sourceOpenId:from.openId,target:{openId:to.openId}}}])).not.toThrow();
    expect(()=>assertPriorHandoverClosed(context,'leave',[leave()],[{...task,status:'completed'},{...task,payload:{...task.payload,patchOnly:true}}])).not.toThrow();
  });
  it('仅当前审批且未来通知随现有转办同步替换时允许',()=>{
    expect(()=>assertLeaveHandoverCoverage(context,leave(),[])).not.toThrow();expect(()=>assertOvertimeHandoverCoverage(context,overtime(),[])).not.toThrow();
  });
  it('后续经理尚未开始审批也不能被当前阶段清单遗漏',()=>{
    const app=leave();app.approvalPlan!.stages.push({key:'manager',approvers:[source],resolutionPolicy:'first_legal_action'});
    expect(()=>assertLeaveHandoverCoverage(context,app,[])).toThrow('尚未开始');
  });
  it('过去已审批的示例人员001历史保留，但未完成独立通知必须明确阻断',()=>{
    const app=leave();app.currentStage={key:'manager',version:2,approverOpenIds:[other.openId]};app.approvalPlan!.stages.push({key:'manager',approvers:[other],resolutionPolicy:'first_legal_action'});app.status='manager_pending';
    expect(()=>assertLeaveHandoverCoverage(context,app,[])).toThrow('独立通知');
    app.resultRecipients=[];app.approvalPlan!.notificationPlan.finalResultRecipients=[];expect(()=>assertLeaveHandoverCoverage(context,app,[])).not.toThrow();
  });
  it.each(['pending','processing','failed'] as const)('请休假结果投递未收口会阻断，不能先转当前审批 %s',status=>{
    expect(()=>assertLeaveHandoverCoverage(context,leave(),[{recordId:'recLeave',kind:'deliver_result_cards',status}])).toThrow('独立通知');
  });
  it('已完成通知不重复交接；其他楼栋或其他申请不阻断',()=>{
    expect(()=>assertLeaveHandoverCoverage(context,leave(),[{recordId:'recLeave',kind:'deliver_result_cards',status:'completed'}])).not.toThrow();
    expect(()=>assertLeaveHandoverCoverage(context,leave(),[{recordId:'recOther',kind:'deliver_result_cards',status:'pending'}])).not.toThrow();
    const app=leave();app.snapshot.building='A楼';app.approvalPlan=null;expect(()=>assertLeaveHandoverCoverage(context,app,[])).not.toThrow();
  });
  it('范围内未知或失败路由不当作零待办成功',()=>{
    const app=leave();app.approvalPlan=null;expect(()=>assertLeaveHandoverCoverage(context,app,[])).toThrow('审批路由');
    const ot=overtime();ot.phase='pending_approval';expect(()=>assertOvertimeHandoverCoverage(context,ot,[])).toThrow('审批路由');
  });
  it.each(['managerRecipients','professionalRecipients'] as const)('加班非审批通知名单不得默默保留前任 %s',key=>{
    const app=overtime();app[key]=[source];expect(()=>assertOvertimeHandoverCoverage(context,app,[])).toThrow('独立');
  });
  it('独立确认可以转交，原审批历史保留；其他未完成结果通知仍阻断',()=>{
    const app=overtime();app.phase='awaiting_confirmation';app.actualApproverOpenId=source.openId;
    expect(()=>assertOvertimeHandoverCoverage(context,app,[])).not.toThrow();
    app.actualApproverOpenId=other.openId;expect(()=>assertOvertimeHandoverCoverage(context,app,[])).toThrow('结果通知');
    app.approvers=[other];app.confirmationResponsible={openId:source.openId,name:source.name,personRecordId:from.recordId,generation:2};expect(()=>assertOvertimeHandoverCoverage(context,app,[])).not.toThrow();
  });
  it('加班已完成历史保留，但未完成经理投递不能被终态掩盖',()=>{
    const app=overtime();app.phase='confirmed';app.managerRecipients=[source];
    expect(()=>assertOvertimeHandoverCoverage(context,app,[{recordId:app.recordId,kind:'notify_managers',status:'completed'}])).not.toThrow();
    expect(()=>assertOvertimeHandoverCoverage(context,app,[{recordId:app.recordId,kind:'notify_managers',status:'pending'}])).toThrow('独立');
  });
});
