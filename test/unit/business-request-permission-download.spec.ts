import { Reflector } from '@nestjs/core';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { BusinessModule } from '../../shared/business-permissions';
import { businessRequestPermission } from '../../server/common/access/business-request-permission';
import { ProfessionalScoped } from '../../server/common/access/unified-access.decorators';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';

const routes: { module: BusinessModule; download: string; read: string }[] = [
  { module: 'monthly_reports', download: '/api/ali-monthly-report/files/report-id', read: '/api/ali-monthly-report/config' },
  { module: 'system_reports', download: '/api/system-monthly-report/archives/archive-id/download-url', read: '/api/system-monthly-report/archives/archive-id/preview' },
  { module: 'system_reports', download: '/api/system-monthly-report/packages/task-id/download-url', read: '/api/system-monthly-report/packages/task-id' },
  { module: 'contracts', download: '/api/contract-management/attachments/access-id/download', read: '/api/contract-management/attachments/access-id/manifest' },
];

class Endpoint { read() {} }
ProfessionalScoped()(Endpoint.prototype, 'read', Object.getOwnPropertyDescriptor(Endpoint.prototype, 'read')!);

function canAccess(url: string, module: BusinessModule, denyExport: boolean, method = 'GET'): boolean {
  const principal: AccessPrincipal = {
    role: 'professional_engineer',
    purchaseBuilding: 'A楼',
    buildings: ['A楼'],
    specialties: ['暖通'],
    accountId: 'synthetic-download-reader',
    personalRules: denyExport ? [{
      id: 'deny-download', effect: 'deny', module, actions: ['export'], buildings: null, specialties: null,
    }] : [],
  };
  const guard = new UnifiedAccessGuard(new Reflector(), {
    cookieName: 'synthetic-session',
    isAccessControlEnabled: () => true,
    renew: () => ({ principal, principalFingerprint: 'synthetic-download-principal' }),
    pagePermissions: () => ({ paths: ['/ali-monthly-report', '/system-monthly-report', '/contract-management'], configured: true }),
  } as never);
  const request = { method, originalUrl: url, url, query: {}, headers: {}, protocol: 'http' };
  return guard.canActivate({
    getClass: () => Endpoint,
    getHandler: () => Endpoint.prototype.read,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ cookie: jest.fn() }) }),
  } as never);
}

describe('business download permissions', () => {
  it.each(routes)('requires export for $download while keeping its ordinary read available', ({ module, download, read }) => {
    expect(businessRequestPermission(download, 'GET')).toEqual({ module, action: 'export' });
    expect(businessRequestPermission(read, 'GET')).toEqual({ module, action: 'read' });
    expect(canAccess(read, module, true)).toBe(true);
    expect(canAccess(download, module, true)).toBe(false);
    expect(canAccess(download, module, false)).toBe(true);
  });

  it.each(routes)('does not let HEAD, trailing slashes or refresh flags bypass export for $download', ({ module, download }) => {
    expect(businessRequestPermission(`${download}/`, 'HEAD', true)).toEqual({ module, action: 'export' });
    expect(canAccess(`${download}/`, module, true, 'HEAD')).toBe(false);
    for (const query of ['refresh=1', 'forceRefresh=true', 'recheck=1', 'force=true']) {
      expect(canAccess(`${download}?${query}`, module, true)).toBe(false);
      expect(canAccess(`${download}?${query}`, module, false)).toBe(true);
    }
  });

  it('leaves preview pages and storage status as read operations and preserves normal refresh checks', () => {
    for (const path of [
      '/api/contract-management/attachments/access-id/pages/1',
      '/api/contract-management/attachments/storage',
      '/api/system-monthly-report/tasks/task-id',
      '/api/system-monthly-report/packages/download-url',
    ]) expect(businessRequestPermission(path, 'GET')?.action).toBe('read');
    expect(businessRequestPermission('/api/system-monthly-report/dashboard', 'GET', true)).toEqual({ module: 'system_reports', action: 'refresh' });
  });
});
