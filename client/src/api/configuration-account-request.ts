import type { AccessConfigurationResponse, AccountMutation } from '@shared/access-configuration.interface';
import { getCurrentCsrfToken } from './csrf-token';

const UNCERTAIN = '保存结果未确认，请保留当前草稿，使用原请求重试或刷新核对。';
const SAFE_MESSAGES = new Set([
  '角色或楼栋专业范围无效', '账号信息或密码无效，密码需为8至256字符', '个人页面读取配置无效',
  '角色绑定或个人例外无效', '外部人员只能使用飞书账号', '飞书 Open ID 无效', '飞书账号不能设置本地密码',
  '请选择已有本地共享入口或填写飞书身份', '基地成员仅适用于在职人员视图中的实名账号', '账号不存在，请刷新列表',
  '飞书授权已存在，请编辑已有账号', '账号稳定身份不能修改', '外部员工姓名、密码和在职状态请在人员表维护',
  '复职确认无效', '人员状态仍为离职，不能启用登录', '复职账号须由管理员明确确认恢复登录',
  '请核对在职状态后确认恢复登录', '管理员身份不能通过普通模板分配', '角色或楼栋范围无效',
  '此密码已用于其他共享入口，请使用不同密码', '启用共享入口时请设置新密码', '关联账号权限无效，未保存',
  '请求包含服务端不支持的字段，请确认页面与服务端版本一致后重试',
]);
const CSRF_MESSAGES = new Set([
  'Forbidden，csrf token header must be singular.', 'Forbidden，csrf token not found or invalid in cookie.',
  'Forbidden，csrf token not found or invalid in header.', 'Forbidden，csrf token not match.',
  'Invalid CSRF token', 'Missing CSRF token', 'CSRF token mismatch', 'Invalid CSRF token.',
]);
class AccountSaveError extends Error {
  constructor(message: string, readonly status?: number, readonly uncertain = false) { super(message); }
}
function saveUrl(): string {
  const base = String(process.env.CLIENT_BASE_PATH || '').trim().replace(/^\/+|\/+$/g, '');
  try {
    if (base && base.split('/').some(segment => {
      const decoded = decodeURIComponent(segment);
      return !decoded || decoded === '.' || decoded === '..' || /[\\/?:#\u0000-\u0020]/.test(decoded);
    })) throw new Error('invalid');
  } catch { throw new AccountSaveError('配置服务地址无效，请联系管理员'); }
  return `${base ? `/${base}` : ''}/api/access/configuration/accounts`;
}

/** Account passwords must never enter SDK request/response telemetry. Retry identity belongs to the editor. */
export async function saveConfigurationAccount(body: AccountMutation): Promise<AccessConfigurationResponse> {
  const url = saveUrl();
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 15_000);
  try {
    const csrf = getCurrentCsrfToken();
    const response = await fetch(url, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(csrf ? { 'X-Suda-Csrf-Token': csrf } : {}) },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = undefined; }
    if (controller.signal.aborted) throw new AccountSaveError(UNCERTAIN, 408, true);
    if (!response.ok) {
      const message = data && typeof data === 'object' && !Array.isArray(data) ? (data as { message?: unknown }).message : text.trim();
      if (response.status === 403 && typeof message === 'string' && CSRF_MESSAGES.has(message)) throw new AccountSaveError('页面已过期，请刷新页面后重试；当前草稿已保留。', 403);
      if (response.status === 408 || response.status >= 500) throw new AccountSaveError(UNCERTAIN, response.status, true);
      if (typeof message === 'string' && SAFE_MESSAGES.has(message)) throw new AccountSaveError(message, response.status);
      const safeMessage = response.status === 401 ? '管理权限已变化，请重新登录。' : response.status === 403 ? '当前账号无权修改此配置。' :
        response.status === 409 ? '配置已被更新，请保留草稿并刷新核对差异后重试。' : response.status === 429 ? '操作过于频繁，请稍后重试。' : '账号配置未通过校验，请核对后重试。';
      throw new AccountSaveError(safeMessage, response.status);
    }
    if (!isConfiguration(data) || data.revision < body.expectedRevision) throw new AccountSaveError(UNCERTAIN, response.status, true);
    return data;
  } catch (error) {
    if (error instanceof AccountSaveError) throw error;
    // Never attach fetch errors, response bodies, request options or passwords to errors.
    throw new AccountSaveError(UNCERTAIN, controller.signal.aborted ? 408 : undefined, true);
  } finally { globalThis.clearTimeout(timeout); }
}
function isConfiguration(value: unknown): value is AccessConfigurationResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Partial<AccessConfigurationResponse>;
  return Number.isSafeInteger(data.revision) && data.revision! >= 0 && typeof data.appId === 'string' &&
    Array.isArray(data.accounts) && data.accounts.every(account => account && typeof account.id === 'string' && typeof account.name === 'string' && typeof account.enabled === 'boolean') &&
    Array.isArray(data.cardRules) && Array.isArray(data.audit);
}
