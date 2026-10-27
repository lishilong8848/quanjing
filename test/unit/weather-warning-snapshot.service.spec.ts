import { ServiceUnavailableException } from '@nestjs/common';
import type {
  WeatherWarningCheckSummary,
  WeatherWarningTestPreviewResponse,
} from '../../shared/api.interface';
import type {
  QWeatherWarningResponse,
  QWeatherWarningItem,
} from '../../server/modules/bitable-sync/bitable-sync.service';
import type { WeatherWarningFetchResult } from '../../server/modules/weather-warning/weather-warning-source-status';
import type { WeatherWarningRule } from '../../server/modules/weather-warning/weather-warning-rules';
import { WeatherWarningSnapshotService } from '../../server/modules/weather-warning/weather-warning-snapshot.service';

const NOW_MS = Date.parse('2026-08-04T00:00:00.000Z');

const LEVEL_THREE_RULES: WeatherWarningRule[] = [
  {
    warningType: '高温',
    warningColor: 'orange',
    guardLevel: '三级戒备',
  },
];

const LEVEL_THREE_REQUIRED_CHECK_KEYS = [
  'device',
  'disaster',
  'materials',
  'contacts',
  'managerConfirmation',
] as const;

const LEVEL_ONE_REQUIRED_CHECK_KEYS = [
  'device',
  'environment',
  'disaster',
  'materials',
  'contacts',
  'managerConfirmation',
] as const;

const CHECK_SUMMARY: WeatherWarningCheckSummary = {
  device: 'completed',
  environment: 'pending',
  disaster: 'completed',
  materials: 'completed',
  contacts: 'completed',
  managerConfirmation: 'pending',
  abnormalSummaries: [],
};

const BUILDING_PROGRESS = {
  available: true,
  buildings: [
    {
      building: 'A楼',
      recordAt: '2026-08-04T00:30:00.000Z',
      checks: {
        device: 'completed',
        environment: 'pending',
        disaster: 'completed',
        materials: 'completed',
        contacts: 'completed',
        managerConfirmation: 'pending',
      },
      abnormalSummaries: [],
    },
  ],
  missingRegistrationBuildings: ['B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'],
  unassignedRecordCount: 0,
  incompleteItems: [
    {
      building: 'A楼',
      key: 'environment',
      label: '环境安全',
      state: 'pending',
    },
  ],
} as const;

const GUARD_COMPLETION = {
  state: 'incomplete',
  completedBuildingCount: 1,
  totalBuildingCount: 7,
} as const;

function weatherWarning(
  overrides: Partial<QWeatherWarningItem> = {},
): QWeatherWarningItem {
  return {
    id: 'high-temp-orange',
    title: '南通市气象台发布高温橙色预警',
    type: '高温',
    level: '橙色',
    status: '发布',
    pubTime: '2026-08-04T00:00:00.000Z',
    ...overrides,
  };
}

function warningFetchResult(
  overrides: Partial<WeatherWarningFetchResult<QWeatherWarningResponse>> = {},
): WeatherWarningFetchResult<QWeatherWarningResponse> {
  return {
    state: 'fresh',
    data: {
      code: '200',
      warning: [weatherWarning()],
    },
    fetchedAt: '2026-08-04T00:00:00.000Z',
    lastSuccessAt: '2026-08-04T00:00:00.000Z',
    warningCount: 1,
    isStale: false,
    ...overrides,
  };
}

function weatherNowResponse() {
  return {
    code: '200',
    updateTime: '2026-08-04T00:00:00.000Z',
    now: {
      temp: '34',
      feelsLike: '36',
      humidity: '75',
      windScale: '3',
    },
  };
}

function createService(
  options: {
    warningResult?: WeatherWarningFetchResult<QWeatherWarningResponse>;
    weatherNow?: unknown;
    weatherNowError?: Error;
    rules?: WeatherWarningRule[];
    rulesError?: Error;
    checkSummary?: WeatherWarningCheckSummary;
    checkSummaryError?: Error;
    buildingProgress?: typeof BUILDING_PROGRESS;
    guardCompletion?: {
      state: 'completed' | 'incomplete' | 'unavailable' | 'not_applicable';
      completedBuildingCount: number;
      totalBuildingCount: number;
    };
    testRecipient?: { openId: string; displayName: string } | null;
  } = {},
) {
  const weatherService = {
    getWeatherWarningFetchResult: jest
      .fn()
      .mockResolvedValue(options.warningResult ?? warningFetchResult()),
    getWeatherNow: jest.fn(),
  };
  if (options.weatherNowError) {
    weatherService.getWeatherNow.mockRejectedValue(options.weatherNowError);
  } else {
    weatherService.getWeatherNow.mockResolvedValue(
      options.weatherNow ?? weatherNowResponse(),
    );
  }

  const bitableService = {
    getRules: jest.fn().mockResolvedValue(options.rules ?? LEVEL_THREE_RULES),
    getCheckProgress: jest.fn().mockResolvedValue({
      summary: options.checkSummary ?? CHECK_SUMMARY,
      buildingProgress: options.buildingProgress ?? BUILDING_PROGRESS,
      guardCompletion: options.guardCompletion ?? GUARD_COMPLETION,
    }),
    getRuntimeConfig: jest.fn().mockReturnValue({
      testRecipient:
        options.testRecipient === undefined
          ? { openId: 'ou_weather_test', displayName: '马进宇' }
          : options.testRecipient,
    }),
  };
  if (options.rulesError) {
    bitableService.getRules.mockRejectedValue(options.rulesError);
  }
  if (options.checkSummaryError) {
    bitableService.getCheckProgress.mockRejectedValue(
      options.checkSummaryError,
    );
  }

  return {
    service: new WeatherWarningSnapshotService(
      weatherService as never,
      bitableService as never,
    ),
    weatherService,
    bitableService,
  };
}

describe('WeatherWarningSnapshotService', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('maps a high-temperature orange warning to level three with the exact check tag and pending checks', async () => {
    const { service, weatherService, bitableService } = createService();

    const snapshot = await service.getSnapshot({ forceRefresh: true });

    expect(snapshot).toMatchObject({
      status: 'active',
      sourceState: 'fresh',
      guardDecisionState: 'fresh',
      checkSyncState: 'fresh',
      guardLevel: '三级戒备',
      matchedWarnings: [
        {
          id: 'high-temp-orange',
          type: '高温',
          color: 'orange',
          guardLevel: '三级戒备',
        },
      ],
      unmatchedWarnings: [],
      weather: {
        temperature: '34',
        feelsLike: '36',
        humidity: '75',
        windScale: '3',
        observedAt: '2026-08-04T00:00:00.000Z',
      },
      checkSummary: CHECK_SUMMARY,
      buildingProgress: BUILDING_PROGRESS,
      guardCompletion: GUARD_COMPLETION,
      requiredCheckKeys: LEVEL_THREE_REQUIRED_CHECK_KEYS,
      canSendTest: true,
    });
    expect(snapshot.actions).toHaveLength(5);
    expect(snapshot.actions[0]).toContain('7*24 On call');
    expect(weatherService.getWeatherWarningFetchResult).toHaveBeenCalledWith(
      true,
    );
    expect(bitableService.getRules).toHaveBeenCalledWith(true);
    expect(bitableService.getCheckProgress).toHaveBeenCalledWith(
      '三级戒备',
      '高温橙色',
      '2026-08-04T00:00:00.000Z',
      LEVEL_THREE_REQUIRED_CHECK_KEYS,
      true,
    );
    expect(JSON.stringify(snapshot)).not.toContain('ou_weather_test');
  });

  it('skips guard progress reads for the external query snapshot', async () => {
    const { service, bitableService } = createService();

    const snapshot = await service.getSnapshot({
      includeCheckProgress: false,
    });

    expect(snapshot).toMatchObject({
      status: 'active',
      sourceState: 'fresh',
      guardDecisionState: 'fresh',
      checkSyncState: 'not_applicable',
      guardLevel: '三级戒备',
    });
    expect(snapshot).not.toHaveProperty('buildingProgress');
    expect(snapshot).not.toHaveProperty('guardCompletion');
    expect(bitableService.getCheckProgress).not.toHaveBeenCalled();
  });

  it('refreshes warning data without forcing a rules-table refresh', async () => {
    const { service, weatherService, bitableService } = createService();

    await service.getSnapshot({
      forceRefresh: true,
      forceRuleRefresh: false,
      includeCheckProgress: false,
    });

    expect(weatherService.getWeatherWarningFetchResult).toHaveBeenCalledWith(
      true,
    );
    expect(bitableService.getRules).toHaveBeenCalledWith(false);
    expect(bitableService.getCheckProgress).not.toHaveBeenCalled();
  });

  it('uses the warning publication time instead of a future activation start time for the event window', async () => {
    const { service, bitableService } = createService({
      warningResult: warningFetchResult({
        data: {
          code: '200',
          warning: [
            weatherWarning({
              pubTime: '2026-08-03T23:40:00.000Z',
              startTime: '2026-08-04T08:00:00.000Z',
            }),
          ],
        },
        fetchedAt: '2026-08-04T00:00:00.000Z',
        lastSuccessAt: '2026-08-04T00:00:00.000Z',
      }),
    });

    await service.getSnapshot();

    expect(bitableService.getCheckProgress).toHaveBeenCalledWith(
      '三级戒备',
      '高温橙色',
      '2026-08-03T23:40:00.000Z',
      LEVEL_THREE_REQUIRED_CHECK_KEYS,
      false,
    );
  });

  it('keeps the first in-process detection time when publication time is unavailable', async () => {
    const firstResult = warningFetchResult({
      data: {
        code: '200',
        warning: [weatherWarning({ pubTime: undefined })],
      },
      fetchedAt: '2026-08-04T00:05:00.000Z',
      lastSuccessAt: '2026-08-04T00:05:00.000Z',
    });
    const secondResult = warningFetchResult({
      data: firstResult.data,
      fetchedAt: '2026-08-04T00:15:00.000Z',
      lastSuccessAt: '2026-08-04T00:15:00.000Z',
    });
    const { service, weatherService, bitableService } = createService({
      warningResult: firstResult,
    });
    weatherService.getWeatherWarningFetchResult
      .mockResolvedValueOnce(firstResult)
      .mockResolvedValueOnce(secondResult);

    await service.getSnapshot();
    await service.getSnapshot();

    expect(bitableService.getCheckProgress).toHaveBeenNthCalledWith(
      1,
      '三级戒备',
      '高温橙色',
      '2026-08-04T00:05:00.000Z',
      LEVEL_THREE_REQUIRED_CHECK_KEYS,
      false,
    );
    expect(bitableService.getCheckProgress).toHaveBeenNthCalledWith(
      2,
      '三级戒备',
      '高温橙色',
      '2026-08-04T00:05:00.000Z',
      LEVEL_THREE_REQUIRED_CHECK_KEYS,
      false,
    );
  });

  it('allows a persisted event-opened time to override derived publication and detection times', async () => {
    const { service, bitableService } = createService();

    await service.getSnapshot({
      eventOpenedAt: '2026-08-03T23:55:00.000Z',
    });

    expect(bitableService.getCheckProgress).toHaveBeenCalledWith(
      '三级戒备',
      '高温橙色',
      '2026-08-03T23:55:00.000Z',
      LEVEL_THREE_REQUIRED_CHECK_KEYS,
      false,
    );
  });

  it('keeps a fresh guard decision actionable when only check progress sync fails', async () => {
    const { service } = createService({
      checkSummaryError: new Error('check sync failed'),
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot).toMatchObject({
      status: 'active',
      sourceState: 'fresh',
      guardDecisionState: 'fresh',
      checkSyncState: 'unavailable',
      guardLevel: '三级戒备',
      buildingProgress: {
        available: false,
        buildings: [],
        missingRegistrationBuildings: [],
        unassignedRecordCount: 0,
        incompleteItems: [],
      },
      guardCompletion: {
        state: 'unavailable',
        completedBuildingCount: 0,
        totalBuildingCount: 7,
      },
      sourceError: '天气预警与戒备已判定，重保检查进度暂未同步',
      canSendTest: true,
    });
  });

  it('exposes a completed aggregate only when the Bitable progress is complete', async () => {
    const { service } = createService({
      guardCompletion: {
        state: 'completed',
        completedBuildingCount: 7,
        totalBuildingCount: 7,
      },
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.guardCompletion).toEqual({
      state: 'completed',
      completedBuildingCount: 7,
      totalBuildingCount: 7,
    });
  });

  it('keeps every matched warning with its own level while using the highest level for checks and actions', async () => {
    const { service, bitableService } = createService({
      warningResult: warningFetchResult({
        data: {
          code: '200',
          warning: [
            weatherWarning(),
            weatherWarning({
              id: 'typhoon-red',
              title: '南通市气象台发布台风红色预警',
              type: '台风',
              level: '红色',
            }),
          ],
        },
        warningCount: 2,
      }),
      rules: [
        ...LEVEL_THREE_RULES,
        {
          warningType: '台风',
          warningColor: 'red',
          guardLevel: '一级戒备',
        },
      ],
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.guardLevel).toBe('一级戒备');
    expect(
      snapshot.matchedWarnings.map(({ id, guardLevel }) => ({
        id,
        guardLevel,
      })),
    ).toEqual([
      { id: 'typhoon-red', guardLevel: '一级戒备' },
      { id: 'high-temp-orange', guardLevel: '三级戒备' },
    ]);
    expect(bitableService.getCheckProgress).toHaveBeenCalledWith(
      '一级戒备',
      '台风红色',
      '2026-08-04T00:00:00.000Z',
      LEVEL_ONE_REQUIRED_CHECK_KEYS,
      false,
    );
    expect(snapshot.actions[0]).toContain('Stand by');
  });

  it('keeps a valid warning decision when weather-now fails and redacts the upstream error', async () => {
    const { service } = createService({
      weatherNowError: new Error('token=weather-secret'),
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot).toMatchObject({
      status: 'active',
      sourceState: 'fresh',
      guardLevel: '三级戒备',
      weather: null,
      weatherSourceError: '天气实况数据暂不可用',
      canSendTest: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain('weather-secret');
  });

  it('treats a placeholder weather response as unavailable without clearing the warning', async () => {
    const { service } = createService({
      weatherNow: {
        code: '200',
        now: {
          temp: '--',
          feelsLike: '待更新',
          humidity: '--',
          windScale: '--',
        },
      },
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot).toMatchObject({
      status: 'active',
      guardLevel: '三级戒备',
      weather: null,
      weatherSourceError: '天气实况数据暂不可用',
    });
  });

  it('permits a test send from a bounded degraded fallback when its last successful warning is mapped', async () => {
    const { service } = createService({
      warningResult: warningFetchResult({
        state: 'degraded',
        lastSuccessAt: '2026-08-03T23:55:00.000Z',
        isStale: false,
      }),
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot).toMatchObject({
      status: 'degraded',
      sourceState: 'degraded',
      guardLevel: '三级戒备',
      canSendTest: true,
    });
  });

  it.each([
    [
      'stale',
      warningFetchResult({
        state: 'stale',
        lastSuccessAt: '2026-08-03T23:30:00.000Z',
        isStale: true,
      }),
      'stale',
    ],
    [
      'unavailable',
      warningFetchResult({
        state: 'unavailable',
        data: null,
        lastSuccessAt: undefined,
        warningCount: 0,
        isStale: false,
      }),
      'degraded',
    ],
  ] as const)(
    'never permits a test send from a %s warning source',
    async (_state, warningResult, expectedStatus) => {
      const { service } = createService({ warningResult });

      const snapshot = await service.getSnapshot();

      expect(snapshot).toMatchObject({
        status: expectedStatus,
        sourceState: warningResult.state,
        canSendTest: false,
      });
    },
  );

  it('returns a clear non-sendable snapshot without a matched active warning', async () => {
    const { service, bitableService } = createService({
      warningResult: warningFetchResult({
        data: { code: '200', warning: [] },
        warningCount: 0,
      }),
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot).toMatchObject({
      status: 'clear',
      guardLevel: null,
      matchedWarnings: [],
      unmatchedWarnings: [],
      actions: [],
      canSendTest: false,
      checkSummary: {
        device: 'not_started',
        managerConfirmation: 'not_started',
      },
    });
    expect(bitableService.getCheckProgress).not.toHaveBeenCalled();
  });

  it('does not permit a test send when the configured recipient is absent', async () => {
    const { service } = createService({ testRecipient: null });

    const snapshot = await service.getSnapshot();

    expect(snapshot).toMatchObject({
      status: 'active',
      guardLevel: '三级戒备',
      canSendTest: false,
    });
  });

  it('keeps a fresh unmatched warning whose type and color are absent while marking the snapshot clear', async () => {
    const { service, bitableService } = createService({
      warningResult: warningFetchResult({
        data: {
          code: '200',
          warning: [
            weatherWarning({
              id: 'missing-type-and-color',
              title: '未分类预警',
              type: undefined,
              typeName: undefined,
              level: undefined,
              severity: undefined,
              severityColor: undefined,
            }),
          ],
        },
      }),
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot).toMatchObject({
      status: 'clear',
      guardLevel: null,
      unmatchedWarnings: [
        {
          id: 'missing-type-and-color',
          title: '未分类预警',
          type: null,
          color: null,
          guardLevel: null,
        },
      ],
      actions: [],
      canSendTest: false,
    });
    expect(bitableService.getCheckProgress).not.toHaveBeenCalled();
  });

  it('keeps real warnings in a non-sendable degraded snapshot when the guard-rule Base is unavailable', async () => {
    const unavailable = new ServiceUnavailableException(
      'Weather warning Base unavailable: FEISHU_WEATHER_WARNING_RULE_TABLE_ID',
    );
    const { service, bitableService } = createService({
      rulesError: unavailable,
    });

    await expect(service.getSnapshot()).resolves.toMatchObject({
      status: 'degraded',
      sourceState: 'degraded',
      guardDecisionState: 'pending',
      checkSyncState: 'not_applicable',
      guardLevel: null,
      matchedWarnings: [],
      unmatchedWarnings: [
        {
          id: 'high-temp-orange',
          title: '南通市气象台发布高温橙色预警',
          type: '高温',
          color: 'orange',
          guardLevel: null,
        },
      ],
      actions: [],
      weather: {
        temperature: '34',
      },
      checkSummary: {
        device: 'not_started',
        environment: 'not_started',
        disaster: 'not_started',
        materials: 'not_started',
        contacts: 'not_started',
        managerConfirmation: 'not_started',
        abnormalSummaries: [],
      },
      sourceError: '天气预警已获取，重保规则暂未同步',
      canSendTest: false,
    });
    expect(bitableService.getCheckProgress).not.toHaveBeenCalled();
    expect(bitableService.getRuntimeConfig).not.toHaveBeenCalled();
  });

  it('treats an empty or fully invalid guard-rule table as pending sync', async () => {
    const { service, bitableService } = createService({ rules: [] });

    await expect(service.getSnapshot()).resolves.toMatchObject({
      status: 'degraded',
      sourceState: 'degraded',
      guardLevel: null,
      matchedWarnings: [],
      unmatchedWarnings: [{ id: 'high-temp-orange' }],
      sourceError: '天气预警已获取，重保规则暂未同步',
      canSendTest: false,
    });
    expect(bitableService.getCheckProgress).not.toHaveBeenCalled();
    expect(bitableService.getRuntimeConfig).not.toHaveBeenCalled();
  });

  it.each([
    [
      'stale warning data when rule sync fails',
      warningFetchResult({
        state: 'stale',
        lastSuccessAt: '2026-08-03T23:30:00.000Z',
        isStale: true,
      }),
      { rulesError: new Error('rule sync failed') },
      'stale',
      'stale',
      '天气预警与重保规则暂未完成同步',
    ],
    [
      'unavailable warning data when rule sync fails',
      warningFetchResult({
        state: 'unavailable',
        data: null,
        lastSuccessAt: undefined,
        warningCount: 0,
        isStale: false,
      }),
      { rulesError: new Error('rule sync failed') },
      'unavailable',
      'degraded',
      '天气预警与重保规则暂未完成同步',
    ],
    [
      'stale warning data when check sync fails',
      warningFetchResult({
        state: 'stale',
        lastSuccessAt: '2026-08-03T23:30:00.000Z',
        isStale: true,
      }),
      { checkSummaryError: new Error('check sync failed') },
      'stale',
      'stale',
      '天气预警数据源暂不可用',
    ],
  ] as const)(
    'preserves %s instead of downgrading it to ordinary degraded state',
    async (
      _caseName,
      warningResult,
      failure,
      expectedSourceState,
      expectedStatus,
      expectedSourceError,
    ) => {
      const { service } = createService({ warningResult, ...failure });

      const snapshot = await service.getSnapshot();

      expect(snapshot).toMatchObject({
        sourceState: expectedSourceState,
        status: expectedStatus,
        sourceError: expectedSourceError,
        canSendTest: false,
      });
    },
  );

  it('keeps the preview contract recipient-safe and sender-fixed to the system bot', () => {
    const preview: WeatherWarningTestPreviewResponse = {
      success: true,
      recipientName: '马进宇',
      senderName: '系统机器人',
      canSend: false,
      snapshot: {
        status: 'clear',
        sourceState: 'fresh',
        snapshotAt: '2026-08-04T00:00:00.000Z',
        guardLevel: null,
        matchedWarnings: [],
        unmatchedWarnings: [],
        actions: [],
        weather: null,
        checkSummary: {
          device: 'not_started',
          environment: 'not_started',
          disaster: 'not_started',
          materials: 'not_started',
          contacts: 'not_started',
          managerConfirmation: 'not_started',
          abnormalSummaries: [],
        },
        canSendTest: false,
      },
    };

    expect(Object.keys(preview)).not.toContain('openId');
    expect(preview.senderName).toBe('系统机器人');
  });
});
