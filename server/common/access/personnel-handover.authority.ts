import { BadRequestException, ConflictException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ManagedAccount, AccessConfigurationResponse } from '../../../shared/access-configuration.interface';
import type { AuthorityPerson, AuthorityDuty } from '../../../shared/personnel-authority.interface';
import type { HandoverBatch, HandoverContext, HandoverPreviewRequest, PersonnelHandoverPreview, PersonnelPermissionArchive, AccountPermissionTemplate, PermissionArchiveReference } from '../../../shared/personnel-handover.interface';
import type { ConfigurationDirectorySnapshot } from './access-configuration.directory';
import type { PreviewContent } from './personnel-handover.baseline';
import { copyHandoverPreview, permissionTemplateFingerprint } from './personnel-handover.baseline';
import type { AccessConfigurationService } from './access-configuration.service';
import type { AccessConfigurationDirectory } from './access-configuration.directory';
import type { HandoverActor, HandoverAuthorityPort } from './personnel-handover.service';
import { accountPermissionTemplate, copyAccountPermissionTemplate, previewPermissionInheritance } from './personnel-handover.preview';
import { buildPersonnelDutyRoutingChanges, personnelDutyAssignmentFingerprint } from './personnel-duty-routing';
import { feishuIdentityFingerprint } from './feishu-access-approved-grants';
import { createHash } from 'node:crypto';
import { effectivePagePaths } from '../../../shared/page-access';
import { handoverPermissionGrantKeys, normalizeHandoverPermissionOwnership, splitHandoverPermissionGrants } from './personnel-handover.ownership';
import { isAuthorityDutyKey } from '../../../shared/personnel-authority.interface';

function dutyFingerprint(duty:AuthorityDuty):string {
  return createHash('sha256').update(JSON.stringify([duty.recordId,duty.kind,[...duty.personnelIds].sort(),duty.buildings && [...duty.buildings].sort(),duty.specialties && [...duty.specialties].sort(),duty.role || null,duty.enabled,duty.startsAt,duty.endsAt,[...duty.parentDutyIds].sort(),duty.version,...(duty.origin ? [duty.origin] : [])])).digest('hex');
}

export function handoverPersonAccounts(state:AccessConfigurationResponse,person:AuthorityPerson):ManagedAccount[] {
  const feishuId=person.openId ? `feishu-${feishuIdentityFingerprint(state.appId,person.openId)}` : undefined;
  return state.accounts.filter(account=>account.kind==='feishu' ? account.appId===state.appId && account.id===feishuId :
    account.loginMethod==='personnel-password' && account.personnelAppId===state.appId && (account.personnelIdentity===person.id || account.id===person.id));
}

export function buildHandoverAuthoritySnapshot(directory:ConfigurationDirectorySnapshot,state:AccessConfigurationResponse,archives:readonly PersonnelPermissionArchive[],request:HandoverPreviewRequest):{content:PreviewContent;context:HandoverContext} {
  if(!request || Object.keys(request).some(key=>!['fromPersonId','toPersonId','dutyRecordIds','mode','ownership'].includes(key)) ||
    ![request.fromPersonId,request.toPersonId].every(id=>typeof id==='string' && /^local-external-[a-f0-9]{64}$/.test(id)) ||
    !['offboarding','rotation'].includes(request.mode) || !Array.isArray(request.dutyRecordIds) || !request.dutyRecordIds.length || request.dutyRecordIds.length>100 ||
    new Set(request.dutyRecordIds).size!==request.dutyRecordIds.length || request.dutyRecordIds.some(id=>!isAuthorityDutyKey(id))) throw new BadRequestException('交接人员、职责或模式无效');
  const authority=directory.personnelAuthority,employment=directory.employmentState,now=Date.now();
  if(!authority || authority.mode!=='shadow' || authority.source.appId!==state.appId || directory.appId!==state.appId || directory.personnelComplete!==true ||
    authority.problems.length || !employment?.complete || !/^[a-f0-9]{64}$/.test(authority.version) || !Number.isFinite(authority.snapshotAt) || authority.snapshotAt<now-5*60_000 || authority.snapshotAt>now+60_000) throw new ServiceUnavailableException('人员职责资料不完整或已过期，请更新资料后重试');
  const from=authority.people.find(person=>person.id===request.fromPersonId),to=authority.people.find(person=>person.id===request.toPersonId);
  if(!from || !to || from.id===to.id || !to.active) throw new BadRequestException('请选择不同的前任和在任接任者');
  if(!from.openId || !to.openId || from.openId===to.openId || authority.people.some(person=>person.id!==from.id && person.openId===from.openId || person.id!==to.id && person.openId===to.openId)) throw new ConflictException('交接人员的本应用飞书身份缺失或重复，请先核对');
  for(const person of [from,to]){
    const entries=employment.entries.filter(entry=>entry.personnelIdentity===person.id);
    if(entries.length!==1 || entries[0].inactive===person.active || entries[0].openId!==person.openId) throw new ConflictException('人员在任状态或飞书身份尚未明确，请先核对');
  }
  if(request.mode==='offboarding' && from.active || request.mode==='rotation' && !from.active) throw new ConflictException('人员状态与交接模式不一致，已收权人员不能按轮岗恢复权限');
  const duties=authority.duties.filter(duty=>request.dutyRecordIds.includes(duty.recordId));
  if(duties.length!==request.dutyRecordIds.length || duties.some(duty=>!duty.enabled || duty.startsAt>now || duty.endsAt!==null && duty.endsAt<=now || !duty.personnelIds.some(id=>id===from.id || id===to.id))) throw new ConflictException('职责不属于交接人员或尚未生效，请先核对');
  const sources=handoverPersonAccounts(state,from),targets=handoverPersonAccounts(state,to);
  if(!sources.length || !targets.length) throw new ConflictException('交接人员尚未关联本应用授权账号');
  if(targets.some(account=>!account.enabled || account.deleted || account.permissionsRevoked || account.personnelActive===false)) throw new ConflictException('接任者账号已收权、停用或删除，交接不能恢复该账号');
  if(request.mode==='rotation' && sources.some(account=>account.permissionsRevoked || !account.enabled || account.deleted || account.personnelActive===false)) throw new ConflictException('前任已收权或停用，不能通过轮岗重新加权');
  if(request.mode==='offboarding' && sources.some(account=>!account.permissionsRevoked)) throw new ConflictException('人员权限状态尚未对齐，请先同步人员权限');
  const sourceTemplates=sources.map(account=>{
    if(request.mode==='rotation') return {account,template:accountPermissionTemplate(account,state.rolePageRules)};
    const matching=archives.filter(archive=>archive.accountId===account.id && archive.appId===state.appId && (!archive.personnelIdentity || archive.personnelIdentity===from.id));
    if(matching.length!==1) throw new ConflictException('前任缺少唯一的收权前授权存档，请先核对');
    const archive=matching[0],template=copyAccountPermissionTemplate(archive.template);
    if(archive.configurationRevision>state.revision || template.sourceVersion>account.version) throw new ConflictException('收权前授权存档版本不一致，请先核对');
    const reference:PermissionArchiveReference={accountId:account.id,configurationRevision:archive.configurationRevision,sourceVersion:template.sourceVersion,templateHash:permissionTemplateFingerprint(template)};
    return {account,template,reference};
  });
  const semantic=(template:AccountPermissionTemplate)=>JSON.stringify({...template,sourceVersion:1});
  if(sourceTemplates.some(source=>semantic(source.template)!==semantic(sourceTemplates[0].template))) throw new ConflictException('前任多个登录账号权限不一致，请先对齐或单独核对');
  const ownership=request.ownership===undefined ? undefined : normalizeHandoverPermissionOwnership(request.ownership,request.dutyRecordIds);
  if(ownership?.some(row=>!sources.some(account=>account.id===row.sourceAccountId)))throw new BadRequestException('权限归属账号不属于前任');
  const splits=new Map(sourceTemplates.flatMap(source=>{
    const choice=ownership?.find(row=>row.sourceAccountId===source.account.id);
    return choice ? [[source.account.id,splitHandoverPermissionGrants(source.template,choice.grants,request.dutyRecordIds,effectivePagePaths('site_member',state.rolePageRules),effectivePagePaths(source.template.role,state.rolePageRules))] as const] : [];
  }));
  const permissionOwnership=sourceTemplates.map(source=>{
    const grantKeys=handoverPermissionGrantKeys(source.template,effectivePagePaths(source.template.role,state.rolePageRules),effectivePagePaths('site_member',state.rolePageRules));
    return {sourceAccountId:source.account.id,kind:source.account.kind,source:source.template,required:request.mode==='rotation'||ownership!==undefined||grantKeys.length>1,grantKeys};
  });
  const unresolved=permissionOwnership.some(source=>source.required&&!splits.has(source.sourceAccountId));
  if(splits.size===sourceTemplates.length && [...splits.values()].some(split=>semantic(split.retained)!==semantic([...splits.values()][0].retained)||semantic(split.transfer)!==semantic([...splits.values()][0].transfer)))throw new ConflictException('前任不同登录方式的权限归属不一致，请统一选择');
  const permissions=targets.map(target=>{
    const source=sourceTemplates.find(source=>source.account.kind===target.kind) || sourceTemplates[0];
    const split=splits.get(source.account.id),transfer=split?.transfer || source.template;
    const value=previewPermissionInheritance(transfer,accountPermissionTemplate(target,state.rolePageRules));
    if(transfer.role==='admin' && target.role!=='admin') value.conflicts.push('管理员权限须单独配置，不能由岗位交接直接提升');
    return {...value,source:source.template,sourceAccountId:source.account.id,targetAccountId:target.id,...(split?{transfer:split.transfer,...(request.mode==='rotation'?{sourceRetained:split.retained}:{})}:{}),...(source.reference?{sourceArchive:source.reference}:{})};
  });
  const usedArchives=sourceTemplates.flatMap(source=>source.reference?[source.reference]:[]);
  const context:HandoverContext={from:structuredClone(from),to:structuredClone(to),duties:structuredClone(duties),directoryVersion:authority.version};
  const content:PreviewContent={requested:{...request,...(ownership?{ownership}:{}),dutyRecordIds:[...request.dutyRecordIds]},baseline:{configurationRevision:state.revision,directoryVersion:authority.version,accounts:[...sources,...targets].map(account=>({id:account.id,version:account.version})),duties:duties.map(duty=>({recordId:duty.recordId,version:duty.version,fingerprint:dutyFingerprint(duty)})),pending:[],...(usedArchives.length?{archives:usedArchives}:{})},
    from:context.from,to:context.to,permissionOwnership,dutyRouting:buildPersonnelDutyRoutingChanges(authority.people,duties,from,to,state.personnelDutyAssignments,state.appId),permissions,pending:[],excluded:[],conflicts:[...new Set([...permissions.flatMap(permission=>permission.conflicts),...(unresolved?['请确认个人权限归属，保留其他任职仍需要的授权']:[])])],warnings:[]};
  return {content,context};
}

export class PersonnelHandoverAuthority implements HandoverAuthorityPort {
  constructor(private readonly configuration:AccessConfigurationService,private readonly directory:Pick<AccessConfigurationDirectory,'read'>) {}
  async assertAdministrator(actor:HandoverActor):Promise<void> {
    const account=this.configuration.snapshot().accounts.find(account=>account.id===actor.id);
    if (!account || account.role!=='admin' || !account.enabled || account.deleted || account.permissionsRevoked || account.name!==actor.name ||
      !Number.isSafeInteger(actor.authorizationVersion) || actor.authorizationVersion!==account.version ||
      !this.configuration.validateSession(account.id,actor.authorizationVersion,account.role,account.building)) throw new UnauthorizedException('管理权限已变化，请重新登录');
  }
  async snapshot(request:HandoverPreviewRequest){
    const directory=await this.directory.read(),state=this.configuration.snapshot();
    return {ready:true,...buildHandoverAuthoritySnapshot(directory,state,this.configuration.permissionArchives(),request)};
  }
  async restoreContext(input:PersonnelHandoverPreview,batch?:HandoverBatch):Promise<HandoverContext> {
    const preview=copyHandoverPreview(input);
    const applied=batch ? this.configuration.personnelHandoverPermissionRevision(batch) : undefined;
    const request=structuredClone(preview.requested);if(applied!==undefined&&request.mode==='rotation')delete request.ownership;
    const fresh=await this.snapshot(request);
    if (batch && batch.preview.fingerprint!==preview.fingerprint) throw new ConflictException('交接恢复清单不一致');
    if (preview.dutyRouting) {
      if (JSON.stringify(preview.dutyRouting.map(row => row.assignment)) !== JSON.stringify(fresh.content.dutyRouting?.map(row => row.assignment))) throw new ConflictException('人员职责已变化，请核对岗位人员或范围');
      const assignments=this.configuration.snapshot().personnelDutyAssignments;
      for (const row of preview.dutyRouting) {
        const actual=personnelDutyAssignmentFingerprint(assignments?.[row.assignment.dutyRecordId]);
        const expected=applied!==undefined && batch ? personnelDutyAssignmentFingerprint({...row.assignment,confirmedBatchId:batch.id}) : row.previousFingerprint;
        if(actual!==expected)throw new ConflictException('岗位交接配置已变化，请核对原批次');
      }
    }
    if ((!batch || preview.baseline.duties.some(ref=>!ref.fingerprint)) && fresh.context.directoryVersion!==preview.baseline.directoryVersion || fresh.context.duties.length!==preview.baseline.duties.length ||
      fresh.context.duties.some(duty=>!preview.baseline.duties.some(ref=>ref.recordId===duty.recordId && ref.version===duty.version && (!ref.fingerprint || ref.fingerprint===dutyFingerprint(duty))))) throw new ConflictException('人员职责已变化，请重新核对交接');
    if (fresh.content.from.id!==preview.from.id || fresh.content.from.recordId!==preview.from.recordId || fresh.content.from.openId!==preview.from.openId || fresh.content.from.active!==preview.from.active ||
      fresh.content.to.id!==preview.to.id || fresh.content.to.recordId!==preview.to.recordId || fresh.content.to.openId!==preview.to.openId || !fresh.content.to.active) throw new ConflictException('交接人员身份已变化');
    if (fresh.content.baseline.accounts.length!==preview.baseline.accounts.length || fresh.content.baseline.accounts.some(account=>{
      const original=preview.baseline.accounts.find(ref=>ref.id===account.id),target=preview.permissions.find(item=>item.targetAccountId===account.id);
      const sourceChanged=preview.requested.mode==='rotation'&&preview.requested.ownership?.some(choice=>choice.sourceAccountId===account.id);
      return !original || account.version!==original.version+(applied!==undefined && (target||sourceChanged) ? 1 : 0);
    })) throw new ConflictException('交接账号权限已变化，请重新核对清单');
    if (JSON.stringify(fresh.content.baseline.archives || [])!==JSON.stringify(preview.baseline.archives || [])) throw new ConflictException('前任授权存档已变化，请重新核对清单');
    for (const expected of preview.permissions) {
      const current=fresh.content.permissions.find(item=>item.targetAccountId===expected.targetAccountId);
      const template=applied!==undefined ? {...expected.after,sourceVersion:expected.before.sourceVersion+1} : expected.before;
      if (!current || current.sourceAccountId!==expected.sourceAccountId || permissionTemplateFingerprint(current.before)!==permissionTemplateFingerprint(template)) throw new ConflictException('交接账号权限已变化，请重新核对清单');
    }
    if(applied!==undefined&&preview.requested.mode==='rotation') {
      const state=this.configuration.snapshot();
      for(const choice of preview.requested.ownership||[]) {
        const original=preview.permissionOwnership?.find(item=>item.sourceAccountId===choice.sourceAccountId)?.source||preview.permissions.find(item=>item.sourceAccountId===choice.sourceAccountId)?.source||{...preview.permissions[0].source,sourceVersion:preview.baseline.accounts.find(account=>account.id===choice.sourceAccountId)!.version};
        const retained=splitHandoverPermissionGrants(original,choice.grants,preview.requested.dutyRecordIds,effectivePagePaths('site_member',state.rolePageRules),effectivePagePaths(original.role,state.rolePageRules)).retained;
        const current=state.accounts.find(account=>account.id===choice.sourceAccountId);
        if(!current||permissionTemplateFingerprint(accountPermissionTemplate(current,state.rolePageRules))!==permissionTemplateFingerprint({...retained,sourceVersion:original.sourceVersion+1}))throw new ConflictException('前任保留权限已变化，请核对原批次');
      }
    }
    return fresh.context;
  }
  async applyPermissions(batch:HandoverBatch,mutationId:string):Promise<void> {
    await this.restoreContext(batch.preview,batch);
    await this.configuration.applyPersonnelHandoverPermissions(batch,mutationId);
  }
  async permissionsApplied(batch:HandoverBatch):Promise<boolean> {
    return this.configuration.personnelHandoverPermissionRevision(batch)!==undefined;
  }
}
