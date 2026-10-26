import 'reflect-metadata';

import { RequestMethod } from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Test, type TestingModule } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { type AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import ts = require('typescript');
import type { WeatherWarningSnapshot } from '../../shared/api.interface';
import { GuestReadableMetadataKey } from '../../server/common/access/unified-access.decorators';
import { buildWeatherWarningExternalContract } from '../../server/modules/weather-warning/weather-warning-external-contract';
import { WeatherWarningSnapshotService } from '../../server/modules/weather-warning/weather-warning-snapshot.service';

const NO_CACHE_VALUE = 'no-store, no-cache, must-revalidate, proxy-revalidate';
type WeatherWarningQueryControllerConstructor =
  typeof import('../../server/modules/weather-warning/weather-warning-query.controller').WeatherWarningQueryController;
const WeatherWarningQueryController = loadLegacyWeatherWarningQueryController();

describe('WeatherWarningQueryController', () => {
  let moduleRef: TestingModule;
  let snapshotService: { getSnapshot: jest.Mock };

  beforeEach(async () => {
    snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(createSnapshot()),
    };
    moduleRef = await Test.createTestingModule({
      controllers: [WeatherWarningQueryController],
      providers: [
        { provide: WeatherWarningSnapshotService, useValue: snapshotService },
      ],
    }).compile();
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('publishes GET /api/weather/warning as a guest-readable route', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, WeatherWarningQueryController),
    ).toBe('api/weather');
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        WeatherWarningQueryController.prototype.getWarning,
      ),
    ).toBe('warning');
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        WeatherWarningQueryController.prototype.getWarning,
      ),
    ).toBe(RequestMethod.GET);
    expect(
      Reflect.getMetadata(
        GuestReadableMetadataKey,
        WeatherWarningQueryController.prototype.getWarning,
      ),
    ).toBe(true);
  });

  it('serves the unified text contract with no-cache headers', async () => {
    const app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/weather/warning`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe(NO_CACHE_VALUE);
      expect(response.headers.get('pragma')).toBe('no-cache');
      expect(response.headers.get('expires')).toBe('0');

      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        schemaVersion: '2.0',
        pollIntervalSeconds: 600,
        hasWarning: true,
        hasGuard: true,
        guardLevel: '三级戒备',
      });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/https?:\/\//u);
      expect(serialized).not.toMatch(/(?:file|image|link|url|token)/iu);
      expect(serialized).not.toContain('checkSummary');
      expect(serialized).not.toContain('buildingProgress');
      expect(snapshotService.getSnapshot).toHaveBeenCalledTimes(1);
      expect(snapshotService.getSnapshot).toHaveBeenCalledWith({
        includeCheckProgress: false,
      });
    } finally {
      await app.close();
    }
  });
});

function createSnapshot(): WeatherWarningSnapshot {
  return {
    status: 'active',
    sourceState: 'fresh',
    guardDecisionState: 'fresh',
    checkSyncState: 'fresh',
    snapshotAt: '2026-08-11T03:29:21.348Z',
    lastSuccessAt: '2026-08-11T03:20:14.449Z',
    guardLevel: '三级戒备',
    matchedWarnings: [
      {
        id: 'warning-blue-rain',
        title: '江苏省气象台发布暴雨蓝色预警',
        type: '暴雨',
        color: 'blue',
        guardLevel: '三级戒备',
      },
    ],
    unmatchedWarnings: [],
    actions: ['相关人员7*24 On call'],
    weather: {
      temperature: '29',
      feelsLike: '31',
      humidity: '92',
      windDirection: '东风',
      windScale: '3',
      observedAt: '2026-08-11 10:00:08',
    },
    checkSummary: {
      device: 'not_started',
      environment: 'not_required',
      disaster: 'not_started',
      materials: 'not_started',
      contacts: 'not_started',
      managerConfirmation: 'not_started',
      abnormalSummaries: [],
    },
    requiredCheckKeys: [
      'device',
      'disaster',
      'materials',
      'contacts',
      'managerConfirmation',
    ],
    buildingProgress: {
      available: true,
      buildings: [],
      missingRegistrationBuildings: ['A楼'],
      unassignedRecordCount: 0,
      incompleteItems: [],
    },
    canSendTest: true,
  };
}

function loadLegacyWeatherWarningQueryController(): WeatherWarningQueryControllerConstructor {
  const controllerPath = join(
    process.cwd(),
    'server/modules/weather-warning/weather-warning-query.controller.ts',
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
      '@server/common/access/unified-access.decorators',
      jest.requireActual(
        '../../server/common/access/unified-access.decorators',
      ),
    ],
    [
      './weather-warning-external-contract',
      { buildWeatherWarningExternalContract },
    ],
    ['./weather-warning-snapshot.service', { WeatherWarningSnapshotService }],
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
    .WeatherWarningQueryController as WeatherWarningQueryControllerConstructor;
}
