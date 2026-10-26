#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken';
const DEPARTMENT_URL = 'https://oapi.dingtalk.com/topapi/v2/department/listsub';
const USER_URL = 'https://oapi.dingtalk.com/topapi/v2/user/list';
const RESULT_URL = 'https://oapi.dingtalk.com/attendance/list';
const DETAIL_URL = 'https://oapi.dingtalk.com/attendance/listRecord';
const REQUEST_TIMEOUT_MS = 30_000;
const USER_BATCH_SIZE = 50;
const MAX_RESULT_PAGES_PER_BATCH = 200;

const HELP = `DingTalk attendance CLI

Usage:
  node scripts/dingtalk-attendance-cli.mjs --self-test
  node scripts/dingtalk-attendance-cli.mjs --mode result|detail --from "YYYY-MM-DD HH:mm:ss" --to "YYYY-MM-DD HH:mm:ss" (--all-users | --users id1,id2) [--output file.json]

Options:
  --self-test          Validate credentials only; consumes no attendance quota.
  --mode result|detail Attendance result or raw punch detail. Default: result.
  --from VALUE         Shanghai local start time. Default: today 00:00:00.
  --to VALUE           Shanghai local end time. Default: today 23:59:59.
  --all-users          Query all visible company users.
  --users VALUE        Comma/space-separated DingTalk user IDs.
  --output PATH        Write JSON to a file instead of stdout.
  --help               Show this help.

Credentials are read from DINGTALK_ATTENDANCE_CLIENT_ID and
DINGTALK_ATTENDANCE_CLIENT_SECRET in the process, .env, or .env.local.
`;

main().catch((error) => {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  loadEnvironment(resolve(process.cwd(), '.env'));
  loadEnvironment(resolve(process.cwd(), '.env.local'));
  const credentials = readCredentials();
  const token = await getAccessToken(credentials);

  if (options.selfTest) {
    process.stdout.write(
      `${JSON.stringify({
        authenticated: true,
        attendanceApiCalls: 0,
        mode: 'credential-only',
      })}\n`,
    );
    return;
  }

  const users = options.allUsers ? await listAllUsers(token) : [];
  const userIds = options.allUsers
    ? users.map((user) => user.userId)
    : normalizeUserIds(options.userIds);
  if (!userIds.length) {
    throw new Error('Use --all-users or provide at least one ID with --users.');
  }
  const date = shanghaiDateKey(new Date());
  const query = {
    start: options.start || `${date} 00:00:00`,
    end: options.end || `${date} 23:59:59`,
    userIds,
  };
  assertLocalDateTime(query.start, '--from');
  assertLocalDateTime(query.end, '--to');
  const records =
    options.mode === 'detail'
      ? await listAttendanceDetails(token, query)
      : await listAttendanceResults(token, query);
  const payload = `${JSON.stringify(records, null, 2)}\n`;
  if (options.output) {
    const outputPath = resolve(options.output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, payload, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(
      `${JSON.stringify({ mode: options.mode, records: records.length, output: outputPath })}\n`,
    );
  } else {
    process.stdout.write(payload);
  }
}

function parseArguments(args) {
  const options = {
    help: false,
    selfTest: false,
    mode: 'result',
    start: '',
    end: '',
    allUsers: false,
    userIds: [],
    output: '',
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--self-test') options.selfTest = true;
    else if (argument === '--all-users') options.allUsers = true;
    else if (argument === '--mode')
      options.mode = requireValue(args, ++index, '--mode');
    else if (argument === '--from')
      options.start = requireValue(args, ++index, '--from');
    else if (argument === '--to')
      options.end = requireValue(args, ++index, '--to');
    else if (argument === '--users') {
      options.userIds.push(
        ...requireValue(args, ++index, '--users').split(/[\s,，;；]+/u),
      );
    } else if (argument === '--output') {
      options.output = requireValue(args, ++index, '--output');
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!['result', 'detail'].includes(options.mode)) {
    throw new Error('--mode must be result or detail.');
  }
  if (options.allUsers && options.userIds.length) {
    throw new Error('--all-users and --users cannot be used together.');
  }
  return options;
}

function requireValue(args, index, name) {
  const value = args[index];
  if (!value || value.startsWith('--'))
    throw new Error(`${name} requires a value.`);
  return value;
}

function loadEnvironment(path) {
  let content = '';
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u);
    if (!match || process.env[match[1]]?.trim()) continue;
    process.env[match[1]] = parseEnvironmentValue(match[2]);
  }
}

function parseEnvironmentValue(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/u, '').trim();
}

function readCredentials() {
  const appKey =
    process.env.DINGTALK_ATTENDANCE_CLIENT_ID?.trim() ||
    process.env.DINGTALK_ATTENDANCE_APP_KEY?.trim();
  const appSecret =
    process.env.DINGTALK_ATTENDANCE_CLIENT_SECRET?.trim() ||
    process.env.DINGTALK_ATTENDANCE_APP_SECRET?.trim();
  if (!appKey || !appSecret) {
    throw new Error(
      'Missing DingTalk attendance credentials in environment variables.',
    );
  }
  return { appKey, appSecret };
}

async function getAccessToken(credentials) {
  const data = await requestJson(TOKEN_URL, credentials);
  const token = text(data.accessToken);
  if (!token)
    throw new Error('DingTalk token response did not contain accessToken.');
  return token;
}

async function listAllUsers(token) {
  const departmentQueue = [1];
  const visitedDepartments = new Set();
  const users = new Map();
  while (departmentQueue.length) {
    const departmentId = departmentQueue.shift();
    if (!departmentId || visitedDepartments.has(departmentId)) continue;
    visitedDepartments.add(departmentId);
    const departments = await requestOapi(DEPARTMENT_URL, token, {
      dept_id: departmentId,
      language: 'zh_CN',
    });
    for (const item of Array.isArray(departments.result)
      ? departments.result
      : []) {
      const childId = Number(item?.dept_id);
      if (childId > 0 && !visitedDepartments.has(childId))
        departmentQueue.push(childId);
    }
    let cursor = 0;
    while (true) {
      const response = await requestOapi(USER_URL, token, {
        dept_id: departmentId,
        cursor,
        size: 100,
        language: 'zh_CN',
        contain_access_limit: false,
      });
      const result = asObject(response.result);
      for (const item of Array.isArray(result.list) ? result.list : []) {
        const userId = text(item?.userid ?? item?.userId);
        const name = text(item?.name);
        if (userId && name) users.set(userId, { userId, name });
      }
      if (!Boolean(result.has_more ?? result.hasMore)) break;
      const nextCursor = Number(result.next_cursor ?? result.nextCursor);
      if (!Number.isFinite(nextCursor) || nextCursor === cursor) break;
      cursor = nextCursor;
    }
  }
  if (!users.size)
    throw new Error('DingTalk directory returned no visible users.');
  return [...users.values()];
}

async function listAttendanceResults(token, query) {
  const records = [];
  for (const userIds of chunks(
    normalizeUserIds(query.userIds),
    USER_BATCH_SIZE,
  )) {
    let offset = 0;
    let pageCount = 0;
    const pageFingerprints = new Set();
    while (true) {
      pageCount += 1;
      if (pageCount > MAX_RESULT_PAGES_PER_BATCH) {
        throw new Error(
          `DingTalk attendance result pagination exceeded ${MAX_RESULT_PAGES_PER_BATCH} pages for one user batch.`,
        );
      }
      const response = await requestOapi(RESULT_URL, token, {
        workDateFrom: query.start,
        workDateTo: query.end,
        userIdList: userIds,
        offset,
        limit: 50,
        isI18n: false,
      });
      const nested = asObject(response.result);
      const items = Array.isArray(response.recordresult)
        ? response.recordresult
        : Array.isArray(nested.recordresult)
          ? nested.recordresult
          : [];
      const hasMore = Boolean(response.hasMore ?? response.has_more);
      if (hasMore && items.length === 0) {
        throw new Error(
          'DingTalk attendance result pagination returned an empty page with hasMore=true.',
        );
      }
      const fingerprint = JSON.stringify(items);
      if (hasMore && pageFingerprints.has(fingerprint)) {
        throw new Error(
          'DingTalk attendance result pagination repeated a page; further requests were stopped.',
        );
      }
      pageFingerprints.add(fingerprint);
      records.push(...items);
      if (!hasMore) break;
      offset += 50;
    }
  }
  return records;
}

async function listAttendanceDetails(token, query) {
  const records = [];
  for (const userIds of chunks(
    normalizeUserIds(query.userIds),
    USER_BATCH_SIZE,
  )) {
    const response = await requestOapi(DETAIL_URL, token, {
      checkDateFrom: query.start,
      checkDateTo: query.end,
      userIds,
      isI18n: false,
    });
    const items = Array.isArray(response.recordresult)
      ? response.recordresult
      : Array.isArray(response.result)
        ? response.result
        : [];
    records.push(...items);
  }
  return records;
}

async function requestOapi(url, token, body) {
  const target = new URL(url);
  target.searchParams.set('access_token', token);
  const data = await requestJson(target, body);
  const errorCode = Number(data.errcode || 0);
  if (errorCode !== 0) {
    throw new Error(
      `DingTalk API failed (${errorCode}): ${text(data.errmsg) || 'unknown error'}`,
    );
  }
  return data;
}

async function requestJson(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${text(data?.message ?? data?.errmsg) || 'request failed'}`,
      );
    }
    return asObject(data);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeUserIds(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function text(value) {
  return String(value ?? '').trim();
}

function assertLocalDateTime(value, name) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)) {
    throw new Error(`${name} must use YYYY-MM-DD HH:mm:ss.`);
  }
}

function shanghaiDateKey(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(
      /(app[_-]?secret|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s,;}&]+/giu,
      '$1=***',
    )
    .replace(/[\r\n\t]/gu, ' ')
    .slice(0, 500);
}
