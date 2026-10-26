import { ServiceUnavailableException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WeatherWarningRegistrationEnabledGuard } from '../../server/modules/weather-warning/weather-warning-registration-enabled.guard';

describe('WeatherWarningRegistrationEnabledGuard', () => {
  const originalValue = process.env.WEATHER_WARNING_REGISTRATION_ENABLED;

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.WEATHER_WARNING_REGISTRATION_ENABLED;
    } else {
      process.env.WEATHER_WARNING_REGISTRATION_ENABLED = originalValue;
    }
  });

  it('rejects registration before controller work while the feature is paused', () => {
    delete process.env.WEATHER_WARNING_REGISTRATION_ENABLED;
    const guard = new WeatherWarningRegistrationEnabledGuard();

    expect(() => guard.canActivate()).toThrow(ServiceUnavailableException);
    expect(() => guard.canActivate()).toThrow(
      '天气预警戒备登记已暂停，请在指定的其他应用完成',
    );
  });

  it('allows the retained registration flow when explicitly restored', () => {
    process.env.WEATHER_WARNING_REGISTRATION_ENABLED = 'true';

    expect(new WeatherWarningRegistrationEnabledGuard().canActivate()).toBe(
      true,
    );
  });

  it('guards both registration routes before their handlers', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/weather-warning/weather-warning.controller.ts',
      ),
      'utf8',
    );

    expect(source).toMatch(
      /@UseGuards\(WeatherWarningRegistrationEnabledGuard\)[\s\S]*?async getRegistrationOptions/u,
    );
    expect(source).toMatch(
      /@UseGuards\(WeatherWarningRegistrationEnabledGuard\)[\s\S]*?@UseInterceptors\([\s\S]*?async submitRegistration/u,
    );
  });
});
