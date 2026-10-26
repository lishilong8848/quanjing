import type {
  WeatherWarningDisplayWarning,
  WeatherWarningSnapshot,
} from '@shared/api.interface';
import { resolveWeatherWarningCheckScope } from './weather-warning-check-scope';
import { WEATHER_GUARD_BUILDINGS } from './weather-warning-registration.rules';

const SCHEMA_VERSION = '2.0' as const;
const POLL_INTERVAL_SECONDS = 10 * 60;
const SUPPORTED_ATTACHMENT_TEXT =
  '支持PNG、JPG/JPEG、WebP、PDF，单文件不超过10 MiB';

export function buildWeatherWarningExternalContract(
  snapshot: WeatherWarningSnapshot,
) {
  const warnings = mergeWarnings(snapshot);
  const primaryMatchedWarning = snapshot.matchedWarnings[0] ?? null;
  const hasGuard =
    primaryMatchedWarning !== null && snapshot.guardLevel !== null;

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: snapshot.snapshotAt,
    pollIntervalSeconds: POLL_INTERVAL_SECONDS,
    hasWarning: warnings.length > 0,
    hasGuard,
    status: snapshot.status,
    sourceState: snapshot.sourceState,
    guardDecisionState: snapshot.guardDecisionState ?? null,
    lastSuccessAt: snapshot.lastSuccessAt ?? null,
    guardLevel: snapshot.guardLevel,
    primaryWarningId:
      primaryMatchedWarning?.id ?? warnings[0]?.id ?? null,
    warnings,
    weather: buildWeather(snapshot),
    units: {
      temperature: '℃',
      feelsLikeTemperature: '℃',
      relativeHumidity: '%',
      windLevel: '级',
      dewPointTemperature: '℃',
      atmosphericPressure: 'hPa',
      wetBulbTemperature: '℃',
    },
    guard: {
      required: hasGuard,
      level: snapshot.guardLevel,
      actions: hasGuard ? [...snapshot.actions] : [],
      initialNotificationEnabled: true,
      progressNotificationEnabled: false,
      reminderIntervalMinutes: null,
    },
    registrationRequirements: buildRegistrationRequirements(
      primaryMatchedWarning,
      hasGuard,
    ),
  };
}

function mergeWarnings(snapshot: WeatherWarningSnapshot) {
  const warnings = new Map<
    string,
    ReturnType<typeof toExternalWarning>
  >();
  for (const warning of snapshot.matchedWarnings) {
    warnings.set(warning.id, toExternalWarning(warning, true));
  }
  for (const warning of snapshot.unmatchedWarnings) {
    if (!warnings.has(warning.id)) {
      warnings.set(warning.id, toExternalWarning(warning, false));
    }
  }
  return [...warnings.values()];
}

function toExternalWarning(
  warning: WeatherWarningDisplayWarning,
  guardRequired: boolean,
) {
  return {
    id: warning.id,
    title: warning.title,
    type: warning.type,
    color: warning.color,
    guardRequired,
    guardLevel: guardRequired ? warning.guardLevel : null,
    publishTime: normalizeShanghaiTimestamp(warning.pubTime),
    startTime: normalizeShanghaiTimestamp(warning.startTime),
    endTime: normalizeShanghaiTimestamp(warning.endTime),
    status: normalizeNullableText(warning.status),
  };
}

function buildWeather(snapshot: WeatherWarningSnapshot) {
  if (!snapshot.weather) return null;
  const windLevelText = normalizeWindLevelText(snapshot.weather.windScale);

  return {
    condition: null,
    temperature: toNullableNumber(
      snapshot.weather.temperature,
      /\s*(?:℃|°C)$/iu,
    ),
    feelsLikeTemperature: toNullableNumber(
      snapshot.weather.feelsLike,
      /\s*(?:℃|°C)$/iu,
    ),
    relativeHumidity: toNullableNumber(
      snapshot.weather.humidity,
      /\s*%$/u,
    ),
    windDirection: normalizeNullableText(snapshot.weather.windDirection),
    windLevel: toExactWindLevel(snapshot.weather.windScale),
    windLevelText,
    dewPointTemperature: null,
    atmosphericPressure: null,
    wetBulbTemperature: null,
    observedAt: normalizeShanghaiTimestamp(snapshot.weather.observedAt),
  };
}

function buildRegistrationRequirements(
  warning: WeatherWarningDisplayWarning | null,
  hasGuard: boolean,
) {
  if (!warning || !hasGuard) {
    return {
      required: false,
      enabled: false,
      handlingMode: 'external_application' as const,
      summary: '当前没有需要启动戒备登记的预警',
      applicableBuildings: [] as string[],
      requiredForms: [] as string[],
      requiredContents: [] as string[],
      attachmentRequirements: [] as string[],
    };
  }

  let environmentRequired = false;
  let scopeResolved = true;
  try {
    environmentRequired =
      resolveWeatherWarningCheckScope(warning).environmentRequired;
  } catch {
    scopeResolved = false;
  }

  const requiredForms = [
    '《重保戒备检查表-设备安全检查页》',
    ...(environmentRequired
      ? ['《重保戒备检查表-环境安全检查页》']
      : []),
    '《重保戒备检查表-灾害专项检查页》',
    '《重保戒备检查表-物资检查清单》',
    '《重保戒备检查表-重保联络清单》',
  ];
  const requiredContents = [
    '楼栋：A楼、B楼、C楼、D楼、E楼、H楼或110站，必填',
    '检查人：至少选择1名在职人员',
    '设备安全：填写正常或异常；异常时填写具体说明',
    '灾害专项：填写正常或异常；异常时填写具体说明',
    environmentRequired
      ? '环境安全：本次必填；填写正常或异常，异常时填写具体说明'
      : scopeResolved
        ? '环境安全：本次不需要，不计入完成率、不催办'
        : '环境安全：检查范围未配置，需人工确认后填写',
    '重保物资清单：填写正常或异常；异常时填写具体说明',
    '重保联络清单：填写正常或异常；异常时填写具体说明',
    '机房经理：由人员角色自动关联2名，不由提交人选择',
    '登记时间、戒备等级和重保标签：由服务端自动记录',
  ];
  const attachmentRequirements = [
    `设备安全：提交1份检查附件，${SUPPORTED_ATTACHMENT_TEXT}`,
    `灾害专项：提交1份检查附件，${SUPPORTED_ATTACHMENT_TEXT}`,
    ...(environmentRequired
      ? [`环境安全：提交1份检查附件，${SUPPORTED_ATTACHMENT_TEXT}`]
      : []),
  ];

  return {
    required: true,
    enabled: false,
    handlingMode: 'external_application' as const,
    summary:
      '本系统天气戒备登记和进度跟踪已暂停，请在指定的其他应用完成',
    applicableBuildings: [...WEATHER_GUARD_BUILDINGS],
    requiredForms,
    requiredContents,
    attachmentRequirements,
  };
}

function toNullableNumber(
  value: unknown,
  displayUnitPattern?: RegExp,
): number | null {
  const rawText = normalizeNullableText(value);
  const text = rawText?.replace(displayUnitPattern ?? /$^/u, '').trim();
  if (!text || !/^[+-]?\d+(?:\.\d+)?$/u.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function toExactWindLevel(value: unknown): number | null {
  const text = normalizeNullableText(value)?.replace(/级$/u, '').trim();
  if (!text || !/^\d+(?:\.\d+)?$/u.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function normalizeWindLevelText(value: unknown): string | null {
  const text = normalizeNullableText(value);
  if (!text) return null;
  return text.endsWith('级') ? text : `${text}级`;
}

function normalizeShanghaiTimestamp(value: unknown): string | null {
  const text = normalizeNullableText(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text)) {
    return text;
  }
  const localMatch =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/u.exec(
      text,
    );
  if (!localMatch) return text;
  return `${localMatch[1]}T${localMatch[2]}:${localMatch[3] ?? '00'}+08:00`;
}

function normalizeNullableText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}
