#!/usr/bin/env node

import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { HttpService } = require('@nestjs/axios');
const { AttendanceAutomationFeishuGateway } = require(
  resolve(
    process.cwd(),
    'dist/server/modules/duty-schedule/attendance-automation-feishu.gateway.js',
  ),
);
const { buildAttendanceAnomalyCard } = require(
  resolve(
    process.cwd(),
    'dist/server/modules/duty-schedule/attendance-automation.card.js',
  ),
);
const { buildAttendanceAutomationIdempotencyKey } = require(
  resolve(
    process.cwd(),
    'dist/server/modules/duty-schedule/attendance-automation.scheduler.js',
  ),
);

main().catch((error) => {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const businessDate =
    readDateArgument(process.argv.slice(2)) || yesterdayInShanghai();
  const managerName =
    process.env.FEISHU_ATTENDANCE_MANAGER_NAME?.trim() || '马进宇';
  const gateway = new AttendanceAutomationFeishuGateway(new HttpService());
  const summary = await gateway.readArchivedAttendanceSummary(businessDate);
  const managerAnomalies = summary.anomalies.filter(
    (anomaly) => anomaly.building !== '110站',
  );
  const buildings = [
    ...new Set([
      ...summary.anomalies.map((anomaly) => anomaly.building),
      ...Object.keys(summary.normalByBuilding),
    ]),
  ];
  if (buildings.length === 0) {
    throw new Error(`${businessDate} 的考勤归档多维表没有可核验记录`);
  }
  const recipients = await gateway.resolveRecipients('morning-off-duty-check', [
    ...buildings,
  ]);
  const managers = recipients.filter(
    (recipient) =>
      recipient.scope === 'manager' && recipient.name.trim() === managerName,
  );
  if (managers.length !== 1) {
    throw new Error(
      `机房经理收件人必须唯一，当前解析到 ${managers.length} 个“${managerName}”`,
    );
  }
  const normalCount = Object.entries(summary.normalByBuilding).reduce(
    (total, [building, count]) =>
      total + (building === '110站' ? 0 : Number(count) || 0),
    0,
  );
  const card = buildAttendanceAnomalyCard({
    date: businessDate,
    fetchedAt: summary.fetchedAt,
    label: '测试 · 09:05 · 昨日考勤',
    summaryPeriod: 'yesterday',
    dueSlots: ['00:30 归档'],
    futureSlots: [],
    anomalies: managerAnomalies,
    normalCount,
    scheduleUrl: buildScheduleUrl(),
  });
  const manager = managers[0];
  const messageId = await gateway.sendCard(
    manager.openId,
    card,
    buildAttendanceAutomationIdempotencyKey(
      'archive-yesterday',
      businessDate,
      `manager-test:${manager.openId}`,
    ),
  );
  process.stdout.write(
    `${JSON.stringify({
      success: true,
      businessDate,
      manager: manager.name,
      anomalies: managerAnomalies.length,
      messageId,
      dingTalkAttendanceApiCalls: 0,
    })}\n`,
  );
}

function readDateArgument(args) {
  const index = args.indexOf('--date');
  if (index < 0) return '';
  const value = args[index + 1]?.trim() || '';
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error('--date 必须是 YYYY-MM-DD');
  }
  return value;
}

function yesterdayInShanghai() {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  now.setUTCDate(now.getUTCDate() - 1);
  return now.toISOString().slice(0, 10);
}

function buildScheduleUrl() {
  const raw = process.env.PUBLIC_BASE_URL?.trim();
  if (!raw) throw new Error('缺少 PUBLIC_BASE_URL');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('PUBLIC_BASE_URL 必须是无凭据 HTTPS 地址');
  }
  const publicPath = url.pathname.replace(/^\/+|\/+$/gu, '');
  const clientPath = (process.env.CLIENT_BASE_PATH || '')
    .trim()
    .replace(/^\/+|\/+$/gu, '');
  url.pathname = `/${[publicPath, clientPath, 'monthly-schedule']
    .filter(Boolean)
    .join('/')}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}
