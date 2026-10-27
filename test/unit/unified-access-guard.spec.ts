import {
  Controller,
  Get,
  Post,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { request as nodeHttpRequest } from 'node:http';
import { createConnection, type AddressInfo } from 'node:net';
import {
  PURCHASE_ACCESS_BUILDINGS,
  type AccessPrincipal,
  type AccessRole,
  type PurchaseAccessBuilding,
} from '../../shared/access-control.interface';
import { ACCESS_SESSION_TTL_MS } from '../../server/common/access/unified-access.service';
import {
  AdminOnly,
  GuestReadable,
  PublicAccess,
} from '../../server/common/access/unified-access.decorators';
import {
  readStrictCookie,
  UnifiedAccessGuard,
} from '../../server/common/access/unified-access.guard';
import {
  createCampusOperationsScreenshotAccessToken,
  createMonthlyScheduleScreenshotAccessToken,
} from '../../server/modules/duty-schedule/monthly-schedule-screenshot-access';

class EmergencyDutyAccessProbeController {
  getSchedules() {}
  getOptions() {}
  upsertSchedule() {}
}

GuestReadable()(
  EmergencyDutyAccessProbeController.prototype,
  'getSchedules',
  Object.getOwnPropertyDescriptor(
    EmergencyDutyAccessProbeController.prototype,
    'getSchedules',
  ),
);

const NOW = Date.UTC(2026, 6, 14, 8, 0, 0);
const COOKIE_NAME = 'vnet_access_session';
const GUEST_SUBMITTABLE_METADATA_KEY = 'unified-access:guest-submittable';
const POST_DELETE_PATHS = [
  '/api/purchase-inventory/records/batch-delete',
  '/api/duty-schedules/construction-management/attachments/delete',
  '/api/duty-schedules/construction-management/projects/delete',
  '/api/duty-schedules/exception-follow-up/delete',
  '/api/duty-schedules/travel-staff/revoke',
];

type AccessRequest = Partial<Request> & {
  accessPrincipal?: AccessPrincipal;
  accessRole?: AccessRole;
};

type TestResponse = Partial<Response> & {
  cookie: jest.Mock;
  clearCookie: jest.Mock;
  once: jest.Mock;
};

describe('UnifiedAccessGuard', () => {
  let renew: jest.Mock;
  let guard: UnifiedAccessGuard;
  let dateNow: jest.SpyInstance<number, []>;
  const originalClientBasePath = process.env.CLIENT_BASE_PATH;
  it.each([
    '/api/duty-schedules/construction-management',
    '/api/duty-schedules/construction-management/attachments/test-file',
    '/api/sync-task/construction-12345678-1234-4123-8123-123456789abc',
  ])('blocks guest construction reads even with GuestReadable: %s', (path) => {
    expect(guard.canActivate(makeContext(path, guestReadableTarget()).context)).toBe(false);
    authenticateAs('editor');
    expect(guard.canActivate(makeContext(path, guestReadableTarget()).context)).toBe(true);
  });
  it('allows the exact stocktake batch endpoint for inventory admins and blocks nearby paths and methods', () => {
    authenticateAs('inventory_admin' as never, 'A楼');
    const statusPath = '/api/inventory-management/stocktake/bulk-status';
    expect(guard.canActivate(makeContext(statusPath, { method: 'GET', cookie: `${COOKIE_NAME}=inventory-admin-token` }).context)).toBe(true);
    for (const [url, method] of [[statusPath, 'POST'], [statusPath + '/extra', 'GET']])
      expect(guard.canActivate(makeContext(url, { method, cookie: `${COOKIE_NAME}=inventory-admin-token` }).context)).toBe(false);
    for (const action of ['bulk-confirm', 'bulk-undo', 'retry-sync']) {
    const path = `/api/inventory-management/stocktake/${action}`;
    expect(guard.canActivate(makeContext(path, { method: 'POST', cookie: `${COOKIE_NAME}=inventory-admin-token` }).context)).toBe(true);
    for (const [url, method] of [[path, 'GET'], [path + '/extra', 'POST']])
      expect(guard.canActivate(makeContext(url, { method, cookie: `${COOKIE_NAME}=inventory-admin-token` }).context)).toBe(false);
    }
  });
  const originalCookieSecure = process.env.LOCAL_ACCESS_COOKIE_SECURE;
  const originalTrustProxy = process.env.LOCAL_ACCESS_TRUST_PROXY;

  beforeEach(() => {
    dateNow = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    renew = jest.fn().mockReturnValue(null);
    guard = new UnifiedAccessGuard(new Reflector(), {
      cookieName: COOKIE_NAME,
      renew,
      isAccessControlEnabled: jest.fn().mockReturnValue(true),
    } as never);
    delete process.env.CLIENT_BASE_PATH;
    delete process.env.LOCAL_ACCESS_COOKIE_SECURE;
    delete process.env.LOCAL_ACCESS_TRUST_PROXY;
  });

  afterEach(() => {
    dateNow.mockRestore();
    restoreEnvironment('CLIENT_BASE_PATH', originalClientBasePath);
    restoreEnvironment('LOCAL_ACCESS_COOKIE_SECURE', originalCookieSecure);
    restoreEnvironment('LOCAL_ACCESS_TRUST_PROXY', originalTrustProxy);
  });

  it('decorators attach class and method metadata understood by the guard', () => {
    @PublicAccess()
    class PublicController {}

    class MixedController {
      @GuestReadable()
      read() {}

      @AdminOnly()
      administer() {}
    }

    const publicContext = makeContext('/api/private', {
      controller: PublicController,
    });
    const guestContext = makeContext('/api/read', {
      controller: MixedController,
      handler: MixedController.prototype.read,
    });
    const adminContext = makeContext('/api/administer', {
      controller: MixedController,
      handler: MixedController.prototype.administer,
    });

    expect(guard.canActivate(publicContext.context)).toBe(true);
    expect(guard.canActivate(guestContext.context)).toBe(true);
    expect(guard.canActivate(adminContext.context)).toBe(false);
  });

  it('allows non-API SPA and static requests without touching sessions', () => {
    const { context, request } = makeContext('/assets/app.js');

    expect(guard.canActivate(context)).toBe(true);
    expect(renew).not.toHaveBeenCalled();
    expect(request.accessRole).toBeUndefined();
  });

  it('allows explicit public API endpoints without a session', () => {
    class PublicController {
      callback() {}
    }
    PublicAccess()(
      PublicController.prototype,
      'callback',
      Object.getOwnPropertyDescriptor(PublicController.prototype, 'callback'),
    );
    const { context } = makeContext('/api/oauth/callback', {
      controller: PublicController,
      handler: PublicController.prototype.callback,
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(renew).not.toHaveBeenCalled();
  });

  it('injects an anonymous administrator and allows every API when access control is disabled', () => {
    guard = new UnifiedAccessGuard(new Reflector(), {
      cookieName: COOKIE_NAME,
      renew,
      isAccessControlEnabled: jest.fn().mockReturnValue(false),
      getUnrestrictedPrincipalFingerprint: jest
        .fn()
        .mockReturnValue('unrestricted-admin'),
    } as never);
    const ordinary = makeContext('/api/contract-management/delete', {
      method: 'DELETE',
    });
    @PublicAccess()
    class PublicController {}
    const publicApi = makeContext('/api/oauth/callback', {
      controller: PublicController,
    });

    expect(guard.canActivate(ordinary.context)).toBe(true);
    expect(guard.canActivate(publicApi.context)).toBe(true);
    for (const request of [ordinary.request, publicApi.request]) {
      expect(request.accessPrincipal).toEqual({
        role: 'admin',
        purchaseBuilding: null,
      });
      expect(request.accessPrincipalFingerprint).toBe('unrestricted-admin');
      expect(request.accessRole).toBe('admin');
    }
    expect(renew).not.toHaveBeenCalled();
  });

  it('allows a guest only on GuestReadable GET and records the guest role', () => {
    const target = guestReadableTarget();
    const { context, request } = makeContext('/api/bitable/weather/now', target);

    expect(guard.canActivate(context)).toBe(true);
    expect(request.accessPrincipal).toEqual({
      role: 'guest',
      purchaseBuilding: null,
    });
    expect(request.accessRole).toBe('guest');
  });

  it('allows guest emergency-duty summaries while retaining private options and writes', () => {
    const scheduleRead = makeContext(
      '/api/duty-schedules/emergency-duty?startDate=2026-08-01',
      {
        method: 'GET',
        controller: EmergencyDutyAccessProbeController,
        handler: EmergencyDutyAccessProbeController.prototype.getSchedules,
      },
    );
    const optionsRead = makeContext(
      '/api/duty-schedules/emergency-duty/options',
      {
        method: 'GET',
        controller: EmergencyDutyAccessProbeController,
        handler: EmergencyDutyAccessProbeController.prototype.getOptions,
      },
    );
    const scheduleWrite = makeContext('/api/duty-schedules/emergency-duty', {
      method: 'POST',
      controller: EmergencyDutyAccessProbeController,
      handler: EmergencyDutyAccessProbeController.prototype.upsertSchedule,
    });

    expect(guard.canActivate(scheduleRead.context)).toBe(true);
    expect(scheduleRead.request.accessRole).toBe('guest');
    expect(guard.canActivate(optionsRead.context)).toBe(false);
    expect(optionsRead.request.accessRole).toBe('guest');
    expect(guard.canActivate(scheduleWrite.context)).toBe(false);
    expect(scheduleWrite.request.accessRole).toBe('guest');
  });

  it.each([
    'inventory_admin',
    'purchase_admin',
    'supply_chain_admin',
    'purchase_applicant',
    'construction_admin',
    'duty_editor',
    'editor',
  ] as const)(
    'allows an authenticated %s principal on GuestReadable GET',
    (role) => {
      authenticateAs(role);
      const target = guestReadableTarget();
      const { context, request } = makeContext(
        '/api/duty-schedules/work-calendar',
        target,
      );

      expect(guard.canActivate(context)).toBe(true);
      expect(request.accessRole).toBe(role);
    },
  );

  it('denies an ordinary API endpoint to a guest', () => {
    const { context, request } = makeContext('/api/purchase-inventory');

    expect(guard.canActivate(context)).toBe(false);
    expect(request.accessRole).toBe('guest');
  });

  it.each([
    'guest',
    'professional_admin',
    'inventory_admin',
    'purchase_admin',
    'supply_chain_admin',
    'purchase_applicant',
    'construction_admin',
    'duty_editor',
    'editor',
  ] as const)(
    'allows an injected %s principal on a GuestSubmittable POST',
    (role) => {
      if (role !== 'guest') authenticateAs(role);
      const target = guestSubmittableTarget();
      const { context, request } = makeContext(
        '/api/duty-schedules/change-request',
        {
          method: 'POST',
          ...target,
        },
      );

      expect(guard.canActivate(context)).toBe(true);
      expect(request.accessPrincipal).toEqual({
        role,
        purchaseBuilding: null,
      });
    },
  );

  it.each(['GET', 'PATCH', 'DELETE'] as const)(
    'does not widen guest access when GuestSubmittable is placed on %s',
    (method) => {
      const target = guestSubmittableTarget();
      const { context } = makeContext('/api/duty-schedules/change-request', {
        method,
        ...target,
      });

      expect(guard.canActivate(context)).toBe(false);
    },
  );

  it('does not let GuestSubmittable bypass AdminOnly', () => {
    const target = guestSubmittableTarget(true);
    const { context } = makeContext('/api/duty-schedules/change-request', {
      method: 'POST',
      ...target,
    });

    expect(guard.canActivate(context)).toBe(false);
  });

  it('keeps an unmarked guest POST denied', () => {
    const { context } = makeContext('/api/duty-schedules/change-request', {
      method: 'POST',
    });

    expect(guard.canActivate(context)).toBe(false);
  });

  it('keeps the exact multipart change attachment stage route guest-submittable for controller owner checks', () => {
    const target = guestSubmittableTarget();
    const { context } = makeContext(
      '/api/duty-schedules/change-attachments/stage',
      {
        method: 'POST',
        ...target,
      },
    );

    expect(guard.canActivate(context)).toBe(true);
  });

  it('does not allow class-level GuestSubmittable metadata to widen every POST', () => {
    class SubmissionController {
      submit() {}
    }
    Reflect.defineMetadata(
      GUEST_SUBMITTABLE_METADATA_KEY,
      true,
      SubmissionController,
    );
    const { context } = makeContext('/api/duty-schedules/change-request', {
      method: 'POST',
      controller: SubmissionController,
      handler: SubmissionController.prototype.submit,
    });

    expect(guard.canActivate(context)).toBe(false);
  });

  it('rate-limits repeated guest submissions before request bodies are parsed', () => {
    const target = guestSubmittableTarget();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const allowed = makeContext('/api/duty-schedules/change-request', {
        method: 'POST',
        ...target,
      });
      expect(guard.canActivate(allowed.context)).toBe(true);
      releaseGuestSubmission(allowed.response);
    }

    const limited = makeContext('/api/duty-schedules/change-request', {
      method: 'POST',
      ...target,
    });
    expectGuestSubmissionStatus(() => guard.canActivate(limited.context), 429);
  });

  it('allows only one in-flight guest submission per source', () => {
    const target = guestSubmittableTarget();
    const first = makeContext('/api/duty-schedules/change-request', {
      method: 'POST',
      ...target,
    });
    const concurrent = makeContext('/api/duty-schedules/change-request', {
      method: 'POST',
      ...target,
    });

    expect(guard.canActivate(first.context)).toBe(true);
    expectGuestSubmissionStatus(
      () => guard.canActivate(concurrent.context),
      429,
    );
    releaseGuestSubmission(first.response);
  });

  it('uses the trusted proxy client address for visitor submission limits', () => {
    process.env.LOCAL_ACCESS_TRUST_PROXY = 'true';
    const target = guestSubmittableTarget();
    const first = makeContext('/api/duty-schedules/change-request', {
      method: 'POST',
      ...target,
      requestOverrides: {
        headers: { 'x-forwarded-for': '203.0.113.10' },
      },
    });
    const second = makeContext('/api/duty-schedules/change-request', {
      method: 'POST',
      ...target,
      requestOverrides: {
        headers: { 'x-forwarded-for': '203.0.113.11' },
      },
    });

    expect(guard.canActivate(first.context)).toBe(true);
    expect(guard.canActivate(second.context)).toBe(true);
    releaseGuestSubmission(first.response);
    releaseGuestSubmission(second.response);
  });

  it('rate-limits low-privilege authenticated self-service submissions too', () => {
    authenticateAs('purchase_applicant');
    const target = guestSubmittableTarget();
    const first = makeContext('/api/duty-schedules/change-request', {
      method: 'POST',
      ...target,
    });
    const concurrent = makeContext('/api/duty-schedules/change-request', {
      method: 'POST',
      ...target,
    });

    expect(guard.canActivate(first.context)).toBe(true);
    expectGuestSubmissionStatus(
      () => guard.canActivate(concurrent.context),
      429,
    );
    releaseGuestSubmission(first.response);
  });

  it('does not apply the visitor limiter to schedule editors', () => {
    authenticateAs('duty_editor');
    const target = guestSubmittableTarget();
    const first = makeContext('/api/duty-schedules/change-request', {
      method: 'POST',
      ...target,
    });
    const concurrent = makeContext('/api/duty-schedules/change-request', {
      method: 'POST',
      ...target,
    });

    expect(guard.canActivate(first.context)).toBe(true);
    expect(guard.canActivate(concurrent.context)).toBe(true);
  });

  it('allows only a signed read-only campus screenshot data request', () => {
    const screenshotDate = '2026-07-22';
    const screenshotToken = createCampusOperationsScreenshotAccessToken(
      screenshotDate,
      'white',
      NOW,
    );
    const validQuery = {
      screenshotDate,
      screenshotShift: 'white',
      screenshotToken,
    };
    const valid = makeContext('/api/bitable/campus-operations-dashboard', {
      query: validQuery,
    });
    const invalid = makeContext('/api/bitable/campus-operations-dashboard', {
      query: { ...validQuery, screenshotToken: 'invalid-token' },
    });
    const forcedRefresh = makeContext(
      '/api/bitable/campus-operations-dashboard?forceRefresh=1',
      {
        query: { ...validQuery, forceRefresh: '1' },
      },
    );
    const wrongShift = makeContext('/api/bitable/campus-operations-dashboard', {
      query: { ...validQuery, screenshotShift: 'night' },
    });
    const monthlyToken = makeContext(
      '/api/bitable/campus-operations-dashboard',
      {
        query: {
          ...validQuery,
          screenshotToken: createMonthlyScheduleScreenshotAccessToken(
            screenshotDate,
            NOW,
          ),
        },
      },
    );

    expect(guard.canActivate(valid.context)).toBe(true);
    expect(valid.request.accessRole).toBe('guest');
    expect(guard.canActivate(invalid.context)).toBe(false);
    expect(guard.canActivate(wrongShift.context)).toBe(false);
    expect(guard.canActivate(monthlyToken.context)).toBe(false);
    expect(guard.canActivate(forcedRefresh.context)).toBe(false);
  });

  it.each(['/API/private', '/aPi/private'])(
    'treats case-insensitive API path %s as protected',
    (path) => {
      const { context, request } = makeContext(path);

      expect(guard.canActivate(context)).toBe(false);
      expect(request.accessRole).toBe('guest');
    },
  );

  it.each([
    [{ refresh: '1' }, '/api/duty-schedules?refresh=1'],
    [{ refresh: 'true' }, '/api/duty-schedules?refresh=true'],
    [{ forceRefresh: '1' }, '/api/duty-schedules?forceRefresh=1'],
    [{ forceRefresh: ['false', 'true'] }, '/api/duty-schedules'],
  ])('denies guest refresh query %p', (query, url) => {
    const { context } = makeContext(url, {
      ...guestReadableTarget(),
      query,
    });

    expect(guard.canActivate(context)).toBe(false);
  });

  it('applies contract policy case-insensitively', () => {
    authenticateAs('editor');
    const { context } = makeContext('/API/Contract-Management/Dashboard', {
      cookie: `${COOKIE_NAME}=old-token`,
    });

    expect(guard.canActivate(context)).toBe(false);
  });

  it('allows a purchase administrator on contract APIs but denies other modules and prefix collisions', () => {
    authenticateAs('purchase_admin');
    const regular = makeContext('/API/Contract-Management/Dashboard/', {
      cookie: `${COOKIE_NAME}=purchase-admin-token`,
    });
    const adminOnly = makeContext(
      '/api/contract-management/workflows/self-test',
      {
        ...adminOnlyTarget(),
        method: 'POST',
        cookie: `${COOKIE_NAME}=purchase-admin-token`,
      },
    );
    const expiryDisposition = makeContext(
      '/api/contract-management/contracts/record-1/expiry-disposition',
      {
        method: 'PATCH',
        cookie: `${COOKIE_NAME}=purchase-admin-token`,
      },
    );
    const outside = makeContext('/api/duty-schedules', {
      cookie: `${COOKIE_NAME}=purchase-admin-token`,
    });
    const prefixCollision = makeContext('/api/contract-management-archive', {
      cookie: `${COOKIE_NAME}=purchase-admin-token`,
    });

    expect(guard.canActivate(regular.context)).toBe(true);
    expect(guard.canActivate(adminOnly.context)).toBe(true);
    expect(guard.canActivate(expiryDisposition.context)).toBe(true);
    expect(guard.canActivate(outside.context)).toBe(false);
    expect(guard.canActivate(prefixCollision.context)).toBe(false);
  });

  it('allows a Feishu supply-chain administrator only on purchase and contract API families', () => {
    authenticateAs('supply_chain_admin');
    const allowedRequests = [
      [
        'DELETE',
        'https://service.test/API/Purchase-Inventory/records/record-1/?probe=1',
      ],
      ['POST', '/api/purchase-inventory/workflows/self-test'],
      ['GET', '/api/contract-management/dashboard'],
      ['PATCH', '/api/contract-management/contracts/record-1'],
      [
        'PATCH',
        '/api/contract-management/contracts/record-1/expiry-disposition',
      ],
    ] as const;
    const deniedRequests = [
      ['GET', '/api/duty-schedules'],
      ['GET', '/api/inventory-management/dashboard'],
      ['GET', '/api/purchase-inventory-archive/dashboard'],
      ['GET', '/api/contract-management-archive/dashboard'],
      ['GET', '/api/purchase-inventory%2Farchive/dashboard'],
      ['GET', '/api/contract-management%5Carchive/dashboard'],
    ] as const;

    for (const [method, path] of allowedRequests) {
      const metadata = path.endsWith('/self-test') ? adminOnlyTarget() : {};
      const { context } = makeContext(path, {
        ...metadata,
        method,
        cookie: `${COOKIE_NAME}=supply-chain-admin-token`,
      });
      expect(guard.canActivate(context)).toBe(true);
    }
    for (const [method, path] of deniedRequests) {
      const { context } = makeContext(path, {
        method,
        cookie: `${COOKIE_NAME}=supply-chain-admin-token`,
      });
      expect(guard.canActivate(context)).toBe(false);
    }
  });

  it('allows a Feishu duty editor only on exact schedule read and non-destructive mutation APIs', () => {
    authenticateAs('duty_editor');
    const allowedRequests = [
      ['GET', 'https://service.test/API/Monthly-Schedules/2026/7/?probe=1'],
      ['POST', '/api/duty-schedules/vacancy-substitute'],
      ['POST', '/api/duty-schedules/staff-adjustment'],
      ['GET', '/api/duty-schedules/travel-staff?refresh=1'],
      ['POST', '/api/duty-schedules/travel-staff'],
      ['POST', '/api/duty-schedules/travel-staff/adjust'],
      ['POST', '/api/duty-schedules/personnel-movement'],
      ['POST', '/api/duty-schedules/additional-matter'],
      ['POST', '/api/duty-schedules/sealing-registration'],
      ['POST', '/api/duty-schedules/leave-request'],
      ['POST', '/api/duty-schedules/overtime-request'],
      ['POST', '/api/duty-schedules/change-adjustment'],
      ['POST', '/api/duty-schedules/change-drill-report'],
      ['POST', '/api/duty-schedules/change-summary-report'],
      ['POST', '/api/duty-schedules/change-summary-report/abandon'],
      [
        'GET',
        '/api/duty-schedules/change-summary-report-sync/change-summary-report-123e4567-e89b-42d3-a456-426614174000',
      ],
      [
        'GET',
        '/api/duty-schedules/emergency-duty?startDate=2026-08-01&endDate=2026-08-31',
      ],
      ['GET', '/api/duty-schedules/emergency-duty/options'],
      ['POST', '/api/duty-schedules/emergency-duty'],
      [
        'GET',
        '/api/duty-schedules/change-records/rec_change_01/attachments/boxcn_scheme_01',
      ],
      ['GET', '/api/duty-schedules/long-white-duty-staff'],
      ['POST', '/api/duty-schedules/exception-follow-up'],
      ['GET', '/api/duty-schedules/exception-follow-ups?refresh=true'],
      ['POST', '/api/duty-schedules/exception-follow-up/update'],
      ['GET', '/api/sealing-info/2026?refresh=1'],
      ['GET', '/api/change-info/2026?refresh=1'],
      ['POST', '/api/change-info/adjustment'],
      ['GET', '/api/today-focus-checklist?refresh=1'],
      ['GET', '/api/bitable/weather/now'],
      ['GET', '/api/bitable/weather/warning'],
      ['GET', '/api/bitable/weather/hourly'],
      ['GET', '/api/bitable/person-profiles?forceRefresh=1'],
      ['GET', '/api/bitable/festival-schedules'],
      ['GET', '/api/bitable/today-leave-staff'],
      ['POST', '/api/sync-all-from-feishu'],
      ['POST', '/api/duty-schedules/sync-local-fast'],
      ['POST', '/api/duty-overview-screenshot/send'],
      ['POST', '/api/typhoon-path-screenshot/send-group'],
    ] as const;

    for (const [method, path] of allowedRequests) {
      const { context } = makeContext(path, {
        method,
        cookie: `${COOKIE_NAME}=duty-editor-token`,
      });
      expect(guard.canActivate(context)).toBe(true);
    }
  });

  it('denies a Feishu duty editor construction, deletion, unrelated, and path-collision APIs', () => {
    authenticateAs('duty_editor');
    const deniedRequests = [
      ['GET', '/api/buildings'],
      ['GET', '/api/duty-schedules'],
      ['POST', '/api/duty-schedules/batch'],
      ['POST', '/api/duty-schedules/overtime-request/archive'],
      ['POST', '/api/duty-schedules/change-adjustment/archive'],
      ['POST', '/api/duty-schedules/change-drill-report/archive'],
      ['POST', '/api/duty-schedules/change-summary-report/archive'],
      [
        'POST',
        '/api/duty-schedules/change-summary-report/self-test/cleanup-bound-attachment',
      ],
      ['GET', '/api/duty-schedules/change-summary-report-sync/extra/path'],
      ['POST', '/api/duty-schedules/emergency-duty/options'],
      ['GET', '/api/duty-schedules/emergency-duty/extra'],
      [
        'GET',
        '/api/duty-schedules/change-records/rec_change_01/attachments/boxcn_scheme_01/extra',
      ],
      [
        'GET',
        '/api/duty-schedules/change-records/rec_change_01%2Fescape/attachments/boxcn_scheme_01',
      ],
      ['GET', '/api/duty-program-modified/scan?refresh=1'],
      ['POST', '/api/duty-program-modified/repair'],
      ['GET', '/api/duty-schedules/construction-management'],
      ['POST', '/api/duty-schedules/travel-staff/revoke'],
      ['POST', '/api/duty-schedules/exception-follow-up/delete'],
      ['DELETE', '/api/duty-schedules/travel-staff'],
      ['GET', '/api/monthly-schedules/2026/7/extra'],
      ['GET', '/api/monthly-schedules-archive/2026/7'],
      ['GET', '/api/purchase-inventory/dashboard'],
      ['GET', '/api/contract-management/dashboard'],
      ['GET', '/api/inventory-management/dashboard'],
      ['POST', '/api/sync-from-feishu'],
      ['GET', '/api/last-sync-time'],
      ['GET', '/api/sync-task/task-123'],
      ['GET', '/api/sync-task/task-123/extra'],
      ['GET', '/api/sync-task/task%2Fextra'],
      ['POST', '/api/sync-from-feishu-archive'],
    ] as const;

    for (const [method, path] of deniedRequests) {
      const { context } = makeContext(path, {
        method,
        cookie: `${COOKIE_NAME}=duty-editor-token`,
      });
      expect(guard.canActivate(context)).toBe(false);
    }
  });

  it.each([
    ['true', { recordId: 'record-1', clearAdjustment: true }, false],
    ['false', { recordId: 'record-1', clearAdjustment: false }, true],
    ['omitted', { recordId: 'record-1' }, true],
    ['string', { recordId: 'record-1', clearAdjustment: 'false' }, false],
    ['number', { recordId: 'record-1', clearAdjustment: 0 }, false],
    ['null', { recordId: 'record-1', clearAdjustment: null }, false],
    ['array', { recordId: 'record-1', clearAdjustment: [] }, false],
    ['object', { recordId: 'record-1', clearAdjustment: {} }, false],
  ] as const)(
    'enforces duty-editor clearAdjustment runtime type for %s',
    (_label, body, expected) => {
      authenticateAs('duty_editor');
      const { context } = makeContext('/api/change-info/adjustment', {
        method: 'POST',
        cookie: `${COOKIE_NAME}=duty-editor-token`,
        requestOverrides: { body },
      });

      expect(guard.canActivate(context)).toBe(expected);
    },
  );

  it('allows a construction administrator only on the exact construction API family for every CRUD method', () => {
    authenticateAs('construction_admin');
    const allowedRequests = [
      ['GET', '/API/Duty-Schedules/Construction-Management/'],
      ['POST', '/api/duty-schedules/construction-management/projects'],
      ['PATCH', '/api/duty-schedules/construction-management/projects/1'],
      ['DELETE', '/api/duty-schedules/construction-management/attachments/1'],
      ['POST', '/api/duty-schedules/construction-management/projects/delete'],
    ] as const;
    const deniedRequests = [
      ['GET', '/api/duty-schedules'],
      ['POST', '/api/duty-schedules/monthly-schedule'],
      ['GET', '/api/purchase-inventory/dashboard'],
      ['GET', '/api/contract-management/dashboard'],
      ['GET', '/api/duty-schedules/construction-management-archive'],
      [
        'GET',
        '/api/duty-schedules/construction-management%2Farchive/dashboard',
      ],
    ] as const;

    for (const [method, path] of allowedRequests) {
      const metadata = path.endsWith('/projects/delete')
        ? adminOnlyTarget()
        : {};
      const { context } = makeContext(path, {
        ...metadata,
        method,
        cookie: `${COOKIE_NAME}=construction-admin-token`,
      });
      expect(guard.canActivate(context)).toBe(true);
    }
    for (const [method, path] of deniedRequests) {
      const { context } = makeContext(path, {
        method,
        cookie: `${COOKIE_NAME}=construction-admin-token`,
      });
      expect(guard.canActivate(context)).toBe(false);
    }
  });

  it('allows a construction administrator to poll only one safe sync task id with GET', () => {
    authenticateAs('construction_admin');
    const constructionTaskId =
      'construction-123e4567-e89b-42d3-a456-426614174000';
    const allowedRequests = [
      ['GET', `/api/sync-task/${constructionTaskId}`],
      [
        'GET',
        `https://service.test/API/Sync-Task/${constructionTaskId.toUpperCase()}/?probe=1`,
      ],
    ] as const;
    const deniedRequests = [
      ['GET', '/api/sync-task'],
      ['GET', '/api/sync-task/'],
      ['GET', '/api/sync-task/123e4567-e89b-42d3-a456-426614174000'],
      [
        'GET',
        '/api/sync-task/construction-123e4567-e89b-12d3-a456-426614174000',
      ],
      ['GET', `/api/sync-task/${constructionTaskId}/extra`],
      ['POST', `/api/sync-task/${constructionTaskId}`],
      ['PATCH', `/api/sync-task/${constructionTaskId}`],
      ['DELETE', `/api/sync-task/${constructionTaskId}`],
      ['GET', '/api/sync-task/construction-task%2Fextra'],
      ['GET', '/api/sync-task/construction-task%5Cextra'],
      ['GET', `/api/sync-task-archive/${constructionTaskId}`],
    ] as const;

    for (const [method, path] of allowedRequests) {
      const { context } = makeContext(path, {
        method,
        cookie: `${COOKIE_NAME}=construction-admin-token`,
      });
      expect(guard.canActivate(context)).toBe(true);
    }
    for (const [method, path] of deniedRequests) {
      const { context } = makeContext(path, {
        method,
        cookie: `${COOKIE_NAME}=construction-admin-token`,
      });
      expect(guard.canActivate(context)).toBe(false);
    }
  });

  it('allows an inventory administrator only on the inventory API', () => {
    authenticateAs('inventory_admin' as never, 'A楼');
    const inventory = makeContext('/api/inventory-management/dashboard', {
      cookie: `${COOKIE_NAME}=inventory-admin-token`,
    });
    const otherBuildingInventory = makeContext(
      '/api/inventory-management/items?building=B%E6%A5%BC',
      { cookie: `${COOKIE_NAME}=inventory-admin-token` },
    );
    const purchase = makeContext('/api/purchase-inventory/dashboard', {
      cookie: `${COOKIE_NAME}=inventory-admin-token`,
    });
    const contracts = makeContext('/api/contract-management/dashboard', {
      cookie: `${COOKIE_NAME}=inventory-admin-token`,
    });

    expect(guard.canActivate(inventory.context)).toBe(true);
    expect(guard.canActivate(otherBuildingInventory.context)).toBe(true);
    expect(guard.canActivate(purchase.context)).toBe(false);
    expect(guard.canActivate(contracts.context)).toBe(false);
  });

  it('limits a building administrator to business routes and denies global administration', () => {
    authenticateAs('building_admin', '110站');
    const allowed = [
      ['GET', '/api/inventory-management/dashboard'],
      ['GET', '/api/purchase-inventory/dashboard'],
      ['POST', '/api/purchase-inventory/records/batch-delete'],
      ['POST', '/api/purchase-inventory/records/rec123/approval'],
      ['GET', '/api/purchase-inventory/approval/tasks/task-123'],
      ['GET', '/api/risk-inspection/ali-monthly-quality'],
      ['PATCH', '/api/risk-inspection/ali-monthly-quality/issues/rec123/supplemental'],
      ['GET', '/api/bitable/campus-training-dashboard'],
    ] as const;
    for (const [method, path] of allowed) {
      expect(guard.canActivate(makeContext(path, { method, cookie: `${COOKIE_NAME}=building-token`, ...(path.includes('/approval') ? adminOnlyTarget() : {}) }).context)).toBe(true);
    }
    for (const [method, path] of [
      ['POST', '/api/purchase-inventory/workflows/self-test'],
      ['POST', '/api/purchase-inventory/workflows/reminders/warehouse/run'],
      ['GET', '/api/contract-management/dashboard'],
      ['PATCH', '/api/risk-inspection/ali-monthly-quality/issues/rec123%2Fextra/supplemental'],
    ] as const) {
      expect(guard.canActivate(makeContext(path, { method, cookie: `${COOKIE_NAME}=building-token`, ...(path.endsWith('/self-test') || path.endsWith('/approval') ? adminOnlyTarget() : {}) }).context)).toBe(false);
    }
  });

  it('allows an inventory administrator to search the shared applicant directory without widening purchase access', () => {
    authenticateAs('inventory_admin' as never, 'A楼');
    const applicantSearch = makeContext(
      '/api/purchase-inventory/applicant-search?query=%E9%A9%AC',
      { cookie: `${COOKIE_NAME}=inventory-admin-token` },
    );
    const purchaseDashboard = makeContext('/api/purchase-inventory/dashboard', {
      cookie: `${COOKIE_NAME}=inventory-admin-token`,
    });
    const purchaseApplication = makeContext(
      '/api/purchase-inventory/applications',
      {
        method: 'POST',
        cookie: `${COOKIE_NAME}=inventory-admin-token`,
      },
    );

    expect(guard.canActivate(applicantSearch.context)).toBe(true);
    expect(guard.canActivate(purchaseDashboard.context)).toBe(false);
    expect(guard.canActivate(purchaseApplication.context)).toBe(false);
  });

  it('allows an inventory administrator to prepare a purchase inbound category', () => {
    authenticateAs('inventory_admin' as never, 'A楼');
    const prepareCategory = makeContext(
      '/api/inventory-management/purchase-inbounds/prepare-category',
      {
        method: 'POST',
        cookie: `${COOKIE_NAME}=inventory-admin-token`,
      },
    );

    expect(guard.canActivate(prepareCategory.context)).toBe(true);
  });

  it.each([
    '/api/inventory-management/inbounds/tasks/inventory-inbound-manual-abc_123',
    '/api/inventory-management/purchase-inbounds/category-tasks/purchase-category-abc_123',
  ])(
    'allows an inventory administrator to query inbound task status at %s',
    (path) => {
      authenticateAs('inventory_admin' as never, 'A楼');
      const task = makeContext(path, {
        method: 'GET',
        cookie: `${COOKIE_NAME}=inventory-admin-token`,
      });

      expect(guard.canActivate(task.context)).toBe(true);
    },
  );

  it.each([
    ['POST', '/api/inventory-management/inbounds/tasks/task-1'],
    ['DELETE', '/api/inventory-management/inbounds/tasks/task-1'],
    ['GET', '/api/inventory-management/inbounds/tasks/'],
    ['GET', '/api/inventory-management/inbounds/tasks/task.1'],
    ['GET', '/api/inventory-management/inbounds/tasks/task%2Fescape'],
    [
      'POST',
      '/api/inventory-management/purchase-inbounds/category-tasks/task-1',
    ],
    [
      'DELETE',
      '/api/inventory-management/purchase-inbounds/category-tasks/task-1',
    ],
    ['GET', '/api/inventory-management/purchase-inbounds/category-tasks/'],
    [
      'GET',
      '/api/inventory-management/purchase-inbounds/category-tasks/task.1',
    ],
    [
      'GET',
      '/api/inventory-management/purchase-inbounds/category-tasks/task%2Fescape',
    ],
  ] as const)(
    'does not widen inbound task access to %s %s',
    (method, path) => {
      authenticateAs('inventory_admin' as never, 'A楼');
      const task = makeContext(path, {
        method,
        cookie: `${COOKIE_NAME}=inventory-admin-token`,
      });

      expect(guard.canActivate(task.context)).toBe(false);
    },
  );

  it('allows an inventory administrator on the exact outbound confirmation POST route', () => {
    authenticateAs('inventory_admin' as never, 'A楼');
    const confirmation = makeContext(
      '/api/inventory-management/outbounds/record_ABC-123/confirm',
      {
        method: 'POST',
        cookie: `${COOKIE_NAME}=inventory-admin-token`,
      },
    );

    expect(guard.canActivate(confirmation.context)).toBe(true);
  });

  it('allows an inventory administrator to submit and query an asynchronous outbound task', () => {
    authenticateAs('inventory_admin' as never, 'A楼');
    const submission = makeContext('/api/inventory-management/outbounds', {
      method: 'POST',
      cookie: `${COOKIE_NAME}=inventory-admin-token`,
    });
    const task = makeContext(
      '/api/inventory-management/outbounds/tasks/inventory-outbound-abc_123?building=A%E6%A5%BC',
      {
        method: 'GET',
        cookie: `${COOKIE_NAME}=inventory-admin-token`,
      },
    );

    expect(guard.canActivate(submission.context)).toBe(true);
    expect(guard.canActivate(task.context)).toBe(true);
  });

  it.each(['inventory_admin', 'building_admin'] as const)(
    'allows %s to submit only the exact inventory batch routes',
    (role) => {
      authenticateAs(role, 'A楼');
      const cookie = `${COOKIE_NAME}=inventory-batch-token`;
      for (const path of [
        '/api/inventory-management/purchase-inbounds/confirm-batch',
        '/api/inventory-management/outbounds/batch',
      ]) {
        expect(guard.canActivate(makeContext(path, { method: 'POST', cookie }).context)).toBe(true);
        for (const denied of [
          { method: 'GET', path },
          { method: 'PATCH', path },
          { method: 'POST', path: `${path}/extra` },
        ]) {
          expect(guard.canActivate(makeContext(denied.path, { method: denied.method, cookie }).context)).toBe(false);
        }
      }
    },
  );

  it('allows an inventory administrator to submit and query an asynchronous movement deletion task', () => {
    authenticateAs('inventory_admin' as never, 'A楼');
    const submission = makeContext(
      '/api/inventory-management/movements/deletions',
      {
        method: 'POST',
        cookie: `${COOKIE_NAME}=inventory-admin-token`,
      },
    );
    const task = makeContext(
      '/api/inventory-management/movements/deletions/tasks/inventory-movement-deletion-abc_123',
      {
        method: 'GET',
        cookie: `${COOKIE_NAME}=inventory-admin-token`,
      },
    );

    expect(guard.canActivate(submission.context)).toBe(true);
    expect(guard.canActivate(task.context)).toBe(true);
  });

  it.each([
    ['GET', '/api/inventory-management/movements/deletions'],
    ['POST', '/api/inventory-management/movements/deletions/extra'],
    ['POST', '/api/inventory-management/movements/deletions/tasks/task-1'],
    ['GET', '/api/inventory-management/movements/deletions/tasks/'],
    ['GET', '/api/inventory-management/movements/deletions/tasks/task.1'],
    [
      'GET',
      '/api/inventory-management/movements/deletions/tasks/task%2Fescape',
    ],
  ] as const)(
    'does not widen movement deletion access to %s %s',
    (method, path) => {
      authenticateAs('inventory_admin' as never, 'A楼');
      const request = makeContext(path, {
        method,
        cookie: `${COOKIE_NAME}=inventory-admin-token`,
      });

      expect(guard.canActivate(request.context)).toBe(false);
    },
  );

  it.each([
    ['POST', '/api/inventory-management/outbounds/extra'],
    ['POST', '/api/inventory-management/outbounds/tasks/task-1'],
    ['GET', '/api/inventory-management/outbounds/tasks/'],
    ['GET', '/api/inventory-management/outbounds/tasks/task.1'],
    ['GET', '/api/inventory-management/outbounds/tasks/task%2Fescape'],
  ] as const)(
    'does not widen asynchronous outbound access to %s %s',
    (method, path) => {
      authenticateAs('inventory_admin' as never, 'A楼');
      const request = makeContext(path, {
        method,
        cookie: `${COOKIE_NAME}=inventory-admin-token`,
      });

      expect(guard.canActivate(request.context)).toBe(false);
    },
  );

  it.each([
    ['GET', '/api/inventory-management/outbounds/record-1/confirm'],
    ['DELETE', '/api/inventory-management/outbounds/record-1/confirm'],
    ['POST', '/api/inventory-management/outbounds//confirm'],
    ['POST', '/api/inventory-management/outbounds/record-1/extra/confirm'],
    ['POST', '/api/inventory-management/outbounds/record.1/confirm'],
    ['POST', '/api/inventory-management/outbounds/record%2Fextra/confirm'],
    ['POST', '/api/inventory-management/outbounds/record%252Fextra/confirm'],
    ['POST', '/api/inventory-management/outbounds/record%5Cextra/confirm'],
    ['POST', '/api/inventory-management/outbounds/record%255Cextra/confirm'],
  ] as const)(
    'does not widen outbound confirmation access to %s %s',
    (method, path) => {
      authenticateAs('inventory_admin' as never, 'A楼');
      const request = makeContext(path, {
        method,
        cookie: `${COOKIE_NAME}=inventory-admin-token`,
      });

      expect(guard.canActivate(request.context)).toBe(false);
    },
  );

  it.each([
    ['GET', '/api/inventory-management/storage-locations?building=B%E6%A5%BC'],
    ['POST', '/api/inventory-management/storage-locations'],
  ])(
    'allows an inventory administrator to use the scoped storage location route %s %s',
    (method, path) => {
      authenticateAs('inventory_admin' as never, 'A楼');
      const request = makeContext(path, {
        method,
        cookie: `${COOKIE_NAME}=inventory-admin-token`,
      });

      expect(guard.canActivate(request.context)).toBe(true);
    },
  );

  it.each(
    POST_DELETE_PATHS.filter(
      (path) => path !== '/api/purchase-inventory/records/batch-delete',
    ),
  )(
    'applies persisted POST deletion policy case-insensitively for %s',
    (path) => {
      authenticateAs('editor');
      const mixedCasePath = path
        .replace('/api/', '/API/')
        .replace('/delete', '/DeLeTe');
      const { context } = makeContext(mixedCasePath, {
        method: 'POST',
        cookie: `${COOKIE_NAME}=old-token`,
      });

      expect(guard.canActivate(context)).toBe(false);
    },
  );

  it('allows editor purchase batch deletion to reach record-level authorization', () => {
    authenticateAs('editor');
    const { context, request } = makeContext(
      '/api/purchase-inventory/records/batch-delete',
      {
        method: 'POST',
        cookie: `${COOKIE_NAME}=old-token`,
        ...adminOnlyTarget(),
      },
    );

    expect(guard.canActivate(context)).toBe(true);
    expect(request.accessRole).toBe('editor');
  });

  it.each([
    ['GET', '/api/purchase-inventory/workflows'],
    ['GET', '/api/purchase-inventory/catalog/search'],
    ['GET', '/api/purchase-inventory/applicant/search'],
    ['GET', '/api/purchase-inventory/applicants/search'],
    ['POST', '/api/purchase-inventory/workflows/self-test'],
    ['POST', '/api/purchase-inventory/workflows/record-123/approve'],
    ['POST', '/api/purchase-inventory/workflows/record-123/start'],
    ['GET', '/api/purchase-inventory/workflows/receipt-tasks'],
    ['GET', '/api/purchase-inventory/workflows/receipt-tasks/task-123/extra'],
    ['GET', '/api/purchase-inventory/workflows/receipt-tasks/task-123%2Fextra'],
    ['GET', '/api/purchase-inventory/applications/tasks'],
    [
      'GET',
      '/api/purchase-inventory/applications/tasks/purchase-application-123/extra',
    ],
    [
      'GET',
      '/api/purchase-inventory/applications/tasks/purchase-application-123%2Fextra',
    ],
    [
      'POST',
      '/api/purchase-inventory/applications/tasks/purchase-application-123',
    ],
    ['POST', '/api/purchase-inventory/workflows/record-123/receive/extra'],
    ['GET', '/api/contract-management/dashboard'],
    ['GET', '/api/purchase-inventory-evil/dashboard'],
    ['POST', '/api/purchase-inventory/dashboard'],
    ['GET', '/api/purchase-inventory/dashboard/extra'],
    ['PATCH', '/api/purchase-inventory/records/record-123/extra'],
    ['PATCH', '/api/purchase-inventory/records/record-123%2Fextra'],
  ] as const)(
    'denies a purchase applicant outside the allowlist %s %s',
    (method, path) => {
      authenticateAs('purchase_applicant', PURCHASE_ACCESS_BUILDINGS[0]);
      const { context } = makeContext(path, {
        method,
        cookie: `${COOKIE_NAME}=purchase-applicant-token`,
      });

      expect(guard.canActivate(context)).toBe(false);
    },
  );

  it.each([
    'ftp://integration.test/api/probe',
    'http://user:pass@integration.test/api/probe',
    'http://integration.test/api\\probe',
    '/api/probe#fragment',
  ])(
    'rejects invalid raw request target before trusting parsed Express path %p',
    (rawTarget) => {
      authenticateAs('admin');
      const { context } = makeContext(rawTarget, {
        cookie: `${COOKIE_NAME}=admin-token`,
        requestOverrides: { path: '/api/probe' },
      });

      expect(guard.canActivate(context)).toBe(false);
    },
  );

  it('parses an absolute-form request target pathname', () => {
    authenticateAs('editor');
    const { context } = makeContext(
      'http://integration.test/API/Contract-Management/Dashboard?refresh=false',
      { cookie: `${COOKIE_NAME}=old-token` },
    );

    expect(guard.canActivate(context)).toBe(false);
  });

  it('does not fall back from a malformed originalUrl to a safe url or path', () => {
    authenticateAs('admin');
    const { context } = makeContext('/api/probe', {
      cookie: `${COOKIE_NAME}=admin-token`,
      requestOverrides: {
        originalUrl: 'http://[::1',
        url: '/api/probe',
        path: '/api/probe',
      },
    });

    expect(guard.canActivate(context)).toBe(false);
  });

  it.each([
    '/api/other/../purchase-inventory/dashboard',
    '/api/other/./purchase-inventory/dashboard',
    '/api/other/%2e%2e/purchase-inventory/dashboard',
    '/api/other/%252e%252e/purchase-inventory/dashboard',
    '/api/other/%25252e%25252e/purchase-inventory/dashboard',
    '/api/purchase-inventory%2Fdashboard',
    '/api/purchase-inventory%252Fdashboard',
    '/api/purchase-inventory%25252Fdashboard',
    '/api/purchase-inventory\\dashboard',
    '/api/purchase-inventory%5Cdashboard',
    '/api/purchase-inventory%255Cdashboard',
    '/api/purchase-inventory%25255Cdashboard',
    '/api/purchase-inventory/%00dashboard',
    '/api/purchase-inventory/%2500dashboard',
    '/api/purchase-inventory/%252500dashboard',
    '/api/purchase-inventory/\u0000dashboard',
    '/api/purchase-inventory/%',
    '/api/purchase-inventory/%ZZ',
    '/api/purchase-inventory/%E0%A4%A',
    'http://integration.test/api/other/../purchase-inventory/dashboard',
    'http://user:pass@integration.test/api/purchase-inventory/dashboard',
    'http://integration.test/api/purchase-inventory/dashboard#fragment',
    'ftp://integration.test/api/purchase-inventory/dashboard',
    'http://[::1',
  ])('fails closed for unsafe or malformed request target %p', (path) => {
    authenticateAs('admin');
    const { context } = makeContext(path, {
      cookie: `${COOKIE_NAME}=admin-token`,
    });

    expect(guard.canActivate(context)).toBe(false);
  });

  it('fails closed when only a malformed parsed path is available', () => {
    authenticateAs('admin');
    const { context } = makeContext('/api/probe', {
      cookie: `${COOKIE_NAME}=admin-token`,
      requestOverrides: {
        originalUrl: undefined,
        url: undefined,
        path: 'http://[::1',
      },
    });

    expect(guard.canActivate(context)).toBe(false);
  });

  it.each([
    '/tenant/../admin',
    '/tenant/%2e%2e/admin',
    '/tenant%2Fescape',
    'https://integration.test/tenant',
    '/tenant?mode=unsafe',
    '/tenant\\escape',
    '/tenant/%00',
    '/tenant/%E0%A4%A',
    '  https://integration.test/tenant  ',
    '  //tenant  ',
    '  /tenant%252Fescape  ',
    '  /tenant/%25252e%25252e  ',
  ])('fails closed for malformed CLIENT_BASE_PATH %p', (basePath) => {
    process.env.CLIENT_BASE_PATH = basePath;
    authenticateAs('admin');
    const { context } = makeContext('/api/probe', {
      cookie: `${COOKIE_NAME}=admin-token`,
    });

    expect(guard.canActivate(context)).toBe(false);
  });

  it('matches CLIENT_BASE_PATH with Express case-insensitive semantics', () => {
    process.env.CLIENT_BASE_PATH = '/tenant';
    authenticateAs('editor');
    const { context } = makeContext(
      '/TENANT/API/Contract-Management/Dashboard/',
      { cookie: `${COOKIE_NAME}=old-token` },
    );

    expect(guard.canActivate(context)).toBe(false);
  });

  it('trims CLIENT_BASE_PATH like main.ts before matching it', () => {
    process.env.CLIENT_BASE_PATH = '  /tenant/  ';
    authenticateAs('duty_editor');
    const { context } = makeContext(
      '/TENANT/api/duty-schedules/vacancy-substitute',
      {
        method: 'POST',
        cookie: `${COOKIE_NAME}=duty-editor-token`,
      },
    );

    expect(guard.canActivate(context)).toBe(true);
  });

  it('treats a trimmed root CLIENT_BASE_PATH like main.ts', () => {
    process.env.CLIENT_BASE_PATH = '  /  ';
    authenticateAs('duty_editor');
    const { context } = makeContext('/api/duty-schedules/vacancy-substitute', {
      method: 'POST',
      cookie: `${COOKIE_NAME}=duty-editor-token`,
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it.each(['%25', '%2525'])(
    'allows a purchase applicant record id containing a legal encoded percent: %s',
    (recordId) => {
      authenticateAs('purchase_applicant', PURCHASE_ACCESS_BUILDINGS[0]);
      const { context } = makeContext(
        `/api/purchase-inventory/records/${recordId}`,
        {
          method: 'PATCH',
          cookie: `${COOKIE_NAME}=purchase-applicant-token`,
        },
      );

      expect(guard.canActivate(context)).toBe(true);
    },
  );

  it('normalizes only the one optional trailing slash Express accepts for an exact route', () => {
    authenticateAs('duty_editor');
    const singleTrailingSlash = makeContext(
      '/api/duty-schedules/vacancy-substitute/',
      {
        method: 'POST',
        cookie: `${COOKIE_NAME}=duty-editor-token`,
      },
    );
    const repeatedTrailingSlash = makeContext(
      '/api/duty-schedules/vacancy-substitute//',
      {
        method: 'POST',
        cookie: `${COOKIE_NAME}=duty-editor-token`,
      },
    );

    expect(guard.canActivate(singleTrailingSlash.context)).toBe(true);
    expect(guard.canActivate(repeatedTrailingSlash.context)).toBe(false);
  });

  it('does not treat false refresh values as force refresh', () => {
    const { context } = makeContext('/api/bitable/weather/now?refresh=false', {
      ...guestReadableTarget(),
      query: { refresh: 'false' },
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it.each(
    POST_DELETE_PATHS.filter(
      (path) => path !== '/api/purchase-inventory/records/batch-delete',
    ),
  )('denies editor persisted POST deletion %s', (path) => {
    authenticateAs('editor');
    const { context } = makeContext(path, {
      method: 'POST',
      cookie: `${COOKIE_NAME}=old-token`,
    });

    expect(guard.canActivate(context)).toBe(false);
  });

  it('denies editor every HTTP DELETE', () => {
    authenticateAs('editor');
    const { context } = makeContext('/api/inventory/items/1', {
      method: 'DELETE',
      cookie: `${COOKIE_NAME}=old-token`,
    });

    expect(guard.canActivate(context)).toBe(false);
  });

  it.each([
    '/api/contract-management',
    '/api/contract-management/dashboard',
    '/tenant/api/contract-management/dashboard?refresh=false',
  ])('denies editor contract endpoint %s', (path) => {
    process.env.CLIENT_BASE_PATH = '/tenant';
    authenticateAs('editor');
    const { context } = makeContext(path, {
      cookie: `${COOKIE_NAME}=old-token`,
    });

    expect(guard.canActivate(context)).toBe(false);
  });

  it('allows editor ordinary mutations including project termination', () => {
    authenticateAs('editor');
    const { context, request } = makeContext(
      '/api/duty-schedules/construction-management/projects/terminate',
      {
        method: 'POST',
        cookie: `${COOKIE_NAME}=old-token`,
      },
    );

    expect(guard.canActivate(context)).toBe(true);
    expect(request.accessRole).toBe('editor');
  });

  it('denies an AdminOnly endpoint to editor', () => {
    authenticateAs('editor');
    const target = adminOnlyTarget();
    const { context } = makeContext('/api/workflows/self-test', {
      ...target,
      cookie: `${COOKIE_NAME}=old-token`,
    });

    expect(guard.canActivate(context)).toBe(false);
  });

  it.each([
    ['guest', false],
    ['editor', false],
    ['admin', true],
  ] as const)(
    'keeps GuestReadable AdminOnly endpoint admin-only for %s',
    (role, expected) => {
      if (role !== 'guest') authenticateAs(role);
      const target = guestReadableAdminOnlyTarget();
      const { context } = makeContext('/api/workflows/self-test', {
        ...target,
        ...(role === 'guest' ? {} : { cookie: `${COOKIE_NAME}=old-token` }),
      });

      expect(guard.canActivate(context)).toBe(expected);
    },
  );

  it.each([
    ['guest', false],
    ['editor', false],
    ['admin', true],
  ] as const)(
    'keeps GuestReadable contract endpoint admin-only for %s',
    (role, expected) => {
      if (role !== 'guest') authenticateAs(role);
      const { context } = makeContext('/api/contract-management/dashboard', {
        ...guestReadableTarget(),
        ...(role === 'guest' ? {} : { cookie: `${COOKIE_NAME}=old-token` }),
      });

      expect(guard.canActivate(context)).toBe(expected);
    },
  );

  it.each([
    ['guest', false],
    ['editor', false],
    ['admin', true],
  ] as const)(
    'keeps GuestReadable DELETE endpoint admin-only for %s',
    (role, expected) => {
      if (role !== 'guest') authenticateAs(role);
      const { context } = makeContext('/api/inventory/items/1', {
        ...guestReadableTarget(),
        method: 'DELETE',
        ...(role === 'guest' ? {} : { cookie: `${COOKIE_NAME}=old-token` }),
      });

      expect(guard.canActivate(context)).toBe(expected);
    },
  );

  it.each([
    ['GET', '/api/contract-management/dashboard'],
    ['DELETE', '/api/inventory/items/1'],
    ['POST', POST_DELETE_PATHS[0]],
  ])('allows admin %s %s', (method, path) => {
    authenticateAs('admin');
    const { context, request } = makeContext(path, {
      method,
      cookie: `${COOKIE_NAME}=old-token`,
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(request.accessRole).toBe('admin');
  });

  it.each(['admin', 'editor'] as const)(
    'allows %s to manually send the duty overview screenshot to a group',
    (role) => {
      authenticateAs(role);
      const { context, request } = makeContext(
        '/api/duty-overview-screenshot/send',
        {
          method: 'POST',
          cookie: `${COOKIE_NAME}=screenshot-role-token`,
        },
      );

      expect(guard.canActivate(context)).toBe(true);
      expect(request.accessRole).toBe(role);
    },
  );

  it('allows a purchase admin on purchase APIs and injects the full principal', () => {
    const principal: AccessPrincipal = {
      role: 'purchase_admin',
      purchaseBuilding: null,
    };
    renew.mockReturnValue({
      token: 'renewed-token',
      principal,
      expiresAt: NOW + ACCESS_SESSION_TTL_MS,
    });
    const { context, request } = makeContext('/api/purchase-inventory', {
      cookie: `${COOKIE_NAME}=purchase-admin-token`,
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(request.accessPrincipal).toEqual(principal);
    expect(request.accessRole).toBe('purchase_admin');
  });

  it('allows a purchase admin through AdminOnly metadata within the normalized purchase prefix', () => {
    authenticateAs('purchase_admin');
    const { context } = makeContext(
      '/API/Purchase-Inventory/workflows/self-test/?probe=1',
      {
        ...adminOnlyTarget(),
        method: 'POST',
        cookie: `${COOKIE_NAME}=purchase-admin-token`,
      },
    );

    expect(guard.canActivate(context)).toBe(true);
  });

  it.each([
    '/api/purchase-inventory-evil/dashboard',
    '/api/purchase-inventoryevil/dashboard',
    '/api/duty-schedules',
    '/api/contract-management-archive',
  ])(
    'denies a purchase admin outside the exact purchase and contract prefixes %s',
    (path) => {
      authenticateAs('purchase_admin');
      const { context } = makeContext(path, {
        cookie: `${COOKIE_NAME}=purchase-admin-token`,
      });

      expect(guard.canActivate(context)).toBe(false);
    },
  );

  it.each([
    ['GET', '/api/purchase-inventory/dashboard'],
    ['GET', '/api/purchase-inventory/application-options'],
    ['GET', '/api/purchase-inventory/catalog-search'],
    ['GET', '/api/purchase-inventory/applicant-search'],
    ['POST', '/api/purchase-inventory/applications'],
    [
      'GET',
      '/api/purchase-inventory/applications/tasks/purchase-application-123',
    ],
    ['POST', '/api/purchase-inventory/records/batch-delete'],
    ['PATCH', '/api/purchase-inventory/records/record-123'],
    ['GET', '/api/purchase-inventory/workflows/record-123'],
    ['POST', '/api/purchase-inventory/workflows/record-123/order'],
    ['POST', '/api/purchase-inventory/workflows/record-123/receive'],
    ['GET', '/api/purchase-inventory/workflows/receipt-tasks/task-123'],
  ] as const)(
    'allows a purchase applicant on allowlisted endpoint %s %s',
    (method, path) => {
      const principal: AccessPrincipal = {
        role: 'purchase_applicant',
        purchaseBuilding: PURCHASE_ACCESS_BUILDINGS[0],
      };
      renew.mockReturnValue({
        token: 'renewed-token',
        principal,
        expiresAt: NOW + ACCESS_SESSION_TTL_MS,
      });
      const metadata = path.endsWith('/batch-delete') ? adminOnlyTarget() : {};
      const { context, request } = makeContext(path, {
        ...metadata,
        method,
        cookie: `${COOKIE_NAME}=purchase-applicant-token`,
      });

      expect(guard.canActivate(context)).toBe(true);
      expect(request.accessPrincipal).toEqual(principal);
      expect(request.accessRole).toBe('purchase_applicant');
    },
  );

  it('does not let a purchase applicant bypass AdminOnly on an ordinary allowlisted endpoint', () => {
    authenticateAs('purchase_applicant', PURCHASE_ACCESS_BUILDINGS[0]);
    const { context } = makeContext('/api/purchase-inventory/dashboard', {
      ...adminOnlyTarget(),
      method: 'GET',
      cookie: `${COOKIE_NAME}=purchase-applicant-token`,
    });

    expect(guard.canActivate(context)).toBe(false);
  });

  it.each([
    ['GET', '/API/Purchase-Inventory/Dashboard/?probe=1'],
    ['PATCH', '/api/purchase-inventory/records/record-123/?probe=1'],
  ] as const)(
    'normalizes an allowlisted purchase applicant endpoint %s %s',
    (method, path) => {
      authenticateAs('purchase_applicant', PURCHASE_ACCESS_BUILDINGS[0]);
      const { context } = makeContext(path, {
        method,
        cookie: `${COOKIE_NAME}=purchase-applicant-token`,
      });

      expect(guard.canActivate(context)).toBe(true);
    },
  );

  it('does not let a delayed business response overwrite a newer login cookie', () => {
    authenticateAs('editor');
    const { context, response } = makeContext(
      '/api/duty-schedules/travel-staff',
      {
        cookie: `${COOKIE_NAME}=old-editor-token`,
      },
    );

    expect(guard.canActivate(context)).toBe(true);
    expect(renew).toHaveBeenCalledWith('old-editor-token', NOW);
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it('validates an authenticated session without rewriting its cookie over HTTP', () => {
    authenticateAs('editor');
    const { context, response } = makeContext('/api/inventory', {
      cookie: `${COOKIE_NAME}=old-token`,
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(renew).toHaveBeenCalledWith('old-token', NOW);
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it.each([
    ['actual HTTPS', { secure: true, protocol: 'https' }, {}],
    [
      'explicit secure cookie setting',
      { secure: false, protocol: 'http' },
      { LOCAL_ACCESS_COOKIE_SECURE: 'true' },
    ],
    [
      'explicitly trusted HTTPS proxy',
      {
        secure: false,
        protocol: 'http',
        headers: { 'x-forwarded-proto': 'https' },
      },
      { LOCAL_ACCESS_TRUST_PROXY: 'true' },
    ],
  ])(
    'does not rewrite cookies for %s business requests',
    (_label, requestOverrides, environment) => {
      Object.assign(process.env, environment);
      authenticateAs('admin');
      const { context, response } = makeContext('/api/inventory', {
        cookie: `${COOKIE_NAME}=old-token`,
        requestOverrides,
      });

      expect(guard.canActivate(context)).toBe(true);
      expect(response.cookie).not.toHaveBeenCalled();
    },
  );

  it('never lets an explicit false setting downgrade an actual HTTPS request', () => {
    process.env.LOCAL_ACCESS_COOKIE_SECURE = 'false';
    authenticateAs('admin');
    const { context, response } = makeContext('/api/inventory', {
      cookie: `${COOKIE_NAME}=old-token`,
      requestOverrides: { secure: true, protocol: 'https' },
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it.each([
    `${COOKIE_NAME}=%E0%A4%A`,
    `${COOKIE_NAME}=one; ${COOKIE_NAME}=two`,
    `${COOKIE_NAME}`,
  ])('handles malformed cookie header without throwing: %s', (cookie) => {
    const target = guestReadableTarget();
    const { context, request, response } = makeContext('/api/duty-schedules', {
      ...target,
      cookie,
    });

    expect(() => guard.canActivate(context)).not.toThrow();
    expect(request.accessRole).toBe('guest');
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it.each([
    `${COOKIE_NAME}=valid-session; ${COOKIE_NAME}`,
    `${COOKIE_NAME}; ${COOKIE_NAME}=valid-session`,
  ])('rejects every duplicate cookie ordering: %s', (cookie) => {
    expect(readStrictCookie(cookie, COOKIE_NAME)).toEqual({ present: true });
  });

  it.each([
    `${COOKIE_NAME}=valid-session; ${COOKIE_NAME}`,
    `${COOKIE_NAME}; ${COOKIE_NAME}=valid-session`,
  ])('downgrades duplicate cookie ordering to guest: %s', (cookie) => {
    renew.mockImplementation((token) =>
      token === 'valid-session'
        ? {
            token: 'renewed-token',
            principal: { role: 'editor', purchaseBuilding: null },
            expiresAt: NOW + ACCESS_SESSION_TTL_MS,
          }
        : null,
    );
    const { context, request } = makeContext('/api/bitable/weather/now', {
      ...guestReadableTarget(),
      cookie,
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(request.accessRole).toBe('guest');
  });

  function authenticateAs(
    role: Exclude<AccessRole, 'guest'>,
    purchaseBuilding: PurchaseAccessBuilding | null = null,
  ) {
    renew.mockReturnValue({
      token: 'renewed-token',
      principal: { role, purchaseBuilding },
      expiresAt: NOW + ACCESS_SESSION_TTL_MS,
    });
  }
});

describe('UnifiedAccessGuard Nest HTTP integration', () => {
  let app: INestApplication;
  let port: number;

  beforeAll(async () => {
    const access = {
      cookieName: COOKIE_NAME,
      isAccessControlEnabled: () => true,
      renew: (token: string | undefined, now: number) => {
        if (
          token !== 'editor-token' &&
          token !== 'admin-token' &&
          token !== 'duty-editor-token'
        ) {
          return null;
        }
        const role =
          token === 'admin-token'
            ? 'admin'
            : token === 'duty-editor-token'
              ? 'duty_editor'
              : 'editor';
        return {
          token: `renewed-${role}-token`,
          principal: { role, purchaseBuilding: null },
          expiresAt: now + ACCESS_SESSION_TTL_MS,
        };
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [HttpProbeController],
      providers: [
        Reflector,
        {
          provide: UnifiedAccessGuard,
          useFactory: (reflector: Reflector) =>
            new UnifiedAccessGuard(reflector, access as never),
          inject: [Reflector],
        },
        {
          provide: APP_GUARD,
          useExisting: UnifiedAccessGuard,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each([
    '/api/duty-schedules/construction-management',
    '/api/duty-schedules/construction-management/attachments/fixture',
    '/api/sync-task/construction-12345678-1234-4123-8123-123456789abc',
  ])('enforces construction guest rejection over HTTP: %s', async (path) => {
    expect(await requestStatus(port, path)).toBe(403);
    expect(await requestStatus(port, path, { cookie: `${COOKIE_NAME}=admin-token` })).toBe(200);
    expect(await requestStatus(port, path, { cookie: `${COOKIE_NAME}=editor-token` })).toBe(200);
  });

  it('returns 403 for uppercase ordinary API request as guest', async () => {
    expect(await requestStatus(port, '/API/probe')).toBe(403);
  });

  it('returns 403 for absolute-form mixed-case contract request as editor', async () => {
    const target = `http://127.0.0.1:${port}/API/Contract-Management/probe`;

    expect(
      await requestStatus(port, target, {
        cookie: `${COOKIE_NAME}=editor-token`,
      }),
    ).toBe(403);
  });

  it('still allows an admin on a mixed-case contract API path', async () => {
    expect(
      await requestStatus(port, '/API/Contract-Management/probe', {
        cookie: `${COOKIE_NAME}=admin-token`,
      }),
    ).toBe(200);
  });

  it('still allows a guest on a mixed-case GuestReadable path', async () => {
    expect(await requestStatus(port, '/API/guest')).toBe(200);
  });

  it.each([
    ['ftp absolute-form', 'ftp://integration.test/api/probe', 403],
    [
      'absolute-form userinfo',
      'http://user:pass@integration.test/api/probe',
      403,
    ],
    ['absolute-form backslash', 'http://integration.test/api\\probe', 403],
    ['origin-form backslash', '/api\\probe', 404],
    ['origin-form fragment', '/api/probe#fragment', 403],
  ])(
    'fails closed for a real Express HTTP request with %s',
    async (_label, target, expectedStatus) => {
      expect(
        await requestRawTargetStatus(port, target, {
          Cookie: `${COOKIE_NAME}=admin-token`,
        }),
      ).toBe(expectedStatus);
    },
  );

  it('allows a valid absolute-form target through real Express HTTP', async () => {
    expect(
      await requestRawTargetStatus(port, 'http://integration.test/api/probe', {
        Cookie: `${COOKIE_NAME}=admin-token`,
      }),
    ).toBe(200);
  });

  it.each(['/api/records/%25', '/api/records/%2525'])(
    'allows a legal encoded percent on a real Express dynamic route: %s',
    async (target) => {
      expect(
        await requestRawTargetStatus(port, target, {
          Cookie: `${COOKIE_NAME}=admin-token`,
        }),
      ).toBe(200);
    },
  );

  it.each([
    '/api/records/%2F',
    '/api/records/%252F',
    '/api/records/%25252F',
    '/api/records/%5C',
    '/api/records/%255C',
    '/api/records/%25255C',
    '/api/records/%2E%2E',
    '/api/records/%252E%252E',
    '/api/records/%25252E%25252E',
    '/api/records/%00',
    '/api/records/%2500',
    '/api/records/%252500',
  ])(
    'rejects recursively encoded structural bytes on a real Express route: %s',
    async (target) => {
      expect(
        await requestRawTargetStatus(port, target, {
          Cookie: `${COOKIE_NAME}=admin-token`,
        }),
      ).toBe(403);
    },
  );

  it.each([
    ['false', { recordId: 'record-1', clearAdjustment: false }, 201],
    ['omitted', { recordId: 'record-1' }, 201],
    ['true', { recordId: 'record-1', clearAdjustment: true }, 403],
    ['invalid', { recordId: 'record-1', clearAdjustment: 'false' }, 403],
  ] as const)(
    'enforces duty-editor clearAdjustment for a real HTTP POST body: %s',
    async (_label, body, expectedStatus) => {
      expect(
        await requestJsonStatus(port, '/api/change-info/adjustment', body, {
          cookie: `${COOKIE_NAME}=duty-editor-token`,
        }),
      ).toBe(expectedStatus);
    },
  );
});

function makeContext(
  url: string,
  options: {
    method?: string;
    cookie?: string;
    query?: Record<string, unknown>;
    controller?: Function;
    handler?: Function;
    requestOverrides?: Record<string, unknown>;
  } = {},
) {
  class DefaultController {}
  const defaultHandler = () => undefined;
  const request: AccessRequest = {
    method: options.method ?? 'GET',
    originalUrl: url,
    url,
    path: url.split('?')[0],
    query: options.query ?? {},
    headers: options.cookie ? { cookie: options.cookie } : {},
    secure: false,
    protocol: 'http',
    socket: { remoteAddress: '127.0.0.1' } as never,
    ...(options.requestOverrides ?? {}),
  };
  const response: TestResponse = {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
    once: jest.fn(),
  };
  const context = {
    getClass: () => options.controller ?? DefaultController,
    getHandler: () => options.handler ?? defaultHandler,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;

  return { context, request, response };
}

function releaseGuestSubmission(response: TestResponse): void {
  const finishListener = response.once.mock.calls.find(
    ([event]) => event === 'finish',
  )?.[1] as (() => void) | undefined;
  finishListener?.();
}

function expectGuestSubmissionStatus(
  operation: () => unknown,
  expectedStatus: number,
): void {
  try {
    operation();
    throw new Error('expected guest submission limiter to reject');
  } catch (error) {
    expect((error as { getStatus?: () => number }).getStatus?.()).toBe(
      expectedStatus,
    );
  }
}

function guestReadableTarget() {
  class GuestController {
    read() {}
  }
  GuestReadable()(
    GuestController.prototype,
    'read',
    Object.getOwnPropertyDescriptor(GuestController.prototype, 'read'),
  );
  return {
    controller: GuestController,
    handler: GuestController.prototype.read,
  };
}

function adminOnlyTarget() {
  class AdminController {
    run() {}
  }
  AdminOnly()(
    AdminController.prototype,
    'run',
    Object.getOwnPropertyDescriptor(AdminController.prototype, 'run'),
  );
  return {
    controller: AdminController,
    handler: AdminController.prototype.run,
  };
}

function guestReadableAdminOnlyTarget() {
  class RestrictedController {
    read() {}
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    RestrictedController.prototype,
    'read',
  );
  GuestReadable()(RestrictedController.prototype, 'read', descriptor);
  AdminOnly()(RestrictedController.prototype, 'read', descriptor);
  return {
    controller: RestrictedController,
    handler: RestrictedController.prototype.read,
  };
}

function guestSubmittableTarget(adminOnly = false) {
  class SubmissionController {
    submit() {}
  }
  const handler = SubmissionController.prototype.submit;
  Reflect.defineMetadata(GUEST_SUBMITTABLE_METADATA_KEY, true, handler);
  if (adminOnly) {
    AdminOnly()(
      SubmissionController.prototype,
      'submit',
      Object.getOwnPropertyDescriptor(SubmissionController.prototype, 'submit'),
    );
  }
  return {
    controller: SubmissionController,
    handler,
  };
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

class HttpProbeController {
  constructionProbe() { return { ok: true }; }
  constructionAttachmentProbe() { return { ok: true }; }
  constructionSyncProbe() { return { ok: true }; }
  probe() {
    return { ok: true };
  }

  contractProbe() {
    return { ok: true };
  }

  guestProbe() {
    return { ok: true };
  }

  changeAdjustmentProbe() {
    return { ok: true };
  }

  recordProbe() {
    return { ok: true };
  }
}

Controller('api')(HttpProbeController);
applyGetRoute(HttpProbeController, 'constructionProbe', 'duty-schedules/construction-management', true);
applyGetRoute(HttpProbeController, 'constructionAttachmentProbe', 'duty-schedules/construction-management/attachments/fixture', true);
applyGetRoute(HttpProbeController, 'constructionSyncProbe', 'sync-task/construction-12345678-1234-4123-8123-123456789abc', true);
applyGetRoute(HttpProbeController, 'probe', 'probe');
applyGetRoute(
  HttpProbeController,
  'contractProbe',
  'contract-management/probe',
);
applyGetRoute(HttpProbeController, 'guestProbe', 'guest', true);
applyPostRoute(
  HttpProbeController,
  'changeAdjustmentProbe',
  'change-info/adjustment',
);
applyGetRoute(HttpProbeController, 'recordProbe', 'records/:recordId');

function applyGetRoute(
  controller: typeof HttpProbeController,
  method: keyof HttpProbeController,
  path: string,
  guestReadable = false,
) {
  const descriptor = Object.getOwnPropertyDescriptor(
    controller.prototype,
    method,
  );
  if (!descriptor) throw new Error(`Missing HTTP probe method: ${method}`);
  Get(path)(controller.prototype, method, descriptor);
  if (guestReadable) {
    GuestReadable()(controller.prototype, method, descriptor);
  }
}

function applyPostRoute(
  controller: typeof HttpProbeController,
  method: keyof HttpProbeController,
  path: string,
) {
  const descriptor = Object.getOwnPropertyDescriptor(
    controller.prototype,
    method,
  );
  if (!descriptor) throw new Error(`Missing HTTP probe method: ${method}`);
  Post(path)(controller.prototype, method, descriptor);
}

function requestStatus(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = nodeHttpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path,
        headers,
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

function requestJsonStatus(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<number> {
  const encodedBody = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = nodeHttpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(encodedBody)),
          ...headers,
        },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.end(encodedBody);
  });
}

function requestRawTargetStatus(
  port: number,
  target: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      const serializedHeaders = Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join('\r\n');
      socket.end(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n${serializedHeaders}\r\n\r\n`,
      );
    });
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5_000, () => {
      socket.destroy(new Error('Timed out waiting for raw HTTP response'));
    });
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.on('end', () => {
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(response);
      if (!match) {
        reject(
          new Error(`Invalid raw HTTP response: ${response.slice(0, 80)}`),
        );
        return;
      }
      resolve(Number(match[1]));
    });
    socket.on('error', reject);
  });
}
