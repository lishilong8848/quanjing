import { ServiceUnavailableException } from '@nestjs/common';
import { normalizedBusinessBuildings } from '../../../shared/business-permissions';
import { normalizeProfessionalScope } from '../../../shared/professional-access';
import { AUTHORITY_DUTY_CATALOG, isAuthorityDutyKey, type AuthorityDutyKind } from '../../../shared/personnel-authority.interface';
import type { PersonnelDutyAssignment } from '../../../shared/personnel-duty-routing';
import { PERSONNEL_SOURCE_MAX_AGE_MS, validPersonnelSourceBinding, type PersonnelSourceState, type PersonnelSourceBinding, type PersonnelSourcePreview } from '../../../shared/personnel-source.interface';
import type { ConfigurationDirectorySnapshot } from './access-configuration.directory';
import type { ConfigurationState } from './access-configuration.store';
import { resolvePersonnelDutyMembers, validPersonnelDutyAssignments } from './personnel-duty-routing';
import { filterActivePersonnelDutyMembers, type DutyEligibilityState } from './personnel-duty-eligibility';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(value);
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const candidateBatch = '00000000-0000-0000-0000-000000000000';
const sameKind = (wanted: AuthorityDutyKind, actual: AuthorityDutyKind) => wanted === actual || ['leave_supervisor', 'overtime_supervisor'].includes(wanted) && actual === 'building_supervisor';

export function validPersonnelSource(value: unknown): value is PersonnelSourceState {
  if (!record(value) || !record(value.source)) return false;
  const binding = value.source;
  if (Object.keys(value).some(key => !['status','source','directoryVersion','activatedAt','lastSuccessAt','routes','pending','error'].includes(key)) ||
    !['active','pending','error','paused'].includes(String(value.status)) || !validPersonnelSourceBinding(binding) ||
    typeof value.directoryVersion !== 'string' || !/^[a-f0-9]{64}$/.test(value.directoryVersion) || !timestamp(value.activatedAt) || !timestamp(value.lastSuccessAt) ||
    value.lastSuccessAt < value.activatedAt || !validPersonnelDutyAssignments(value.routes) || !Object.keys(value.routes).length ||
    Object.values(value.routes).some(rule => rule.appId !== binding.appId || rule.origin === 'personnel_position' && binding.kind !== 'personnel_positions') || !Array.isArray(value.pending) || value.pending.length > 1000 ||
    value.error !== undefined && !text(value.error)) return false;
  const seen = new Set<string>();
  for (const item of value.pending) {
    if (!record(item) || Object.keys(item).some(key => !['dutyRecordId','name','reason','candidate'].includes(key)) || typeof item.dutyRecordId !== 'string' ||
      !isAuthorityDutyKey(item.dutyRecordId) || seen.has(item.dutyRecordId) || !text(item.name) || !text(item.reason) ||
      item.candidate !== undefined && (!validPersonnelDutyAssignments({ [item.dutyRecordId]: item.candidate }) || (item.candidate as PersonnelDutyAssignment).appId !== binding.appId || (item.candidate as PersonnelDutyAssignment).origin === 'personnel_position' && binding.kind !== 'personnel_positions') ||
      !value.routes[item.dutyRecordId] && !item.candidate) return false;
    seen.add(item.dutyRecordId);
  }
  return value.status !== 'active' || !value.pending.length;
}

export function samePersonnelRoute(a: PersonnelDutyAssignment, b: PersonnelDutyAssignment): boolean {
  const semantic = (row: PersonnelDutyAssignment) => JSON.stringify([row.appId,row.dutyRecordId,row.kind,row.buildings && [...row.buildings].sort(),
    row.specialties && [...row.specialties].sort(),row.startsAt,row.endsAt,row.origin || null,row.members.map(person => [person.personId,person.recordId,person.openId]).sort((x,y) => x[0].localeCompare(y[0]))]);
  return semantic(a) === semantic(b);
}

type SourceState = Pick<ConfigurationState, 'revision' | 'personnelSource' | 'personnelDutyAssignments' | 'personnelBaseline'> & DutyEligibilityState;
export function inspectPersonnelSource(directory: ConfigurationDirectorySnapshot, state: SourceState, appId: string, now = Date.now()) {
  const authority = directory.personnelAuthority;
  const result: PersonnelSourcePreview = { configurationRevision: state.revision, directoryVersion: authority?.version || '', checkedAt: now, canActivate: false, problems: [], rows: [] };
  const routes: Record<string, PersonnelDutyAssignment> = {};
  const pending: PersonnelSourceState['pending'] = [];
  const fail = (message: string) => { if (!result.problems.includes(message)) result.problems.push(message); };
  if (!authority || authority.mode !== 'shadow' || !directory.personnelComplete || !directory.employmentState?.complete || directory.appId !== appId || authority.source.appId !== appId ||
    !/^cli_[A-Za-z0-9_-]+$/.test(appId) || !validPersonnelSourceBinding(authority.source) || !/^[a-f0-9]{64}$/.test(authority.version) ||
    ![directory.snapshotAt,authority.snapshotAt].every(at => timestamp(at) && at >= now - 5 * 60_000 && at <= now + 60_000)) {
    fail('人员与岗位来源不完整或已过期，请重新核对');
    return { preview: result, routes, pending, source: undefined };
  }
  const source = authority.source as PersonnelSourceBinding;
  if(authority.duties.some(duty=>duty.origin==='personnel_position'&&source.kind!=='personnel_positions'))fail('主表派生岗位的来源种类不一致，请重新核对');
  if (state.personnelSource && (['appId','appToken','tableId','dutyTableId','kind'] as const).some(key => state.personnelSource!.source[key] !== source[key])) fail('人员来源发生变化，请恢复原来源后重新核对');
  for (const problem of authority.problems) fail(problem);
  result.unmanagedKinds=AUTHORITY_DUTY_CATALOG.filter(item=>!['professional_engineer','contract_action','leave_supervisor','overtime_supervisor'].includes(item.id)&&!authority.duties.some(duty=>duty.enabled&&duty.kind===item.id)).map(item=>item.id);
  if (!authority.duties.length) fail('尚无可识别岗位，请核对人员岗位、范围或额外职责');
  if (result.problems.length) return { preview: result, routes, pending, source };
  for (const duty of authority.duties.filter(duty => duty.enabled)) {
    // Engineer and contract-action records describe page/action grants; this migration never creates those grants.
    if (['professional_engineer','contract_action'].includes(duty.kind)) continue;
    const people = duty.personnelIds.map(id => authority.people.find(person => person.id === id));
    const identityReady = people.length > 0 && people.every(person => person?.active && person.openId &&
      filterActivePersonnelDutyMembers(state, appId, [{ openId: person.openId, name: person.name }]).length === 1 &&
      directory.employmentState!.entries.some(entry => entry.personnelIdentity === person.id && entry.openId === person.openId && !entry.inactive));
    if (!identityReady) { fail(`${duty.name}：人员身份、在任状态或业务授权尚未就绪`); continue; }
    const baseline=state.personnelBaseline?.confirmations[state.personnelBaseline.currentId];
    const baselineRow=baseline?.rows[duty.recordId];
    const baselineMatches=!!baseline&&!!baselineRow&&(['appId','appToken','tableId','dutyTableId','kind'] as const).every(key=>baseline.source[key]===source[key]);
    const confirmed:PersonnelDutyAssignment|undefined = state.personnelDutyAssignments?.[duty.recordId] || state.personnelSource?.routes[duty.recordId] || (baselineMatches?{...baselineRow!,baselineConfirmationId:baseline!.id}:undefined);
    const candidate: PersonnelDutyAssignment = { appId, dutyRecordId: duty.recordId, ...(duty.origin ? {origin:duty.origin} : {}), kind: duty.kind, buildings: duty.buildings, specialties: duty.specialties,
      startsAt: duty.startsAt, endsAt: duty.endsAt, version: duty.version, ...(confirmed?.baselineConfirmationId?{baselineConfirmationId:confirmed.baselineConfirmationId}:{confirmedBatchId:confirmed?.confirmedBatchId || candidateBatch}),
      members: people.map(person => ({ personId: person!.id, recordId: person!.recordId, openId: person!.openId!, name: person!.name })) };
    if (!validPersonnelDutyAssignments({ [duty.recordId]: candidate })) { fail(`${duty.name}：职责人员或范围无效`); continue; }
    const aligned = !!confirmed && samePersonnelRoute(candidate, confirmed);
    const reason = confirmed ? '人员或范围已变化，请完成岗位交接后重新核对' : '尚无已确认的岗位基线，请先核对现有岗位授权';
    result.rows.push({ dutyRecordId: duty.recordId, name: duty.name, ...(duty.origin ? {origin:duty.origin} : {}), kind: duty.kind, buildings: duty.buildings, specialties: duty.specialties,
      members: candidate.members.map(person => person.name), status: aligned ? 'aligned' : 'unconfirmed', ...(!aligned ? { reason } : {}) });
    if (aligned) routes[duty.recordId] = candidate;
    else pending.push({ dutyRecordId: duty.recordId, name: duty.name, reason, candidate });
  }
  for (const [id, route] of Object.entries(state.personnelSource?.routes || {})) {
    if (result.rows.some(row => row.dutyRecordId === id)) continue;
    const reason = '原职责已停用、移除或身份无效，请恢复关联并核对岗位交接';
    const name = authority.duties.find(duty => duty.recordId === id)?.name || '原确认岗位';
    pending.push({ dutyRecordId: id, name, reason });
    result.rows.push({ dutyRecordId: id, name, kind: route.kind, buildings: route.buildings, specialties: route.specialties,
      members: route.members.map(person => person.name), status: 'unconfirmed', reason });
    routes[id] = structuredClone(route);
  }
  if (!Object.keys(routes).length && !pending.length) fail('没有可接管的工作流职责，请先核对岗位职责');
  result.canActivate = !result.problems.length && !pending.length && Object.keys(routes).length > 0;
  return { preview: result, routes, pending, source };
}

export function reconcilePersonnelSource(state: ConfigurationState, directory: ConfigurationDirectorySnapshot): void {
  const previous = state.personnelSource;
  if (!previous) return;
  const next = inspectPersonnelSource(directory, state, previous.source.appId);
  if (next.preview.problems.length) { markPersonnelSourceError(state); return; }
  state.personnelSource = { ...previous, status: previous.status === 'paused' ? 'paused' : next.pending.length ? 'pending' : 'active',
    directoryVersion: next.preview.directoryVersion, lastSuccessAt: Math.max(previous.activatedAt, directory.personnelAuthority!.snapshotAt),
    routes: { ...previous.routes, ...next.routes }, pending: next.pending };
  delete state.personnelSource.error;
}

export function markPersonnelSourceError(state: ConfigurationState): void {
  if (state.personnelSource) {
    if (state.personnelSource.status !== 'paused') state.personnelSource.status = 'error';
    state.personnelSource.error = '岗位来源核对失败，最近确认的配置已保留，请重试';
  }
}

export function acknowledgePersonnelSourceAssignments(state: ConfigurationState): void {
  const source = state.personnelSource;
  if (!source) return;
  source.pending = source.pending.filter(item => {
    const confirmed = state.personnelDutyAssignments?.[item.dutyRecordId];
    if (!item.candidate || !confirmed || !samePersonnelRoute(item.candidate, confirmed)) return true;
    const {baselineConfirmationId:_baseline,confirmedBatchId:_previous,...definition}=structuredClone(item.candidate);
    source.routes[item.dutyRecordId] = { ...definition, confirmedBatchId: confirmed.confirmedBatchId! };
    return false;
  });
  if (source.status === 'pending' && !source.pending.length) source.status = 'active';
}

function intersects(rule: PersonnelDutyAssignment, target: { building?: unknown; specialty?: unknown }): boolean {
  const buildings = normalizedBusinessBuildings(target.building), specialties = normalizeProfessionalScope(target.specialty);
  return (rule.buildings === null || buildings.some(value => rule.buildings!.includes(value))) &&
    (rule.specialties === null || specialties.some(value => rule.specialties!.includes(value)));
}

export function resolvePersonnelSourceMembers(source: PersonnelSourceState | undefined, appId: string, kind: AuthorityDutyKind, target: { building?: unknown; specialty?: unknown }, now = Date.now()) {
  if (!source) return null;
  if (!validPersonnelSource(source) || source.source.appId !== appId || !Number.isFinite(now)) throw new ServiceUnavailableException('统一岗位来源或应用身份无效，请核对配置');
  const candidates = [...Object.values(source.routes), ...source.pending.flatMap(item => item.candidate ? [item.candidate] : [])].filter(rule => sameKind(kind, rule.kind));
  if (!candidates.length) return null;
  if (target.building == null && candidates.some(rule => rule.buildings !== null)) throw new ServiceUnavailableException('岗位鉴权缺少明确楼栋');
  const relevant = candidates.filter(rule => rule.buildings === null || normalizedBusinessBuildings(target.building).some(value => rule.buildings!.includes(value)));
  if (!relevant.length) return null;
  if (target.specialty == null && relevant.some(rule => rule.specialties !== null)) throw new ServiceUnavailableException('岗位鉴权缺少明确专业');
  if (!relevant.some(rule => intersects(rule, target))) return null;
  if (source.status === 'paused') throw new ServiceUnavailableException('统一岗位来源已暂停，请联系管理员');
  if (source.lastSuccessAt > now + 60_000 || now - source.lastSuccessAt > PERSONNEL_SOURCE_MAX_AGE_MS) throw new ServiceUnavailableException('岗位来源已超过核对有效期，请同步后重试');
  if (source.pending.some(item => [source.routes[item.dutyRecordId],item.candidate].some(rule => rule && sameKind(kind, rule.kind) && intersects(rule, target)))) throw new ServiceUnavailableException('岗位职责待确认交接，请联系管理员');
  const members = resolvePersonnelDutyMembers(source.routes, appId, kind, target, now);
  if (!members?.length) throw new ServiceUnavailableException('岗位职责当前没有有效负责人，请核对岗位交接');
  return members;
}
