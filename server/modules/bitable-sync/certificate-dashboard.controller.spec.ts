import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const controllerSource = readFileSync(
  join(process.cwd(), 'server/modules/bitable-sync/bitable-sync.controller.ts'),
  'utf8',
);
const moduleSource = readFileSync(
  join(process.cwd(), 'server/modules/bitable-sync/bitable-sync.module.ts'),
  'utf8',
);

function getMethodBlock(methodName: string): string {
  const start = controllerSource.indexOf(`  async ${methodName}(`);
  if (start === -1) return '';
  const nextMethod = controllerSource.indexOf('\n  async ', start + 1);
  const previousMethodEnd = controllerSource.lastIndexOf('\n  }', start);
  return controllerSource.slice(
    previousMethodEnd === -1 ? 0 : previousMethodEnd + 4,
    nextMethod === -1 ? controllerSource.length : nextMethod,
  );
}

describe('campus certificate dashboard API', () => {
  it('parses the forceRefresh query and delegates all work to the service', () => {
    const method = getMethodBlock('getCampusCertificateDashboard');

    expect(method).toContain("@Query('forceRefresh') forceRefresh?: string");
    expect(method).toContain("forceRefresh === '1'");
    expect(method).toContain("forceRefresh === 'true'");
    expect(method).toContain(
      'this.certificateDashboardService.getDashboard(shouldRefresh)',
    );
  });

  it('publishes an authenticated no-store GET route', () => {
    const method = getMethodBlock('getCampusCertificateDashboard');

    expect(method).not.toContain('@GuestReadable()');
    expect(method).toContain("@Get('campus-certificate-dashboard')");
    expect(method).toContain("'Cache-Control'");
    expect(method).toContain(
      "'no-store, no-cache, must-revalidate, proxy-revalidate'",
    );
  });

  it('registers the certificate services in the existing module', () => {
    expect(moduleSource).toContain('CertificateDashboardService');
    expect(moduleSource).toContain('CertificateDashboardNotificationService');
    expect(moduleSource).toMatch(
      /providers:\s*\[[^\]]*CertificateDashboardService[^\]]*CertificateDashboardNotificationService/s,
    );
  });

  it('publishes an authenticated no-store expiry notification preview route', () => {
    const method = getMethodBlock(
      'getCampusCertificateExpiryNotificationPreview',
    );

    expect(method).not.toContain('@GuestReadable()');
    expect(method).toContain(
      "@Get('campus-certificate-dashboard/expiry-notification-preview')",
    );
    expect(method).toContain("'Cache-Control'");
    expect(method).toContain(
      "'no-store, no-cache, must-revalidate, proxy-revalidate'",
    );
    expect(method).toContain(
      'this.certificateDashboardNotificationService.previewExpiryNotifications()',
    );
  });

  it('publishes an authenticated POST route and forwards the typed body', () => {
    const method = getMethodBlock('notifyExpiringCampusCertificates');

    expect(method).not.toContain('@GuestReadable()');
    expect(method).toContain(
      "@Post('campus-certificate-dashboard/notify-expiring')",
    );
    expect(method).toContain(
      '@Body() body: CampusCertificateExpiryNotificationRequest',
    );
    expect(method).toMatch(
      /this\.certificateDashboardNotificationService\.sendExpiryNotifications\(\s*body,\s*\)/,
    );
  });
});
