import type { ManagedAccount, AccountMutation } from '@shared/access-configuration.interface';
import type { PersonalPermissionRule } from '@shared/business-permissions';

export function optionalAccountPermissions(account: ManagedAccount | undefined, personalRules: PersonalPermissionRule[], pagePaths: string[]): Pick<AccountMutation, 'personalRules' | 'pagePaths'> {
  return {
    ...(JSON.stringify(account?.personalRules || []) === JSON.stringify(personalRules) ? {} : { personalRules }),
    ...(JSON.stringify([...(account?.pagePaths || [])].sort()) === JSON.stringify([...pagePaths].sort()) ? {} : { pagePaths }),
  };
}
export function accountRevisionError(revision: unknown, original: ManagedAccount | undefined, accounts: ManagedAccount[]): string {
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) return '配置版本无效，请刷新配置后重试';
  if (original && accounts.find(account => account.id === original.id)?.version !== original.version) return '该账号已发生变化，请关闭并重新打开后编辑；当前草稿未保存';
  return '';
}
