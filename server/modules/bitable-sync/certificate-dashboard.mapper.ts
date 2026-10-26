import type {
  CampusCertificateBuildingCompliance,
  CampusCertificateComplianceStatus,
  CampusCertificateDashboardResponse,
  CampusCertificateExpiryEvent,
  CampusCertificateMetric,
  CampusCertificateNonCompliantPerson,
  CampusCertificatePerson,
} from '../../../shared/api.interface';
import {
  type BitableRecordItem,
  extractDateTimeIso,
  extractDateValue,
  extractDisplayText,
  extractDisplayValues,
  getRecordId,
  pickField,
} from '../../common/feishu/bitable-direct-read';

const TARGET_QUALIFIED = 90;
const BUILDING_ORDER = [
  '110站',
  'A楼',
  'H楼',
  'D楼',
  'E楼',
  'C楼',
  'B楼',
] as const;

const COMPLIANCE_OPTION_STATUS: Record<
  string,
  CampusCertificateComplianceStatus
> = {
  optr63Dphp: '合规',
  optixgST5g: '不涉及',
  optU2Gi5Q4: '不合规',
};

const BUILDING_OPTION_LABEL: Record<string, (typeof BUILDING_ORDER)[number]> = {
  opt8Ll1tGG: '110站',
  optoYag9Yd: 'A楼',
  opt601tBh1: 'H楼',
  opt34QiiO3: 'D楼',
  optciYId6U: 'E楼',
  optSnsb7yW: 'C楼',
  optlwTsAAK: 'B楼',
};

const METRIC_DEFINITIONS: Array<
  Omit<CampusCertificateMetric, 'value'> & {
    select: (person: CampusCertificatePerson) => boolean;
  }
> = [
  {
    id: 'high-voltage',
    label: '高压电工资质持有情况',
    tone: 'blue',
    select: (person) => person.highVoltageValid,
  },
  {
    id: 'low-voltage',
    label: '低压电工资质持有情况',
    tone: 'green',
    select: (person) => person.lowVoltageValid,
  },
  {
    id: 'height-work',
    label: '高处作业资质持有情况',
    tone: 'red',
    select: (person) => person.heightWorkValid,
  },
  {
    id: 'expiring',
    label: '证件90天内到期',
    tone: 'orange',
    select: (person) => Boolean(person.expiryReminder),
  },
];

const EXPIRY_DEFINITIONS = [
  {
    key: 'highVoltageExpiryDate',
    category: 'high-voltage',
    certificateName: '高压电工证',
  },
  {
    key: 'lowVoltageExpiryDate',
    category: 'low-voltage',
    certificateName: '低压电工证',
  },
  {
    key: 'heightWorkExpiryDate',
    category: 'height-work',
    certificateName: '高处作业证',
  },
] as const;

export function mapCampusCertificateDashboard(
  records: BitableRecordItem[],
  syncedAt: string,
): CampusCertificateDashboardResponse {
  const people = records.map((record, index) =>
    mapPerson(record, index, syncedAt),
  );
  const certificateMetrics = METRIC_DEFINITIONS.map(
    ({ select, ...definition }) => ({
      ...definition,
      value: people.filter(select).length,
    }),
  );
  const compliantPeople = countStatus(people, '合规');
  const nonCompliantPeopleCount = countStatus(people, '不合规');
  const notApplicablePeople = countStatus(people, '不涉及');
  const currentQualified = Math.max(
    0,
    TARGET_QUALIFIED - nonCompliantPeopleCount,
  );
  const totalCertificates = certificateMetrics
    .filter((metric) => metric.id !== 'expiring')
    .reduce((total, metric) => total + metric.value, 0);

  return {
    summary: {
      totalPeople: people.length,
      compliantPeople,
      nonCompliantPeople: nonCompliantPeopleCount,
      notApplicablePeople,
      currentQualified,
      targetQualified: TARGET_QUALIFIED,
      complianceRate: roundOne((currentQualified / TARGET_QUALIFIED) * 100),
      totalCertificates,
      averageComplianceRate:
        totalCertificates > 0
          ? roundOne(100 - (nonCompliantPeopleCount / totalCertificates) * 100)
          : 0,
    },
    certificateMetrics,
    buildingCompliance: buildBuildingCompliance(people),
    nonCompliantPeople: people
      .filter((person) => person.complianceStatus === '不合规')
      .map(mapNonCompliantPerson),
    people,
    expiryEvents: buildExpiryEvents(people),
    sourceUpdatedAt: findLatestSourceUpdate(records),
    syncedAt,
    sourceStatus: 'fresh',
  };
}

function mapPerson(
  record: BitableRecordItem,
  index: number,
  syncedAt: string,
): CampusCertificatePerson {
  const fields = record.fields || {};
  const missingCertificate = displayText(
    pickField(fields, ['缺少证书', '缺失证书']),
  );
  const certificateSummary = displayText(
    pickField(fields, ['持证统计', '持证打标']),
  );
  const directBuilding = [
    ...extractDisplayValues(pickField(fields, ['楼栋'])),
    ...extractDisplayValues(pickField(fields, ['机楼/专业', '机楼专业'])),
  ];

  const highVoltageExpiryDate = certificateExpiryDate(
    pickField(fields, ['高压证-到期日期', '高压证到期日期']),
  );
  const lowVoltageExpiryDate = certificateExpiryDate(
    pickField(fields, ['低压证-到期日期', '低压证到期日期']),
  );
  const heightWorkExpiryDate = certificateExpiryDate(
    pickField(fields, ['登高证-到期日期', '登高证到期日期']),
  );
  const sourceReminder = displayText(
    pickField(fields, ['月度临期提示', '临期提示']),
  );

  return {
    id: getRecordId(record) || `certificate-person-${index + 1}`,
    name: displayText(pickField(fields, ['姓名', '员工姓名'])) || '未命名',
    building: findBuilding(directBuilding),
    position: displayText(pickField(fields, ['岗位', '体系岗位'])) || '未填写',
    team: displayText(pickField(fields, ['班组'])) || '未填写',
    complianceStatus: normalizeComplianceStatus(
      displayText(pickField(fields, ['证书是否合规', '持证是否合规'])),
    ),
    missingCertificate,
    highVoltageValid: resolveValidity(
      pickField(fields, ['高压证-是否有效', '高压证是否有效']),
      certificateSummary,
      '高压电工证',
    ),
    lowVoltageValid: resolveValidity(
      pickField(fields, ['低压证-是否有效', '低压证是否有效']),
      certificateSummary,
      '低压电工证',
    ),
    heightWorkValid: resolveValidity(
      pickField(fields, ['登高证-是否有效', '登高证是否有效']),
      certificateSummary,
      '高处作业证',
    ),
    highVoltageExpiryDate,
    lowVoltageExpiryDate,
    heightWorkExpiryDate,
    expiryReminder: buildValidExpiryReminder(
      sourceReminder,
      {
        highVoltageExpiryDate,
        lowVoltageExpiryDate,
        heightWorkExpiryDate,
      },
      syncedAt,
    ),
  };
}

function certificateExpiryDate(value: unknown): string | null {
  if (value === 0 || value === '0') return null;
  const date = extractDateValue(value);
  return date === '1970-01-01' ? null : date;
}

function certificateDayIndex(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const timestamp = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== Number(match[1]) ||
    parsed.getUTCMonth() + 1 !== Number(match[2]) ||
    parsed.getUTCDate() !== Number(match[3])
  )
    return null;
  return timestamp / 86_400_000;
}

function shanghaiDayIndex(timestamp: string): number | null {
  const value = new Date(timestamp);
  if (!Number.isFinite(value.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: 'year' | 'month' | 'day') =>
    Number(parts.find((item) => item.type === type)?.value);
  return certificateDayIndex(
    `${part('year')}-${String(part('month')).padStart(2, '0')}-${String(part('day')).padStart(2, '0')}`,
  );
}

function buildValidExpiryReminder(
  source: string,
  dates: {
    highVoltageExpiryDate: string | null;
    lowVoltageExpiryDate: string | null;
    heightWorkExpiryDate: string | null;
  },
  syncedAt: string,
): string {
  const today = shanghaiDayIndex(syncedAt);
  if (today === null) return '';
  const known = [
    {
      name: '高压电工证',
      aliases: ['高压证', '高压电工证'],
      date: dates.highVoltageExpiryDate,
    },
    {
      name: '低压电工证',
      aliases: ['低压证', '低压电工证'],
      date: dates.lowVoltageExpiryDate,
    },
    {
      name: '登高证',
      aliases: ['登高证', '高处作业证'],
      date: dates.heightWorkExpiryDate,
    },
  ];
  const reminders: string[] = [];
  for (const item of known) {
    if (!item.date) continue;
    const day = certificateDayIndex(item.date);
    const days = day === null ? null : day - today;
    if (days !== null && days >= 0 && days <= 90)
      reminders.push(`${item.name}将在${days}天后到期`);
  }
  const certificateName =
    '(?:高压电工证|高压证|低压电工证|低压证|登高证|高处作业证|制冷证)';
  const clausePattern = new RegExp(
    `(${certificateName}(?:[、,，和及与/\\s]+${certificateName})*)将在(\\d+)天(后|内)到期`,
    'g',
  );
  for (const match of source.matchAll(clausePattern)) {
    const days = Number(match[2]);
    if (!Number.isSafeInteger(days) || days < 0 || days > 90) continue;
    for (const name of match[1].match(new RegExp(certificateName, 'g')) ?? []) {
      if (known.some((item) => item.date && item.aliases.includes(name)))
        continue;
      const reminder = `${name}将在${days}天${match[3]}到期`;
      if (!reminders.includes(reminder)) reminders.push(reminder);
    }
  }
  return reminders.join('；');
}

function buildBuildingCompliance(
  people: CampusCertificatePerson[],
): CampusCertificateBuildingCompliance[] {
  return BUILDING_ORDER.map((building) => {
    const buildingPeople = people.filter(
      (person) =>
        person.building === building &&
        (person.complianceStatus === '合规' ||
          person.complianceStatus === '不合规'),
    );
    const compliant = countStatus(buildingPeople, '合规');
    const nonCompliant = countStatus(buildingPeople, '不合规');
    const total = compliant + nonCompliant;

    return {
      building,
      compliant,
      nonCompliant,
      rate: total > 0 ? Math.round((compliant / total) * 100) : 0,
    };
  });
}

function mapNonCompliantPerson(
  person: CampusCertificatePerson,
): CampusCertificateNonCompliantPerson {
  return {
    id: person.id,
    building: person.building,
    name: person.name,
    position: person.position,
    missingCertificate: person.missingCertificate,
    positionTone: person.position.includes('暖通') ? 'red' : 'green',
  };
}

function buildExpiryEvents(
  people: CampusCertificatePerson[],
): CampusCertificateExpiryEvent[] {
  return people.flatMap((person) =>
    EXPIRY_DEFINITIONS.flatMap(
      ({ key, category, certificateName }): CampusCertificateExpiryEvent[] => {
        const date = person[key];
        if (!date) return [];
        return [
          {
            id: `${person.id}-${category}-${date}`,
            date,
            category,
            personId: person.id,
            personName: person.name,
            building: person.building,
            certificateName,
          },
        ];
      },
    ),
  );
}

function findLatestSourceUpdate(records: BitableRecordItem[]): string | null {
  const timestamps = records
    .map((record) => {
      const fieldTimestamp = extractDateTimeIso(
        pickField(record.fields || {}, ['更新时间', '更新日期']),
      );
      if (fieldTimestamp) return fieldTimestamp;
      if (!record.last_modified_time) return null;
      const normalizedTimestamp =
        record.last_modified_time < 1_000_000_000_000
          ? record.last_modified_time * 1000
          : record.last_modified_time;
      return extractDateTimeIso(normalizedTimestamp);
    })
    .filter((value): value is string => Boolean(value));

  if (timestamps.length === 0) return null;
  return timestamps.reduce((latest, current) =>
    new Date(current).getTime() > new Date(latest).getTime() ? current : latest,
  );
}

function findBuilding(values: string[]): string {
  for (const value of values) {
    if (BUILDING_OPTION_LABEL[value.trim()]) continue;
    const normalized = normalizeBuilding(value);
    if (normalized) return normalized;
  }
  for (const value of values) {
    const optionBuilding = BUILDING_OPTION_LABEL[value.trim()];
    if (optionBuilding) return optionBuilding;
  }
  return '未分配';
}

function normalizeBuilding(value: string): string {
  const text = value.trim().toUpperCase();
  if (text.includes('110')) return '110站';
  const chineseMatch = text.match(/([ABCDEH])\s*[楼栋]/i);
  if (chineseMatch?.[1]) return `${chineseMatch[1].toUpperCase()}楼`;
  const englishMatch = text.match(
    /(?:BUILDING[_\s-]*([ABCDEH])|([ABCDEH])[_\s-]*BUILDING)/i,
  );
  const buildingCode = englishMatch?.[1] || englishMatch?.[2];
  if (buildingCode) return `${buildingCode.toUpperCase()}楼`;
  return /^[ABCDEH]$/i.test(text) ? `${text}楼` : '';
}

function normalizeComplianceStatus(
  value: string,
): CampusCertificateComplianceStatus {
  if (value === '合规') return '合规';
  if (value === '不合规') return '不合规';
  if (value === '不涉及') return '不涉及';
  if (COMPLIANCE_OPTION_STATUS[value]) return COMPLIANCE_OPTION_STATUS[value];
  return '未知';
}

function resolveValidity(
  directValue: unknown,
  certificateSummary: string,
  certificateName: string,
): boolean {
  const directText = displayText(directValue).toLowerCase();
  if (directText) {
    if (
      directText.includes('❌') ||
      directText.includes('无效') ||
      directText.includes('过期') ||
      directText === 'false' ||
      directText === '0'
    ) {
      return false;
    }
    return (
      directText.includes('✔') ||
      directText.includes('✅') ||
      directText.includes('有效') ||
      directText === 'true' ||
      directText === '1'
    );
  }
  return certificateSummary.includes(certificateName);
}

function displayText(value: unknown): string {
  return extractDisplayText(value, '、').trim();
}

function countStatus(
  people: CampusCertificatePerson[],
  status: CampusCertificateComplianceStatus,
): number {
  return people.filter((person) => person.complianceStatus === status).length;
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}
