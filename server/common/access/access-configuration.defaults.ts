import type { StoredAccount } from './access-configuration.store';
import type { ManagedAccessRole } from '../../../shared/access-configuration.interface';
import { BUILDING_ADMIN_BUILDINGS, PURCHASE_ACCESS_BUILDINGS } from '../../../shared/access-control.interface';
import { APPROVED_FEISHU_APP_ID, APPROVED_FEISHU_GRANTS, feishuIdentityFingerprint } from './feishu-access-approved-grants';
import { validAccessPasswordHash } from './access-password';
import { OPEN_ID_PATTERN } from './access-configuration.validation';
import { PROFESSIONAL_DEFAULTS } from './access-professional-defaults';
import { createHash } from 'node:crypto';
import { SITE_MEMBER_BACKUP_ACCOUNT_ID, SITE_MEMBER_BACKUP_NAME, SITE_MEMBER_BACKUP_PASSWORD_HASH_ENV } from '../../../shared/site-member-backup';

export function defaultAccessAccounts(): Record<string, StoredAccount> {
  const accounts: Record<string, StoredAccount> = {};
  const addLocal = (role: ManagedAccessRole, building: StoredAccount['building'], variable: string) => {
    const passwordHash = process.env[variable]?.trim() || '';
    const id = `local-${role}-${building === '110站' ? '110' : building?.[0] || 'all'}`;
    accounts[id] = { id, kind: 'local', name: `${building || ''}${roleName(role)}密码登录`, role, building,
      enabled: validAccessPasswordHash(passwordHash), deleted: false, version: 1, source: 'default', passwordHash };
  };
  for (const role of ['admin', 'editor', 'purchase_admin', 'construction_admin'] as const) addLocal(role, null, `LOCAL_${role.toUpperCase()}_PASSWORD_HASH`);
  addLocal('site_member', null, SITE_MEMBER_BACKUP_PASSWORD_HASH_ENV);
  const backup = accounts[SITE_MEMBER_BACKUP_ACCOUNT_ID];
  backup.name = SITE_MEMBER_BACKUP_NAME;
  // Rotating the environment hash must also invalidate existing backup sessions.
  backup.version = parseInt(createHash('sha256').update(backup.passwordHash || '').digest('hex').slice(0, 8), 16) + 1;
  for (const building of PURCHASE_ACCESS_BUILDINGS) {
    addLocal('inventory_admin', building, `LOCAL_INVENTORY_ADMIN_${building[0]}_PASSWORD_HASH`);
    addLocal('purchase_applicant', building, `LOCAL_PURCHASE_APPLICANT_${building[0]}_PASSWORD_HASH`);
  }
  for (const building of BUILDING_ADMIN_BUILDINGS) addLocal('building_admin', building, `LOCAL_BUILDING_ADMIN_${building === '110站' ? '110' : building[0]}_PASSWORD_HASH`);
  const appId = process.env.FEISHU_APP_ID?.trim() || '';
  if (!/^cli_[A-Za-z0-9_-]+$/.test(appId)) return accounts;
  if (appId === APPROVED_FEISHU_APP_ID && process.env.FEISHU_ACCESS_APPROVED_GRANTS_ENABLED?.trim() !== 'false') {
    for (const grant of APPROVED_FEISHU_GRANTS) {
      const id = `feishu-${grant.identityHash}`;
      accounts[id] = { id, kind: 'feishu', name: `飞书人员 ${grant.identityHash.slice(0, 8)}`, role: grant.role,
        building: grant.purchaseBuilding, enabled: true, deleted: false, version: 1, source: 'default', appId, identityHash: grant.identityHash };
    }
  }
  const addFeishu = (role: ManagedAccessRole, building: StoredAccount['building'], variable: string) => {
    for (const openId of (process.env[variable] || '').split(/[\s,;，；]+/).filter(Boolean)) {
      if (!OPEN_ID_PATTERN.test(openId)) throw new Error('飞书访问角色配置包含无效身份');
      const hash = feishuIdentityFingerprint(appId, openId), id = `feishu-${hash}`;
      // Existing approved transitions are already checked by FeishuAccessService.
      const prior = accounts[id];
      accounts[id] = { id, kind: 'feishu', name: prior?.name || `飞书人员 ${hash.slice(0, 8)}`, role: prior?.role || role,
        building: prior ? prior.building : building, enabled: true, deleted: false, version: 1, source: 'default', appId, openId, identityHash: hash };
    }
  };
  for (const role of ['admin','editor','purchase_admin','construction_admin','duty_editor','supply_chain_admin'] as const) addFeishu(role, null, `FEISHU_ACCESS_${role.toUpperCase()}_OPEN_IDS`);
  for (const building of PURCHASE_ACCESS_BUILDINGS) addFeishu('inventory_admin', building, `FEISHU_ACCESS_INVENTORY_ADMIN_${building[0]}_OPEN_IDS`);
  for (const building of BUILDING_ADMIN_BUILDINGS) addFeishu('building_admin', building, `FEISHU_ACCESS_BUILDING_ADMIN_${building === '110站' ? '110' : building[0]}_OPEN_IDS`);
  if (appId === APPROVED_FEISHU_APP_ID) for (const person of PROFESSIONAL_DEFAULTS) {
    const identityHash = feishuIdentityFingerprint(appId, person.openId), id = `feishu-${identityHash}`;
    accounts[id] = { id, kind: 'feishu', name: person.name, openId: person.openId, role: 'professional_admin', building: null,
      specialties: [...person.specialties], permissionSource: 'personnel', enabled: true, deleted: false, version: 1, source: 'default', appId, identityHash };
  }
  return accounts;
}
export function roleName(role: ManagedAccessRole): string {
  return ({ guest: '游客', site_member: '基地成员', professional_admin: '专业主管', professional_engineer: '专业工程师', admin: '管理员', editor: '子管理员', building_admin: '楼栋主管', inventory_admin: '库房管理员', purchase_admin: '采购与合同管理员',
    purchase_applicant: '采购申请人', construction_admin: '施工管理员', duty_editor: '值班编辑', supply_chain_admin: '采供存管理员' })[role];
}
