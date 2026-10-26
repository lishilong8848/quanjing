import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AccessPrincipal } from '@shared/access-control.interface';
import { resolveSelfServiceApplicant } from '@shared/self-service-applicant';
import { extractDisplayText, getRecordId, pickField, type BitableRecordItem } from '../feishu/bitable-direct-read';
import { feishuIdentityFingerprint } from './feishu-access-approved-grants';

interface PersonnelIdentity {
  appId: string;
  appToken: string;
  tableId: string;
  recordId: string;
  openId?: string;
}

export function bindSelfServiceApplicant(
  requestedName: string,
  principal: AccessPrincipal | undefined,
  authenticated: boolean,
  action = '提交申请',
): string {
  const applicant = resolveSelfServiceApplicant(principal, authenticated, action);
  if (applicant.mode === 'login') throw new UnauthorizedException(applicant.message);
  if (applicant.mode === 'error') throw new BadRequestException(applicant.message);
  if (applicant.mode === 'manual') return requestedName;
  if (requestedName.trim() && requestedName.trim() !== applicant.name) {
    throw new ForbiddenException('申请人员必须为当前登录本人');
  }
  return applicant.name;
}

function personnelAccountId(accountId: string, person: PersonnelIdentity): string | undefined {
  if (accountId.startsWith('feishu-')) {
    return person.appId && person.openId
      ? `feishu-${feishuIdentityFingerprint(person.appId, person.openId)}` : undefined;
  }
  if (accountId.startsWith('local-external-')) {
    return person.appId && person.appToken && person.tableId && person.recordId
      ? `local-external-${createHash('sha256').update(JSON.stringify([
          person.appId, person.appToken, person.tableId, person.recordId,
        ])).digest('hex')}` : undefined;
  }
  return undefined;
}

export function assertSelfServicePersonnelIdentity(principal: AccessPrincipal | undefined, person: PersonnelIdentity): void {
  const accountId = principal?.accountId;
  if (!accountId || !/^(?:feishu-|local-external-)/.test(accountId)) return;
  if (personnelAccountId(accountId, person) !== accountId) {
    throw new ForbiddenException('登录账号与申请人员资料不一致，请联系管理员核对');
  }
}

export function matchesSelfServicePersonnelIdentity(principal: AccessPrincipal, person: PersonnelIdentity): boolean {
  return Boolean(principal.accountId) && personnelAccountId(principal.accountId!, person) === principal.accountId;
}

export function resolveSelfServicePersonnelRecord(
  principal: AccessPrincipal,
  source: Omit<PersonnelIdentity, 'recordId' | 'openId'>,
  records: readonly BitableRecordItem[],
): BitableRecordItem {
  const matches = records.filter(record => {
    const fields = record.fields || {};
    const userField = pickField(fields, ['员工姓名', '员工', '人员']);
    const ids = new Set<string>();
    if (Array.isArray(userField)) {
      for (const user of userField) {
        if (user && typeof user === 'object' && typeof user.id === 'string') ids.add(user.id);
      }
    }
    const explicitId = extractDisplayText(pickField(fields, ['飞书 open_id', 'open_id', 'Open ID']), '').trim();
    if (explicitId) ids.add(explicitId);
    const openId = ids.size === 1 ? [...ids][0] : undefined;
    return personnelAccountId(principal.accountId || '', { ...source, recordId: getRecordId(record), openId }) === principal.accountId;
  });
  if (matches.length !== 1) throw new ForbiddenException('登录账号未唯一匹配到人员，请联系管理员核对');
  const name = extractDisplayText(pickField(matches[0].fields || {}, ['姓名', '员工姓名', '员工', '人员']), ' ').trim();
  if (!name || name !== principal.displayName?.trim()) throw new ForbiddenException('登录姓名与人员资料不一致，请重新登录后重试');
  return matches[0];
}
