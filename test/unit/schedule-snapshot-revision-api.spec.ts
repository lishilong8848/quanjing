import 'reflect-metadata';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test, type TestingModule } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { type AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import ts = require('typescript');
import { GuestReadableMetadataKey } from '../../server/common/access/unified-access.decorators';

class BitableSyncServiceToken {}
class CertificateDashboardServiceToken {}
class CertificateDashboardNotificationServiceToken {}
class TrainingDashboardServiceToken {}
class TodayOperationsAlarmServiceToken {}
class TodayOperationsOverviewServiceToken {}

type BitableSyncControllerConstructor =
  typeof import('../../server/modules/bitable-sync/bitable-sync.controller').BitableSyncController;
const BitableSyncController = loadLegacyBitableSyncController();

const NO_CACHE_VALUE =
  'no-store, no-cache, must-revalidate, proxy-revalidate';

interface ClientScheduleSnapshotRevisionResponse {
  available: boolean;
  token: string | null;
  nonDutyFetchedAt: number | null;
  scheduleFetchedAt: number | null;
}

const expectedResponse: ClientScheduleSnapshotRevisionResponse = {
  available: true,
  token: '1725000000100:1725000000900',
  nonDutyFetchedAt: 1_725_000_000_100,
  scheduleFetchedAt: 1_725_000_000_900,
};

describe('schedule snapshot revision API', () => {
  let moduleRef: TestingModule;
  let bitableSyncService: {
    getScheduleSnapshotRevision: jest.Mock<
      Promise<ClientScheduleSnapshotRevisionResponse>,
      []
    >;
  };

  beforeEach(async () => {
    bitableSyncService = {
      getScheduleSnapshotRevision: jest.fn().mockResolvedValue(expectedResponse),
    };
    moduleRef = await Test.createTestingModule({
      controllers: [BitableSyncController],
      providers: [
        { provide: BitableSyncServiceToken, useValue: bitableSyncService },
        { provide: CertificateDashboardServiceToken, useValue: {} },
        { provide: CertificateDashboardNotificationServiceToken, useValue: {} },
        { provide: TrainingDashboardServiceToken, useValue: {} },
        { provide: TodayOperationsAlarmServiceToken, useValue: {} },
        { provide: TodayOperationsOverviewServiceToken, useValue: {} },
      ],
    }).compile();
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('publishes GET /api/bitable/schedule-snapshot-revision as guest-readable', () => {
    const handler = (
      BitableSyncController.prototype as unknown as Record<
        string,
        () => Promise<ClientScheduleSnapshotRevisionResponse>
      >
    ).getScheduleSnapshotRevision;

    expect(handler).toBeDefined();
    expect(Reflect.getMetadata(PATH_METADATA, BitableSyncController)).toBe(
      'api/bitable',
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      'schedule-snapshot-revision',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(GuestReadableMetadataKey, handler)).toBe(true);
  });

  it('serves the client response contract with no-store headers', async () => {
    const app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/bitable/schedule-snapshot-revision`,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe(NO_CACHE_VALUE);
      expect(await response.json()).toEqual(expectedResponse);
      expect(
        bitableSyncService.getScheduleSnapshotRevision,
      ).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

function loadLegacyBitableSyncController(): BitableSyncControllerConstructor {
  const controllerPath = join(
    process.cwd(),
    'server/modules/bitable-sync/bitable-sync.controller.ts',
  );
  const transpiled = ts.transpileModule(readFileSync(controllerPath, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
      importHelpers: false,
    },
    fileName: controllerPath,
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    throw new Error(
      errors
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        )
        .join('; '),
    );
  }

  const dependencies = new Map<string, unknown>([
    ['@nestjs/common', jest.requireActual('@nestjs/common')],
    [
      '../../../shared/person-profile-access',
      { canViewPersonProfileDetails: () => true },
    ],
    [
      '../../../shared/organization-person-profile',
      {
        canViewOrganizationPersonProfile: () => true,
        parseOrganizationPersonProfileSource: (value: unknown) => value,
      },
    ],
    [
      '../../common/access/unified-access.decorators',
      jest.requireActual(
        '../../server/common/access/unified-access.decorators',
      ),
    ],
    ['./bitable-sync.service', { BitableSyncService: BitableSyncServiceToken }],
    [
      './certificate-dashboard-notification.service',
      {
        CertificateDashboardNotificationService:
          CertificateDashboardNotificationServiceToken,
      },
    ],
    [
      './certificate-dashboard.service',
      { CertificateDashboardService: CertificateDashboardServiceToken },
    ],
    [
      './training-dashboard.service',
      { TrainingDashboardService: TrainingDashboardServiceToken },
    ],
    [
      './today-operations-alarm.service',
      { TodayOperationsAlarmService: TodayOperationsAlarmServiceToken },
    ],
    [
      './today-operations-overview.service',
      { TodayOperationsOverviewService: TodayOperationsOverviewServiceToken },
    ],
    [
      './organization-person-profile.mapper',
      { mergeOrganizationPersonCertificatesFromDashboard: () => [] },
    ],
    [
      './person-profile-source',
      {
        parsePersonProfilePhotoScope: (value: unknown) => value,
        parsePersonProfileScope: (value: unknown) => value,
      },
    ],
  ]);
  const moduleRecord: { exports: Record<string, unknown> } = { exports: {} };
  const evaluate = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    transpiled.outputText,
  ) as (
    requireModule: (specifier: string) => unknown,
    module: { exports: Record<string, unknown> },
    exports: Record<string, unknown>,
    filename: string,
    directory: string,
  ) => void;
  evaluate(
    (specifier) => {
      if (!dependencies.has(specifier)) {
        throw new Error(`unexpected controller dependency: ${specifier}`);
      }
      return dependencies.get(specifier);
    },
    moduleRecord,
    moduleRecord.exports,
    controllerPath,
    dirname(controllerPath),
  );
  return moduleRecord.exports
    .BitableSyncController as BitableSyncControllerConstructor;
}
