/**
 * 中国法定节假日工作日历。
 *
 * 2026 年数据来源：
 * 中国政府网《国务院办公厅关于2026年部分节假日安排的通知》
 * https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
 */

export type ChinaWorkdayKind =
  | 'holiday'
  | 'adjusted_workday'
  | 'weekend_rest'
  | 'weekday'
  | 'calendar_data_missing';

export interface ChinaWorkdayInfo {
  dateKey: string;
  kind: ChinaWorkdayKind;
  isWorkday: boolean;
  supported: boolean;
  name?: string;
  source?: string;
}

export interface HolidayInfo {
  name: string;
  isHoliday: boolean;
  isAdjustedWorkday: boolean;
  source?: string;
}

export interface LongWhiteRestInfo {
  isRestDay: boolean;
  reason: string;
  isOfficialHoliday: boolean;
  isAdjustedWorkday: boolean;
}

export interface ChinaWorkCalendarYearSnapshot {
  year: number;
  source: string;
  sourceUrl: string;
  noticeNumber: string;
  publishedAt: string;
  retrievedAt: string;
  contentHash: string;
  holidays: Record<string, string>;
  adjustedWorkdays: string[];
}

export interface ChinaWorkCalendarSnapshot {
  schemaVersion: 1;
  years: ChinaWorkCalendarYearSnapshot[];
}

export interface ChinaWorkCalendarMaintenanceStatus {
  enabled: boolean;
  refreshing: boolean;
  supportedYears: number[];
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  nextCheckAt?: string;
  lastError?: string;
}

export interface ChinaWorkCalendarResponse {
  snapshot: ChinaWorkCalendarSnapshot;
  status: ChinaWorkCalendarMaintenanceStatus;
}

interface ChinaWorkCalendarYear {
  source: string;
  holidays: Readonly<Record<string, string>>;
  adjustedWorkdays: ReadonlySet<string>;
}

interface IndexedCalendarException {
  ownerYear: number;
  kind: 'holiday' | 'adjusted_workday';
  name: string;
  source: string;
}

const OFFICIAL_2026_NOTICE_NAME =
  '中国政府网《国务院办公厅关于2026年部分节假日安排的通知》';
const OFFICIAL_2026_NOTICE_NUMBER = '国办发明电〔2025〕7号';
const OFFICIAL_2026_SOURCE = `${OFFICIAL_2026_NOTICE_NAME}（${OFFICIAL_2026_NOTICE_NUMBER}）`;
const OFFICIAL_2026_SOURCE_URL =
  'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm';

/**
 * 国务院办公厅 2026 年放假调休日历。
 * 仅包含官方通知明确的放假日，不把普通周末混入节假日。
 */
const OFFICIAL_2026_HOLIDAYS: Readonly<Record<string, string>> = {
  '2026-01-01': '元旦',
  '2026-01-02': '元旦',
  '2026-01-03': '元旦',

  '2026-02-15': '春节',
  '2026-02-16': '春节',
  '2026-02-17': '春节',
  '2026-02-18': '春节',
  '2026-02-19': '春节',
  '2026-02-20': '春节',
  '2026-02-21': '春节',
  '2026-02-22': '春节',
  '2026-02-23': '春节',

  '2026-04-04': '清明节',
  '2026-04-05': '清明节',
  '2026-04-06': '清明节',

  '2026-05-01': '劳动节',
  '2026-05-02': '劳动节',
  '2026-05-03': '劳动节',
  '2026-05-04': '劳动节',
  '2026-05-05': '劳动节',

  '2026-06-19': '端午节',
  '2026-06-20': '端午节',
  '2026-06-21': '端午节',

  '2026-09-25': '中秋节',
  '2026-09-26': '中秋节',
  '2026-09-27': '中秋节',

  '2026-10-01': '国庆节',
  '2026-10-02': '国庆节',
  '2026-10-03': '国庆节',
  '2026-10-04': '国庆节',
  '2026-10-05': '国庆节',
  '2026-10-06': '国庆节',
  '2026-10-07': '国庆节',
};

/**
 * 官方通知明确要求上班的调休日期。
 * 这些日期即使落在周六/周日，也应按工作日处理。
 */
const OFFICIAL_2026_ADJUSTED_WORKDAYS: ReadonlySet<string> = new Set([
  '2026-01-04',
  '2026-02-14',
  '2026-02-28',
  '2026-05-09',
  '2026-09-20',
  '2026-10-10',
]);

const BUNDLED_CHINA_WORK_CALENDAR_SNAPSHOT: ChinaWorkCalendarSnapshot = {
  schemaVersion: 1,
  years: [
    {
      year: 2026,
      source: OFFICIAL_2026_SOURCE,
      sourceUrl: OFFICIAL_2026_SOURCE_URL,
      noticeNumber: OFFICIAL_2026_NOTICE_NUMBER,
      publishedAt: '2025-11-04T00:00:00.000+08:00',
      retrievedAt: '2026-08-03T00:00:00.000+08:00',
      contentHash:
        'c20faa5c930c1779785484f7b2a846c71b296ebfc259d2bcbf1beb70ec1a0441',
      holidays: { ...OFFICIAL_2026_HOLIDAYS },
      adjustedWorkdays: [...OFFICIAL_2026_ADJUSTED_WORKDAYS],
    },
  ],
};

const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function formatShanghaiDateKey(date: Date): string | null {
  const parts = SHANGHAI_DATE_FORMATTER.formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  return year && month && day ? `${year}-${month}-${day}` : null;
}

function normalizeDateKey(date: Date | string): string | null {
  let dateKey: string;

  if (typeof date === 'string') {
    dateKey = date;
  } else {
    if (Number.isNaN(date.getTime())) {
      return null;
    }

    const shanghaiDateKey = formatShanghaiDateKey(date);
    if (!shanghaiDateKey) {
      return null;
    }
    dateKey = shanghaiDateKey;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return null;
  }

  const parsedDate = new Date(`${dateKey}T00:00:00.000Z`);
  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== dateKey
  ) {
    return null;
  }

  return dateKey;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象`);
  }

  return value as Record<string, unknown>;
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
  path: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path}.${field} 必须是非空字符串`);
  }

  return value.trim();
}

function requiredIsoDateString(
  record: Record<string, unknown>,
  field: string,
  path: string,
): string {
  const value = requiredString(record, field, path);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${path}.${field} 必须是有效日期时间`);
  }

  return value;
}

function validateExceptionDate(
  dateKey: string,
  calendarYear: number,
  field: string,
): string {
  const normalized = normalizeDateKey(dateKey);
  if (!normalized) {
    throw new Error(`${field} 包含无效日期 ${dateKey}`);
  }

  const dateYear = Number(normalized.slice(0, 4));
  if (Math.abs(dateYear - calendarYear) > 1) {
    throw new Error(`${field} 日期 ${dateKey} 必须位于目标 year 的前后一年内`);
  }

  return normalized;
}

function validateYearSnapshot(
  value: unknown,
  index: number,
): ChinaWorkCalendarYearSnapshot {
  const path = `years[${index}]`;
  const record = asRecord(value, path);
  const year = record.year;
  if (!Number.isInteger(year) || Number(year) < 1949 || Number(year) > 9999) {
    throw new Error(`${path}.year 必须是有效的四位年份`);
  }

  const calendarYear = Number(year);
  const source = requiredString(record, 'source', path);
  for (const keyword of [
    '中国政府网',
    '国务院办公厅',
    `${calendarYear}年`,
    '节假日',
  ]) {
    if (!source.includes(keyword)) {
      throw new Error(`${path}.source 缺少官方通知关键字：${keyword}`);
    }
  }

  const sourceUrl = requiredString(record, 'sourceUrl', path);
  let parsedSourceUrl: URL;
  try {
    parsedSourceUrl = new URL(sourceUrl);
  } catch {
    throw new Error(`${path}.sourceUrl 必须是有效官方地址`);
  }
  if (
    parsedSourceUrl.protocol !== 'https:' ||
    parsedSourceUrl.hostname !== 'www.gov.cn' ||
    parsedSourceUrl.port !== '' ||
    parsedSourceUrl.username !== '' ||
    parsedSourceUrl.password !== '' ||
    !parsedSourceUrl.pathname.startsWith('/zhengce/') ||
    parsedSourceUrl.hash !== ''
  ) {
    throw new Error(
      `${path}.sourceUrl 必须是 https://www.gov.cn/zhengce/ 官方政策地址`,
    );
  }

  const noticeNumber = requiredString(record, 'noticeNumber', path);
  if (!/^国办发明电〔\d{4}〕\d+号$/.test(noticeNumber)) {
    throw new Error(`${path}.noticeNumber 不是有效国办发明电文号`);
  }
  if (!source.includes(noticeNumber)) {
    throw new Error(`${path}.source 未包含 noticeNumber`);
  }
  const publishedAt = requiredIsoDateString(record, 'publishedAt', path);
  const retrievedAt = requiredIsoDateString(record, 'retrievedAt', path);
  const contentHash = requiredString(record, 'contentHash', path);
  if (!/^[0-9a-f]{64}$/.test(contentHash)) {
    throw new Error(`${path}.contentHash 必须是 64 位 SHA-256 哈希`);
  }

  const holidayRecord = asRecord(record.holidays, `${path}.holidays`);
  const holidayEntries = Object.entries(holidayRecord);
  if (holidayEntries.length < 7 || holidayEntries.length > 100) {
    throw new Error(`${path}.holidays 不是完整年度数据（至少 7 天）`);
  }

  const holidays: Record<string, string> = {};
  for (const [rawDateKey, rawName] of holidayEntries.sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const dateKey = validateExceptionDate(
      rawDateKey,
      calendarYear,
      `${path}.holidays`,
    );
    if (typeof rawName !== 'string' || rawName.trim().length === 0) {
      throw new Error(`${path}.holidays.${rawDateKey} 必须有节假日名称`);
    }
    holidays[dateKey] = rawName.trim();
  }

  if (!Array.isArray(record.adjustedWorkdays)) {
    throw new Error(`${path}.adjustedWorkdays 必须是数组`);
  }
  if (record.adjustedWorkdays.length > 60) {
    throw new Error(`${path}.adjustedWorkdays 数量不合理`);
  }

  const adjustedWorkdaySet = new Set<string>();
  for (const rawDateKey of record.adjustedWorkdays) {
    if (typeof rawDateKey !== 'string') {
      throw new Error(`${path}.adjustedWorkdays 包含非字符串日期`);
    }
    const dateKey = validateExceptionDate(
      rawDateKey,
      calendarYear,
      `${path}.adjustedWorkdays`,
    );
    if (adjustedWorkdaySet.has(dateKey)) {
      throw new Error(`${path}.adjustedWorkdays 包含重复日期 ${dateKey}`);
    }
    if (holidays[dateKey]) {
      throw new Error(`节假日与调休上班日重叠：${dateKey}`);
    }
    adjustedWorkdaySet.add(dateKey);
  }

  return {
    year: calendarYear,
    source,
    sourceUrl,
    noticeNumber,
    publishedAt,
    retrievedAt,
    contentHash,
    holidays,
    adjustedWorkdays: [...adjustedWorkdaySet].sort(),
  };
}

export function validateChinaWorkCalendarSnapshot(
  value: unknown,
): ChinaWorkCalendarSnapshot {
  const record = asRecord(value, '工作日历快照');
  if (record.schemaVersion !== 1) {
    throw new Error('schemaVersion 必须为 1');
  }
  if (!Array.isArray(record.years) || record.years.length === 0) {
    throw new Error('years 必须是非空数组');
  }

  const years = record.years.map(validateYearSnapshot);
  const uniqueYears = new Set(years.map(({ year }) => year));
  if (uniqueYears.size !== years.length) {
    throw new Error('years 不能包含重复年份');
  }

  return {
    schemaVersion: 1,
    years: years.sort((left, right) => left.year - right.year),
  };
}

function cloneSnapshot(
  snapshot: ChinaWorkCalendarSnapshot,
): ChinaWorkCalendarSnapshot {
  return {
    schemaVersion: 1,
    years: snapshot.years.map((year) => ({
      ...year,
      holidays: { ...year.holidays },
      adjustedWorkdays: [...year.adjustedWorkdays],
    })),
  };
}

function createRuntimeCalendarState(snapshot: ChinaWorkCalendarSnapshot): {
  calendars: Readonly<Record<string, ChinaWorkCalendarYear>>;
  exceptions: Readonly<Record<string, IndexedCalendarException>>;
} {
  const calendars: Record<string, ChinaWorkCalendarYear> = {};
  const exceptions: Record<string, IndexedCalendarException> = {};

  const addException = (
    dateKey: string,
    exception: IndexedCalendarException,
  ) => {
    const existing = exceptions[dateKey];
    const dateYear = Number(dateKey.slice(0, 4));
    const exceptionOwnsDate = exception.ownerYear === dateYear;
    const existingOwnsDate = existing?.ownerYear === dateYear;
    if (
      !existing ||
      (exceptionOwnsDate && !existingOwnsDate) ||
      (!exceptionOwnsDate &&
        !existingOwnsDate &&
        exception.ownerYear > existing.ownerYear)
    ) {
      exceptions[dateKey] = exception;
    }
  };

  for (const year of snapshot.years) {
    calendars[String(year.year)] = {
      source: year.source,
      holidays: { ...year.holidays },
      adjustedWorkdays: new Set(year.adjustedWorkdays),
    };
    for (const [dateKey, name] of Object.entries(year.holidays)) {
      addException(dateKey, {
        ownerYear: year.year,
        kind: 'holiday',
        name,
        source: year.source,
      });
    }
    for (const dateKey of year.adjustedWorkdays) {
      addException(dateKey, {
        ownerYear: year.year,
        kind: 'adjusted_workday',
        name: '调休上班',
        source: year.source,
      });
    }
  }

  return { calendars, exceptions };
}

let activeSnapshot = validateChinaWorkCalendarSnapshot(
  BUNDLED_CHINA_WORK_CALENDAR_SNAPSHOT,
);
const initialRuntimeState = createRuntimeCalendarState(activeSnapshot);
let activeCalendars = initialRuntimeState.calendars;
let activeExceptions = initialRuntimeState.exceptions;

export function installChinaWorkCalendarSnapshot(
  snapshot: ChinaWorkCalendarSnapshot,
): boolean {
  const normalized = validateChinaWorkCalendarSnapshot(snapshot);
  const mergedYears = new Map(
    activeSnapshot.years.map((year) => [year.year, year] as const),
  );
  for (const year of normalized.years) {
    mergedYears.set(year.year, year);
  }

  const candidate: ChinaWorkCalendarSnapshot = {
    schemaVersion: 1,
    years: [...mergedYears.values()].sort(
      (left, right) => left.year - right.year,
    ),
  };
  if (JSON.stringify(candidate) === JSON.stringify(activeSnapshot)) {
    return false;
  }

  const candidateRuntimeState = createRuntimeCalendarState(candidate);
  activeSnapshot = candidate;
  activeCalendars = candidateRuntimeState.calendars;
  activeExceptions = candidateRuntimeState.exceptions;
  return true;
}

export function getChinaWorkCalendarSnapshot(): ChinaWorkCalendarSnapshot {
  return cloneSnapshot(activeSnapshot);
}

function getInputDateKey(date: Date | string): string {
  return typeof date === 'string' ? date : '';
}

function createMissingCalendarInfo(
  dateKey: string,
  name: string,
): ChinaWorkdayInfo {
  return {
    dateKey,
    kind: 'calendar_data_missing',
    isWorkday: false,
    supported: false,
    name,
  };
}

export function getChinaWorkdayInfo(date: Date | string): ChinaWorkdayInfo {
  const dateKey = normalizeDateKey(date);
  if (!dateKey) {
    return createMissingCalendarInfo(getInputDateKey(date), '日期格式无效');
  }

  const explicitException = activeExceptions[dateKey];
  if (explicitException) {
    return {
      dateKey,
      kind: explicitException.kind,
      isWorkday: explicitException.kind === 'adjusted_workday',
      supported: true,
      name: explicitException.name,
      source: explicitException.source,
    };
  }

  const year = dateKey.slice(0, 4);
  const calendar = activeCalendars[year];
  if (!calendar) {
    return createMissingCalendarInfo(dateKey, `缺少 ${year} 年法定节假日日历`);
  }

  const holidayName = calendar.holidays[dateKey];
  if (holidayName) {
    return {
      dateKey,
      kind: 'holiday',
      isWorkday: false,
      supported: true,
      name: holidayName,
      source: calendar.source,
    };
  }

  if (calendar.adjustedWorkdays.has(dateKey)) {
    return {
      dateKey,
      kind: 'adjusted_workday',
      isWorkday: true,
      supported: true,
      name: '调休上班',
      source: calendar.source,
    };
  }

  const dayOfWeek = new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  return {
    dateKey,
    kind: isWeekend ? 'weekend_rest' : 'weekday',
    isWorkday: !isWeekend,
    supported: true,
    name: isWeekend ? '周末' : '工作日',
    source: calendar.source,
  };
}

export function getHolidayInfo(date: Date | string): HolidayInfo {
  const workdayInfo = getChinaWorkdayInfo(date);
  const result: HolidayInfo = {
    name: workdayInfo.kind === 'holiday' ? workdayInfo.name || '' : '',
    isHoliday: workdayInfo.kind === 'holiday',
    isAdjustedWorkday: workdayInfo.kind === 'adjusted_workday',
  };

  if (workdayInfo.source) {
    result.source = workdayInfo.source;
  }

  return result;
}

export function getLongWhiteRestInfo(date: Date | string): LongWhiteRestInfo {
  const workdayInfo = getChinaWorkdayInfo(date);

  return {
    isRestDay: !workdayInfo.isWorkday,
    reason: workdayInfo.name || '日期格式无效',
    isOfficialHoliday: workdayInfo.kind === 'holiday',
    isAdjustedWorkday: workdayInfo.kind === 'adjusted_workday',
  };
}
