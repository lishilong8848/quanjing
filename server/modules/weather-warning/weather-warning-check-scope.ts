import type {
  WeatherWarningCheckKey,
  WeatherWarningMatchedWarning,
} from '../../../shared/api.interface';

const CATEGORY_ONE_WARNING_TYPES = new Set([
  '暴雨',
  '暴雪',
  '台风',
  '洪水',
]);
const CATEGORY_TWO_WARNING_TYPES = new Set([
  '雷电',
  '冰雹',
  '寒潮',
  '霜冻',
  '高温',
]);
const BASE_REQUIRED_CHECK_KEYS = [
  'device',
  'disaster',
  'materials',
  'contacts',
  'managerConfirmation',
] as const satisfies readonly WeatherWarningCheckKey[];

export interface WeatherWarningCheckScope {
  requiredCheckKeys: readonly WeatherWarningCheckKey[];
  notRequiredCheckKeys: readonly WeatherWarningCheckKey[];
  environmentRequired: boolean;
}

export class WeatherWarningCheckScopeUnresolvedError extends Error {
  readonly code = 'WEATHER_WARNING_CHECK_SCOPE_UNRESOLVED';

  constructor() {
    super('当前天气预警未配置重保检查范围');
    this.name = 'WeatherWarningCheckScopeUnresolvedError';
  }
}

export function resolveWeatherWarningCheckScope(
  warning: Pick<
    WeatherWarningMatchedWarning,
    'type' | 'color' | 'guardLevel'
  >,
): WeatherWarningCheckScope {
  const type = normalizeWarningType(warning.type);
  const color = warning.color;
  const guardLevel = warning.guardLevel;
  const categoryOne = CATEGORY_ONE_WARNING_TYPES.has(type);
  const categoryTwo = CATEGORY_TWO_WARNING_TYPES.has(type);

  const environmentRequired =
    categoryOne && color === 'red' && guardLevel === '一级戒备';
  const categoryOneWithoutEnvironment =
    categoryOne &&
    ((color === 'orange' && guardLevel === '二级戒备') ||
      ((color === 'blue' || color === 'yellow') &&
        guardLevel === '三级戒备'));
  const categoryTwoWithoutEnvironment =
    categoryTwo &&
    ((color === 'red' && guardLevel === '二级戒备') ||
      (color === 'orange' && guardLevel === '三级戒备'));

  if (
    !environmentRequired &&
    !categoryOneWithoutEnvironment &&
    !categoryTwoWithoutEnvironment
  ) {
    throw new WeatherWarningCheckScopeUnresolvedError();
  }

  return environmentRequired
    ? {
        requiredCheckKeys: [
          'device',
          'environment',
          ...BASE_REQUIRED_CHECK_KEYS.slice(1),
        ],
        notRequiredCheckKeys: [],
        environmentRequired: true,
      }
    : {
        requiredCheckKeys: [...BASE_REQUIRED_CHECK_KEYS],
        notRequiredCheckKeys: ['environment'],
        environmentRequired: false,
      };
}

function normalizeWarningType(value: string | null): string {
  return String(value ?? '')
    .trim()
    .replace(/预警$/u, '')
    .trim();
}
