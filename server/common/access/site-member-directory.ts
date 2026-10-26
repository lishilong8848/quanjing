import { createHash } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { extractDisplayText, getRecordId, pickField, type BitableRecordItem } from '../feishu/bitable-direct-read';
import { readPersonnelAuthorizationState } from './personnel-employment-state';
import { normalizeAccessDisplayName } from './access-display-name';
import { OPEN_ID_PATTERN } from './access-configuration.validation';
import type { SiteMemberIdentity } from './site-member-accounts';
import { readPersonnelEngineerScope } from './engineer-personnel';
import { buildAuthorityPeople } from './personnel-authority.people';

export function buildSiteMemberDirectory(records: readonly BitableRecordItem[], appId: string, appToken: string, tableId: string) {
  const authority = buildAuthorityPeople(records, appId, appToken, tableId);
  const members: SiteMemberIdentity[] = [], blockedOpenIds = new Set<string>(), seenRecords = new Set<string>();
  const counts = new Map<string, number>();
  let missingName = 0, inconsistentIdentity = 0;
  for (const record of records) {
    const fields = record.fields || {};
    if (readPersonnelAuthorizationState(fields) === 'inactive') continue;
    const users = pickField(fields, ['员工姓名', '员工', '人员']);
    const associatedIds = Array.isArray(users) ? [...new Set(users.map(user => user?.id ?? user?.open_id ?? user?.openId).filter((id): id is string => typeof id === 'string' && OPEN_ID_PATTERN.test(id)))] : [];
    const explicit = extractDisplayText(pickField(fields, ['飞书 open_id', 'open_id', 'Open ID']), '').trim();
    const name = normalizeAccessDisplayName(extractDisplayText(fields.姓名, '').trim() || extractDisplayText(users, ' ').trim());
    if (!name) { missingName++; for (const id of associatedIds) blockedOpenIds.add(id); if (OPEN_ID_PATTERN.test(explicit)) blockedOpenIds.add(explicit); continue; }
    const recordId = getRecordId(record);
    if (!/^rec[A-Za-z0-9_]+$/.test(recordId) || seenRecords.has(recordId)) throw new ServiceUnavailableException('在职人员记录身份缺失或重复，保留现有授权');
    seenRecords.add(recordId);
    let openId = OPEN_ID_PATTERN.test(explicit) ? explicit : associatedIds.length === 1 ? associatedIds[0] : undefined;
    if ((explicit && !OPEN_ID_PATTERN.test(explicit)) || associatedIds.length > 1 || (explicit && associatedIds.some(id => id !== explicit))) {
      inconsistentIdentity++; for (const id of associatedIds) blockedOpenIds.add(id); if (openId) blockedOpenIds.add(openId); openId = undefined;
    }
    if (openId) counts.set(openId, (counts.get(openId) || 0) + 1);
    members.push({ name, ...(openId ? { openId } : {}), ...readPersonnelEngineerScope(fields), passwordAccountId: `local-external-${createHash('sha256').update(JSON.stringify([appId, appToken, tableId, recordId])).digest('hex')}` });
  }
  let duplicatedPeople = 0;
  for (const [id, count] of counts) if (count > 1) { blockedOpenIds.add(id); duplicatedPeople += count; }
  const warnings: string[] = [];
  const invalidEngineers = members.filter(person => person.engineerScopeInvalid).length;
  if (invalidEngineers) warnings.push(`${invalidEngineers} 名工程师的岗位、专业或楼栋未明确，保留现有权限，请核对人员标签。`);
  if (duplicatedPeople) warnings.push(`${duplicatedPeople} 名人员的飞书账号关联重复，请核对；姓名账号权限正常同步。`);
  if (inconsistentIdentity) warnings.push(`${inconsistentIdentity} 条人员记录的飞书账号关联不一致，请核对；姓名账号权限正常同步。`);
  if (missingName) warnings.push(`${missingName} 条记录未填写有效姓名，已跳过；示例人员004员权限正常同步。`);
  return { members: members.map(({ openId, ...person }) => openId && !blockedOpenIds.has(openId) ? { ...person, openId } : person), blockedOpenIds, warnings, authorityPeople: authority.people, authorityProblems: authority.problems };
}
