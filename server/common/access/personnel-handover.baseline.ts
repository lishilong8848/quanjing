import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AccountPermissionTemplate, PersonnelHandoverPreview, PermissionArchiveReference } from '../../../shared/personnel-handover.interface';
import type { AuthorityPerson } from '../../../shared/personnel-authority.interface';
import { BUILDING_ADMIN_BUILDINGS } from '../../../shared/access-control.interface';
import { PROFESSIONAL_SPECIALTIES, professionalScopeIsValid } from '../../../shared/professional-access';
import { PAGE_ACCESS_ROLES, validPagePaths } from '../../../shared/page-access';
import { validBuildingScope } from '../../../shared/building-access';
import { validPersonalRules } from '../../../shared/business-permissions';
import { ID_PATTERN, HASH_PATTERN } from './access-configuration.validation';
import { normalizeAccessDisplayName } from './access-display-name';
import { pendingHandoverSelection } from './personnel-handover.preview';
import { normalizePersonnelDutyRoutingChanges } from './personnel-duty-routing';
import { normalizeHandoverPermissionOwnership } from './personnel-handover.ownership';

export type PreviewContent = Omit<PersonnelHandoverPreview, 'fingerprint' | 'createdAt'>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fail = (): never => { throw new BadRequestException('交接清单身份、权限或版本无效'); };
const id = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(value);
const version = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function strings(value: unknown, limit: number, validate: (item: unknown) => boolean, unique = true): string[] {
  if (!Array.isArray(value) || value.length > limit || !value.every(validate) || (unique && new Set(value).size !== value.length)) return fail();
  return [...value] as string[];
}
function person(value: AuthorityPerson): AuthorityPerson {
  if (!record(value) || !id(value.id) || !id(value.recordId) || typeof value.name !== 'string' || normalizeAccessDisplayName(value.name) !== value.name || typeof value.active !== 'boolean' ||
    !['employee','duty_account','collaborator'].includes(value.type) || typeof value.position !== 'string' || value.position.length > 500 || typeof value.systemPosition !== 'string' || value.systemPosition.length > 500 ||
    (value.openId !== undefined && (typeof value.openId !== 'string' || !/^ou_[A-Za-z0-9_-]{1,124}$/u.test(value.openId)))) return fail();
  return { id:value.id,recordId:value.recordId,name:value.name,active:value.active,type:value.type,position:value.position,systemPosition:value.systemPosition,
    ...(value.openId ? { openId:value.openId } : {}),
    buildings:strings(value.buildings,7,item=>(BUILDING_ADMIN_BUILDINGS as readonly unknown[]).includes(item)) as AuthorityPerson['buildings'],
    specialties:strings(value.specialties,6,item=>(PROFESSIONAL_SPECIALTIES as readonly unknown[]).includes(item)) as AuthorityPerson['specialties'],
    permissionTags:strings(value.permissionTags,100,text),dutyRecordIds:strings(value.dutyRecordIds,1000,id) };
}
function template(value: AccountPermissionTemplate): AccountPermissionTemplate {
  if (!record(value) || !(PAGE_ACCESS_ROLES as readonly unknown[]).includes(value.role) || !validBuildingScope(value.role,value.building,value.buildings) ||
    !version(value.sourceVersion) || !validPagePaths(value.pagePaths) ||
    (['professional_admin','professional_engineer'].includes(value.role) ? !professionalScopeIsValid(value.specialties) : value.specialties !== undefined) ||
    (value.personalRules !== undefined && !validPersonalRules(value.personalRules))) return fail();
  return { role:value.role,building:value.building,sourceVersion:value.sourceVersion,pagePaths:[...value.pagePaths],
    ...(value.buildings ? { buildings:[...value.buildings] } : {}),...(value.specialties ? { specialties:[...value.specialties] } : {}),
    ...(value.personalRules ? { personalRules:value.personalRules.map(rule=>({ id:rule.id,effect:rule.effect,module:rule.module,actions:[...rule.actions],buildings:rule.buildings ? [...rule.buildings] : null,specialties:rule.specialties ? [...rule.specialties] : null })) } : {}) };
}
export function permissionTemplateFingerprint(value: AccountPermissionTemplate): string {
  return createHash('sha256').update(JSON.stringify(template(value))).digest('hex');
}
function archive(value: PermissionArchiveReference): PermissionArchiveReference {
  if (!record(value) || !id(value.accountId) || !Number.isSafeInteger(value.configurationRevision) || value.configurationRevision < 0 ||
    !version(value.sourceVersion) || typeof value.templateHash !== 'string' || !HASH_PATTERN.test(value.templateHash)) return fail();
  return { accountId:value.accountId,configurationRevision:value.configurationRevision,sourceVersion:value.sourceVersion,templateHash:value.templateHash };
}
function content(value: PreviewContent): PreviewContent {
  if (!record(value) || !record(value.requested) || !record(value.baseline)) return fail();
  const requested=value.requested, baseline=value.baseline;
  if (!id(requested.fromPersonId) || !id(requested.toPersonId) || requested.fromPersonId === requested.toPersonId || !['offboarding','rotation'].includes(requested.mode) ||
    !Number.isSafeInteger(baseline.configurationRevision) || baseline.configurationRevision < 0 || !HASH_PATTERN.test(baseline.directoryVersion)) return fail();
  const dutyRecordIds=strings(requested.dutyRecordIds,100,id).sort();
  if (!dutyRecordIds.length) return fail();
  const ownership=requested.ownership===undefined?undefined:normalizeHandoverPermissionOwnership(requested.ownership,dutyRecordIds);
  const from=person(value.from), to=person(value.to);
  if (from.id !== requested.fromPersonId || to.id !== requested.toPersonId || from.recordId === to.recordId || !to.active ||
    (from.openId && from.openId === to.openId)) return fail();
  if (!Array.isArray(baseline.accounts) || baseline.accounts.length > 100 || !Array.isArray(baseline.duties) || baseline.duties.length > 100 || !Array.isArray(baseline.pending) || baseline.pending.length > 10_000) return fail();
  const accounts=baseline.accounts.map(item=>{ if (!record(item) || !id(item.id) || !version(item.version)) return fail(); return { id:item.id,version:item.version }; });
  const duties=baseline.duties.map(item=>{ if (!record(item) || !id(item.recordId) || !version(item.version) || item.fingerprint!==undefined && !HASH_PATTERN.test(item.fingerprint)) return fail(); return { recordId:item.recordId,version:item.version,...(item.fingerprint ? {fingerprint:item.fingerprint} : {}) }; });
  const refs=baseline.pending.map(item=>{ if (!record(item) || !text(item.key) || !text(item.version)) return fail(); return { key:item.key,version:item.version }; });
  if (baseline.archives !== undefined && (!Array.isArray(baseline.archives) || baseline.archives.length > 100)) return fail();
  const archives=(baseline.archives || []).map(archive);
  if (new Set(archives.map(item=>item.accountId)).size !== archives.length || archives.some(item=>item.configurationRevision > baseline.configurationRevision ||
    !accounts.some(account=>account.id === item.accountId && account.version >= item.sourceVersion))) return fail();
  if (new Set(accounts.map(item=>item.id)).size !== accounts.length || new Set(duties.map(item=>item.recordId)).size !== duties.length || new Set(refs.map(item=>item.key)).size !== refs.length ||
    dutyRecordIds.some(key=>!duties.some(item=>item.recordId === key))) return fail();
  if (!Array.isArray(value.permissions) || value.permissions.length > 100) return fail();
  const permissions=value.permissions.map(item=>{
    if (!record(item) || !id(item.sourceAccountId) || !id(item.targetAccountId) || item.sourceAccountId === item.targetAccountId) return fail();
    const source=template(item.source), before=template(item.before), after=template(item.after);
    const transfer=item.transfer===undefined?undefined:template(item.transfer),sourceRetained=item.sourceRetained===undefined?undefined:template(item.sourceRetained);
    if((transfer||sourceRetained)&&!ownership?.some(row=>row.sourceAccountId===item.sourceAccountId)||transfer&&transfer.sourceVersion!==source.sourceVersion||sourceRetained&&(sourceRetained.sourceVersion!==source.sourceVersion||requested.mode!=='rotation'))return fail();
    const sourceArchive=item.sourceArchive === undefined ? undefined : archive(item.sourceArchive);
    const sourceVersionValid=sourceArchive ? sourceArchive.accountId === item.sourceAccountId && sourceArchive.sourceVersion === source.sourceVersion &&
      sourceArchive.templateHash === permissionTemplateFingerprint(source) && archives.some(ref=>JSON.stringify(ref) === JSON.stringify(sourceArchive)) :
      accounts.find(account=>account.id === item.sourceAccountId)?.version === source.sourceVersion;
    if (!sourceVersionValid || accounts.find(account=>account.id === item.targetAccountId)?.version !== before.sourceVersion || after.sourceVersion !== before.sourceVersion ||
      !validPagePaths(item.addedPages) || !validPagePaths(item.removedPages)) return fail();
    return { sourceAccountId:item.sourceAccountId,targetAccountId:item.targetAccountId,source,before,after,...(transfer?{transfer}:{}),...(sourceRetained?{sourceRetained}:{}),
      ...(sourceArchive ? { sourceArchive } : {}),
      conflicts:strings(item.conflicts,100,text,false),warnings:strings(item.warnings,100,text,false),addedPages:[...item.addedPages],removedPages:[...item.removedPages] };
  });
  if (new Set(permissions.map(item=>item.targetAccountId)).size !== permissions.length) return fail();
  const selection=pendingHandoverSelection(value.pending);
  if (selection.conflicts.length || selection.excluded.length || selection.pending.some(item=>!dutyRecordIds.includes(item.dutyRecordId) || refs.find(ref=>ref.key === item.key)?.version !== item.version)) return fail();
  if (!Array.isArray(value.excluded) || value.excluded.length > 10_000) return fail();
  const excluded=value.excluded.map(item=>{ if (!record(item) || !text(item.key) || !text(item.reason)) return fail(); return { key:item.key,reason:item.reason }; });
  if(value.permissionOwnership!==undefined&&(!Array.isArray(value.permissionOwnership)||value.permissionOwnership.length>100))return fail();
  const permissionOwnership=value.permissionOwnership===undefined?undefined:value.permissionOwnership.map(row=>{
    if(!record(row)||!id(row.sourceAccountId)||!['local','feishu'].includes(row.kind)||typeof row.required!=='boolean')return fail();
    const source=template(row.source),ref=accounts.find(account=>account.id===row.sourceAccountId),saved=archives.find(item=>item.accountId===row.sourceAccountId);
    if(!ref||source.sourceVersion!==(requested.mode==='offboarding'?saved?.sourceVersion:ref.version))return fail();
    return {sourceAccountId:row.sourceAccountId,kind:row.kind,source,required:row.required,grantKeys:strings(row.grantKeys,300,text)};
  });
  if(permissionOwnership&&(!Array.isArray(value.permissionOwnership)||permissionOwnership.length>100||new Set(permissionOwnership.map(row=>row.sourceAccountId)).size!==permissionOwnership.length))return fail();
  const dutyRouting = value.dutyRouting === undefined ? undefined : normalizePersonnelDutyRoutingChanges(value.dutyRouting);
  if (dutyRouting && (dutyRouting.length !== dutyRecordIds.length || dutyRouting.some(row => !dutyRecordIds.includes(row.assignment.dutyRecordId) ||
    baseline.duties.find(duty => duty.recordId === row.assignment.dutyRecordId)?.version !== row.assignment.version ||
    !row.assignment.members.some(member => member.personId === to.id && member.recordId === to.recordId && member.openId === to.openId) || row.assignment.members.some(member => member.personId === from.id || member.openId === from.openId)))) return fail();
  return { requested:{ fromPersonId:requested.fromPersonId,toPersonId:requested.toPersonId,mode:requested.mode,dutyRecordIds,...(ownership?{ownership}:{}) },
    baseline:{ configurationRevision:baseline.configurationRevision,directoryVersion:baseline.directoryVersion,accounts:accounts.sort((a,b)=>a.id < b.id ? -1 : a.id > b.id ? 1 : 0),duties:duties.sort((a,b)=>a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0),pending:refs.sort((a,b)=>a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      ...(archives.length ? { archives:archives.sort((a,b)=>a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0) } : {}) },
    from,to,...(permissionOwnership?{permissionOwnership:permissionOwnership.sort((a,b)=>a.sourceAccountId.localeCompare(b.sourceAccountId))}:{}),...(dutyRouting ? { dutyRouting } : {}),permissions:permissions.sort((a,b)=>a.targetAccountId < b.targetAccountId ? -1 : a.targetAccountId > b.targetAccountId ? 1 : 0),pending:selection.pending.sort((a,b)=>a.key < b.key ? -1 : a.key > b.key ? 1 : 0),excluded,
    conflicts:strings(value.conflicts,1000,text,false),warnings:strings(value.warnings,1000,text,false) };
}
export function handoverFingerprint(value: PreviewContent): string {
  return createHash('sha256').update(JSON.stringify(content(value))).digest('hex');
}
export function normalizeHandoverPreview(value: PersonnelHandoverPreview): PersonnelHandoverPreview {
  const normalized=content(value);
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return fail();
  if (typeof value.fingerprint !== 'string' || !HASH_PATTERN.test(value.fingerprint) || handoverFingerprint(normalized) !== value.fingerprint) throw new BadRequestException('交接预览指纹无效');
  return { ...normalized,fingerprint:value.fingerprint,createdAt:value.createdAt };
}
export function assertHandoverBaseline(preview: PersonnelHandoverPreview, current: PreviewContent): void {
  const valid=normalizeHandoverPreview(preview);
  try {
    if (valid.fingerprint === handoverFingerprint(current)) return;
  } catch { /* An invalid current snapshot must invalidate the old confirmation. */ }
  throw new ConflictException('交接清单已变化，请核对更新后的清单，原选择已保留');
}
export function copyHandoverPreview(value: PersonnelHandoverPreview): PersonnelHandoverPreview { return clone(normalizeHandoverPreview(value)); }
