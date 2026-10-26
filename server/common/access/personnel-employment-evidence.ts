import { createHash } from 'node:crypto';
import { extractDisplayText, getRecordId, pickField, type BitableRecordItem } from '../feishu/bitable-direct-read';
import type { PersonnelEmploymentEvidence } from './access-configuration.directory';
import { OPEN_ID_PATTERN } from './access-configuration.validation';
import { readPersonnelAuthorizationState } from './personnel-employment-state';

export function buildPersonnelEmploymentEvidence(records: readonly BitableRecordItem[], appId: string, appToken: string, tableId: string): PersonnelEmploymentEvidence & { warnings: string[] } {
  const ids = new Set<string>(), counts = new Map<string, number>(), warnings = new Set<string>();
  let complete = true;
  const candidates = records.flatMap(record => {
    const recordId = getRecordId(record), fields = record.fields || {};
    if (!/^rec[A-Za-z0-9_]+$/u.test(recordId) || ids.has(recordId)) { complete = false; return []; }
    ids.add(recordId);
    const users = pickField(fields, ['员工姓名','员工','人员']);
    const linked = Array.isArray(users) ? [...new Set(users.map(user => user?.id ?? user?.open_id ?? user?.openId).filter((id): id is string => typeof id === 'string' && OPEN_ID_PATTERN.test(id)))] : [];
    const explicit = extractDisplayText(pickField(fields, ['飞书 open_id','open_id','Open ID']), '').trim();
    const consistent = !(explicit && !OPEN_ID_PATTERN.test(explicit)) && linked.length <= 1 && !(explicit && linked.some(id => id !== explicit));
    const openId = consistent ? (OPEN_ID_PATTERN.test(explicit) ? explicit : linked[0]) : undefined;
    if (!consistent) warnings.add('部分人员飞书身份关联不一致，保留现有飞书授权。');
    if (openId) counts.set(openId, (counts.get(openId) || 0) + 1);
    const status = readPersonnelAuthorizationState(fields);
    if (status === 'unknown') warnings.add('部分人员的离职/异动勾选状态未明确，保留现有授权。');
    return [{ personnelIdentity: `local-external-${createHash('sha256').update(JSON.stringify([appId, appToken, tableId, recordId])).digest('hex')}`, openId, status }];
  });
  if ([...counts.values()].some(count => count > 1)) warnings.add('部分人员飞书身份重复，保留现有飞书授权。');
  return { complete, entries: candidates.flatMap(person => person.status === 'unknown' ? [] : [{ personnelIdentity: person.personnelIdentity,
    ...(person.openId && counts.get(person.openId) === 1 ? { openId: person.openId } : {}), inactive: person.status === 'inactive' }]), warnings: [...warnings] };
}
