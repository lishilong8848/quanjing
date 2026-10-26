export type CertificateMetricDetailKey =
  | 'high-voltage'
  | 'low-voltage'
  | 'height-work'
  | 'expiring'
  | 'compliant'
  | 'non-compliant';

export interface CertificatePersonLike {
  id: string;
  name: string;
  building: string;
  position: string;
  team: string;
  complianceStatus: '合规' | '不合规' | '不涉及' | string;
  missingCertificate: string;
  highVoltageValid: boolean;
  lowVoltageValid: boolean;
  heightWorkValid: boolean;
  highVoltageExpiryDate: string | null;
  lowVoltageExpiryDate: string | null;
  heightWorkExpiryDate: string | null;
  expiryReminder: string;
}

export interface CertificateExpiryEventLike {
  id: string;
  personId: string;
  personName: string;
  building: string;
  category: 'high-voltage' | 'low-voltage' | 'height-work';
  certificateName: string;
  date: string;
}

const CERTIFICATE_MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const CERTIFICATE_DATE_PATTERN =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const CERTIFICATE_TIMESTAMP_PATTERN =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;
const CERTIFICATE_CATEGORY_ORDER = {
  'high-voltage': 0,
  'low-voltage': 1,
  'height-work': 2,
} as const;
const CERTIFICATE_DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRING_CERTIFICATE_WINDOW_DAYS = 90;
const EXPIRING_CERTIFICATE_NAME_SOURCE =
  '高压电工证|高压证|低压电工证|低压证|登高证|高处作业证|制冷证';
const EXPIRING_CERTIFICATE_NAME_PATTERN = new RegExp(
  EXPIRING_CERTIFICATE_NAME_SOURCE,
  'g',
);
const EXPIRING_CERTIFICATE_CLAUSE_PATTERN = new RegExp(
  `(?:${EXPIRING_CERTIFICATE_NAME_SOURCE})(?:(?:\\s*(?:、|，|,|和|及|与|/|／)\\s*)(?:${EXPIRING_CERTIFICATE_NAME_SOURCE}))*\\s*将在[^。；;\\r\\n]*?到期`,
  'g',
);
const EXPIRING_CERTIFICATE_NAME_ALIASES: Record<string, string> = {
  高压证: '高压电工证',
  高压电工证: '高压电工证',
  低压证: '低压电工证',
  低压电工证: '低压电工证',
  登高证: '高处作业证',
  高处作业证: '高处作业证',
  制冷证: '制冷证',
};
const SHANGHAI_CERTIFICATE_DATE_FORMATTER = new Intl.DateTimeFormat(
  'en-US-u-ca-gregory-nu-latn',
  {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  },
);

export function selectCertificateMetricPeople<T extends CertificatePersonLike>(
  people: readonly T[],
  key: CertificateMetricDetailKey,
): T[] {
  return people.filter((person) => {
    switch (key) {
      case 'high-voltage':
        return person.highVoltageValid;
      case 'low-voltage':
        return person.lowVoltageValid;
      case 'height-work':
        return person.heightWorkValid;
      case 'expiring':
        return person.expiryReminder.trim().length > 0;
      case 'compliant':
        return person.complianceStatus === '合规';
      case 'non-compliant':
        return person.complianceStatus === '不合规';
    }
  });
}

export function selectCertificateBuildingPeople<
  T extends CertificatePersonLike,
>(
  people: readonly T[],
  building: string,
  series: 'compliant' | 'non-compliant' | 'rate',
): T[] {
  return people.filter(
    (person) =>
      person.building === building &&
      (series === 'rate'
        ? person.complianceStatus === '合规' ||
          person.complianceStatus === '不合规'
        : person.complianceStatus ===
          (series === 'compliant' ? '合规' : '不合规')),
  );
}

export function selectCertificateBuildingRoster<
  T extends CertificatePersonLike,
>(people: readonly T[], building: string): T[] {
  return people.filter((person) => person.building === building);
}

export function summarizeCertificateBuildingPeople(
  people: readonly CertificatePersonLike[],
  building: string,
): { total: number; notApplicable: number; unclassified: number } {
  const roster = selectCertificateBuildingRoster(people, building);
  return {
    total: roster.length,
    notApplicable: roster.filter(
      (person) => person.complianceStatus === '不涉及',
    ).length,
    unclassified: roster.filter(
      (person) =>
        !['合规', '不合规', '不涉及'].includes(person.complianceStatus),
    ).length,
  };
}

function toCalendarDayIndex(
  year: number,
  month: number,
  day: number,
): number | null {
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return timestamp / CERTIFICATE_DAY_MS;
}

function toCertificateDayIndex(value: string): number | null {
  const dateMatch = CERTIFICATE_DATE_PATTERN.exec(value);

  if (dateMatch) {
    return toCalendarDayIndex(
      Number(dateMatch[1]),
      Number(dateMatch[2]),
      Number(dateMatch[3]),
    );
  }

  if (!CERTIFICATE_TIMESTAMP_PATTERN.test(value)) {
    return null;
  }

  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const parts = SHANGHAI_CERTIFICATE_DATE_FORMATTER.formatToParts(timestamp);
  const readPart = (type: 'year' | 'month' | 'day') =>
    Number(parts.find((part) => part.type === type)?.value);

  return toCalendarDayIndex(
    readPart('year'),
    readPart('month'),
    readPart('day'),
  );
}

function normalizeExpiringCertificateName(value: string): string {
  const name = value.trim();

  return EXPIRING_CERTIFICATE_NAME_ALIASES[name] ?? name;
}

export function getExpiringCertificateLabel(
  person: CertificatePersonLike,
  expiryEvents: readonly CertificateExpiryEventLike[],
  referenceDate: string,
): string {
  const names: string[] = [];
  const seenNames = new Set<string>();
  const addName = (value: string) => {
    const name = normalizeExpiringCertificateName(value);

    if (name && !seenNames.has(name)) {
      seenNames.add(name);
      names.push(name);
    }
  };
  const referenceDay = toCertificateDayIndex(referenceDate);

  if (referenceDay !== null) {
    expiryEvents.forEach((event) => {
      if (event.personId !== person.id || !event.certificateName.trim()) {
        return;
      }

      const eventDay = toCertificateDayIndex(event.date);
      const daysUntilExpiry =
        eventDay === null ? null : eventDay - referenceDay;

      if (
        daysUntilExpiry !== null &&
        daysUntilExpiry >= 0 &&
        daysUntilExpiry <= EXPIRING_CERTIFICATE_WINDOW_DAYS
      ) {
        addName(event.certificateName);
      }
    });
  }

  (person.expiryReminder.match(EXPIRING_CERTIFICATE_CLAUSE_PATTERN) ?? [])
    .flatMap((clause) => clause.match(EXPIRING_CERTIFICATE_NAME_PATTERN) ?? [])
    .forEach(addName);

  return `${names.length > 0 ? names.join('、') : '证书名称待核对'} / 临期证件`;
}

export function selectCertificateExpiryEvents<
  T extends CertificateExpiryEventLike,
>(
  events: readonly T[],
  date: string,
  filter: 'all' | CertificateExpiryEventLike['category'],
): T[] {
  if (!CERTIFICATE_DATE_PATTERN.test(date)) {
    return [];
  }

  return events
    .filter(
      (event) =>
        event.date === date && (filter === 'all' || event.category === filter),
    )
    .slice()
    .sort(
      (left, right) =>
        left.personName.localeCompare(right.personName, 'zh-CN') ||
        CERTIFICATE_CATEGORY_ORDER[left.category] -
          CERTIFICATE_CATEGORY_ORDER[right.category] ||
        left.id.localeCompare(right.id),
    );
}

function toMonthIndex(month: string): number | null {
  const match = CERTIFICATE_MONTH_PATTERN.exec(month);

  if (!match) {
    return null;
  }

  return Number(match[1]) * 12 + Number(match[2]) - 1;
}

function fromMonthIndex(monthIndex: number): string {
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;

  return `${year}-${String(month).padStart(2, '0')}`;
}

export function buildCertificateCalendarMonths(
  events: readonly CertificateExpiryEventLike[],
  referenceMonth: string,
): string[] {
  const referenceIndex = toMonthIndex(referenceMonth);

  if (referenceIndex === null) {
    throw new RangeError(`Unsupported certificate month: ${referenceMonth}`);
  }

  const eventMonthIndexes = events
    .map((event) => toMonthIndex(event.date.slice(0, 7)))
    .filter((monthIndex): monthIndex is number => monthIndex !== null);
  const firstMonthIndex = Math.min(referenceIndex, ...eventMonthIndexes);
  const lastMonthIndex = Math.max(referenceIndex, ...eventMonthIndexes);

  return Array.from(
    { length: lastMonthIndex - firstMonthIndex + 1 },
    (_, index) => fromMonthIndex(firstMonthIndex + index),
  );
}
