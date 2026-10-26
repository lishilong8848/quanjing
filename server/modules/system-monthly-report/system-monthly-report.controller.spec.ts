import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('system monthly report controller access boundary', () => {
  const source = readFileSync(
    resolve(
      process.cwd(),
      'server/modules/system-monthly-report/system-monthly-report.controller.ts',
    ),
    'utf8',
  );
  const serviceSource = readFileSync(
    resolve(
      process.cwd(),
      'server/modules/system-monthly-report/system-monthly-report.service.ts',
    ),
    'utf8',
  );

  it('allows guarded guest entry only for identity changes and scoped business writes', () => {
    for (const route of [
      "@Post('identity-session')",
      "@Post('identity-session/logout')",
      "@Post('submissions')",
      "@Post('submissions/delete')",
      "@Post('reviews')",
    ]) {
      expect(source).toMatch(
        new RegExp(
          `@GuestSubmittable\\(\\)[\\s\\S]{0,100}${escapeRegex(route)}`,
          'u',
        ),
      );
    }
  });

  it('uses an HttpOnly bounded module cookie and never exposes a person Open ID', () => {
    expect(source).toMatch(/vnet_system_monthly_report_identity/u);
    expect(source).toMatch(/httpOnly:\s*true/u);
    expect(source).toMatch(/sameSite:\s*'lax'/u);
    expect(source).toMatch(
      /IDENTITY_COOKIE_PATH\s*=\s*'\/api\/system-monthly-report'/u,
    );
    expect(source).toMatch(/path:\s*IDENTITY_COOKIE_PATH/u);
    expect(source).toMatch(/maxAge:/u);
    expect(source).not.toMatch(
      /person\.openId[\s\S]{0,80}(?:json|send|return)/iu,
    );
  });

  it('resolves a server-side subject for dashboards, submissions, reviews, tasks and downloads', () => {
    expect(source).toMatch(/resolveSubject\(/u);
    expect(source).toMatch(/projectSystemMonthlyReportDashboard\(/u);
    expect(source).toMatch(/acceptSubmission\([\s\S]*subject/u);
    expect(source).toMatch(/acceptSubmissionDeletion\([\s\S]*subject/u);
    expect(source).toMatch(/acceptReview\([\s\S]*subject/u);
    expect(source).toMatch(/getTask\(taskId,\s*subject\)/u);
    expect(source).toMatch(
      /getArchiveDownload\(archiveId,\s*subject,\s*dashboard\)/u,
    );
    expect(source).toMatch(
      /getArchivePreview\(archiveId,\s*subject,\s*dashboard\)/u,
    );
  });

  it('keeps package creation, polling, download and retry privileged', () => {
    expect(source).toMatch(/requirePrivilegedSubject\(/u);
    expect(source).toMatch(/acceptPackage\([\s\S]*privilegedSubject/u);
    expect(source).toMatch(/getPackageTask\(taskId,\s*privilegedSubject\)/u);
    expect(source).toMatch(
      /getPackageDownload\(taskId,\s*privilegedSubject\)/u,
    );
    expect(source).toMatch(/retryPackage\(taskId,\s*privilegedSubject\)/u);
  });

  it('uses the shared 150 MiB report limit at both request boundaries', () => {
    expect(source).toContain('SYSTEM_MONTHLY_REPORT_MAX_REPORT_BYTES');
    expect(source).toMatch(
      /fileSize:\s*SYSTEM_MONTHLY_REPORT_MAX_REPORT_BYTES/u,
    );
    expect(serviceSource).toContain('SYSTEM_MONTHLY_REPORT_MAX_REPORT_BYTES');
    expect(source).not.toContain('fileSize: 50 * 1024 * 1024');
    expect(serviceSource).not.toContain('MAX_REPORT_BYTES = 50 * 1024 * 1024');
  });

  it('canonicalizes the upload name on the server before staging and syncing', () => {
    expect(serviceSource).toContain('normalizeSystemMonthlyReportSubmission');
    expect(serviceSource).not.toContain(
      'file.originalname !== request.versionedFileName',
    );
  });

  it('authorizes task recovery through the stable person ownership helper', () => {
    expect(serviceSource).toContain('isSystemMonthlyReportTaskOwner');
  });
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
