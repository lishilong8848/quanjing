import type { StoredAccount } from './access-configuration.store';
import { feishuIdentityFingerprint } from './feishu-access-approved-grants';
import type { PersonnelEngineerScope } from './engineer-personnel';

export interface SiteMemberIdentity {
  name: string;
  openId?: string;
  passwordAccountId: string;
  engineerScope?: PersonnelEngineerScope | null;
  engineerScopeInvalid?: true;
}

export function reconcileSiteMemberAccounts(
  accounts: Record<string, StoredAccount>, appId: string, members: readonly SiteMemberIdentity[], complete = true,
): { before?: StoredAccount; after: StoredAccount }[] {
  if (!complete) return [];
  const identities = new Map<string, SiteMemberIdentity>();
  for (const person of members) {
    identities.set(person.passwordAccountId, person);
    if (person.openId) identities.set(`feishu-${feishuIdentityFingerprint(appId, person.openId)}`, person);
  }
  const changes: { before?: StoredAccount; after: StoredAccount }[] = [];
  const relevant = Object.values(accounts).filter(account => account.kind === 'feishu' ? account.appId === appId && !account.external : account.loginMethod === 'personnel-password' && account.personnelAppId === appId);
  const ids = new Set([...relevant.map(account => account.id), ...[...identities.keys()].filter(id => id.startsWith('feishu-'))]);
  for (const id of ids) {
    const before = accounts[id], person = identities.get(id);
    if (before?.deleted) continue;
    if (!before && !person) continue;
    const after: StoredAccount = before ? { ...before } : {
      id, kind: 'feishu', name: person!.name, openId: person!.openId, identityHash: id.slice('feishu-'.length), appId,
      role: 'site_member', building: null, enabled: true, deleted: false, version: 1, source: 'configuration', permissionSource: 'personnel',
    };
    after.siteMember = !!person;
    if (person) after.personnelIdentity = person.passwordAccountId;
    if (after.permissionSource === 'personnel' && ['guest', 'site_member', 'professional_engineer'].includes(after.role)) {
      if (person) {
        after.name = person.name;
        if (person.engineerScope) {
          after.role = 'professional_engineer'; after.building = person.engineerScope.buildings[0];
          after.buildings = [...person.engineerScope.buildings]; after.specialties = [...person.engineerScope.specialties];
        } else if (!person.engineerScopeInvalid || after.role !== 'professional_engineer') {
          after.role = 'site_member'; after.building = null; delete after.buildings; delete after.specialties;
        }
        if (after.kind === 'feishu' && !before) after.enabled = true;
      } else { after.role = 'guest'; after.building = null; delete after.buildings; delete after.specialties; }
    }
    if (!before || JSON.stringify({ ...after, version: 0 }) !== JSON.stringify({ ...before, version: 0 })) {
      after.version = before ? before.version + 1 : 1;
      accounts[id] = after; changes.push({ before, after });
    }
  }
  return changes;
}
