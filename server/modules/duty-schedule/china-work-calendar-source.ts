import { createHash } from 'node:crypto';

import type { ChinaWorkCalendarYearSnapshot } from '../../../shared/china-work-calendar';

const OFFICIAL_SEARCH_URL = 'https://sousuo.www.gov.cn/search-gov/data';
const REQUIRED_HOLIDAYS = [
  '元旦',
  '春节',
  '清明节',
  '劳动节',
  '端午节',
  '中秋节',
  '国庆节',
] as const;
const BROWSER_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  Referer: 'https://sousuo.www.gov.cn/zcwjk/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
};

interface HttpResponse {
  data: unknown;
}

export interface ChinaWorkCalendarHttpClient {
  get(
    url: string,
    config: {
      timeout: number;
      headers: Record<string, string>;
      params?: Record<string, string | number>;
      responseType?: 'text';
    },
  ): Promise<HttpResponse>;
}

interface NoticeParseInput {
  year: number;
  url: string;
  html: string;
  retrievedAt: string;
}

interface DateToken {
  year: number | null;
  month: number | null;
  day: number;
}

interface DateRange {
  start: string;
  end: string;
  startYear: number;
  endYear: number;
  startMonth: number;
  endMonth: number;
  dates: string[];
}

function assertYear(year: number): void {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new Error('法定节假日日历年份无效');
  }
}

function expectedTitle(year: number): string {
  return `国务院办公厅关于${year}年部分节假日安排的通知`;
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: "'",
    emsp: ' ',
    ensp: ' ',
    gt: '>',
    ldquo: '“',
    lt: '<',
    nbsp: ' ',
    quot: '"',
    rdquo: '”',
    thinsp: ' ',
  };

  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (entity, key: string) => {
      if (key.startsWith('#x') || key.startsWith('#X')) {
        const codePoint = Number.parseInt(key.slice(2), 16);
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      if (key.startsWith('#')) {
        const codePoint = Number.parseInt(key.slice(1), 10);
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      return namedEntities[key.toLowerCase()] ?? entity;
    },
  );
}

function normalizeSearchTitle(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return decodeHtmlEntities(value.replace(/<\/?em\b[^>]*>/gi, ''))
    .replace(/[\s\u00a0\u3000]+/g, '')
    .trim();
}

function isOfficialPolicyUrl(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'www.gov.cn' &&
      parsed.port === '' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname.startsWith('/zhengce/') &&
      /\.html?$/i.test(parsed.pathname) &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}

function collectSearchEntries(
  value: unknown,
  entries: Array<{ title: unknown; url: unknown }>,
  seen: Set<unknown>,
): void {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return;
  }
  seen.add(value);

  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if ('title' in record && 'url' in record) {
      entries.push({ title: record.title, url: record.url });
    }
    Object.values(record).forEach((child) =>
      collectSearchEntries(child, entries, seen),
    );
    return;
  }

  value.forEach((child) => collectSearchEntries(child, entries, seen));
}

export function findOfficialNoticeUrl(
  searchPayload: unknown,
  year: number,
): string | null {
  assertYear(year);
  const entries: Array<{ title: unknown; url: unknown }> = [];
  collectSearchEntries(searchPayload, entries, new Set());
  const title = expectedTitle(year);
  const matches = new Set(
    entries
      .filter(
        (entry) =>
          normalizeSearchTitle(entry.title) === title &&
          isOfficialPolicyUrl(entry.url),
      )
      .map((entry) => entry.url as string),
  );

  if (matches.size > 1) {
    throw new Error(`发现多个 ${year} 年官方节假日通知结果`);
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function extractUcapContent(html: string): string {
  const openingTag =
    /<div\b(?=[^>]*\bid\s*=\s*(["'])UCAP-CONTENT\1)[^>]*>/i.exec(html);
  if (!openingTag || openingTag.index === undefined) {
    throw new Error('官方通知缺少 UCAP-CONTENT 正文');
  }

  const contentStart = openingTag.index + openingTag[0].length;
  const tagPattern = /<\/?div\b[^>]*>/gi;
  tagPattern.lastIndex = contentStart;
  let depth = 1;
  let tag: RegExpExecArray | null;
  while ((tag = tagPattern.exec(html)) !== null) {
    if (/^<\/div/i.test(tag[0])) {
      depth -= 1;
      if (depth === 0) {
        return html.slice(contentStart, tag.index);
      }
    } else if (!/\/>$/.test(tag[0])) {
      depth += 1;
    }
  }

  throw new Error('官方通知 UCAP-CONTENT 正文未闭合');
}

function extractSemanticLines(contentHtml: string): string[] {
  const withBlockBreaks = contentHtml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|td|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  return decodeHtmlEntities(withBlockBreaks)
    .replace(/\r/g, '')
    .split(/\n+/)
    .map((line) => line.replace(/[\t \u00a0\u3000]+/g, ' ').trim())
    .filter(Boolean);
}

function normalizeCompactText(value: string): string {
  return value.replace(/[\s\u00a0\u3000]+/g, '');
}

function toDateKey(year: number, month: number, day: number): string {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    throw new Error('官方通知包含无效日期');
  }

  const key = `${year.toString().padStart(4, '0')}-${month
    .toString()
    .padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  const date = new Date(`${key}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== key) {
    throw new Error(`官方通知包含无效日期：${key}`);
  }
  return key;
}

function parseDateTokens(value: string): DateToken[] {
  const tokens: DateToken[] = [];
  const pattern = /(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})日/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    tokens.push({
      year: match[1] ? Number(match[1]) : null,
      month: match[2] ? Number(match[2]) : null,
      day: Number(match[3]),
    });
  }
  return tokens;
}

function removeParentheticalText(value: string): string {
  let result = value;
  let previous: string;
  do {
    previous = result;
    result = result.replace(/（[^（）]*）|\([^()]*\)/g, '');
  } while (result !== previous);
  return result;
}

function expandDateRange(start: string, end: string): string[] {
  const startTime = Date.parse(`${start}T00:00:00.000Z`);
  const endTime = Date.parse(`${end}T00:00:00.000Z`);
  if (
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    endTime < startTime
  ) {
    throw new Error('官方通知放假日期范围无效');
  }

  const dayCount = Math.floor((endTime - startTime) / 86_400_000) + 1;
  if (dayCount > 31) {
    throw new Error('官方通知放假日期范围异常');
  }

  return Array.from({ length: dayCount }, (_, index) =>
    new Date(startTime + index * 86_400_000).toISOString().slice(0, 10),
  );
}

function parseHolidayRange(expression: string, year: number): DateRange {
  const cleaned = removeParentheticalText(expression);
  const tokens = parseDateTokens(cleaned);
  if (tokens.length < 1 || tokens.length > 2 || tokens[0].month === null) {
    throw new Error(`无法确定放假日期：${expression}`);
  }
  if (tokens.length === 2 && !/至|到/.test(cleaned)) {
    throw new Error(`放假日期不是连续范围：${expression}`);
  }

  const startToken = tokens[0];
  const endToken = tokens[1] ?? startToken;
  const startMonth = startToken.month;
  const endMonth = endToken.month ?? startMonth;
  let startYear: number;
  let endYear: number;

  if (startToken.year !== null && endToken.year !== null) {
    startYear = startToken.year;
    endYear = endToken.year;
  } else if (startToken.year !== null) {
    startYear = startToken.year;
    endYear = startYear + (endMonth < startMonth ? 1 : 0);
  } else if (endToken.year !== null) {
    endYear = endToken.year;
    startYear = endYear - (startMonth > endMonth ? 1 : 0);
  } else if (startMonth > endMonth) {
    startYear = year - 1;
    endYear = year;
  } else {
    startYear = year;
    endYear = year;
  }

  if (
    Math.abs(startYear - year) > 1 ||
    Math.abs(endYear - year) > 1 ||
    (startYear !== year && endYear !== year)
  ) {
    throw new Error('官方通知放假范围与目标年份不一致');
  }

  const start = toDateKey(startYear, startMonth, startToken.day);
  const end = toDateKey(endYear, endMonth, endToken.day);
  return {
    start,
    end,
    startYear,
    endYear,
    startMonth,
    endMonth,
    dates: expandDateRange(start, end),
  };
}

function inferAdjustedYear(
  targetYear: number,
  month: number,
  range: DateRange,
): number {
  if (range.startYear !== range.endYear) {
    return month >= range.startMonth ? range.startYear : range.endYear;
  }
  return targetYear;
}

function parseAdjustedWorkdays(
  details: string,
  year: number,
  holidayRange: DateRange,
): string[] {
  const workdays: string[] = [];
  for (const clause of details.split(/[。；;]/)) {
    if (!clause.includes('上班')) {
      continue;
    }

    const tokens = parseDateTokens(removeParentheticalText(clause));
    if (tokens.length === 0) {
      throw new Error(`无法确定调休上班日期：${clause}`);
    }

    let inheritedMonth: number | null = null;
    for (const token of tokens) {
      const month = token.month ?? inheritedMonth;
      if (month === null) {
        throw new Error(`调休上班日期缺少月份：${clause}`);
      }
      inheritedMonth = month;
      const resolvedYear =
        token.year ?? inferAdjustedYear(year, month, holidayRange);
      if (Math.abs(resolvedYear - year) > 1) {
        throw new Error('调休上班日期与目标年份不一致');
      }
      workdays.push(toDateKey(resolvedYear, month, token.day));
    }
  }
  return workdays;
}

function declaredHolidayDays(details: string): number | null {
  const match =
    /共\s*(\d+)\s*天/.exec(details) ??
    /放假(?:调休)?\s*(\d+)\s*天/.exec(details);
  return match ? Number(match[1]) : null;
}

function sectionHolidayNames(header: string): string[] {
  const names = normalizeCompactText(header)
    .replace(/[和及]/g, '、')
    .split('、')
    .filter(Boolean);
  if (
    names.length < 1 ||
    names.length > 2 ||
    names.some(
      (name) => !(REQUIRED_HOLIDAYS as readonly string[]).includes(name),
    )
  ) {
    throw new Error(`官方通知包含未知节日段落：${header}`);
  }
  return names;
}

function parsePublicationDate(value: string): string {
  const match = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(
    normalizeCompactText(value),
  );
  if (!match) {
    throw new Error('官方通知缺少有效发布日期');
  }
  return toDateKey(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function parseOfficialHolidayNotice({
  year,
  url,
  html,
  retrievedAt,
}: NoticeParseInput): ChinaWorkCalendarYearSnapshot {
  assertYear(year);
  if (!isOfficialPolicyUrl(url)) {
    throw new Error('官方通知 URL 不可信');
  }
  if (typeof html !== 'string' || html.length === 0) {
    throw new Error('官方通知正文为空');
  }
  if (Number.isNaN(Date.parse(retrievedAt))) {
    throw new Error('官方通知抓取时间无效');
  }

  const contentHtml = extractUcapContent(html);
  const lines = extractSemanticLines(contentHtml);
  const compactBody = normalizeCompactText(lines.join(''));
  if (!compactBody.includes('经国务院批准')) {
    throw new Error('官方通知缺少国务院批准语义');
  }

  const noticeNumberPattern = /^国办发明电〔(\d{4})〕(\d+)号$/;
  const noticeIndex = lines.findIndex((line) =>
    noticeNumberPattern.test(normalizeCompactText(line)),
  );
  if (noticeIndex < 1) {
    throw new Error('官方通知缺少有效国办发明电文号');
  }
  const title = normalizeCompactText(lines.slice(0, noticeIndex).join(''));
  if (title !== expectedTitle(year)) {
    throw new Error('官方通知标题与目标年份不匹配');
  }
  const noticeNumber = normalizeCompactText(lines[noticeIndex]);
  const noticeMatch = noticeNumberPattern.exec(noticeNumber);
  if (!noticeMatch) {
    throw new Error('官方通知文号无效');
  }

  const officeIndex = lines.findIndex(
    (line, index) =>
      index > noticeIndex && normalizeCompactText(line) === '国务院办公厅',
  );
  if (officeIndex < 0 || officeIndex + 1 >= lines.length) {
    throw new Error('官方通知缺少国务院办公厅落款');
  }
  const publishedAt = parsePublicationDate(lines[officeIndex + 1]);
  if (Number(noticeMatch[1]) !== Number(publishedAt.slice(0, 4))) {
    throw new Error('官方通知文号年份与发布日期不一致');
  }

  const sectionPattern = /^[一二三四五六七八九十]+、([^：:]+)[：:](.+)$/;
  const sections = lines
    .map((line) => sectionPattern.exec(normalizeCompactText(line)))
    .filter((match): match is RegExpExecArray => match !== null);
  const holidayOccurrences = new Map<string, number>();
  const holidays: Record<string, string> = {};
  const adjustedWorkdays = new Set<string>();

  for (const section of sections) {
    const names = sectionHolidayNames(section[1]);
    names.forEach((name) =>
      holidayOccurrences.set(name, (holidayOccurrences.get(name) ?? 0) + 1),
    );

    const details = section[2];
    const holidayMarker = details.indexOf('放假');
    if (holidayMarker <= 0) {
      throw new Error(`节日段落缺少放假日期：${section[1]}`);
    }
    const holidayRange = parseHolidayRange(
      details.slice(0, holidayMarker),
      year,
    );
    const declaredDays = declaredHolidayDays(details);
    if (declaredDays !== null && declaredDays !== holidayRange.dates.length) {
      throw new Error(`节日放假天数与日期范围不一致：${section[1]}`);
    }
    const holidayName = names.join('、');
    holidayRange.dates.forEach((date) => {
      if (holidays[date]) {
        throw new Error(`官方通知存在重复放假日期：${date}`);
      }
      holidays[date] = holidayName;
    });
    parseAdjustedWorkdays(details, year, holidayRange).forEach((date) =>
      adjustedWorkdays.add(date),
    );
  }

  for (const holidayName of REQUIRED_HOLIDAYS) {
    if (holidayOccurrences.get(holidayName) !== 1) {
      throw new Error(`官方通知缺少或重复节日语义：${holidayName}`);
    }
  }
  if (sections.length < 6 || sections.length > 7) {
    throw new Error('官方通知节日段落数量异常');
  }
  for (const date of adjustedWorkdays) {
    if (holidays[date]) {
      throw new Error(`放假日期与调休上班日期重叠：${date}`);
    }
  }

  return {
    year,
    source: `中国政府网《${title}》（${noticeNumber}）`,
    sourceUrl: url,
    noticeNumber,
    publishedAt,
    retrievedAt,
    contentHash: createHash('sha256').update(compactBody).digest('hex'),
    holidays,
    adjustedWorkdays: [...adjustedWorkdays].sort(),
  };
}

export async function fetchOfficialChinaWorkCalendar(
  http: ChinaWorkCalendarHttpClient,
  year: number,
  timeoutMs: number,
): Promise<ChinaWorkCalendarYearSnapshot | null> {
  assertYear(year);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('法定节假日数据请求超时配置无效');
  }

  const title = expectedTitle(year);
  const searchResponse = await http.get(OFFICIAL_SEARCH_URL, {
    timeout: timeoutMs,
    headers: BROWSER_HEADERS,
    params: {
      n: 10,
      p: 1,
      q: title,
      searchfield: 'title',
      t: 'zhengcelibrary',
    },
  });
  if (searchResponse.data && typeof searchResponse.data === 'object') {
    const searchResult = searchResponse.data as {
      code?: unknown;
      searchVO?: unknown;
    };
    if (searchResult.code === 1001 && searchResult.searchVO == null) {
      return null;
    }
    if ('code' in searchResult && searchResult.code !== 200) {
      throw new Error('中国政府网政策搜索请求失败');
    }
  }

  const noticeUrl = findOfficialNoticeUrl(searchResponse.data, year);
  if (!noticeUrl) {
    return null;
  }

  const noticeResponse = await http.get(noticeUrl, {
    timeout: timeoutMs,
    headers: BROWSER_HEADERS,
    responseType: 'text',
  });
  if (typeof noticeResponse.data !== 'string') {
    throw new Error('中国政府网节假日通知响应不是 HTML');
  }

  return parseOfficialHolidayNotice({
    year,
    url: noticeUrl,
    html: noticeResponse.data,
    retrievedAt: new Date().toISOString(),
  });
}
