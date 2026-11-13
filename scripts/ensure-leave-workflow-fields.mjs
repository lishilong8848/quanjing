import { setTimeout as delay } from 'node:timers/promises';

const TABLE_ID = 'tblpCzmTT3EapaUY';
const SOURCE_URL =
  'https://vnet.feishu.cn/wiki/G7oUwGdwaiTmimk8i2ecGTWOn4d?table=tblpCzmTT3EapaUY&view=vewHyBE14E';
const DEFAULT_OPENAPI_BASE_URL = 'https://open.feishu.cn/open-apis';
const MAX_OPENAPI_PAGES = 100;
const OPENAPI_TIMEOUT_MS = 15_000;
const READ_CHECK_BUDGET_MS = 30_000;
const MAX_READ_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 5_000;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_FEISHU_CODES = new Set([1254290, 99991400]);
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'TimeoutError',
]);
const FIELD_GATE_PREFIX = 'LEAVE_PREFLIGHT';
const readDeadline = performance.now() + READ_CHECK_BUDGET_MS;
let openApiTenantAccessToken = '';
const REQUIRED_FIELDS = [
  select('审批来源', ['飞书工作流', '程序卡片']),
  select('请假工作流状态', [
    '待路由',
    '待主管审批',
    '待经理审批',
    '已审批',
    '已驳回',
    '同步异常',
  ]),
  user('请假当前审批人', true),
  user('请假实际审批人', true),
  datetime('请假审批时间'),
  text('请假审批策略版本'),
  text('请假工作流错误'),
  text('休假人员姓名（程序）'),
  text('请假驳回原因'),
  number('替班调整版本'),
  text('替班安排'),
  user('替班调整人', false),
  datetime('替班调整时间'),
];
const SHIFT_DETAIL_TABLE_NAME = '请假替班班次明细';
const SHIFT_DETAIL_FIELDS = [
  text('明细唯一ID'),
  text('请假记录ID'),
  text('班次键'),
  text('排班记录IDs'),
  datetime('班次日期'),
  datetime('开始时间'),
  datetime('结束时间'),
  text('班次'),
  text('楼栋'),
  text('班组'),
  text('替班人员记录ID'),
  text('替班人员姓名'),
  text('替班人员OpenID'),
  user('替班用户', false),
  number('替班安排版本'),
  select('状态', ['pending', 'active']),
  text('调整人OpenID'),
  text('调整人姓名'),
  datetime('调整时间'),
];

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const requireReady = args.includes('--require-ready');
const withShiftDetails = args.includes('--with-shift-details');
class FieldGateError extends Error {}

async function main() {
  const configuredTableId = firstEnv(
    'FEISHU_LEAVE_REQUEST_TABLE_ID',
    'FEISHU_LEAVE_SUBSTITUTE_TABLE_ID',
  );
  if (configuredTableId && configuredTableId !== TABLE_ID) {
    fail('请休假工作流字段迁移只允许目标请休假表');
  }
  const baseToken = firstEnv(
    'FEISHU_LEAVE_REQUEST_APP_TOKEN',
    'FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN',
    'FEISHU_MAIN_APP_TOKEN',
    'FEISHU_BITABLE_APP_TOKEN',
  );
  if (!baseToken) {
    fail('缺少请休假多维表 app token，不能检查程序审批字段');
  }

  const current = await listFields(baseToken, TABLE_ID, '读取请休假工作流字段');
  const currentByName = new Map(
    extractFields(current)
      .map((field) => [fieldName(field), field])
      .filter(([name]) => Boolean(name)),
  );
  const missing = [];
  for (const required of REQUIRED_FIELDS) {
    const field = currentByName.get(required.name);
    if (!field) {
      missing.push(required);
      continue;
    }
    if (!isExpectedField(field, required)) {
      fail(`字段“${required.name}”已存在，但类型或多选配置不兼容`, 'SCHEMA');
    }
  }

  if (requireReady && missing.length > 0) {
    fail(
      `缺少请休假程序审批字段：${missing.map((item) => item.name).join('、')}`,
      'SCHEMA',
    );
  }

  if (apply) {
    for (const field of missing) await createField(baseToken, TABLE_ID, field);
  }

  const shiftDetails = withShiftDetails
    ? await ensureShiftDetailSchema(baseToken)
    : undefined;

  process.stdout.write(
    `${JSON.stringify({
      success: true,
      dryRun: !apply,
      tableId: TABLE_ID,
      sourceUrl: SOURCE_URL,
      existing: REQUIRED_FIELDS.filter((item) =>
        currentByName.has(item.name),
      ).map((item) => item.name),
      created: apply ? missing.map((item) => item.name) : [],
      missing: apply ? [] : missing.map((item) => item.name),
      ...(shiftDetails ? { shiftDetails } : {}),
    })}\n`,
  );
}

function text(name) {
  return {
    name,
    type: 'text',
    multiple: false,
    json: { field_name: name, type: 1 },
  };
}

function datetime(name) {
  return {
    name,
    type: 'datetime',
    multiple: false,
    json: {
      field_name: name,
      type: 5,
      property: { date_formatter: 'yyyy-MM-dd HH:mm' },
    },
  };
}

function number(name) {
  return {
    name,
    type: 'number',
    multiple: false,
    json: { field_name: name, type: 2 },
  };
}

function user(name, multiple) {
  return {
    name,
    type: 'user',
    multiple,
    json: { field_name: name, type: 11, property: { multiple } },
  };
}

function select(name, options) {
  return {
    name,
    type: 'select',
    multiple: false,
    json: {
      field_name: name,
      type: 3,
      property: {
        options: options.map((option) => ({ name: option })),
      },
    },
  };
}

function relation(name, tableId, multiple) {
  return {
    name,
    type: 'relation',
    multiple,
    tableId,
    json: {
      field_name: name,
      type: 18,
      ui_type: 'SingleLink',
      property: {
        table_id: tableId,
        multiple,
      },
    },
  };
}

async function ensureShiftDetailSchema(token) {
  const dutyTableId = firstEnv(
    'FEISHU_SCHEDULE_TABLE_ID',
    'FEISHU_DUTY_TABLE_ID',
  );
  if (!dutyTableId) {
    fail('缺少排班表 ID，不能创建请假替班班次明细关联字段');
  }
  const tables = await listTables(token);
  const namedTables = tables.filter(
    (table) => tableName(table) === SHIFT_DETAIL_TABLE_NAME,
  );
  if (namedTables.length > 1) {
    fail(`多维表中存在重复表名“${SHIFT_DETAIL_TABLE_NAME}”`, 'SCHEMA');
  }
  const configuredDetailTableId = firstEnv(
    'FEISHU_LEAVE_SHIFT_DETAIL_TABLE_ID',
  );
  let detailTableId = namedTables[0] ? tableId(namedTables[0]) : '';
  if (
    configuredDetailTableId &&
    detailTableId &&
    configuredDetailTableId !== detailTableId
  ) {
    fail('请假替班班次明细表 ID 与同名表不一致');
  }
  if (!detailTableId) detailTableId = configuredDetailTableId;
  let tableCreated = false;
  if (!detailTableId) {
    if (requireReady) fail(`缺少多维表“${SHIFT_DETAIL_TABLE_NAME}”`, 'SCHEMA');
    if (!apply) {
      return {
        tableName: SHIFT_DETAIL_TABLE_NAME,
        tableId: '',
        tableCreated: false,
        tableMissing: true,
        existing: [],
        created: [],
        missing: [],
      };
    }
    detailTableId = await createTable(token);
    tableCreated = true;
  }
  const required = [
    ...SHIFT_DETAIL_FIELDS,
    relation('请假主记录', TABLE_ID, false),
    relation('排班记录', dutyTableId, true),
  ];
  const current = await listFields(
    token,
    detailTableId,
    '读取请假替班班次明细字段',
  );
  const currentByName = new Map(
    extractFields(current)
      .map((field) => [fieldName(field), field])
      .filter(([name]) => Boolean(name)),
  );
  const missing = [];
  for (const expected of required) {
    const field = currentByName.get(expected.name);
    if (!field) {
      missing.push(expected);
      continue;
    }
    if (!isExpectedField(field, expected)) {
      fail(`字段“${expected.name}”已存在，但类型或关联配置不兼容`, 'SCHEMA');
    }
  }
  if (requireReady && missing.length) {
    fail(
      `缺少请假替班班次明细字段：${missing.map((item) => item.name).join('、')}`, 'SCHEMA',
    );
  }
  if (apply) {
    for (const field of missing) {
      await createField(token, detailTableId, field);
    }
  }
  return {
    tableName: SHIFT_DETAIL_TABLE_NAME,
    tableId: detailTableId,
    tableCreated,
    tableMissing: false,
    existing: required
      .filter((item) => currentByName.has(item.name))
      .map((item) => item.name),
    created: apply ? missing.map((item) => item.name) : [],
    missing: apply ? [] : missing.map((item) => item.name),
  };
}

async function listTables(token) {
  const payload = await requestOpenApi(
    '读取多维表数据表列表',
    `/bitable/v1/apps/${encodeURIComponent(token)}/tables?page_size=100`,
  );
  return extractTables(payload);
}

async function createTable(token) {
  const payload = await requestOpenApi(
    `创建多维表：${SHIFT_DETAIL_TABLE_NAME}`,
    `/bitable/v1/apps/${encodeURIComponent(token)}/tables`,
    {
      method: 'POST',
      body: {
        table: {
          name: SHIFT_DETAIL_TABLE_NAME,
        },
      },
    },
  );
  const createdId = tableId(payload?.data?.table || payload?.data);
  if (!createdId) fail('创建请假替班班次明细表响应缺少 table_id');
  return createdId;
}

async function listFields(token, targetTableId, operation) {
  const items = [];
  const seenPageTokens = new Set();
  let pageToken = '';

  for (let page = 0; page < MAX_OPENAPI_PAGES; page += 1) {
    const query = new URLSearchParams({ page_size: '200' });
    if (pageToken) query.set('page_token', pageToken);
    const payload = await requestOpenApi(
      operation,
      `/bitable/v1/apps/${encodeURIComponent(token)}/tables/${encodeURIComponent(
        targetTableId,
      )}/fields?${query}`,
    );
    const data = payload?.data;
    if (!Array.isArray(data?.items)) fail(`飞书字段列表响应缺少 items：${operation}`, 'RESPONSE');
    items.push(...data.items);
    if (!data?.has_more) return { data: { items } };

    const nextPageToken = String(data?.page_token || '').trim();
    if (!nextPageToken || seenPageTokens.has(nextPageToken)) {
      fail('飞书字段分页返回了空或重复的 page_token，已拒绝继续', 'RESPONSE');
    }
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  fail('飞书字段分页超过安全页数限制，已拒绝继续', 'RESPONSE');
}

async function createField(token, targetTableId, field) {
  await requestOpenApi(
    `创建请休假工作流字段：${field.name}`,
    `/bitable/v1/apps/${encodeURIComponent(token)}/tables/${encodeURIComponent(
      targetTableId,
    )}/fields`,
    { method: 'POST', body: field.json },
  );
}

async function requestOpenApi(operation, path, options = {}) {
  const authenticated = options.authenticated !== false;
  const method = options.method || 'GET';
  const readonly = !apply && (method === 'GET' || !authenticated);
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (authenticated) {
    headers.Authorization = `Bearer ${await getOpenApiTenantAccessToken()}`;
  }

  const url = `${openApiBaseUrl()}${path}`;
  const attempts = readonly ? MAX_READ_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remaining = readonly ? Math.floor(readDeadline - performance.now()) : OPENAPI_TIMEOUT_MS;
    if (remaining <= 0) fail(`飞书只读检查达到总时限：${operation}`, 'NETWORK');
    let response;
    let payload;
    let failure;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(Math.min(remaining, OPENAPI_TIMEOUT_MS)),
      });
      payload = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        failure = response?.ok
          ? { kind: 'RESPONSE', detail: 'invalid-json', transient: false }
          : httpFailure(response);
      } else {
        const code = error?.cause?.code || error?.code || error?.name || '';
        const safeCode = /^[A-Za-z0-9_]{1,64}$/u.test(code) ? code : 'unknown';
        failure = { kind: 'NETWORK', detail: `cause=${safeCode}`, transient: TRANSIENT_NETWORK_CODES.has(safeCode) };
      }
    }
    if (!failure && response.ok && payload && payload.code === 0) return payload;
    if (!failure) failure = httpFailure(response, payload);

    const waitMs = retryDelay(response, attempt);
    const detail = `${operation}（${failure.detail}, attempt=${attempt}/${attempts}）`;
    if (!failure.transient || attempt === attempts || waitMs > MAX_RETRY_DELAY_MS || performance.now() + waitMs >= readDeadline) {
      if (apply && failure.kind === 'HTTP' && payload) {
        const message = safeApiMessage(payload.msg || payload.message || 'unknown');
        fail(`飞书 OpenAPI 拒绝请求：${operation}（code=${Number(payload.code) || 'unknown'}，msg=${message}）`, 'HTTP');
      }
      fail(`飞书 OpenAPI 检查失败：${detail}`, failure.kind);
    }
    process.stderr.write(`[WARN] [${FIELD_GATE_PREFIX}_${failure.kind}] 飞书只读检查重试：${detail}, waitMs=${waitMs}\n`);
    await delay(waitMs);
  }
}

function httpFailure(response, payload) {
  const status = response?.status || 'unknown';
  const apiCode = Number(payload?.code);
  const logId = response?.headers.get('x-tt-logid') || response?.headers.get('x-request-id') || '';
  const logDetail = /^[A-Za-z0-9_-]{8,80}$/u.test(logId) ? `, logId=${logId}` : '';
  const detail = `http=${status}, code=${Number.isSafeInteger(apiCode) ? apiCode : 'unknown'}${logDetail}`;
  if (response?.ok && !Number.isSafeInteger(apiCode)) {
    return { kind: 'RESPONSE', detail, transient: false };
  }
  // Monthly quota exhaustion is not a short-lived rate limit.
  const transient = apiCode !== 99991403 && (TRANSIENT_HTTP_STATUSES.has(status) || TRANSIENT_FEISHU_CODES.has(apiCode));
  return { kind: 'HTTP', detail, transient };
}

function retryDelay(response, attempt) {
  const header = (response?.headers.get('x-ogw-ratelimit-reset') || response?.headers.get('retry-after') || '').trim();
  const resetMs = !header ? 0 : /^\d+(?:\.\d+)?$/u.test(header)
    ? Number(header) * 1000
    : Date.parse(header) - Date.now();
  return Number.isFinite(resetMs) ? Math.max(attempt * 500, Math.ceil(resetMs)) : Infinity;
}

function safeApiMessage(value) {
  let message = String(value).replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
  const sensitive = [TABLE_ID, openApiTenantAccessToken, ...Object.entries(process.env)
    .filter(([key]) => /SECRET|TOKEN|PASSWORD|ENCRYPT|APP_ID|SOURCE_URL|TABLE_ID/u.test(key))
    .map(([, value]) => value?.trim())]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const value of sensitive) message = message.replaceAll(value, '[REDACTED]');
  return message.slice(0, 160);
}

async function getOpenApiTenantAccessToken() {
  if (openApiTenantAccessToken) return openApiTenantAccessToken;
  const appId = firstEnv('FEISHU_APP_ID');
  const appSecret = firstEnv('FEISHU_APP_SECRET');
  if (!appId || !appSecret) {
    fail('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET，无法检查请休假字段');
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
  const token = String(
    payload?.tenant_access_token || payload?.data?.tenant_access_token || '',
  ).trim();
  if (!token) {
    fail('飞书 OpenAPI 鉴权响应缺少 tenant_access_token', 'RESPONSE');
  }
  openApiTenantAccessToken = token;
  return token;
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
  return configured.replace(/\/+$/, '');
}

function extractFields(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['items', 'fields', 'data']) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    const nested = extractFields(candidate);
    if (nested.length) return nested;
  }
  return [];
}

function extractTables(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['items', 'tables', 'data']) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    const nested = extractTables(candidate);
    if (nested.length) return nested;
  }
  return [];
}

function tableName(table) {
  return table && typeof table === 'object'
    ? String(table.name || table.table_name || '').trim()
    : '';
}

function tableId(table) {
  return table && typeof table === 'object'
    ? String(table.table_id || table.id || '').trim()
    : '';
}

function fieldName(field) {
  return field && typeof field === 'object'
    ? String(field.name || field.field_name || '').trim()
    : '';
}

function isExpectedField(field, expected) {
  const type =
    typeof field.type === 'string' ? field.type.toLowerCase() : field.type;
  const typeMatches =
    (expected.type === 'text' && (type === 'text' || type === 1)) ||
    (expected.type === 'number' && (type === 'number' || type === 2)) ||
    (expected.type === 'select' && (type === 'select' || type === 3)) ||
    (expected.type === 'datetime' && (type === 'datetime' || type === 5)) ||
    (expected.type === 'user' && (type === 'user' || type === 11)) ||
    (expected.type === 'relation' && (type === 'relation' || type === 18));
  if (!typeMatches) return false;
  const multiple = field.multiple ?? field.property?.multiple ?? false;
  if (Boolean(multiple) !== expected.multiple) return false;
  if (expected.type === 'relation') {
    return (
      String(field.property?.table_id || field.table_id || '').trim() ===
      expected.tableId
    );
  }
  return true;
}

function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return '';
}

function fail(message, kind = 'CONFIG') {
  throw new FieldGateError(`[${FIELD_GATE_PREFIX}_${kind}] ${message}`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof FieldGateError
    ? error.message
    : `[${FIELD_GATE_PREFIX}_INTERNAL] 请休假字段检查发生异常`;
  process.stderr.write(`${message}\n`);
  // Allow stderr to drain before the process exits.
  process.exitCode = 1;
}
