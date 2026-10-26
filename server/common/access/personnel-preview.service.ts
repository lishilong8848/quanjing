import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { AccessConfigurationResponse, ManagedAccount } from '../../../shared/access-configuration.interface';
import { isAuthorityDutyKey, type AuthorityPerson, type PersonnelAuthoritySnapshot } from '../../../shared/personnel-authority.interface';
import type { HandoverContext, PendingDuty } from '../../../shared/personnel-handover.interface';
import type { PersonnelOverview, PersonnelPreviewCheck, PersonnelPreviewRequest, PersonnelReadOnlyPreview } from '../../../shared/personnel-preview.interface';
import { AccessConfigurationService } from './access-configuration.service';
import { AccessConfigurationDirectory, type ConfigurationDirectorySnapshot } from './access-configuration.directory';
import { feishuIdentityFingerprint } from './feishu-access-approved-grants';
import { accountPermissionTemplate, pendingHandoverSelection, previewPermissionInheritance } from './personnel-handover.preview';
import { PERSONNEL_PREVIEW_READERS, type PersonnelPreviewReader } from './personnel-preview.ports';

const checks: (PersonnelPreviewCheck & { kinds: string[] })[] = [
  {module:'leave',label:'请休假',status:'not_selected',scope:'示例人员001和经理待审批阶段',incomplete:['通知与后续执行'],kinds:['leave_supervisor','leave_manager','building_supervisor']},
  {module:'overtime',label:'加班',status:'not_selected',scope:'待审批、批准后待确认',incomplete:['通知职责'],kinds:['overtime_supervisor','overtime_manager','building_supervisor']},
  {module:'inventory',label:'出入库',status:'not_selected',scope:'出库待审批阶段',incomplete:['入库','出库后续执行','库房知会'],kinds:['warehouse_approver','warehouse_notify']},
  {module:'purchase',label:'采购',status:'not_selected',scope:'采购经理批量审批',incomplete:['旧单卡审批','采购执行','签收','通知'],kinds:['purchase_manager','purchase_approver','purchase_executor','building_executor']},
  {module:'contracts',label:'合同',status:'not_selected',scope:'合同与付款办理权限、原待发通知；已受理处置保持原执行',incomplete:['未知处置结果核对','历史通知楼栋归属'],kinds:['contract_action','contract_notify']},
];

@Injectable()
export class PersonnelPreviewService {
  constructor(private readonly configuration: AccessConfigurationService, private readonly directory: AccessConfigurationDirectory, private readonly modules: ModuleRef) {}

  overview(directory: ConfigurationDirectorySnapshot, state: AccessConfigurationResponse): PersonnelOverview {
    const authority = this.authority(directory, state.appId);
    const archives = this.configuration.permissionArchives();
    return {
      mode:'preview',directoryVersion:authority.version,snapshotAt:authority.snapshotAt,configurationRevision:state.revision,
      people:authority.people.map(person=>({person:structuredClone(person),accounts:state.accounts.filter(account=>this.belongs(account,person,state.appId)),
        archives:archives.filter(archive=>archive.appId===state.appId && (archive.personnelIdentity===person.id || archive.accountId===this.feishuAccountId(person,state.appId)))
          .map(archive=>({accountId:archive.accountId,capturedAt:archive.capturedAt,role:archive.template.role})),
        duties:authority.duties.filter(duty=>duty.personnelIds.includes(person.id)).map(duty=>structuredClone(duty)),
      })),
      duties:structuredClone(authority.duties),problems:[...authority.problems],issues:structuredClone(authority.issues),
    };
  }

  async preview(input: PersonnelPreviewRequest): Promise<PersonnelReadOnlyPreview> {
    this.validate(input);
    const directory=await this.directory.read();
    const state=this.configuration.enrichedSnapshot(directory.people);
    const authority=this.authority(directory,state.appId);
    if (input.expectedDirectoryVersion!==authority.version || input.expectedConfigurationRevision!==state.revision) throw new ConflictException('人员或权限配置已变化，请更新资料后重新预览');
    const from=authority.people.find(person=>person.id===input.fromPersonId),to=authority.people.find(person=>person.id===input.toPersonId);
    if (!from || !to || from.id===to.id || !to.active || (from.openId && from.openId===to.openId)) throw new BadRequestException('请选择不同的前任和在任接任者');
    const duties=authority.duties.filter(duty=>input.dutyRecordIds.includes(duty.recordId));
    if (duties.length!==input.dutyRecordIds.length || duties.some(duty=>!duty.personnelIds.includes(from.id) && !duty.personnelIds.includes(to.id))) throw new BadRequestException('所选职责不属于前任或接任者，请核对岗位');
    const conflicts=[...authority.problems],warnings:string[]=[];
    if (!duties.length) warnings.push('未选择岗位职责，仅预览页面和业务权限');
    const now=Date.now(),activeDuties=duties.filter(duty=>duty.enabled && duty.startsAt<=now && (duty.endsAt===null || duty.endsAt>now));
    for(const duty of duties) if(!activeDuties.includes(duty)) warnings.push(`${duty.name}当前未生效，不列举其待办`);
    if (!to.openId) warnings.push('接任者尚未关联飞书身份，卡片待办不能转交');
    const sourceAccounts=state.accounts.filter(account=>this.belongs(account,from,state.appId));
    const targets=state.accounts.filter(account=>this.belongs(account,to,state.appId) && account.enabled && !account.deleted && !account.permissionsRevoked);
    const archives=this.configuration.permissionArchives();
    const permissions:PersonnelReadOnlyPreview['permissions']=[];
    for(const source of sourceAccounts){
      const archive=archives.find(item=>item.accountId===source.id && item.appId===state.appId && (!item.personnelIdentity || item.personnelIdentity===from.id));
      const historical=source.permissionsRevoked || !source.enabled || source.deleted;
      if(historical && !archive){conflicts.push(`${from.name}的${source.kind==='feishu'?'飞书':'姓名'}账号缺少收权前授权存档`);continue;}
      const template=historical ? archive!.template : accountPermissionTemplate(source,state.rolePageRules);
      const matching=targets.filter(target=>target.kind===source.kind);
      const selected=matching.length ? matching : targets;
      for(const target of selected){
        const value=previewPermissionInheritance(template,accountPermissionTemplate(target,state.rolePageRules));
        permissions.push({...value,sourceAccountId:source.id,targetAccountId:target.id,...(historical ? {sourceArchiveAt:archive!.capturedAt}: {})});
        conflicts.push(...value.conflicts);
      }
    }
    if(!sourceAccounts.length) conflicts.push('前任尚未关联本应用授权账号，不能核对其完整权限');
    if(!targets.length) conflicts.push('接任者尚无可用的本应用授权账号，请先核对账号状态');
    if(sourceAccounts.length>1) warnings.push('前任有多个登录账号，各账号权限分别对照，不自动合并身份');
    const context:HandoverContext={from,to,duties:activeDuties,directoryVersion:authority.version};
    const pending:PendingDuty[]=[],excluded:PersonnelReadOnlyPreview['excluded']=[],results:PersonnelPreviewCheck[]=[];
    for(const definition of checks){
      const {kinds,...check}=definition;
      if(check.status==='unsupported'){results.push(check);continue;}
      if(!activeDuties.some(duty=>kinds.includes(duty.kind))){results.push(check);continue;}
      try {
        const reader=this.modules.get<PersonnelPreviewReader>(PERSONNEL_PREVIEW_READERS[check.module as keyof typeof PERSONNEL_PREVIEW_READERS],{strict:false});
        if(reader.module!==check.module) throw new Error('Wrong preview reader');
        const items=await this.withTimeout(reader.listPending(context));
        if(items.some(item=>item.module!==check.module || !input.dutyRecordIds.includes(item.dutyRecordId))) throw new Error('Unexpected preview scope');
        const selected=pendingHandoverSelection(items);
        pending.push(...selected.pending);excluded.push(...selected.excluded);conflicts.push(...selected.conflicts);
        results.push({...check,status:'checked',count:selected.pending.length});
      } catch {
        const reason=`${check.label}待办未核对，请检查工作流及职责配置后重试`;
        results.push({...check,status:'unavailable',reason});conflicts.push(reason);
      }
    }
    if(this.configuration.snapshot().revision!==state.revision) throw new ConflictException('预览期间权限配置已变化，请更新资料后重新预览');
    const value={readOnly:true as const,directoryVersion:authority.version,configurationRevision:state.revision,from:structuredClone(from),to:structuredClone(to),duties:structuredClone(duties),permissions,pending,excluded,checks:results,conflicts:[...new Set(conflicts)],warnings:[...new Set(warnings)]};
    return {...value,createdAt:new Date().toISOString(),fingerprint:createHash('sha256').update(JSON.stringify(value)).digest('hex')};
  }

  private authority(directory:ConfigurationDirectorySnapshot,appId:string):PersonnelAuthoritySnapshot {
    const value=directory.personnelAuthority;
    if(!value || value.mode!=='shadow' || value.source.appId!==appId || directory.appId!==appId) throw new ServiceUnavailableException('人员与岗位资料尚未就绪，请稍后重试');
    return value;
  }
  private feishuAccountId(person:AuthorityPerson,appId:string):string|undefined { return person.openId ? `feishu-${feishuIdentityFingerprint(appId,person.openId)}` : undefined; }
  private belongs(account:ManagedAccount,person:AuthorityPerson,appId:string):boolean {
    return account.kind==='feishu' ? account.appId===appId && account.id===this.feishuAccountId(person,appId) : account.loginMethod==='personnel-password' && account.personnelAppId===appId && (account.personnelIdentity===person.id || account.id===person.id);
  }
  private validate(value:PersonnelPreviewRequest):void {
    const keys=['fromPersonId','toPersonId','dutyRecordIds','expectedDirectoryVersion','expectedConfigurationRevision'];
    if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!keys.includes(key)) ||
      ![value.fromPersonId,value.toPersonId].every(id=>typeof id==='string' && /^local-external-[a-f0-9]{64}$/.test(id)) ||
      typeof value.expectedDirectoryVersion!=='string' || !/^[a-f0-9]{64}$/.test(value.expectedDirectoryVersion) || !Number.isSafeInteger(value.expectedConfigurationRevision) || value.expectedConfigurationRevision<0 ||
      !Array.isArray(value.dutyRecordIds) || value.dutyRecordIds.length>100 || new Set(value.dutyRecordIds).size!==value.dutyRecordIds.length || value.dutyRecordIds.some(id=>!isAuthorityDutyKey(id))) throw new BadRequestException('交接预览字段或版本无效');
  }
  private async withTimeout<T>(operation:Promise<T>):Promise<T> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try { return await Promise.race([operation,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Preview timeout')),2000);})]); }
    finally { if(timer)clearTimeout(timer); }
  }
}
