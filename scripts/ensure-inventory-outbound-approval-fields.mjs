import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_OPENAPI_BASE_URL = 'https://open.feishu.cn/open-apis';
const OPENAPI_TIMEOUT_MS = 15_000;
const MAX_OPENAPI_PAGES = 100;
const MAX_READ_ATTEMPTS = 3;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'TimeoutError',
]);
const REQUIRED_FIELDS = [
  select('出库工作流状态', [
    '待路由',
    '待审批',
    '已通过',
    '已驳回',
    '同步异常',
  ]),
  user('出库当前审批人', true),
  user('出库实际审批人', false),
  datetime('出库审批时间'),
  text('出库审批策略版本'),
  text('出库驳回原因'),
  text('出库审批动作标识'),
  text('出库工作流错误'),
  text('出库审批快照'),
  text('出库审批投递台账'),
  select('出库审批收尾状态', ['待收尾', '已完成']),
  text('出库审批结果投递台账'),
];

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const explicitDryRun = args.includes('--dry-run');
const requireReady = args.includes('--require-ready');
const sourceUrl = firstEnv('FEISHU_WAREHOUSE_SOURCE_URL');
const tableId = firstEnv('FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID');
let baseToken = '';
let tenantAccessToken = '';

async function main() {
  const fieldListFile = readOption('--field-list-file');

  if (apply && explicitDryRun) {
    fail('--apply 与 --dry-run 不能同时使用');
  }
  if (apply && requireReady) {
    fail('--apply 不能与 --require-ready 同时使用');
  }
  if (apply && fieldListFile) {
    fail('--apply 不能与 --field-list-file 同时使用');
  }

  baseToken =
    firstEnv('FEISHU_WAREHOUSE_APP_TOKEN') || extractBaseToken(sourceUrl);

  if (!fieldListFile && !baseToken) {
    baseToken = await resolveWikiBaseToken(sourceUrl);
  }
  if (!tableId) {
    fail('缺少 FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID，不能检查出库审批字段');
  }
  if (!fieldListFile && !baseToken) {
    fail(
      '缺少 FEISHU_WAREHOUSE_APP_TOKEN 或可解析的 FEISHU_WAREHOUSE_SOURCE_URL',
    );
  }

  const rawFields = fieldListFile
    ? JSON.parse(await readFile(fieldListFile, 'utf8'))
    : await listFields(baseToken, tableId);
  const currentByName = new Map(
    extractFields(rawFields)
      .map((field) => [fieldName(field), field])
      .filter(([name]) => Boolean(name)),
  );
  const existing = [];
  const missing = [];

  for (const required of REQUIRED_FIELDS) {
    const current = currentByName.get(required.name);
    if (!current) {
      missing.push(required);
      continue;
    }
    if (!isExpectedField(current, required)) {
      fail(
        `字段“${required.name}”已存在，但类型或配置不符`,
        'OUTBOUND_PREFLIGHT_SCHEMA',
      );
    }
    existing.push(required.name);
  }

  if (requireReady && missing.length > 0) {
    fail(
      `缺少出库审批工作流字段：${missing.map((field) => field.name).join('、')}`,
      'OUTBOUND_PREFLIGHT_SCHEMA',
    );
  }

  const created = [];
  if (apply) {
    for (const field of missing) {
      await createField(baseToken, tableId, field);
      created.push(field.name);
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      success: true,
      dryRun: !apply,
      tableId,
      existing,
      created,
      missing: apply ? [] : missing.map((field) => field.name),
    })}\n`,
  );
}

function text(name) {
  return {
    name,
    kind: 'text',
    multiple: false,
    payload: { field_name: name, type: 1 },
  };
}

function datetime(name) {
  return {
    name,
    kind: 'datetime',
    multiple: false,
    payload: {
      field_name: name,
      type: 5,
      property: { date_formatter: 'yyyy-MM-dd HH:mm' },
    },
  };
}

function user(name, multiple) {
  return {
    name,
    kind: 'user',
    multiple,
    payload: {
      field_name: name,
      type: 11,
      property: { multiple },
    },
  };
}

function select(name, options) {
  return {
    name,
    kind: 'select',
    multiple: false,
    options,
    payload: {
      field_name: name,
      type: 3,
      property: {
        options: options.map((option) => ({ name: option })),
      },
    },
  };
}

async function listFields(token, targetTableId) {
  const items = [];
  const seenPageTokens = new Set();
  let pageToken = '';

  for (let page = 0; page < MAX_OPENAPI_PAGES; page += 1) {
    const query = new URLSearchParams({ page_size: '200' });
    if (pageToken) query.set('page_token', pageToken);
    const payload = await requestOpenApi(
      '读取出库审批工作流字段',
      `/bitable/v1/apps/${encodeURIComponent(token)}/tables/${encodeURIComponent(
        targetTableId,
      )}/fields?${query}`,
    );
    const data = payload?.data;
    if (Array.isArray(data?.items)) items.push(...data.items);
    if (!data?.has_more) return { data: { items } };

    const nextPageToken = String(data?.page_token || '').trim();
    if (!nextPageToken || seenPageTokens.has(nextPageToken)) {
      fail('飞书字段分页返回了空或重复的 page_token，已拒绝继续');
    }
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  fail('飞书字段分页超过安全页数限制，已拒绝继续');
}

async function createField(token, targetTableId, field) {
  await requestOpenApi(
    `创建出库审批工作流字段：${field.name}`,
    `/bitable/v1/apps/${encodeURIComponent(token)}/tables/${encodeURIComponent(
      targetTableId,
    )}/fields`,
    { method: 'POST', body: field.payload },
  );
}

async function resolveWikiBaseToken(url) {
  if (!url) return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail('FEISHU_WAREHOUSE_SOURCE_URL 无效');
  }
  const match = parsed.pathname.match(/\/wiki\/([^/]+)/u);
  if (!match?.[1]) return '';
  const query = new URLSearchParams({ token: match[1], obj_type: 'wiki' });
  const payload = await requestOpenApi(
    '解析库房管理多维表',
    `/wiki/v2/spaces/get_node?${query}`,
  );
  return String(
    payload?.data?.node?.obj_token || payload?.data?.obj_token || '',
  ).trim();
}

async function requestOpenApi(operation, path, options = {}) {
  const authenticated = options.authenticated !== false;
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (authenticated) {
    headers.Authorization = `Bearer ${await getTenantAccessToken()}`;
  }

  // Auth is credential-only. Never replay a field-creation POST.
  const readonly =
    !apply && ((options.method || 'GET') === 'GET' || !authenticated);
  const attempts = readonly ? MAX_READ_ATTEMPTS : 1;
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    let payload;
    let failure;
    try {
      response = await fetch(`${openApiBaseUrl()}${path}`, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(OPENAPI_TIMEOUT_MS),
      });
      // Body reads are under the same timeout and network classification.
      payload = await response.json();
    } catch (error) {
      if (error instanceof FieldGateError) throw error;
      const cause = String(
        error?.cause?.code ||
          (error?.name === 'TimeoutError' ? error.name : error?.code) ||
          error?.name ||
          'unknown',
      );
      failure = {
        kind: 'OUTBOUND_PREFLIGHT_NETWORK',
        transient: TRANSIENT_NETWORK_CODES.has(cause),
        detail: `cause=${/^[A-Za-z0-9_]{1,64}$/u.test(cause) ? cause : 'unknown'}`,
      };
      if (error instanceof SyntaxError) {
        failure = TRANSIENT_HTTP_STATUSES.has(response?.status)
          ? {
              kind: 'OUTBOUND_PREFLIGHT_HTTP',
              transient: true,
              detail: `http=${response.status}, invalid-json`,
            }
          : {
              kind: 'OUTBOUND_PREFLIGHT_RESPONSE',
              transient: false,
              detail: `http=${response?.status || 'unknown'}, invalid-json`,
            };
      }
    }
    if (
      !failure &&
      response.ok &&
      (payload?.code === undefined || payload.code === 0)
    )
      return payload;
    if (!failure) {
      const code = Number.isFinite(Number(payload?.code))
        ? Number(payload.code)
        : response.status;
      failure = {
        kind: 'OUTBOUND_PREFLIGHT_HTTP',
        transient:
          TRANSIENT_HTTP_STATUSES.has(response.status) || code === 99991400,
        detail: `http=${response.status}, code=${code}, msg=${safeMessage(payload?.msg || payload?.message || 'unknown').slice(0, 160)}`,
      };
    }
    const detail = `${operation} (${failure.detail}, attempt=${attempt}/${attempts}, elapsedMs=${Date.now() - startedAt})`;
    const resetHeader =
      response?.headers.get('x-ogw-ratelimit-reset') ||
      response?.headers.get('retry-after');
    const reset =
      resetHeader && /^\d+(?:\.\d+)?$/u.test(resetHeader.trim())
        ? Number(resetHeader) * 1000
        : resetHeader
          ? Date.parse(resetHeader) - Date.now()
          : 0;
    const waitMs = !Number.isFinite(reset)
      ? Infinity
      : Math.max(attempt * 500, Math.ceil(reset));
    // A long rate-limit window is a preflight rejection, not a tight retry loop.
    if (!failure.transient || attempt === attempts || waitMs > 5000) {
      fail(
        `飞书 OpenAPI 检查失败：${detail}${waitMs > 5000 ? ', retry window exceeds short preflight budget' : ''}`,
        failure.kind,
      );
    }
    process.stderr.write(
      `[WARN] outbound read-only retry ${detail}, waitMs=${waitMs}\n`,
    );
    await delay(waitMs);
  }
}

async function getTenantAccessToken() {
  if (tenantAccessToken) return tenantAccessToken;
  const appId = firstEnv('FEISHU_APP_ID');
  const appSecret = firstEnv('FEISHU_APP_SECRET');
  if (!appId || !appSecret) {
    fail('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET，无法检查出库审批字段');
  }
  const payload = await requestOpenApi(
    '获取 tenant_access_token',
    '/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      body: { app_id: appId, app_secret: appSecret },
      authenticated: false,
    },
  );
  tenantAccessToken = String(
    payload?.tenant_access_token || payload?.data?.tenant_access_token || '',
  ).trim();
  if (!tenantAccessToken) {
    fail('飞书 OpenAPI 鉴权响应缺少 tenant_access_token');
  }
  return tenantAccessToken;
}

function isExpectedField(field, expected) {
  const actualType = normalizeType(field?.type);
  if (actualType !== expected.kind) return false;
  const actualMultiple = Boolean(
    field?.multiple ?? field?.property?.multiple ?? false,
  );
  if (actualMultiple !== expected.multiple) return false;
  if (expected.kind !== 'select') return true;

  const actualOptions = extractOptions(field);
  return (
    actualOptions.size === expected.options.length &&
    expected.options.every((option) => actualOptions.has(option))
  );
}

function normalizeType(type) {
  if (typeof type === 'string') return type.trim().toLowerCase();
  if (type === 1) return 'text';
  if (type === 3) return 'select';
  if (type === 5) return 'datetime';
  if (type === 11) return 'user';
  return '';
}

function extractOptions(field) {
  const options = Array.isArray(field?.options)
    ? field.options
    : Array.isArray(field?.property?.options)
      ? field.property.options
      : [];
  return new Set(
    options
      .map((option) =>
        typeof option === 'string'
          ? option.trim()
          : String(option?.name || '').trim(),
      )
      .filter(Boolean),
  );
}

function extractFields(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['items', 'fields', 'data']) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    const nested = extractFields(candidate);
    if (nested.length > 0) return nested;
  }
  return [];
}

function fieldName(field) {
  return field && typeof field === 'object'
    ? String(field.name || field.field_name || '').trim()
    : '';
}

function extractBaseToken(url) {
  if (!url) return '';
  try {
    const match = new URL(url).pathname.match(/\/base\/([^/]+)/u);
    return match?.[1]?.trim() || '';
  } catch {
    fail('FEISHU_WAREHOUSE_SOURCE_URL 无效');
  }
}

function openApiBaseUrl() {
  const configured =
    firstEnv('LARK_OPENAPI_BASE_URL') || DEFAULT_OPENAPI_BASE_URL;
  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    fail('LARK_OPENAPI_BASE_URL 无效');
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
    parsed.hostname.toLowerCase(),
  );
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
  ) {
    fail('LARK_OPENAPI_BASE_URL 必须是 HTTPS 地址或本机回环测试地址');
  }
  return configured.replace(/\/+$/u, '');
}

function readOption(name) {
  const index = args.indexOf(name);
  if (index < 0) return '';
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} 缺少参数`);
  return value;
}

function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return '';
}

function safeMessage(message) {
  let text = String(message).replace(/[\u0000-\u001f\u007f]+/gu, ' ');
  const privateValues = [
    tenantAccessToken,
    baseToken,
    tableId,
    ...Object.entries(process.env)
      .filter(([key]) =>
        /SECRET|TOKEN|PASSWORD|ENCRYPT|APP_ID|SOURCE_URL|TABLE_ID/u.test(key),
      )
      .map(([, value]) => value),
  ]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const value of privateValues)
    text = text.split(value).join('[REDACTED]');
  return text;
}

class FieldGateError extends Error {}

function fail(message, kind = 'OUTBOUND_PREFLIGHT_CONFIG') {
  throw new FieldGateError(`[${kind}] ${safeMessage(message)}`);
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof FieldGateError
      ? error.message
      : '[OUTBOUND_PREFLIGHT_INTERNAL] 出库字段检查发生异常';
  process.stderr.write(`${message}\n`);
  // Let Node flush UTF-8 stderr and close its HTTP handles normally.
  process.exitCode = 1;
}
