import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { PersonalArchiveResponse } from '../../../shared/personnel-archive.interface';
import { mapOrganizationPersonProfileRecord } from '../../modules/bitable-sync/organization-person-profile.mapper';
import { extractDisplayText, getRecordId, pickField, type BitableRecordItem } from '../feishu/bitable-direct-read';
import { AccessConfigurationService } from './access-configuration.service';
import { PersonnelArchiveGateway, photoToken, type PersonnelArchiveDirectory } from './personnel-archive.gateway';
import { matchesSelfServicePersonnelIdentity, resolveSelfServicePersonnelRecord } from './self-service-applicant';
import { readPersonnelAuthorizationState } from './personnel-employment-state';

@Injectable()
export class PersonnelArchiveService {
  constructor(private readonly configuration: AccessConfigurationService, private readonly gateway: PersonnelArchiveGateway) {}

  async read(principal: AccessPrincipal): Promise<PersonalArchiveResponse> {
    const resolved = await this.resolve(principal);
    if (!resolved) return { status: 'unbound', profile: null, snapshotAt: null };
    const mapped = mapOrganizationPersonProfileRecord(resolved.record);
    if (!mapped) throw new ForbiddenException('个人档案未匹配，请联系管理员核对');
    const { recordId: _recordId, qualityAssessment: _quality, ...profile } = mapped;
    // Employment history contains source ids in the organization DTO. Keep only local list keys.
    profile.employmentHistory = profile.employmentHistory.map((item, index) => ({ ...item, id: `history-${index + 1}` }));
    profile.photoUrl = photoToken(resolved.record) ? '/api/access/personal/archive/photo' : null;
    this.current(principal, resolved.actorVersion);
    return { status: 'ready', profile, snapshotAt: resolved.directory.snapshotAt };
  }

  async photo(principal: AccessPrincipal) {
    const resolved = await this.resolve(principal);
    if (!resolved) return null;
    const photo = await this.gateway.photo(resolved.directory, resolved.record);
    this.current(principal, resolved.actorVersion);
    return photo;
  }

  private current(principal: AccessPrincipal, expectedActorVersion?: number) {
    const current = this.configuration.currentPrincipal(principal.accountId, principal.authorizationVersion);
    if (!current || current.role !== principal.role || principal.requiresPasswordChange) throw new UnauthorizedException('登录状态已变化，请重新登录');
    const account = this.configuration.getPersonnelCredentialAccount(current.accountId!);
    if (!account || !account.enabled || account.deleted || account.reactivationRequired || account.personnelActive === false || account.personnelSuspended) throw new UnauthorizedException('当前账号不可读取个人档案');
    let actorVersion: number | undefined;
    if (principal.impersonation) {
      const actor = this.configuration.getPersonnelCredentialAccount(principal.impersonation.actorAccountId);
      if (!actor || principal.impersonation.expiresAt <= Date.now() ||
        (expectedActorVersion !== undefined && actor.version !== expectedActorVersion) ||
        this.configuration.currentPrincipal(actor.id, actor.version)?.role !== 'admin') throw new UnauthorizedException('管理员代登录状态已变化，请重新登录');
      actorVersion = actor.version;
    }
    return { principal: current, account, actorVersion };
  }

  private async resolve(principal: AccessPrincipal): Promise<{ directory: PersonnelArchiveDirectory; record: BitableRecordItem; actorVersion?: number } | null> {
    const initial = this.current(principal);
    const id = initial.principal.accountId!;
    if (!/^(?:feishu-|local-external-)/.test(id)) return null;
    const directory = await this.gateway.read();
    const latest = this.current(principal, initial.actorVersion);
    const bound = latest.account.personnelIdentity || (latest.account.loginMethod === 'personnel-password' ? id : undefined);
    const source = { appId: directory.appId, appToken: directory.appToken, tableId: directory.tableId };
    if (directory.appId !== (latest.account.appId || latest.account.personnelAppId)) throw new ForbiddenException('个人档案数据源与登录身份不一致');
    if (!bound && !directory.records.some(record => matchesSelfServicePersonnelIdentity(latest.principal, { ...source, recordId: getRecordId(record), openId: recordOpenId(record) }))) return null;
    const record = resolveSelfServicePersonnelRecord(latest.principal, source, directory.records);
    if (bound && bound !== `local-external-${createHash('sha256').update(JSON.stringify([directory.appId,directory.appToken,directory.tableId,getRecordId(record)])).digest('hex')}`) throw new ForbiddenException('个人档案关联已变化，请联系管理员核对');
    const state = readPersonnelAuthorizationState(record.fields || {});
    if (state !== 'active') throw new ForbiddenException('个人档案在职状态尚未确认，请联系管理员核对');
    return { directory, record, actorVersion: initial.actorVersion };
  }
}

function recordOpenId(record: BitableRecordItem): string | undefined {
  const fields = record.fields || {}, users = pickField(fields, ['员工姓名','员工','人员']), ids = new Set<string>();
  if (Array.isArray(users)) for (const user of users) if (user && typeof user.id === 'string') ids.add(user.id);
  const explicit = extractDisplayText(pickField(fields, ['飞书 open_id','open_id','Open ID']), '').trim();
  if (explicit) ids.add(explicit);
  return ids.size === 1 ? [...ids][0] : undefined;
}
