import type { AuthorityDuty, AuthorityPerson } from '../../../shared/personnel-authority.interface';
import { AUTHORITY_DUTY_CATALOG } from '../../../shared/personnel-authority.interface';
import { normalizedBusinessBuildings } from '../../../shared/business-permissions';
import { normalizeProfessionalScope } from '../../../shared/professional-access';
import type { ConfigurationState } from './access-configuration.store';
import { resolveCurrentPersonnelDutyRoutePeople } from './personnel-duty-current';
import { buildLeaveApprovalPlan } from '../../modules/leave-workflow/leave-workflow.rules';
import type { LeaveOrganizationRecord } from '../../modules/leave-workflow/leave-workflow.types';
import { resolveOvertimeApprovalRoute, resolveOvertimeProfessionalRecipients } from '../../modules/overtime-workflow/overtime-workflow.rules';
import type { OvertimeOrganizationRecord } from '../../modules/overtime-workflow/overtime-workflow.types';
type ContextPerson={name:string;openId:string;personRecordId?:string;position:string;buildings:string[]};

function semantic(value:unknown):unknown{
  if(Array.isArray(value)){
    const rows=value.map(semantic);
    return rows.every(row=>!!row&&typeof row==='object'&&'openId' in row)?rows.sort((a,b)=>String((a as {openId:string}).openId).localeCompare(String((b as {openId:string}).openId))):rows;
  }
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['name','position','personRecordId','approverNames','reason','buildings'].includes(key)).map(([key,item])=>[key,semantic(item)]));
  return value;
}

/** Compare original pure algorithms with the proposed holder substitution; never dispatch a workflow. */
export function verifyPersonnelBaselineContext(duty:AuthorityDuty,people:readonly AuthorityPerson[],state:ConfigurationState,appId:string,
  leave:LeaveOrganizationRecord[]|undefined,overtime:OvertimeOrganizationRecord[]|undefined):void{
  const members=duty.personnelIds.map(id=>people.find(person=>person.id===id));
  if(!members.length||members.some(person=>!person?.active||!person.openId))throw Error('职责人员身份尚未核实');
  const proposed:ContextPerson[]=members.map(person=>({name:person!.name,openId:person!.openId!,personRecordId:person!.recordId,position:AUTHORITY_DUTY_CATALOG.find(row=>row.id===duty.kind)!.label,buildings:[...(duty.buildings||[])]}));
  let witnessed=0;
  const equivalentKind=(kind:string)=>kind===duty.kind||duty.kind==='building_supervisor'&&['leave_supervisor','overtime_supervisor'].includes(kind);
  function evaluate<T>(run:(resolve:(kind:string,fallback:()=>typeof proposed,target:{building:string[];specialty?:string})=>typeof proposed)=>T){
    let touched=0;
    const resolver=(replace:boolean)=>(kind:string,fallback:()=>typeof proposed,target:{building:string[];specialty?:string})=>{
      if(!equivalentKind(kind))return resolveCurrentPersonnelDutyRoutePeople(state,appId,kind as AuthorityDuty['kind'],target)??fallback();
      const buildings=normalizedBusinessBuildings(target.building),specialties=normalizeProfessionalScope(target.specialty);
      if(duty.buildings&&!buildings.some(building=>duty.buildings!.includes(building)))return resolveCurrentPersonnelDutyRoutePeople(state,appId,kind as AuthorityDuty['kind'],target)??fallback();
      if(duty.specialties&&!specialties.some(specialty=>duty.specialties!.includes(specialty)))return resolveCurrentPersonnelDutyRoutePeople(state,appId,kind as AuthorityDuty['kind'],target)??fallback();
      touched++;
      if(duty.buildings&&buildings.some(building=>!duty.buildings!.includes(building))||duty.specialties&&(!specialties.length||specialties.some(specialty=>!duty.specialties!.includes(specialty))))throw Error('原申请包含职责外的楼栋或专业，尚不能合并确认');
      return replace?proposed:resolveCurrentPersonnelDutyRoutePeople(state,appId,kind as AuthorityDuty['kind'],target)??fallback();
    };
    let before:T;
    try{before=run(resolver(false));}catch{if(touched)throw Error('现行审批关系不完整，无法确认原有效岗位');return;}
    if(!touched)return;
    let after:T;try{after=run(resolver(true));}catch{throw Error('新职责不能保持原有审批或回避规则');}
    if(JSON.stringify(semantic(before))!==JSON.stringify(semantic(after)))throw Error('同范围存在不同直属关系或审批规则，请先对齐职责关联');
    witnessed++;
  }
  if(leave)for(const applicant of leave)for(const approvalDayCount of [1,3])evaluate(resolveDuty=>buildLeaveApprovalPlan({applicant,organizationRecords:leave,approvalDayCount,resolveDuty}));
  if(overtime)for(const applicant of overtime){
    if(duty.kind==='professional_supervisor')evaluate(resolveDuty=>resolveOvertimeProfessionalRecipients(applicant,overtime,resolveDuty));
    else evaluate(resolveDuty=>resolveOvertimeApprovalRoute({applicant,organizationRecords:overtime,resolveDuty}));
  }
  if(!witnessed)throw Error('未找到可证明该岗位现行有效范围的审批上下文');
}
