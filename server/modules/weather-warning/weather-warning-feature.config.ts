export interface WeatherWarningFeatureConfig {
  registrationEnabled: boolean;
  progressNotificationsEnabled: boolean;
}

export function loadWeatherWarningFeatureConfig(
  env: NodeJS.ProcessEnv = process.env,
): WeatherWarningFeatureConfig {
  return {
    registrationEnabled: isEnabled(
      env.WEATHER_WARNING_REGISTRATION_ENABLED,
    ),
    progressNotificationsEnabled: isEnabled(
      env.FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED,
    ),
  };
}

function isEnabled(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'on', 'yes'].includes(value.trim().toLowerCase());
}
