import type {
  MbtiTypeCode,
  OrganizationPersonProfileDetail,
  OrganizationPersonProfileSource,
} from '@shared/organization-person-profile';

export interface OrganizationPersonProfileSummary {
  source: OrganizationPersonProfileSource;
  recordId: string;
  name: string;
  position: string | null;
  buildings: string[];
  shift: string | null;
  photoUrl: string | null;
  email: string | null;
  phone: string | null;
}

export interface MbtiTypeDefinition {
  name: string;
  traits: string;
}

export const MBTI_TYPE_DEFINITIONS: Record<MbtiTypeCode, MbtiTypeDefinition> = {
  ISTJ: { name: '稳健执行型', traits: '重事实、秩序与可靠交付' },
  ISFJ: { name: '细致守护型', traits: '细致体察并稳定支持团队' },
  INFJ: { name: '洞察引导型', traits: '关注长期价值与他人成长' },
  INTJ: { name: '战略规划型', traits: '擅长构建系统和长期路径' },
  ISTP: { name: '冷静实干型', traits: '善于拆解问题并现场处置' },
  ISFP: { name: '温和体验型', traits: '重视真实体验与灵活配合' },
  INFP: { name: '价值理想型', traits: '由价值驱动并关注更多可能' },
  INTP: { name: '逻辑探索型', traits: '喜欢分析原理和优化模型' },
  ESTP: { name: '行动应变型', traits: '反应敏捷并善于处理现场变化' },
  ESFP: { name: '活力协作型', traits: '以热情互动带动团队氛围' },
  ENFP: { name: '灵感连接型', traits: '善于发现机会并连接多方资源' },
  ENTP: { name: '创新辩证型', traits: '喜欢挑战假设并探索新解法' },
  ESTJ: { name: '组织推进型', traits: '目标清晰并推动标准化落地' },
  ESFJ: { name: '关系协调型', traits: '关注协作秩序与成员需要' },
  ENFJ: { name: '成长赋能型', traits: '善于凝聚共识并促进他人成长' },
  ENTJ: { name: '目标统筹型', traits: '擅长决策、配置资源和推进结果' },
};

export type MbtiPreferenceLetter =
  | 'E'
  | 'I'
  | 'S'
  | 'N'
  | 'T'
  | 'F'
  | 'J'
  | 'P';

export const MBTI_PREFERENCE_DEFINITIONS: Record<
  MbtiPreferenceLetter,
  { label: string; description: string }
> = {
  E: {
    label: '外向偏好',
    description: '从外部互动获得能量，倾向边讨论边行动。',
  },
  I: {
    label: '内向偏好',
    description: '从独立思考获得能量，倾向先思考再表达。',
  },
  S: {
    label: '实感偏好',
    description: '关注事实、细节和已有经验，重视可以验证的信息。',
  },
  N: {
    label: '直觉偏好',
    description: '关注模式、可能性和整体关联，重视未来方向。',
  },
  T: {
    label: '思考偏好',
    description: '做决定时更重逻辑、一致性和相对客观的标准。',
  },
  F: {
    label: '情感偏好',
    description: '做决定时更重价值、影响和相关人员的需要。',
  },
  J: {
    label: '判断偏好',
    description: '偏好计划、结构和尽快闭环，让外部生活更有秩序。',
  },
  P: {
    label: '感知偏好',
    description: '偏好弹性、探索和保留选择，以适应新的信息。',
  },
};

const PROFILE_PLACEHOLDER_VALUES = new Set([
  '-',
  '--',
  '—',
  'n/a',
  'na',
  'null',
  'undefined',
  '不适用',
  '无',
  '暂无',
  '未维护',
  '尚未维护',
  '待维护',
  '待补充',
  '未填写',
  '未录入',
  '未提供',
  '未知',
  '未测评',
  '未评级',
  '在职人员',
]);

export function isProfileDisplayValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const normalized = String(value).trim();
  if (!normalized) return false;

  const compact = normalized.replace(/\s+/gu, '').toLocaleLowerCase();
  if (PROFILE_PLACEHOLDER_VALUES.has(compact)) return false;

  return !/(?:未维护|尚未维护|待维护|待补充|未填写|未录入|未提供)$/u.test(
    compact,
  );
}

export function joinProfileDisplayValues(...values: unknown[]): string | null {
  const uniqueValues = [
    ...new Set(
      values.filter(isProfileDisplayValue).map((value) => String(value).trim()),
    ),
  ];

  return uniqueValues.length > 0 ? uniqueValues.join(' · ') : null;
}

export function isProfileEmploymentTypeDisplayValue(value: unknown): boolean {
  if (!isProfileDisplayValue(value)) return false;
  return !/^\d+$/u.test(String(value).trim());
}

export function organizationProfileCacheKey(
  locator: Pick<OrganizationPersonProfileSummary, 'source' | 'recordId'>,
): string {
  return `${locator.source}:${locator.recordId}`;
}

export function resolveOrganizationPersonProfile(
  summary: OrganizationPersonProfileSummary,
  detail?: OrganizationPersonProfileDetail,
): OrganizationPersonProfileDetail {
  if (detail) {
    return {
      ...detail,
      name: detail.name || summary.name,
      photoUrl: detail.photoUrl || summary.photoUrl,
      position: detail.position || summary.position,
      buildingsSpecialties: detail.buildingsSpecialties.length
        ? detail.buildingsSpecialties
        : summary.buildings,
      shift: detail.shift || summary.shift,
      phone: detail.phone || summary.phone,
      email: detail.email || summary.email,
    };
  }

  return {
    recordId: summary.recordId,
    name: summary.name,
    employeeNo: null,
    photoUrl: summary.photoUrl,
    employmentStatus: 'unknown',
    position: summary.position,
    systemPosition: null,
    company: null,
    employmentType: null,
    buildingsSpecialties: summary.buildings,
    team: null,
    shift: summary.shift,
    supervisorName: null,
    phone: summary.phone,
    email: summary.email,
    idCardMasked: null,
    entryDate: null,
    departureDate: null,
    departureReason: null,
    education: null,
    school: null,
    major: null,
    graduationDate: null,
    hobbies: [],
    vehiclePlate: null,
    specialties: [],
    mbti: null,
    profileScores: {
      responsibility: null,
      stability: null,
      collaboration: null,
      growthPotential: null,
    },
    abilities: [],
    employmentHistory: [],
    training: {
      completedCourses: null,
      totalCourses: null,
      completionRate: null,
      averageScore: null,
      attendanceRate: null,
      finalScore: null,
    },
    drill: {
      annualCount: null,
      latestRating: null,
      latestTitle: null,
      latestDate: null,
    },
    certificates: [],
    certificateSource: null,
    qualityAssessment: {
      status: 'unavailable',
      records: [],
      sourceUpdatedAt: null,
    },
    updatedAt: null,
  };
}
