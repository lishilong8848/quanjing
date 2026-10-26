import {
  WeatherWarningCheckScopeUnresolvedError,
  resolveWeatherWarningCheckScope,
} from '../../server/modules/weather-warning/weather-warning-check-scope';

describe('weather warning check scope', () => {
  it('requires environment safety for category-one red level-one warning', () => {
    expect(
      resolveWeatherWarningCheckScope({
        type: '暴雨',
        color: 'red',
        guardLevel: '一级戒备',
      }),
    ).toEqual({
      requiredCheckKeys: [
        'device',
        'environment',
        'disaster',
        'materials',
        'contacts',
        'managerConfirmation',
      ],
      notRequiredCheckKeys: [],
      environmentRequired: true,
    });
  });

  it('marks environment safety not required for category-one yellow level-three warning', () => {
    expect(
      resolveWeatherWarningCheckScope({
        type: '暴雨',
        color: 'yellow',
        guardLevel: '三级戒备',
      }),
    ).toEqual({
      requiredCheckKeys: [
        'device',
        'disaster',
        'materials',
        'contacts',
        'managerConfirmation',
      ],
      notRequiredCheckKeys: ['environment'],
      environmentRequired: false,
    });
  });

  it.each([
    ['雷电', 'red', '二级戒备'],
    ['高温', 'orange', '三级戒备'],
  ] as const)(
    'does not require environment safety for %s %s %s',
    (type, color, guardLevel) => {
      const scope = resolveWeatherWarningCheckScope({
        type,
        color,
        guardLevel,
      });

      expect(scope.environmentRequired).toBe(false);
      expect(scope.requiredCheckKeys).not.toContain('environment');
      expect(scope.notRequiredCheckKeys).toEqual(['environment']);
    },
  );

  it('rejects a guarded combination outside the supplied matrix', () => {
    expect(() =>
      resolveWeatherWarningCheckScope({
        type: '高温',
        color: 'yellow',
        guardLevel: '三级戒备',
      }),
    ).toThrow(WeatherWarningCheckScopeUnresolvedError);

    try {
      resolveWeatherWarningCheckScope({
        type: '高温',
        color: 'yellow',
        guardLevel: '三级戒备',
      });
      throw new Error('expected matrix resolution to fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'WEATHER_WARNING_CHECK_SCOPE_UNRESOLVED',
      });
    }
  });

  it('returns fresh arrays so callers cannot mutate later resolutions', () => {
    const first = resolveWeatherWarningCheckScope({
      type: '台风',
      color: 'blue',
      guardLevel: '三级戒备',
    });
    (first.requiredCheckKeys as string[]).push('environment');
    (first.notRequiredCheckKeys as string[]).length = 0;

    const second = resolveWeatherWarningCheckScope({
      type: '台风',
      color: 'blue',
      guardLevel: '三级戒备',
    });

    expect(second.requiredCheckKeys).not.toContain('environment');
    expect(second.notRequiredCheckKeys).toEqual(['environment']);
  });
});
