import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join, relative } from 'node:path';

const FIXED_OVERTIME_TABLE_ID = 'tblf1bbd02a2b049';
const DEFAULT_OVERTIME_SOURCE_URL =
  'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE';
const DEFAULT_OPENAPI_BASE_URL = 'https://open.feishu.cn/open-apis';
const MAX_OPENAPI_PAGES = 100;
const OPENAPI_TIMEOUT_MS = 15_000;
const OVERTIME_TABLE_ENV_NAMES = [
  'FEISHU_OVERTIME_TABLE_ID',
  'FEISHU_LEAVE_SUBSTITUTE_TABLE_ID',
  'FEISHU_LEAVE_REQUEST_TABLE_ID',
];
const OVERTIME_APP_TOKEN_ENV_NAMES = [
  'FEISHU_OVERTIME_APP_TOKEN',
  'FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN',
  'FEISHU_LEAVE_REQUEST_APP_TOKEN',
  'FEISHU_MAIN_APP_TOKEN',
  'FEISHU_BITABLE_APP_TOKEN',
];
const LARK_CHILD_ENV_NAMES = [
  'PATH',
  'Path',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'ComSpec',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'NO_COLOR',
  'LARK_CLI_HOME',
  'LARK_CLI_CONFIG',
  'LARK_CLI_PROFILE',
  'LARK_OPENAPI_BASE_URL',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
];
const SENSITIVE_ENV_NAME =
  /(?:^|_)(?:SESSION_TOKEN|ACCESS_TOKEN|APP_ID|APP_SECRET|APP_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|BASE_TOKEN|PRIVATE_KEY|PASSWORD|CREDENTIALS?|SECRET_ID|SECRET_KEY)$/i;
const MIN_SENSITIVE_ENV_VALUE_LENGTH = 8;
let openApiTenantAccessToken = '';

export const OVERTIME_WORKFLOW_REQUIRED_FIELDS = [
  {
    name: '加班工作流状态',
    type: 'select',
    json: {
      type: 'select',
      name: '加班工作流状态',
      multiple: false,
      options: ['待路由', '待审批', '已审批', '已驳回', '待确认', '已确认'].map(
        (name) => ({ name }),
      ),
    },
  },
  {
    name: '加班审批人',
    type: 'user',
    json: { type: 'user', name: '加班审批人', multiple: false },
  },
  {
    name: '加班审批时间',
    type: 'datetime',
    json: {
      type: 'datetime',
      name: '加班审批时间',
      style: { format: 'yyyy-MM-dd HH:mm' },
    },
  },
  {
    name: '加班确认人',
    type: 'user',
    json: { type: 'user', name: '加班确认人', multiple: false },
  },
  {
    name: '加班确认时间',
    type: 'datetime',
    json: {
      type: 'datetime',
      name: '加班确认时间',
      style: { format: 'yyyy-MM-dd HH:mm' },
    },
  },
  {
    name: '加班确认',
    type: 'select',
    json: {
      type: 'select',
      name: '加班确认',
      multiple: false,
      options: [{ name: '确认' }],
    },
  },
  {
    name: '加班经理知会时间',
    type: 'datetime',
    json: {
      type: 'datetime',
      name: '加班经理知会时间',
      style: { format: 'yyyy-MM-dd HH:mm' },
    },
  },
  {
    name: '加班确认最后提醒时间',
    type: 'datetime',
    json: {
      type: 'datetime',
      name: '加班确认最后提醒时间',
      style: { format: 'yyyy-MM-dd HH:mm' },
    },
  },
  {
    name: '加班工作流错误',
    type: 'text',
    json: { type: 'text', name: '加班工作流错误' },
  },
];

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const explicitDryRun = args.includes('--dry-run');
const requireReady = args.includes('--require-ready');
if (apply && explicitDryRun) fail('不能同时使用 --apply 和 --dry-run');
if (apply && requireReady) fail('--require-ready 仅支持 dry-run');
const dryRun = !apply;
const fieldListFile = readOption('--field-list-file');
if (apply && fieldListFile) {
  fail('--apply 不允许使用 --field-list-file；字段快照仅限 dry-run');
}

for (const environmentName of OVERTIME_TABLE_ENV_NAMES) {
  const configuredTableId = process.env[environmentName]?.trim();
  if (configuredTableId && configuredTableId !== FIXED_OVERTIME_TABLE_ID) {
    fail(`固定加班表配置不一致：请修正 ${environmentName}`);
  }
}

const larkIdentity =
  firstEnv(
    'FEISHU_OVERTIME_WORKFLOW_MIGRATION_IDENTITY',
    'FEISHU_LEAVE_MIGRATION_IDENTITY',
  ) || 'bot';
const configuredWikiToken = firstEnv(
  'FEISHU_LEAVE_SUBSTITUTE_WIKI_TOKEN',
  'FEISHU_LEAVE_REQUEST_WIKI_TOKEN',
);
const sourceUrl =
  firstEnv(
    'FEISHU_LEAVE_SUBSTITUTE_SOURCE_URL',
    'FEISHU_LEAVE_REQUEST_SOURCE_URL',
  ) ||
  (configuredWikiToken
    ? `https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE`
    : DEFAULT_OVERTIME_SOURCE_URL);
const sourceTableId = extractTableId(sourceUrl);
if (sourceTableId && sourceTableId !== FIXED_OVERTIME_TABLE_ID) {
  fail('加班数据源 URL 与固定目标表不一致');
}
let baseToken = firstEnv(...OVERTIME_APP_TOKEN_ENV_NAMES);

if (!fieldListFile && !baseToken) {
  if (dryRun) {
    baseToken = await resolveBaseTokenWithOpenApi(
      configuredWikiToken || extractWikiToken(sourceUrl),
    );
  } else {
    const resolved = runLark([
      'base',
      '+url-resolve',
      '--url',
      sourceUrl,
      '--as',
      larkIdentity,
      '--format',
      'json',
    ]);
    baseToken = extractResolvedBaseToken(resolved);
  }
}

if (!fieldListFile && !baseToken) {
  fail('缺少请休假/加班 Base 配置，无法定位加班工作流字段');
}

const rawFields = fieldListFile
  ? await readFieldListFile(fieldListFile)
  : dryRun
    ? await listFieldsWithOpenApi(baseToken)
    : runLark([
        'base',
        '+field-list',
        '--base-token',
        baseToken,
        '--table-id',
        FIXED_OVERTIME_TABLE_ID,
        '--as',
        larkIdentity,
        '--format',
        'json',
        '--limit',
        '200',
      ]);
const existingByName = new Map(
  extractFields(rawFields)
    .map((field) => [fieldName(field), field])
    .filter(([name]) => Boolean(name)),
);

for (const required of OVERTIME_WORKFLOW_REQUIRED_FIELDS) {
  const current = existingByName.get(required.name);
  if (current && !isExpectedField(current, required.type)) {
    fail(`字段“${required.name}”已存在，但类型或配置不符`);
  }
}

const existing = [];
const created = [];
let jsonArgumentDir = '';
let jsonArgumentIndex = 0;

process.once('exit', () => {
  if (jsonArgumentDir) {
    rmSync(jsonArgumentDir, { recursive: true, force: true });
  }
});

for (const required of OVERTIME_WORKFLOW_REQUIRED_FIELDS) {
  if (existingByName.has(required.name)) {
    existing.push(required.name);
    continue;
  }

  if (!dryRun) {
    const payloadPath = await writeJsonArgumentFile(required.json);
    try {
      runLark([
        'base',
        '+field-create',
        '--base-token',
        baseToken,
        '--table-id',
        FIXED_OVERTIME_TABLE_ID,
        '--as',
        larkIdentity,
        '--json',
        `@${payloadPath}`,
      ]);
    } finally {
      await rm(payloadPath, { force: true });
    }
  }
  created.push(required.name);
}

if (jsonArgumentDir) {
  await rm(jsonArgumentDir, { recursive: true, force: true });
  jsonArgumentDir = '';
}

if (requireReady && created.length > 0) {
  fail(
    `缺少加班工作流字段：${created.join('、')}。请先运行 npm run migrate:overtime-workflow-fields`,
  );
}

process.stdout.write(
  `${JSON.stringify({ success: true, dryRun, existing, created })}\n`,
);

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

async function readFieldListFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail('--field-list-file 必须是可读取的 JSON 文件');
  }
}

async function writeJsonArgumentFile(value) {
  if (!jsonArgumentDir) {
    jsonArgumentDir = await mkdtemp(
      join(process.cwd(), '.overtime-workflow-field-json-'),
    );
  }
  jsonArgumentIndex += 1;
  const absolutePath = join(jsonArgumentDir, `field-${jsonArgumentIndex}.json`);
  await writeFile(absolutePath, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return relative(process.cwd(), absolutePath).replaceAll('\\', '/');
}

function extractTableId(value) {
  try {
    return new URL(value).searchParams.get('table')?.trim() || '';
  } catch {
    fail('请休假/加班 Base 数据源 URL 无效');
  }
}

function extractWikiToken(value) {
  try {
    const parsed = new URL(value);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const index = segments.indexOf('wiki');
    return index >= 0 ? String(segments[index + 1] || '').trim() : '';
  } catch {
    fail('请休假/加班 Base 数据源 URL 无效');
  }
}

async function resolveBaseTokenWithOpenApi(wikiToken) {
  if (!wikiToken) {
    fail('缺少请休假/加班 Base 配置，无法定位加班工作流字段');
  }
  const query = new URLSearchParams({ token: wikiToken }).toString();
  const payload = await requestOpenApi(
    '解析加班 Base 数据源',
    `/wiki/v2/spaces/get_node?${query}`,
  );
  const node = payload?.data?.node;
  const token = String(node?.obj_token || '').trim();
  if (node?.obj_type !== 'bitable' || !token) {
    fail('配置的请休假/加班数据源不是可读取的多维表格');
  }
  return token;
}

async function listFieldsWithOpenApi(appToken) {
  const items = [];
  const seenPageTokens = new Set();
  let pageToken = '';

  for (let page = 0; page < MAX_OPENAPI_PAGES; page += 1) {
    const query = new URLSearchParams({ page_size: '200' });
    if (pageToken) query.set('page_token', pageToken);
    const payload = await requestOpenApi(
      '读取加班工作流字段',
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(
        FIXED_OVERTIME_TABLE_ID,
      )}/fields?${query}`,
    );
    const data = payload?.data;
    if (Array.isArray(data?.items)) items.push(...data.items);
    if (!data?.has_more) return { data: { items } };

    const nextPageToken = String(data?.page_token || '').trim();
    if (!nextPageToken || seenPageTokens.has(nextPageToken)) {
      fail('飞书字段分页返回了空或重复的 page_token，已拒绝继续启动');
    }
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  fail('飞书字段分页超过安全页数限制，已拒绝继续启动');
}

async function requestOpenApi(operation, path, options = {}) {
  const authenticated = options.authenticated !== false;
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (authenticated) {
    headers.Authorization = `Bearer ${await getOpenApiTenantAccessToken()}`;
  }

  let response;
  try {
    response = await fetch(`${openApiBaseUrl()}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(OPENAPI_TIMEOUT_MS),
    });
  } catch {
    fail(`飞书 OpenAPI 请求失败：${operation}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    fail(`飞书 OpenAPI 返回了无法解析的响应：${operation}`);
  }
  if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
    fail(`飞书 OpenAPI 拒绝请求：${operation}`);
  }
  return payload;
}

async function getOpenApiTenantAccessToken() {
  if (openApiTenantAccessToken) return openApiTenantAccessToken;
  const appId = firstEnv('FEISHU_APP_ID');
  const appSecret = firstEnv('FEISHU_APP_SECRET');
  if (!appId || !appSecret) {
    fail('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET，无法执行只读字段检查');
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
    fail('飞书 OpenAPI 鉴权响应缺少 tenant_access_token');
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

function extractResolvedBaseToken(value) {
  const payload =
    value?.data && typeof value.data === 'object' ? value.data : value;
  return String(
    payload?.base_token || payload?.app_token || payload?.obj_token || '',
  ).trim();
}

function runLark(commandArgs) {
  const command = resolveLarkCommand();
  const result = spawnSync(
    command.executable,
    [...command.prefix, ...commandArgs],
    {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      env: buildLarkChildEnvironment(),
    },
  );
  if (result.error) {
    fail(`lark-cli 执行失败：${safeMessage(result.error.message)}`);
  }
  if (result.status !== 0) {
    fail(`lark-cli 返回失败：${safeMessage(result.stderr || result.stdout)}`);
  }
  const output = result.stdout.trim();
  if (!output) return {};
  try {
    return JSON.parse(output);
  } catch {
    fail('lark-cli 返回了无法解析的 JSON');
  }
}

function buildLarkChildEnvironment() {
  const environment = {};
  for (const name of LARK_CHILD_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function resolveLarkCommand() {
  const configured = process.env.LARK_CLI_BIN?.trim();
  if (configured) {
    if (/\.(?:cjs|mjs|js)$/i.test(configured)) {
      return { executable: process.execPath, prefix: [configured] };
    }
    return wrapWindowsPowerShell(configured);
  }
  if (process.platform !== 'win32') {
    return { executable: 'lark-cli', prefix: [] };
  }
  const candidates = [
    join(dirname(process.execPath), 'lark-cli.ps1'),
    ...String(process.env.PATH || '')
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, 'lark-cli.ps1')),
  ];
  const script = candidates.find((candidate) => existsSync(candidate));
  return script
    ? wrapWindowsPowerShell(script)
    : { executable: 'lark-cli.exe', prefix: [] };
}

function wrapWindowsPowerShell(executable) {
  if (
    process.platform === 'win32' &&
    executable.toLowerCase().endsWith('.ps1')
  ) {
    return {
      executable: 'powershell.exe',
      prefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', executable],
    };
  }
  return { executable, prefix: [] };
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
  if (!field || typeof field !== 'object') return '';
  return String(field.name || field.field_name || '').trim();
}

function isExpectedField(field, expectedType) {
  const type =
    typeof field?.type === 'string' ? field.type.toLowerCase() : field?.type;
  if (expectedType === 'text') return type === 'text' || type === 1;
  if (expectedType === 'datetime') return type === 'datetime' || type === 5;
  if (expectedType === 'user') {
    if (type !== 'user' && type !== 11) return false;
    return field?.multiple !== true && field?.property?.multiple !== true;
  }
  if (expectedType === 'select') {
    if (type !== 'select' && type !== 3) return false;
    return field?.multiple !== true && field?.property?.multiple !== true;
  }
  return false;
}

function safeMessage(value) {
  let redacted = String(value || '未知错误');
  for (const secret of collectSensitiveValues()) {
    redacted = redacted.replaceAll(secret, '[redacted-secret]');
  }
  return redacted
    .replace(/ou_[a-zA-Z0-9]+/g, '[redacted-open-id]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

function collectSensitiveValues() {
  const values = new Set();
  const add = (value) => {
    const raw = typeof value === 'string' ? value : '';
    if (raw) values.add(raw);
    const trimmed = raw.trim();
    if (trimmed) values.add(trimmed);
  };

  add(baseToken);
  add(sourceUrl);
  add(configuredWikiToken);
  add(process.env.FEISHU_APP_ID);
  add(process.env.FEISHU_APP_SECRET);
  for (const identifier of extractSourceSensitiveIdentifiers(sourceUrl)) {
    add(identifier);
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (
      SENSITIVE_ENV_NAME.test(name) &&
      typeof value === 'string' &&
      value.trim().length >= MIN_SENSITIVE_ENV_VALUE_LENGTH
    ) {
      add(value);
    }
  }
  return [...values].sort((left, right) => right.length - left.length);
}

function extractSourceSensitiveIdentifiers(value) {
  try {
    const parsed = new URL(value);
    const identifiers = [];
    const segments = parsed.pathname.split('/').filter(Boolean);
    for (const marker of ['wiki', 'base']) {
      const index = segments.indexOf(marker);
      if (index >= 0 && segments[index + 1]) {
        identifiers.push(segments[index + 1]);
      }
    }
    for (const name of ['app_token', 'base_token', 'wiki_token', 'token']) {
      const identifier = parsed.searchParams.get(name)?.trim();
      if (identifier) identifiers.push(identifier);
    }
    return identifiers;
  } catch {
    return [];
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
