import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import type { PersonnelBaselineEvidence } from '../../../shared/personnel-baseline.interface';
import type { AuthorityDuty } from '../../../shared/personnel-authority.interface';
import type { ConfigurationDirectorySnapshot } from './access-configuration.directory';
import type { ConfigurationState } from './access-configuration.store';
import { PurchaseWorkflowGateway } from '../../modules/purchase-inventory/purchase-workflow.gateway';
import { InventoryWarehouseRoleDirectory, readWarehouseRoleRecords } from '../../modules/inventory-outbound-approval/inventory-warehouse-role-directory';
import { AccessConfigurationCardDirectory } from './access-configuration.card-directory';
import { LeaveWorkflowGateway } from '../../modules/leave-workflow/leave-workflow.gateway';
import { OvertimeWorkflowGateway } from '../../modules/overtime-workflow/overtime-workflow.gateway';
import { resolveCurrentPersonnelDutyMembers } from './personnel-duty-current';
import { verifyPersonnelBaselineContext } from './personnel-baseline.context';

@Injectable()
export class PersonnelBaselineDirectory {
  constructor(private readonly http:HttpService){}
  async read(directory:ConfigurationDirectorySnapshot,state:ConfigurationState):Promise<Record<string,PersonnelBaselineEvidence>>{
    const authority=directory.personnelAuthority,appId=process.env.FEISHU_APP_ID?.trim()||'';
    if(!authority?.duties.length||directory.appId!==appId||state.personnelSource)return {};
    // Share only this check's fresh table, including failures; another check must read again.
    let warehouseRecords:ReturnType<typeof readWarehouseRoleRecords>|undefined;
    const warehouse=new InventoryWarehouseRoleDirectory(this.http,http=>warehouseRecords??=readWarehouseRoleRecords(http));
    const purchase=new PurchaseWorkflowGateway(this.http),cards=new AccessConfigurationCardDirectory(this.http);
    const leave=new LeaveWorkflowGateway(this.http),overtime=new OvertimeWorkflowGateway(this.http);
    const reads=new Map<string,Promise<PersonnelBaselineEvidence['members']>>();
    const once=(key:string,read:()=>Promise<PersonnelBaselineEvidence['members']>)=>{
      let pending=reads.get(key);if(!pending){pending=Promise.resolve().then(read);reads.set(key,pending);}return pending;
    };
    let leaveRecords:ReturnType<LeaveWorkflowGateway['fetchOrganizationRoutingRecords']>|undefined, overtimeRecords:ReturnType<OvertimeWorkflowGateway['fetchOrganizationRoutingRecords']>|undefined;
    const result:Record<string,PersonnelBaselineEvidence>={};
    const duties=authority.duties.filter(row=>row.enabled&&!['professional_engineer','contract_action'].includes(row.kind));
    const readDuty=async(duty:AuthorityDuty)=>{
      const row:PersonnelBaselineEvidence={source:'现行有效岗位',members:[],observedAt:Date.now()};result[duty.recordId]=row;
      try{
        const scoped=(kind:AuthorityDuty['kind'])=>{
          const current=resolveCurrentPersonnelDutyMembers(state,appId,kind,{building:duty.buildings,specialty:duty.specialties});
          return current===null?undefined:current;
        };
        const configured=scoped(duty.kind);
        if(configured){row.source='已确认岗位或当前卡片配置';row.members=configured;return;}
        const cells=(duty.buildings||[null]).flatMap(building=>(duty.specialties||[null]).map(specialty=>({building,specialty})));
        const rows:PersonnelBaselineEvidence['members'][]=[];
        const sources:Partial<Record<AuthorityDuty['kind'],string>>={purchase_manager:'原采购经理审批配置',purchase_approver:'原采购审批配置',purchase_executor:'原综合采购执行配置',building_executor:'原楼栋自采执行配置',warehouse_approver:'原库房审批配置',warehouse_notify:'原库房知会配置',contract_notify:'原合同额外通知配置'};
        row.source=sources[duty.kind]||'原请假与加班审批算法';
        for(const cell of cells){
          const scope={building:cell.building||'',specialty:cell.specialty||''};
          const dynamic=!sources[duty.kind];
          const key=JSON.stringify([appId,authority.source,state.revision,duty.kind,scope.building,scope.specialty,dynamic?[duty.personnelIds,duty.buildings,duty.specialties]:null]);
          rows.push(await once(key,async()=>{
          switch(duty.kind){
            case 'purchase_manager':return (await cards.read('purchase_manager',null)).members||[];
            case 'purchase_approver':return purchase.resolveConfiguredApproversAsApp(scope);
            case 'purchase_executor':return [await purchase.resolvePurchaseAdminAsApp(scope)];
            case 'building_executor':return [await purchase.resolveBuildingSupervisorAsApp(scope.building,scope.specialty||undefined)];
            case 'warehouse_approver':return warehouse.resolveApprovers(scope.building,true);
            case 'warehouse_notify':return warehouse.resolveNotificationRecipients(scope.building,true);
            case 'contract_notify':{const prior=await cards.read('contract_notify',null);if(prior.members===null)throw Error('合同按单据示例人员019动态通知，不能改为全局固定岗位');return prior.members;}
            default:{
              const needsLeave=['building_supervisor','leave_supervisor','leave_manager','professional_supervisor'].includes(duty.kind);
              const needsOvertime=['building_supervisor','overtime_supervisor','overtime_manager','professional_supervisor'].includes(duty.kind);
              if(needsLeave)leaveRecords??=leave.fetchOrganizationRoutingRecords(true);
              if(needsOvertime)overtimeRecords??=overtime.fetchOrganizationRoutingRecords(true);
              verifyPersonnelBaselineContext(duty,authority.people,state,appId,needsLeave?await leaveRecords:undefined,needsOvertime?await overtimeRecords:undefined);
              return duty.personnelIds.map(id=>authority.people.find(person=>person.id===id)!).map(person=>({openId:person.openId!,name:person.name}));
            }
          }
          }));
        }
        const signatures=rows.map(members=>JSON.stringify([...new Set(members.map(person=>person.openId))].sort()));
        if(!rows.length||signatures.some(value=>value!==signatures[0]))throw Error('楼栋或专业的原有效人员不一致，请拆分职责');
        row.members=rows[0];
      }catch(error){row.problem=error instanceof Error&&/^(合同按|楼栋或|同范围|未找到可证明|现行审批关系|新职责不能|原申请包含)/u.test(error.message)?error.message:'现行岗位来源读取失败，请核对关联并重试';}
      row.observedAt=Date.now();
    };
    let next=0;
    await Promise.all(Array.from({length:Math.min(4,duties.length)},async()=>{
      while(next<duties.length)await readDuty(duties[next++]);
    }));
    return result;
  }
}
