import { createHash } from 'node:crypto';
import type { AuthorityPeopleSnapshot, AuthorityPersonType } from '../../../shared/personnel-authority.interface';
import { normalizedBusinessBuildings } from '../../../shared/business-permissions';
import { normalizeProfessionalScope } from '../../../shared/professional-access';
import { extractDisplayText, extractDisplayValues, getRecordId, pickField, type BitableRecordItem } from '../feishu/bitable-direct-read';
import { readPersonnelAuthorizationState } from './personnel-employment-state';
import { normalizeAccessDisplayName } from './access-display-name';
import { OPEN_ID_PATTERN } from './access-configuration.validation';

const types: Record<string, AuthorityPersonType> = { 员工: 'employee', 值班账号: 'duty_account', 协作人员: 'collaborator' };
const validRecordId = (value: unknown): value is string => typeof value === 'string' && /^rec[A-Za-z0-9_]+$/.test(value);
export function authorityRecordIds(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : typeof value === 'object' && 'record_ids' in value ? (value as { record_ids: unknown }).record_ids : null;
  if (!Array.isArray(values) || values.length > 200) return null;
  const ids = values.map(item => typeof item === 'string' ? item : item && typeof item === 'object' ? item.id ?? item.record_id : null);
  return ids.every(validRecordId) ? [...new Set(ids)] : null;
}

export function buildAuthorityPeople(records: readonly BitableRecordItem[], appId: string, appToken: string, tableId: string): AuthorityPeopleSnapshot {
  const people: AuthorityPeopleSnapshot['people'] = [], problems = new Set<string>(), ids = new Set<string>(), activeOpenIds = new Set<string>();
  const issues: AuthorityPeopleSnapshot['issues'] = [];
  let currentRecordId: string | undefined;
  const problem = (message: string) => { problems.add(message); issues.push({ ...(currentRecordId ? { recordId: currentRecordId } : {}), message }); };
  for (const record of records) {
    const fields = record.fields || {}, recordId = getRecordId(record);
    currentRecordId = validRecordId(recordId) ? recordId : undefined;
    if (!validRecordId(recordId) || ids.has(recordId)) { problem('人员记录身份缺失或重复'); continue; }
    ids.add(recordId);
    const users = pickField(fields, ['员工姓名', '员工', '人员']);
    const linked = Array.isArray(users) ? [...new Set(users.map(user => user?.id ?? user?.open_id ?? user?.openId).filter((id): id is string => typeof id === 'string' && OPEN_ID_PATTERN.test(id)))] : [];
    const explicit = extractDisplayText(pickField(fields, ['飞书 open_id', 'open_id', 'Open ID']), '').trim();
    let openId = OPEN_ID_PATTERN.test(explicit) ? explicit : linked.length === 1 ? linked[0] : undefined;
    if ((explicit && !OPEN_ID_PATTERN.test(explicit)) || linked.length > 1 || (explicit && linked.some(id => id !== explicit))) {
      problem('人员飞书身份关联不一致'); openId = undefined;
    }
    const name = normalizeAccessDisplayName(extractDisplayText(fields.姓名, '').trim() || extractDisplayText(users, ' ').trim());
    if (!name) { problem('人员姓名未维护'); continue; }
    const active = readPersonnelAuthorizationState(fields) !== 'inactive';
    if (active && openId) {
      if (activeOpenIds.has(openId)) problem('在职人员飞书身份重复');
      activeOpenIds.add(openId);
    }
    const scope = extractDisplayValues(pickField(fields, ['机楼/专业', '机楼专业']));
    const buildingParts = scope.filter(value => /楼$|站$|变电站$|^opt/u.test(value));
    const buildings = buildingParts.length ? normalizedBusinessBuildings(buildingParts) : [];
    if (buildingParts.length && !buildings.length) problem('人员楼栋范围无效');
    const specialties = normalizeProfessionalScope(scope);
    const label = extractDisplayText(fields.人员类型, '').trim(), type = label ? Object.prototype.hasOwnProperty.call(types, label) ? types[label] : undefined : 'employee';
    if (!type) problem('人员类型无效');
    const dutyRecordIds = authorityRecordIds(fields.任职职责);
    if (!dutyRecordIds) problem('人员职责关联无效');
    people.push({
      id: `local-external-${createHash('sha256').update(JSON.stringify([appId, appToken, tableId, recordId])).digest('hex')}`,
      recordId, name, ...(openId ? { openId } : {}), active, type: type || 'employee',
      position: extractDisplayText(fields.岗位, '、').trim(), systemPosition: extractDisplayText(fields.体系岗位, '、').trim(),
      buildings, specialties, permissionTags: extractDisplayValues(fields.权限身份), dutyRecordIds: dutyRecordIds || [],
    });
  }
  return { people, problems: [...problems], issues };
}
