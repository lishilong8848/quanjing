export type CertificateFilter =
  | 'all'
  | 'high-voltage'
  | 'low-voltage'
  | 'height-work';

export interface CertificateMetric {
  id: 'high-voltage' | 'low-voltage' | 'height-work' | 'expiring';
  label: string;
  value: number;
  tone: 'blue' | 'green' | 'red' | 'orange';
}

export interface BuildingCompliance {
  building: string;
  compliant: number;
  nonCompliant: number;
  rate: number;
}

export interface NonCompliantPerson {
  id: string;
  building: string;
  name: string;
  position: string;
  missingCertificate: string;
  positionTone: 'green' | 'red';
}

export const dashboardSummary = {
  complianceRate: 95.6,
  currentQualified: 86,
  targetQualified: 90,
  totalCertificates: 153,
} as const;

export const certificateMetrics: CertificateMetric[] = [
  {
    id: 'high-voltage',
    label: '高压电工资质持有情况',
    value: 68,
    tone: 'blue',
  },
  {
    id: 'low-voltage',
    label: '低压电工资质持有情况',
    value: 72,
    tone: 'green',
  },
  {
    id: 'height-work',
    label: '高处作业资质持有情况',
    value: 7,
    tone: 'red',
  },
  {
    id: 'expiring',
    label: '证件90天内到期',
    value: 8,
    tone: 'orange',
  },
];

export const buildingCompliance: BuildingCompliance[] = [
  { building: '110站', compliant: 8, nonCompliant: 0, rate: 100 },
  { building: 'A楼', compliant: 11, nonCompliant: 0, rate: 100 },
  { building: 'H楼', compliant: 15, nonCompliant: 0, rate: 100 },
  { building: 'D楼', compliant: 11, nonCompliant: 0, rate: 100 },
  { building: 'E楼', compliant: 10, nonCompliant: 2, rate: 83 },
  { building: 'C楼', compliant: 10, nonCompliant: 0, rate: 100 },
  { building: 'B楼', compliant: 8, nonCompliant: 2, rate: 80 },
];

export const nonCompliantPeople: NonCompliantPerson[] = [
  {
    id: 'e-jiang-liang',
    building: 'E楼',
    name: '江亮',
    position: '运维值班员',
    missingCertificate: '低压电工证或高压电工证',
    positionTone: 'green',
  },
  {
    id: 'b-li-song-qi',
    building: 'B楼',
    name: '李松奇',
    position: '运维值班员',
    missingCertificate: '高压电工证',
    positionTone: 'green',
  },
  {
    id: 'e-fu-jin-tao',
    building: 'E楼',
    name: '付锦涛',
    position: '运维值班员',
    missingCertificate: '低压电工证或高压电工证',
    positionTone: 'green',
  },
  {
    id: 'b-ji-lei',
    building: 'B楼',
    name: '季磊',
    position: '暖通工程师',
    missingCertificate: '低压电工证',
    positionTone: 'red',
  },
];

export const filterCertificateTotals: Record<CertificateFilter, number> = {
  all: 153,
  'high-voltage': 68,
  'low-voltage': 72,
  'height-work': 7,
};

export const CERTIFICATE_MONTHS = [
  '2025-05',
  '2025-06',
  '2025-07',
  '2025-08',
  '2025-09',
  '2025-10',
  '2025-11',
  '2025-12',
] as const;

export type CertificateMonth = string;
export type CertificateCategoryFilter = Exclude<CertificateFilter, 'all'>;
export type CertificateHeatLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface CertificateCalendarBlank {
  kind: 'blank';
  key: string;
}

export interface CertificateCalendarDay {
  kind: 'day';
  key: string;
  date: string;
  day: number;
  count: number;
  level: CertificateHeatLevel;
}

export type CertificateCalendarCell =
  | CertificateCalendarBlank
  | CertificateCalendarDay;

export interface CertificateExpiryCalendar {
  cells: CertificateCalendarCell[];
  total: number;
}

export interface CertificateExpiryEvent {
  id: string;
  personId: string;
  personName: string;
  building: string;
  category: CertificateCategoryFilter;
  certificateName: string;
  date: string;
}

const CERTIFICATE_CATEGORY_FILTERS: readonly CertificateCategoryFilter[] = [
  'high-voltage',
  'low-voltage',
  'height-work',
];

const CERTIFICATE_FILTERS: readonly CertificateFilter[] = [
  'all',
  ...CERTIFICATE_CATEGORY_FILTERS,
];

const CERTIFICATE_MONTH_TOTALS: Record<
  CertificateCategoryFilter,
  readonly number[]
> = {
  'high-voltage': [8, 9, 7, 10, 8, 9, 8, 9],
  'low-voltage': [9, 8, 10, 9, 8, 10, 9, 9],
  'height-work': [1, 1, 1, 1, 1, 1, 0, 1],
};

const CERTIFICATE_EXPIRY_DAYS: Record<
  CertificateCategoryFilter,
  readonly number[]
> = {
  'high-voltage': [4, 12, 20, 28],
  'low-voltage': [6, 12, 18, 24, 30],
  'height-work': [12],
};

const CERTIFICATE_HEAT_LEVELS = [0, 1, 2, 3, 4, 5, 6] as const;

function isCertificateMonth(value: unknown): value is CertificateMonth {
  return (
    typeof value === 'string' &&
    (CERTIFICATE_MONTHS as readonly string[]).includes(value)
  );
}

function isCertificateFilter(value: unknown): value is CertificateFilter {
  return (
    typeof value === 'string' &&
    (CERTIFICATE_FILTERS as readonly string[]).includes(value)
  );
}

function getCategoryDailyCount(
  monthIndex: number,
  day: number,
  filter: CertificateCategoryFilter,
): number {
  const monthTotal = CERTIFICATE_MONTH_TOTALS[filter][monthIndex] ?? 0;
  const expiryDays = CERTIFICATE_EXPIRY_DAYS[filter];
  const expiryDayIndex = expiryDays.indexOf(day);

  if (expiryDayIndex === -1) {
    return 0;
  }

  const quotient = Math.floor(monthTotal / expiryDays.length);
  const remainder = monthTotal % expiryDays.length;

  return quotient + (expiryDayIndex < remainder ? 1 : 0);
}

function getDailyCount(
  monthIndex: number,
  day: number,
  filter: CertificateFilter,
): number {
  if (filter !== 'all') {
    return getCategoryDailyCount(monthIndex, day, filter);
  }

  return CERTIFICATE_CATEGORY_FILTERS.reduce(
    (total, category) =>
      total + getCategoryDailyCount(monthIndex, day, category),
    0,
  );
}

function toHeatLevel(count: number): CertificateHeatLevel {
  const levelIndex = Math.min(
    CERTIFICATE_HEAT_LEVELS.length - 1,
    Math.max(0, Math.trunc(count)),
  );

  return CERTIFICATE_HEAT_LEVELS[levelIndex] ?? 0;
}

function isCalendarMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function buildCalendarCells(
  month: string,
  getCount: (date: string, day: number) => number,
): CertificateExpiryCalendar {
  if (!isCalendarMonth(month)) {
    throw new RangeError(`Unsupported certificate month: ${String(month)}`);
  }

  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const localMonthIndex = Number(monthText) - 1;
  const firstWeekday = new Date(year, localMonthIndex, 1).getDay();
  const leadingBlankCount = (firstWeekday + 6) % 7;
  const daysInMonth = new Date(year, localMonthIndex + 1, 0).getDate();
  let total = 0;

  const cells = Array.from<unknown, CertificateCalendarCell>(
    { length: 42 },
    (_, slotIndex) => {
      const day = slotIndex - leadingBlankCount + 1;

      if (day < 1 || day > daysInMonth) {
        return {
          kind: 'blank',
          key: `${month}-blank-${slotIndex}`,
        };
      }

      const date = `${month}-${String(day).padStart(2, '0')}`;
      const count = Math.max(0, Math.trunc(getCount(date, day)));
      const level = toHeatLevel(count);
      total += count;

      return {
        kind: 'day',
        key: date,
        date,
        day,
        count,
        level,
      };
    },
  );

  return { cells, total };
}

export function buildExpiryCalendarFromEvents(
  month: string,
  filter: CertificateFilter,
  events: readonly CertificateExpiryEvent[],
): CertificateExpiryCalendar {
  if (!isCertificateFilter(filter)) {
    throw new RangeError(`Unsupported certificate filter: ${String(filter)}`);
  }

  const countsByDate = new Map<string, number>();

  for (const event of events) {
    if (filter !== 'all' && event.category !== filter) {
      continue;
    }

    countsByDate.set(event.date, (countsByDate.get(event.date) ?? 0) + 1);
  }

  return buildCalendarCells(month, (date) => countsByDate.get(date) ?? 0);
}

export function buildExpiryCalendar(
  month: CertificateMonth,
  filter: CertificateFilter,
): CertificateExpiryCalendar {
  if (!isCertificateMonth(month)) {
    throw new RangeError(`Unsupported certificate month: ${String(month)}`);
  }

  if (!isCertificateFilter(filter)) {
    throw new RangeError(`Unsupported certificate filter: ${String(filter)}`);
  }

  const monthIndex = (CERTIFICATE_MONTHS as readonly string[]).indexOf(month);
  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const localMonthIndex = Number(monthText) - 1;
  const firstWeekday = new Date(year, localMonthIndex, 1).getDay();
  const leadingBlankCount = (firstWeekday + 6) % 7;
  const daysInMonth = new Date(year, localMonthIndex + 1, 0).getDate();
  let total = 0;

  const cells = Array.from<unknown, CertificateCalendarCell>(
    { length: 42 },
    (_, slotIndex) => {
      const day = slotIndex - leadingBlankCount + 1;

      if (day < 1 || day > daysInMonth) {
        return {
          kind: 'blank',
          key: `${month}-blank-${slotIndex}`,
        };
      }

      const date = `${month}-${String(day).padStart(2, '0')}`;
      const count = getDailyCount(monthIndex, day, filter);
      const level = toHeatLevel(count);
      total += count;

      return {
        kind: 'day',
        key: date,
        date,
        day,
        count,
        level,
      };
    },
  );

  return { cells, total };
}

export function stepCertificateMonth(
  month: CertificateMonth,
  direction: -1 | 1,
  availableMonths: readonly CertificateMonth[] = CERTIFICATE_MONTHS,
): CertificateMonth | null {
  if (
    !availableMonths.includes(month) ||
    (direction !== -1 && direction !== 1)
  ) {
    return null;
  }

  const currentIndex = availableMonths.indexOf(month);
  const targetIndex = currentIndex + direction;

  if (targetIndex < 0 || targetIndex >= availableMonths.length) {
    return null;
  }

  return availableMonths[targetIndex] ?? null;
}

const HEATMAP_FILTER_OFFSETS: Record<CertificateFilter, number> = {
  all: 0,
  'high-voltage': 1,
  'low-voltage': 3,
  'height-work': 5,
};

export function createHeatmap(filter: CertificateFilter): number[][] {
  const offset = HEATMAP_FILTER_OFFSETS[filter];

  return Array.from({ length: 7 }, (_, rowIndex) =>
    Array.from(
      { length: 24 },
      (_, columnIndex) =>
        (rowIndex * 3 +
          columnIndex * 5 +
          Math.floor(columnIndex / 4) +
          offset) %
        7,
    ),
  );
}
