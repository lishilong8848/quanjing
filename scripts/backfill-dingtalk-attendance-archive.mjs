#!/usr/bin/env node

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import axios from 'axios';

const require = createRequire(import.meta.url);
const MAX_CORRECTION_QUERY_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_CORRECTION_APPROVALS_PER_RUN = 19;

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const now = new Date();
  const options = parseBackfillOptions(process.argv.slice(2), now);
  const today = shanghaiDateKey(now);
  if (options.through > today) {
    throw new Error(`--through 不能晚于今天 ${today}`);
  }
  const dates = dateRange(options.from, options.through);
  if (!options.auditOnly && dates.length > 7) {
    throw new Error('单次补数范围不能超过 7 天，避免超出钉钉考勤接口时间窗');
  }
  if (options.auditOnly) {
    const records = options.recordListFile
      ? extractRecords(
          JSON.parse(await readFile(options.recordListFile, 'utf8')),
        )
      : await listAttendanceArchiveRecords();
    const coverage = dates.map((date) => ({
      date,
      resultRows: records.filter(
        (record) =>
          shanghaiDateFromValue(record?.fields?.['工作日期']) === date &&
          display(record?.fields?.['记录类型']) === '考勤结果',
      ).length,
    }));
    const staleStatusByDate = dates.map((date) => ({
      date,
      rows: records.filter(
        (record) =>
          shanghaiDateFromValue(record?.fields?.['工作日期']) === date &&
          display(record?.fields?.['记录类型']) === '考勤结果' &&
          hasStaleMissingStatus(record?.fields || {}),
      ).length,
    }));
    process.stdout.write(
      `${JSON.stringify({
        success: true,
        mode: 'audit-only',
        from: options.from,
        through: options.through,
        coverage,
        missingDates: coverage
          .filter((item) => item.resultRows === 0)
          .map((item) => item.date),
        staleStatusWithActual: {
          total: staleStatusByDate.reduce((sum, item) => sum + item.rows, 0),
          byDate: staleStatusByDate,
        },
      })}\n`,
    );
    return;
  }
  if (options.recordListFile) {
    throw new Error('--record-list-file 仅支持 --audit-only');
  }

  const { HttpService } = require('@nestjs/axios');
  const { DingTalkAttendanceClient } = require(
    resolve(
      process.cwd(),
      'dist/server/modules/duty-schedule/dingtalk-attendance.client.js',
    ),
  );
  const { AttendanceAutomationFeishuGateway } = require(
    resolve(
      process.cwd(),
      'dist/server/modules/duty-schedule/attendance-automation-feishu.gateway.js',
    ),
  );
  const { DutyScheduleService } = require(
    resolve(
      process.cwd(),
      'dist/server/modules/duty-schedule/duty-schedule.service.js',
    ),
  );
  const { buildDailyAttendanceExpectationPlan } = require(
    resolve(
      process.cwd(),
      'dist/server/modules/duty-schedule/attendance-automation.expectations.js',
    ),
  );
  const { deriveAttendanceResults } = require(
    resolve(
      process.cwd(),
      'dist/server/modules/duty-schedule/attendance-automation-coordinator.service.js',
    ),
  );
  const httpService = new HttpService();
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const dutyScheduleService = new DutyScheduleService(null, httpService);
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  const schedules = await dutyScheduleService.getDutySchedules(
    shiftDate(options.from, -1),
    options.through,
  );
  const longWhiteByDate = new Map(
    await Promise.all(
      dates.map(async (date) => {
        const response = await dutyScheduleService.getLongWhiteDutyStaff(
          date,
          false,
        );
        return [
          date,
          Array.isArray(response?.buildings) ? response.buildings : [],
        ];
      }),
    ),
  );
  if (schedules.length === 0) {
    throw new Error('排班页面没有返回补数范围内的排班数据');
  }

  const dingTalkClient = new DingTalkAttendanceClient(httpService);
  const users = await dingTalkClient.listAllUsers();
  const queryEnd =
    options.through === today
      ? shanghaiDateTime(now)
      : `${options.through} 23:59:59`;
  const details = await dingTalkClient.listAttendanceDetails({
    start: `${options.from} 00:00:00`,
    end: queryEnd,
    userIds: users.map((user) => user.userId),
  });
  const gateway = new AttendanceAutomationFeishuGateway(httpService);
  const cutoffMillis = parseShanghaiDateTime(queryEnd);
  const correctionQuery = buildCorrectionApprovalQuery(options, now);
  const { archived, correctionApprovals } =
    await archiveBackfillWithCorrectionApprovals({
      dates,
      correctionQuery,
      dingTalkClient,
      gateway,
      async buildArchiveInput(date, corrections) {
        const plan = buildDailyAttendanceExpectationPlan({
          date,
          schedules,
          longWhiteBuildings: longWhiteByDate.get(date) || [],
        });
        const expectations = plan.expectations.filter(
          (expectation) =>
            date !== today ||
            parseShanghaiDateTime(expectation.expectedAt) <= cutoffMillis,
        );
        if (expectations.length === 0) {
          throw new Error(`${date} 没有已到期的应打卡事件，停止补数`);
        }
        const dateDetails = details.filter(
          (detail) => shanghaiDateFromValue(detail.userCheckTime) === date,
        );
        const results = deriveAttendanceResults(
          expectations,
          users,
          details,
          [],
          corrections,
        );
        return {
          input: {
            businessDate: date,
            users,
            results,
            details: dateDetails,
          },
          audit: {
            date,
            expected: expectations.length,
            detailRecords: dateDetails.length,
          },
        };
      },
    });

  process.stdout.write(
    `${JSON.stringify({
      success: true,
      from: options.from,
      through: options.through,
      queryEnd,
      directoryUsers: users.length,
      attendanceApiCalls: Math.ceil(users.length / 50),
      detailRecords: details.length,
      correctionApprovals,
      archived,
    })}\n`,
  );
}

export async function archiveBackfillWithCorrectionApprovals({
  dates,
  correctionQuery,
  dingTalkClient,
  gateway,
  buildArchiveInput,
}) {
  assertBoundedCorrectionQuery(correctionQuery);
  let fetched;
  try {
    fetched = await dingTalkClient.listCorrectionApprovals(correctionQuery);
  } catch (error) {
    throw new Error(
      `补卡审批查询失败（${correctionQuery.start} 至 ${correctionQuery.end}）：${safeError(error)}；尚未写入飞书`,
      { cause: error },
    );
  }
  const uniqueByInstanceId = new Map();
  let missingProcessInstanceIds = 0;
  for (const correction of fetched) {
    const processInstanceId = String(
      correction?.processInstanceId || '',
    ).trim();
    if (!processInstanceId) {
      missingProcessInstanceIds += 1;
      continue;
    }
    uniqueByInstanceId.set(processInstanceId, correction);
  }
  if (missingProcessInstanceIds > 0) {
    throw new Error(
      `补卡审批列表返回 ${missingProcessInstanceIds} 条缺少 processInstanceId 的记录；尚未写入飞书`,
    );
  }
  if (uniqueByInstanceId.size > MAX_CORRECTION_APPROVALS_PER_RUN) {
    throw new Error(
      `补卡审批实例 ${uniqueByInstanceId.size} 条，超过单次安全上限 ${MAX_CORRECTION_APPROVALS_PER_RUN} 条；尚未写入飞书，请缩小审批查询区间`,
    );
  }

  const dateSet = new Set(dates);
  const correctionsByDate = new Map(dates.map((date) => [date, []]));
  let inScope = 0;
  let outOfScope = 0;
  for (const correction of uniqueByInstanceId.values()) {
    const businessDate = shanghaiDateFromValue(
      correction.workDate ?? correction.correctionTime,
    );
    if (!dateSet.has(businessDate)) {
      outOfScope += 1;
      continue;
    }
    correctionsByDate.get(businessDate).push(correction);
    inScope += 1;
  }

  const archived = [];
  for (const date of dates) {
    const corrections = correctionsByDate.get(date) || [];
    const prepared = await buildArchiveInput(date, corrections);
    const result = await gateway.archiveAttendance({
      ...prepared.input,
      corrections,
    });
    archived.push({
      ...prepared.audit,
      correctionApprovals: corrections.length,
      ...result,
    });
  }

  return {
    correctionApprovals: {
      query: correctionQuery,
      fetched: fetched.length,
      unique: uniqueByInstanceId.size,
      duplicates: fetched.length - uniqueByInstanceId.size,
      inScope,
      outOfScope,
      byDate: dates.map((date) => ({
        date,
        count: correctionsByDate.get(date)?.length || 0,
      })),
    },
    archived,
  };
}

function assertBoundedCorrectionQuery(query) {
  const start = parseShanghaiDateTime(String(query?.start || ''));
  const end = parseShanghaiDateTime(String(query?.end || ''));
  if (start > end) {
    throw new Error('补卡审批查询开始时间不能晚于结束时间');
  }
  if (end - start > MAX_CORRECTION_QUERY_WINDOW_MS) {
    throw new Error('补卡审批查询区间不能超过 31 天');
  }
}

export function parseBackfillOptions(args, now = new Date()) {
  const today = shanghaiDateKey(now);
  const from = readOption(args, '--from') || '2026-08-31';
  const through = readOption(args, '--through') || today;
  const options = {
    from,
    through,
    correctionFrom: readOption(args, '--correction-from') || from,
    correctionThrough: readOption(args, '--correction-through') || through,
    auditOnly: args.includes('--audit-only'),
    recordListFile: readOption(args, '--record-list-file'),
  };
  assertDateKey(options.from, '--from');
  assertDateKey(options.through, '--through');
  assertDateKey(options.correctionFrom, '--correction-from');
  assertDateKey(options.correctionThrough, '--correction-through');
  if (options.from > options.through) {
    throw new Error('--from 不能晚于 --through');
  }
  if (options.correctionFrom > options.correctionThrough) {
    throw new Error('--correction-from 不能晚于 --correction-through');
  }
  if (options.correctionThrough > today) {
    throw new Error(`--correction-through 不能晚于今天 ${today}`);
  }
  return options;
}

export function buildCorrectionApprovalQuery(options, now = new Date()) {
  const today = shanghaiDateKey(now);
  return {
    start: `${options.correctionFrom} 00:00:00`,
    end:
      options.correctionThrough === today
        ? shanghaiDateTime(now)
        : `${options.correctionThrough} 23:59:59`,
  };
}

async function listAttendanceArchiveRecords() {
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) throw new Error('缺少飞书只读审计凭据');
  const appToken =
    process.env.FEISHU_ATTENDANCE_ARCHIVE_APP_TOKEN?.trim() ||
    'PUBLIC_EXAMPLE_FEISHU_MAIN_APP_TOKEN';
  const tableId =
    process.env.FEISHU_ATTENDANCE_ARCHIVE_TABLE_ID?.trim() ||
    'tbl01cda9acd2f8f';
  const baseUrl = 'https://open.feishu.cn/open-apis';
  const tokenResponse = await axios.post(
    `${baseUrl}/auth/v3/tenant_access_token/internal`,
    { app_id: appId, app_secret: appSecret },
    { timeout: 30_000 },
  );
  assertOpenApiSuccess(tokenResponse.data, '获取租户令牌');
  const token = String(tokenResponse.data?.tenant_access_token || '').trim();
  if (!token) throw new Error('飞书只读审计未取得租户令牌');
  const records = [];
  const seen = new Set();
  let pageToken = '';
  for (let page = 0; page < 100; page += 1) {
    const response = await axios.post(
      `${baseUrl}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/search`,
      {
        field_names: [
          '工作日期',
          '记录类型',
          '实际打卡时间',
          '时间状态',
          '上班打卡时间',
          '下班打卡时间',
          '上班状态',
          '下班状态',
        ],
      },
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { page_size: 500, page_token: pageToken || undefined },
        timeout: 30_000,
      },
    );
    assertOpenApiSuccess(response.data, '读取考勤归档记录');
    records.push(...extractRecords(response.data));
    if (!response.data?.data?.has_more) return records;
    const next = String(response.data?.data?.page_token || '').trim();
    if (!next || seen.has(next)) throw new Error('飞书分页令牌为空或重复');
    seen.add(next);
    pageToken = next;
  }
  throw new Error('飞书只读审计超过分页安全上限');
}

function extractRecords(value) {
  if (Array.isArray(value)) return value;
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

function assertOpenApiSuccess(value, operation) {
  if (Number(value?.code || 0) !== 0) {
    throw new Error(
      `${operation}失败：code=${String(value?.code)}, msg=${String(value?.msg || '')}`,
    );
  }
}

function display(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(display).filter(Boolean).join('');
  if (typeof value === 'object')
    return display(value.text ?? value.value ?? value.name ?? '');
  return String(value).trim();
}

function hasStaleMissingStatus(fields) {
  return (
    (hasDateValue(fields['实际打卡时间']) &&
      isMissingStatus(fields['时间状态'])) ||
    (hasDateValue(fields['上班打卡时间']) &&
      isMissingStatus(fields['上班状态'])) ||
    (hasDateValue(fields['下班打卡时间']) &&
      isMissingStatus(fields['下班状态']))
  );
}

function hasDateValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  return Boolean(display(value));
}

function isMissingStatus(value) {
  return ['未打卡', '旷工'].includes(display(value));
}

function readOption(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || '').trim() : '';
}

function dateRange(from, through) {
  const result = [];
  for (let date = from; date <= through; date = shiftDate(date, 1)) {
    result.push(date);
  }
  return result;
}

function assertDateKey(value, optionName) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`${optionName} 必须是 YYYY-MM-DD`);
  }
}

function shiftDate(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

function shanghaiDateKey(value) {
  return new Date(value.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function shanghaiDateTime(value) {
  return new Date(value.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

function parseShanghaiDateTime(value) {
  const parsed = Date.parse(value.replace(' ', 'T') + '+08:00');
  if (!Number.isFinite(parsed)) throw new Error(`无效上海时间：${value}`);
  return parsed;
}

function shanghaiDateFromValue(value) {
  if (value === null || value === undefined || value === '') return '';
  const parsed =
    typeof value === 'number'
      ? value
      : /^\d+$/u.test(String(value))
        ? Number(value)
        : Date.parse(
            /(?:Z|[+-]\d{2}:?\d{2})$/iu.test(String(value))
              ? String(value)
              : String(value).replace(' ', 'T') + '+08:00',
          );
  return Number.isFinite(parsed)
    ? new Date(parsed + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : '';
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}
