export const SITE_MEMBER_BACKUP_ACCOUNT_ID = 'local-site_member-all';
export const SITE_MEMBER_BACKUP_NAME = '基地备用';
export const SITE_MEMBER_BACKUP_PASSWORD_HASH_ENV = 'LOCAL_SITE_MEMBER_PASSWORD_HASH';

export function isSiteMemberSessionAccountId(value: unknown): value is string {
  return typeof value === 'string' && (value === SITE_MEMBER_BACKUP_ACCOUNT_ID || /^(?:feishu-|local-external-)[a-f0-9]{64}$/.test(value));
}
