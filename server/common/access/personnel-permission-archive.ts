import type { ManagedAccount } from '../../../shared/access-configuration.interface';
import type { PersonnelPermissionArchive } from '../../../shared/personnel-handover.interface';
import type { RolePageRules } from '../../../shared/page-access';
import { BadRequestException } from '@nestjs/common';
import { accountPermissionTemplate, copyAccountPermissionTemplate } from './personnel-handover.preview';
import { ID_PATTERN } from './access-configuration.validation';
import { normalizeAccessDisplayName } from './access-display-name';

export function capturePersonnelPermission(account: ManagedAccount, rules: RolePageRules | undefined, revision: number, now: Date = new Date()): PersonnelPermissionArchive | null {
  if (!account.enabled || account.deleted || (account.loginMethod === 'personnel-password' && account.personnelActive !== true)) return null;
  if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isFinite(now.getTime())) throw new BadRequestException('人员授权快照版本无效');
  const appId=account.kind === 'feishu' ? account.appId : account.personnelAppId;
  const archive:PersonnelPermissionArchive={ accountId:account.id,name:account.name,capturedAt:now.toISOString(),configurationRevision:revision,template:accountPermissionTemplate(account,rules),
    ...(appId ? { appId } : {}),...(account.personnelIdentity ? { personnelIdentity:account.personnelIdentity } : {}) };
  if (!validPersonnelPermissionArchives({ [account.id]:archive })) throw new BadRequestException('人员授权快照无效');
  return archive;
}
export function validPersonnelPermissionArchives(value: unknown): value is Record<string, PersonnelPermissionArchive> {
  const record=(item:unknown):item is Record<string,unknown>=>!!item && typeof item === 'object' && !Array.isArray(item);
  if (!record(value) || Object.keys(value).length > 2000) return false;
  try {
    return Object.entries(value).every(([id,item])=>{
      if (!ID_PATTERN.test(id) || !/^(?:local|feishu)-/u.test(id) || !record(item) || item.accountId !== id ||
        Object.keys(item).some(key=>!['accountId','name','appId','personnelIdentity','capturedAt','configurationRevision','template'].includes(key)) ||
        typeof item.name !== 'string' || normalizeAccessDisplayName(item.name) !== item.name || typeof item.capturedAt !== 'string' || !Number.isFinite(Date.parse(item.capturedAt)) ||
        !Number.isSafeInteger(item.configurationRevision) || Number(item.configurationRevision) < 0 ||
        (item.appId !== undefined && (typeof item.appId !== 'string' || !/^cli_[A-Za-z0-9_-]+$/u.test(item.appId))) ||
        (item.personnelIdentity !== undefined && (typeof item.personnelIdentity !== 'string' || !/^local-external-[a-f0-9]{64}$/u.test(item.personnelIdentity)))) return false;
      const template=copyAccountPermissionTemplate(item.template as PersonnelPermissionArchive['template']);
      return JSON.stringify(template) === JSON.stringify(item.template);
    });
  } catch { return false; }
}
