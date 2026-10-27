#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join, relative } from 'node:path';

const SOURCE_URL =
  'https://vnet.feishu.cn/wiki/G7oUwGdwaiTmimk8i2ecGTWOn4d?table=tblCGU1ry3tanQ20&view=vewX0MdewN';
const SOURCE_TABLE_ID = 'tblMK8wzLlFKbTlP';
const TARGET_TABLE_ID = 'tblCGU1ry3tanQ20';
const targetFieldTypes = new Map([
  ['日期', 5],
  ['异常项', 1],
  ['异常说明', 1],
  ['异常类型', 3],
  ['已知悉', 7],
  ['已处理完成', 7],
  ['处理措施', 1],
  ['异常唯一键', 1],
  ['来源', 3],
  ['楼栋', 1],
  ['最近发现时间', 5],
  ['处理人姓名', 1],
  ['处理时间', 5],
  ['客户端变更ID', 1],
]);

main().catch((error) => {
  process.stderr.write(
    `${safeMessage(error instanceof Error ? error.message : error)}\n`,
  );
  process.exitCode = 1;
});

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const explicitDryRun = args.includes('--dry-run');
  const sourceFile = readOption(args, '--source-records-file');
  const targetFile = readOption(args, '--target-records-file');
  if (apply && explicitDryRun)
    throw new Error('不能同时使用 --apply 和 --dry-run');
  if (Boolean(sourceFile) !== Boolean(targetFile)) {
    throw new Error('记录夹具必须同时提供源表和目标表');
  }
  if (apply && sourceFile) throw new Error('--apply 不允许使用记录夹具');
  const dryRun = !apply;
  const identity =
    process.env.TODAY_OPERATIONS_FOLLOW_UP_MIGRATION_IDENTITY?.trim() || 'bot';
  let baseToken = process.env.TODAY_OPERATIONS_ANOMALY_APP_TOKEN?.trim() || '';
  if (!sourceFile && !baseToken) {
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
  if (!sourceFile && !baseToken)
    throw new Error('无法解析异常跟进多维表 base token');
  if (apply) assertTargetFieldsReady(baseToken, identity);

  const sourceRecords = sourceFile
    ? extractRecords(JSON.parse(await readFile(sourceFile, 'utf8')))
    : listAllRecords(baseToken, SOURCE_TABLE_ID, identity);
  const targetRecords = targetFile
    ? extractRecords(JSON.parse(await readFile(targetFile, 'utf8')))
    : listAllRecords(baseToken, TARGET_TABLE_ID, identity);

  const targetKeys = new Set(
    targetRecords
      .map((record) => display(record?.fields?.['异常唯一键']))
      .filter(Boolean),
  );
  const candidates = sourceRecords.map(mapLegacyRecord);
  const candidateKeys = new Set();
  for (const candidate of candidates) {
    if (candidateKeys.has(candidate.issueKey)) {
      throw new Error(`旧表存在重复异常唯一键：${candidate.issueKey}`);
    }
    candidateKeys.add(candidate.issueKey);
  }
  const alreadyPresent = candidates.filter((item) =>
    targetKeys.has(item.issueKey),
  );
  const creates = candidates.filter((item) => !targetKeys.has(item.issueKey));
  const targetBackfills = targetRecords
    .map(mapTargetMetadataBackfill)
    .filter(Boolean);

  if (apply) {
    if (creates.length) {
      const fieldNames = [
        ...new Set(
          creates.flatMap((candidate) => Object.keys(candidate.fields)),
        ),
      ];
      const payload = {
        fields: fieldNames,
        rows: creates.map((candidate) =>
          fieldNames.map((name) =>
            Object.prototype.hasOwnProperty.call(candidate.fields, name)
              ? candidate.fields[name]
              : null,
          ),
        ),
      };
      await withJsonArgument(payload, (path) =>
        runLark([
          'base',
          '+record-batch-create',
          '--base-token',
          baseToken,
          '--table-id',
          TARGET_TABLE_ID,
          '--as',
          identity,
          '--json',
          `@${path}`,
          '--format',
          'json',
        ]),
      );
    }
    for (const backfill of targetBackfills) {
      await withJsonArgument(backfill.fields, (path) =>
        runLark([
          'base',
          '+record-upsert',
          '--base-token',
          baseToken,
          '--table-id',
          TARGET_TABLE_ID,
          '--record-id',
          backfill.recordId,
          '--as',
          identity,
          '--json',
          `@${path}`,
          '--format',
          'json',
        ]),
      );
    }
    const verifiedKeys = new Set(
      listAllRecords(baseToken, TARGET_TABLE_ID, identity)
        .map((record) => display(record?.fields?.['异常唯一键']))
        .filter(Boolean),
    );
    const missing = [...candidates, ...targetBackfills].filter(
      (item) => !verifiedKeys.has(item.issueKey),
    );
    if (missing.length)
      throw new Error(`迁移回读校验失败：缺少 ${missing.length} 条记录`);
  }

  process.stdout.write(
    `${JSON.stringify({
      success: true,
      dryRun,
      sourceRecords: sourceRecords.length,
      alreadyPresent: alreadyPresent.length,
      createCount: creates.length,
      applied: apply ? creates.length : 0,
      targetBackfillCount: targetBackfills.length,
      targetBackfillsApplied: apply ? targetBackfills.length : 0,
      planned: creates.map(
        ({
          sourceRecordId,
          date,
          type,
          item,
          building,
          acknowledged,
          completed,
        }) => ({
          sourceRecordId,
          date,
          type,
          item,
          building,
          acknowledged,
          completed,
        }),
      ),
      targetBackfills: targetBackfills.map(
        ({ recordId, date, source, type, building }) => ({
          recordId,
          date,
          source,
          type,
          building,
        }),
      ),
    })}\n`,
  );
}

function mapLegacyRecord(record) {
  const sourceRecordId = String(record?.record_id || record?.id || '').trim();
  const fields =
    record?.fields && typeof record.fields === 'object' ? record.fields : {};
  const date = shanghaiDateKey(fields['异常日期']);
  const type = display(fields['异常项类型']);
  const item = display(fields['详细内容']);
  const handling = display(fields['异常修正与处理']);
  if (
    !sourceRecordId ||
    !date ||
    !item ||
    !['排班异常', '封网&变更'].includes(type)
  ) {
    throw new Error(`旧表记录无法安全迁移：${sourceRecordId || '<unknown>'}`);
  }
  const digest = createHash('sha256')
    .update(`${date}|${type}|${item}`)
    .digest('hex');
  const issueKey = `legacy-manual:${digest}`;
  const observedAt =
    normalizeEpoch(
      record?.last_modified_time || record?.created_time || fields['创建时间'],
    ) || Date.parse(`${date}T00:00:00+08:00`);
  const building = buildingsFrom(item);
  const acknowledged = Boolean(handling);
  return {
    sourceRecordId,
    issueKey,
    date,
    type,
    item,
    building,
    acknowledged,
    completed: false,
    fields: {
      日期: `${date} 00:00:00`,
      异常项: item,
      异常说明: item,
      异常类型: type,
      来源: '历史手工跟进',
      楼栋: building,
      异常唯一键: issueKey,
      最近发现时间: shanghaiDateTime(observedAt),
      已知悉: acknowledged,
      已处理完成: false,
      处理措施: handling,
      ...(acknowledged ? { 处理时间: shanghaiDateTime(observedAt) } : {}),
      客户端变更ID: `legacy-migrate:${digest}`,
    },
  };
}

function mapTargetMetadataBackfill(record) {
  const recordId = String(record?.record_id || record?.id || '').trim();
  const fields =
    record?.fields && typeof record.fields === 'object' ? record.fields : {};
  if (!recordId || display(fields['异常唯一键'])) return null;
  const date = shanghaiDateKey(fields['日期']);
  const item = display(fields['异常项']);
  const description = display(fields['异常说明']);
  if (!date || !item)
    throw new Error(`目标表记录缺少日期或异常项：${recordId}`);
  const digest = createHash('sha256')
    .update(`${recordId}|${date}|${item}|${description}`)
    .digest('hex');
  const issueKey = `legacy-target:${digest}`;
  const source = '今日航图';
  const type = inferTargetType(`${item} ${description}`);
  const building = buildingsFrom(`${item} ${description}`);
  const observedAt =
    normalizeEpoch(
      record?.last_modified_time || record?.created_time || fields['创建时间'],
    ) || Date.parse(`${date}T00:00:00+08:00`);
  return {
    recordId,
    issueKey,
    date,
    source,
    type,
    building,
    fields: {
      异常唯一键: issueKey,
      来源: source,
      异常类型: type,
      楼栋: building,
      最近发现时间: shanghaiDateTime(observedAt),
      客户端变更ID: `legacy-target-backfill:${digest}`,
    },
  };
}

function inferTargetType(value) {
  const hasOperations = /告警|机柜|用电|PUE|水耗|数据缺失|运行摘要/iu.test(
    value,
  );
  if (!hasOperations && /考勤|迟到|早退|未打卡/iu.test(value))
    return '考勤异常';
  if (!hasOperations && /排班|连班|替班|请假|加班/iu.test(value))
    return '排班异常';
  if (!hasOperations && /封网|变更/iu.test(value)) return '封网&变更';
  return '运行异常';
}

function buildingsFrom(value) {
  const order = ['110站', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼'];
  return (
    [
      ...new Set(
        [...String(value).matchAll(/(?:110站|[ABCDEH](?:楼|栋))/gu)].map(
          (match) => match[0].replace('栋', '楼'),
        ),
      ),
    ]
      .sort((left, right) => order.indexOf(left) - order.indexOf(right))
      .join('、') || '园区'
  );
}

function assertTargetFieldsReady(baseToken, identity) {
  const fields = extractFields(
    runLark([
      'base',
      '+field-list',
      '--base-token',
      baseToken,
      '--table-id',
      TARGET_TABLE_ID,
      '--as',
      identity,
      '--format',
      'json',
      '--limit',
      '200',
    ]),
  );
  const byName = new Map(
    fields.map((field) => [
      String(field?.field_name || field?.name || '').trim(),
      numericType(field?.type),
    ]),
  );
  for (const [name, type] of targetFieldTypes) {
    if (byName.get(name) !== type) {
      throw new Error(`目标表字段未就绪：${name} 应为类型 ${type}`);
    }
  }
}

function numericType(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  return (
    { text: 1, number: 2, select: 3, datetime: 5, checkbox: 7 }[
      String(value || '').toLowerCase()
    ] || 0
  );
}

function listAllRecords(baseToken, tableId, identity) {
  const records = [];
  for (let offset = 0; offset < 10_000; offset += 200) {
    const page = extractRecords(
      runLark([
        'base',
        '+record-list',
        '--base-token',
        baseToken,
        '--table-id',
        tableId,
        '--as',
        identity,
        '--format',
        'json',
        '--limit',
        '200',
        '--offset',
        String(offset),
      ]),
    );
    records.push(...page);
    if (page.length < 200) return records;
  }
  throw new Error(`读取表 ${tableId} 超过分页安全上限`);
}

function extractRecords(value) {
  if (Array.isArray(value)) return value;
  const tabular =
    value?.data && typeof value.data === 'object' ? value.data : value;
  if (
    Array.isArray(tabular?.data) &&
    Array.isArray(tabular?.fields) &&
    Array.isArray(tabular?.record_id_list)
  ) {
    return tabular.data.map((row, index) => ({
      record_id: tabular.record_id_list[index],
      fields: Object.fromEntries(
        tabular.fields.map((name, fieldIndex) => [name, row?.[fieldIndex]]),
      ),
    }));
  }
  for (const candidate of [
    value?.data?.items,
    value?.data?.records,
    value?.items,
    value?.records,
  ]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function extractFields(value) {
  if (Array.isArray(value)) return value;
  for (const candidate of [
    value?.data?.items,
    value?.data?.fields,
    value?.items,
    value?.fields,
  ]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function shanghaiDateKey(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/u.test(value.trim())) {
    return value.trim().slice(0, 10);
  }
  const epoch = normalizeEpoch(value);
  return epoch
    ? new Date(epoch + 8 * 60 * 60_000).toISOString().slice(0, 10)
    : '';
}

function shanghaiDateTime(epoch) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epoch));
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

function normalizeEpoch(value) {
  const number = Number(display(value));
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 10_000_000_000 ? number * 1_000 : number;
}

function display(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(display).filter(Boolean).join('');
  if (typeof value === 'object')
    return display(value.text ?? value.value ?? value.name ?? '');
  return String(value).replace(/\s+/gu, ' ').trim();
}

function extractResolvedBaseToken(value) {
  const payload =
    value?.data && typeof value.data === 'object' ? value.data : value;
  return String(
    payload?.base_token || payload?.app_token || payload?.obj_token || '',
  ).trim();
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return '';
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数`);
  return value;
}

async function withJsonArgument(value, operation) {
  const directory = await mkdtemp(
    join(process.cwd(), '.legacy-follow-up-json-'),
  );
  const absolutePath = join(directory, 'record.json');
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
    throw new Error(`lark-cli 执行失败：${safeMessage(result.error.message)}`);
  if (result.status !== 0)
    throw new Error(
      `lark-cli 返回失败：${safeMessage(result.stderr || result.stdout)}`,
    );
  const output = String(result.stdout || '').trim();
  if (!output) return {};
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('lark-cli 返回了无法解析的 JSON');
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
    .slice(0, 800);
}
