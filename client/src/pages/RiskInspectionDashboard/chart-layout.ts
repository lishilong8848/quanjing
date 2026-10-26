export interface OuterDonutLabelLayoutInput {
  cx: number;
  cy: number;
  midAngle: number;
  outerRadius: number;
  index: number;
  labelText?: string;
}

export interface OuterDonutLabelLayout {
  direction: 1 | -1;
  startX: number;
  startY: number;
  bendX: number;
  bendY: number;
  middleX: number;
  middleY: number;
  endX: number;
  endY: number;
  labelY: number;
  textX: number;
  labelWidth: number;
  labelBounds: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
}

export interface InnerDonutLabelLayoutInput {
  cx: number;
  cy: number;
  midAngle: number;
  percent: number;
  innerRadius: number;
  outerRadius: number;
  valueText?: string;
}

export interface InnerDonutLabelLayout {
  mode: 'full' | 'value-only' | 'hidden';
  x: number;
  y: number;
  width: number;
  height: number;
  valueTextLength?: number;
}

export interface RiskTrendPeriodLabel {
  yearLabel: string;
  weekLabel: string;
  rangeLabel: string;
}

export interface DonutColorItem {
  key: string;
  label: string;
}

export const RISK_DONUT_GEOMETRY = {
  width: 420,
  height: 276,
  centerX: 210,
  centerY: 138,
  outerInnerRadius: 80,
  outerRadius: 106,
  innerRadius: 22,
  innerOuterRadius: 70,
} as const;

const SEVERITY_COLORS = ['#1677ff', '#69b1ff', '#b7d8ff', '#7c8cf8', '#cbd5e1'];
const SEVERITY_LABEL_COLORS = [
  '#0f4c81',
  '#075985',
  '#1e4f7a',
  '#3730a3',
  '#475569',
];
const STATUS_COLORS = ['#30c7a4', '#ffb84d', '#5b8ff9', '#9b8afb', '#94a3b8'];

const OUTER_LABEL_MIN_WIDTH = 76;
const OUTER_LABEL_MAX_WIDTH = 96;
const OUTER_LABEL_FONT_SIZE = 10.5;
const OUTER_LABEL_HEIGHT = 14;
const OUTER_LABEL_ROW_STEP = 20;
const OUTER_LABEL_TEXT_GAP = 5;
const OUTER_LEADER_START_GAP = 4;
const OUTER_LEADER_RAIL_GAP = 12;
const OUTER_LEADER_END_CLEARANCE = 1;
const INNER_VALUE_HORIZONTAL_PADDING = 8;
const OUTER_LABEL_SAFE_BOUNDS = {
  left: 8,
  right: 412,
  top: 8,
  bottom: 268,
} as const;

function estimateOuterDonutLabelWidth(labelText?: string): number {
  if (!labelText) return OUTER_LABEL_MIN_WIDTH;

  const estimatedWidth = Array.from(labelText).reduce((width, character) => {
    if (/\s/u.test(character)) return width + 3.5;
    if (/[\u2e80-\u9fff\uf900-\ufaff]/u.test(character)) {
      return width + OUTER_LABEL_FONT_SIZE;
    }
    if (/[A-Z]/u.test(character)) return width + 7;
    if (/[0-9%]/u.test(character)) return width + 6.25;
    if (/[a-z]/u.test(character)) return width + 5.75;
    return width + 6;
  }, 4);

  return Math.max(
    OUTER_LABEL_MIN_WIDTH,
    Math.min(OUTER_LABEL_MAX_WIDTH, Math.ceil(estimatedWidth)),
  );
}

const DONUT_SEGMENT_INDEX_BY_KEY: Record<string, number> = {
  low: 0,
  低风险: 0,
  'ultra-low': 1,
  超低风险: 1,
  medium: 2,
  中风险: 2,
  high: 3,
  高风险: 3,
  unknown: 4,
  未知风险: 4,
  未分级: 4,
};

const STATUS_COLOR_INDEX_BY_KEY: Record<string, number> = {
  completed: 0,
  已完成: 0,
  rectifying: 1,
  整改中: 1,
  suspended: 2,
  已挂起: 2,
  unknown: 3,
  状态未知: 3,
};

export function getStableDonutLabelIndex(
  itemKey: string,
  fallbackIndex: number,
): number {
  return DONUT_SEGMENT_INDEX_BY_KEY[itemKey] ?? fallbackIndex;
}

export function getSeverityColor(item: DonutColorItem, index: number): string {
  const stableIndex = getStableDonutLabelIndex(item.key || item.label, index);
  return (
    SEVERITY_COLORS[stableIndex % SEVERITY_COLORS.length] ?? SEVERITY_COLORS[0]
  );
}

export function getSeverityLabelColor(
  item: DonutColorItem,
  index: number,
): string {
  const stableIndex = getStableDonutLabelIndex(item.key || item.label, index);
  return (
    SEVERITY_LABEL_COLORS[stableIndex % SEVERITY_LABEL_COLORS.length] ??
    SEVERITY_LABEL_COLORS[0]
  );
}

export function getStatusColor(item: DonutColorItem, index: number): string {
  const stableIndex =
    STATUS_COLOR_INDEX_BY_KEY[item.key || item.label] ?? index;
  return STATUS_COLORS[stableIndex % STATUS_COLORS.length] ?? STATUS_COLORS[0];
}

export function getOuterDonutLabelLayout({
  cx,
  cy,
  midAngle,
  outerRadius,
  index,
  labelText,
}: OuterDonutLabelLayoutInput): OuterDonutLabelLayout {
  const radians = (-midAngle * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const semanticIndex = ((index % 5) + 5) % 5;
  const naturalDirection: 1 | -1 = cosine >= 0 ? 1 : -1;
  const direction: 1 | -1 = semanticIndex === 1 ? 1 : naturalDirection;
  const switchesSide = direction !== naturalDirection;
  const labelTrackIndex = semanticIndex;
  const leaderRadius = outerRadius + OUTER_LEADER_START_GAP;
  const startX = cx + leaderRadius * cosine;
  const startY = cy + leaderRadius * sine;
  const topLabelY =
    OUTER_LABEL_SAFE_BOUNDS.top +
    OUTER_LABEL_HEIGHT / 2 +
    labelTrackIndex * OUTER_LABEL_ROW_STEP;
  const bottomLabelY =
    OUTER_LABEL_SAFE_BOUNDS.bottom -
    OUTER_LABEL_HEIGHT / 2 -
    labelTrackIndex * OUTER_LABEL_ROW_STEP;
  const labelWidth = estimateOuterDonutLabelWidth(labelText);
  const textX =
    direction > 0
      ? OUTER_LABEL_SAFE_BOUNDS.right - labelWidth
      : OUTER_LABEL_SAFE_BOUNDS.left + labelWidth;
  const endX = textX - direction * OUTER_LABEL_TEXT_GAP;
  const minimumEndDistanceY = Math.sqrt(
    Math.max(
      0,
      (outerRadius + OUTER_LEADER_END_CLEARANCE) ** 2 -
        Math.abs(endX - cx) ** 2,
    ),
  );
  const unclampedLabelY =
    sine < 0
      ? Math.min(topLabelY, cy - minimumEndDistanceY)
      : Math.max(bottomLabelY, cy + minimumEndDistanceY);
  const labelY = Math.min(
    OUTER_LABEL_SAFE_BOUNDS.bottom - OUTER_LABEL_HEIGHT / 2,
    Math.max(
      OUTER_LABEL_SAFE_BOUNDS.top + OUTER_LABEL_HEIGHT / 2,
      unclampedLabelY,
    ),
  );
  const safeRouteY =
    cy + (sine < 0 ? -1 : 1) * (outerRadius + OUTER_LEADER_RAIL_GAP);
  const bendX = switchesSide
    ? startX
    : cx + direction * (outerRadius + OUTER_LEADER_RAIL_GAP);
  const bendY = switchesSide ? safeRouteY : startY;
  const middleX = switchesSide ? endX : bendX;
  const middleY = switchesSide ? safeRouteY : labelY;
  const endY = labelY;
  const labelBounds =
    direction > 0
      ? {
          left: textX,
          right: textX + labelWidth,
          top: labelY - OUTER_LABEL_HEIGHT / 2,
          bottom: labelY + OUTER_LABEL_HEIGHT / 2,
        }
      : {
          left: textX - labelWidth,
          right: textX,
          top: labelY - OUTER_LABEL_HEIGHT / 2,
          bottom: labelY + OUTER_LABEL_HEIGHT / 2,
        };

  return {
    direction,
    startX,
    startY,
    bendX,
    bendY,
    middleX,
    middleY,
    endX,
    endY,
    labelY,
    textX,
    labelWidth,
    labelBounds,
  };
}

export function getInnerDonutLabelLayout({
  cx,
  cy,
  midAngle,
  percent,
  innerRadius,
  outerRadius,
  valueText,
}: InnerDonutLabelLayoutInput): InnerDonutLabelLayout {
  const mode: InnerDonutLabelLayout['mode'] =
    percent >= 0.2 ? 'full' : percent >= 0.1 ? 'value-only' : 'hidden';
  const width = mode === 'full' ? 40 : mode === 'value-only' ? 28 : 0;
  const height = mode === 'full' ? 26 : mode === 'value-only' ? 20 : 0;
  const maximumValueTextLength = Math.max(
    0,
    width - INNER_VALUE_HORIZONTAL_PADDING,
  );
  const estimatedValueTextLength = Array.from(valueText || '').reduce(
    (length, character) => length + (/[0-9]/u.test(character) ? 5.5 : 4.5),
    0,
  );
  const valueTextLength =
    mode !== 'hidden' &&
    estimatedValueTextLength > maximumValueTextLength &&
    maximumValueTextLength > 0
      ? maximumValueTextLength
      : undefined;
  const radians = (-midAngle * Math.PI) / 180;
  const absoluteCosine = Math.abs(Math.cos(radians));
  const absoluteSine = Math.abs(Math.sin(radians));
  const halfWidth = width / 2;
  const halfHeight = height / 2;

  const getNearestRadius = (radius: number) =>
    Math.hypot(
      Math.max(0, radius * absoluteCosine - halfWidth),
      Math.max(0, radius * absoluteSine - halfHeight),
    );
  const getFarthestRadius = (radius: number) =>
    Math.hypot(
      radius * absoluteCosine + halfWidth,
      radius * absoluteSine + halfHeight,
    );

  let minimumSafeRadius = innerRadius;
  let minimumSearchEnd = outerRadius;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const candidate = (minimumSafeRadius + minimumSearchEnd) / 2;
    if (getNearestRadius(candidate) >= innerRadius) {
      minimumSearchEnd = candidate;
    } else {
      minimumSafeRadius = candidate;
    }
  }
  minimumSafeRadius = minimumSearchEnd;

  let maximumSearchStart = innerRadius;
  let maximumSafeRadius = outerRadius;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const candidate = (maximumSearchStart + maximumSafeRadius) / 2;
    if (getFarthestRadius(candidate) <= outerRadius) {
      maximumSearchStart = candidate;
    } else {
      maximumSafeRadius = candidate;
    }
  }
  maximumSafeRadius = maximumSearchStart;

  const preferredRadius = (innerRadius + outerRadius) / 2;
  const radius =
    mode === 'hidden'
      ? preferredRadius
      : Math.min(
          maximumSafeRadius,
          Math.max(minimumSafeRadius, preferredRadius),
        );

  return {
    mode,
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
    width,
    height,
    valueTextLength,
  };
}

export function getTrendPointLabelLayout(
  x: number,
  y: number,
  width = 420,
  height = 180,
) {
  return {
    leftPercent: (x / width) * 100,
    topPercent: (y / height) * 100,
  };
}

export function formatRiskTrendPeriod(
  label: string,
  dashboardMonth: string,
): RiskTrendPeriodLabel {
  const labelMatch = label.trim().match(/^(\d{1,2})\/(\d{1,2})$/);
  const monthMatch = dashboardMonth.match(/^(\d{4})-(\d{2})$/);
  if (!labelMatch || !monthMatch) {
    return { yearLabel: '', weekLabel: label, rangeLabel: '—' };
  }

  const dashboardYear = Number(monthMatch[1]);
  const dashboardMonthNumber = Number(monthMatch[2]);
  const periodMonth = Number(labelMatch[1]);
  const periodDay = Number(labelMatch[2]);
  let periodYear = dashboardYear;
  if (periodMonth - dashboardMonthNumber > 6) periodYear -= 1;
  if (dashboardMonthNumber - periodMonth > 6) periodYear += 1;

  const periodStart = new Date(
    Date.UTC(periodYear, periodMonth - 1, periodDay),
  );
  const periodEnd = new Date(periodStart);
  periodEnd.setUTCDate(periodEnd.getUTCDate() + 6);

  const isoAnchor = new Date(periodStart);
  const isoDay = isoAnchor.getUTCDay() || 7;
  isoAnchor.setUTCDate(isoAnchor.getUTCDate() + 4 - isoDay);
  const isoYear = isoAnchor.getUTCFullYear();
  const isoYearStart = new Date(Date.UTC(isoYear, 0, 1));
  const weekNumber = Math.ceil(
    ((isoAnchor.getTime() - isoYearStart.getTime()) / 86400000 + 1) / 7,
  );
  const pad = (value: number) => String(value).padStart(2, '0');
  const formatDate = (date: Date) =>
    `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`;

  return {
    yearLabel: `${String(isoYear).slice(-2)}年`,
    weekLabel: `第${weekNumber}周`,
    rangeLabel: `${formatDate(periodStart)}–${formatDate(periodEnd)}`,
  };
}
