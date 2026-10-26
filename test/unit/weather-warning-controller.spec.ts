import 'reflect-metadata';

import { BadRequestException, RequestMethod } from '@nestjs/common';
import {
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Test, type TestingModule } from '@nestjs/testing';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { type AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import type { Request } from 'express';
import ts = require('typescript');
import type {
  WeatherGuardRegistrationOptions,
  WeatherGuardRegistrationRequest,
  WeatherGuardRegistrationResponse,
  WeatherWarningSnapshot,
} from '../../shared/api.interface';
import {
  AdminOnlyMetadataKey,
  GuestReadableMetadataKey,
  GuestSubmittableMetadataKey,
} from '../../server/common/access/unified-access.decorators';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { createApiCsrfValidationMiddleware } from '../../server/main';
import {
  WeatherWarningNotificationService,
  toPublicWeatherWarningSnapshot,
} from '../../server/modules/weather-warning/weather-warning-notification.service';
import type { WeatherWarningRegistrationUploadFile } from '../../server/modules/weather-warning/weather-warning-registration.gateway';
import { WeatherWarningRegistrationEnabledGuard } from '../../server/modules/weather-warning/weather-warning-registration-enabled.guard';
import { WeatherWarningRegistrationService } from '../../server/modules/weather-warning/weather-warning-registration.service';
import { loadWeatherWarningFeatureConfig } from '../../server/modules/weather-warning/weather-warning-feature.config';
import { WeatherWarningSnapshotService } from '../../server/modules/weather-warning/weather-warning-snapshot.service';

jest.mock('../../server/app.module', () => ({ AppModule: class AppModule {} }));
jest.mock('../../server/runtime-env', () => ({}));

const NO_CACHE_VALUE = 'no-store, no-cache, must-revalidate, proxy-revalidate';
const REGISTRATION_PAYLOAD_MAX_BYTES = 128 * 1024;
type WeatherWarningControllerConstructor =
  typeof import('../../server/modules/weather-warning/weather-warning.controller').WeatherWarningController;
type WeatherWarningControllerInstance =
  InstanceType<WeatherWarningControllerConstructor>;
const WeatherWarningController = loadLegacyWeatherWarningController();

describe('WeatherWarningController', () => {
  const originalRegistrationEnabled =
    process.env.WEATHER_WARNING_REGISTRATION_ENABLED;
  const originalProgressNotificationsEnabled =
    process.env.FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED;
  let snapshotService: { getSnapshot: jest.Mock };
  let notificationService: {
    getTestPreview: jest.Mock;
    sendTest: jest.Mock;
    sendFullFlowTest: jest.Mock;
    sendFullFlowProgress: jest.Mock;
  };
  let registrationService: {
    getOptions: jest.Mock;
    submit: jest.Mock;
  };
  let moduleRef: TestingModule;
  let controller: WeatherWarningControllerInstance;
  let registrationController: WeatherWarningControllerInstance;

  beforeEach(async () => {
    process.env.WEATHER_WARNING_REGISTRATION_ENABLED = 'true';
    process.env.FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED = 'true';
    snapshotService = { getSnapshot: jest.fn() };
    notificationService = {
      getTestPreview: jest.fn(),
      sendTest: jest.fn(),
      sendFullFlowTest: jest.fn(),
      sendFullFlowProgress: jest.fn(),
    };
    registrationService = {
      getOptions: jest.fn(),
      submit: jest.fn(),
    };
    moduleRef = await Test.createTestingModule({
      controllers: [WeatherWarningController],
      providers: [
        { provide: WeatherWarningSnapshotService, useValue: snapshotService },
        {
          provide: WeatherWarningNotificationService,
          useValue: notificationService,
        },
        {
          provide: WeatherWarningRegistrationService,
          useValue: registrationService,
        },
      ],
    }).compile();
    controller = moduleRef.get(WeatherWarningController);
    registrationController = controller;
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  afterAll(() => {
    if (originalRegistrationEnabled === undefined) {
      delete process.env.WEATHER_WARNING_REGISTRATION_ENABLED;
    } else {
      process.env.WEATHER_WARNING_REGISTRATION_ENABLED =
        originalRegistrationEnabled;
    }
    if (originalProgressNotificationsEnabled === undefined) {
      delete process.env.FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED;
    } else {
      process.env.FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED =
        originalProgressNotificationsEnabled;
    }
  });

  it('compiles the controller in a Nest TestingModule with all three service dependencies', () => {
    expect(controller).toBeInstanceOf(WeatherWarningController);
    expect(Reflect.getMetadata(PATH_METADATA, WeatherWarningController)).toBe(
      'api/weather-warning',
    );
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        WeatherWarningController.prototype.getRegistrationOptions,
      ),
    ).toBe('registration/options');
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        WeatherWarningController.prototype.getRegistrationOptions,
      ),
    ).toBe(RequestMethod.GET);
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        WeatherWarningController.prototype.submitRegistration,
      ),
    ).toBe('registration');
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        WeatherWarningController.prototype.submitRegistration,
      ),
    ).toBe(RequestMethod.POST);
    expect(
      Reflect.getMetadata(
        INTERCEPTORS_METADATA,
        WeatherWarningController.prototype.submitRegistration,
      ),
    ).toEqual([expect.any(Function)]);
  });

  it('serves registration options through a real Nest route with no-store headers', async () => {
    const options = createRegistrationOptions();
    registrationService.getOptions.mockResolvedValue(options);
    const app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/weather-warning/registration/options?warningId=warning-1`,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe(NO_CACHE_VALUE);
      expect(response.headers.get('pragma')).toBe('no-cache');
      expect(response.headers.get('expires')).toBe('0');
      await expect(response.json()).resolves.toEqual(options);
      expect(registrationService.getOptions).toHaveBeenCalledTimes(1);
      const [warningId, signal] = registrationService.getOptions.mock
        .calls[0] as [string, AbortSignal];
      expect(warningId).toBe('warning-1');
      expect(signal).toBeInstanceOf(AbortSignal);
    } finally {
      await app.close();
    }
  });

  it('enforces the real Multer registration boundary before calling the service', async () => {
    const payload = createRegistrationPayload();
    const responseBody = createRegistrationResponse();
    registrationService.submit.mockResolvedValue(responseBody);
    const app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    const endpoint = `http://127.0.0.1:${
      (app.getHttpServer().address() as AddressInfo).port
    }/api/weather-warning/registration`;

    try {
      const validForm = new FormData();
      validForm.append('payload', JSON.stringify(payload));
      validForm.append(
        'deviceEvidence',
        new Blob([Buffer.from('controller-does-not-check-magic')], {
          type: 'image/png',
        }),
        'device.png',
      );
      const validResponse = await fetch(endpoint, {
        method: 'POST',
        body: validForm,
      });

      expect(validResponse.status).toBe(201);
      expect(validResponse.headers.get('cache-control')).toBe(NO_CACHE_VALUE);
      await expect(validResponse.json()).resolves.toEqual(responseBody);
      expect(registrationService.submit).toHaveBeenCalledTimes(1);
      const [input, signal] = registrationService.submit.mock.calls[0] as [
        {
          payload: WeatherGuardRegistrationRequest;
          files: {
            deviceEvidence?: WeatherWarningRegistrationUploadFile[];
            disasterEvidence?: WeatherWarningRegistrationUploadFile[];
            environmentEvidence?: WeatherWarningRegistrationUploadFile[];
          };
        },
        AbortSignal,
      ];
      expect(input.payload).toEqual(payload);
      expect(input.files.deviceEvidence).toEqual([
        expect.objectContaining({
          fieldname: 'deviceEvidence',
          originalname: 'device.png',
          mimetype: 'image/png',
        }),
      ]);
      expect(Buffer.isBuffer(input.files.deviceEvidence?.[0]?.buffer)).toBe(
        true,
      );
      expect(Object.keys(input.files)).toEqual([
        'deviceEvidence',
        'disasterEvidence',
        'environmentEvidence',
      ]);
      expect(signal).toBeInstanceOf(AbortSignal);

      registrationService.submit.mockClear();
      const pdfForm = registrationMultipartForm(payload, [
        [
          'deviceEvidence',
          'device-scan.pdf',
          'application/pdf',
          Buffer.from('%PDF-1.7\n', 'ascii'),
        ],
      ]);
      const pdfResponse = await fetch(endpoint, {
        method: 'POST',
        body: pdfForm,
      });
      expect(pdfResponse.status).toBe(201);
      expect(registrationService.submit).toHaveBeenCalledTimes(1);
      expect(
        registrationService.submit.mock.calls[0]?.[0]?.files?.deviceEvidence,
      ).toEqual([
        expect.objectContaining({
          originalname: 'device-scan.pdf',
          mimetype: 'application/pdf',
        }),
      ]);

      registrationService.submit.mockClear();
      const rejectedForms = [
        registrationMultipartForm(payload, [
          ['unknownEvidence', 'unknown.png', 'image/png', Buffer.from('x')],
        ]),
        registrationMultipartForm(payload, [
          ['deviceEvidence', 'device.png', 'image/png', Buffer.from('x')],
          ['deviceEvidence', 'second.png', 'image/png', Buffer.from('x')],
        ]),
        registrationMultipartForm(payload, [
          ['deviceEvidence', 'device.jpg', 'image/png', Buffer.from('x')],
        ]),
        registrationMultipartForm(payload, [
          ['deviceEvidence', 'device.pdf', 'image/png', Buffer.from('x')],
        ]),
        registrationMultipartForm(payload, [], [['open_id', 'ou_x']]),
        registrationMultipartForm(payload, [
          [
            'deviceEvidence',
            'too-large.png',
            'image/png',
            Buffer.alloc(10 * 1024 * 1024 + 1),
          ],
        ]),
      ];

      for (const rejectedForm of rejectedForms) {
        const response = await fetch(endpoint, {
          method: 'POST',
          body: rejectedForm,
        });
        expect([400, 413]).toContain(response.status);
      }
      expect(registrationService.submit).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('allows a guest with matching CSRF tokens to submit multipart registration through the real access guard', async () => {
    const responseBody = createRegistrationResponse();
    registrationService.submit.mockResolvedValue(responseBody);
    const guardedModule = await Test.createTestingModule({
      controllers: [WeatherWarningController],
      providers: [
        { provide: WeatherWarningSnapshotService, useValue: snapshotService },
        {
          provide: WeatherWarningNotificationService,
          useValue: notificationService,
        },
        {
          provide: WeatherWarningRegistrationService,
          useValue: registrationService,
        },
        Reflector,
        {
          provide: UnifiedAccessGuard,
          useFactory: (reflector: Reflector) =>
            new UnifiedAccessGuard(reflector, {
              cookieName: 'vnet_access_session',
              isAccessControlEnabled: () => true,
              renew: () => null,
            } as never),
          inject: [Reflector],
        },
        { provide: APP_GUARD, useExisting: UnifiedAccessGuard },
      ],
    }).compile();
    const app = guardedModule.createNestApplication();
    app.use(testCookieParser);
    app.use('/api', createApiCsrfValidationMiddleware());
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    const endpoint = `http://127.0.0.1:${
      (app.getHttpServer().address() as AddressInfo).port
    }/api/weather-warning/registration`;
    const token = 'a'.repeat(43);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          cookie: `suda-csrf-token=${token}`,
          'x-suda-csrf-token': token,
        },
        body: registrationMultipartForm(createRegistrationPayload(), []),
      });

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual(responseBody);
      expect(registrationService.submit).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      await guardedModule.close();
    }
  });

  it('rejects missing or wrong CSRF and invalid multipart input before calling the registration service', async () => {
    const guardedModule = await Test.createTestingModule({
      controllers: [WeatherWarningController],
      providers: [
        { provide: WeatherWarningSnapshotService, useValue: snapshotService },
        {
          provide: WeatherWarningNotificationService,
          useValue: notificationService,
        },
        {
          provide: WeatherWarningRegistrationService,
          useValue: registrationService,
        },
        Reflector,
        {
          provide: UnifiedAccessGuard,
          useFactory: (reflector: Reflector) =>
            new UnifiedAccessGuard(reflector, {
              cookieName: 'vnet_access_session',
              isAccessControlEnabled: () => true,
              renew: () => null,
            } as never),
          inject: [Reflector],
        },
        { provide: APP_GUARD, useExisting: UnifiedAccessGuard },
      ],
    }).compile();
    const app = guardedModule.createNestApplication();
    app.use(testCookieParser);
    app.use('/api', createApiCsrfValidationMiddleware());
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    const endpoint = `http://127.0.0.1:${
      (app.getHttpServer().address() as AddressInfo).port
    }/api/weather-warning/registration`;
    const token = 'a'.repeat(43);

    try {
      const missingCsrf = await fetch(endpoint, {
        method: 'POST',
        body: registrationMultipartForm(createRegistrationPayload(), []),
      });
      expect(missingCsrf.status).toBe(403);

      const wrongCsrf = await fetch(endpoint, {
        method: 'POST',
        headers: {
          cookie: `suda-csrf-token=${token}`,
          'x-suda-csrf-token': 'b'.repeat(43),
        },
        body: registrationMultipartForm(createRegistrationPayload(), []),
      });
      expect(wrongCsrf.status).toBe(403);

      const invalidInput = new FormData();
      invalidInput.append('payload', '');
      const invalidResponse = await fetch(endpoint, {
        method: 'POST',
        headers: {
          cookie: `suda-csrf-token=${token}`,
          'x-suda-csrf-token': token,
        },
        body: invalidInput,
      });
      expect(invalidResponse.status).toBe(400);
      expect(registrationService.submit).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await guardedModule.close();
    }
  });

  it('exposes the guest snapshot while removing internal abnormal descriptions', async () => {
    const source = createSnapshot({
      checkSummary: {
        ...createSnapshot().checkSummary,
        device: 'abnormal',
        abnormalSummaries: ['设备：UPS 电池温度异常（仅内部可见）'],
      },
    });
    snapshotService.getSnapshot.mockResolvedValue(source);

    const result = await controller.getSnapshot();

    expect(snapshotService.getSnapshot).toHaveBeenCalledWith();
    expect(result).toEqual({
      ...source,
      features: {
        registrationEnabled: true,
        progressNotificationsEnabled: true,
      },
      checkSummary: {
        ...source.checkSummary,
        abnormalSummaries: [],
      },
    });
    expect(result).not.toBe(source);
    expect(result.checkSummary).not.toBe(source.checkSummary);
    expect(result.matchedWarnings[0]?.guardLevel).toBe('三级戒备');
    expect(JSON.stringify(result)).not.toContain('仅内部可见');
    expect(source.checkSummary.abnormalSummaries).toEqual([
      '设备：UPS 电池温度异常（仅内部可见）',
    ]);
  });

  it('exposes fail-closed registration and progress feature flags on the guest snapshot', async () => {
    delete process.env.WEATHER_WARNING_REGISTRATION_ENABLED;
    delete process.env.FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED;
    snapshotService.getSnapshot.mockResolvedValue(createSnapshot());

    const result = await controller.getSnapshot();

    expect(result.features).toEqual({
      registrationEnabled: false,
      progressNotificationsEnabled: false,
    });
  });

  it('publishes only the safe guard completion aggregate', () => {
    const source = createSnapshot({
      guardCompletion: Object.assign(
        {
          state: 'completed' as const,
          completedBuildingCount: 7,
          totalBuildingCount: 7,
        },
        { attachmentToken: 'private-file-token' },
      ),
      buildingProgress: {
        available: true,
        buildings: [],
        missingRegistrationBuildings: [],
        unassignedRecordCount: 0,
        incompleteItems: [],
      },
    });

    const result = toPublicWeatherWarningSnapshot(source);

    expect(result.guardCompletion).toEqual({
      state: 'completed',
      completedBuildingCount: 7,
      totalBuildingCount: 7,
    });
    expect(result).not.toHaveProperty('buildingProgress');
    expect(JSON.stringify(result)).not.toContain('private-file-token');
  });

  it('delegates the administrator preview and removes internal abnormal descriptions again at the transport boundary', async () => {
    const rawSnapshot = createSnapshot({
      checkSummary: {
        ...createSnapshot().checkSummary,
        environment: 'abnormal',
        abnormalSummaries: ['环境：湿度异常（仅内部可见）'],
      },
    });
    notificationService.getTestPreview.mockResolvedValue({
      success: true,
      recipientName: '示例人员020',
      senderName: '系统机器人',
      canSend: true,
      snapshot: rawSnapshot,
      recipientOpenId: 'ou_private_test_recipient',
      tenantAccessToken: 'private-token',
      card: { schema: '2.0', private: true },
    });

    const result = await controller.getTestPreview();

    expect(notificationService.getTestPreview).toHaveBeenCalledWith();
    expect(result).toEqual({
      success: true,
      recipientName: '示例人员020',
      senderName: '系统机器人',
      canSend: true,
      snapshot: {
        ...rawSnapshot,
        checkSummary: {
          ...rawSnapshot.checkSummary,
          abnormalSummaries: [],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('仅内部可见');
    expect(JSON.stringify(result)).not.toContain('ou_private_test_recipient');
    expect(JSON.stringify(result)).not.toContain('private-token');
    expect(JSON.stringify(result)).not.toContain('"schema":"2.0"');
  });

  it('passes the exact test-send request body to the notification service', async () => {
    const body = { clientMutationId: 'weather-card-test-001' };
    const response = {
      success: true,
      sent: true,
      clientMutationId: body.clientMutationId,
      message: '已发送',
    };
    notificationService.sendTest.mockResolvedValue(response);

    await expect(controller.sendTest(body)).resolves.toEqual(response);
    expect(notificationService.sendTest).toHaveBeenCalledTimes(1);
    expect(notificationService.sendTest).toHaveBeenCalledWith(body);
  });

  it('passes the exact full-flow initial request body to the notification service', async () => {
    const body = {
      clientMutationId: 'weather-e2e-1785811200000-a1b2c3d4e5f60708',
    };
    const response = {
      success: true,
      sent: true,
      clientMutationId: body.clientMutationId,
      message: '已发送',
    };
    notificationService.sendFullFlowTest.mockResolvedValue(response);

    await expect(controller.sendFullFlowTest(body)).resolves.toEqual(response);
    expect(notificationService.sendFullFlowTest).toHaveBeenCalledTimes(1);
    expect(notificationService.sendFullFlowTest).toHaveBeenCalledWith(body);
  });

  it('passes the exact full-flow progress request body to the notification service', async () => {
    const body = {
      runClientMutationId: 'weather-e2e-1785811200000-a1b2c3d4e5f60708',
      clientMutationId: 'weather-e2e-progress-20260809-001',
      cardType: 'progress' as const,
    };
    const response = {
      success: true,
      sent: true,
      clientMutationId: body.clientMutationId,
      message: '已发送',
    };
    notificationService.sendFullFlowProgress.mockResolvedValue(response);

    await expect(controller.sendFullFlowProgress(body)).resolves.toEqual(
      response,
    );
    expect(notificationService.sendFullFlowProgress).toHaveBeenCalledTimes(1);
    expect(notificationService.sendFullFlowProgress).toHaveBeenCalledWith(body);
  });

  it('passes the warning id and a request-scoped abort signal to registration options', async () => {
    const options = createRegistrationOptions();
    const request = createAbortableRequest();
    registrationService.getOptions.mockResolvedValue(options);

    await expect(
      registrationController.getRegistrationOptions('warning-1', request),
    ).resolves.toEqual(options);

    expect(registrationService.getOptions).toHaveBeenCalledTimes(1);
    const [warningId, signal] = registrationService.getOptions.mock
      .calls[0] as [string, AbortSignal];
    expect(warningId).toBe('warning-1');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    expect(request.listenerCount('aborted')).toBe(0);
    expect(request.listenerCount('close')).toBe(0);
  });

  it('aborts registration options only for an aborted request and unbinds the listener', async () => {
    const options = createRegistrationOptions();
    const pending = createDeferred<WeatherGuardRegistrationOptions>();
    const request = createAbortableRequest();
    registrationService.getOptions.mockReturnValue(pending.promise);

    const result = registrationController.getRegistrationOptions(
      'warning-1',
      request,
    );
    const signal = registrationService.getOptions.mock.calls[0]?.[1] as
      | AbortSignal
      | undefined;

    expect(signal?.aborted).toBe(false);
    request.emit('close');
    expect(signal?.aborted).toBe(false);
    request.emit('aborted');
    expect(signal?.aborted).toBe(true);

    pending.resolve(options);
    await expect(result).resolves.toEqual(options);
    expect(request.listenerCount('aborted')).toBe(0);
  });

  it('passes an already-aborted signal to registration options without leaking a listener', async () => {
    const request = createAbortableRequest(true);
    registrationService.getOptions.mockResolvedValue(
      createRegistrationOptions(),
    );

    await registrationController.getRegistrationOptions('warning-1', request);

    const signal = registrationService.getOptions.mock.calls[0]?.[1] as
      | AbortSignal
      | undefined;
    expect(signal?.aborted).toBe(true);
    expect(request.listenerCount('aborted')).toBe(0);
  });

  it('parses only the payload field and forwards only the three fixed evidence fields', async () => {
    const payload = createRegistrationPayload();
    const response = createRegistrationResponse();
    const deviceEvidence = createUploadFile('device.png', 'image/png');
    const disasterEvidence = createUploadFile('disaster.jpg', 'image/jpeg');
    const unknownEvidence = createUploadFile('unknown.webp', 'image/webp');
    const request = createAbortableRequest();
    registrationService.submit.mockResolvedValue(response);

    await expect(
      registrationController.submitRegistration(
        { payload: JSON.stringify(payload) },
        {
          deviceEvidence: [deviceEvidence],
          disasterEvidence: [disasterEvidence],
          unknownEvidence: [unknownEvidence],
        },
        request,
      ),
    ).resolves.toEqual(response);

    expect(registrationService.submit).toHaveBeenCalledTimes(1);
    const [input, signal] = registrationService.submit.mock.calls[0] as [
      {
        payload: WeatherGuardRegistrationRequest;
        files: Record<string, unknown>;
      },
      AbortSignal,
    ];
    expect(input).toEqual({
      payload,
      files: {
        deviceEvidence: [deviceEvidence],
        disasterEvidence: [disasterEvidence],
        environmentEvidence: undefined,
      },
    });
    expect(Object.keys(input.files)).toEqual([
      'deviceEvidence',
      'disasterEvidence',
      'environmentEvidence',
    ]);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(request.listenerCount('aborted')).toBe(0);
  });

  it('normalizes a missing uploaded-files value to the fixed evidence shape', async () => {
    const payload = createRegistrationPayload();
    registrationService.submit.mockResolvedValue(createRegistrationResponse());

    await registrationController.submitRegistration(
      { payload: JSON.stringify(payload) },
      undefined,
      createAbortableRequest(),
    );

    expect(registrationService.submit).toHaveBeenCalledWith(
      {
        payload,
        files: {
          deviceEvidence: undefined,
          disasterEvidence: undefined,
          environmentEvidence: undefined,
        },
      },
      expect.any(AbortSignal),
    );
  });

  it.each([
    ['missing body', undefined],
    ['missing payload', {}],
    ['empty payload', { payload: '' }],
    ['whitespace payload', { payload: '   ' }],
    ['non-string payload', { payload: {} }],
    ['invalid JSON', { payload: '{invalid' }],
    ['JSON null', { payload: 'null' }],
    ['JSON array', { payload: '[]' }],
    ['JSON string', { payload: '"value"' }],
    ['JSON number', { payload: '1' }],
    [
      'extra multipart text field',
      { payload: JSON.stringify(createRegistrationPayload()), open_id: 'ou_x' },
    ],
    [
      'naked registration fields',
      { warningId: 'warning-1', guardLevel: '二级戒备', date: '2026-08-08' },
    ],
    [
      'oversized payload',
      {
        payload: JSON.stringify({
          value: 'x'.repeat(REGISTRATION_PAYLOAD_MAX_BYTES),
        }),
      },
    ],
  ])(
    'rejects %s with 400 before registration service work',
    async (_label, body) => {
      await expect(
        registrationController.submitRegistration(
          body,
          {},
          createAbortableRequest(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(registrationService.submit).not.toHaveBeenCalled();
    },
  );

  it('uses distinct abort signals so one cancelled submit caller cannot cancel another', async () => {
    const firstPending = createDeferred<WeatherGuardRegistrationResponse>();
    const secondPending = createDeferred<WeatherGuardRegistrationResponse>();
    registrationService.submit
      .mockReturnValueOnce(firstPending.promise)
      .mockReturnValueOnce(secondPending.promise);
    const firstRequest = createAbortableRequest();
    const secondRequest = createAbortableRequest();
    const body = { payload: JSON.stringify(createRegistrationPayload()) };

    const firstResult = registrationController.submitRegistration(
      body,
      {},
      firstRequest,
    );
    const secondResult = registrationController.submitRegistration(
      body,
      {},
      secondRequest,
    );
    const firstSignal = registrationService.submit.mock.calls[0]?.[1] as
      | AbortSignal
      | undefined;
    const secondSignal = registrationService.submit.mock.calls[1]?.[1] as
      | AbortSignal
      | undefined;

    expect(firstSignal).toBeInstanceOf(AbortSignal);
    expect(secondSignal).toBeInstanceOf(AbortSignal);
    expect(firstSignal).not.toBe(secondSignal);
    firstRequest.emit('close');
    expect(firstSignal?.aborted).toBe(false);
    expect(secondSignal?.aborted).toBe(false);
    firstRequest.emit('aborted');
    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal?.aborted).toBe(false);

    firstPending.resolve(createRegistrationResponse({ recordId: 'rec-first' }));
    secondPending.resolve(
      createRegistrationResponse({ recordId: 'rec-second' }),
    );
    await Promise.all([firstResult, secondResult]);
    expect(firstRequest.listenerCount('aborted')).toBe(0);
    expect(secondRequest.listenerCount('aborted')).toBe(0);
  });

  it('marks snapshot/options guest-readable, registration guest-submittable, and keeps preview/send admin-only', () => {
    expect(
      Reflect.getMetadata(
        GuestReadableMetadataKey,
        WeatherWarningController.prototype.getSnapshot,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        AdminOnlyMetadataKey,
        WeatherWarningController.prototype.getSnapshot,
      ),
    ).toBeUndefined();

    expect(
      Reflect.getMetadata(
        GuestReadableMetadataKey,
        WeatherWarningController.prototype.getRegistrationOptions,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        GuestSubmittableMetadataKey,
        WeatherWarningController.prototype.submitRegistration,
      ),
    ).toBe(true);
    for (const method of [
      'getRegistrationOptions',
      'submitRegistration',
    ] as const) {
      expect(
        Reflect.getMetadata(
          AdminOnlyMetadataKey,
          WeatherWarningController.prototype[method],
        ),
      ).toBeUndefined();
    }
    expect(
      Reflect.getMetadata(
        GuestSubmittableMetadataKey,
        WeatherWarningController.prototype.getRegistrationOptions,
      ),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(
        GuestReadableMetadataKey,
        WeatherWarningController.prototype.submitRegistration,
      ),
    ).toBeUndefined();

    for (const method of [
      'getTestPreview',
      'sendTest',
      'sendFullFlowTest',
      'sendFullFlowProgress',
    ] as const) {
      expect(
        Reflect.getMetadata(
          AdminOnlyMetadataKey,
          WeatherWarningController.prototype[method],
        ),
      ).toBe(true);
      expect(
        Reflect.getMetadata(
          GuestReadableMetadataKey,
          WeatherWarningController.prototype[method],
        ),
      ).toBeUndefined();
    }
  });

  it('uses the fixed API routes and no-cache response headers', () => {
    const source = readControllerSource();

    expect(source).toContain("@Controller('api/weather-warning')");
    expect(source).toMatch(
      /@GuestReadable\(\)\s+@Get\('snapshot'\)[\s\S]{0,420}getSnapshot\(/,
    );
    expect(source).toMatch(
      /@AdminOnly\(\)\s+@Get\('test-preview'\)[\s\S]{0,420}getTestPreview\(/,
    );
    expect(source).toMatch(
      /@AdminOnly\(\)\s+@Post\('test-send'\)[\s\S]{0,420}sendTest\(/,
    );
    expect(source).toMatch(
      /@AdminOnly\(\)\s+@Post\('test-full-flow-send'\)[\s\S]{0,420}sendFullFlowTest\(/,
    );
    expect(source).toMatch(
      /@AdminOnly\(\)\s+@Post\('test-full-flow-progress-send'\)[\s\S]{0,500}sendFullFlowProgress\(/,
    );
    expect(source).toMatch(
      /@GuestReadable\(\)\s+@Get\('registration\/options'\)[\s\S]{0,500}getRegistrationOptions\(/,
    );
    expect(source).toMatch(/@GuestSubmittable\(\)\s+@Post\('registration'\)/);
    expect(source.split(NO_CACHE_VALUE)).toHaveLength(8);
    expect(source).toContain("@Header('Pragma', 'no-cache')");
    expect(source).toContain("@Header('Expires', '0')");
  });

  it('configures the registration multipart boundary with exact fields, limits, and an early image filter', () => {
    const source = readControllerSource();
    const registrationStart = source.indexOf("@Post('registration')");
    const registrationMethod = source.indexOf(
      'async submitRegistration(',
      registrationStart,
    );
    const decoratorBlock = source.slice(registrationStart, registrationMethod);

    expect(registrationStart).toBeGreaterThan(-1);
    expect(registrationMethod).toBeGreaterThan(registrationStart);
    expect(decoratorBlock).toContain('FileFieldsInterceptor(');
    expect(decoratorBlock).toContain("{ name: 'deviceEvidence', maxCount: 1 }");
    expect(decoratorBlock).toContain(
      "{ name: 'disasterEvidence', maxCount: 1 }",
    );
    expect(decoratorBlock).toContain(
      "{ name: 'environmentEvidence', maxCount: 1 }",
    );
    expect(decoratorBlock).toMatch(/files:\s*3/);
    expect(decoratorBlock).toMatch(/fileSize:\s*10 \* 1024 \* 1024/);
    expect(decoratorBlock).toMatch(/fields:\s*1/);
    expect(decoratorBlock).toMatch(/parts:\s*5/);
    expect(decoratorBlock).toMatch(/fieldSize:\s*128 \* 1024/);
    expect(decoratorBlock).toMatch(/fieldNameSize:\s*64/);
    expect(decoratorBlock).toMatch(/fileFilter:\s*\w+/);
    expect(source).toContain("'.png': 'image/png'");
    expect(source).toContain("'.jpg': 'image/jpeg'");
    expect(source).toContain("'.jpeg': 'image/jpeg'");
    expect(source).toContain("'.webp': 'image/webp'");
    expect(source).toContain("'.pdf': 'application/pdf'");
  });

  it('registers the weather warning module before the view fallback with only its required imports', () => {
    const moduleSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/weather-warning/weather-warning.module.ts',
      ),
      'utf8',
    );
    const appSource = readFileSync(
      join(process.cwd(), 'server/app.module.ts'),
      'utf8',
    );

    expect(moduleSource).toContain('WeatherWarningController');
    expect(moduleSource).toContain('WeatherWarningSnapshotService');
    expect(moduleSource).toContain('WeatherWarningNotificationService');
    expect(moduleSource).toContain('WeatherWarningBitableService');
    expect(moduleSource).toContain('BitableSyncModule');
    expect(moduleSource).toMatch(
      /HttpModule\.register\(\{\s*timeout:\s*30_?000,\s*maxRedirects:\s*5,?\s*\}\)/s,
    );
    expect(appSource).toContain('WeatherWarningModule');
    expect(appSource.indexOf('WeatherWarningModule')).toBeLessThan(
      appSource.indexOf('ViewModule'),
    );
  });
});

describe('WeatherWarningNotificationService preview and test request gateway', () => {
  it('force-refreshes the preview without exposing open IDs, card payloads, or abnormal descriptions', async () => {
    const snapshot = createSnapshot({
      checkSummary: {
        ...createSnapshot().checkSummary,
        materials: 'abnormal',
        abnormalSummaries: ['物资：备用电池不足（仅内部可见）'],
      },
    });
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(snapshot),
    };
    const bitableService = {
      getRuntimeConfig: jest.fn(() => ({
        testRecipient: {
          openId: 'ou_private_test_recipient',
          displayName: '示例人员020',
        },
      })),
    };
    const httpService = { axiosRef: { post: jest.fn() } };
    const service = new WeatherWarningNotificationService(
      httpService as never,
      snapshotService as never,
      bitableService as never,
    );

    const result = await service.getTestPreview();

    expect(snapshotService.getSnapshot).toHaveBeenCalledWith({
      forceRefresh: true,
    });
    expect(result).toEqual({
      success: true,
      recipientName: '示例人员020',
      senderName: '系统机器人',
      canSend: true,
      snapshot: {
        ...snapshot,
        checkSummary: {
          ...snapshot.checkSummary,
          abnormalSummaries: [],
        },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('仅内部可见');
    expect(serialized).not.toContain('ou_private_test_recipient');
    expect(serialized).not.toContain('card');
    expect(httpService.axiosRef.post).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    {},
    { clientMutationId: '' },
    { clientMutationId: 'short' },
    { clientMutationId: 'weather-card-test-001 ' },
    { clientMutationId: ' weather-card-test-001' },
    { clientMutationId: 'weather-card-test-001', recipientOpenId: 'ou_x' },
    { clientMutationId: 'weather-card-test-001', senderName: '冒充发送人' },
  ])(
    'rejects the strict test-send body %p before any external work',
    async (body) => {
      const snapshotService = { getSnapshot: jest.fn() };
      const httpService = { axiosRef: { post: jest.fn() } };
      const service = new WeatherWarningNotificationService(
        httpService as never,
        snapshotService as never,
        { getRuntimeConfig: jest.fn() } as never,
      );

      await expect(service.sendTest(body as never)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
      expect(httpService.axiosRef.post).not.toHaveBeenCalled();
    },
  );
});

function loadLegacyWeatherWarningController(): WeatherWarningControllerConstructor {
  const controllerPath = join(
    process.cwd(),
    'server/modules/weather-warning/weather-warning.controller.ts',
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
      `legacy controller transpilation failed: ${errors
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        )
        .join('; ')}`,
    );
  }

  const dependencies = new Map<string, unknown>([
    ['@nestjs/common', jest.requireActual('@nestjs/common')],
    [
      '@nestjs/platform-express',
      jest.requireActual('@nestjs/platform-express'),
    ],
    [
      '@server/common/access/unified-access.decorators',
      jest.requireActual(
        '../../server/common/access/unified-access.decorators',
      ),
    ],
    [
      './weather-warning-notification.service',
      {
        WeatherWarningNotificationService,
        toPublicWeatherWarningSnapshot,
      },
    ],
    [
      './weather-warning-registration.service',
      { WeatherWarningRegistrationService },
    ],
    [
      './weather-warning-registration-enabled.guard',
      { WeatherWarningRegistrationEnabledGuard },
    ],
    ['./weather-warning-feature.config', { loadWeatherWarningFeatureConfig }],
    ['./weather-warning-snapshot.service', { WeatherWarningSnapshotService }],
  ]);
  const localRequire = (specifier: string): unknown => {
    if (!dependencies.has(specifier)) {
      throw new Error(`unexpected controller dependency: ${specifier}`);
    }
    return dependencies.get(specifier);
  };
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
    localRequire,
    moduleRecord,
    moduleRecord.exports,
    controllerPath,
    dirname(controllerPath),
  );
  if (typeof moduleRecord.exports.WeatherWarningController !== 'function') {
    throw new Error(
      'legacy controller transpilation did not export controller',
    );
  }
  return moduleRecord.exports
    .WeatherWarningController as WeatherWarningControllerConstructor;
}

function readControllerSource(): string {
  return readFileSync(
    join(
      process.cwd(),
      'server/modules/weather-warning/weather-warning.controller.ts',
    ),
    'utf8',
  );
}

function createSnapshot(
  overrides: Partial<WeatherWarningSnapshot> = {},
): WeatherWarningSnapshot {
  return {
    status: 'active',
    sourceState: 'fresh',
    guardDecisionState: 'fresh',
    checkSyncState: 'fresh',
    snapshotAt: '2026-08-05T10:00:00+08:00',
    guardLevel: '三级戒备',
    matchedWarnings: [
      {
        id: 'warning-1',
        title: '高温橙色预警',
        type: '高温',
        color: 'orange',
        guardLevel: '三级戒备',
      },
    ],
    unmatchedWarnings: [],
    actions: ['相关人员 7*24 On call'],
    weather: { temperature: '34', humidity: '75' },
    checkSummary: {
      device: 'completed',
      environment: 'pending',
      disaster: 'not_started',
      materials: 'completed',
      contacts: 'completed',
      managerConfirmation: 'pending',
      abnormalSummaries: [],
    },
    canSendTest: true,
    ...overrides,
  };
}

function createAbortableRequest(aborted = false): Request & EventEmitter {
  return Object.assign(new EventEmitter(), { aborted }) as unknown as Request &
    EventEmitter;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createRegistrationOptions(): WeatherGuardRegistrationOptions {
  return {
    warning: {
      id: 'warning-1',
      title: '台风红色预警',
      type: '台风',
      color: 'red',
      guardLevel: '一级戒备',
    },
    guardLevel: '一级戒备',
    environmentRequired: true,
    buildings: ['A楼'],
    checkers: [
      {
        key: 'checker-key',
        name: '检查人',
        position: '设施运维工程师',
        buildings: ['A楼'],
      },
    ],
    personnelSyncedAt: '2026-08-08T09:55:00.000Z',
    personnelStale: false,
    acceptedImageTypes: [
      'image/png',
      'image/jpeg',
      'image/webp',
      'application/pdf',
    ],
    maxImageBytes: 10 * 1024 * 1024,
  };
}

function createRegistrationPayload(
  overrides: Partial<WeatherGuardRegistrationRequest> = {},
): WeatherGuardRegistrationRequest {
  return {
    clientMutationId: 'weather-registration-001',
    warningId: 'warning-1',
    building: 'A楼',
    checkerKeys: ['checker-key'],
    deviceStatus: '正常',
    disasterStatus: '正常',
    environmentStatus: '正常',
    materialsStatus: '正常',
    contactsStatus: '正常',
    ...overrides,
  };
}

function createRegistrationResponse(
  overrides: Partial<WeatherGuardRegistrationResponse> = {},
): WeatherGuardRegistrationResponse {
  return {
    success: true,
    recordId: 'rec-registration-1',
    createdAt: '2026-08-08T10:00:00+08:00',
    building: 'A楼',
    guardLevel: '一级戒备',
    ...overrides,
  };
}

function registrationMultipartForm(
  payload: WeatherGuardRegistrationRequest,
  files: ReadonlyArray<
    readonly [
      fieldName: string,
      fileName: string,
      mimeType: string,
      content: Buffer,
    ]
  >,
  textFields: ReadonlyArray<readonly [fieldName: string, value: string]> = [],
): FormData {
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  for (const [fieldName, value] of textFields) {
    form.append(fieldName, value);
  }
  for (const [fieldName, fileName, mimeType, content] of files) {
    form.append(fieldName, new Blob([content], { type: mimeType }), fileName);
  }
  return form;
}

function testCookieParser(
  request: Request & { cookies?: Record<string, string> },
  _response: unknown,
  next: () => void,
): void {
  const cookies: Record<string, string> = {};
  for (const part of String(request.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    cookies[part.slice(0, separator).trim()] = decodeURIComponent(
      part.slice(separator + 1).trim(),
    );
  }
  request.cookies = cookies;
  next();
}

function createUploadFile(
  originalname: string,
  mimetype: string,
): WeatherWarningRegistrationUploadFile {
  const buffer = Buffer.from('test-image');
  return {
    buffer,
    originalname,
    mimetype,
    size: buffer.length,
  };
}
