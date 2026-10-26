import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join, relative } from 'node:path';

const BUILDINGS = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', '110站', 'H楼'];

export const CHANGE_DRILL_REPORT_REQUIRED_FIELDS = [
  {
    name: '演练楼栋',
    type: 'select',
    multiple: true,
    options: BUILDINGS,
    json: {
      type: 'select',
      name: '演练楼栋',
      multiple: true,
      options: BUILDINGS.map((name, index) => ({
        name,
        hue: [
          'Blue',
          'Orange',
          'Wathet',
          'Yellow',
          'Turquoise',
          'Red',
          'Purple',
        ][index],
        lightness: 'Lighter',
      })),
    },
  },
  {
    name: '演练提交请求唯一ID',
    type: 'text',
    json: { type: 'text', name: '演练提交请求唯一ID' },
  },
  {
    name: '演练提交请求指纹',
    type: 'text',
    json: { type: 'text', name: '演练提交请求指纹' },
  },
];

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const explicitDryRun = args.includes('--dry-run');
if (apply && explicitDryRun) fail('不能同时使用 --apply 和 --dry-run');
const dryRun = !apply;
const fieldListFile = readOption('--field-list-file');
const larkIdentity = firstEnv('FEISHU_CHANGE_MIGRATION_IDENTITY') || 'bot';
const sourceUrl =
  firstEnv(
    'FEISHU_CALENDAR_CHANGE_SOURCE_URL',
    'FEISHU_CHANGE_CALENDAR_SOURCE_URL',
    'FEISHU_CHANGE_MANAGEMENT_SOURCE_URL',
  ) ||
  'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE';
let baseToken = firstEnv(
  'FEISHU_CALENDAR_CHANGE_APP_TOKEN',
  'FEISHU_CHANGE_CALENDAR_APP_TOKEN',
  'FEISHU_CHANGE_MANAGEMENT_APP_TOKEN',
  'FEISHU_FOCUS_CHANGE_APP_TOKEN',
  'FEISHU_CHANGE_APP_TOKEN',
);
const tableId =
  firstEnv('FEISHU_CHANGE_DRILL_REPORT_TABLE_ID') || 'tbl73b701bc3e2a1';

if (!fieldListFile && !baseToken) {
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

if (!fieldListFile && !baseToken) {
  fail('缺少变更 Base 配置，无法定位演练报告关联表');
}

const rawFields = fieldListFile
  ? JSON.parse(await readFile(fieldListFile, 'utf8'))
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

for (const required of CHANGE_DRILL_REPORT_REQUIRED_FIELDS) {
  const current = existingByName.get(required.name);
  if (current) {
    if (!isExpectedField(current, required)) {
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

async function writeJsonArgumentFile(value) {
  if (!jsonArgumentDir) {
    jsonArgumentDir = await mkdtemp(
      join(process.cwd(), '.change-drill-report-field-json-'),
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
    { encoding: 'utf8', windowsHide: true, shell: false },
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

function resolveLarkCommand() {
  const configured = process.env.LARK_CLI_BIN?.trim();
  if (configured) return wrapWindowsPowerShell(configured);
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

function isExpectedField(field, required) {
  const type =
    typeof field?.type === 'string' ? field.type.toLowerCase() : field?.type;
  if (required.type === 'text') return type === 'text' || type === 1;
  if (required.type !== 'select' || (type !== 'select' && type !== 4)) {
    return false;
  }
  const multiple = field?.multiple ?? field?.property?.multiple;
  if (multiple !== true) return false;
  const options = Array.isArray(field?.options)
    ? field.options
    : Array.isArray(field?.property?.options)
      ? field.property.options
      : [];
  const optionNames = new Set(
    options.map((option) => String(option?.name || '').trim()).filter(Boolean),
  );
  return required.options.every((name) => optionNames.has(name));
}

function safeMessage(value) {
  const raw = String(value || '未知错误');
  return (baseToken ? raw.replaceAll(baseToken, '[redacted]') : raw)
    .replace(/ou_[a-zA-Z0-9]+/g, '[redacted-open-id]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
