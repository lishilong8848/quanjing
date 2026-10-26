import { Reflector } from '@nestjs/core';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { GuestReadableMetadataKey } from '../../server/common/access/unified-access.decorators';
import { canAccessPage } from '../../client/src/access/access-policy';

describe('游客私有页面与接口限制', () => {
  it.each(['/monthly-schedule', '/monthly-schedule/apply/leave', '/today-operations-panorama', '/monthly-operations', '/system-monthly-report', '/operations-kb/documents/test', '/meeting-management', '/ali-monthly-report'])('游客不能访问 %s，授权的子管理员仍可访问', path => {
    expect(canAccessPage('guest', path)).toBe(false);
    expect(canAccessPage('editor', path)).toBe(true);
  });
  it.each(['/api/attendance/today', '/api/attendance/history', '/api/duty-schedules/long-white-duty-staff', '/api/bitable/monthly-operations-resources', '/api/system-monthly-report/submissions'])('即使标记 GuestReadable，游客接口 %s 仍拒绝', path => {
    const handler = () => undefined;
    Reflect.defineMetadata(GuestReadableMetadataKey, true, handler);
    for (const named of [false, true]) {
      const access = { cookieName: 'test', isAccessControlEnabled: () => true, renew: () => named ? { principal: { role: 'guest', purchaseBuilding: null, displayName: '已登录游客' }, principalFingerprint: 'test' } : null };
      const guard = new UnifiedAccessGuard(new Reflector(), access as never);
      const request = { method: 'GET', url: path, originalUrl: path, headers: {} };
      const context = { getClass: () => class {}, getHandler: () => handler, switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }) };
      expect(guard.canActivate(context as never)).toBe(false);
      for (const role of ['admin', 'editor', 'building_admin', 'duty_editor', 'professional_admin']) {
        access.renew = () => ({ principal: { role, purchaseBuilding: role === 'building_admin' ? 'A楼' : null }, principalFingerprint: 'authorized' }) as never;
        if (path.includes('system-monthly-report')) continue;
        expect(guard.canActivate(context as never)).toBe(true);
      }
    }
  });
});
