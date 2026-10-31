import { getCurrentCsrfToken } from './csrf-token';
import { EMPLOYEE_ONBOARDING_PHOTO_FILE_RULE } from '@shared/employee-onboarding';

const PRIVATE_PATHS = new Set([
  '/api/access/personal/profile', '/api/access/personal/archive', '/api/access/personal/archive/photo',
  '/api/access/personal/password/change', '/api/access/personal/password/reset',
  '/api/access/personal/permission-requests', '/api/access/personal/permission-requests/update',
  '/api/access/personal/permission-requests/cancel', '/api/access/personal/permission-requests/summary',
  '/api/access/configuration/permission-requests', '/api/access/configuration/permission-requests/summary',
  '/api/access/personal/archive-corrections', '/api/access/personal/archive-corrections/cancel',
  '/api/access/personal/archive-corrections/summary', '/api/access/configuration/archive-corrections',
  '/api/access/configuration/archive-corrections/summary',
] as const);
type PersonalPrivatePath = typeof PRIVATE_PATHS extends Set<infer Path> ? Path : never;
const MAX_PHOTO_BYTES = EMPLOYEE_ONBOARDING_PHOTO_FILE_RULE.maxBytesPerFile;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const PASSWORD_UNCERTAIN = '密码更新结果未确认，可能已更新，请尝试新密码登录；也可保留当前内容，使用原请求重试。';
const PASSWORD_ALREADY_UPDATED = '上次密码已更新，请使用上次设置的新密码重新登录后再修改';
const PASSWORD_PENDING_MESSAGES = new Set([
  '上次密码处理结果待核对，请使用原请求重试',
  '密码正在处理，请稍后使用原请求重试',
  '密码安全状态正在恢复，请稍后重试',
]);
const SAFE_MESSAGES = new Set([
  '当前密码不正确', '请输入当前密码', '两次输入的新密码不一致', '两次密码不一致', '新密码需为 8 至 128 个字符',
  '新密码不能与当前密码或身份证号码相同', '人员身份核验未通过，暂不能重置密码', '当前账号不可修改人员密码',
  '账号状态已变化，请重新登录', '请先登录个人账号', '代登录时不能修改密码', '请先退出代登录', '请先修改初始密码',
  '密码请求格式无效', '请从本站页面提交', '原请求标识已用于不同内容或已结束，请重新提交', '原请求标识已用于不同内容，请重新提交',
  '密码来源已变化，请核对后使用新请求重新提交', '上次密码处理结果待核对，请使用原请求重试',
  '密码已再次变更，请使用当前密码重新登录', '密码来源已变化，请核对后重新提交',
  '尝试次数较多，请稍后重试', '密码服务繁忙，请稍后重试', '个人档案暂不可用，请稍后重试',
  '个人档案未匹配，请联系管理员核对', '个人档案数据源与登录身份不一致',
  '个人档案关联已变化，请联系管理员核对', '个人档案在职状态尚未确认，请联系管理员核对',
  '登录账号未唯一匹配到人员，请联系管理员核对', '登录姓名与人员资料不一致，请重新登录后重试',
  '个人档案资料暂不可用，请稍后重试',
  '申请记录已变化，请刷新后重试', '申请已处理，不能撤回', '仅待审核申请可以修改',
  '仅待审核申请可以撤回', '申请权限尚未生效', '请填写申请理由', '请填写核对说明',
  '权限申请变更内容无效', '只能变更本人的权限申请', '此申请已变化或已处理，请刷新后重试',
  '权限申请内容无效，请重新选择真实页面、功能及范围', '所申请的权限已经具备，无需重复申请',
  '已有较多待处理申请，请等待管理员审核', '权限审核内容无效', '权限申请不存在',
  '不能审核本人或关联账号的权限申请', '此申请已被处理，请刷新后查看结果',
  '申请人的账号身份已变化，请重新提交申请', '申请权限尚未全部生效，请先在现有权限配置中保存并核对范围，再确认已授权',
  '代登录期间不能提交或审核权限申请', '请先修改初始密码，再办理权限申请', '登录权限已变化，请重新登录',
  '仅系统管理员可以审核权限申请', '此账号当前不能申请或办理个人权限，请管理员核对在职及启用状态',
  '此账号当前不可用，请管理员核对在职及启用状态', '申请对应账号不存在，请管理员核对人员身份',
  '权限配置已变化，请重新核对', '重复提交内容不一致，请重新发起', '申请理由需填写1至500字', '审核说明需填写1至500字',
  '申请权限与现有禁止规则冲突，请先在权限配置中调整后重试',
  '此申请已完成授权，不能拒绝或撤回，请刷新后查看结果',
  '管理员通知暂未登记，请保留申请并重试',
  '申请权限与现有禁止规则或查看范围冲突，请先在权限配置中调整后重试',
  '权限申请授权回执无法核验，请联系管理员，现有权限已保留',
  '个人权限规则已达上限，请先在权限配置中整理后重试',
  '权限申请内容无法核验，请刷新后重试',
  '未找到可接收通知的飞书管理员，申请已保留，请联系管理员核对',
  '资料纠错内容无效', '已有较多待处理纠错，请等待管理员处理或撤回不再需要的申请', '只能撤回本人的资料纠错',
  '资料纠错处理决定无效', '不能处理本人或关联账号的资料纠错', '代登录期间不能办理资料纠错',
  '仅系统管理员可以处理资料纠错', '账号当前不可办理资料纠错', '当前账号尚未关联本人档案，请联系管理员',
  '纠错描述和处理说明需填写1至1000字', '请勿填写完整身份证号，请仅说明需要核对的资料',
  '资料纠错请求无效', '资料纠错不存在', '资料纠错已变化或已处理，请刷新后重试',
]);

class PersonalPrivateError extends Error {
  constructor(message: string, readonly status?: number, readonly uncertain = false,
    readonly passwordRecovery?: PersonalPasswordRecovery) { super(message); }
}
export type PersonalPasswordRecovery = 'retry' | 'login';

/** Sensitive bodies and archive results must not pass through the SDK's Axios telemetry hooks. */
export async function personalPrivateRequest<T>(path: PersonalPrivatePath, options: {
  body?: unknown; signal?: AbortSignal; photo?: boolean;
} = {}): Promise<T> {
  const password = path.includes('/password/');
  const archive = path === '/api/access/personal/archive' || path === '/api/access/personal/archive/photo';
  const write = options.body !== undefined;
  const genericFailure = archive ? '个人档案读取失败，请重试' : write ? '提交结果未确认，请保留当前内容并使用原请求重试' : '读取失败，请重试';
  const url = privateUrl(path);
  const controller = new AbortController();
  if (options.signal?.aborted) throw new PersonalPrivateError('读取已取消');
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timeout = globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, password || archive ? 60_000 : 15_000);
  try {
    const csrf = getCurrentCsrfToken();
    const response = await fetch(url, { method: options.body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: controller.signal,
      headers: { Accept: options.photo ? 'image/png, image/jpeg, image/webp' : 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(csrf ? { 'X-Suda-Csrf-Token': csrf } : {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok) {
      if (options.photo) throw new PersonalPrivateError('个人照片读取失败，请重试', response.status);
      // CSRF middleware returns fixed plain text, while application errors return JSON.
      // Parse once and never attach the raw response to a public error.
      const text = await response.text().catch(() => '');
      let data: unknown = text;
      try { data = JSON.parse(text); } catch { /* Fixed text is checked below. */ }
      throw failureForStatus(response.status, password, data, genericFailure);
    }
    if (options.photo) {
      const type = (response.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
      const length = Number(response.headers.get('content-length') || 0);
      if (response.status !== 200 || !IMAGE_TYPES.includes(type) || length > MAX_PHOTO_BYTES) { controller.abort(); throw new PersonalPrivateError('个人照片读取失败，请重试'); }
      const photo = await response.blob();
      if (controller.signal.aborted) throw new PersonalPrivateError(options.signal?.aborted ? '读取已取消' : '个人照片读取失败，请重试', timedOut ? 408 : undefined);
      if (!(photo instanceof Blob) || photo.size === 0 || photo.size > MAX_PHOTO_BYTES || !IMAGE_TYPES.includes(photo.type.toLowerCase().split(';')[0].trim())) throw new PersonalPrivateError('个人照片读取失败，请重试');
      return photo as T;
    }
    const data: unknown = await response.json().catch(() => null);
    if (controller.signal.aborted) throw new PersonalPrivateError(password ? PASSWORD_UNCERTAIN : timedOut ? '读取超时，请重试' : '读取已取消', timedOut ? 408 : undefined, password);
    if (password && (!data || typeof data !== 'object' || Array.isArray(data) || (data as { success?: unknown }).success !== true)) throw new PersonalPrivateError(PASSWORD_UNCERTAIN, undefined, true);
    if (!password && (!data || typeof data !== 'object' || archive && Array.isArray(data))) throw new PersonalPrivateError(genericFailure);
    const list = !write && (path.endsWith('/permission-requests') || path.endsWith('/archive-corrections'));
    if (list && !Array.isArray(data) || !list && !password && Array.isArray(data)) throw new PersonalPrivateError(genericFailure);
    return data as T;
  } catch (failure) {
    if (failure instanceof PersonalPrivateError) throw failure;
    if (password) throw new PersonalPrivateError(PASSWORD_UNCERTAIN, timedOut ? 408 : undefined, true);
    if (options.signal?.aborted) throw new PersonalPrivateError('读取已取消');
    throw new PersonalPrivateError(options.photo ? '个人照片读取失败，请重试' : timedOut && !write ? archive ? '个人档案读取超时，请重试' : '读取超时，请重试' : genericFailure, timedOut ? 408 : undefined, write);
  } finally {
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
  }
}

function privateUrl(path: PersonalPrivatePath): string {
  if (!PRIVATE_PATHS.has(path)) throw new PersonalPrivateError('个人服务地址配置无效，请联系管理员');
  const raw = String(process.env.CLIENT_BASE_PATH || '').trim().replace(/^\/+|\/+$/g, '');
  if (!raw) return path;
  try {
    if (raw.split('/').some(segment => { const decoded = decodeURIComponent(segment); return !decoded || decoded === '.' || decoded === '..' || /[\\/?:#\u0000-\u0020]/.test(decoded); })) throw new Error('invalid');
  } catch { throw new PersonalPrivateError('个人服务地址配置无效，请联系管理员'); }
  return `/${raw}${path}`;
}

function failureForStatus(status: number, password: boolean, body: unknown, genericFailure: string): PersonalPrivateError {
  if (password && (status === 401 || status === 408 || status >= 500)) return new PersonalPrivateError(PASSWORD_UNCERTAIN, status, true, status === 401 ? 'login' : 'retry');
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? (body as { message?: unknown }).message : undefined;
  if (password && status === 409 && typeof raw === 'string') {
    if (raw === PASSWORD_ALREADY_UPDATED) return new PersonalPrivateError(raw, status, false, 'login');
    if (PASSWORD_PENDING_MESSAGES.has(raw)) return new PersonalPrivateError(raw, status, true, 'retry');
  }
  // Only known application messages may leave this boundary; never preserve the raw response or a fetch/SDK error object.
  if (typeof raw === 'string' && SAFE_MESSAGES.has(raw)) return new PersonalPrivateError(raw, status);
  const csrfMessages = ['Invalid CSRF token', 'Missing CSRF token', 'CSRF token mismatch', 'Invalid CSRF token.',
    'Forbidden，csrf token header must be singular.', 'Forbidden，csrf token not found or invalid in cookie.',
    'Forbidden，csrf token not found or invalid in header.', 'Forbidden，csrf token not match.'];
  if (status === 403 && (typeof raw === 'string' && csrfMessages.includes(raw) || typeof body === 'string' && csrfMessages.includes(body.trim()))) return new PersonalPrivateError('登录页面已过期，请刷新页面后重试。', status);
  if (status === 401) return new PersonalPrivateError('登录状态已变化，请重新登录后重试', status);
  if (status === 403) return new PersonalPrivateError('当前操作未通过身份校验，请重新登录后重试', status);
  if (status === 409) return new PersonalPrivateError('处理状态已变化，请保留当前内容并重新核对', status);
  if (status === 429) return new PersonalPrivateError('尝试次数较多，请稍后重试', status);
  return new PersonalPrivateError(password ? '密码请求未通过校验，请核对后重试' : genericFailure, status, status === 408 || status >= 500);
}
