import type {
  QWeatherWarningItem,
  QWeatherWarningResponse,
} from '@server/modules/bitable-sync/bitable-sync.service';

export const TYPHOON_PATH_URL = 'https://typhoon.slt.zj.gov.cn/#/';
export const DEFAULT_TYPHOON_PATH_CHAT_ID = 'oc_afb27caf36b3bfeea2de20bd6f955d21';

export type TyphoonWarningLevel = 'blue' | 'yellow' | 'orange' | 'red';

export interface ActiveTyphoonWarning {
  id: string;
  warningKey: string;
  title: string;
  level: TyphoonWarningLevel;
  levelText: string;
  pubTime?: string;
  text?: string;
  raw: QWeatherWarningItem;
}

export interface TyphoonWarningSendState {
  warningKey?: string;
  level?: TyphoonWarningLevel;
  lastSentAt?: string;
  lastWarningTitle?: string;
}

export interface TyphoonPathScreenshotSendDecision {
  shouldSend: boolean;
  reason: string;
  cadenceHours?: number;
  nextSendAt?: string;
  warning?: ActiveTyphoonWarning;
}

const LEVEL_RANK: Record<TyphoonWarningLevel, number> = {
  blue: 1,
  yellow: 2,
  orange: 3,
  red: 4,
};

const LEVEL_TEXT: Record<TyphoonWarningLevel, string> = {
  blue: '蓝色',
  yellow: '黄色',
  orange: '橙色',
  red: '红色',
};

const TERMINAL_WARNING_STATUS_MARKERS = [
  '解除',
  '取消',
  '撤销',
  '结束',
  '终止',
  '失效',
  '过期',
  'cancelled',
  'canceled',
  'cancel',
  'expired',
  'ended',
  'closed',
  'inactive',
] as const;

export function findActiveTyphoonWarning(
  data: Pick<QWeatherWarningResponse, 'warning'> | null | undefined,
  now: Date = new Date(),
): ActiveTyphoonWarning | null {
  const candidates = (data?.warning || [])
    .filter((item) => isWeatherWarningActive(item, now) && isTyphoonWarning(item))
    .map((item) => {
      const level = normalizeTyphoonWarningLevel(item);
      if (!level) return null;
      const title = item.title?.trim() || `${LEVEL_TEXT[level]}台风预警`;
      const warningKey = item.id?.trim()
        || [title, item.pubTime, item.startTime, level].filter(Boolean).join('|');

      const warning: ActiveTyphoonWarning = {
        id: item.id?.trim() || warningKey,
        warningKey,
        title,
        level,
        levelText: LEVEL_TEXT[level],
        pubTime: item.pubTime || item.startTime || undefined,
        text: item.text,
        raw: item,
      };

      return warning;
    })
    .filter((item): item is ActiveTyphoonWarning => Boolean(item));

  return candidates.sort((left, right) => LEVEL_RANK[right.level] - LEVEL_RANK[left.level])[0] || null;
}

export function getTyphoonWarningCadenceHours(level: TyphoonWarningLevel): number {
  return level === 'blue' ? 8 : 4;
}

export function decideTyphoonPathScreenshotSend(
  data: Pick<QWeatherWarningResponse, 'warning'> | null | undefined,
  state: TyphoonWarningSendState | null | undefined,
  now: Date = new Date(),
): TyphoonPathScreenshotSendDecision {
  const warning = findActiveTyphoonWarning(data, now);
  if (!warning) {
    return {
      shouldSend: false,
      reason: 'no-active-typhoon-warning',
    };
  }

  const cadenceHours = getTyphoonWarningCadenceHours(warning.level);
  if (!state?.lastSentAt) {
    return {
      shouldSend: true,
      reason: 'never-sent',
      cadenceHours,
      warning,
    };
  }

  if (state.warningKey !== warning.warningKey) {
    return {
      shouldSend: true,
      reason: 'new-warning',
      cadenceHours,
      warning,
    };
  }

  if (state.level && LEVEL_RANK[warning.level] > LEVEL_RANK[state.level]) {
    return {
      shouldSend: true,
      reason: 'level-escalated',
      cadenceHours,
      warning,
    };
  }

  const lastSentAt = new Date(state.lastSentAt);
  if (Number.isNaN(lastSentAt.getTime())) {
    return {
      shouldSend: false,
      reason: 'invalid-state',
      cadenceHours,
      warning,
    };
  }

  const nextSendAt = new Date(lastSentAt.getTime() + cadenceHours * 60 * 60 * 1000);
  if (now.getTime() >= nextSendAt.getTime()) {
    return {
      shouldSend: true,
      reason: 'cadence-elapsed',
      cadenceHours,
      nextSendAt: nextSendAt.toISOString(),
      warning,
    };
  }

  return {
    shouldSend: false,
    reason: 'cadence-not-elapsed',
    cadenceHours,
    nextSendAt: nextSendAt.toISOString(),
    warning,
  };
}

export function buildTyphoonPathWarningDeliveryKey(
  decision: TyphoonPathScreenshotSendDecision,
  state: TyphoonWarningSendState | null | undefined,
): string {
  const warning = decision.warning;
  if (!warning) {
    throw new Error('生成台风路径投递标识时缺少有效台风预警');
  }

  const cycleAnchor = decision.reason === 'cadence-elapsed'
    ? decision.nextSendAt
    : warning.pubTime || warning.raw.startTime || state?.lastSentAt || warning.warningKey;
  if (!cycleAnchor) {
    throw new Error('生成台风路径投递标识时缺少稳定周期时间');
  }

  return [
    'typhoon-path',
    'warning',
    warning.warningKey,
    warning.level,
    decision.reason,
    cycleAnchor,
  ].join(':');
}

export function buildForcedTyphoonPathDeliveryKey(
  clientMutationId: string,
): string {
  return `typhoon-path:force:${clientMutationId}`;
}

export function buildTyphoonWarningSendState(
  warning: ActiveTyphoonWarning,
  sentAt: Date = new Date(),
): TyphoonWarningSendState {
  return {
    warningKey: warning.warningKey,
    level: warning.level,
    lastSentAt: sentAt.toISOString(),
    lastWarningTitle: warning.title,
  };
}

export function isWeatherWarningActive(
  item: QWeatherWarningItem,
  now: Date = new Date(),
): boolean {
  const status = `${item.status || ''}`.trim().toLowerCase();
  if (!status) return false;

  const terminalText = `${status} ${item.title || ''}`.toLowerCase();
  if (
    TERMINAL_WARNING_STATUS_MARKERS.some((marker) =>
      terminalText.includes(marker))
  ) {
    return false;
  }

  const endTime = `${item.endTime || ''}`.trim();
  if (!endTime) return true;

  const parsedEndTime = parseWarningTime(endTime);
  return parsedEndTime === null || parsedEndTime > now.getTime();
}

function isTyphoonWarning(item: QWeatherWarningItem): boolean {
  const classification = [
    item.title,
    item.type,
    item.typeName,
  ].filter(Boolean).join(' ').toLowerCase();

  if (classification) {
    return classification.includes('台风') || classification.includes('typhoon');
  }

  const text = `${item.text || ''}`.toLowerCase();

  return text.includes('台风预警') || text.includes('typhoon warning');
}

function normalizeTyphoonWarningLevel(
  item: QWeatherWarningItem,
): TyphoonWarningLevel | null {
  const haystack = [
    item.level,
    item.severityColor,
    item.severity,
    item.title,
    item.text,
  ].join(' ').toLowerCase();

  if (haystack.includes('red') || haystack.includes('红')) return 'red';
  if (haystack.includes('orange') || haystack.includes('橙')) return 'orange';
  if (haystack.includes('yellow') || haystack.includes('黄')) return 'yellow';
  if (haystack.includes('blue') || haystack.includes('蓝')) return 'blue';
  return null;
}

function parseWarningTime(value: string): number | null {
  const numericValue = Number(value);
  const timestamp = Number.isFinite(numericValue) && value !== ''
    ? numericValue < 10_000_000_000
      ? numericValue * 1000
      : numericValue
    : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}
