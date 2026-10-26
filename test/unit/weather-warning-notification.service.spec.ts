import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  WeatherWarningSnapshot,
  WeatherWarningTestSendResponse,
} from '../../shared/api.interface';
import * as weatherWarningDeliveryStateStore from '../../server/modules/weather-warning/weather-warning-delivery-state-store';
import {
  acquireWeatherWarningDeliveryLease,
  writeWeatherWarningDeliveryStateFile,
} from '../../server/modules/weather-warning/weather-warning-delivery-state-store';
import { WeatherWarningNotificationService } from '../../server/modules/weather-warning/weather-warning-notification.service';
import { createWeatherWarningTestSimulationContext } from '../../server/modules/weather-warning/weather-warning-test-simulation';

const AUTH_ENDPOINT =
  'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const MESSAGE_ENDPOINT =
  'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id';
const CHAT_MESSAGE_ENDPOINT =
  'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id';
const VALID_MUTATION_ID = 'weather-test-20260804-001';
const FULL_FLOW_STARTED_AT = Date.parse('2026-08-04T08:00:00.000Z');
const FULL_FLOW_RUN_MUTATION_ID = `weather-e2e-${FULL_FLOW_STARTED_AT}-a1b2c3d4e5f60708`;
const SECOND_FULL_FLOW_RUN_MUTATION_ID = `weather-e2e-${FULL_FLOW_STARTED_AT}-b2c3d4e5f6070819`;
const FULL_FLOW_PROGRESS_MUTATION_ID = 'weather-e2e-progress-20260804-001';
const CONFIGURED_OPEN_ID = 'ou_weather_test_recipient';
const PUBLIC_BASE_URL = 'https://app.sjhl.online/platform/';
const CLIENT_BASE_PATH = '/nantong/';
const TEST_REGISTRATION_URL =
  'https://app.sjhl.online/platform/nantong/monthly-schedule?weatherGuardRegistration=1&warningId=high-temperature-orange&source=test-card';
const LEGACY_APPROVAL_URL =
  'https://example.feishu.cn/share/PUBLIC_EXAMPLE_SOURCE';

const ACTIVE_SNAPSHOT: WeatherWarningSnapshot = {
  status: 'active',
  sourceState: 'fresh',
  guardDecisionState: 'fresh',
  checkSyncState: 'fresh',
  snapshotAt: '2026-08-04T08:00:00.000Z',
  lastSuccessAt: '2026-08-04T08:00:00.000Z',
  guardLevel: '三级戒备',
  matchedWarnings: [
    {
      id: 'high-temperature-orange',
      title: '南通市气象台发布高温橙色预警',
      type: '高温',
      color: 'orange',
      guardLevel: '三级戒备',
    },
  ],
  unmatchedWarnings: [],
  actions: ['相关人员 7*24 On call'],
  weather: {
    temperature: '31℃',
    feelsLike: '34℃',
    humidity: '75%',
    windDirection: '东风',
    windScale: '3级',
  },
  checkSummary: {
    device: 'completed',
    environment: 'pending',
    disaster: 'completed',
    materials: 'completed',
    contacts: 'completed',
    managerConfirmation: 'pending',
    abnormalSummaries: [],
  },
  canSendTest: true,
};

const FULL_FLOW_PROGRESS = {
  summary: {
    device: 'completed' as const,
    environment: 'pending' as const,
    disaster: 'completed' as const,
    materials: 'completed' as const,
    contacts: 'completed' as const,
    managerConfirmation: 'pending' as const,
    abnormalSummaries: [],
  },
  buildingProgress: {
    available: true,
    buildings: [
      {
        building: 'A楼' as const,
        recordAt: '2026-08-04T08:10:00.000Z',
        checks: {
          device: 'completed' as const,
          environment: 'pending' as const,
          disaster: 'completed' as const,
          materials: 'completed' as const,
          contacts: 'completed' as const,
          managerConfirmation: 'pending' as const,
        },
        abnormalSummaries: [],
      },
    ],
    missingRegistrationBuildings: [
      'B楼' as const,
      'C楼' as const,
      'D楼' as const,
      'E楼' as const,
      'H楼' as const,
      '110站' as const,
    ],
    unassignedRecordCount: 0,
    incompleteItems: [
      {
        building: 'A楼' as const,
        key: 'environment' as const,
        label: '环境安全',
        state: 'pending' as const,
      },
      {
        building: 'A楼' as const,
        key: 'managerConfirmation' as const,
        label: '机房经理确认',
        state: 'pending' as const,
      },
      {
        building: 'B楼' as const,
        key: 'registration' as const,
        label: '未提交戒备登记',
        state: 'missing_registration' as const,
      },
    ],
  },
};

type MessageResponse = {
  code: number;
  data?: { message_id?: unknown };
  msg?: string;
};

function createService(
  options: {
    snapshot?: WeatherWarningSnapshot;
    recipient?: { openId: string; displayName: string } | null;
    messageResponse?: MessageResponse;
    messageError?: Error;
    checkProgress?: typeof FULL_FLOW_PROGRESS;
    checkProgressError?: Error;
  } = {},
) {
  const snapshotService = {
    getSnapshot: jest
      .fn()
      .mockResolvedValue(options.snapshot ?? ACTIVE_SNAPSHOT),
  };
  const bitableService = {
    getCheckProgress: options.checkProgressError
      ? jest.fn().mockRejectedValue(options.checkProgressError)
      : jest
          .fn()
          .mockResolvedValue(options.checkProgress ?? FULL_FLOW_PROGRESS),
    getRuntimeConfig: jest.fn().mockReturnValue({
      testRecipient:
        options.recipient === undefined
          ? { openId: CONFIGURED_OPEN_ID, displayName: '示例人员020' }
          : options.recipient,
    }),
  };
  const post = jest.fn(async (url: string) => {
    if (url === AUTH_ENDPOINT) {
      return {
        data: {
          code: 0,
          tenant_access_token: 'tenant-token-for-test',
          expire: 7200,
        },
      };
    }
    if (url === MESSAGE_ENDPOINT || url === CHAT_MESSAGE_ENDPOINT) {
      if (options.messageError) throw options.messageError;
      return {
        data: options.messageResponse ?? {
          code: 0,
          data: { message_id: 'om_weather_warning_test' },
        },
      };
    }
    throw new Error(`Unexpected endpoint: ${url}`);
  });

  return {
    service: new WeatherWarningNotificationService(
      { axiosRef: { post } } as never,
      snapshotService as never,
      bitableService as never,
    ),
    snapshotService,
    bitableService,
    post,
  };
}

describe('WeatherWarningNotificationService', () => {
  const originalEnvironment = {
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
    statePath: process.env.FEISHU_WEATHER_WARNING_DELIVERY_STATE_PATH,
    stateDirectory: process.env.FEISHU_WEATHER_WARNING_DELIVERY_STATE_DIR,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    clientBasePath: process.env.CLIENT_BASE_PATH,
    simulationSecret: process.env.WEATHER_WARNING_TEST_SIMULATION_SECRET,
    registrationEnabled: process.env.WEATHER_WARNING_REGISTRATION_ENABLED,
    progressNotificationsEnabled:
      process.env.FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED,
  };
  let temporaryDirectory = '';
  let statePath = '';

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'weather-warning-notification-'),
    );
    statePath = join(temporaryDirectory, 'weather-warning-delivery-state.json');
    process.env.FEISHU_APP_ID = 'cli_weather_warning_test';
    process.env.FEISHU_APP_SECRET = 'test-secret-not-a-real-credential';
    process.env.FEISHU_WEATHER_WARNING_DELIVERY_STATE_PATH = statePath;
    delete process.env.FEISHU_WEATHER_WARNING_DELIVERY_STATE_DIR;
    process.env.PUBLIC_BASE_URL = PUBLIC_BASE_URL;
    process.env.CLIENT_BASE_PATH = CLIENT_BASE_PATH;
    process.env.WEATHER_WARNING_TEST_SIMULATION_SECRET =
      'weather-warning-notification-full-flow-secret-32-bytes';
    process.env.WEATHER_WARNING_REGISTRATION_ENABLED = 'true';
    process.env.FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED = 'true';
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-04T08:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (temporaryDirectory && existsSync(temporaryDirectory)) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    restoreEnvironment('FEISHU_APP_ID', originalEnvironment.appId);
    restoreEnvironment('FEISHU_APP_SECRET', originalEnvironment.appSecret);
    restoreEnvironment(
      'FEISHU_WEATHER_WARNING_DELIVERY_STATE_PATH',
      originalEnvironment.statePath,
    );
    restoreEnvironment(
      'FEISHU_WEATHER_WARNING_DELIVERY_STATE_DIR',
      originalEnvironment.stateDirectory,
    );
    restoreEnvironment('PUBLIC_BASE_URL', originalEnvironment.publicBaseUrl);
    restoreEnvironment('CLIENT_BASE_PATH', originalEnvironment.clientBasePath);
    restoreEnvironment(
      'WEATHER_WARNING_TEST_SIMULATION_SECRET',
      originalEnvironment.simulationSecret,
    );
    restoreEnvironment(
      'WEATHER_WARNING_REGISTRATION_ENABLED',
      originalEnvironment.registrationEnabled,
    );
    restoreEnvironment(
      'FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED',
      originalEnvironment.progressNotificationsEnabled,
    );
  });

  it.each([
    undefined,
    {},
    { clientMutationId: 'short' },
    { clientMutationId: 'weather test 20260804' },
    { clientMutationId: VALID_MUTATION_ID, openId: CONFIGURED_OPEN_ID },
  ])('rejects an invalid or expanded test-send request', async (request) => {
    const { service, post, snapshotService } = createService();

    await expect(service.sendTest(request as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    '__proto__',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
    'constructor',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    'toString',
    'valueOf',
    'prototype',
  ] as const)(
    'rejects a reserved prototype mutation key %s before any notification side effect',
    async (clientMutationId) => {
      const { service, bitableService, post, snapshotService } =
        createService();

      await expect(
        service.sendTest({ clientMutationId }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
      expect(bitableService.getRuntimeConfig).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(existsSync(statePath)).toBe(false);
    },
  );

  it('accepts a normal non-reserved client mutation id', async () => {
    const clientMutationId = 'weather.normal:20260805';
    const { service, post } = createService();

    await expect(service.sendTest({ clientMutationId })).resolves.toMatchObject(
      {
        success: true,
        clientMutationId,
      },
    );

    expect(
      post.mock.calls.filter(([url]) => url === MESSAGE_ENDPOINT),
    ).toHaveLength(1);
  });

  it('sends an isolated full-flow simulation card only to the configured person', async () => {
    const context = createWeatherWarningTestSimulationContext(
      FULL_FLOW_RUN_MUTATION_ID,
      FULL_FLOW_STARTED_AT,
    );
    const { service, post, snapshotService, bitableService } = createService();

    await expect(
      service.sendFullFlowTest({
        clientMutationId: FULL_FLOW_RUN_MUTATION_ID,
      }),
    ).resolves.toMatchObject({
      success: true,
      sent: true,
      clientMutationId: FULL_FLOW_RUN_MUTATION_ID,
    });

    expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
    expect(bitableService.getCheckProgress).not.toHaveBeenCalled();
    expect(
      post.mock.calls.filter(([url]) => url === CHAT_MESSAGE_ENDPOINT),
    ).toHaveLength(0);
    const messageCalls = post.mock.calls.filter(
      ([url]) => url === MESSAGE_ENDPOINT,
    );
    expect(messageCalls).toHaveLength(1);
    expect(messageCalls[0]?.[1]).toEqual(
      expect.objectContaining({
        receive_id: CONFIGURED_OPEN_ID,
        msg_type: 'interactive',
      }),
    );
    const deliveredCard = JSON.parse(String(messageCalls[0]?.[1]?.content));
    const serializedCard = JSON.stringify(deliveredCard);
    expect(deliveredCard).toMatchObject({ schema: '2.0' });
    expect(serializedCard).toContain(encodeURIComponent(context.warningId));
    expect(serializedCard).toContain('全流程测试');
    expect(serializedCard).toContain('A楼');
    expect(serializedCard).toContain('110站');
    expect(serializedCard).toContain('提交戒备登记');
    expect(serializedCard).toContain('下载重保检查单');
  });

  it('保留首次戒备提醒但在跟踪功能默认关闭时不读取进度也不展示登记和进度', async () => {
    delete process.env.WEATHER_WARNING_REGISTRATION_ENABLED;
    delete process.env.FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED;
    const { service, post, snapshotService, bitableService } = createService();

    await expect(
      service.sendFullFlowTest({
        clientMutationId: FULL_FLOW_RUN_MUTATION_ID,
      }),
    ).resolves.toMatchObject({
      success: true,
      sent: true,
      clientMutationId: FULL_FLOW_RUN_MUTATION_ID,
    });

    expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
    expect(bitableService.getCheckProgress).not.toHaveBeenCalled();
    const messageCalls = post.mock.calls.filter(
      ([url]) => url === MESSAGE_ENDPOINT,
    );
    expect(messageCalls).toHaveLength(1);
    const serializedCard = String(messageCalls[0]?.[1]?.content);
    expect(serializedCard).toContain('下载重保检查单');
    expect(serializedCard).not.toContain('提交戒备登记');
    expect(serializedCard).not.toContain('weatherGuardRegistration');
    expect(serializedCard).not.toContain('执行进度');
  });

  it.each([
    ['progress' as const, 'weather-e2e-progress-paused-001'],
    ['reminder' as const, 'weather-e2e-reminder-paused-001'],
  ])(
    '跟踪功能默认关闭时明确拒绝 %s 测试且不读取进度不发送消息',
    async (cardType, clientMutationId) => {
      delete process.env.WEATHER_WARNING_REGISTRATION_ENABLED;
      delete process.env.FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED;
      const { service, post, snapshotService, bitableService } =
        createService();

      await expect(
        service.sendFullFlowProgress({
          runClientMutationId: FULL_FLOW_RUN_MUTATION_ID,
          clientMutationId,
          cardType,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
      expect(bitableService.getCheckProgress).not.toHaveBeenCalled();
      expect(bitableService.getRuntimeConfig).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    {},
    { clientMutationId: VALID_MUTATION_ID },
    {
      clientMutationId: FULL_FLOW_RUN_MUTATION_ID,
      recipientOpenId: CONFIGURED_OPEN_ID,
    },
  ])(
    'rejects an invalid or expanded full-flow initial request before external work',
    async (request) => {
      const { service, post, snapshotService, bitableService } =
        createService();

      await expect(
        service.sendFullFlowTest(request as never),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
      expect(bitableService.getCheckProgress).not.toHaveBeenCalled();
      expect(bitableService.getRuntimeConfig).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    },
  );

  it('force-reads Base building progress and sends one idempotent progress card only to the person', async () => {
    const context = createWeatherWarningTestSimulationContext(
      FULL_FLOW_RUN_MUTATION_ID,
      FULL_FLOW_STARTED_AT,
    );
    const request = {
      runClientMutationId: FULL_FLOW_RUN_MUTATION_ID,
      clientMutationId: FULL_FLOW_PROGRESS_MUTATION_ID,
      cardType: 'progress' as const,
    };
    const { service, post, snapshotService, bitableService } = createService();

    const first = await service.sendFullFlowProgress(request);
    const replay = await service.sendFullFlowProgress(request);

    expect(replay).toEqual(first);
    expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
    expect(bitableService.getCheckProgress).toHaveBeenCalledTimes(1);
    expect(bitableService.getCheckProgress).toHaveBeenCalledWith(
      '三级戒备',
      context.tag,
      context.openedAt,
      context.snapshot.requiredCheckKeys,
      true,
    );
    expect(
      post.mock.calls.filter(([url]) => url === CHAT_MESSAGE_ENDPOINT),
    ).toHaveLength(0);
    const messageCalls = post.mock.calls.filter(
      ([url]) => url === MESSAGE_ENDPOINT,
    );
    expect(messageCalls).toHaveLength(1);
    const serializedCard = String(messageCalls[0]?.[1]?.content);
    expect(serializedCard).toContain('A楼');
    expect(serializedCard).toContain('B楼');
    expect(serializedCard).toContain('4/5');
    expect(serializedCard).toContain('未登记');
  });

  it('isolates progress delivery idempotency by full-flow run when the request mutation id is reused', async () => {
    const { service, post, bitableService } = createService();

    await service.sendFullFlowProgress({
      runClientMutationId: FULL_FLOW_RUN_MUTATION_ID,
      clientMutationId: FULL_FLOW_PROGRESS_MUTATION_ID,
      cardType: 'progress',
    });
    await service.sendFullFlowProgress({
      runClientMutationId: SECOND_FULL_FLOW_RUN_MUTATION_ID,
      clientMutationId: FULL_FLOW_PROGRESS_MUTATION_ID,
      cardType: 'progress',
    });

    expect(bitableService.getCheckProgress).toHaveBeenCalledTimes(2);
    expect(
      post.mock.calls.filter(([url]) => url === MESSAGE_ENDPOINT),
    ).toHaveLength(2);
  });

  it('sends a full-flow reminder with the concrete building and unfinished item', async () => {
    const { service, post } = createService();

    await service.sendFullFlowProgress({
      runClientMutationId: FULL_FLOW_RUN_MUTATION_ID,
      clientMutationId: 'weather-e2e-reminder-20260804-001',
      cardType: 'reminder',
    });

    const messageCalls = post.mock.calls.filter(
      ([url]) => url === MESSAGE_ENDPOINT,
    );
    expect(messageCalls).toHaveLength(1);
    const serializedCard = String(messageCalls[0]?.[1]?.content);
    expect(serializedCard).toContain('A楼');
    expect(serializedCard).toContain('环境安全');
    expect(serializedCard).toContain('B楼');
    expect(serializedCard).toContain('未提交戒备登记');
    expect(
      post.mock.calls.filter(([url]) => url === CHAT_MESSAGE_ENDPOINT),
    ).toHaveLength(0);
  });

  it('sends an explicit unavailable progress state instead of inventing zero progress when Base fails', async () => {
    const { service, post } = createService({
      checkProgressError: new Error('private Base failure'),
    });

    await expect(
      service.sendFullFlowProgress({
        runClientMutationId: FULL_FLOW_RUN_MUTATION_ID,
        clientMutationId: 'weather-e2e-progress-unavailable-001',
        cardType: 'progress',
      }),
    ).resolves.toMatchObject({ success: true, sent: true });

    const messageCall = post.mock.calls.find(
      ([url]) => url === MESSAGE_ENDPOINT,
    );
    const serializedCard = String(messageCall?.[1]?.content);
    expect(serializedCard).toContain('楼栋进度暂不可用');
    expect(serializedCard).not.toContain('完成 0/42');
    expect(serializedCard).not.toContain('private Base failure');
    expect(
      post.mock.calls.filter(([url]) => url === CHAT_MESSAGE_ENDPOINT),
    ).toHaveLength(0);
  });

  it.each([
    undefined,
    {},
    {
      runClientMutationId: FULL_FLOW_RUN_MUTATION_ID,
      clientMutationId: FULL_FLOW_PROGRESS_MUTATION_ID,
      cardType: 'progress',
      chatId: 'oc_must_never_be_accepted',
    },
    {
      runClientMutationId: VALID_MUTATION_ID,
      clientMutationId: FULL_FLOW_PROGRESS_MUTATION_ID,
      cardType: 'progress',
    },
    {
      runClientMutationId: FULL_FLOW_RUN_MUTATION_ID,
      clientMutationId: FULL_FLOW_PROGRESS_MUTATION_ID,
      cardType: 'unknown',
    },
  ])(
    'rejects an invalid full-flow progress request before external work',
    async (request) => {
      const { service, post, snapshotService, bitableService } =
        createService();

      await expect(
        service.sendFullFlowProgress(request as never),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
      expect(bitableService.getCheckProgress).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    },
  );

  it.each([` ${VALID_MUTATION_ID}`, `${VALID_MUTATION_ID} `, 202608040001])(
    'rejects a non-exact client mutation id before any notification side effect',
    async (clientMutationId) => {
      const { service, bitableService, post, snapshotService } =
        createService();

      await expect(
        service.sendTest({ clientMutationId } as never),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
      expect(bitableService.getRuntimeConfig).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(existsSync(statePath)).toBe(false);
    },
  );

  it('blocks a non-sendable fresh snapshot before reading the recipient or calling Feishu', async () => {
    const { service, bitableService, post } = createService({
      snapshot: { ...ACTIVE_SNAPSHOT, canSendTest: false },
    });

    await expect(
      service.sendTest({ clientMutationId: VALID_MUTATION_ID }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(bitableService.getRuntimeConfig).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expectLeaseCanBeAcquired(statePath);
  });

  it('fails closed before Feishu authentication when PUBLIC_BASE_URL is missing', async () => {
    delete process.env.PUBLIC_BASE_URL;
    const { service, post } = createService();

    await expect(
      service.sendTest({ clientMutationId: VALID_MUTATION_ID }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(post).not.toHaveBeenCalled();
    expect(existsSync(statePath)).toBe(false);
    expectLeaseCanBeAcquired(statePath);
  });

  it('fails closed before Feishu authentication when no primary matched warning exists', async () => {
    const { service, post } = createService({
      snapshot: { ...ACTIVE_SNAPSHOT, matchedWarnings: [] },
    });

    await expect(
      service.sendTest({ clientMutationId: VALID_MUTATION_ID }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(post).not.toHaveBeenCalled();
    expect(existsSync(statePath)).toBe(false);
    expectLeaseCanBeAcquired(statePath);
  });

  it.each([
    ['missing', null],
    ['invalid', { openId: 'oc_no-fallback-group', displayName: '示例人员020' }],
  ] as const)(
    'fails closed when the configured recipient is %s',
    async (_caseName, recipient) => {
      const { service, post } = createService({ recipient });

      const error = await service
        .sendTest({ clientMutationId: VALID_MUTATION_ID })
        .then(
          () => undefined,
          (failure: unknown) => failure,
        );

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(String(error)).not.toContain('oc_no-fallback-group');
      expect(post).not.toHaveBeenCalled();
      expectLeaseCanBeAcquired(statePath);
    },
  );

  it('fails closed while another notification operation holds the independent lease', async () => {
    const lease = acquireWeatherWarningDeliveryLease({
      explicitPath: statePath,
    });
    const { service, post, snapshotService } = createService();

    await expect(
      service.sendTest({ clientMutationId: VALID_MUTATION_ID }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    lease?.release();
    expectLeaseCanBeAcquired(statePath);
  });

  it('fails closed when the persisted delivery state is corrupt', async () => {
    writeFileSync(statePath, '{not-json', 'utf8');
    const { service, post, snapshotService } = createService();

    await expect(
      service.sendTest({ clientMutationId: VALID_MUTATION_ID }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expectLeaseCanBeAcquired(statePath);
  });

  it.each([
    ['reports a nonzero Feishu code', { code: 230035, msg: 'token=private' }],
    ['requires a nonempty Feishu message id', { code: 0, data: {} }],
  ] as const)(
    '%s and does not persist a delivery',
    async (_name, messageResponse) => {
      const { service, post } = createService({ messageResponse });

      const error = await service
        .sendTest({ clientMutationId: VALID_MUTATION_ID })
        .then(
          () => undefined,
          (failure: unknown) => failure,
        );

      expect(error).toBeInstanceOf(BadGatewayException);
      expect(String(error)).not.toContain('private');
      expect(String(error)).not.toContain('230035');
      expect(
        post.mock.calls.filter(([url]) => url === MESSAGE_ENDPOINT),
      ).toHaveLength(1);
      expect(existsSync(statePath)).toBe(false);
      expectLeaseCanBeAcquired(statePath);
    },
  );

  it.each([
    'not-a-feishu-message-id',
    ' om_weather_warning_wrapped ',
    'om_weather_warning_wrapped\n',
  ] as const)(
    'rejects malformed raw Feishu message id %j before attempting state write',
    async (messageId) => {
      const writeState = jest.spyOn(
        weatherWarningDeliveryStateStore,
        'writeWeatherWarningDeliveryStateFile',
      );
      const { service, post } = createService({
        messageResponse: {
          code: 0,
          data: { message_id: messageId },
        },
      });

      const error = await service
        .sendTest({ clientMutationId: VALID_MUTATION_ID })
        .then(
          () => undefined,
          (failure: unknown) => failure,
        );

      expect(error).toBeInstanceOf(BadGatewayException);
      expect(String(error)).not.toContain(messageId.trim());
      expect(writeState).not.toHaveBeenCalled();
      expect(existsSync(statePath)).toBe(false);
      expect(
        post.mock.calls.filter(([url]) => url === MESSAGE_ENDPOINT),
      ).toHaveLength(1);
      expectLeaseCanBeAcquired(statePath);
    },
  );

  it.each([
    ['network failure', new Error('tenant_access_token=private')],
    ['nonzero response', undefined],
  ] as const)(
    'sanitizes Feishu auth %s without attempting state write',
    async (_caseName, networkError) => {
      const writeState = jest.spyOn(
        weatherWarningDeliveryStateStore,
        'writeWeatherWarningDeliveryStateFile',
      );
      const { service, post } = createService();
      post.mockReset();
      if (networkError) {
        post.mockRejectedValue(networkError);
      } else {
        post.mockResolvedValue({
          data: { code: 999, msg: 'tenant_access_token=private' },
        });
      }

      const error = await service
        .sendTest({ clientMutationId: VALID_MUTATION_ID })
        .then(
          () => undefined,
          (failure: unknown) => failure,
        );

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(String(error)).not.toContain('private');
      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0]?.[0]).toBe(AUTH_ENDPOINT);
      expect(writeState).not.toHaveBeenCalled();
      expect(existsSync(statePath)).toBe(false);
      expectLeaseCanBeAcquired(statePath);
    },
  );

  it('clears a failed in-flight tenant-token request so a later notification can retry', async () => {
    const { service, post } = createService();
    post
      .mockReset()
      .mockRejectedValueOnce(new Error('first tenant token failure'))
      .mockResolvedValueOnce({
        data: {
          code: 0,
          tenant_access_token: 'tenant-token-after-retry',
          expire: 7200,
        },
      })
      .mockResolvedValueOnce({
        data: { code: 0, data: { message_id: 'om_weather_warning_retry' } },
      });

    await expect(
      service.sendTest({ clientMutationId: VALID_MUTATION_ID }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      service.sendTest({ clientMutationId: 'weather-test-20260804-002' }),
    ).resolves.toMatchObject({
      success: true,
      messageId: 'om_weather_warning_retry',
    });

    expect(
      post.mock.calls.filter(([url]) => url === AUTH_ENDPOINT),
    ).toHaveLength(2);
    expect(
      post.mock.calls.filter(([url]) => url === MESSAGE_ENDPOINT),
    ).toHaveLength(1);
  });

  it('sanitizes an IM network failure without attempting state write', async () => {
    const writeState = jest.spyOn(
      weatherWarningDeliveryStateStore,
      'writeWeatherWarningDeliveryStateFile',
    );
    const { service, post } = createService({
      messageError: new Error('message request token=private'),
    });

    const error = await service
      .sendTest({ clientMutationId: VALID_MUTATION_ID })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );

    expect(error).toBeInstanceOf(BadGatewayException);
    expect(String(error)).not.toContain('private');
    expect(writeState).not.toHaveBeenCalled();
    expect(existsSync(statePath)).toBe(false);
    expect(
      post.mock.calls.filter(([url]) => url === MESSAGE_ENDPOINT),
    ).toHaveLength(1);
    expectLeaseCanBeAcquired(statePath);
  });

  it('logs only a sanitized Feishu numeric code for a rejected message response', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service } = createService({
      messageResponse: {
        code: 230035,
        msg: 'recipient=ou_private tenant_access_token=private',
      },
    });

    await expect(
      service.sendTest({ clientMutationId: VALID_MUTATION_ID }),
    ).rejects.toBeInstanceOf(BadGatewayException);

    expect(warn).toHaveBeenCalledWith(
      '天气预警飞书投递失败：stage=response, status=200, code=230035',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('ou_private');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  });

  it('logs only sanitized status and numeric code for a rejected IM HTTP request', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const messageError = Object.assign(
      new Error('recipient=ou_private tenant_access_token=private'),
      {
        response: {
          status: 400,
          data: {
            code: 230001,
            msg: 'recipient=ou_private tenant_access_token=private',
          },
        },
      },
    );
    const { service } = createService({ messageError });

    await expect(
      service.sendTest({ clientMutationId: VALID_MUTATION_ID }),
    ).rejects.toBeInstanceOf(BadGatewayException);

    expect(warn).toHaveBeenCalledWith(
      '天气预警飞书投递失败：stage=http, status=400, code=230001',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('ou_private');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  });

  it('persists exactly one successful configured-recipient delivery without leaking its open id', async () => {
    const { service, post, snapshotService } = createService();

    const result = await service.sendTest({
      clientMutationId: VALID_MUTATION_ID,
    });
    const messageCall = post.mock.calls.find(
      ([url]) => url === MESSAGE_ENDPOINT,
    );

    expect(snapshotService.getSnapshot).toHaveBeenCalledWith({
      forceRefresh: true,
    });
    expect(result).toEqual<WeatherWarningTestSendResponse>({
      success: true,
      sent: true,
      clientMutationId: VALID_MUTATION_ID,
      messageId: 'om_weather_warning_test',
      sentAt: '2026-08-04T08:00:00.000Z',
      message: '天气预警测试卡片已发送',
    });
    expect(messageCall).toBeDefined();
    expect(messageCall?.[1]).toEqual({
      receive_id: CONFIGURED_OPEN_ID,
      msg_type: 'interactive',
      content: expect.any(String),
      uuid: stableUuid(VALID_MUTATION_ID),
    });
    expect(messageCall?.[2]).toEqual(
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token-for-test' },
        timeout: 30_000,
      }),
    );
    const deliveredCard = JSON.parse(String(messageCall?.[1]?.content));
    expect(deliveredCard).toMatchObject({
      schema: '2.0',
    });
    expect(JSON.stringify(deliveredCard)).toContain(TEST_REGISTRATION_URL);
    expect(JSON.stringify(deliveredCard)).not.toContain(LEGACY_APPROVAL_URL);

    const persistedState = readFileSync(statePath, 'utf8');
    expect(persistedState).toContain(VALID_MUTATION_ID);
    expect(persistedState).toContain('om_weather_warning_test');
    expect(persistedState).not.toContain(CONFIGURED_OPEN_ID);
    expect(persistedState).not.toContain('tenant-token-for-test');
    expect(JSON.stringify(result)).not.toContain(CONFIGURED_OPEN_ID);
  });

  it('rejects a concurrent duplicate mutation without a second IM post or state write', async () => {
    let resolveSnapshot: (snapshot: WeatherWarningSnapshot) => void;
    const snapshotGate = new Promise<WeatherWarningSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
    const writeState = jest.spyOn(
      weatherWarningDeliveryStateStore,
      'writeWeatherWarningDeliveryStateFile',
    );
    const { service, post, snapshotService } = createService();
    snapshotService.getSnapshot.mockReturnValueOnce(snapshotGate);

    const firstSend = service.sendTest({
      clientMutationId: VALID_MUTATION_ID,
    });
    expect(snapshotService.getSnapshot).toHaveBeenCalledWith({
      forceRefresh: true,
    });

    await expect(
      service.sendTest({ clientMutationId: VALID_MUTATION_ID }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      post.mock.calls.filter(([url]) => url === MESSAGE_ENDPOINT),
    ).toHaveLength(0);

    resolveSnapshot!(ACTIVE_SNAPSHOT);
    await expect(firstSend).resolves.toMatchObject({
      success: true,
      clientMutationId: VALID_MUTATION_ID,
    });

    expect(
      post.mock.calls.filter(([url]) => url === MESSAGE_ENDPOINT),
    ).toHaveLength(1);
    expect(writeState).toHaveBeenCalledTimes(1);
  });

  it('replays the exact prior success for the same mutation without another snapshot or Feishu call', async () => {
    const { service, post, snapshotService } = createService();
    const first = await service.sendTest({
      clientMutationId: VALID_MUTATION_ID,
    });
    snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      canSendTest: false,
    });

    const replay = await service.sendTest({
      clientMutationId: VALID_MUTATION_ID,
    });

    expect(replay).toEqual(first);
    expect(snapshotService.getSnapshot).toHaveBeenCalledTimes(1);
    expect(
      post.mock.calls.filter(([url]) => url === AUTH_ENDPOINT),
    ).toHaveLength(1);
    expect(
      post.mock.calls.filter(([url]) => url === MESSAGE_ENDPOINT),
    ).toHaveLength(1);
  });

  it('replays a normal own persisted delivery entry without another snapshot or Feishu call', async () => {
    writeWeatherWarningDeliveryStateFile(
      {
        version: 1,
        entries: {
          [VALID_MUTATION_ID]: {
            clientMutationId: VALID_MUTATION_ID,
            messageId: 'om_weather_warning_replay',
            sentAt: '2026-08-04T08:00:00.000Z',
            uuid: stableUuid(VALID_MUTATION_ID),
            snapshotSignature: 'sha256:test-replay',
          },
        },
      },
      { explicitPath: statePath },
    );
    const { service, post, snapshotService } = createService();

    await expect(
      service.sendTest({ clientMutationId: VALID_MUTATION_ID }),
    ).resolves.toEqual({
      success: true,
      sent: true,
      clientMutationId: VALID_MUTATION_ID,
      messageId: 'om_weather_warning_replay',
      sentAt: '2026-08-04T08:00:00.000Z',
      message: '天气预警测试卡片已发送',
    });

    expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('uses the canonical stable UUID and caches a valid tenant token for distinct sends', async () => {
    const { service, post } = createService();

    await service.sendTest({ clientMutationId: VALID_MUTATION_ID });
    await service.sendTest({ clientMutationId: 'weather-test-20260804-002' });

    const messageCalls = post.mock.calls.filter(
      ([url]) => url === MESSAGE_ENDPOINT,
    );
    expect(messageCalls.map(([, body]) => body.uuid)).toEqual([
      stableUuid(VALID_MUTATION_ID),
      stableUuid('weather-test-20260804-002'),
    ]);
    expect(
      post.mock.calls.filter(([url]) => url === AUTH_ENDPOINT),
    ).toHaveLength(1);
  });

  it.each([
    {
      receiveIdType: 'chat_id' as const,
      receiveId: 'oc_weather_warning_group',
      endpoint: CHAT_MESSAGE_ENDPOINT,
    },
    {
      receiveIdType: 'open_id' as const,
      receiveId: 'ou_ma_jinyu',
      endpoint: MESSAGE_ENDPOINT,
    },
  ])(
    'sends an automation card to a controlled $receiveIdType target with a stable uuid',
    async ({ receiveIdType, receiveId, endpoint }) => {
      const { service, post } = createService();
      const deliveryKey =
        'auto:initial:event-0123456789abcdef:target-fedcba9876543210';

      await expect(
        service.sendAutomationCard({
          deliveryKey,
          target: {
            key: receiveIdType === 'chat_id' ? 'chat-1' : 'owner',
            receiveIdType,
            receiveId,
            displayName: '受控目标',
          },
          card: { schema: '2.0', body: { elements: [] } },
        }),
      ).resolves.toEqual({
        messageId: 'om_weather_warning_test',
        sentAt: '2026-08-04T08:00:00.000Z',
        uuid: automationUuid(deliveryKey),
      });

      const messageCall = post.mock.calls.find(([url]) => url === endpoint);
      expect(messageCall?.[1]).toEqual({
        receive_id: receiveId,
        msg_type: 'interactive',
        content: JSON.stringify({
          schema: '2.0',
          body: { elements: [] },
        }),
        uuid: automationUuid(deliveryKey),
      });
    },
  );

  it('rejects an invalid automation target before authentication or IM delivery', async () => {
    const { service, post } = createService();
    const invalidId = 'private-invalid-target';

    const error = await service
      .sendAutomationCard({
        deliveryKey:
          'auto:initial:event-0123456789abcdef:target-fedcba9876543210',
        target: {
          key: 'chat-1',
          receiveIdType: 'chat_id',
          receiveId: invalidId,
          displayName: '非法目标',
        },
        card: { schema: '2.0' },
      })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(String(error)).not.toContain(invalidId);
    expect(post).not.toHaveBeenCalled();
  });
});

function stableUuid(clientMutationId: string): string {
  return createHash('sha256')
    .update(`weather-warning:test:${clientMutationId}`)
    .digest('hex')
    .slice(0, 32);
}

function automationUuid(deliveryKey: string): string {
  return createHash('sha256')
    .update(`weather-warning:auto:${deliveryKey}`)
    .digest('hex')
    .slice(0, 32);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function expectLeaseCanBeAcquired(explicitPath: string): void {
  const lease = acquireWeatherWarningDeliveryLease({ explicitPath });
  expect(lease).not.toBeNull();
  lease?.release();
}
