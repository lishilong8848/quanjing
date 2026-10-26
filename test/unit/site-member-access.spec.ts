import { reconcileSiteMemberAccounts } from '../../server/common/access/site-member-accounts';
import { defaultCanAccessPage, effectivePagePaths } from '../../shared/page-access';
import { capabilitiesForRole, getAccessRoleLabel } from '../../client/src/access/access-policy';
import type { StoredAccount } from '../../server/common/access/access-configuration.store';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';

const appId = 'cli_site_member_fixture';
const person = { name: '验收成员甲', openId: 'ou_site_fixture', passwordAccountId: `local-external-${'1'.repeat(64)}` };
const id = `feishu-${feishuIdentityFingerprint(appId, person.openId)}`;
const local: StoredAccount = { id: person.passwordAccountId, kind: 'local', name: person.name, role: 'guest', building: null, enabled: true, deleted: false, version: 1, source: 'configuration', permissionSource: 'personnel', loginMethod: 'personnel-password', personnelActive: true, personnelAppId: appId };

describe('基地成员基础权限', () => {
  it('只增加排班中心完整读取和今日航图，不能管理其他业务', () => {
    expect(defaultCanAccessPage('site_member', '/monthly-schedule')).toBe(true);
    expect(defaultCanAccessPage('site_member', '/today-operations-panorama')).toBe(true);
    for (const page of ['/monthly-operations', '/construction-management', '/operations-kb', '/contract-management', '/inventory-management', '/system-configuration']) expect(defaultCanAccessPage('site_member', page)).toBe(false);
    expect(capabilitiesForRole('site_member')).toEqual({ canEdit: false, canDelete: false, canForceRefresh: false, canAccessContracts: false });
    expect(getAccessRoleLabel('site_member', null)).toBe('基地成员');
    expect(effectivePagePaths('site_member', { site_member: ['/nantong-base'] })).toEqual(['/nantong-base']);
    expect(effectivePagePaths('site_member', { guest: ['/mbti-assessment'] })).toEqual(['/mbti-assessment', '/monthly-schedule', '/today-operations-panorama']);
  });
  it('两种稳定身份都获得同一角色，不靠同名串联', () => {
    const unrelated = { ...local, id: `local-external-${'2'.repeat(64)}` };
    const accounts: Record<string, StoredAccount> = { [local.id]: { ...local }, [unrelated.id]: unrelated };
    reconcileSiteMemberAccounts(accounts, appId, [person]);
    expect(accounts[id]).toMatchObject({ name: person.name, role: 'site_member', siteMember: true, identityHash: feishuIdentityFingerprint(appId, person.openId) });
    expect(accounts[local.id]).toMatchObject({ role: 'site_member', siteMember: true });
    expect(accounts[unrelated.id].role).toBe('guest');
  });
  it('没有Open ID的在职记录仍可按记录ID取得姓名账号权限', () => {
    const accounts = { [local.id]: { ...local } };
    reconcileSiteMemberAccounts(accounts, appId, [{ name: person.name, passwordAccountId: local.id }]);
    expect(Object.keys(accounts)).toEqual([local.id]);
    expect(accounts[local.id].role).toBe('site_member');
  });
  it('保留管理员、手工游客、停用和已删除设置', () => {
    for (const override of [{ role: 'admin' as const }, { role: 'guest' as const, permissionSource: 'manual' as const }, { enabled: false, permissionSource: 'manual' as const }, { deleted: true, enabled: false }]) {
      const previous = { ...local, ...override };
      const accounts = { [local.id]: previous };
      reconcileSiteMemberAccounts(accounts, appId, [person]);
      expect(accounts[local.id]).toMatchObject(override);
    }
  });
  it('完整在职视图移出撤销自动成员权限但仍可游客登录，重新加入恢复', () => {
    const accounts: Record<string, StoredAccount> = { [local.id]: { ...local } };
    reconcileSiteMemberAccounts(accounts, appId, [person]);
    const version = accounts[id].version;
    expect(reconcileSiteMemberAccounts(accounts, appId, [person])).toHaveLength(0);
    expect(accounts[id].version).toBe(version);
    reconcileSiteMemberAccounts(accounts, appId, []);
    expect(accounts[id]).toMatchObject({ enabled: true, role: 'guest', siteMember: false });
    expect(accounts[local.id]).toMatchObject({ role: 'guest', siteMember: false });
    reconcileSiteMemberAccounts(accounts, appId, [person]);
    expect(accounts[id]).toMatchObject({ enabled: true, siteMember: true });
    expect(accounts[local.id].role).toBe('site_member');
  });
  it('视图不完整时不能按缺行撤销自动权限或已核人员链接',()=>{
    const accounts:Record<string,StoredAccount>={ [local.id]:{...local} };
    reconcileSiteMemberAccounts(accounts,appId,[person]); const before=JSON.stringify(accounts);
    (reconcileSiteMemberAccounts as (...args:unknown[])=>unknown)(accounts,appId,[],false);
    expect(JSON.stringify(accounts)).toBe(before);
  });
});
