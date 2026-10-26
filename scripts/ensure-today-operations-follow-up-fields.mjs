#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join, relative } from 'node:path';

const SOURCE_URL =
  'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE';
const FIXED_TABLE_ID = 'tblf929a5033c904';
const requiredFields = [
  field('日期', 5, {
    type: 'datetime',
    name: '日期',
    style: { format: 'yyyy-MM-dd' },
  }),
  field('异常项', 1, { type: 'text', name: '异常项' }),
  field('异常说明', 1, { type: 'text', name: '异常说明' }),
  field('已知悉', 7, { type: 'checkbox', name: '已知悉' }),
  field('已处理完成', 7, { type: 'checkbox', name: '已处理完成' }),
  field('处理措施', 1, { type: 'text', name: '处理措施' }),
  selectField('异常类型', ['运行异常', '排班异常', '封网&变更', '考勤异常']),
  field('异常唯一键', 1, { type: 'text', name: '异常唯一键' }),
  selectField('来源', [
    '今日航图',
    '每日巡视',
    '考勤通晒',
    '人工登记',
    '历史手工跟进',
  ]),
  field('楼栋', 1, { type: 'text', name: '楼栋' }),
  field('最近发现时间', 5, datetimeJson('最近发现时间')),
  field('处理人姓名', 1, { type: 'text', name: '处理人姓名' }),
  field('处理时间', 5, datetimeJson('处理时间')),
  field('客户端变更ID', 1, { type: 'text', name: '客户端变更ID' }),
];

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const explicitDryRun = args.includes('--dry-run');
const requireReady = args.includes('--require-ready');
const fieldListFile = readOption('--field-list-file');
if (apply && explicitDryRun) fail('不能同时使用 --apply 和 --dry-run');
if (apply && requireReady) fail('--require-ready 仅支持 dry-run');
if (apply && fieldListFile) fail('--apply 不允许使用 --field-list-file');
const dryRun = !apply;
const identity =
  process.env.TODAY_OPERATIONS_FOLLOW_UP_MIGRATION_IDENTITY?.trim() || 'bot';

let baseToken = process.env.TODAY_OPERATIONS_ANOMALY_APP_TOKEN?.trim() || '';
const configuredTableId = process.env.TODAY_OPERATIONS_ANOMALY_TABLE_ID?.trim();
if (configuredTableId && configuredTableId !== FIXED_TABLE_ID) {
  fail('TODAY_OPERATIONS_ANOMALY_TABLE_ID 与固定异常跟进表不一致');
}
if (!fieldListFile && !baseToken) {
  baseToken = extractResolvedBaseToken(
    runLark([
      'base',
      '+url-resolve',
      '--url',
      SOURCE_URL,
      '--as',
      identity,
      '--format',
      'json',
    ]),
  );
}
if (!fieldListFile && !baseToken) fail('无法解析异常跟进多维表 base token');

const fields = extractFields(
  fieldListFile
    ? JSON.parse(await readFile(fieldListFile, 'utf8'))
    : runLark([
        'base',
        '+field-list',
        '--base-token',
        baseToken,
        '--table-id',
        FIXED_TABLE_ID,
        '--as',
        identity,
        '--format',
        'json',
        '--limit',
        '200',
      ]),
);
const existingByName = new Map(fields.map((item) => [fieldName(item), item]));
const existing = [];
const created = [];
const updated = [];

for (const required of requiredFields) {
  const current = existingByName.get(required.name);
  if (!current) {
    created.push(required.name);
    continue;
  }
  if (
    numericType(current) !== required.expectedType ||
    (required.options && !isSingleSelect(current))
  ) {
    fail(`字段“${required.name}”已存在，但类型或配置不符`);
  }
  existing.push(required.name);
  if (
    required.options &&
    required.options.some((option) => !optionNames(current).includes(option))
  ) {
    updated.push(required.name);
  }
}

if (requireReady && (created.length || updated.length)) {
  fail(
    `异常跟进字段尚未就绪：缺少 ${created.join('、') || '无'}；待更新 ${updated.join('、') || '无'}`,
  );
}

if (apply) {
  for (const name of created) {
    const required = requiredFields.find((item) => item.name === name);
    await withJsonArgument(required.json, (path) =>
      runLark([
        'base',
        '+field-create',
        '--base-token',
        baseToken,
        '--table-id',
        FIXED_TABLE_ID,
        '--as',
        identity,
        '--json',
        `@${path}`,
      ]),
    );
  }
  for (const name of updated) {
    const required = requiredFields.find((item) => item.name === name);
    const current = existingByName.get(name);
    const fieldId = String(current?.field_id || current?.id || '').trim();
    if (!fieldId) fail(`字段“${name}”缺少 field_id，拒绝更新`);
    const options = preserveOptions(current);
    for (const option of required.options) {
      if (!options.some((item) => item.name === option))
        options.push({ name: option });
    }
    await withJsonArgument(
      { type: 'select', name, multiple: false, options },
      (path) =>
        runLark([
          'base',
          '+field-update',
          '--base-token',
          baseToken,
          '--table-id',
          FIXED_TABLE_ID,
          '--field-id',
          fieldId,
          '--as',
          identity,
          '--json',
          `@${path}`,
          '--yes',
        ]),
    );
  }
}

process.stdout.write(
  `${JSON.stringify({ success: true, dryRun, existing, created, updated })}\n`,
);

function field(name, expectedType, json) {
  return { name, expectedType, json };
}

function selectField(name, options) {
  return {
    name,
    expectedType: 3,
    options,
    json: {
      type: 'select',
      name,
      multiple: false,
      options: options.map((option) => ({ name: option })),
    },
  };
}

function datetimeJson(name) {
  return { type: 'datetime', name, style: { format: 'yyyy-MM-dd HH:mm' } };
}

function numericType(value) {
  if (Number.isFinite(Number(value?.type))) return Number(value.type);
  return (
    { text: 1, number: 2, select: 3, datetime: 5, checkbox: 7 }[
      String(value?.type || '').toLowerCase()
    ] || 0
  );
}

function isSingleSelect(value) {
  return (
    numericType(value) === 3 &&
    value?.multiple !== true &&
    value?.property?.multiple !== true
  );
}

function preserveOptions(value) {
  const raw = Array.isArray(value?.property?.options)
    ? value.property.options
    : Array.isArray(value?.options)
      ? value.options
      : [];
  return raw
    .map((item) => {
      const name = String(item?.name || item || '').trim();
      if (!name) return null;
      const result = { name };
      if (item?.hue) result.hue = item.hue;
      if (item?.lightness) result.lightness = item.lightness;
      return result;
    })
    .filter(Boolean);
}

function optionNames(value) {
  return preserveOptions(value).map((item) => item.name);
}

function extractFields(value) {
  if (Array.isArray(value)) return value;
  for (const candidate of [
    value?.data?.items,
    value?.data?.fields,
    value?.items,
    value?.fields,
    value?.data,
  ]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function fieldName(value) {
  return String(value?.field_name || value?.name || '').trim();
}

function extractResolvedBaseToken(value) {
  const payload =
    value?.data && typeof value.data === 'object' ? value.data : value;
  return String(
    payload?.base_token || payload?.app_token || payload?.obj_token || '',
  ).trim();
}

function readOption(name) {
  const index = args.indexOf(name);
  if (index < 0) return '';
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} 缺少参数`);
  return value;
}

async function withJsonArgument(value, operation) {
  const directory = await mkdtemp(
    join(process.cwd(), '.operations-follow-up-field-json-'),
  );
  const absolutePath = join(directory, 'field.json');
  await writeFile(absolutePath, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  try {
    return operation(
      relative(process.cwd(), absolutePath).replaceAll('\\', '/'),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    },
  );
  if (result.error)
    fail(`lark-cli 执行失败：${safeMessage(result.error.message)}`);
  if (result.status !== 0)
    fail(`lark-cli 返回失败：${safeMessage(result.stderr || result.stdout)}`);
  const output = String(result.stdout || '').trim();
  if (!output) return {};
  try {
    return JSON.parse(output);
  } catch {
    fail('lark-cli 返回了无法解析的 JSON');
  }
}

function resolveLarkCommand() {
  const override = process.env.LARK_CLI_BIN?.trim();
  if (override) return wrapWindowsPowerShell(override);
  if (process.platform !== 'win32')
    return { executable: 'lark-cli', prefix: [] };
  const candidates = [
    join(dirname(process.execPath), 'lark-cli.ps1'),
    ...String(process.env.PATH || '')
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, 'lark-cli.ps1')),
  ];
  const script = candidates.find((candidate) => existsSync(candidate));
  return script
    ? wrapWindowsPowerShell(script)
    : { executable: 'lark-cli.exe', prefix: [] };
}

function wrapWindowsPowerShell(executable) {
  return process.platform === 'win32' &&
    executable.toLowerCase().endsWith('.ps1')
    ? {
        executable: 'powershell.exe',
        prefix: [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          executable,
        ],
      }
    : { executable, prefix: [] };
}

function safeMessage(value) {
  return String(value || '')
    .replace(
      /(?:app_secret|access_token|app_token)\s*[=:]\s*\S+/giu,
      '<redacted>',
    )
    .slice(0, 600);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
