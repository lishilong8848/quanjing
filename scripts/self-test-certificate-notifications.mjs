import { createHash } from 'node:crypto';
import { HttpService } from '@nestjs/axios';

process.env.FORCE_AUTHN_INNERAPI_DOMAIN ||= 'http://localhost:3001';
process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true';

const args = new Set(process.argv.slice(2));
const sendExpiry = args.has('--send-expiry');
const sendSelfTest = args.has('--send-self-test');
const diagnose = args.has('--diagnose');
const confirmsLiveSend = args.has('--confirm-live-send');

if ((sendExpiry || sendSelfTest) && !confirmsLiveSend) {
  throw new Error('真实发送必须显式提供 --confirm-live-send');
}

const { CertificateDashboardService } =
  await import('../dist/server/modules/bitable-sync/certificate-dashboard.service.js');
const { CertificateDashboardNotificationService } =
  await import('../dist/server/modules/bitable-sync/certificate-dashboard-notification.service.js');

let output = null;

try {
  const httpService = new HttpService();
  const dashboardService = new CertificateDashboardService(httpService);
  const service = new CertificateDashboardNotificationService(
    httpService,
    dashboardService,
  );
  const preview = await service.previewExpiryNotifications();
  const diagnostics = diagnose
    ? buildDirectoryDiagnostics(
        await service.getGroupMembers(),
        preview.people.map((person) => person.name),
      )
    : null;
  const expiry = sendExpiry
    ? await service.sendExpiryNotifications({
        requestId: preview.requestId,
      })
    : null;
  let selfTest = null;

  if (sendSelfTest) {
    try {
      selfTest = await service.sendSelfTestSuccess(
        '示例人员020',
        stableKey(`certificate-self-test:${shanghaiDateKey(new Date())}`),
      );
    } catch (error) {
      selfTest = {
        success: false,
        name: '示例人员020',
        error: safeErrorMessage(error),
      };
    }
  }

  output = {
    ok:
      !preview.blocked &&
      preview.matchedCount === preview.totalPeople &&
      preview.unmatchedNames.length === 0 &&
      preview.ambiguousNames.length === 0 &&
      (!expiry || expiry.success) &&
      (!selfTest || selfTest.success),
    mode: sendExpiry || sendSelfTest ? 'live-send' : 'preview',
    preview: {
      totalPeople: preview.totalPeople,
      matchedCount: preview.matchedCount,
      unmatchedCount: preview.unmatchedNames.length,
      ambiguousCount: preview.ambiguousNames.length,
      blocked: preview.blocked,
      blockedReason: preview.blockedReason,
      sourceUpdatedAt: preview.sourceUpdatedAt,
      syncedAt: preview.syncedAt,
    },
    diagnostics,
    expiry: expiry
      ? {
          success: expiry.success,
          attemptedCount: expiry.attemptedCount,
          sentCount: expiry.sentCount,
          failedCount: expiry.failedCount,
          unmatchedNames: expiry.unmatchedNames,
          ambiguousNames: expiry.ambiguousNames,
          failures: expiry.failures.map(({ name, message }) => ({
            name,
            message,
          })),
          sentAt: expiry.sentAt,
        }
      : null,
    selfTest,
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (!output.ok) process.exitCode = 1;
} catch (error) {
  output = {
    ok: false,
    mode: sendExpiry || sendSelfTest ? 'live-send' : 'preview',
    error: safeErrorMessage(error),
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = 1;
}

function stableKey(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function shanghaiDateKey(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

function safeErrorMessage(error) {
  const message =
    error instanceof Error ? error.message : String(error || '执行失败');
  return message
    .replace(
      /(app_secret|tenant_access_token|authorization|token)\s*[:=]\s*[^\s,;]+/gi,
      '$1=***',
    )
    .slice(0, 300);
}

function buildDirectoryDiagnostics(members, expiryNames) {
  const names = members.map((member) => normalizePersonName(member.name));
  return {
    directoryMemberCount: members.length,
    expiryNameMatchCounts: expiryNames.map(
      (name) =>
        names.filter((candidate) => candidate === normalizePersonName(name))
          .length,
    ),
    selfTestNameMatchCount: names.filter(
      (candidate) => candidate === normalizePersonName('示例人员020'),
    ).length,
  };
}

function normalizePersonName(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .toLocaleLowerCase('zh-CN');
}
