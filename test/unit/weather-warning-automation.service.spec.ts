import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WeatherWarningSnapshot } from '../../shared/api.interface';
import {
  acquireWeatherWarningAutomationLease,
  readWeatherWarningAutomationStateFile,
} from '../../server/modules/weather-warning/weather-warning-automation-state-store';
import { WeatherWarningAutomationService } from '../../server/modules/weather-warning/weather-warning-automation.service';

const ACTIVE_SNAPSHOT: WeatherWarningSnapshot = {
  status: 'active',
  sourceState: 'fresh',
  guardDecisionState: 'fresh',
  checkSyncState: 'fresh',
  snapshotAt: '2026-08-08T00:00:00.000Z',
  lastSuccessAt: '2026-08-08T00:00:00.000Z',
  guardLevel: '三级戒备',
  matchedWarnings: [
    {
      id: 'typhoon-blue-20260807',
      title: '江苏省气象台发布台风蓝色预警',
      type: '台风',
      color: 'blue',
      guardLevel: '三级戒备',
      pubTime: '2026-08-07T15:31:00+08:00',
    },
  ],
  unmatchedWarnings: [],
  actions: ['相关人员7*24 On call'],
  weather: null,
  checkSummary: {
    device: 'completed',
    environment: 'pending',
    disaster: 'completed',
    materials: 'completed',
    contacts: 'completed',
    managerConfirmation: 'completed',
    abnormalSummaries: [],
  },
  requiredCheckKeys: [
    'device',
    'disaster',
    'materials',
    'contacts',
    'managerConfirmation',
  ],
  canSendTest: true,
};

const PUBLIC_BASE_URL = 'https://app.sjhl.online/platform/';
const CLIENT_BASE_PATH = '/nantong/';
const LEGACY_APPROVAL_URL =
  'https://vnet.feishu.cn/share/base/form/shrcneofD8Ahc8650YU6hIuPpTe';

const AUTOMATION_ENVIRONMENT_NAMES = [
  'FEISHU_WEATHER_WARNING_AUTOMATION_ENABLED',
  'FEISHU_WEATHER_WARNING_CHAT_IDS',
  'FEISHU_WEATHER_WARNING_IMPORTANT_EVENT_CHAT_IDS',
  'FEISHU_WEATHER_WARNING_OWNER_OPEN_ID',
  'FEISHU_WEATHER_WARNING_OWNER_NAME',
  'FEISHU_WEATHER_WARNING_POLL_INTERVAL_MS',
  'FEISHU_WEATHER_WARNING_REMINDER_INTERVAL_MS',
  'FEISHU_WEATHER_WARNING_AUTOMATION_STATE_PATH',
  'FEISHU_WEATHER_WARNING_AUTOMATION_STATE_DIR',
  'WEATHER_WARNING_REGISTRATION_ENABLED',
  'FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED',
  'PUBLIC_BASE_URL',
  'CLIENT_BASE_PATH',
] as const;

describe('WeatherWarningAutomationService', () => {
  const originalEnvironment = captureAutomationEnvironment();
  let root = '';
  let statePath = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'weather-warning-automation-'));
    statePath = join(root, 'automation-state.json');
    process.env.FEISHU_WEATHER_WARNING_AUTOMATION_STATE_PATH = statePath;
    delete process.env.FEISHU_WEATHER_WARNING_AUTOMATION_STATE_DIR;
    delete process.env.FEISHU_WEATHER_WARNING_AUTOMATION_ENABLED;
    delete process.env.FEISHU_WEATHER_WARNING_CHAT_IDS;
    delete process.env.FEISHU_WEATHER_WARNING_IMPORTANT_EVENT_CHAT_IDS;
    delete process.env.FEISHU_WEATHER_WARNING_OWNER_OPEN_ID;
    delete process.env.FEISHU_WEATHER_WARNING_OWNER_NAME;
    delete process.env.FEISHU_WEATHER_WARNING_POLL_INTERVAL_MS;
    delete process.env.FEISHU_WEATHER_WARNING_REMINDER_INTERVAL_MS;
    delete process.env.WEATHER_WARNING_REGISTRATION_ENABLED;
    delete process.env.FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED;
    process.env.PUBLIC_BASE_URL = PUBLIC_BASE_URL;
    process.env.CLIENT_BASE_PATH = CLIENT_BASE_PATH;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (root && existsSync(root))
      rmSync(root, { recursive: true, force: true });
  });

  afterAll(() => restoreAutomationEnvironment(originalEnvironment));

  it('does not read a snapshot or send when automation is disabled by default', async () => {
    const { service, snapshotService, notificationService } = createService();

    await expect(
      service.runDue(new Date('2026-08-08T00:00:00.000Z')),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'disabled', sentCount: 0 }),
    );
    expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
    expect(notificationService.sendAutomationCard).not.toHaveBeenCalled();
    expect(existsSync(statePath)).toBe(false);
  });

  it('keeps the first alert but pauses registration, progress reads, and later reminders', async () => {
    enableAutomation({ trackingEnabled: false });
    const automation = createService({
      ...ACTIVE_SNAPSHOT,
      buildingProgress: {
        available: true,
        buildings: [],
        missingRegistrationBuildings: ['A楼'],
        unassignedRecordCount: 0,
        incompleteItems: [
          {
            building: 'A楼',
            key: 'registration',
            label: '未提交戒备登记',
            state: 'missing_registration',
          },
        ],
      },
    });

    await expect(
      automation.service.runDue(new Date('2026-08-08T00:00:00.000Z')),
    ).resolves.toMatchObject({
      status: 'processed',
      sentCount: 2,
      failedCount: 0,
    });
    expect(automation.bitableService.getCheckProgress).not.toHaveBeenCalled();
    for (const [request] of automation.notificationService.sendAutomationCard
      .mock.calls) {
      const card = JSON.stringify(request.card);
      expect(request.deliveryKey).toMatch(/^auto:initial:/u);
      expect(card).toContain('下载重保检查单');
      expect(card).toContain('相关人员7');
      expect(card).not.toContain('提交戒备登记');
      expect(card).not.toContain('执行进度');
      expect(card).not.toContain('weatherGuardRegistration');
    }

    automation.notificationService.sendAutomationCard.mockClear();
    await expect(
      automation.service.runDue(new Date('2026-08-09T00:00:00.000Z')),
    ).resolves.toMatchObject({
      status: 'processed',
      sentCount: 0,
      failedCount: 0,
    });
    expect(automation.bitableService.getCheckProgress).not.toHaveBeenCalled();
    expect(
      automation.notificationService.sendAutomationCard,
    ).not.toHaveBeenCalled();
  });

  it('sends one initial card to each controlled target and restores dedupe state after restart', async () => {
    enableAutomation();
    const first = createService();
    const now = new Date('2026-08-08T00:00:00.000Z');

    await expect(first.service.runDue(now)).resolves.toEqual(
      expect.objectContaining({
        status: 'processed',
        sentCount: 2,
        failedCount: 0,
        eventHash: expect.stringMatching(/^[0-9a-f]{24}$/u),
      }),
    );
    expect(first.snapshotService.getSnapshot).toHaveBeenCalledWith({
      forceRefresh: true,
      forceRuleRefresh: false,
      includeCheckProgress: true,
    });
    expect(first.bitableService.getCheckProgress).toHaveBeenCalledWith(
      '三级戒备',
      '台风蓝色',
      '2026-08-08T00:00:00.000Z',
      ACTIVE_SNAPSHOT.requiredCheckKeys,
      true,
    );
    expect(
      first.notificationService.sendAutomationCard.mock.calls.map(
        ([request]) => request.target.receiveIdType,
      ),
    ).toEqual(['chat_id', 'open_id']);
    expect(
      first.notificationService.sendAutomationCard.mock.calls.map(
        ([request]) => request.deliveryKey,
      ),
    ).toEqual([
      expect.stringMatching(/^auto:initial:[0-9a-f]{24}:[0-9a-f]{16}$/u),
      expect.stringMatching(/^auto:initial:[0-9a-f]{24}:[0-9a-f]{16}$/u),
    ]);
    for (const [request] of first.notificationService.sendAutomationCard.mock
      .calls) {
      expectCardRegistrationUrl(request.card, 'typhoon-blue-20260807');
    }

    const persisted = readFileSync(statePath, 'utf8');
    expect(persisted).not.toContain('oc_weather_warning_group');
    expect(persisted).not.toContain('ou_ma_jinyu');

    const restarted = createService();
    await expect(restarted.service.runDue(now)).resolves.toEqual(
      expect.objectContaining({
        status: 'processed',
        sentCount: 0,
        failedCount: 0,
      }),
    );
    expect(
      restarted.notificationService.sendAutomationCard,
    ).not.toHaveBeenCalled();
  });

  it('keeps initial delivery identities stable when a restart loses its local state file', async () => {
    enableAutomation();
    const first = createService();

    await expect(
      first.service.runDue(new Date('2026-08-08T00:00:00.000Z')),
    ).resolves.toMatchObject({ status: 'processed', sentCount: 2 });
    const firstDeliveryKeys =
      first.notificationService.sendAutomationCard.mock.calls.map(
        ([request]) => request.deliveryKey,
      );

    rmSync(statePath, { force: true });
    const restartedWithoutState = createService();
    await expect(
      restartedWithoutState.service.runDue(
        new Date('2026-08-08T08:28:00.000Z'),
      ),
    ).resolves.toMatchObject({ status: 'processed', sentCount: 2 });
    const restartedDeliveryKeys =
      restartedWithoutState.notificationService.sendAutomationCard.mock.calls.map(
        ([request]) => request.deliveryKey,
      );

    expect(restartedDeliveryKeys).toEqual(firstDeliveryKeys);
  });

  it('sends a concrete building reminder only when two hours have elapsed', async () => {
    enableAutomation();
    const snapshot = {
      ...ACTIVE_SNAPSHOT,
      buildingProgress: {
        available: true,
        buildings: [],
        missingRegistrationBuildings: [],
        unassignedRecordCount: 0,
        incompleteItems: [
          {
            building: 'A楼',
            key: 'environment',
            label: '环境安全',
            state: 'pending',
          },
          {
            building: 'H楼',
            key: 'materials',
            label: '物资清单',
            state: 'abnormal',
            detail: '备用电池数量不足',
          },
        ],
      },
    } as WeatherWarningSnapshot;
    const currentSentAt = { value: '2026-08-08T00:00:00.000Z' };
    const automation = createService(snapshot, {
      sentAt: () => currentSentAt.value,
    });

    await expect(
      automation.service.runDue(new Date('2026-08-08T00:00:00.000Z')),
    ).resolves.toMatchObject({ sentCount: 2, failedCount: 0 });
    automation.notificationService.sendAutomationCard.mockClear();

    await expect(
      automation.service.runDue(new Date('2026-08-08T01:59:59.999Z')),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'processed', sentCount: 0 }),
    );
    expect(
      automation.notificationService.sendAutomationCard,
    ).not.toHaveBeenCalled();

    currentSentAt.value = '2026-08-08T02:00:00.000Z';
    await expect(
      automation.service.runDue(new Date('2026-08-08T02:00:00.000Z')),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'processed', sentCount: 2 }),
    );
    const requests =
      automation.notificationService.sendAutomationCard.mock.calls.map(
        ([request]) => request,
      );
    expect(requests.map((request) => request.deliveryKey)).toEqual([
      expect.stringMatching(
        /^auto:reminder:[0-9a-f]{24}:[0-9a-z]+:[0-9a-f]{16}$/u,
      ),
      expect.stringMatching(
        /^auto:reminder:[0-9a-f]{24}:[0-9a-z]+:[0-9a-f]{16}$/u,
      ),
    ]);
    for (const request of requests) {
      const serializedCard = JSON.stringify(request.card);
      expect(serializedCard).not.toContain('A楼');
      expect(serializedCard).not.toContain('环境安全');
      expect(serializedCard).toContain('H楼');
      expect(serializedCard).toContain('备用电池数量不足');
      expectCardRegistrationUrl(request.card, 'typhoon-blue-20260807');
    }

    automation.notificationService.sendAutomationCard.mockClear();
    await automation.service.runDue(new Date('2026-08-08T02:00:00.000Z'));
    expect(
      automation.notificationService.sendAutomationCard,
    ).not.toHaveBeenCalled();
  });

  it('does not send reminders after every check is completed', async () => {
    enableAutomation();
    const completedSnapshot: WeatherWarningSnapshot = {
      ...ACTIVE_SNAPSHOT,
      checkSummary: {
        device: 'completed',
        environment: 'completed',
        disaster: 'completed',
        materials: 'completed',
        contacts: 'completed',
        managerConfirmation: 'completed',
        abnormalSummaries: [],
      },
    };
    const automation = createService(completedSnapshot);

    await automation.service.runDue(new Date('2026-08-08T00:00:00.000Z'));
    automation.notificationService.sendAutomationCard.mockClear();
    await automation.service.runDue(new Date('2026-08-08T12:00:00.000Z'));

    expect(
      automation.notificationService.sendAutomationCard,
    ).not.toHaveBeenCalled();
  });

  it('persists each successful target and retries only the failed target', async () => {
    enableAutomation();
    const automation = createService(ACTIVE_SNAPSHOT, {
      failOnceForTargetKey: 'owner',
    });
    const now = new Date('2026-08-08T00:00:00.000Z');

    await expect(automation.service.runDue(now)).resolves.toEqual(
      expect.objectContaining({ sentCount: 1, failedCount: 1 }),
    );
    await expect(automation.service.runDue(now)).resolves.toEqual(
      expect.objectContaining({ sentCount: 1, failedCount: 0 }),
    );

    expect(
      automation.notificationService.sendAutomationCard.mock.calls.map(
        ([request]) => request.target.key,
      ),
    ).toEqual(['chat-1', 'owner', 'owner']);
  });

  it('keeps one event when warning titles or collection members change', async () => {
    enableAutomation();
    const automation = createService();
    const openedAt = new Date('2026-08-08T00:00:00.000Z');

    const firstRun = await automation.service.runDue(openedAt);
    automation.notificationService.sendAutomationCard.mockClear();
    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      snapshotAt: '2026-08-08T00:10:00.000Z',
      matchedWarnings: [
        {
          ...ACTIVE_SNAPSHOT.matchedWarnings[0],
          title: '江苏省气象台继续发布台风蓝色预警（标题已更新）',
        },
        {
          id: 'rain-yellow-20260808',
          title: '南通市气象台发布暴雨黄色预警',
          type: '暴雨',
          color: 'yellow',
          guardLevel: '三级戒备',
          pubTime: '2026-08-08T00:05:00.000Z',
        },
      ],
    });

    const secondRun = await automation.service.runDue(
      new Date('2026-08-08T00:10:00.000Z'),
    );

    expect(secondRun).toMatchObject({
      status: 'processed',
      sentCount: 0,
      eventHash: firstRun.eventHash,
    });
    expect(
      automation.notificationService.sendAutomationCard,
    ).not.toHaveBeenCalled();
    expect(
      readWeatherWarningAutomationStateFile({ explicitPath: statePath })
        .activeEvent,
    ).toMatchObject({ revision: 1, openedAt: openedAt.toISOString() });
  });

  it('sends one upgrade notification when the warning color rises within the same guard level', async () => {
    enableAutomation({ trackingEnabled: false });
    const automation = createService({
      ...ACTIVE_SNAPSHOT,
      matchedWarnings: [
        {
          ...ACTIVE_SNAPSHOT.matchedWarnings[0],
          id: 'rain-blue-20260815',
          title: '南通市气象台发布暴雨蓝色预警',
          type: '暴雨',
        },
      ],
    });

    const firstRun = await automation.service.runDue(
      new Date('2026-08-15T00:00:00.000Z'),
    );
    automation.notificationService.sendAutomationCard.mockClear();
    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      snapshotAt: '2026-08-15T00:10:00.000Z',
      guardLevel: '三级戒备',
      matchedWarnings: [
        {
          ...ACTIVE_SNAPSHOT.matchedWarnings[0],
          id: 'rain-yellow-20260815',
          title: '南通市气象台发布暴雨黄色预警',
          type: '暴雨',
          color: 'yellow',
          guardLevel: '三级戒备',
          pubTime: '2026-08-15T00:00:00.000Z',
        },
      ],
    });

    await expect(
      automation.service.runDue(new Date('2026-08-15T00:10:00.000Z')),
    ).resolves.toMatchObject({
      status: 'processed',
      eventHash: firstRun.eventHash,
      sentCount: 2,
      failedCount: 0,
    });

    const requests =
      automation.notificationService.sendAutomationCard.mock.calls.map(
        ([request]) => request,
      );
    expect(requests.map(({ deliveryKey }) => deliveryKey)).toEqual([
      expect.stringMatching(/^auto:upgrade:[0-9a-f]{24}:2:[0-9a-f]{16}$/u),
      expect.stringMatching(/^auto:upgrade:[0-9a-f]{24}:2:[0-9a-f]{16}$/u),
    ]);
    for (const request of requests) {
      const card = JSON.stringify(request.card);
      expect(card).toContain('升级通报');
      expect(card).toContain('暴雨黄色预警');
      expect(card).toContain('三级戒备');
      expect(card).toContain('相关人员7');
      expect(card).not.toContain('执行进度');
      expect(card).not.toContain('提交戒备登记');
    }
    expect(
      readWeatherWarningAutomationStateFile({ explicitPath: statePath })
        .activeEvent,
    ).toMatchObject({
      guardLevel: '三级戒备',
      highestGuardLevel: '三级戒备',
      revision: 2,
      primaryWarning: {
        id: 'rain-yellow-20260815',
        color: 'yellow',
      },
    });

    automation.notificationService.sendAutomationCard.mockClear();
    await expect(
      automation.service.runDue(new Date('2026-08-15T00:20:00.000Z')),
    ).resolves.toMatchObject({ sentCount: 0, failedCount: 0 });
    expect(
      automation.notificationService.sendAutomationCard,
    ).not.toHaveBeenCalled();

    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      snapshotAt: '2026-08-15T00:30:00.000Z',
      guardLevel: '三级戒备',
      matchedWarnings: [
        {
          ...ACTIVE_SNAPSHOT.matchedWarnings[0],
          id: 'rain-blue-again-20260815',
          title: '南通市气象台降级发布暴雨蓝色预警',
          type: '暴雨',
          color: 'blue',
          guardLevel: '三级戒备',
        },
      ],
    });
    await automation.service.runDue(new Date('2026-08-15T00:30:00.000Z'));

    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      snapshotAt: '2026-08-15T00:40:00.000Z',
      guardLevel: '三级戒备',
      matchedWarnings: [
        {
          ...ACTIVE_SNAPSHOT.matchedWarnings[0],
          id: 'rain-yellow-again-20260815',
          title: '南通市气象台再次发布暴雨黄色预警',
          type: '暴雨',
          color: 'yellow',
          guardLevel: '三级戒备',
        },
      ],
    });
    await expect(
      automation.service.runDue(new Date('2026-08-15T00:40:00.000Z')),
    ).resolves.toMatchObject({ sentCount: 0, failedCount: 0 });
    expect(
      automation.notificationService.sendAutomationCard,
    ).not.toHaveBeenCalled();
    expect(
      readWeatherWarningAutomationStateFile({ explicitPath: statePath })
        .activeEvent,
    ).toMatchObject({ revision: 2, primaryWarning: { color: 'yellow' } });

    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      snapshotAt: '2026-08-15T00:50:00.000Z',
      guardLevel: '三级戒备',
      matchedWarnings: [
        {
          ...ACTIVE_SNAPSHOT.matchedWarnings[0],
          id: 'rain-orange-20260815',
          title: '南通市气象台升级发布暴雨橙色预警',
          type: '暴雨',
          color: 'orange',
          guardLevel: '三级戒备',
        },
      ],
    });
    await expect(
      automation.service.runDue(new Date('2026-08-15T00:50:00.000Z')),
    ).resolves.toMatchObject({ sentCount: 2, failedCount: 0 });
    expect(
      readWeatherWarningAutomationStateFile({ explicitPath: statePath })
        .activeEvent,
    ).toMatchObject({ revision: 3, primaryWarning: { color: 'orange' } });
  });

  it('sends one upgrade revision and resolves every audience reached by a level-one event', async () => {
    enableAutomation({ importantEventChatIds: 'oc_important_event_group' });
    const automation = createService();

    await automation.service.runDue(new Date('2026-08-08T00:00:00.000Z'));
    automation.notificationService.sendAutomationCard.mockClear();
    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      snapshotAt: '2026-08-08T00:10:00.000Z',
      guardLevel: '一级戒备',
      matchedWarnings: [
        {
          ...ACTIVE_SNAPSHOT.matchedWarnings[0],
          id: 'typhoon-red-20260808',
          title: '江苏省气象台升级发布台风红色预警',
          color: 'red',
          guardLevel: '一级戒备',
        },
      ],
    });

    await expect(
      automation.service.runDue(new Date('2026-08-08T00:10:00.000Z')),
    ).resolves.toMatchObject({ sentCount: 3, failedCount: 0 });

    const requests =
      automation.notificationService.sendAutomationCard.mock.calls.map(
        ([request]) => request,
      );
    expect(requests.map(({ target }) => target.audience)).toEqual([
      'general_chat',
      'important_event_chat',
      'owner',
    ]);
    expect(requests.map(({ deliveryKey }) => deliveryKey)).toEqual([
      expect.stringMatching(/^auto:upgrade:[0-9a-f]{24}:2:[0-9a-f]{16}$/u),
      expect.stringMatching(/^auto:upgrade:[0-9a-f]{24}:2:[0-9a-f]{16}$/u),
      expect.stringMatching(/^auto:upgrade:[0-9a-f]{24}:2:[0-9a-f]{16}$/u),
    ]);
    for (const request of requests) {
      expectCardRegistrationUrl(request.card, 'typhoon-red-20260808');
      expect(JSON.stringify(request.card)).toContain('升级通报');
    }
    expect(
      readWeatherWarningAutomationStateFile({ explicitPath: statePath })
        .activeEvent,
    ).toMatchObject({
      guardLevel: '一级戒备',
      highestGuardLevel: '一级戒备',
      revision: 2,
    });

    automation.notificationService.sendAutomationCard.mockClear();
    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      status: 'clear',
      sourceState: 'fresh',
      guardDecisionState: 'fresh',
      snapshotAt: '2026-08-08T00:20:00.000Z',
      guardLevel: null,
      matchedWarnings: [],
      actions: [],
      checkSyncState: 'not_applicable',
    });

    await expect(
      automation.service.runDue(new Date('2026-08-08T00:20:00.000Z')),
    ).resolves.toMatchObject({
      status: 'resolved',
      sentCount: 3,
      failedCount: 0,
    });
    const resolvedRequests =
      automation.notificationService.sendAutomationCard.mock.calls.map(
        ([request]) => request,
      );
    expect(resolvedRequests.map(({ target }) => target.audience)).toEqual([
      'general_chat',
      'important_event_chat',
      'owner',
    ]);
    expect(resolvedRequests.map(({ deliveryKey }) => deliveryKey)).toEqual([
      expect.stringMatching(/^auto:resolved:[0-9a-f]{24}:[0-9a-f]{16}$/u),
      expect.stringMatching(/^auto:resolved:[0-9a-f]{24}:[0-9a-f]{16}$/u),
      expect.stringMatching(/^auto:resolved:[0-9a-f]{24}:[0-9a-f]{16}$/u),
    ]);
    for (const request of resolvedRequests) {
      const serialized = JSON.stringify(request.card);
      expect(serialized).toContain('南通天气预警 · 已结束');
      expect(serialized).toContain('一级戒备');
      expect(serialized).not.toContain('当前状态');
      expect(serialized).not.toContain('button');
    }
  });

  it('does not notify again after a downgrade and rebound below the historical peak', async () => {
    enableAutomation({ trackingEnabled: false });
    const automation = createService();

    await automation.service.runDue(new Date('2026-08-08T00:00:00.000Z'));
    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      snapshotAt: '2026-08-08T00:10:00.000Z',
      guardLevel: '一级戒备',
      matchedWarnings: [
        {
          ...ACTIVE_SNAPSHOT.matchedWarnings[0],
          id: 'typhoon-red-20260808',
          title: '江苏省气象台升级发布台风红色预警',
          color: 'red',
          guardLevel: '一级戒备',
        },
      ],
    });
    await automation.service.runDue(new Date('2026-08-08T00:10:00.000Z'));

    automation.notificationService.sendAutomationCard.mockClear();

    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      snapshotAt: '2026-08-08T00:20:00.000Z',
    });
    await expect(
      automation.service.runDue(new Date('2026-08-08T00:20:00.000Z')),
    ).resolves.toMatchObject({ sentCount: 0, failedCount: 0 });

    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      snapshotAt: '2026-08-08T00:30:00.000Z',
      guardLevel: '二级戒备',
      matchedWarnings: [
        {
          ...ACTIVE_SNAPSHOT.matchedWarnings[0],
          id: 'typhoon-orange-20260808',
          title: '江苏省气象台发布台风橙色预警',
          color: 'orange',
          guardLevel: '二级戒备',
        },
      ],
    });
    await expect(
      automation.service.runDue(new Date('2026-08-08T00:30:00.000Z')),
    ).resolves.toMatchObject({ sentCount: 0, failedCount: 0 });

    expect(
      automation.notificationService.sendAutomationCard,
    ).not.toHaveBeenCalled();

    expect(
      readWeatherWarningAutomationStateFile({ explicitPath: statePath })
        .activeEvent,
    ).toMatchObject({
      guardLevel: '二级戒备',
      highestGuardLevel: '一级戒备',
      revision: 2,
      primaryWarning: {
        id: 'typhoon-red-20260808',
        title: '江苏省气象台升级发布台风红色预警',
        color: 'red',
      },
    });
  });

  it('keeps one event while the same warning is active but no longer matches a guard rule', async () => {
    enableAutomation({ trackingEnabled: false });
    const automation = createService();
    const firstRun = await automation.service.runDue(
      new Date('2026-08-08T00:00:00.000Z'),
    );
    automation.notificationService.sendAutomationCard.mockClear();
    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      status: 'clear',
      snapshotAt: '2026-08-08T00:01:00.000Z',
      guardLevel: null,
      matchedWarnings: [],
      unmatchedWarnings: [
        {
          ...ACTIVE_SNAPSHOT.matchedWarnings[0],
          id: 'typhoon-blue-downgraded-20260807',
          title: '江苏省气象台降级发布台风蓝色预警',
          guardLevel: null,
        },
      ],
      actions: [],
      checkSyncState: 'not_applicable',
    });

    await expect(
      automation.service.runDue(new Date('2026-08-08T00:01:00.000Z')),
    ).resolves.toMatchObject({ sentCount: 0, failedCount: 0 });
    expect(
      readWeatherWarningAutomationStateFile({ explicitPath: statePath })
        .activeEvent,
    ).toMatchObject({ eventHash: firstRun.eventHash, revision: 1 });

    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      snapshotAt: '2026-08-08T00:02:00.000Z',
    });
    await expect(
      automation.service.runDue(new Date('2026-08-08T00:02:00.000Z')),
    ).resolves.toMatchObject({
      eventHash: firstRun.eventHash,
      sentCount: 0,
      failedCount: 0,
    });
    expect(
      automation.notificationService.sendAutomationCard,
    ).not.toHaveBeenCalled();
  });

  it('does not close an active event after one isolated fresh empty snapshot', async () => {
    enableAutomation({ trackingEnabled: false });
    const automation = createService();
    const firstRun = await automation.service.runDue(
      new Date('2026-08-08T00:00:00.000Z'),
    );
    automation.notificationService.sendAutomationCard.mockClear();
    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      status: 'clear',
      snapshotAt: '2026-08-08T00:01:00.000Z',
      guardLevel: null,
      matchedWarnings: [],
      unmatchedWarnings: [],
      actions: [],
      checkSyncState: 'not_applicable',
    });

    await expect(
      automation.service.runDue(new Date('2026-08-08T00:01:00.000Z')),
    ).resolves.toMatchObject({
      status: 'no-active-warning',
      sentCount: 0,
      failedCount: 0,
    });
    expect(
      readWeatherWarningAutomationStateFile({ explicitPath: statePath })
        .activeEvent,
    ).toMatchObject({ eventHash: firstRun.eventHash });
    expect(
      automation.notificationService.sendAutomationCard,
    ).not.toHaveBeenCalled();

    await expect(
      automation.service.runDue(new Date('2026-08-08T00:02:00.000Z')),
    ).resolves.toMatchObject({
      status: 'resolved',
      sentCount: 2,
      failedCount: 0,
    });
    expect(
      readWeatherWarningAutomationStateFile({ explicitPath: statePath })
        .activeEvent,
    ).toBeNull();
  });

  it('backfills the warning summary for a migrated version-two active event', async () => {
    enableAutomation({ trackingEnabled: false });
    const automation = createService();

    await automation.service.runDue(new Date('2026-08-08T00:00:00.000Z'));
    const current = readWeatherWarningAutomationStateFile({
      explicitPath: statePath,
    });
    const activeEvent = current.activeEvent;
    expect(activeEvent).not.toBeNull();
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 2,
        entries: current.entries,
        eventSequence: current.eventSequence,
        activeEvent: {
          eventHash: activeEvent?.eventHash,
          openedAt: activeEvent?.openedAt,
          guardLevel: activeEvent?.guardLevel,
          revision: activeEvent?.revision,
          warningFingerprint: activeEvent?.warningFingerprint,
        },
      }),
      'utf8',
    );

    await automation.service.runDue(new Date('2026-08-08T00:10:00.000Z'));

    expect(
      readWeatherWarningAutomationStateFile({ explicitPath: statePath })
        .activeEvent,
    ).toMatchObject({
      highestGuardLevel: '三级戒备',
      primaryWarning: {
        id: 'typhoon-blue-20260807',
        title: '江苏省气象台发布台风蓝色预警',
        type: '台风',
        color: 'blue',
      },
    });
  });

  it('never sends an important-event group for level two or level three', async () => {
    enableAutomation({ importantEventChatIds: 'oc_important_event_group' });
    const automation = createService();

    await automation.service.runDue(new Date('2026-08-08T00:00:00.000Z'));

    expect(
      automation.notificationService.sendAutomationCard.mock.calls.map(
        ([request]) => request.target.audience,
      ),
    ).toEqual(['general_chat', 'owner']);
  });

  it('fails closed without delivery when PUBLIC_BASE_URL is missing', async () => {
    enableAutomation();
    delete process.env.PUBLIC_BASE_URL;
    const automation = createService();

    await expect(
      automation.service.runDue(new Date('2026-08-08T00:00:00.000Z')),
    ).rejects.toThrow();

    expect(
      automation.notificationService.sendAutomationCard,
    ).not.toHaveBeenCalled();
  });

  it('fails closed on a blank primary warning id instead of falling back to another warning', async () => {
    enableAutomation();
    const automation = createService({
      ...ACTIVE_SNAPSHOT,
      matchedWarnings: [
        { ...ACTIVE_SNAPSHOT.matchedWarnings[0], id: '' },
        {
          ...ACTIVE_SNAPSHOT.matchedWarnings[0],
          id: 'secondary-warning-must-not-be-used',
        },
      ],
    });

    await expect(
      automation.service.runDue(new Date('2026-08-08T00:00:00.000Z')),
    ).rejects.toThrow();

    expect(
      automation.notificationService.sendAutomationCard,
    ).not.toHaveBeenCalled();
  });

  it('sends one resolved card per notified target, deduplicates it, and treats a later warning as a new event', async () => {
    enableAutomation();
    const automation = createService();
    const first = await automation.service.runDue(
      new Date('2026-08-08T00:00:00.000Z'),
    );
    automation.notificationService.sendAutomationCard.mockClear();
    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      status: 'clear',
      snapshotAt: '2026-08-08T01:00:00.000Z',
      guardLevel: null,
      matchedWarnings: [],
      actions: [],
      checkSyncState: 'not_applicable',
    });

    await expect(
      automation.service.runDue(new Date('2026-08-08T01:00:00.000Z')),
    ).resolves.toMatchObject({
      status: 'resolved',
      sentCount: 2,
      failedCount: 0,
    });
    expect(
      automation.notificationService.sendAutomationCard.mock.calls.map(
        ([request]) => request.deliveryKey,
      ),
    ).toEqual([
      expect.stringMatching(/^auto:resolved:[0-9a-f]{24}:[0-9a-f]{16}$/u),
      expect.stringMatching(/^auto:resolved:[0-9a-f]{24}:[0-9a-f]{16}$/u),
    ]);
    const resolvedState = readWeatherWarningAutomationStateFile({
      explicitPath: statePath,
    });
    expect(resolvedState.activeEvent).toBeNull();
    expect(resolvedState.pendingResolvedEvents).toEqual({});
    expect(
      Object.keys(resolvedState.entries).filter((deliveryKey) =>
        deliveryKey.startsWith('auto:resolved:'),
      ),
    ).toHaveLength(2);

    automation.notificationService.sendAutomationCard.mockClear();
    await expect(
      automation.service.runDue(new Date('2026-08-08T01:10:00.000Z')),
    ).resolves.toMatchObject({
      status: 'no-active-warning',
      sentCount: 0,
      failedCount: 0,
    });
    expect(
      automation.notificationService.sendAutomationCard,
    ).not.toHaveBeenCalled();

    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      snapshotAt: '2026-08-08T02:00:00.000Z',
    });
    const reopened = await automation.service.runDue(
      new Date('2026-08-08T02:00:00.000Z'),
    );

    expect(reopened).toMatchObject({ status: 'processed', sentCount: 2 });
    expect(reopened.eventHash).not.toBe(first.eventHash);
    expect(
      readWeatherWarningAutomationStateFile({ explicitPath: statePath }),
    ).toMatchObject({
      eventSequence: 2,
      activeEvent: {
        openedAt: '2026-08-08T02:00:00.000Z',
        revision: 1,
      },
    });
  });

  it('retries only a failed resolved target and keeps the original close time', async () => {
    enableAutomation();
    const automation = createService(ACTIVE_SNAPSHOT, {
      failOnceForTargetKey: 'owner',
      failOnceForDeliveryPrefix: 'auto:resolved:',
    });

    await automation.service.runDue(new Date('2026-08-08T00:00:00.000Z'));
    automation.notificationService.sendAutomationCard.mockClear();
    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      status: 'clear',
      sourceState: 'fresh',
      guardDecisionState: 'fresh',
      snapshotAt: '2026-08-08T01:00:00.000Z',
      guardLevel: null,
      matchedWarnings: [],
      actions: [],
      checkSyncState: 'not_applicable',
    });

    await expect(
      automation.service.runDue(new Date('2026-08-08T01:00:00.000Z')),
    ).resolves.toMatchObject({
      status: 'resolved',
      sentCount: 1,
      failedCount: 1,
    });
    const pendingAfterFailure = Object.values(
      readWeatherWarningAutomationStateFile({ explicitPath: statePath })
        .pendingResolvedEvents,
    );
    expect(pendingAfterFailure).toHaveLength(1);
    expect(pendingAfterFailure[0]).toMatchObject({
      closedAt: '2026-08-08T01:00:00.000Z',
      highestGuardLevel: '三级戒备',
    });
    automation.notificationService.sendAutomationCard.mockClear();

    await expect(
      automation.service.runDue(new Date('2026-08-08T01:10:00.000Z')),
    ).resolves.toMatchObject({
      status: 'resolved',
      sentCount: 1,
      failedCount: 0,
    });
    expect(
      automation.notificationService.sendAutomationCard.mock.calls.map(
        ([request]) => request.target.key,
      ),
    ).toEqual(['owner']);
    const stateAfterRetry = readWeatherWarningAutomationStateFile({
      explicitPath: statePath,
    });
    expect(stateAfterRetry.activeEvent).toBeNull();
    expect(stateAfterRetry.pendingResolvedEvents).toEqual({});
  });

  it('resolves only targets that successfully received an alert', async () => {
    enableAutomation({ trackingEnabled: false });
    const automation = createService(ACTIVE_SNAPSHOT, {
      failOnceForTargetKey: 'owner',
      failOnceForDeliveryPrefix: 'auto:initial:',
    });

    await expect(
      automation.service.runDue(new Date('2026-08-08T00:00:00.000Z')),
    ).resolves.toMatchObject({ sentCount: 1, failedCount: 1 });
    automation.notificationService.sendAutomationCard.mockClear();
    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      status: 'clear',
      sourceState: 'fresh',
      guardDecisionState: 'fresh',
      snapshotAt: '2026-08-08T01:00:00.000Z',
      guardLevel: null,
      matchedWarnings: [],
      actions: [],
      checkSyncState: 'not_applicable',
    });

    await expect(
      automation.service.runDue(new Date('2026-08-08T01:00:00.000Z')),
    ).resolves.toMatchObject({
      status: 'resolved',
      sentCount: 1,
      failedCount: 0,
    });
    expect(
      automation.notificationService.sendAutomationCard.mock.calls.map(
        ([request]) => request.target.key,
      ),
    ).toEqual(['chat-1']);
  });

  it('retries an older resolved event while opening a new warning event', async () => {
    enableAutomation({ trackingEnabled: false });
    const automation = createService(ACTIVE_SNAPSHOT, {
      failOnceForTargetKey: 'owner',
      failOnceForDeliveryPrefix: 'auto:resolved:',
    });
    const firstRun = await automation.service.runDue(
      new Date('2026-08-08T00:00:00.000Z'),
    );
    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      status: 'clear',
      sourceState: 'fresh',
      guardDecisionState: 'fresh',
      snapshotAt: '2026-08-08T01:00:00.000Z',
      guardLevel: null,
      matchedWarnings: [],
      actions: [],
      checkSyncState: 'not_applicable',
    });
    await automation.service.runDue(new Date('2026-08-08T01:00:00.000Z'));

    automation.notificationService.sendAutomationCard.mockClear();
    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      snapshotAt: '2026-08-08T01:10:00.000Z',
      matchedWarnings: [
        {
          ...ACTIVE_SNAPSHOT.matchedWarnings[0],
          id: 'rain-yellow-20260808',
          title: '南通市气象台发布暴雨黄色预警',
          type: '暴雨',
          color: 'yellow',
        },
      ],
    });

    const nextRun = await automation.service.runDue(
      new Date('2026-08-08T01:10:00.000Z'),
    );
    expect(nextRun).toMatchObject({
      status: 'processed',
      sentCount: 3,
      failedCount: 0,
    });
    expect(nextRun.eventHash).not.toBe(firstRun.eventHash);
    const requests =
      automation.notificationService.sendAutomationCard.mock.calls.map(
        ([request]) => request,
      );
    expect(
      requests
        .filter(({ deliveryKey }) => deliveryKey.startsWith('auto:resolved:'))
        .map(({ target }) => target.key),
    ).toEqual(['owner']);
    expect(
      requests
        .filter(({ deliveryKey }) => deliveryKey.startsWith('auto:initial:'))
        .map(({ target }) => target.key),
    ).toEqual(['chat-1', 'owner']);
    const state = readWeatherWarningAutomationStateFile({
      explicitPath: statePath,
    });
    expect(state.pendingResolvedEvents).toEqual({});
    expect(state.activeEvent?.eventHash).toBe(nextRun.eventHash);
  });

  it('does not close or send a resolved card from a stale empty snapshot', async () => {
    enableAutomation();
    const automation = createService();

    const firstRun = await automation.service.runDue(
      new Date('2026-08-08T00:00:00.000Z'),
    );
    automation.notificationService.sendAutomationCard.mockClear();
    automation.snapshotService.getSnapshot.mockResolvedValue({
      ...ACTIVE_SNAPSHOT,
      status: 'stale',
      sourceState: 'stale',
      guardDecisionState: 'stale',
      snapshotAt: '2026-08-08T01:00:00.000Z',
      guardLevel: null,
      matchedWarnings: [],
      actions: [],
      checkSyncState: 'not_applicable',
    });

    await expect(
      automation.service.runDue(new Date('2026-08-08T01:00:00.000Z')),
    ).resolves.toMatchObject({
      status: 'no-active-warning',
      sentCount: 0,
      failedCount: 0,
    });
    expect(
      automation.notificationService.sendAutomationCard,
    ).not.toHaveBeenCalled();
    expect(
      readWeatherWarningAutomationStateFile({ explicitPath: statePath })
        .activeEvent,
    ).toMatchObject({ eventHash: firstRun.eventHash });
  });

  it('skips due reminders explicitly when building progress is unavailable', async () => {
    enableAutomation();
    const automation = createService(ACTIVE_SNAPSHOT, {
      progressResult: () => ({
        summary: ACTIVE_SNAPSHOT.checkSummary,
        buildingProgress: {
          available: false,
          buildings: [],
          missingRegistrationBuildings: [],
          unassignedRecordCount: 0,
          incompleteItems: [],
        },
      }),
    });

    await expect(
      automation.service.runDue(new Date('2026-08-08T00:00:00.000Z')),
    ).resolves.toMatchObject({ sentCount: 2, failedCount: 0 });
    automation.notificationService.sendAutomationCard.mockClear();

    await expect(
      automation.service.runDue(new Date('2026-08-08T06:00:00.000Z')),
    ).resolves.toMatchObject({
      status: 'processed',
      sentCount: 0,
      reminderSkippedReason: 'building-progress-unavailable',
    });
    expect(
      automation.notificationService.sendAutomationCard,
    ).not.toHaveBeenCalled();
  });

  it('sends initial alerts with unavailable progress when progress reading fails', async () => {
    enableAutomation();
    const automation = createService(ACTIVE_SNAPSHOT, {
      progressError: new Error('simulated progress outage'),
    });

    await expect(
      automation.service.runDue(new Date('2026-08-08T00:00:00.000Z')),
    ).resolves.toMatchObject({
      status: 'processed',
      sentCount: 2,
      failedCount: 0,
    });
    expect(automation.bitableService.getCheckProgress).toHaveBeenCalledTimes(1);
    expect(
      automation.notificationService.sendAutomationCard,
    ).toHaveBeenCalledTimes(2);
    for (const [request] of automation.notificationService.sendAutomationCard
      .mock.calls) {
      expect(request.deliveryKey).toMatch(/^auto:initial:/u);
      expect(JSON.stringify(request.card)).toContain('楼栋进度暂不可用');
    }
  });

  it('skips a due reminder when progress reading still fails after initial alerts', async () => {
    enableAutomation();
    const automation = createService(ACTIVE_SNAPSHOT, {
      progressError: new Error('simulated progress outage'),
    });

    await expect(
      automation.service.runDue(new Date('2026-08-08T00:00:00.000Z')),
    ).resolves.toMatchObject({
      status: 'processed',
      sentCount: 2,
      failedCount: 0,
    });
    automation.notificationService.sendAutomationCard.mockClear();

    await expect(
      automation.service.runDue(new Date('2026-08-08T06:00:00.000Z')),
    ).resolves.toMatchObject({
      status: 'processed',
      sentCount: 0,
      failedCount: 0,
      reminderSkippedReason: 'building-progress-unavailable',
    });
    expect(automation.bitableService.getCheckProgress).toHaveBeenCalledTimes(2);
    expect(
      automation.notificationService.sendAutomationCard,
    ).not.toHaveBeenCalled();
    expect(
      Object.keys(
        readWeatherWarningAutomationStateFile({ explicitPath: statePath })
          .entries,
      ).filter((key) => key.startsWith('auto:reminder:')),
    ).toEqual([]);
  });

  it('returns busy without reading a snapshot while another process holds the lease', async () => {
    enableAutomation();
    const lease = acquireWeatherWarningAutomationLease({
      explicitPath: statePath,
      now: new Date('2026-08-08T00:00:00.000Z'),
    });
    expect(lease).not.toBeNull();
    const automation = createService();

    try {
      await expect(
        automation.service.runDue(new Date('2026-08-08T00:00:00.000Z')),
      ).resolves.toEqual({ status: 'busy', sentCount: 0, failedCount: 0 });
      expect(automation.snapshotService.getSnapshot).not.toHaveBeenCalled();
    } finally {
      lease?.release();
    }
  });
});

function createService(
  snapshot: WeatherWarningSnapshot = ACTIVE_SNAPSHOT,
  options: {
    failOnceForTargetKey?: string;
    failOnceForDeliveryPrefix?: string;
    sentAt?: () => string;
    progressError?: Error;
    progressResult?: () => {
      summary: WeatherWarningSnapshot['checkSummary'];
      buildingProgress: NonNullable<WeatherWarningSnapshot['buildingProgress']>;
    };
  } = {},
) {
  const snapshotService = {
    getSnapshot: jest.fn().mockResolvedValue(snapshot),
  };
  let messageIndex = 0;
  let failedOnce = false;
  const notificationService = {
    sendAutomationCard: jest.fn(
      async (request: {
        deliveryKey: string;
        target: { key: string };
        card: Record<string, unknown>;
      }) => {
        if (
          !failedOnce &&
          options.failOnceForTargetKey === request.target.key &&
          (!options.failOnceForDeliveryPrefix ||
            request.deliveryKey.startsWith(options.failOnceForDeliveryPrefix))
        ) {
          failedOnce = true;
          throw new Error('simulated delivery failure');
        }
        messageIndex += 1;
        return {
          messageId: `om_weather_automation_${messageIndex}`,
          sentAt: options.sentAt?.() || '2026-08-08T00:00:00.000Z',
          uuid: request.deliveryKey.padEnd(32, '0').slice(0, 32),
        };
      },
    ),
  };
  const bitableService = {
    getCheckProgress: jest.fn(async () => {
      if (options.progressError) throw options.progressError;
      return (
        options.progressResult?.() ?? {
          summary: snapshot.checkSummary,
          buildingProgress: snapshot.buildingProgress ?? {
            available: false,
            buildings: [],
            missingRegistrationBuildings: [],
            unassignedRecordCount: 0,
            incompleteItems: [],
          },
        }
      );
    }),
  };
  return {
    service: new WeatherWarningAutomationService(
      snapshotService as never,
      notificationService as never,
      bitableService as never,
    ),
    snapshotService,
    notificationService,
    bitableService,
  };
}

function enableAutomation(
  options: {
    importantEventChatIds?: string;
    trackingEnabled?: boolean;
  } = {},
): void {
  process.env.FEISHU_WEATHER_WARNING_AUTOMATION_ENABLED = 'true';
  process.env.FEISHU_WEATHER_WARNING_CHAT_IDS = 'oc_weather_warning_group';
  process.env.FEISHU_WEATHER_WARNING_IMPORTANT_EVENT_CHAT_IDS =
    options.importantEventChatIds || 'oc_important_event_group';
  process.env.FEISHU_WEATHER_WARNING_OWNER_OPEN_ID = 'ou_ma_jinyu';
  process.env.FEISHU_WEATHER_WARNING_OWNER_NAME = '马进宇';
  if (options.trackingEnabled === false) {
    delete process.env.WEATHER_WARNING_REGISTRATION_ENABLED;
    delete process.env.FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED;
  } else {
    process.env.WEATHER_WARNING_REGISTRATION_ENABLED = 'true';
    process.env.FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED = 'true';
  }
}

function captureAutomationEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(
    AUTOMATION_ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]),
  );
}

function restoreAutomationEnvironment(
  values: Record<string, string | undefined>,
): void {
  for (const name of AUTOMATION_ENVIRONMENT_NAMES) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function expectCardRegistrationUrl(
  card: Record<string, unknown>,
  warningId: string,
): void {
  const expectedUrl = `${PUBLIC_BASE_URL.replace(/\/+$/u, '')}${CLIENT_BASE_PATH.replace(
    /\/+$/u,
    '',
  )}/monthly-schedule?weatherGuardRegistration=1&warningId=${encodeURIComponent(
    warningId,
  )}&source=feishu-card`;
  const serializedCard = JSON.stringify(card);
  expect(serializedCard).toContain(expectedUrl);
  expect(serializedCard).not.toContain(LEGACY_APPROVAL_URL);
}
