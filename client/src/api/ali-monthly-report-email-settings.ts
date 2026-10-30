import type { AliMonthlyReportEmailSettings, SaveAliMonthlyReportEmailSettings, SaveAliMonthlyReportEmailSettingsResponse } from '@shared/ali-monthly-report-email-settings';
import { getCurrentCsrfToken } from './csrf-token';

export class MonthlyEmailSettingsError extends Error {
  constructor(message: string, readonly status?: number, readonly uncertain = false, readonly cancelled = false) { super(message); }
}

const UNCERTAIN = '保存结果暂未确认，请保留当前内容，使用原请求重试。';
const PATH = '/api/ali-monthly-report/email-settings';

function endpoint(): string {
  const base = String(process.env.CLIENT_BASE_PATH || '').trim().replace(/^\/+|\/+$/g, '');
  try {
    if (base && base.split('/').some(part => { const decoded = decodeURIComponent(part); return !decoded || decoded === '.' || decoded === '..' || /[\\/?:#\u0000-\u0020]/.test(decoded); })) throw new Error();
  } catch { throw new MonthlyEmailSettingsError('邮箱配置地址无效，请联系管理员'); }
  return base ? `/${base}${PATH}` : PATH;
}

function settingsValue(value: unknown): value is AliMonthlyReportEmailSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<AliMonthlyReportEmailSettings>;
  return typeof row.senderEmail === 'string' && typeof row.authCodeConfigured === 'boolean' &&
    (row.source === 'page' || row.source === 'server') && typeof row.revision === 'string' && !!row.revision &&
    typeof row.canSave === 'boolean' && (row.updatedAt === null || typeof row.updatedAt === 'string');
}

function safeSettings(value: AliMonthlyReportEmailSettings): AliMonthlyReportEmailSettings {
  // A response can never put an authorization code or an arbitrary issue message into component state.
  return { senderEmail: value.senderEmail, authCodeConfigured: value.authCodeConfigured, source: value.source,
    revision: value.revision, updatedAt: value.updatedAt, canSave: value.canSave };
}

async function request(body?: SaveAliMonthlyReportEmailSettings, signal?: AbortSignal): Promise<AliMonthlyReportEmailSettings | SaveAliMonthlyReportEmailSettingsResponse> {
  if (signal?.aborted) throw new MonthlyEmailSettingsError('读取已取消', undefined, false, true);
  const url = endpoint(), controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
  try {
    const csrf = getCurrentCsrfToken();
    const response = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-Suda-Csrf-Token': csrf } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 403) throw new MonthlyEmailSettingsError('登录或管理权限已变化，请刷新页面确认后重试。', status);
      if (status === 409) throw new MonthlyEmailSettingsError('配置已被其他管理员更新，请读取最新配置后核对；当前输入已保留。', status);
      if (body && (status === 408 || status >= 500)) throw new MonthlyEmailSettingsError(UNCERTAIN, status, true);
      if (status === 429) throw new MonthlyEmailSettingsError('操作较频繁，请稍后重试。', status);
      throw new MonthlyEmailSettingsError(body ? '邮箱配置未保存，请检查邮箱与授权码后重试。' : '邮箱配置读取失败，请重试。', status);
    }
    const value: unknown = await response.json();
    if (controller.signal.aborted) throw new MonthlyEmailSettingsError(body ? UNCERTAIN : '邮箱配置读取超时，请重试。', timedOut ? 408 : undefined, !!body, !!signal?.aborted);
    if (!body) {
      if (!settingsValue(value)) throw new MonthlyEmailSettingsError('邮箱配置读取失败，请重试。');
      return safeSettings(value);
    }
    const result = value as Partial<SaveAliMonthlyReportEmailSettingsResponse> | null;
    if (!result || result.success !== true || !settingsValue(result.settings) || !result.config ||
      !Array.isArray(result.config.reportTypes) || !Array.isArray(result.config.missingConfigKeys) || typeof result.config.emailReady !== 'boolean') {
      throw new MonthlyEmailSettingsError(UNCERTAIN, undefined, true);
    }
    return { success: true, settings: safeSettings(result.settings), config: result.config };
  } catch (error) {
    if (error instanceof MonthlyEmailSettingsError) throw error;
    throw new MonthlyEmailSettingsError(body ? UNCERTAIN : signal?.aborted ? '读取已取消' : timedOut ? '邮箱配置读取超时，请重试。' : '邮箱配置读取失败，请重试。',
      timedOut ? 408 : undefined, !!body, !!signal?.aborted);
  } finally {
    globalThis.clearTimeout(timer); signal?.removeEventListener('abort', cancel);
  }
}

export const getAliMonthlyReportEmailSettings = (signal?: AbortSignal) => request(undefined, signal) as Promise<AliMonthlyReportEmailSettings>;
export const saveAliMonthlyReportEmailSettings = (body: SaveAliMonthlyReportEmailSettings, signal?: AbortSignal) => request(body, signal) as Promise<SaveAliMonthlyReportEmailSettingsResponse>;
