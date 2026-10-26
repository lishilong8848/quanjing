import {
  extractDateTimeIso,
  extractDateValue,
  extractDisplayText,
  extractDisplayValues,
  extractNumberValue,
  getRecordId,
  pickField,
  type BitableRecordItem,
  type PersistedBitableRecordSnapshot,
} from '@server/common/feishu/bitable-direct-read';
import {
  MBTI_TYPE_CODES,
  type MbtiTypeCode,
  type OrganizationPersonAbilityScore,
  type OrganizationPersonCertificate,
  type OrganizationPersonEmploymentHistoryItem,
  type OrganizationPersonEmploymentStatus,
  type OrganizationPersonProfileDetail,
  type OrganizationPersonQualityAssessment,
} from '@shared/organization-person-profile';
import type { CampusCertificatePerson } from '@shared/api.interface';
import { mapAliMonthlyQualityIssues } from '../risk-inspection/risk-inspection.mapper';
import { buildActivePersonnelDirectory } from './active-personnel-directory';

type Fields = Record<string, unknown>;

const ABILITY_FIELDS: Array<{
  key: OrganizationPersonAbilityScore['key'];
  label: string;
  fields: string[];
  benchmarkFields: string[];
}> = [
  {
    key: 'electricalOperations',
    label: '电气运维',
    fields: ['电气运维', '电气运维能力'],
    benchmarkFields: ['电气运维岗位基准', '岗位基准-电气运维'],
  },
  {
    key: 'hvacFundamentals',
    label: '暖通基础',
    fields: ['暖通基础', '暖通基础能力'],
    benchmarkFields: ['暖通基础岗位基准', '岗位基准-暖通基础'],
  },
  {
    key: 'emergencyResponse',
    label: '应急响应',
    fields: ['应急响应', '应急处置'],
    benchmarkFields: ['应急响应岗位基准', '岗位基准-应急响应'],
  },
  {
    key: 'safetyCompliance',
    label: '安全规范',
    fields: ['安全规范', '安全合规'],
    benchmarkFields: ['安全规范岗位基准', '岗位基准-安全规范'],
  },
  {
    key: 'teamwork',
    label: '团队协作',
    fields: ['团队协作', '协作能力'],
    benchmarkFields: ['团队协作岗位基准', '岗位基准-团队协作'],
  },
  {
    key: 'drillPractice',
    label: '演练实战',
    fields: ['演练实战', '演练能力'],
    benchmarkFields: ['演练实战岗位基准', '岗位基准-演练实战'],
  },
];

const CERTIFICATE_FIELDS: Array<{
  id: string;
  name: string;
  statusFields: string[];
  expiryFields: string[];
}> = [
  {
    id: 'high-voltage',
    name: '高压电工证',
    statusFields: ['高压电工证', '高压电工证状态', '高压电工证有效性'],
    expiryFields: ['高压电工证到期日期', '高压电工证有效期'],
  },
  {
    id: 'low-voltage',
    name: '低压电工证',
    statusFields: ['低压电工证', '低压电工证状态', '低压电工证有效性'],
    expiryFields: ['低压电工证到期日期', '低压电工证有效期'],
  },
  {
    id: 'work-at-height',
    name: '高处作业证',
    statusFields: ['高处作业证', '高处作业证状态', '高处作业证有效性'],
    expiryFields: ['高处作业证到期日期', '高处作业证有效期'],
  },
];

export function mapOrganizationPersonProfileRecord(
  record: BitableRecordItem,
): OrganizationPersonProfileDetail | null {
  const fields = record.fields ?? {};
  const recordId = getRecordId(record);
  const name = readText(fields, ['姓名', '员工姓名', '员工', '人员']);
  if (!recordId || !name) return null;

  const position = readNullableText(fields, ['岗位', '楼岗位', '职位']);
  const entryDate = readDate(fields, ['入职日期', '入司日期']);
  const departureDate = readDate(fields, [
    '离职日期',
    '最后工作日',
    '异动日期',
  ]);
  const employmentStatus = resolveEmploymentStatus(fields);
  const employmentHistory = buildEmploymentHistory({
    fields,
    recordId,
    position,
    entryDate,
    departureDate,
    employmentStatus,
  });
  const certificates = buildCertificates(fields);

  return {
    recordId,
    name,
    employeeNo: readNullableText(fields, ['员工工号', '工号', '编码']),
    photoUrl: hasValue(pickField(fields, ['照片', '证件照', '个人照片']))
      ? `/api/bitable/employee-photo/${encodeURIComponent(recordId)}?scope=organization`
      : null,
    employmentStatus,
    position,
    systemPosition: readNullableText(fields, ['体系岗位', '岗位体系']),
    company: readNullableText(fields, ['公司名称', '公司', '单位']),
    employmentType: readNullableText(fields, ['用工性质', '人员性质']),
    buildingsSpecialties: readList(fields, [
      '机楼/专业',
      '机楼专业',
      '楼栋/专业',
      '楼栋',
      '机楼',
    ]),
    team: readNullableText(fields, ['班组', '组别']),
    shift: readNullableText(fields, ['班次', '班别']),
    supervisorName: readNullableText(fields, ['示例人员001', '直接示例人员001']),
    phone: readNullableText(fields, ['联系方式', '电话', '手机号']),
    email: readNullableText(fields, ['电子邮箱', '邮箱']),
    idCardMasked: maskOrganizationPersonIdCard(
      readNullableText(fields, ['身份证号', '证件号码']),
    ),
    entryDate,
    departureDate,
    departureReason: readNullableText(fields, ['离职原因', '异动原因']),
    education: readNullableText(fields, ['学历', '最高学历']),
    school: readNullableText(fields, ['毕业院校', '院校']),
    major: readNullableText(fields, ['所学专业', '专业']),
    graduationDate: readDate(fields, ['毕业时间', '毕业日期']),
    hobbies: readList(fields, ['兴趣爱好', '爱好']),
    vehiclePlate: readNullableText(fields, ['车牌号', '车辆牌照']),
    specialties: readList(fields, ['特长标签', '特长', '技能标签']),
    mbti: parseMbti(readNullableText(fields, ['MBTI', '16型人格', '人格类型'])),
    profileScores: {
      responsibility: readScore(fields, ['责任心']),
      stability: readScore(fields, ['稳定性']),
      collaboration: readScore(fields, ['协作力', '协作能力']),
      growthPotential: readScore(fields, ['成长潜力']),
    },
    abilities: ABILITY_FIELDS.map((ability) => ({
      key: ability.key,
      label: ability.label,
      score: readScore(fields, ability.fields),
      benchmark: readScore(fields, ability.benchmarkFields),
    })),
    employmentHistory,
    training: {
      completedCourses: readNonNegativeNumber(fields, [
        '培训已完成课程',
        '已完成课程数',
      ]),
      totalCourses: readNonNegativeNumber(fields, ['培训课程总数', '课程总数']),
      completionRate: readScore(fields, ['培训完成率', '课程完成率']),
      averageScore: readScore(fields, ['培训平均分', '平均分']),
      attendanceRate: readScore(fields, ['培训签到率', '签到率']),
      finalScore: readScore(fields, ['最终考核成绩', '最终成绩']),
    },
    drill: {
      annualCount: readNonNegativeNumber(fields, ['年度演练次数', '演练次数']),
      latestRating: readNullableText(fields, ['最近演练评级', '演练评级']),
      latestTitle: readNullableText(fields, ['最近演练主题', '演练主题']),
      latestDate: readDate(fields, ['最近演练日期', '演练日期']),
    },
    certificates,
    certificateSource: certificates.length > 0 ? 'personnel' : null,
    qualityAssessment: unavailableQualityAssessment(),
    updatedAt: extractDateTimeIso(record.last_modified_time),
  };
}

export function buildOrganizationPersonQualityAssessment(
  profileRecordId: string,
  issueSnapshot: PersistedBitableRecordSnapshot | null,
  personnelRecords: BitableRecordItem[],
  now = Date.now(),
): OrganizationPersonQualityAssessment {
  if (!issueSnapshot) return unavailableQualityAssessment();

  const personnelDirectory = buildActivePersonnelDirectory(
    {
      records: personnelRecords,
      fetchedAt: issueSnapshot.fetchedAt,
      expiresAt: issueSnapshot.expiresAt,
    },
    now,
  );
  const records = mapAliMonthlyQualityIssues(
    issueSnapshot.records,
    personnelDirectory,
  )
    .filter(({ responsiblePersons }) =>
      responsiblePersons.some(({ recordId }) => recordId === profileRecordId),
    )
    .map((issue) => ({
      id: issue.id,
      year: null,
      month: issue.month,
      building: issue.building,
      item: issue.item,
      issue: issue.issue,
      supplemental: issue.supplemental,
      attachments: issue.attachments,
      images: issue.images,
    }));

  return {
    status: issueSnapshot.expiresAt <= now ? 'stale' : 'ready',
    records,
    sourceUpdatedAt: new Date(issueSnapshot.fetchedAt).toISOString(),
  };
}

function unavailableQualityAssessment(): OrganizationPersonQualityAssessment {
  return { status: 'unavailable', records: [], sourceUpdatedAt: null };
}

const DASHBOARD_CERTIFICATE_FIELDS: Array<{
  id: string;
  name: string;
  validKey: 'highVoltageValid' | 'lowVoltageValid' | 'heightWorkValid';
  expiryKey:
    | 'highVoltageExpiryDate'
    | 'lowVoltageExpiryDate'
    | 'heightWorkExpiryDate';
}> = [
  {
    id: 'high-voltage',
    name: '高压电工证',
    validKey: 'highVoltageValid',
    expiryKey: 'highVoltageExpiryDate',
  },
  {
    id: 'low-voltage',
    name: '低压电工证',
    validKey: 'lowVoltageValid',
    expiryKey: 'lowVoltageExpiryDate',
  },
  {
    id: 'work-at-height',
    name: '高处作业证',
    validKey: 'heightWorkValid',
    expiryKey: 'heightWorkExpiryDate',
  },
];

export function mergeOrganizationPersonCertificatesFromDashboard(
  profile: OrganizationPersonProfileDetail,
  certificatePeople: CampusCertificatePerson[],
  now = new Date(),
): OrganizationPersonProfileDetail {
  const normalizedName = normalizePersonName(profile.name);
  const sameName = certificatePeople.filter(
    (person) => normalizePersonName(person.name) === normalizedName,
  );
  const matched = resolveCertificatePerson(profile, sameName);
  if (!matched) return profile;

  const dashboardCertificateIds = new Set(
    DASHBOARD_CERTIFICATE_FIELDS.map((certificate) => certificate.id),
  );
  const preservedCertificates = profile.certificates.filter(
    (certificate) => !dashboardCertificateIds.has(certificate.id),
  );
  const dashboardCertificates = DASHBOARD_CERTIFICATE_FIELDS.flatMap(
    (definition): OrganizationPersonCertificate[] => {
      const valid = matched[definition.validKey];
      const expiryDate = matched[definition.expiryKey];
      if (!valid && !expiryDate) return [];
      return [
        {
          id: definition.id,
          name: definition.name,
          status: certificateStatusFromDashboard(valid, expiryDate, now),
          expiryDate,
        },
      ];
    },
  );

  return {
    ...profile,
    certificates: [...preservedCertificates, ...dashboardCertificates],
    certificateSource: 'certificate',
  };
}

function resolveCertificatePerson(
  profile: OrganizationPersonProfileDetail,
  candidates: CampusCertificatePerson[],
): CampusCertificatePerson | null {
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return null;

  const profileBuildings = new Set(
    profile.buildingsSpecialties
      .map(normalizeBuildingLabel)
      .filter((value): value is string => Boolean(value)),
  );
  if (profileBuildings.size === 0) return null;
  const buildingMatches = candidates.filter((candidate) => {
    const building = normalizeBuildingLabel(candidate.building);
    return Boolean(building && profileBuildings.has(building));
  });
  return buildingMatches.length === 1 ? buildingMatches[0] : null;
}

function normalizePersonName(value: string): string {
  return String(value || '')
    .replace(/\s+/gu, '')
    .toLocaleLowerCase('zh-CN');
}

function normalizeBuildingLabel(value: string): string | null {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();
  if (normalized.includes('110')) return '110站';
  const match = normalized.match(/([ABCDEH])\s*[楼栋]?/u);
  return match?.[1] ? `${match[1]}楼` : null;
}

function certificateStatusFromDashboard(
  valid: boolean,
  expiryDate: string | null,
  now: Date,
): OrganizationPersonCertificate['status'] {
  if (!expiryDate) return valid ? 'valid' : 'unknown';
  const expiryTime = Date.parse(`${expiryDate}T23:59:59.999+08:00`);
  if (!Number.isFinite(expiryTime)) return valid ? 'valid' : 'unknown';
  if (expiryTime < now.getTime()) return 'expired';
  if (expiryTime <= now.getTime() + 90 * 24 * 60 * 60 * 1000) {
    return 'expiring';
  }
  return valid ? 'valid' : 'unknown';
}

export function maskOrganizationPersonIdCard(
  value: string | null | undefined,
): string | null {
  const normalized = String(value ?? '')
    .replace(/\s+/g, '')
    .trim();
  if (!normalized) return null;
  if (normalized.length <= 3) return '*'.repeat(normalized.length);
  if (normalized.length <= 10) {
    return `${normalized.slice(0, 3)}${'*'.repeat(normalized.length - 3)}`;
  }
  return `${normalized.slice(0, 6)}${'*'.repeat(
    Math.max(4, normalized.length - 10),
  )}${normalized.slice(-4)}`;
}

function readText(fields: Fields, names: string[]): string {
  return extractDisplayText(pickField(fields, names), ' ').trim();
}

function readNullableText(fields: Fields, names: string[]): string | null {
  return readText(fields, names) || null;
}

function readList(fields: Fields, names: string[]): string[] {
  return extractDisplayValues(pickField(fields, names))
    .flatMap((value) => value.split(/[、,，;；]/u))
    .map((value) => value.trim())
    .filter(
      (value, index, all) => Boolean(value) && all.indexOf(value) === index,
    );
}

function readDate(fields: Fields, names: string[]): string | null {
  return extractDateValue(pickField(fields, names));
}

function readScore(fields: Fields, names: string[]): number | null {
  const value = extractNumberValue(pickField(fields, names));
  if (value === null) return null;
  return Math.min(100, Math.max(0, value));
}

function readNonNegativeNumber(fields: Fields, names: string[]): number | null {
  const value = extractNumberValue(pickField(fields, names));
  return value === null ? null : Math.max(0, value);
}

function parseMbti(value: string | null): MbtiTypeCode | null {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase();
  return (MBTI_TYPE_CODES as readonly string[]).includes(normalized)
    ? (normalized as MbtiTypeCode)
    : null;
}

function resolveEmploymentStatus(
  fields: Fields,
): OrganizationPersonEmploymentStatus {
  const status = readText(fields, ['离职/异动情况', '人员状态', '在职状态'])
    .replace(/\s+/g, '')
    .toLowerCase();
  if (/离职|已离司|departed/u.test(status)) return 'departed';
  if (/异动|调动|transferred/u.test(status)) return 'transferred';
  if (/在职|在岗|active/u.test(status)) return 'active';
  return 'active';
}

function buildEmploymentHistory(options: {
  fields: Fields;
  recordId: string;
  position: string | null;
  entryDate: string | null;
  departureDate: string | null;
  employmentStatus: OrganizationPersonEmploymentStatus;
}): OrganizationPersonEmploymentHistoryItem[] {
  const result: OrganizationPersonEmploymentHistoryItem[] = [];
  if (options.entryDate) {
    result.push({
      id: `${options.recordId}-entry`,
      date: options.entryDate,
      title: '加入团队',
      description: readNullableText(options.fields, ['入职说明']),
      kind: 'entry',
    });
  }
  if (options.position) {
    result.push({
      id: `${options.recordId}-position`,
      date: readDate(options.fields, ['岗位生效日期', '任职日期']),
      title: options.position,
      description:
        readNullableText(options.fields, ['任职说明', '岗位说明']) ||
        '当前岗位',
      kind: 'position',
    });
  }
  if (options.employmentStatus === 'transferred') {
    result.push({
      id: `${options.recordId}-transfer`,
      date: options.departureDate,
      title: '人员异动',
      description: readNullableText(options.fields, ['异动原因', '异动说明']),
      kind: 'transfer',
    });
  }
  if (options.employmentStatus === 'departed') {
    result.push({
      id: `${options.recordId}-departure`,
      date: options.departureDate,
      title: '离职',
      description: readNullableText(options.fields, ['离职原因', '离职说明']),
      kind: 'departure',
    });
  }
  return result;
}

function buildCertificates(fields: Fields): OrganizationPersonCertificate[] {
  return CERTIFICATE_FIELDS.flatMap((certificate) => {
    const statusText = readNullableText(fields, certificate.statusFields);
    const expiryDate = readDate(fields, certificate.expiryFields);
    if (!statusText && !expiryDate) return [];
    return [
      {
        id: certificate.id,
        name: certificate.name,
        status: normalizeCertificateStatus(statusText),
        expiryDate,
      },
    ];
  });
}

function normalizeCertificateStatus(
  value: string | null,
): OrganizationPersonCertificate['status'] {
  const normalized = String(value ?? '').replace(/\s+/g, '');
  if (/过期|失效|无效/u.test(normalized)) return 'expired';
  if (/临期|即将到期/u.test(normalized)) return 'expiring';
  if (/有效|正常|合规/u.test(normalized)) return 'valid';
  return 'unknown';
}

function hasValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return Boolean(value.trim());
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== null && value !== undefined && value !== false;
}
