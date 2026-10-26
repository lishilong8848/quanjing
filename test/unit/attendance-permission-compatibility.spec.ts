import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AccessRole } from '../../shared/access-control.interface';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { UnifiedAccessService } from '../../server/common/access/unified-access.service';
import { AttendanceHistoryController } from '../../server/modules/duty-schedule/attendance-history.controller';
import { AttendanceHistoryService } from '../../server/modules/duty-schedule/attendance-history.service';
import { TodayAttendanceController } from '../../server/modules/duty-schedule/today-attendance.controller';
import { TodayAttendanceSnapshotService } from '../../server/modules/duty-schedule/today-attendance-snapshot.service';
import { AttendanceAutomationCoordinatorService } from '../../server/modules/duty-schedule/attendance-automation-coordinator.service';
import { canAccessPage } from '../../client/src/access/access-policy';

describe('actual attendance routes after professional access changes', () => {
  let app: INestApplication;
  let port: number;
  const history = { getHistory: jest.fn(async () => ({ items: [] })) };
  const snapshots = {
    getSnapshot: jest.fn(async () => ({ entries: [] })),
    getCorrectionEvidence: jest.fn(async () => ({ images: [] })),
    downloadCorrectionEvidence: jest.fn(async () => ({
      buffer: Buffer.from('representative-image'),
      contentType: 'image/png',
      fileName: 'fixture.png',
    })),
  };
  const coordinator = {
    requestManualRetry: jest.fn(async () => ({ accepted: true })),
  };
  const access = {
    cookieName: 'attendance_compatibility',
    isAccessControlEnabled: () => true,
    renew: (value?: string) =>
      value && value !== 'guest' && value !== 'expired'
        ? {
            principal: {
              role: value,
              purchaseBuilding: null,
              specialties: ['暖通'],
            },
            principalFingerprint: 'synthetic-fixture',
          }
        : undefined,
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AttendanceHistoryController, TodayAttendanceController],
      providers: [
        { provide: AttendanceHistoryService, useValue: history },
        { provide: TodayAttendanceSnapshotService, useValue: snapshots },
        {
          provide: AttendanceAutomationCoordinatorService,
          useValue: coordinator,
        },
        { provide: UnifiedAccessService, useValue: access },
        {
          provide: APP_GUARD,
          useFactory: (reflector: Reflector) =>
            new UnifiedAccessGuard(reflector, access as never),
          inject: [Reflector],
        },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function call(path: string, role: AccessRole | 'expired', method = 'GET') {
    return new Promise<{
      status: number;
      body: string;
      headers: Record<string, unknown>;
    }>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            cookie: `attendance_compatibility=${role}`,
            'Content-Type': 'application/json',
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () =>
            resolve({ status: res.statusCode!, body, headers: res.headers }),
          );
        },
      );
      req.on('error', reject);
      req.end(
        method === 'POST'
          ? JSON.stringify({
              clientMutationId: 'attendance-compatibility-fixture',
            })
          : undefined,
      );
    });
  }

  const roles: AccessRole[] = [
    'guest',
    'professional_admin',
    'building_admin',
    'editor',
    'duty_editor',
    'inventory_admin',
    'purchase_admin',
    'purchase_applicant',
    'construction_admin',
    'supply_chain_admin',
    'admin',
  ];
  it.each(roles.filter(role => role !== 'guest'))(
    '%s can read cached history via the actual controller',
    async (role) => {
      expect(canAccessPage(role, '/monthly-schedule')).toBe(true);
      const result = await call(
        '/api/attendance/history?from=2026-10-01&through=2026-10-10',
        role,
      );
      expect(result.status).toBe(200);
      expect(history.getHistory).toHaveBeenCalledWith(
        '2026-10-01',
        '2026-10-10',
        false,
      );
    },
  );

  it.each(['/api/attendance/today', '/api/attendance/history?from=2026-10-01&through=2026-10-10'])(
    'guest cannot read private attendance through actual route %s',
    async path => {
      expect(canAccessPage('guest', '/monthly-schedule')).toBe(false);
      expect((await call(path, 'guest')).status).toBe(403);
      expect(history.getHistory).not.toHaveBeenCalled();
      expect(snapshots.getSnapshot).not.toHaveBeenCalled();
    },
  );

  it.each(roles.filter((role) => role !== 'admin'))(
    '%s cannot read evidence or retry through actual routes',
    async (role) => {
      for (const [path, method] of [
        [
          '/api/attendance/correction-evidence?date=2026-10-01&entryKey=fixture',
          'GET',
        ],
        [
          '/api/attendance/correction-evidence/image?date=2026-10-01&entryKey=fixture&index=0',
          'GET',
        ],
        ['/api/attendance/today/retry', 'POST'],
      ])
        expect((await call(path, role, method)).status).toBe(403);
      expect(snapshots.getCorrectionEvidence).not.toHaveBeenCalled();
      expect(snapshots.downloadCorrectionEvidence).not.toHaveBeenCalled();
      expect(coordinator.requestManualRetry).not.toHaveBeenCalled();
    },
  );

  it.each(['guest', 'professional_admin', 'expired'] as const)(
    '%s cannot bypass cache policy using refresh',
    async (role) => {
      expect(
        (
          await call(
            '/api/attendance/history?from=2026-10-01&through=2026-10-10&refresh=true',
            role,
          )
        ).status,
      ).toBe(403);
      expect(history.getHistory).not.toHaveBeenCalled();
    },
  );

  it('expired sessions cannot retrieve an image', async () => {
    expect(
      (
        await call(
          '/api/attendance/correction-evidence/image?date=2026-10-01&entryKey=fixture&index=0',
          'expired',
        )
      ).status,
    ).toBe(403);
    expect(snapshots.downloadCorrectionEvidence).not.toHaveBeenCalled();
  });

  it('admin reads an image using the existing private no-store route', async () => {
    expect(
      (
        await call(
          '/api/attendance/correction-evidence?date=2026-10-01&entryKey=fixture',
          'admin',
        )
      ).status,
    ).toBe(200);
    const image = await call(
      '/api/attendance/correction-evidence/image?date=2026-10-01&entryKey=fixture&index=0',
      'admin',
    );
    expect(image.status).toBe(200);
    expect(image.headers['cache-control']).toBe('private, no-store');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(image.body).toBe('representative-image');
  });

  it('admin retry uses the actual guarded controller and service', async () => {
    jest.useFakeTimers({
      now: new Date('2026-10-10T12:00:00Z'),
      doNotFake: [
        'nextTick',
        'setImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'performance',
        'queueMicrotask',
        'hrtime',
      ],
    });
    try {
      expect(
        (await call('/api/attendance/today/retry', 'admin', 'POST')).status,
      ).toBe(202);
      expect(coordinator.requestManualRetry).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
