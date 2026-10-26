import { loadWeatherWarningFeatureConfig } from '../../server/modules/weather-warning/weather-warning-feature.config';

describe('weather warning feature config', () => {
  it('pauses registration and progress notifications by default', () => {
    expect(loadWeatherWarningFeatureConfig({})).toEqual({
      registrationEnabled: false,
      progressNotificationsEnabled: false,
    });
  });

  it('can restore each retained feature independently', () => {
    expect(
      loadWeatherWarningFeatureConfig({
        WEATHER_WARNING_REGISTRATION_ENABLED: 'true',
        FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED: '1',
      }),
    ).toEqual({
      registrationEnabled: true,
      progressNotificationsEnabled: true,
    });
  });

  it.each(['false', '0', 'off', 'no', '', 'unexpected'])(
    'treats %p as disabled',
    (value) => {
      expect(
        loadWeatherWarningFeatureConfig({
          WEATHER_WARNING_REGISTRATION_ENABLED: value,
          FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED: value,
        }),
      ).toEqual({
        registrationEnabled: false,
        progressNotificationsEnabled: false,
      });
    },
  );
});
