import type { ManagedAccount, ConfigurationAudit } from '@shared/access-configuration.interface';
import type { AuthorizationTemplate, EffectiveAuthorization } from '@shared/authorization-profile';
import { emptyAuthorizationOverrides } from './authorization-editing';

export function accountLoginLabel(account: ManagedAccount): string {
  return account.kind === 'feishu' ? account.external ? '外部飞书' : '飞书登录' : account.loginMethod === 'personnel-password' ? '姓名登录' : '共享密码入口';
}
export function linkedAccountKey(account: ManagedAccount, appId?: string): string {
  const application = account.kind === 'feishu' ? account.appId : account.personnelAppId;
  return account.personnelIdentity && account.siteMember && !account.external && application && (!appId || application === appId) &&
    (account.kind === 'feishu' || account.loginMethod === 'personnel-password')
    ? `person:${application}:${account.personnelIdentity}` : `account:${account.id}`;
}
export function linkedAccounts(account: ManagedAccount, accounts: ManagedAccount[], appId?: string): ManagedAccount[] {
  const key = linkedAccountKey(account, appId);
  return accounts.filter(item => linkedAccountKey(item, appId) === key);
}
export function synchronizedAccounts(account: ManagedAccount, accounts: ManagedAccount[], appId: string): ManagedAccount[] {
  if (!account.personnelIdentity || !account.siteMember || account.external) return [];
  return linkedAccounts(account, accounts, appId).filter(item => item.id !== account.id && !item.deleted &&
    (item.kind === 'feishu' ? item.appId === appId : item.personnelAppId === appId && item.personnelActive === true));
}
export function groupLinkedAccounts(selected: ManagedAccount[], all: ManagedAccount[], appId?: string) {
  const seen = new Set<string>();
  return selected.flatMap(account => {
    const key = linkedAccountKey(account, appId);
    if (seen.has(key)) return [];
    seen.add(key);
    const members = linkedAccounts(account, all, appId);
    return [{ key, name: account.name, accounts: members.length ? members : [account] }];
  });
}
export function followTemplate(value: EffectiveAuthorization | undefined, template: AuthorizationTemplate): EffectiveAuthorization {
  return { mode: 'follow', templateId: template.id, templateVersion: template.version,
    baseline: structuredClone(template.policy),
    overrides: value?.mode === 'follow' ? structuredClone(value.overrides) : emptyAuthorizationOverrides() };
}
export function mergeVersionedRows<T extends { id: string; version: number }>(current: T[], incoming: T[]): T[] {
  const newer = new Map(current.map(row => [row.id, row]));
  for (const row of incoming) if (!newer.has(row.id) || newer.get(row.id)!.version <= row.version) newer.set(row.id, row);
  return [...newer.values()];
}
export function filterConfigurationAudit(rows: ConfigurationAudit[], query: string, actor: string, action: string, from: string, to: string): ConfigurationAudit[] {
  const start = from ? new Date(`${from}T00:00:00`).getTime() : -Infinity;
  const finish = to ? new Date(`${to}T23:59:59.999`).getTime() : Infinity;
  return rows.filter(row => {
    const at = new Date(row.at).getTime();
    return (!query.trim() || `${row.actorName} ${row.target} ${row.action}`.includes(query.trim())) &&
      (!actor || row.actorId === actor) && (!action || row.action === action) && at >= start && at <= finish;
  }).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
}
export function auditExportRows(rows: ConfigurationAudit[]) {
  const safe = (value: string) => value.replace(/\b(?:ou_|cli_|rec|tbl)[A-Za-z0-9_-]{8,}\b/g, '[已隐藏标识]').replace(/\b[a-f0-9]{32,}\b/gi, '[已隐藏标识]').replace(/\b\d{17}[\dXx]\b/g, '[已隐藏证件号]');
  return rows.map(row => ({ time: row.at, operator: safe(row.actorName), action: safe(row.action), target: safe(row.target) }));
}
