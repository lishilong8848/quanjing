import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { AccessPrincipal } from '@shared/access-control.interface';
import { isStation110DutyApplicant } from '@shared/workforce-request-applicant';
import { SITE_MEMBER_BACKUP_ACCOUNT_ID } from '@shared/site-member-backup';
import { extractDisplayText, getRecordId, normalizeBuildingForFrontend, pickField, type BitableRecordItem } from '../feishu/bitable-direct-read';
import { feishuIdentityFingerprint } from './feishu-access-approved-grants';
import { readPersonnelAuthorizationState } from './personnel-employment-state';
import { bindSelfServiceApplicant } from './self-service-applicant';

export function bindWorkforceRequestApplicant(
  requestedName: string,
  principal: AccessPrincipal | undefined,
  authenticated: boolean,
  action: string,
): string {
  if (principal?.accountId === SITE_MEMBER_BACKUP_ACCOUNT_ID) {
    throw new ForbiddenException('基地备用账号不能代替个人提交请休假或加班申请');
  }
  if (!authenticated && isStation110DutyApplicant(principal)) throw new UnauthorizedException(`请先登录后${action}`);
  return authenticated && isStation110DutyApplicant(principal)
    ? requestedName.trim()
    : bindSelfServiceApplicant(requestedName, principal, authenticated, action);
}

export function assertStation110WorkforceIdentity(
  principal: AccessPrincipal,
  appId: string,
  records: readonly BitableRecordItem[],
  selected: BitableRecordItem,
): void {
  const isStation = (record: BitableRecordItem) => normalizeBuildingForFrontend(extractDisplayText(
    pickField(record.fields || {}, ['机楼/专业', '所属楼栋', '楼栋']), ' ',
  )) === 'station_110';
  const matches = records.filter(record => {
    const fields = record.fields || {};
    const users = pickField(fields, ['员工姓名', '人员']);
    return Array.isArray(users) && users.some(user => user && typeof user.id === 'string' &&
      `feishu-${feishuIdentityFingerprint(appId, user.id)}` === principal.accountId);
  });
  const hasInvalidAssociation = matches.some(record => {
    const users = pickField(record.fields || {}, ['员工姓名', '人员']);
    return !Array.isArray(users) || users.length !== 1 ||
      !isStation110DutyApplicant({ ...principal, displayName: users[0]?.name });
  });
  if (!isStation110DutyApplicant(principal) || !appId || !getRecordId(selected) ||
      !isStation(selected) || readPersonnelAuthorizationState(selected.fields || {}) === 'inactive' ||
      !matches.length || hasInvalidAssociation || matches.some(record => !isStation(record) ||
        readPersonnelAuthorizationState(record.fields || {}) === 'inactive')) {
    throw new ForbiddenException('110站值班账号未匹配到有效的110站人员关联，请联系管理员核对');
  }
}
