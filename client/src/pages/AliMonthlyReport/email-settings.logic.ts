import type { AccessSessionResponse } from '@shared/access-control.interface';
import type { AliMonthlyReportConfigResponse } from '@shared/api.interface';
import { validMonthlyReportAuthCode, validMonthlyReportSender, type AliMonthlyReportEmailSettings } from '@shared/ali-monthly-report-email-settings';

export function canManageMonthlyEmailSettings(access: Pick<AccessSessionResponse, 'role' | 'impersonation' | 'requiresPasswordChange'> & { isChangingIdentity?: boolean; isConfirmingIdentity?: boolean }): boolean {
  return access.role === 'admin' && !access.impersonation && !access.requiresPasswordChange && !access.isChangingIdentity && !access.isConfirmingIdentity;
}

export function monthlyEmailSettingsIdentity(access: AccessSessionResponse): string {
  return JSON.stringify([access.accountId || '', access.authorizationVersion ?? null, access.principalFingerprint || '', access.role,
    access.pagePermissionsRevision ?? null, access.impersonation?.actorAccountId || '', access.requiresPasswordChange === true]);
}

export function normalizedEmailDraft(senderEmail: string, authCode: string) {
  return { senderEmail: senderEmail.trim().toLowerCase(), authCode: authCode.replace(/\s/g, '') };
}

export function emailSettingsMutationId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
    : `monthly-email-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function monthlyReportEmailReady(config: Pick<AliMonthlyReportConfigResponse, 'emailReady' | 'missingEmailConfigKeys' | 'emailConfigurationIssue'>): boolean {
  return config.emailReady === true && !config.missingEmailConfigKeys?.length && !config.emailConfigurationIssue;
}

export function emailSettingsIssue(settings: AliMonthlyReportEmailSettings | null, sender: string, code: string): string | null {
  if (!settings) return '请先读取邮箱配置。';
  if (!settings.canSave) return '邮箱配置暂不能修改，请联系管理员核对。';
  const draft = normalizedEmailDraft(sender, code);
  if (!validMonthlyReportSender(draft.senderEmail)) return '请输入有效的发件邮箱地址。';
  if (!draft.authCode && (!settings.authCodeConfigured || draft.senderEmail !== settings.senderEmail.trim().toLowerCase())) return '首次配置或更换发件邮箱时，请填写授权码。';
  if (draft.authCode && !validMonthlyReportAuthCode(draft.authCode)) return '授权码应为 16 位字母或数字，可直接粘贴带空格的授权码。';
  return null;
}
