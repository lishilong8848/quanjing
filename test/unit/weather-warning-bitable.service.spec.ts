jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
  resolveBitableAppToken: jest.fn(),
}));

import { ServiceUnavailableException } from '@nestjs/common';
import {
  fetchBitableRecords,
  resolveBitableAppToken,
} from '../../server/common/feishu/bitable-direct-read';
import { loadWeatherWarningRuntimeConfig } from '../../server/modules/weather-warning/weather-warning.config';
import { WeatherWarningBitableService } from '../../server/modules/weather-warning/weather-warning-bitable.service';

const ENV_KEYS = [
  'FEISHU_WEATHER_WARNING_SOURCE_URL',
  'FEISHU_WEATHER_WARNING_RULE_TABLE_ID',
  'FEISHU_WEATHER_WARNING_CHECK_TABLE_ID',
  'FEISHU_WEATHER_WARNING_RULE_TYPE_FIELD',
  'FEISHU_WEATHER_WARNING_RULE_COLOR_FIELD',
  'FEISHU_WEATHER_WARNING_RULE_GUARD_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_DATE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_BUILDING_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_GUARD_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_TAG_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_DEVICE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_DEVICE_EVIDENCE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_DEVICE_ISSUE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_ENVIRONMENT_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_ENVIRONMENT_EVIDENCE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_ENVIRONMENT_ISSUE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_DISASTER_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_DISASTER_EVIDENCE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_DISASTER_ISSUE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_MATERIALS_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_MATERIALS_ISSUE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_CONTACTS_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_CONTACTS_ISSUE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_MANAGER_CONFIRMATION_FIELD',
  'FEISHU_WEATHER_WARNING_TEST_OPEN_ID',
  'FEISHU_WEATHER_WARNING_TEST_RECIPIENT_NAME',
] as const;

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

function buildRuntimeEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    FEISHU_WEATHER_WARNING_SOURCE_URL:
      'https://vnet.feishu.cn/base/appWeatherWarning?table=tblRuleFallback',
    FEISHU_WEATHER_WARNING_CHECK_TABLE_ID: 'tblCheckSummary',
    FEISHU_WEATHER_WARNING_RULE_TYPE_FIELD: '预警类型',
    FEISHU_WEATHER_WARNING_RULE_COLOR_FIELD: '预警颜色',
    FEISHU_WEATHER_WARNING_RULE_GUARD_FIELD: '重保戒备等级',
    FEISHU_WEATHER_WARNING_CHECK_DATE_FIELD: '日期',
    FEISHU_WEATHER_WARNING_CHECK_BUILDING_FIELD: '楼栋',
    FEISHU_WEATHER_WARNING_CHECK_GUARD_FIELD: '重保戒备等级',
    FEISHU_WEATHER_WARNING_CHECK_TAG_FIELD: '重保标签',
    FEISHU_WEATHER_WARNING_CHECK_DEVICE_FIELD: '检查设备安全项',
    FEISHU_WEATHER_WARNING_CHECK_DEVICE_EVIDENCE_FIELD: '设备附件',
    FEISHU_WEATHER_WARNING_CHECK_DEVICE_ISSUE_FIELD: '设备异常描述',
    FEISHU_WEATHER_WARNING_CHECK_ENVIRONMENT_FIELD: '环境安全',
    FEISHU_WEATHER_WARNING_CHECK_ENVIRONMENT_EVIDENCE_FIELD: '环境附件',
    FEISHU_WEATHER_WARNING_CHECK_ENVIRONMENT_ISSUE_FIELD: '环境异常描述',
    FEISHU_WEATHER_WARNING_CHECK_DISASTER_FIELD: '灾害专项',
    FEISHU_WEATHER_WARNING_CHECK_DISASTER_EVIDENCE_FIELD: '灾害附件',
    FEISHU_WEATHER_WARNING_CHECK_DISASTER_ISSUE_FIELD: '灾害异常描述',
    FEISHU_WEATHER_WARNING_CHECK_MATERIALS_FIELD: '检查重保物资清单正常',
    FEISHU_WEATHER_WARNING_CHECK_MATERIALS_ISSUE_FIELD: '物资异常描述',
    FEISHU_WEATHER_WARNING_CHECK_CONTACTS_FIELD: '检查重保联络清单人员齐备',
    FEISHU_WEATHER_WARNING_CHECK_CONTACTS_ISSUE_FIELD: '联络异常描述',
    FEISHU_WEATHER_WARNING_CHECK_MANAGER_CONFIRMATION_FIELD: '机房经理确认',
    ...overrides,
  };
}

function applyRuntimeEnv(env: NodeJS.ProcessEnv): void {
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('weather warning runtime config and Bitable service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(resolveBitableAppToken).mockReset();
    jest.mocked(fetchBitableRecords).mockReset();
    applyRuntimeEnv(buildRuntimeEnv());
    jest.mocked(resolveBitableAppToken).mockResolvedValue('appResolved');
    jest.mocked(fetchBitableRecords).mockResolvedValue([]);
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses the source table as the rule-table fallback and exposes only a valid explicit test recipient', () => {
    const config = loadWeatherWarningRuntimeConfig(
      buildRuntimeEnv({
        FEISHU_WEATHER_WARNING_TEST_OPEN_ID: 'ou_weather_test',
        FEISHU_WEATHER_WARNING_TEST_RECIPIENT_NAME: '马进宇',
      }),
    );

    expect(config).toMatchObject({
      appToken: 'appWeatherWarning',
      wikiToken: '',
      ruleTableId: 'tblRuleFallback',
      checkTableId: 'tblCheckSummary',
      ruleFields: {
        type: '预警类型',
        color: '预警颜色',
        guard: '重保戒备等级',
      },
      testRecipient: { openId: 'ou_weather_test', displayName: '马进宇' },
    });

    expect(
      loadWeatherWarningRuntimeConfig(buildRuntimeEnv()).testRecipient,
    ).toBeNull();
  });

  it('uses the confirmed Nantong warning Base structure when deployment overrides are absent', () => {
    expect(loadWeatherWarningRuntimeConfig({})).toMatchObject({
      appToken: 'Tmn8bjGnpasbLTskafbcRijvnKe',
      wikiToken: '',
      ruleTableId: 'tbldeLoJJe6cPiHy',
      checkTableId: 'tblVFWuUbjo4GHOY',
      ruleFields: {
        type: '预警类型',
        color: '预警等级',
        guard: '重保类型',
      },
      checkFields: {
        date: '日期',
        building: '楼栋',
        guard: '重保戒备等级',
        tag: '重保标签',
        device: '检查设备安全项',
        deviceEvidence: '设备安全检查纸质图片',
        deviceIssue: '设备异常描述',
        environment: '检查环境安全项',
        environmentEvidence: '环境安全检查纸质图片',
        environmentIssue: '环境异常描述',
        disaster: '检查灾害专项',
        disasterEvidence: '灾害专项检查纸质图片',
        disasterIssue: '灾害异常描述',
        materials: '检查重保物资清单正常',
        materialsIssue: '重保物资异常描述',
        contacts: '检查重保联络清单人员齐备',
        contactsIssue: '联络清单异常描述',
        managerConfirmation: '机房经理确认',
      },
    });
  });

  it('fails closed with an invalid configured table variable name only', () => {
    expect(() =>
      loadWeatherWarningRuntimeConfig(
        buildRuntimeEnv({
          FEISHU_WEATHER_WARNING_CHECK_TABLE_ID: 'invalid-table',
        }),
      ),
    ).toThrow(ServiceUnavailableException);

    try {
      loadWeatherWarningRuntimeConfig(
        buildRuntimeEnv({
          FEISHU_WEATHER_WARNING_CHECK_TABLE_ID: 'invalid-table',
        }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as Error).message).toContain(
        'FEISHU_WEATHER_WARNING_CHECK_TABLE_ID',
      );
      expect((error as Error).message).not.toContain('appWeatherWarning');
    }
  });

  it('rejects a configured test recipient that is not an open_id', () => {
    expect(() =>
      loadWeatherWarningRuntimeConfig(
        buildRuntimeEnv({
          FEISHU_WEATHER_WARNING_TEST_OPEN_ID: 'user-not-an-open-id',
        }),
      ),
    ).toThrow(ServiceUnavailableException);
  });

  it('reads valid rules through the resolved app token with the ten-minute strict cache policy', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-rule-valid',
        fields: {
          预警类型: '高温',
          预警颜色: '橙色',
          重保戒备等级: '三级戒备',
        },
      },
      {
        record_id: 'rec-rule-invalid',
        fields: {
          预警类型: '高温',
          预警颜色: '未知颜色',
          重保戒备等级: '三级戒备',
        },
      },
    ]);
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    await expect(service.getRules(true)).resolves.toEqual([
      {
        warningType: '高温',
        warningColor: 'orange',
        guardLevel: '三级戒备',
      },
    ]);
    expect(resolveBitableAppToken).toHaveBeenCalledWith(expect.anything(), {
      appToken: 'appWeatherWarning',
      wikiToken: '',
      tableName: '南通天气预警',
    });
    expect(fetchBitableRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        appToken: 'appResolved',
        tableId: 'tblRuleFallback',
        cacheTtlMs: 10 * 60 * 1000,
        forceRefresh: true,
        allowStale: false,
        strict: true,
      }),
    );
  });

  it('reads rule mappings independently when check-table configuration is invalid', async () => {
    applyRuntimeEnv(
      buildRuntimeEnv({
        FEISHU_WEATHER_WARNING_CHECK_TABLE_ID: 'invalid-table',
        FEISHU_WEATHER_WARNING_RULE_COLOR_FIELD: '预警等级',
        FEISHU_WEATHER_WARNING_RULE_GUARD_FIELD: '重保类型',
      }),
    );
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-high-temperature-orange',
        fields: {
          预警类型: ['高温'],
          预警等级: ['橙色'],
          重保类型: ['三级戒备'],
        },
      },
      {
        record_id: 'rec-high-temperature-yellow',
        fields: {
          预警类型: ['高温'],
          预警等级: ['黄色'],
          重保类型: ['无匹配标签'],
        },
      },
    ]);
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    await expect(service.getRules()).resolves.toEqual([
      {
        warningType: '高温',
        warningColor: 'orange',
        guardLevel: '三级戒备',
      },
    ]);
    expect(fetchBitableRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tableId: 'tblRuleFallback',
        fieldNames: ['预警类型', '预警等级', '重保类型'],
      }),
    );
  });

  it('uses the newest exact guard-and-tag check record and maps blank or described checks safely', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-older',
        fields: {
          日期: '2026-08-04T08:00:00+08:00',
          重保戒备等级: '三级戒备',
          重保标签: '高温橙色',
          检查设备安全项: '异常',
          设备异常描述: '旧问题',
          环境安全: '正常',
          灾害专项: '正常',
          检查重保物资清单正常: '正常',
          检查重保联络清单人员齐备: '正常',
          机房经理确认: '已确认',
        },
      },
      {
        record_id: 'rec-newest',
        fields: {
          日期: '2026-08-04T10:00:00+08:00',
          重保戒备等级: ['三级戒备'],
          重保标签: ['高温橙色'],
          检查设备安全项: '正常',
          设备异常描述: '',
          环境安全: '',
          环境异常描述: '湿度偏高',
          灾害专项: '完成',
          灾害异常描述: '',
          检查重保物资清单正常: '已完成',
          物资异常描述: '',
          检查重保联络清单人员齐备: '正常',
          联络异常描述: '',
          机房经理确认: '',
        },
      },
      {
        record_id: 'rec-other-tag',
        fields: {
          日期: '2026-08-04T12:00:00+08:00',
          重保戒备等级: '三级戒备',
          重保标签: '暴雨红色',
          检查设备安全项: '异常',
          设备异常描述: '不得命中',
        },
      },
    ]);
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    await expect(
      service.getCheckSummary('三级戒备', '高温橙色', true),
    ).resolves.toEqual({
      device: 'completed',
      environment: 'abnormal',
      disaster: 'completed',
      materials: 'completed',
      contacts: 'completed',
      managerConfirmation: 'pending',
      abnormalSummaries: ['环境：湿度偏高'],
    });
    expect(fetchBitableRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tableId: 'tblCheckSummary',
        cacheTtlMs: 60 * 1000,
        forceRefresh: true,
        allowStale: false,
        strict: true,
      }),
    );
  });

  it('returns an explicit not-started check summary when no exact record exists', async () => {
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    await expect(
      service.getCheckSummary('一级戒备', '暴雨红色'),
    ).resolves.toEqual({
      device: 'not_started',
      environment: 'not_started',
      disaster: 'not_started',
      materials: 'not_started',
      contacts: 'not_started',
      managerConfirmation: 'not_started',
      abnormalSummaries: [],
    });
  });

  it('treats an empty selected check field without an issue description as pending', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-pending',
        fields: {
          日期: '2026-08-04T10:00:00+08:00',
          重保戒备等级: '三级戒备',
          重保标签: '高温橙色',
          检查设备安全项: '',
          设备异常描述: '',
          环境安全: '正常',
          灾害专项: '正常',
          检查重保物资清单正常: '正常',
          检查重保联络清单人员齐备: '正常',
          机房经理确认: '已确认',
        },
      },
    ]);
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    await expect(
      service.getCheckSummary('三级戒备', '高温橙色'),
    ).resolves.toMatchObject({ device: 'pending' });
  });

  it('does not mistake a non-normal status for a completed check', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-non-normal',
        fields: {
          日期: '2026-08-04T10:00:00+08:00',
          重保戒备等级: '三级戒备',
          重保标签: '高温橙色',
          检查设备安全项: '不正常',
          设备异常描述: '',
        },
      },
    ]);
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    await expect(
      service.getCheckSummary('三级戒备', '高温橙色'),
    ).resolves.toMatchObject({
      device: 'abnormal',
      abnormalSummaries: ['设备：不正常'],
    });
  });

  it('redacts rule-table fetch failures as a safe service-unavailable error', async () => {
    jest
      .mocked(fetchBitableRecords)
      .mockRejectedValue(new Error('token=secret-token ou_sensitive'));
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    await expect(service.getRules()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await service.getRules().catch((error: Error) => {
      expect(error.message).toContain('Weather warning Base unavailable:');
      expect(error.message).toContain('FEISHU_WEATHER_WARNING_RULE_TABLE_ID');
      expect(error.message).not.toContain('secret-token');
      expect(error.message).not.toContain('ou_sensitive');
    });
  });

  it('redacts app-token resolution failures before reading the check table', async () => {
    jest
      .mocked(resolveBitableAppToken)
      .mockRejectedValue(new Error('FEISHU_APP_SECRET=unsafe-value'));
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    await expect(
      service.getCheckSummary('三级戒备', '高温橙色'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await service
      .getCheckSummary('三级戒备', '高温橙色')
      .catch((error: Error) => {
        expect(error.message).toContain('Weather warning Base unavailable:');
        expect(error.message).toContain('FEISHU_WEATHER_WARNING_SOURCE_URL');
        expect(error.message).not.toContain('unsafe-value');
      });
  });

  it('reads Bitable wrappers and boolean check values while skipping malformed records', async () => {
    jest
      .mocked(fetchBitableRecords)
      .mockResolvedValueOnce([
        null as never,
        {
          record_id: 'rec-wrapped-rule',
          fields: {
            预警类型: { title: '高温' },
            预警颜色: { select: { label: '橙色' } },
            重保戒备等级: { value: '三级戒备' },
          },
        },
      ])
      .mockResolvedValueOnce([
        null as never,
        {
          record_id: 'rec-wrapped-check',
          fields: {
            日期: { timestamp: '1786135200000' },
            重保戒备等级: { select: { name: '三级戒备' } },
            重保标签: { label: '高温橙色' },
            检查设备安全项: { value: true },
            环境安全: { value: false },
            灾害专项: { text: '正常' },
            检查重保物资清单正常: { name: '完成' },
            检查重保联络清单人员齐备: { label: '齐备' },
            机房经理确认: { users: [{ title: '已确认' }] },
          },
        },
      ]);
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    await expect(service.getRules()).resolves.toEqual([
      {
        warningType: '高温',
        warningColor: 'orange',
        guardLevel: '三级戒备',
      },
    ]);
    await expect(
      service.getCheckSummary('三级戒备', '高温橙色'),
    ).resolves.toEqual({
      device: 'completed',
      environment: 'abnormal',
      disaster: 'completed',
      materials: 'completed',
      contacts: 'completed',
      managerConfirmation: 'completed',
      abnormalSummaries: ['环境：false'],
    });
  });

  it('selects a valid UTC date record while rejecting invalid and timezone-less date-times', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-invalid-calendar-date',
        fields: {
          日期: '2026-02-30T10:00:00+08:00',
          重保戒备等级: '三级戒备',
          重保标签: '高温橙色',
          检查设备安全项: '异常',
        },
      },
      {
        record_id: 'rec-timezone-less',
        fields: {
          日期: '2026-08-05T10:00:00',
          重保戒备等级: '三级戒备',
          重保标签: '高温橙色',
          检查设备安全项: '异常',
        },
      },
      {
        record_id: 'rec-valid-utc-date',
        fields: {
          日期: '2026-08-04',
          重保戒备等级: '三级戒备',
          重保标签: '高温橙色',
          检查设备安全项: '正常',
        },
      },
    ]);
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    await expect(
      service.getCheckSummary('三级戒备', '高温橙色'),
    ).resolves.toMatchObject({
      device: 'completed',
      abnormalSummaries: [],
    });
  });

  it('uses only the newest record for each building inside the opened event window', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-a-before-event',
        fields: {
          日期: '2026-08-07T23:59:59+08:00',
          楼栋: 'A楼',
          重保戒备等级: '三级戒备',
          重保标签: '台风蓝色',
          检查设备安全项: '异常',
        },
      },
      {
        record_id: 'rec-a-older',
        fields: {
          日期: '2026-08-08T07:30:00+08:00',
          楼栋: 'A楼',
          重保戒备等级: '三级戒备',
          重保标签: '台风蓝色',
          检查设备安全项: '异常',
        },
      },
      {
        record_id: 'rec-a-newest',
        fields: {
          日期: '2026-08-08T08:00:00+08:00',
          楼栋: 'A楼',
          重保戒备等级: '三级戒备',
          重保标签: '台风蓝色',
          检查设备安全项: '正常',
          设备附件: [{ file_token: 'rec-a-newest-device' }],
          环境安全: '正常',
          灾害专项: '正常',
          灾害附件: [{ file_token: 'rec-a-newest-disaster' }],
          检查重保物资清单正常: '正常',
          检查重保联络清单人员齐备: '正常',
          机房经理确认: '已确认',
        },
      },
    ]);
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    await expect(
      callGetCheckProgress(
        service,
        '三级戒备',
        '台风蓝色',
        '2026-08-08T07:01:00+08:00',
      ),
    ).resolves.toMatchObject({
      summary: { device: 'completed' },
      buildingProgress: {
        available: true,
        buildings: [
          {
            building: 'A楼',
            recordAt: '2026-08-08T00:00:00.000Z',
            checks: { device: 'completed' },
          },
        ],
      },
    });
  });

  it('includes a date-only registration from the same Asia/Shanghai day while excluding the previous local day', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'rec-previous-local-day',
        fields: {
          日期: '2026-08-07',
          楼栋: 'B楼',
          重保戒备等级: '三级戒备',
          重保标签: '台风蓝色',
          检查设备安全项: '正常',
        },
      },
      {
        record_id: 'rec-same-local-day',
        fields: {
          日期: '2026-08-08',
          楼栋: 'A楼',
          重保戒备等级: '三级戒备',
          重保标签: '台风蓝色',
          检查设备安全项: '正常',
        },
      },
    ]);
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    const result = await callGetCheckProgress(
      service,
      '三级戒备',
      '台风蓝色',
      '2026-08-08T23:30:00+08:00',
    );

    expect(result.buildingProgress.buildings).toEqual([
      expect.objectContaining({
        building: 'A楼',
        recordAt: '2026-08-07T16:00:00.000Z',
      }),
    ]);
    expect(result.buildingProgress.missingRegistrationBuildings).toContain(
      'B楼',
    );
  });

  it('creates one registration reminder per expected building without a record', async () => {
    jest
      .mocked(fetchBitableRecords)
      .mockResolvedValue([completedBuildingRecord('rec-a', 'A楼')]);
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    const result = await callGetCheckProgress(
      service,
      '三级戒备',
      '台风蓝色',
      '2026-08-08T07:01:00+08:00',
    );

    expect(result.buildingProgress.missingRegistrationBuildings).toEqual([
      'B楼',
      'C楼',
      'D楼',
      'E楼',
      'H楼',
      '110站',
    ]);
    expect(result.buildingProgress.incompleteItems).toEqual(
      result.buildingProgress.missingRegistrationBuildings.map((building) => ({
        building,
        key: 'registration',
        label: '未提交戒备登记',
        state: 'missing_registration',
      })),
    );
  });

  it('keeps the guard incomplete when a completed check is missing required evidence', async () => {
    const aBuilding = completedBuildingRecord('rec-a', 'A楼');
    delete aBuilding.fields.设备附件;
    jest
      .mocked(fetchBitableRecords)
      .mockResolvedValue([
        aBuilding,
        ...['B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'].map((building, index) =>
          completedBuildingRecord(`rec-${index + 1}`, building),
        ),
      ]);
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    const result = await callGetCheckProgress(
      service,
      '三级戒备',
      '台风蓝色',
      '2026-08-08T07:01:00+08:00',
    );

    expect(result.guardCompletion).toEqual({
      state: 'incomplete',
      completedBuildingCount: 6,
      totalBuildingCount: 7,
    });
    expect(
      result.buildingProgress.buildings.find(
        ({ building }) => building === 'A楼',
      )?.checks.device,
    ).toBe('pending');
    expect(result.buildingProgress.incompleteItems).toContainEqual({
      building: 'A楼',
      key: 'device',
      label: '设备安全',
      state: 'pending',
      detail: '缺少检查附件',
    });
  });

  it('marks the guard complete only after every building has required evidence and confirmation', async () => {
    jest
      .mocked(fetchBitableRecords)
      .mockResolvedValue(
        ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'].map(
          (building, index) =>
            completedBuildingRecord(`rec-${index + 1}`, building),
        ),
      );
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    const result = await callGetCheckProgress(
      service,
      '三级戒备',
      '台风蓝色',
      '2026-08-08T07:01:00+08:00',
    );

    expect(result.guardCompletion).toEqual({
      state: 'completed',
      completedBuildingCount: 7,
      totalBuildingCount: 7,
    });
    expect(result.buildingProgress.incompleteItems).toEqual([]);
  });

  it('requires environment evidence only when environment is in the check matrix', async () => {
    const records = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'].map(
      (building, index) => {
        const record = completedBuildingRecord(`rec-${index + 1}`, building);
        delete record.fields.环境附件;
        return record;
      },
    );
    jest.mocked(fetchBitableRecords).mockResolvedValue(records);
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    const withoutEnvironment = await callGetCheckProgress(
      service,
      '三级戒备',
      '台风蓝色',
      '2026-08-08T07:01:00+08:00',
      ['device', 'disaster', 'materials', 'contacts', 'managerConfirmation'],
    );
    expect(withoutEnvironment.guardCompletion.state).toBe('completed');

    const withEnvironment = await callGetCheckProgress(
      service,
      '一级戒备',
      '台风蓝色',
      '2026-08-08T07:01:00+08:00',
      [
        'device',
        'environment',
        'disaster',
        'materials',
        'contacts',
        'managerConfirmation',
      ],
    );
    expect(withEnvironment.guardCompletion).toEqual({
      state: 'incomplete',
      completedBuildingCount: 0,
      totalBuildingCount: 7,
    });
  });

  it('lists pending, not-started and abnormal checks but omits completed checks', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        ...completedBuildingRecord('rec-a', 'A楼'),
        fields: {
          ...completedBuildingRecord('rec-a', 'A楼').fields,
          检查设备安全项: '',
          环境安全: '未启动',
          灾害专项: '异常',
          灾害异常描述: '外墙渗漏待闭环',
        },
      },
      ...['B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'].map((building, index) =>
        completedBuildingRecord(`rec-${index + 1}`, building),
      ),
    ]);
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    const result = await callGetCheckProgress(
      service,
      '三级戒备',
      '台风蓝色',
      '2026-08-08T07:01:00+08:00',
    );

    expect(result.buildingProgress.incompleteItems).toEqual([
      {
        building: 'A楼',
        key: 'device',
        label: '设备安全',
        state: 'pending',
      },
      {
        building: 'A楼',
        key: 'environment',
        label: '环境安全',
        state: 'not_started',
        detail: '未启动',
      },
      {
        building: 'A楼',
        key: 'disaster',
        label: '灾害专项',
        state: 'abnormal',
        detail: '外墙渗漏待闭环',
      },
    ]);
  });

  it('marks environment as not required and never reminds it for a yellow rain level-three warning', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        ...completedBuildingRecord('rec-a', 'A楼'),
        fields: {
          ...completedBuildingRecord('rec-a', 'A楼').fields,
          重保标签: '暴雨黄色',
          检查设备安全项: '',
          环境安全: '',
        },
      },
      ...['B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'].map((building, index) => {
        const record = completedBuildingRecord(`rec-${index + 1}`, building);
        return {
          ...record,
          fields: { ...record.fields, 重保标签: '暴雨黄色' },
        };
      }),
    ]);
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    const result = await callGetCheckProgress(
      service,
      '三级戒备',
      '暴雨黄色',
      '2026-08-08T07:01:00+08:00',
      ['device', 'disaster', 'materials', 'contacts', 'managerConfirmation'],
    );

    expect(result.summary.environment).toBe('not_required');
    expect(
      result.buildingProgress.buildings.find(
        ({ building }) => building === 'A楼',
      )?.checks.environment,
    ).toBe('not_required');
    expect(
      result.buildingProgress.incompleteItems.filter(
        ({ building }) => building === 'A楼',
      ),
    ).toEqual([
      {
        building: 'A楼',
        key: 'device',
        label: '设备安全',
        state: 'pending',
      },
    ]);
  });

  it.each([
    ['一级戒备', ['materials', 'managerConfirmation']],
    ['二级戒备', ['materials', 'managerConfirmation']],
    [
      '三级戒备',
      [
        'device',
        'environment',
        'disaster',
        'materials',
        'contacts',
        'managerConfirmation',
      ],
    ],
  ] as const)(
    'only exposes check items required by %s',
    async (guardLevel, expectedKeys) => {
      jest.mocked(fetchBitableRecords).mockResolvedValue([
        {
          record_id: `rec-${guardLevel}`,
          fields: {
            日期: '2026-08-08T08:00:00+08:00',
            楼栋: 'A楼',
            重保戒备等级: guardLevel,
            重保标签: '台风蓝色',
            检查设备安全项: '',
            设备异常描述: '',
            环境安全: '',
            环境异常描述: '',
            灾害专项: '',
            灾害异常描述: '',
            检查重保物资清单正常: '',
            物资异常描述: '',
            检查重保联络清单人员齐备: '',
            联络异常描述: '',
            机房经理确认: '',
          },
        },
      ]);
      const service = new WeatherWarningBitableService({
        axiosRef: {},
      } as never);

      const result = await callGetCheckProgress(
        service,
        guardLevel,
        '台风蓝色',
        '2026-08-08T07:01:00+08:00',
        expectedKeys,
      );

      expect(
        result.buildingProgress.incompleteItems
          .filter(({ building }) => building === 'A楼')
          .map(({ key }) => key),
      ).toEqual(expectedKeys);
    },
  );

  it('counts empty and illegal building values without assigning them to a building', async () => {
    jest
      .mocked(fetchBitableRecords)
      .mockResolvedValue([
        completedBuildingRecord('rec-a', 'A楼'),
        completedBuildingRecord('rec-empty', ''),
        completedBuildingRecord('rec-illegal', 'X楼'),
      ]);
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    const result = await callGetCheckProgress(
      service,
      '三级戒备',
      '台风蓝色',
      '2026-08-08T07:01:00+08:00',
    );

    expect(result.buildingProgress).toMatchObject({
      available: true,
      unassignedRecordCount: 2,
    });
    expect(
      result.buildingProgress.buildings.map(({ building }) => building),
    ).toEqual(['A楼']);
  });

  it('falls back to the base summary only when the building field is explicitly missing', async () => {
    const missingBuildingField = Object.assign(new Error('field missing'), {
      feishuCode: 1254045,
    });
    jest
      .mocked(fetchBitableRecords)
      .mockRejectedValueOnce(missingBuildingField)
      .mockResolvedValueOnce([
        {
          record_id: 'rec-base',
          fields: {
            日期: '2026-08-08T08:00:00+08:00',
            重保戒备等级: '三级戒备',
            重保标签: '台风蓝色',
            检查设备安全项: '正常',
          },
        },
      ]);
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    await expect(
      callGetCheckProgress(
        service,
        '三级戒备',
        '台风蓝色',
        '2026-08-08T07:01:00+08:00',
      ),
    ).resolves.toEqual({
      summary: expect.objectContaining({ device: 'completed' }),
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
    });
    expect(fetchBitableRecords).toHaveBeenCalledTimes(2);
    expect(
      jest.mocked(fetchBitableRecords).mock.calls[0][1].fieldNames,
    ).toContain('楼栋');
    expect(
      jest.mocked(fetchBitableRecords).mock.calls[1][1].fieldNames,
    ).not.toContain('楼栋');
  });

  it('does not downgrade unrelated check-table failures to base-only progress', async () => {
    jest
      .mocked(fetchBitableRecords)
      .mockRejectedValue(new Error('network unavailable'));
    const service = new WeatherWarningBitableService({ axiosRef: {} } as never);

    await expect(
      callGetCheckProgress(
        service,
        '三级戒备',
        '台风蓝色',
        '2026-08-08T07:01:00+08:00',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
  });
});

type CheckProgressResult = {
  summary: Record<string, unknown>;
  guardCompletion: {
    state: 'completed' | 'incomplete' | 'unavailable' | 'not_applicable';
    completedBuildingCount: number;
    totalBuildingCount: number;
  };
  buildingProgress: {
    available: boolean;
    buildings: Array<{
      building: string;
      recordAt: string;
      checks: Record<string, string>;
    }>;
    missingRegistrationBuildings: string[];
    unassignedRecordCount: number;
    incompleteItems: Array<{
      building: string;
      key: string;
      label: string;
      state: string;
      detail?: string;
    }>;
  };
};

function callGetCheckProgress(
  service: WeatherWarningBitableService,
  guardLevel: '一级戒备' | '二级戒备' | '三级戒备',
  tag: string,
  openedAt: string,
  requiredCheckKeys?: readonly string[],
): Promise<CheckProgressResult> {
  return (
    service as unknown as {
      getCheckProgress(
        level: string,
        checkTag: string,
        eventOpenedAt: string,
        requiredKeys?: readonly string[],
        forceRefresh?: boolean,
      ): Promise<CheckProgressResult>;
    }
  ).getCheckProgress(guardLevel, tag, openedAt, requiredCheckKeys);
}

function completedBuildingRecord(recordId: string, building: string) {
  return {
    record_id: recordId,
    fields: {
      日期: '2026-08-08T08:00:00+08:00',
      楼栋: building,
      重保戒备等级: '三级戒备',
      重保标签: '台风蓝色',
      检查设备安全项: '正常',
      设备附件: [{ file_token: `${recordId}-device` }],
      环境安全: '正常',
      环境附件: [{ file_token: `${recordId}-environment` }],
      灾害专项: '正常',
      灾害附件: [{ file_token: `${recordId}-disaster` }],
      检查重保物资清单正常: '正常',
      检查重保联络清单人员齐备: '正常',
      机房经理确认: '已确认',
    },
  };
}
