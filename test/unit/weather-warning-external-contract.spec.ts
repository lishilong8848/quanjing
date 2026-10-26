import type { WeatherWarningSnapshot } from '../../shared/api.interface';
import { buildWeatherWarningExternalContract } from '../../server/modules/weather-warning/weather-warning-external-contract';

describe('weather warning external contract', () => {
  it('returns a text-only unified contract for an active guard warning', () => {
    const response = buildWeatherWarningExternalContract(
      createSnapshot({
        guardLevel: '一级戒备',
        matchedWarnings: [
          {
            id: 'warning-red-rain',
            title: '江苏省气象台发布暴雨红色预警',
            type: '暴雨',
            color: 'red',
            guardLevel: '一级戒备',
            pubTime: '2026-08-11 08:30:00',
            startTime: '2026-08-11T08:30+08:00',
            status: '预警中',
          },
        ],
      }),
    );

    expect(response).toMatchObject({
      schemaVersion: '2.0',
      generatedAt: '2026-08-11T03:29:21.348Z',
      pollIntervalSeconds: 600,
      hasWarning: true,
      hasGuard: true,
      guardLevel: '一级戒备',
      primaryWarningId: 'warning-red-rain',
      warnings: [
        expect.objectContaining({
          id: 'warning-red-rain',
          guardRequired: true,
          publishTime: '2026-08-11T08:30:00+08:00',
          startTime: '2026-08-11T08:30+08:00',
          endTime: null,
        }),
      ],
      weather: {
        condition: null,
        temperature: 29,
        feelsLikeTemperature: 31,
        relativeHumidity: 92,
        windDirection: '东风',
        windLevel: 3,
        windLevelText: '3级',
        dewPointTemperature: null,
        atmosphericPressure: null,
        wetBulbTemperature: null,
        observedAt: '2026-08-11T10:00:08+08:00',
      },
      guard: {
        required: true,
        level: '一级戒备',
        initialNotificationEnabled: true,
        progressNotificationEnabled: false,
        reminderIntervalMinutes: null,
      },
      registrationRequirements: expect.objectContaining({
        required: true,
        enabled: false,
        handlingMode: 'external_application',
      }),
    });
    expect(response.registrationRequirements.requiredForms).toContain(
      '《重保戒备检查表-环境安全检查页》',
    );
    expect(response.registrationRequirements.attachmentRequirements).toEqual(
      expect.arrayContaining([
        expect.stringContaining('设备安全'),
        expect.stringContaining('灾害专项'),
        expect.stringContaining('环境安全'),
      ]),
    );

    const serialized = JSON.stringify(response);
    expect(response).not.toHaveProperty('checkSyncState');
    expect(serialized).not.toMatch(/https?:\/\//u);
    expect(serialized).not.toContain('registrationUrl');
    expect(serialized).not.toContain('checklistDownloadUrl');
    expect(serialized).not.toContain('deviceEvidence');
  });

  it('marks environment safety as not required for a level-three blue warning', () => {
    const response = buildWeatherWarningExternalContract(createSnapshot());

    expect(response.registrationRequirements.requiredForms).not.toContain(
      '《重保戒备检查表-环境安全检查页》',
    );
    expect(
      response.registrationRequirements.attachmentRequirements.join('\n'),
    ).not.toContain('环境安全');
    expect(response.registrationRequirements.requiredContents).toContain(
      '环境安全：本次不需要，不计入完成率、不催办',
    );
  });

  it('keeps an unmatched warning visible without claiming a guard decision', () => {
    const response = buildWeatherWarningExternalContract(
      createSnapshot({
        status: 'clear',
        guardLevel: null,
        matchedWarnings: [],
        unmatchedWarnings: [
          {
            id: 'warning-unmatched',
            title: '南通市气象台发布大雾黄色预警',
            type: '大雾',
            color: 'yellow',
            guardLevel: null,
          },
        ],
        actions: [],
      }),
    );

    expect(response).toMatchObject({
      hasWarning: true,
      hasGuard: false,
      primaryWarningId: 'warning-unmatched',
      warnings: [
        expect.objectContaining({
          id: 'warning-unmatched',
          guardRequired: false,
          guardLevel: null,
        }),
      ],
      guard: {
        required: false,
        level: null,
        actions: [],
        initialNotificationEnabled: true,
        progressNotificationEnabled: false,
        reminderIntervalMinutes: null,
      },
      registrationRequirements: expect.objectContaining({
        required: false,
        enabled: false,
        requiredForms: [],
        attachmentRequirements: [],
      }),
    });
  });

  it('normalizes weather values that already contain display units', () => {
    const response = buildWeatherWarningExternalContract(
      createSnapshot({
        weather: {
          temperature: '29℃',
          feelsLike: '31 ℃',
          humidity: '92%',
          windDirection: '东风',
          windScale: '3-4级',
          observedAt: '2026-08-11 10:00:08',
        },
      }),
    );

    expect(response.weather).toMatchObject({
      temperature: 29,
      feelsLikeTemperature: 31,
      relativeHumidity: 92,
      windLevel: null,
      windLevelText: '3-4级',
    });
  });
});

function createSnapshot(
  overrides: Partial<WeatherWarningSnapshot> = {},
): WeatherWarningSnapshot {
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
        pubTime: '2026-08-11T08:37+08:00',
        startTime: '2026-08-11T08:37+08:00',
        status: '预警中',
      },
    ],
    unmatchedWarnings: [],
    actions: [
      '相关人员7*24 On call，通知相关设备供应商7*24 On call；',
      '现场团队进行内部预警通报；',
    ],
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
    canSendTest: true,
    ...overrides,
  };
}
