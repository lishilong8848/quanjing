import { ServiceUnavailableException } from '@nestjs/common';
import { loadWeatherWarningAutomationConfig } from '../../server/modules/weather-warning/weather-warning-automation.config';

describe('weather warning automation config', () => {
  it('is disabled by default with a one-minute poll and two-hour reminder cadence', () => {
    const config = loadWeatherWarningAutomationConfig({});

    expect(config).toEqual({
      enabled: false,
      pollIntervalMs: 60 * 1000,
      reminderIntervalMs: 2 * 60 * 60 * 1000,
      targets: [],
      statePath: '',
      stateDirectory: '',
    });
  });

  it('loads deduplicated controlled chat and owner targets only from deployment configuration', () => {
    const config = loadWeatherWarningAutomationConfig({
      FEISHU_WEATHER_WARNING_AUTOMATION_ENABLED: 'true',
      FEISHU_WEATHER_WARNING_CHAT_IDS:
        ' oc_warning_group_a,oc_warning_group_b;oc_warning_group_a ',
      FEISHU_WEATHER_WARNING_IMPORTANT_EVENT_CHAT_IDS:
        'oc_warning_group_b,oc_important_event;oc_important_event',
      FEISHU_WEATHER_WARNING_OWNER_OPEN_ID: 'ou_ma_jinyu',
      FEISHU_WEATHER_WARNING_OWNER_NAME: '示例人员020',
      FEISHU_WEATHER_WARNING_POLL_INTERVAL_MS: '900000',
      FEISHU_WEATHER_WARNING_REMINDER_INTERVAL_MS: '25200000',
      FEISHU_WEATHER_WARNING_AUTOMATION_STATE_PATH: 'D:/state/weather.json',
    });

    expect(config).toEqual({
      enabled: true,
      pollIntervalMs: 900_000,
      reminderIntervalMs: 25_200_000,
      targets: [
        {
          key: 'chat-1',
          receiveIdType: 'chat_id',
          receiveId: 'oc_warning_group_a',
          displayName: '天气预警群1',
          audience: 'general_chat',
        },
        {
          key: 'chat-2',
          receiveIdType: 'chat_id',
          receiveId: 'oc_warning_group_b',
          displayName: '天气预警群2',
          audience: 'general_chat',
        },
        {
          key: 'important-event-chat-1',
          receiveIdType: 'chat_id',
          receiveId: 'oc_important_event',
          displayName: '重要事件通报群1',
          audience: 'important_event_chat',
        },
        {
          key: 'owner',
          receiveIdType: 'open_id',
          receiveId: 'ou_ma_jinyu',
          displayName: '示例人员020',
          audience: 'owner',
        },
      ],
      statePath: 'D:/state/weather.json',
      stateDirectory: '',
    });
  });

  it.each([
    ['FEISHU_WEATHER_WARNING_CHAT_IDS', 'not-a-chat-id'],
    ['FEISHU_WEATHER_WARNING_IMPORTANT_EVENT_CHAT_IDS', 'not-a-chat-id'],
    ['FEISHU_WEATHER_WARNING_OWNER_OPEN_ID', 'not-an-open-id'],
    ['FEISHU_WEATHER_WARNING_POLL_INTERVAL_MS', '59999'],
    ['FEISHU_WEATHER_WARNING_REMINDER_INTERVAL_MS', '3599999'],
  ])('fails closed for invalid enabled configuration %s', (name, value) => {
    const env: NodeJS.ProcessEnv = {
      FEISHU_WEATHER_WARNING_AUTOMATION_ENABLED: 'true',
      FEISHU_WEATHER_WARNING_CHAT_IDS: 'oc_warning_group',
      FEISHU_WEATHER_WARNING_IMPORTANT_EVENT_CHAT_IDS:
        'oc_important_event_group',
      FEISHU_WEATHER_WARNING_OWNER_OPEN_ID: 'ou_ma_jinyu',
      [name]: value,
    };

    expect(() => loadWeatherWarningAutomationConfig(env)).toThrow(
      ServiceUnavailableException,
    );
    expect(() => loadWeatherWarningAutomationConfig(env)).toThrow(name);
    expect(() => loadWeatherWarningAutomationConfig(env)).not.toThrow(value);
  });

  it('fails closed when automation is enabled without both the group and owner targets', () => {
    expect(() =>
      loadWeatherWarningAutomationConfig({
        FEISHU_WEATHER_WARNING_AUTOMATION_ENABLED: 'true',
        FEISHU_WEATHER_WARNING_OWNER_OPEN_ID: 'ou_ma_jinyu',
        FEISHU_WEATHER_WARNING_IMPORTANT_EVENT_CHAT_IDS:
          'oc_important_event_group',
      }),
    ).toThrow('FEISHU_WEATHER_WARNING_CHAT_IDS');

    expect(() =>
      loadWeatherWarningAutomationConfig({
        FEISHU_WEATHER_WARNING_AUTOMATION_ENABLED: 'true',
        FEISHU_WEATHER_WARNING_CHAT_IDS: 'oc_warning_group',
        FEISHU_WEATHER_WARNING_IMPORTANT_EVENT_CHAT_IDS:
          'oc_important_event_group',
      }),
    ).toThrow('FEISHU_WEATHER_WARNING_OWNER_OPEN_ID');

    expect(() =>
      loadWeatherWarningAutomationConfig({
        FEISHU_WEATHER_WARNING_AUTOMATION_ENABLED: 'true',
        FEISHU_WEATHER_WARNING_CHAT_IDS: 'oc_warning_group',
        FEISHU_WEATHER_WARNING_OWNER_OPEN_ID: 'ou_ma_jinyu',
      }),
    ).toThrow('FEISHU_WEATHER_WARNING_IMPORTANT_EVENT_CHAT_IDS');
  });
});
