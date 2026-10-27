export const EMPLOYEE_ONBOARDING_CLIENT_MUTATION_ID_PREFIX =
  'employee-onboarding-' as const;

export const EMPLOYEE_ONBOARDING_EMPLOYMENT_TYPES = [
  '420',
  '102',
  '生态',
] as const;

export const EMPLOYEE_ONBOARDING_COMPANIES = [
  '上海科之锐',
  '启东电力',
  '深圳锐科',
  '锐科',
  '深圳锐科信息技术有限公司',
  '神舟邦邦',
  '上海智服人力资源有限公司',
  '南通承宏云计算有限公司',
  '北京智航万恒',
  '亚康万玮',
] as const;

export const EMPLOYEE_ONBOARDING_POSITIONS = [
  '设施运维经理',
  '综合管理',
  '弱电工程师',
  '暖通工程师',
  '运维实习生',
  '设施运维助理工程师',
  '运维值班长',
  '电气工程师',
  '消防工程师',
  '安全&消防工程师',
  '设施运维副经理',
  '电气主管',
  '暖通主管',
  '弱电主管',
  '设施运维主管',
  '运维值班员',
  '110值班人员',
  '消防主管',
  'FOC',
  '110站站长',
  'H楼值班主管',
] as const;

export const EMPLOYEE_ONBOARDING_EDUCATIONS = [
  '本科',
  '大专',
  '中专',
  '高中',
  '/',
  '中技',
  '硕士',
] as const;

export const EMPLOYEE_ONBOARDING_HOBBIES = [
  '篮球',
  '羽毛球',
  '乒乓球',
  '电子游戏',
  '跑步',
  '唱歌',
  '舞蹈',
  '骑行',
  '钻研技术',
  '阅读',
  '撸铁',
  '喝酒',
  '其他',
] as const;

export const EMPLOYEE_ONBOARDING_TEXT_LIMITS = {
  name: 50,
  graduateSchool: 100,
  major: 100,
  vehiclePlate: 20,
} as const;

const TEN_MEBIBYTES = 10 * 1024 * 1024;

export const EMPLOYEE_ONBOARDING_PHOTO_FILE_RULE = {
  required: true,
  maxCount: 1,
  maxBytesPerFile: TEN_MEBIBYTES,
  mimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
} as const;

export type EmployeeOnboardingEmploymentType =
  (typeof EMPLOYEE_ONBOARDING_EMPLOYMENT_TYPES)[number];
export type EmployeeOnboardingCompany =
  (typeof EMPLOYEE_ONBOARDING_COMPANIES)[number];
export type EmployeeOnboardingPosition =
  (typeof EMPLOYEE_ONBOARDING_POSITIONS)[number];
export type EmployeeOnboardingEducation =
  (typeof EMPLOYEE_ONBOARDING_EDUCATIONS)[number];
export type EmployeeOnboardingHobby =
  (typeof EMPLOYEE_ONBOARDING_HOBBIES)[number];

const EMPLOYMENT_TYPE_BY_COMPANY: Readonly<
  Partial<
    Record<EmployeeOnboardingCompany, EmployeeOnboardingEmploymentType>
  >
> = {
  '南通承宏云计算有限公司': '420',
  '北京智航万恒': '102',
};

export function resolveEmployeeOnboardingEmploymentType(
  companyName: EmployeeOnboardingCompany,
): EmployeeOnboardingEmploymentType {
  return EMPLOYMENT_TYPE_BY_COMPANY[companyName] ?? '生态';
}

export interface EmployeeOnboardingMbtiAssessment {
  participantName: string;
  version: 'short' | 'full';
  answers: readonly (number | 'A' | 'B')[];
  sourceSha256: string;
}

export interface EmployeeOnboardingFormValues {
  name: string;
  companyName: EmployeeOnboardingCompany;
  position: EmployeeOnboardingPosition;
  identityNumber: string;
  phone: string;
  entryDate: string;
  education: EmployeeOnboardingEducation;
  graduateSchool: string;
  major: string;
  graduationDate: string;
  hobbies: EmployeeOnboardingHobby[];
  vehiclePlate?: string;
  mbtiAssessment: EmployeeOnboardingMbtiAssessment;
}

export interface EmployeeOnboardingCreateRequest extends EmployeeOnboardingFormValues {
  clientMutationId: string;
}

export type EmployeeOnboardingCreatePayload = EmployeeOnboardingCreateRequest;

export interface EmployeeOnboardingCreateResponse {
  success: true;
  syncStatus: 'confirmed';
  clientMutationId: string;
  recordId: string;
  createdAt: string;
  mbtiTicket?: string;
}

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RESPONSE_FIELDS = new Set<string>([
  'success',
  'syncStatus',
  'clientMutationId',
  'recordId',
  'createdAt',
  'mbtiTicket',
]);

export function isEmployeeOnboardingClientMutationId(
  value: unknown,
): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(EMPLOYEE_ONBOARDING_CLIENT_MUTATION_ID_PREFIX) &&
    UUID_V4_PATTERN.test(
      value.slice(EMPLOYEE_ONBOARDING_CLIENT_MUTATION_ID_PREFIX.length),
    )
  );
}

export function isEmployeeOnboardingCreateResponse(
  value: unknown,
): value is EmployeeOnboardingCreateResponse {
  if (!isPlainRecord(value)) return false;
  if (
    (Object.keys(value).length !== RESPONSE_FIELDS.size - 1 && Object.keys(value).length !== RESPONSE_FIELDS.size) ||
    Object.keys(value).some((field) => !RESPONSE_FIELDS.has(field))
  ) {
    return false;
  }

  return (
    value.success === true &&
    value.syncStatus === 'confirmed' &&
    isEmployeeOnboardingClientMutationId(value.clientMutationId) &&
    isNonBlankString(value.recordId) &&
    isIsoTimestamp(value.createdAt) &&
    (value.mbtiTicket === undefined || isNonBlankString(value.mbtiTicket))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}
