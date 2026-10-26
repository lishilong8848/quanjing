import { NestFactory } from '@nestjs/core';

process.env.FORCE_AUTHN_INNERAPI_DOMAIN ||= 'http://localhost:3001';
process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true';

const { AppModule } = await import('../dist/server/app.module.js');
const { ContractCreationService } = await import(
  '../dist/server/modules/contract-management/contract-creation.service.js'
);
const { AccessConfigurationService } = await import('../dist/server/common/access/access-configuration.service.js');
const accountId = process.env.CONTRACT_SELF_TEST_ACCOUNT_ID?.trim();
const authorizationVersion = Number(process.env.CONTRACT_SELF_TEST_AUTHORIZATION_VERSION);
if (!accountId || !Number.isSafeInteger(authorizationVersion) || authorizationVersion < 1) {
  throw new Error('请通过 CONTRACT_SELF_TEST_ACCOUNT_ID 和 CONTRACT_SELF_TEST_AUTHORIZATION_VERSION 指定当前管理员授权');
}

const app = await NestFactory.createApplicationContext(AppModule, {
  logger: ['error', 'warn'],
  abortOnError: false,
});

try {
  const service = app.get(ContractCreationService);
  const principal = app.get(AccessConfigurationService).currentPrincipal(accountId, authorizationVersion);
  if (principal?.role !== 'admin') throw new Error('合同真实自测需要当前有效的管理员授权');
  const marker = `CODEX-SELFTEST-${Date.now()}`;
  const buffer = buildOnePagePdf(marker);
  const result = await service.runRealSelfTest({
    originalname: `${marker}.pdf`,
    mimetype: 'application/pdf',
    size: buffer.length,
    buffer,
  }, principal);
  process.stdout.write(
    `${JSON.stringify({
      ok: result.ok,
      recordId: result.recordId,
      baseVerified: result.baseVerified,
      cosReady: result.cosReady,
      notification: {
        attempted: result.notification.attempted,
        recipients: result.notification.recipients,
        sent: result.notification.sent,
        failed: result.notification.failed,
      },
      cleanup: result.cleanup,
    })}\n`,
  );
} finally {
  await app.close();
}

function buildOnePagePdf(label) {
  const safeLabel = label.replace(/[()\\]/g, '');
  const stream = `BT /F1 12 Tf 72 760 Td (${safeLabel}) Tj 0 -22 Td (Created for contract workflow verification and automatic cleanup.) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let content = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(content, 'latin1'));
    content += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(content, 'latin1');
  content += `xref\n0 ${objects.length + 1}\n`;
  content += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    content += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  content += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(content, 'latin1');
}
