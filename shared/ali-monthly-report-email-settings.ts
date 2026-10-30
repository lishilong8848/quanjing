import type { AliMonthlyReportConfigResponse } from './api.interface';

export interface AliMonthlyReportEmailSettings {
  senderEmail: string;
  authCodeConfigured: boolean;
  source: 'page' | 'server';
  revision: string;
  updatedAt: string | null;
  canSave: boolean;
  issue?: string;
}

export interface SaveAliMonthlyReportEmailSettings {
  senderEmail: string;
  /** Omit to preserve the current code; replacing the sender requires a code. */
  authCode?: string;
  expectedRevision: string;
  clientMutationId: string;
}

export interface SaveAliMonthlyReportEmailSettingsResponse {
  success: true;
  settings: AliMonthlyReportEmailSettings;
  config: AliMonthlyReportConfigResponse;
}

export function validMonthlyReportSender(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value);
}

export function validMonthlyReportAuthCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9]{16}$/.test(value);
}
