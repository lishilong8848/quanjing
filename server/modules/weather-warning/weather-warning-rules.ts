import type { QWeatherWarningItem } from '@server/modules/bitable-sync/bitable-sync.service';

export type WeatherWarningColor = 'red' | 'orange' | 'yellow' | 'blue';

export type WeatherGuardLevel = '一级戒备' | '二级戒备' | '三级戒备';

export interface WeatherWarningRule {
  warningType: string;
  warningColor: WeatherWarningColor;
  guardLevel: WeatherGuardLevel;
}

export type MatchedWeatherWarning = QWeatherWarningItem & {
  color: WeatherWarningColor;
  type: string;
  guardLevel: WeatherGuardLevel;
};

export interface WeatherGuardDecision {
  guardLevel: WeatherGuardLevel | null;
  matchedWarnings: MatchedWeatherWarning[];
  unmatchedWarnings: QWeatherWarningItem[];
  activeWarnings: QWeatherWarningItem[];
}

interface NormalizedWeatherWarningRule {
  warningType: string;
  warningColor: WeatherWarningColor;
  guardLevel: WeatherGuardLevel;
}

interface MatchedWarningCandidate {
  warning: QWeatherWarningItem;
  warningType: string;
  warningColor: WeatherWarningColor;
  guardLevel: WeatherGuardLevel;
}

const GUARD_LEVEL_PRIORITY: Record<WeatherGuardLevel, number> = {
  一级戒备: 3,
  二级戒备: 2,
  三级戒备: 1,
};

const COLOR_PRIORITY: Record<WeatherWarningColor, number> = {
  red: 4,
  orange: 3,
  yellow: 2,
  blue: 1,
};

const TERMINAL_STATUS_VALUES = new Set([
  '解除',
  '已解除',
  '失效',
  '已失效',
  '取消',
  '已取消',
  '撤销',
  '已撤销',
  '终止',
  '已终止',
  '结束',
  '已结束',
  '过期',
  '已过期',
  'cancelled',
  'canceled',
  'revoked',
  'terminated',
  'ended',
  'expired',
  'closed',
  'inactive',
]);

const ISO_WARNING_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/u;

export function isActiveWeatherWarning(
  warning: QWeatherWarningItem,
  nowMs: number,
): boolean {
  if (!isRecord(warning)) return false;

  const status = normalizeWarningStatus(warning.status);
  if (TERMINAL_STATUS_VALUES.has(status)) {
    return false;
  }

  const endTime = normalizeText(warning.endTime);
  if (!endTime) return true;

  const endTimeMs = parseWarningTime(endTime);
  return endTimeMs !== null && endTimeMs > nowMs;
}

export function normalizeWeatherWarningColor(
  value: unknown,
): WeatherWarningColor | null {
  const compact = normalizeText(value).replace(/\s+/gu, '').toLowerCase();
  const colorText = compact.replace(/(?:预警|warning|alert)$/u, '');

  if (colorText === 'red' || colorText === '红' || colorText === '红色') {
    return 'red';
  }
  if (colorText === 'orange' || colorText === '橙' || colorText === '橙色') {
    return 'orange';
  }
  if (colorText === 'yellow' || colorText === '黄' || colorText === '黄色') {
    return 'yellow';
  }
  if (colorText === 'blue' || colorText === '蓝' || colorText === '蓝色') {
    return 'blue';
  }
  return null;
}

export function normalizeWeatherWarningType(value: unknown): string {
  return normalizeText(value).replace(/\s+/gu, '').replace(/预警$/u, '');
}

export function selectWeatherGuardDecision(
  warnings: readonly QWeatherWarningItem[],
  rules: readonly WeatherWarningRule[],
  nowMs: number,
): WeatherGuardDecision {
  const warningItems = Array.isArray(warnings) ? warnings : [];
  const activeWarnings = warningItems.filter((warning) =>
    isActiveWeatherWarning(warning, nowMs),
  );
  const normalizedRules = normalizeRules(rules);
  const unmatchedWarnings: QWeatherWarningItem[] = [];
  const matchedCandidates: MatchedWarningCandidate[] = [];

  for (const warning of activeWarnings) {
    const warningType = normalizeWarningType(warning);
    const warningColor = normalizeWarningColor(warning);
    const matchingRule = findMatchingRule(
      normalizedRules,
      warningType,
      warningColor,
    );

    if (!matchingRule || !warningColor) {
      unmatchedWarnings.push(warning);
      continue;
    }

    matchedCandidates.push({
      warning,
      warningType,
      warningColor,
      guardLevel: matchingRule.guardLevel,
    });
  }

  if (!matchedCandidates.length) {
    return {
      guardLevel: null,
      matchedWarnings: [],
      unmatchedWarnings,
      activeWarnings,
    };
  }

  matchedCandidates.sort(compareMatchedCandidates);
  const guardLevel = matchedCandidates[0].guardLevel;
  const matchedWarnings = matchedCandidates.map((candidate) => ({
    ...candidate.warning,
    color: candidate.warningColor,
    type: candidate.warningType,
    guardLevel: candidate.guardLevel,
  }));

  return {
    guardLevel,
    matchedWarnings,
    unmatchedWarnings,
    activeWarnings,
  };
}

function normalizeRules(
  rules: readonly WeatherWarningRule[],
): NormalizedWeatherWarningRule[] {
  const ruleItems = Array.isArray(rules) ? rules : [];
  return ruleItems.flatMap((rule) => {
    if (!isRecord(rule)) return [];

    const warningType = normalizeWeatherWarningType(rule.warningType);
    const warningColor = normalizeWeatherWarningColor(rule.warningColor);
    if (
      !warningType ||
      !warningColor ||
      !isWeatherGuardLevel(rule.guardLevel)
    ) {
      return [];
    }

    return [
      {
        warningType,
        warningColor,
        guardLevel: rule.guardLevel,
      },
    ];
  });
}

function normalizeWarningType(warning: QWeatherWarningItem): string {
  for (const value of [warning.type, warning.typeName]) {
    const type = normalizeWeatherWarningType(value);
    if (type) return type;
  }
  return '';
}

function normalizeWarningColor(
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

function findMatchingRule(
  rules: readonly NormalizedWeatherWarningRule[],
  warningType: string,
  warningColor: WeatherWarningColor | null,
): NormalizedWeatherWarningRule | null {
  if (!warningType || !warningColor) return null;

  const matchingRules = rules.filter(
    (rule) =>
      rule.warningType === warningType && rule.warningColor === warningColor,
  );
  if (!matchingRules.length) return null;

  return matchingRules.sort(
    (left, right) =>
      GUARD_LEVEL_PRIORITY[right.guardLevel] -
      GUARD_LEVEL_PRIORITY[left.guardLevel],
  )[0];
}

function compareMatchedCandidates(
  left: MatchedWarningCandidate,
  right: MatchedWarningCandidate,
): number {
  const guardLevelDifference =
    GUARD_LEVEL_PRIORITY[right.guardLevel] -
    GUARD_LEVEL_PRIORITY[left.guardLevel];
  if (guardLevelDifference) return guardLevelDifference;

  const colorDifference =
    COLOR_PRIORITY[right.warningColor] - COLOR_PRIORITY[left.warningColor];
  if (colorDifference) return colorDifference;

  const pubTimeDifference = comparePubTime(
    left.warning.pubTime,
    right.warning.pubTime,
  );
  if (pubTimeDifference) return pubTimeDifference;

  const idDifference = compareText(left.warning.id, right.warning.id);
  if (idDifference) return idDifference;

  return compareText(
    stableWarningTieBreaker(left),
    stableWarningTieBreaker(right),
  );
}

function comparePubTime(
  left: string | undefined,
  right: string | undefined,
): number {
  const leftTime = parseWarningTime(normalizeText(left));
  const rightTime = parseWarningTime(normalizeText(right));
  if (leftTime === rightTime) return 0;
  if (leftTime === null) return 1;
  if (rightTime === null) return -1;
  return rightTime - leftTime;
}

function compareText(
  left: string | undefined,
  right: string | undefined,
): number {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return 0;
}

function stableWarningTieBreaker(candidate: MatchedWarningCandidate): string {
  const warning = candidate.warning;
  return [
    candidate.warningType,
    candidate.warningColor,
    warning.title,
    warning.type,
    warning.typeName,
    warning.level,
    warning.severityColor,
    warning.severity,
    warning.id,
    warning.pubTime,
    warning.startTime,
    warning.endTime,
    warning.status,
    warning.sender,
    warning.text,
  ]
    .map(normalizeText)
    .join('\u0000');
}

function isWeatherGuardLevel(value: unknown): value is WeatherGuardLevel {
  return value === '一级戒备' || value === '二级戒备' || value === '三级戒备';
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeWarningStatus(value: unknown): string {
  return normalizeText(value).replace(/\s+/gu, ' ').toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function parseWarningTime(value: string): number | null {
  if (!value) return null;

  if (/^[+-]?\d+(?:\.\d+)?$/u.test(value)) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return null;
    return Math.abs(numericValue) < 10_000_000_000
      ? numericValue * 1000
      : numericValue;
  }

  const match = ISO_WARNING_TIME_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] ? Number(match[6]) : 0;
  if (!isValidWarningDateTime(year, month, day, hour, minute, second)) {
    return null;
  }

  if (match[8] !== 'Z') {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      return null;
    }
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isValidWarningDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }

  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= lastDayOfMonth;
}
