#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join, relative } from 'node:path';

const FIXED_TABLE_ID = 'tblsunmofUPOYGL9';
const DEFAULT_APP_TOKEN = 'KdCZbSL5CaTErKsFwFucddA5nYd';

const requiredFields = [
  selectField('班次', ['白班', '夜班', '长白班', '未识别班次']),
  dateField('上班打卡时间'),
  dateField('下班打卡时间'),
  selectField('上班状态', ['正常', '未打卡', '迟到', '旷工', '考勤异常']),
  selectField('下班状态', ['正常', '未打卡', '早退', '旷工', '考勤异常']),
  {
    name: '打卡次数',
    expectedType: 2,
    json: {
      type: 'number',
      name: '打卡次数',
      style: { type: 'plain', precision: 0, percentage: false },
    },
  },
  {
    name: '全部打卡时间',
    expectedType: 1,
    json: { type: 'text', name: '全部打卡时间' },
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
if (apply && fieldListFile) fail('--apply 不允许使用 --field-list-file');

const configuredTableId =
  process.env.FEISHU_ATTENDANCE_ARCHIVE_TABLE_ID?.trim();
if (configuredTableId && configuredTableId !== FIXED_TABLE_ID) {
  fail('FEISHU_ATTENDANCE_ARCHIVE_TABLE_ID 与固定考勤归档表不一致');
}
const baseToken =
  process.env.FEISHU_ATTENDANCE_ARCHIVE_APP_TOKEN?.trim() || DEFAULT_APP_TOKEN;
const identity =
  process.env.FEISHU_ATTENDANCE_ARCHIVE_MIGRATION_IDENTITY?.trim() || 'bot';

const rawFields = fieldListFile
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
    ]);
const fields = extractFields(rawFields);
const existingByName = new Map(
  fields
    .map((field) => [fieldName(field), field])
    .filter(([name]) => Boolean(name)),
);

const existing = [];
const created = [];
const updated = [];

for (const required of requiredFields) {
  const current = existingByName.get(required.name);
  if (!current) {
    created.push(required.name);
    continue;
  }
  if (!matchesField(current, required)) {
    fail(`字段“${required.name}”已存在，但类型或配置不符`);
  }
  existing.push(required.name);
}

const punchType = existingByName.get('打卡类型');
if (!punchType) fail('考勤归档表缺少既有字段“打卡类型”');
if (!isSelect(punchType)) fail('字段“打卡类型”已存在，但类型或配置不符');
const punchTypeOptions = optionNames(punchType);
if (!punchTypeOptions.includes('班次汇总')) updated.push('打卡类型');

if (requireReady && (created.length > 0 || updated.length > 0)) {
  fail(
    `考勤归档字段尚未就绪：缺少 ${created.join('、') || '无'}；待更新 ${updated.join('、') || '无'}`,
  );
}

if (apply) {
  for (const name of created) {
    const required = requiredFields.find((field) => field.name === name);
    await withJsonArgument(required.json, (payloadPath) =>
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
        `@${payloadPath}`,
      ]),
    );
  }
  if (updated.includes('打卡类型')) {
    const fieldId = String(punchType.field_id || punchType.id || '').trim();
    if (!fieldId) fail('字段“打卡类型”缺少 field_id，拒绝更新');
    const options = preserveOptions(punchType);
    options.push({ name: '班次汇总', hue: 'Blue', lightness: 'Lighter' });
    await withJsonArgument(
      { type: 'select', name: '打卡类型', multiple: false, options },
      (payloadPath) =>
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
          `@${payloadPath}`,
          '--yes',
        ]),
    );
  }
}

process.stdout.write(
  `${JSON.stringify({ success: true, dryRun, existing, created, updated })}\n`,
);

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

function dateField(name) {
  return {
    name,
    expectedType: 5,
    json: {
      type: 'datetime',
      name,
      style: { format: 'yyyy-MM-dd HH:mm' },
    },
  };
}

function matchesField(field, required) {
  if (numericType(field) !== required.expectedType) return false;
  if (required.expectedType !== 3) return true;
  if (field.multiple === true || field.property?.multiple === true)
    return false;
  const actual = optionNames(field);
  return required.options.every((option) => actual.includes(option));
}

function isSelect(field) {
  return (
    numericType(field) === 3 &&
    field.multiple !== true &&
    field.property?.multiple !== true
  );
}

function numericType(field) {
  if (Number.isFinite(Number(field?.type))) return Number(field.type);
  const name = String(field?.type || '').toLowerCase();
  return { text: 1, number: 2, select: 3, datetime: 5 }[name] || 0;
}

function optionNames(field) {
  return preserveOptions(field).map((option) => option.name);
}

function preserveOptions(field) {
  const raw = Array.isArray(field?.property?.options)
    ? field.property.options
    : Array.isArray(field?.options)
      ? field.options
      : [];
  return raw
    .map((option) => {
      const name = String(option?.name || option || '').trim();
      if (!name) return null;
      const value = { name };
      if (option?.hue) value.hue = option.hue;
      if (option?.lightness) value.lightness = option.lightness;
      return value;
    })
    .filter(Boolean);
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

function fieldName(field) {
  return String(field?.field_name || field?.name || '').trim();
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
    join(process.cwd(), '.attendance-field-json-'),
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
  if (result.status !== 0) {
    fail(`lark-cli 返回失败：${safeMessage(result.stderr || result.stdout)}`);
  }
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
  if (override) {
    if (/\.(?:cjs|mjs|js)$/iu.test(override)) {
      return { executable: process.execPath, prefix: [override] };
    }
    return wrapWindowsPowerShell(override);
  }
  if (process.platform !== 'win32')
    return { executable: 'lark-cli', prefix: [] };
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

function safeMessage(value) {
  return String(value || '')
    .replace(
      /(?:app_secret|access_token|app_token)\s*[=:]\s*\S+/giu,
      '$1=<redacted>',
    )
    .slice(0, 600);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
