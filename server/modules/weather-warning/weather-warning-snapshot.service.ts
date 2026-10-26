import { Injectable } from '@nestjs/common';
import type {
  WeatherWarningBuildingProgressSummary,
  WeatherWarningCheckKey,
  WeatherWarningCheckSummary,
  WeatherWarningCheckSyncState,
  WeatherWarningDisplayWarning,
  WeatherWarningGuardDecisionState,
  WeatherWarningGuardCompletionSummary,
  WeatherWarningGuardLevel,
  WeatherWarningMetricSnapshot,
  WeatherWarningSnapshot,
  WeatherWarningSnapshotStatus,
} from '@shared/api.interface';
import {
  BitableSyncService,
  type QWeatherWarningItem,
  type QWeatherWarningResponse,
} from '@server/modules/bitable-sync/bitable-sync.service';
import {
  WeatherWarningBitableService,
  WEATHER_WARNING_EXPECTED_BUILDINGS,
  type WeatherWarningCheckSummary as BitableWeatherWarningCheckSummary,
} from './weather-warning-bitable.service';
import { getWeatherWarningActionTemplate } from './weather-warning-action-templates';
import { resolveWeatherWarningCheckScope } from './weather-warning-check-scope';
import {
  normalizeWeatherWarningColor,
  normalizeWeatherWarningType,
  selectWeatherGuardDecision,
  type MatchedWeatherWarning,
  type WeatherGuardDecision,
  type WeatherWarningColor,
  type WeatherWarningRule,
} from './weather-warning-rules';
import type { WeatherWarningFetchResult } from './weather-warning-source-status';

export interface GetWeatherWarningSnapshotOptions {
  forceRefresh?: boolean;
  forceRuleRefresh?: boolean;
  eventOpenedAt?: string;
  includeCheckProgress?: boolean;
}

const SAFE_WEATHER_SOURCE_ERROR = '天气实况数据暂不可用';
const SAFE_WARNING_SOURCE_ERROR = '天气预警数据源暂不可用';
const SAFE_RULE_SOURCE_ERROR = '天气预警已获取，重保规则暂未同步';
const SAFE_CHECK_SOURCE_ERROR = '天气预警与戒备已判定，重保检查进度暂未同步';
const SAFE_WARNING_AND_RULE_SOURCE_ERROR = '天气预警与重保规则暂未完成同步';
const COLOR_LABELS: Record<WeatherWarningColor, string> = {
  red: '红色',
  orange: '橙色',
  yellow: '黄色',
  blue: '蓝色',
};
const WEATHER_PLACEHOLDER_VALUES = new Set([
  '--',
  '-',
  '待更新',
  '未知',
  'n/a',
  'na',
]);

@Injectable()
export class WeatherWarningSnapshotService {
  private readonly firstDetectedAtByEvent = new Map<string, string>();

  constructor(
    private readonly bitableSyncService: BitableSyncService,
    private readonly weatherWarningBitableService: WeatherWarningBitableService,
  ) {}

  async getSnapshot(
    options: GetWeatherWarningSnapshotOptions = {},
  ): Promise<WeatherWarningSnapshot> {
    const forceRefresh = options.forceRefresh === true;
    const forceRuleRefresh =
      options.forceRuleRefresh === undefined
        ? forceRefresh
        : options.forceRuleRefresh === true;
    const includeCheckProgress = options.includeCheckProgress !== false;
    const [warningResult, weatherResult, ruleResult] = await Promise.all([
      this.getWarningFetchResult(forceRefresh),
      this.getWeatherNowSnapshot(),
      this.getRuleResult(forceRuleRefresh),
    ]);
    const decision = selectWeatherGuardDecision(
      getWarningItems(warningResult.data),
      ruleResult.rules,
      Date.now(),
    );
    this.captureFirstDetectedTimes(decision, warningResult);
    const matchedWarnings = decision.matchedWarnings.map((warning, index) =>
      toDisplayWarning(
        warning,
        index,
        warning.type,
        warning.color,
        warning.guardLevel,
      ),
    );
    const unmatchedWarnings = decision.unmatchedWarnings.map((warning, index) =>
      toDisplayWarning(warning, index, undefined, undefined, null),
    );
    const checkResult: {
      summary: WeatherWarningCheckSummary;
      buildingProgress?: WeatherWarningBuildingProgressSummary;
      guardCompletion?: WeatherWarningGuardCompletionSummary;
      requiredCheckKeys: readonly WeatherWarningCheckKey[];
      error: boolean;
      blockingError: boolean;
    } =
      ruleResult.error || !includeCheckProgress
        ? {
            summary: createNotStartedCheckSummary(),
            requiredCheckKeys: [],
            error: false,
            blockingError: false,
          }
        : await this.getCheckSummary(
            decision,
            warningResult,
            forceRefresh,
            options.eventOpenedAt,
          );
    const snapshotSourceState = resolveSnapshotSourceState(
      warningResult.state,
      ruleResult.error || checkResult.blockingError,
    );
    const status = resolveSnapshotStatus(
      snapshotSourceState,
      decision.matchedWarnings.length,
    );
    const guardDecisionState = resolveGuardDecisionState(
      warningResult.state,
      ruleResult.error,
    );
    const checkSyncState: WeatherWarningCheckSyncState =
      !includeCheckProgress ||
      !decision.guardLevel ||
      decision.matchedWarnings.length === 0
        ? 'not_applicable'
        : checkResult.error
          ? 'unavailable'
          : 'fresh';
    const canSendTest =
      !ruleResult.error &&
      !checkResult.blockingError &&
      ((warningResult.state === 'fresh' && status === 'active') ||
        (warningResult.state === 'degraded' &&
          status === 'degraded' &&
          !warningResult.isStale &&
          Boolean(warningResult.lastSuccessAt))) &&
      decision.guardLevel !== null &&
      decision.matchedWarnings.length > 0 &&
      this.hasTestRecipient();
    const sourceError = resolveSourceError({
      warningState: warningResult.state,
      ruleError: ruleResult.error,
      checkError: checkResult.error,
    });

    return {
      status,
      sourceState: snapshotSourceState,
      guardDecisionState,
      checkSyncState,
      snapshotAt: new Date(Date.now()).toISOString(),
      ...(warningResult.lastSuccessAt
        ? { lastSuccessAt: warningResult.lastSuccessAt }
        : {}),
      guardLevel: decision.guardLevel,
      matchedWarnings,
      unmatchedWarnings,
      actions: getWeatherWarningActionTemplate(decision.guardLevel),
      weather: weatherResult.weather,
      ...(weatherResult.error
        ? { weatherSourceError: SAFE_WEATHER_SOURCE_ERROR }
        : {}),
      checkSummary: checkResult.summary,
      requiredCheckKeys: [...checkResult.requiredCheckKeys],
      ...(checkResult.buildingProgress
        ? { buildingProgress: checkResult.buildingProgress }
        : {}),
      ...(checkResult.guardCompletion
        ? { guardCompletion: checkResult.guardCompletion }
        : {}),
      ...(sourceError ? { sourceError } : {}),
      canSendTest,
    };
  }

  private async getRuleResult(forceRefresh: boolean): Promise<{
    rules: WeatherWarningRule[];
    error: boolean;
  }> {
    try {
      const rules =
        await this.weatherWarningBitableService.getRules(forceRefresh);
      return {
        rules,
        error: rules.length === 0,
      };
    } catch {
      return { rules: [], error: true };
    }
  }

  private async getWarningFetchResult(
    forceRefresh: boolean,
  ): Promise<WeatherWarningFetchResult<QWeatherWarningResponse>> {
    try {
      return await this.bitableSyncService.getWeatherWarningFetchResult(
        forceRefresh,
      );
    } catch {
      return {
        state: 'unavailable',
        data: null,
        fetchedAt: new Date(Date.now()).toISOString(),
        warningCount: 0,
        isStale: false,
      };
    }
  }

  private async getWeatherNowSnapshot(): Promise<{
    weather: WeatherWarningMetricSnapshot | null;
    error: boolean;
  }> {
    try {
      const weather = toWeatherMetricSnapshot(
        await this.bitableSyncService.getWeatherNow(),
      );
      return { weather, error: weather === null };
    } catch {
      return { weather: null, error: true };
    }
  }

  private async getCheckSummary(
    decision: WeatherGuardDecision,
    warningResult: WeatherWarningFetchResult<QWeatherWarningResponse>,
    forceRefresh: boolean,
    eventOpenedAtOverride?: string,
  ): Promise<{
    summary: WeatherWarningCheckSummary;
    buildingProgress?: WeatherWarningBuildingProgressSummary;
    guardCompletion?: WeatherWarningGuardCompletionSummary;
    requiredCheckKeys: readonly WeatherWarningCheckKey[];
    error: boolean;
    blockingError: boolean;
  }> {
    const matchedWarning = decision.matchedWarnings[0];
    if (!decision.guardLevel || !matchedWarning) {
      return {
        summary: createNotStartedCheckSummary(),
        requiredCheckKeys: [],
        error: false,
        blockingError: false,
      };
    }

    let requiredCheckKeys: readonly WeatherWarningCheckKey[];
    try {
      requiredCheckKeys =
        resolveWeatherWarningCheckScope(matchedWarning).requiredCheckKeys;
    } catch {
      return {
        summary: createNotStartedCheckSummary(),
        requiredCheckKeys: [],
        error: true,
        blockingError: true,
      };
    }

    const eventOpenedAt = this.resolveEventOpenedAt(
      matchedWarning,
      warningResult,
      eventOpenedAtOverride,
    );
    if (!eventOpenedAt) {
      return {
        summary: createNotStartedCheckSummary(),
        requiredCheckKeys,
        error: true,
        blockingError: true,
      };
    }

    try {
      const result = await this.weatherWarningBitableService.getCheckProgress(
        decision.guardLevel,
        buildCheckTag(matchedWarning),
        eventOpenedAt,
        requiredCheckKeys,
        forceRefresh,
      );
      return {
        summary: toSharedCheckSummary(result.summary),
        buildingProgress: result.buildingProgress,
        guardCompletion: result.guardCompletion,
        requiredCheckKeys,
        error: false,
        blockingError: false,
      };
    } catch {
      return {
        summary: createNotStartedCheckSummary(),
        buildingProgress: createUnavailableBuildingProgress(),
        guardCompletion: {
          state: 'unavailable',
          completedBuildingCount: 0,
          totalBuildingCount: WEATHER_WARNING_EXPECTED_BUILDINGS.length,
        },
        requiredCheckKeys,
        error: true,
        blockingError: false,
      };
    }
  }

  private captureFirstDetectedTimes(
    decision: WeatherGuardDecision,
    warningResult: WeatherWarningFetchResult<QWeatherWarningResponse>,
  ): void {
    const detectedAt =
      getValidDateTime(warningResult.lastSuccessAt) ||
      getValidDateTime(warningResult.fetchedAt) ||
      new Date(Date.now()).toISOString();
    const activeEventKeys = new Set<string>();

    for (const warning of decision.activeWarnings) {
      const eventKey = getWarningEventKey(warning);
      if (!eventKey) continue;
      activeEventKeys.add(eventKey);
      if (!this.firstDetectedAtByEvent.has(eventKey)) {
        this.firstDetectedAtByEvent.set(eventKey, detectedAt);
      }
    }

    for (const eventKey of this.firstDetectedAtByEvent.keys()) {
      if (!activeEventKeys.has(eventKey)) {
        this.firstDetectedAtByEvent.delete(eventKey);
      }
    }
  }

  private resolveEventOpenedAt(
    warning: MatchedWeatherWarning,
    warningResult: WeatherWarningFetchResult<QWeatherWarningResponse>,
    eventOpenedAtOverride?: string,
  ): string {
    const persistedOpenedAt = getValidDateTime(eventOpenedAtOverride);
    if (persistedOpenedAt) return persistedOpenedAt;

    const publishedAt = getValidDateTime(warning.pubTime);
    if (publishedAt) return publishedAt;

    const eventKey = getWarningEventKey(warning);
    return (
      (eventKey ? this.firstDetectedAtByEvent.get(eventKey) : undefined) ||
      getValidDateTime(warningResult.lastSuccessAt) ||
      getValidDateTime(warningResult.fetchedAt) ||
      ''
    );
  }

  private hasTestRecipient(): boolean {
    try {
      return (
        this.weatherWarningBitableService.getRuntimeConfig().testRecipient !==
        null
      );
    } catch {
      return false;
    }
  }
}

function createUnavailableBuildingProgress(): WeatherWarningBuildingProgressSummary {
  return {
    available: false,
    buildings: [],
    missingRegistrationBuildings: [],
    unassignedRecordCount: 0,
    incompleteItems: [],
  };
}

function resolveSourceError(input: {
  warningState: WeatherWarningFetchResult<QWeatherWarningResponse>['state'];
  ruleError: boolean;
  checkError: boolean;
}): string | null {
  if (input.ruleError) {
    return input.warningState === 'fresh'
      ? SAFE_RULE_SOURCE_ERROR
      : SAFE_WARNING_AND_RULE_SOURCE_ERROR;
  }
  if (input.warningState !== 'fresh') return SAFE_WARNING_SOURCE_ERROR;
  if (input.checkError) return SAFE_CHECK_SOURCE_ERROR;
  return null;
}

function resolveSnapshotSourceState(
  warningState: WeatherWarningFetchResult<QWeatherWarningResponse>['state'],
  hasAuxiliaryFailure: boolean,
): WeatherWarningFetchResult<QWeatherWarningResponse>['state'] {
  if (!hasAuxiliaryFailure || warningState !== 'fresh') return warningState;
  return 'degraded';
}

function resolveGuardDecisionState(
  warningState: WeatherWarningFetchResult<QWeatherWarningResponse>['state'],
  ruleError: boolean,
): WeatherWarningGuardDecisionState {
  if (ruleError) return 'pending';
  return warningState === 'fresh' ? 'fresh' : 'stale';
}

function resolveSnapshotStatus(
  sourceState: WeatherWarningFetchResult<QWeatherWarningResponse>['state'],
  activeWarningCount: number,
): WeatherWarningSnapshotStatus {
  switch (sourceState) {
    case 'fresh':
      return activeWarningCount > 0 ? 'active' : 'clear';
    case 'degraded':
      return 'degraded';
    case 'stale':
      return 'stale';
    case 'unavailable':
      return 'degraded';
  }
}

function getWarningItems(
  response: QWeatherWarningResponse | null,
): QWeatherWarningItem[] {
  return Array.isArray(response?.warning) ? response.warning : [];
}

function buildCheckTag(warning: MatchedWeatherWarning): string {
  return `${warning.type}${COLOR_LABELS[warning.color]}`;
}

function toDisplayWarning(
  warning: QWeatherWarningItem,
  index: number,
  matchedType?: string,
  matchedColor?: WeatherWarningColor,
  guardLevel: WeatherWarningGuardLevel | null = null,
): WeatherWarningDisplayWarning {
  const type = matchedType ?? getWarningType(warning);
  const color = matchedColor ?? getWarningColor(warning);
  const title = getWarningTitle(warning, type, color);
  const id = getText(warning.id) || `weather-warning-${index + 1}`;
  const startTime = getText(warning.startTime);
  const endTime = getText(warning.endTime);
  const pubTime = getText(warning.pubTime);
  const status = getText(warning.status);

  return {
    id,
    title,
    type: type || null,
    color,
    guardLevel,
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
    ...(pubTime ? { pubTime } : {}),
    ...(status ? { status } : {}),
  };
}

function getWarningType(warning: QWeatherWarningItem): string | null {
  const type = normalizeWeatherWarningType(warning.type);
  if (type) return type;

  const typeName = normalizeWeatherWarningType(warning.typeName);
  return typeName || null;
}

function getWarningColor(
  warning: QWeatherWarningItem,
): WeatherWarningColor | null {
  for (const value of [
    warning.level,
    warning.severityColor,
    warning.severity,
  ]) {
    const color = normalizeWeatherWarningColor(value);
    if (color) return color;
  }
  return null;
}

function getWarningTitle(
  warning: QWeatherWarningItem,
  type: string | null,
  color: WeatherWarningColor | null,
): string {
  const title = getText(warning.title);
  if (title) return title;
  if (type && color) return `${type}${COLOR_LABELS[color]}预警`;
  if (type) return `${type}预警`;
  return '未命名预警';
}

function toWeatherMetricSnapshot(
  response: unknown,
): WeatherWarningMetricSnapshot | null {
  if (!isPlainRecord(response) || String(response.code) !== '200') {
    return null;
  }
  const now = response.now;
  if (!isPlainRecord(now)) return null;

  const temperature = getUsableWeatherMetric(now.temp);
  const feelsLike = getUsableWeatherMetric(now.feelsLike);
  const humidity = getUsableWeatherMetric(now.humidity);
  const windDirection = getUsableWeatherMetric(now.windDir);
  const windScale = getUsableWeatherMetric(now.windScale);
  if (!temperature && !feelsLike && !humidity && !windDirection && !windScale) {
    return null;
  }

  const observedAt = getText(response.updateTime) || getText(now.obsTime);
  return {
    ...(temperature ? { temperature } : {}),
    ...(feelsLike ? { feelsLike } : {}),
    ...(humidity ? { humidity } : {}),
    ...(windDirection ? { windDirection } : {}),
    ...(windScale ? { windScale } : {}),
    ...(observedAt ? { observedAt } : {}),
  };
}

function getUsableWeatherMetric(value: unknown): string | null {
  const text = getText(value);
  if (!text || WEATHER_PLACEHOLDER_VALUES.has(text.toLowerCase())) {
    return null;
  }
  return text;
}

function createNotStartedCheckSummary(): WeatherWarningCheckSummary {
  return {
    device: 'not_started',
    environment: 'not_started',
    disaster: 'not_started',
    materials: 'not_started',
    contacts: 'not_started',
    managerConfirmation: 'not_started',
    abnormalSummaries: [],
  };
}

function toSharedCheckSummary(
  summary: BitableWeatherWarningCheckSummary,
): WeatherWarningCheckSummary {
  return {
    device: summary.device,
    environment: summary.environment,
    disaster: summary.disaster,
    materials: summary.materials,
    contacts: summary.contacts,
    managerConfirmation: summary.managerConfirmation,
    abnormalSummaries: [...summary.abnormalSummaries],
  };
}

function getText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
}

function getValidDateTime(value: unknown): string {
  const text = getText(value);
  return text && Number.isFinite(Date.parse(text)) ? text : '';
}

function getWarningEventKey(warning: QWeatherWarningItem): string {
  const id = getText(warning.id);
  if (id) return `id:${id}`;

  const fallback = [
    warning.title,
    warning.type,
    warning.typeName,
    warning.level,
    warning.severityColor,
    warning.severity,
    warning.sender,
  ]
    .map(getText)
    .join('\u0000');
  return fallback.replace(/\u0000/gu, '') ? `warning:${fallback}` : '';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (Object.prototype.toString.call(value) !== '[object Object]') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
