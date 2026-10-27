import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const sourceUrl =
  process.env.FEISHU_EQUIPMENT_PATROL_EXECUTION_SOURCE_URL ||
  'https://vnet.feishu.cn/wiki/D01TwFPyXiJBY6kCBDZcMCGLnSe?table=tbl0XK1iQ1P6VY5Y&view=vewcI3Ssfv';
const cli =
  process.platform === 'win32'
    ? execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', '(Get-Command lark-cli).Source'],
        { encoding: 'utf8' },
      ).trim()
    : 'lark-cli';
const fields = [
  '标题（名称）',
  '楼栋',
  '设备',
  '专业',
  '计划开始时间',
  '计划结束时间',
  '实际开始时间',
  '实际结束时间',
  '进度',
  '轮巡状态',
  '内容',
  '最后更新时间',
];

function run(args) {
  const executable = process.platform === 'win32' ? 'powershell.exe' : cli;
  const executableArgs =
    process.platform === 'win32'
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cli, ...args]
      : args;
  const output = execFileSync(executable, executableArgs, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(output);
}

const resolved = run([
  'base',
  '+url-resolve',
  '--url',
  sourceUrl,
  '--as',
  'user',
]);
if (!resolved.ok || !resolved.data?.base_token) {
  throw new Error('Unable to resolve the equipment patrol Base URL.');
}

const args = [
  'base',
  '+record-list',
  '--base-token',
  resolved.data.base_token,
  '--table-id',
  'tbl0XK1iQ1P6VY5Y',
  '--limit',
  '200',
  '--format',
  'json',
  '--as',
  'user',
];
for (const field of fields) args.push('--field-id', field);

const result = run(args);
if (!result.ok || !Array.isArray(result.data?.data)) {
  throw new Error('Unable to read equipment patrol execution records.');
}

const records = result.data.data.map((values, index) => ({
  record_id: result.data.record_id_list[index],
  fields: Object.fromEntries(
    result.data.fields.map((field, fieldIndex) => [field, values[fieldIndex]]),
  ),
}));
const target = resolve(
  process.cwd(),
  'data',
  'equipment-patrol',
  'execution-snapshot.json',
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(
  target,
  `${JSON.stringify(
    {
      version: 1,
      sourceUrl,
      generatedAt: new Date().toISOString(),
      recordCount: records.length,
      records,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

process.stdout.write(`Wrote ${records.length} records to ${target}\n`);
