import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join, relative } from 'node:path';

export const CHANGE_SUMMARY_REPORT_REQUIRED_FIELDS = [
  {
    name: '变更总结请求唯一ID',
    type: 'text',
    json: { type: 'text', name: '变更总结请求唯一ID' },
  },
  {
    name: '变更总结请求指纹',
    type: 'text',
    json: { type: 'text', name: '变更总结请求指纹' },
  },
];

const FIXED_CHANGE_SUMMARY_REPORT_TABLE_ID = 'tblZZHIJCY3f551K';
const CHANGE_SUMMARY_REPORT_TABLE_ENV_NAMES = [
  'FEISHU_CHANGE_SUMMARY_REPORT_TABLE_ID',
  'FEISHU_CHANGE_DRILL_REPORT_TABLE_ID',
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

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const explicitDryRun = args.includes('--dry-run');
if (apply && explicitDryRun) fail('不能同时使用 --apply 和 --dry-run');
const dryRun = !apply;
const fieldListFile = readOption('--field-list-file');
if (apply && fieldListFile) {
  fail('--apply 不允许使用 --field-list-file；字段快照仅限 dry-run');
}
const larkIdentity = firstEnv('FEISHU_CHANGE_MIGRATION_IDENTITY') || 'bot';
const sourceUrl =
  firstEnv(
    'FEISHU_CALENDAR_CHANGE_SOURCE_URL',
    'FEISHU_CHANGE_CALENDAR_SOURCE_URL',
    'FEISHU_CHANGE_MANAGEMENT_SOURCE_URL',
  ) ||
  'https://vnet.feishu.cn/wiki/JhiVwgfoIimAqEk8YwEc09sknGd?table=tblBvg6wCYSX3hcg&view=vewew3vfZT';
let baseToken = firstEnv(
  'FEISHU_CALENDAR_CHANGE_APP_TOKEN',
  'FEISHU_CHANGE_CALENDAR_APP_TOKEN',
  'FEISHU_CHANGE_MANAGEMENT_APP_TOKEN',
  'FEISHU_FOCUS_CHANGE_APP_TOKEN',
  'FEISHU_CHANGE_APP_TOKEN',
);
for (const environmentName of CHANGE_SUMMARY_REPORT_TABLE_ENV_NAMES) {
  const configuredTableId = process.env[environmentName]?.trim();
  if (
    configuredTableId &&
    configuredTableId !== FIXED_CHANGE_SUMMARY_REPORT_TABLE_ID
  ) {
    fail(`固定关单表配置不一致：请修正 ${environmentName}`);
  }
}
const tableId = FIXED_CHANGE_SUMMARY_REPORT_TABLE_ID;

if (!baseToken && (!fieldListFile || apply)) {
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

if ((!fieldListFile || apply) && !baseToken) {
  fail('缺少变更 Base 配置，无法定位变更总结报告关单表');
}

const rawFields = fieldListFile
  ? await readFieldListFile(fieldListFile)
  : runLark([
      'base',
      '+field-list',
      '--base-token',
      baseToken,
      '--table-id',
      tableId,
      '--as',
      larkIdentity,
      '--format',
      'json',
      '--limit',
      '200',
    ]);
const fields = extractFields(rawFields);
const existingByName = new Map(
  fields
    .map((field) => [fieldName(field), field])
    .filter(([name]) => Boolean(name)),
);
const created = [];
const existing = [];
let jsonArgumentDir = '';
let jsonArgumentIndex = 0;

process.once('exit', () => {
  if (jsonArgumentDir) {
    rmSync(jsonArgumentDir, { recursive: true, force: true });
  }
});

for (const required of CHANGE_SUMMARY_REPORT_REQUIRED_FIELDS) {
  const current = existingByName.get(required.name);
  if (current) {
    if (!isExpectedField(current)) {
      fail(`字段“${required.name}”已存在，但类型或配置不符`);
    }
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
        tableId,
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
      join(process.cwd(), '.change-summary-report-field-json-'),
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

function isExpectedField(field) {
  const type =
    typeof field?.type === 'string' ? field.type.toLowerCase() : field?.type;
  return type === 'text' || type === 1;
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
