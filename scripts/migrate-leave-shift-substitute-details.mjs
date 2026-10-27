import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const OPENAPI_BASE_URL = 'https://open.feishu.cn/open-apis';
const LEAVE_TABLE_ID = 'tblpCzmTT3EapaUY';
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
let tenantToken = '';

const options = parseArgs(process.argv.slice(2));
const appToken = firstEnv(
  'FEISHU_LEAVE_REQUEST_APP_TOKEN',
  'FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN',
  'FEISHU_MAIN_APP_TOKEN',
  'FEISHU_BITABLE_APP_TOKEN',
);
const dutyAppToken =
  firstEnv(
    'FEISHU_SCHEDULE_APP_TOKEN',
    'FEISHU_DUTY_APP_TOKEN',
    'FEISHU_MAIN_APP_TOKEN',
    'FEISHU_BITABLE_APP_TOKEN',
  ) || appToken;
const personnelAppToken =
  firstEnv('FEISHU_ORG_APP_TOKEN', 'FEISHU_ORGANIZATION_APP_TOKEN') ||
  appToken;
const dutyTableId = firstEnv(
  'FEISHU_SCHEDULE_TABLE_ID',
  'FEISHU_DUTY_TABLE_ID',
);
const personnelTableId = firstEnv(
  'FEISHU_ACTIVE_PERSONNEL_TABLE_ID',
  'FEISHU_ORG_TABLE_ID',
  'FEISHU_ORGANIZATION_TABLE_ID',
);
if (!appToken || !dutyAppToken || !personnelAppToken || !dutyTableId || !personnelTableId) {
  fail('缺少请假、排班、人员或请假替班班次明细表配置');
}
const detailTableId =
  firstEnv('FEISHU_LEAVE_SHIFT_DETAIL_TABLE_ID') ||
  (await resolveUniqueTableId(appToken, '请假替班班次明细'));
if (!options.recordIds.length && !options.scanApproved) {
  fail('默认只迁移明确指定的记录；请使用 --record-id 或显式 --scan-approved');
}

const personnel = await listRecords(personnelAppToken, personnelTableId);
const recordIds = options.scanApproved
  ? await listApprovedLeaveRecordIds()
  : options.recordIds;
const plans = [];
for (const recordId of [...new Set(recordIds)]) {
  try {
    plans.push(await planRecord(recordId, personnel));
  } catch (error) {
    plans.push({
      recordId,
      disposition: 'manual-review',
      reason: safeMessage(error),
    });
  }
}

const writes = [];
if (options.apply) {
  for (const plan of plans) {
    if (plan.disposition !== 'migratable') continue;
    writes.push(await applyPlan(plan));
  }
}
const output = {
  success: true,
  mode: options.apply ? 'apply' : 'dry-run',
  writeEnabled: options.apply,
  plans,
  writes,
};
if (options.outputPath) {
  await writeFile(options.outputPath, `${JSON.stringify(output, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}
process.stdout.write(`${JSON.stringify(output)}\n`);

async function planRecord(recordId, directory) {
  requireRecordId(recordId);
  const parent = await getRecord(appToken, LEAVE_TABLE_ID, recordId);
  const fields = parent.fields || {};
  const scheduleRecordIds = readIdentifiers(fields['系统影响排班记录ID']);
  if (!scheduleRecordIds.length) {
    return manual(recordId, 'missing-impact-schedule-ids');
  }
  const substituteName = text(fields['替班人员（填姓名）']);
  if (!substituteName) return manual(recordId, 'missing-substitute');
  const matches = directory.filter(
    (record) =>
      normalizedName(personName(record.fields)) ===
      normalizedName(substituteName),
  );
  if (matches.length !== 1) {
    return manual(
      recordId,
      matches.length === 0
        ? 'substitute-person-not-found'
        : 'ambiguous-substitute-person',
    );
  }
  const substitutePersonRecordId = requireRecordId(matches[0].record_id);
  const substituteOpenId = personOpenId(matches[0].fields);
  const scheduleRecords = [];
  for (const scheduleRecordId of scheduleRecordIds) {
    scheduleRecords.push(
      await getRecord(dutyAppToken, dutyTableId, scheduleRecordId),
    );
  }
  const groupsByKey = new Map();
  for (const schedule of scheduleRecords) {
    const group = scheduleGroup(schedule);
    if (!group) return manual(recordId, 'unrecognized-shift');
    const current = groupsByKey.get(group.shiftKey) || {
      ...group,
      scheduleRecordIds: [],
    };
    current.scheduleRecordIds.push(requireRecordId(schedule.record_id));
    current.scheduleRecordIds = [...new Set(current.scheduleRecordIds)].sort();
    groupsByKey.set(group.shiftKey, current);
  }
  const groups = [...groupsByKey.values()].sort((left, right) =>
    left.shiftKey.localeCompare(right.shiftKey),
  );
  return {
    recordId,
    disposition: 'migratable',
    groups,
    substitutePersonRecordId,
    substituteOpenId,
    substituteName,
    plannedDetailIds: groups.map((group) =>
      stableDetailId(recordId, group.shiftKey),
    ),
  };
}

async function applyPlan(plan) {
  const affectedRecordIds = [];
  for (const group of plan.groups) {
    const detailId = stableDetailId(plan.recordId, group.shiftKey);
    const existing = await searchDetail(detailId);
    if (existing.length > 1) throw new Error(`duplicate-detail-id:${detailId}`);
    const fields = {
      明细唯一ID: detailId,
      请假记录ID: plan.recordId,
      请假主记录: [plan.recordId],
      班次键: group.shiftKey,
      排班记录IDs: JSON.stringify(group.scheduleRecordIds),
      排班记录: group.scheduleRecordIds,
      班次日期: Date.parse(`${group.scheduleDate}T00:00:00+08:00`),
      开始时间: Date.parse(`${group.startAt}:00+08:00`),
      结束时间: Date.parse(`${group.endAt}:00+08:00`),
      班次: group.shift,
      替班人员记录ID: plan.substitutePersonRecordId,
      替班人员姓名: plan.substituteName,
      替班人员OpenID: plan.substituteOpenId,
      替班安排版本: 0,
      状态: 'active',
    };
    const stored = existing[0]
      ? await updateRecord(detailTableId, existing[0].record_id, fields)
      : await createRecord(
          detailTableId,
          fields,
          stableClientToken(`legacy:${detailId}`),
        );
    const reread = await getRecord(appToken, detailTableId, stored.record_id);
    if (
      !sameSet(
        readIdentifiers(reread.fields?.['排班记录IDs']),
        group.scheduleRecordIds,
      )
    ) {
      throw new Error(`semantic-readback-failed:${stored.record_id}`);
    }
    affectedRecordIds.push(stored.record_id);
  }
  return {
    recordId: plan.recordId,
    detailRecordIds: affectedRecordIds,
    operation: 'upsert',
  };
}

function scheduleGroup(record) {
  const fields = record.fields || {};
  const scheduleDate = shanghaiDate(
    fields['排班日期'] ?? fields['日期'] ?? fields['schedule_date'],
  );
  const shift = text(
    fields['班次'] ?? fields['值班班次'] ?? fields['班次（文本）'],
  );
  if (!scheduleDate || !shift) return null;
  const compact = shift.replace(/\s+/gu, '');
  let startHour;
  let endHour;
  if (/110/u.test(compact) && /白|日/u.test(compact)) {
    startHour = 8;
    endHour = 20;
  } else if (/110/u.test(compact) && /夜/u.test(compact)) {
    startHour = 20;
    endHour = 32;
  } else if (/夜/u.test(compact)) {
    startHour = 18;
    endHour = 33;
  } else if (/白|长白|日/u.test(compact)) {
    startHour = 9;
    endHour = 18;
  } else {
    return null;
  }
  const startAt = addHours(scheduleDate, startHour);
  const endAt = addHours(scheduleDate, endHour);
  return {
    shiftKey: `${startAt}__${endAt}`,
    scheduleDate,
    startAt,
    endAt,
    shift,
  };
}

async function listApprovedLeaveRecordIds() {
  const records = await listRecords(appToken, LEAVE_TABLE_ID);
  return records
    .filter((record) => text(record.fields?.['请假工作流状态']) === '已审批')
    .map((record) => requireRecordId(record.record_id));
}

async function searchDetail(detailId) {
  const payload = await request(
    `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(
      detailTableId,
    )}/records/search`,
    {
      method: 'POST',
      body: {
        filter: {
          conjunction: 'and',
          conditions: [
            { field_name: '明细唯一ID', operator: 'is', value: [detailId] },
          ],
        },
      },
    },
  );
  return Array.isArray(payload?.data?.items) ? payload.data.items : [];
}

async function resolveUniqueTableId(baseToken, tableName) {
  const matches = [];
  let pageToken = '';
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ page_size: '100' });
    if (pageToken) query.set('page_token', pageToken);
    const payload = await request(
      `/bitable/v1/apps/${encodeURIComponent(baseToken)}/tables?${query}`,
    );
    for (const table of Array.isArray(payload?.data?.items)
      ? payload.data.items
      : []) {
      if (String(table?.name || '').trim() === tableName) {
        const tableId = String(table?.table_id || '').trim();
        if (tableId) matches.push(tableId);
      }
    }
    if (!payload?.data?.has_more) break;
    pageToken = String(payload?.data?.page_token || '').trim();
    if (!pageToken) throw new Error('invalid-table-page-token');
  }
  const uniqueMatches = [...new Set(matches)];
  if (uniqueMatches.length !== 1) {
    fail(
      `expected exactly one table named ${tableName}, found ${uniqueMatches.length}`,
    );
  }
  return uniqueMatches[0];
}

async function listRecords(baseToken, tableId) {
  const records = [];
  let pageToken = '';
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ page_size: '500' });
    if (pageToken) query.set('page_token', pageToken);
    const payload = await request(
      `/bitable/v1/apps/${encodeURIComponent(baseToken)}/tables/${encodeURIComponent(
        tableId,
      )}/records?${query}`,
    );
    if (Array.isArray(payload?.data?.items))
      records.push(...payload.data.items);
    if (!payload?.data?.has_more) return records;
    pageToken = String(payload?.data?.page_token || '').trim();
    if (!pageToken) throw new Error('invalid-page-token');
  }
  throw new Error('page-limit-exceeded');
}

async function getRecord(baseToken, tableId, recordId) {
  const payload = await request(
    `/bitable/v1/apps/${encodeURIComponent(baseToken)}/tables/${encodeURIComponent(
      tableId,
    )}/records/${encodeURIComponent(requireRecordId(recordId))}`,
  );
  const record = payload?.data?.record;
  if (!record?.record_id) throw new Error(`record-not-found:${recordId}`);
  return record;
}

async function createRecord(tableId, fields, clientToken) {
  const payload = await request(
    `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(
      tableId,
    )}/records?client_token=${encodeURIComponent(clientToken)}`,
    { method: 'POST', body: { fields } },
  );
  return payload?.data?.record;
}

async function updateRecord(tableId, recordId, fields) {
  const payload = await request(
    `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(
      tableId,
    )}/records/${encodeURIComponent(requireRecordId(recordId))}`,
    { method: 'PUT', body: { fields } },
  );
  return payload?.data?.record || { record_id: recordId, fields };
}

async function request(path, options = {}) {
  const response = await fetch(`${openApiBaseUrl()}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${await accessToken()}`,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json();
  if (!response.ok || Number(payload?.code || 0) !== 0) {
    throw new Error(
      `openapi-rejected:${response.status}:${payload?.code || 0}`,
    );
  }
  return payload;
}

async function accessToken() {
  if (tenantToken) return tenantToken;
  const appId = firstEnv('FEISHU_APP_ID');
  const appSecret = firstEnv('FEISHU_APP_SECRET');
  if (!appId || !appSecret) fail('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET');
  const response = await fetch(
    `${openApiBaseUrl()}/auth/v3/tenant_access_token/internal`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const payload = await response.json();
  tenantToken = String(payload?.tenant_access_token || '').trim();
  if (!response.ok || Number(payload?.code || 0) !== 0 || !tenantToken) {
    fail('获取飞书 tenant_access_token 失败');
  }
  return tenantToken;
}

function parseArgs(args) {
  const result = {
    apply: false,
    scanApproved: false,
    recordIds: [],
    outputPath: '',
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') continue;
    if (arg === '--apply') {
      result.apply = true;
      continue;
    }
    if (arg === '--scan-approved') {
      result.scanApproved = true;
      continue;
    }
    if (arg === '--record-id') {
      result.recordIds.push(requireRecordId(args[++index]));
      continue;
    }
    if (arg === '--output') {
      result.outputPath = String(args[++index] || '').trim();
      if (!result.outputPath) fail('--output 缺少路径');
      continue;
    }
    fail(`不支持的参数：${arg}`);
  }
  return result;
}

function readIdentifiers(value) {
  if (Array.isArray(value)) return [...new Set(value.flatMap(readIdentifiers))];
  const raw = text(value);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return readIdentifiers(parsed);
  } catch {}
  return [
    ...new Set(
      raw
        .split(/[\s、,，;；/]+/u)
        .map((item) => item.replace(/^[\["']+|[\]"']+$/gu, '').trim())
        .filter((item) => RECORD_ID_PATTERN.test(item)),
    ),
  ];
}

function personName(fields = {}) {
  return text(fields['姓名'] ?? fields['人员姓名'] ?? fields['名字']);
}

function personOpenId(fields = {}) {
  const values = [fields['Open ID'], fields['open_id'], fields['飞书OpenID']];
  for (const value of values) {
    const candidate = text(value);
    if (/^ou_[A-Za-z0-9_-]{1,124}$/u.test(candidate)) return candidate;
  }
  return '';
}

function shanghaiDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value.trim())) {
    return value.trim();
  }
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(timestamp);
}

function addHours(date, hours) {
  const timestamp =
    Date.parse(`${date}T00:00:00+08:00`) + hours * 60 * 60 * 1000;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(timestamp);
  const read = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${read('year')}-${read('month')}-${read('day')}T${read('hour')}:${read('minute')}`;
}

function stableDetailId(recordId, shiftKey) {
  return `leave-shift-${createHash('sha256')
    .update(`${recordId}\0${shiftKey}`)
    .digest('hex')}`;
}

function stableClientToken(value) {
  const chars = createHash('sha256')
    .update(value)
    .digest('hex')
    .slice(0, 32)
    .split('');
  chars[12] = '4';
  chars[16] = ['8', '9', 'a', 'b'][parseInt(chars[16], 16) % 4];
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sameSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function manual(recordId, reason) {
  return { recordId, disposition: 'manual-review', reason };
}

function normalizedName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/gu, '')
    .toLocaleLowerCase('zh-CN');
}

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('、');
  if (value && typeof value === 'object') {
    return String(
      value.text || value.name || value.value || value.id || '',
    ).trim();
  }
  return String(value || '').trim();
}

function requireRecordId(value) {
  const result = String(value || '').trim();
  if (!RECORD_ID_PATTERN.test(result)) fail(`记录 ID 无效：${result}`);
  return result;
}

function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return '';
}

function openApiBaseUrl() {
  const configured = firstEnv('LARK_OPENAPI_BASE_URL') || OPENAPI_BASE_URL;
  const parsed = new URL(configured);
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
    parsed.hostname.toLowerCase(),
  );
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('LARK_OPENAPI_BASE_URL 无效');
  }
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && loopback)
  ) {
    fail('LARK_OPENAPI_BASE_URL 必须是 HTTPS 或本机回环地址');
  }
  return configured.replace(/\/+$/u, '');
}

function safeMessage(error) {
  return String(error instanceof Error ? error.message : error || 'unknown')
    .replace(/[\r\n\t]/gu, ' ')
    .slice(0, 300);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
