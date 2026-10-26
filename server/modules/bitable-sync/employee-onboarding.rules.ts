import {
  EMPLOYEE_ONBOARDING_COMPANIES,
  EMPLOYEE_ONBOARDING_EDUCATIONS,
  EMPLOYEE_ONBOARDING_HOBBIES,
  EMPLOYEE_ONBOARDING_POSITIONS,
  EMPLOYEE_ONBOARDING_TEXT_LIMITS,
  isEmployeeOnboardingClientMutationId,
  resolveEmployeeOnboardingEmploymentType,
  type EmployeeOnboardingCompany,
  type EmployeeOnboardingCreateRequest,
  type EmployeeOnboardingEducation,
  type EmployeeOnboardingEmploymentType,
  type EmployeeOnboardingHobby,
  type EmployeeOnboardingPosition,
} from '../../../shared/employee-onboarding';
import { validateOnboardingMbtiAssessment } from '../../../shared/employee-onboarding-mbti';

export interface EmployeeOnboardingValidationIssue {
  field: string;
  message: string;
}

export interface EmployeeOnboardingBitableFields {
  MBTI: string;
  姓名: string;
  用工性质: EmployeeOnboardingEmploymentType;
  公司名称: EmployeeOnboardingCompany;
  岗位: EmployeeOnboardingPosition;
  身份证号: string;
  联系方式: string;
  入职日期: number;
  学历: EmployeeOnboardingEducation;
  毕业院校: string;
  所学专业: string;
  毕业时间: string;
  兴趣爱好: EmployeeOnboardingHobby[];
  车牌号?: string;
}

export type EmployeeOnboardingValidatedRequest =
  EmployeeOnboardingCreateRequest & {
    employmentType: EmployeeOnboardingEmploymentType;
    mbtiType: string;
  };

export class EmployeeOnboardingRuleError extends Error {
  constructor(
    public readonly issues: readonly EmployeeOnboardingValidationIssue[],
  ) {
    super(issues.map(({ message }) => message).join('；'));
    this.name = 'EmployeeOnboardingRuleError';
  }
}

const REQUEST_FIELDS = new Set<string>([
  'clientMutationId',
  'name',
  'companyName',
  'position',
  'identityNumber',
  'phone',
  'entryDate',
  'education',
  'graduateSchool',
  'major',
  'graduationDate',
  'hobbies',
  'vehiclePlate',
  'mbtiAssessment',
]);
const COMPANY_SET = new Set<string>(EMPLOYEE_ONBOARDING_COMPANIES);
const POSITION_SET = new Set<string>(EMPLOYEE_ONBOARDING_POSITIONS);
const EDUCATION_SET = new Set<string>(EMPLOYEE_ONBOARDING_EDUCATIONS);
const HOBBY_SET = new Set<string>(EMPLOYEE_ONBOARDING_HOBBIES);
const MAINLAND_MOBILE_PATTERN = /^1[3-9]\d{9}$/u;
const IDENTITY_NUMBER_PATTERN = /^\d{17}[\dX]$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const IDENTITY_CHECKSUM_WEIGHTS = [
  7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2,
] as const;
const IDENTITY_CHECKSUM_CODES = [
  '1',
  '0',
  'X',
  '9',
  '8',
  '7',
  '6',
  '5',
  '4',
  '3',
  '2',
] as const;
const SHANGHAI_UTC_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1000;

export function parseEmployeeOnboardingRequest(
  value: unknown,
): EmployeeOnboardingValidatedRequest {
  if (!isPlainRecord(value)) {
    throw new EmployeeOnboardingRuleError([
      { field: 'request', message: '新员工入职请求必须是对象' },
    ]);
  }

  const issues: EmployeeOnboardingValidationIssue[] = [];
  if (Object.keys(value).some((field) => !REQUEST_FIELDS.has(field))) {
    issues.push({ field: 'request', message: '不支持的请求字段' });
  }

  const clientMutationId = readMutationId(value.clientMutationId, issues);
  const name = readRequiredString(
    value.name,
    'name',
    '姓名',
    issues,
    EMPLOYEE_ONBOARDING_TEXT_LIMITS.name,
  );
  const companyName = readOption(
    value.companyName,
    'companyName',
    '公司名称',
    COMPANY_SET,
    issues,
  ) as EmployeeOnboardingCompany;
  const employmentType = resolveEmployeeOnboardingEmploymentType(companyName);
  const position = readOption(
    value.position,
    'position',
    '岗位',
    POSITION_SET,
    issues,
  ) as EmployeeOnboardingPosition;
  const identityNumber = readIdentityNumber(value.identityNumber, issues);
  const phone = readPhone(value.phone, issues);
  const entryDate = readDate(value.entryDate, 'entryDate', '入职日期', issues);
  const education = readOption(
    value.education,
    'education',
    '学历',
    EDUCATION_SET,
    issues,
  ) as EmployeeOnboardingEducation;
  const graduateSchool = readRequiredString(
    value.graduateSchool,
    'graduateSchool',
    '毕业院校',
    issues,
    EMPLOYEE_ONBOARDING_TEXT_LIMITS.graduateSchool,
  );
  const major = readRequiredString(
    value.major,
    'major',
    '所学专业',
    issues,
    EMPLOYEE_ONBOARDING_TEXT_LIMITS.major,
  );
  const graduationDate = readDate(
    value.graduationDate,
    'graduationDate',
    '毕业日期',
    issues,
  );
  const hobbies = readHobbies(value.hobbies, issues);
  const vehiclePlate = readOptionalString(
    value.vehiclePlate,
    'vehiclePlate',
    '车牌号',
    issues,
    EMPLOYEE_ONBOARDING_TEXT_LIMITS.vehiclePlate,
    (text) => text.toUpperCase(),
  );
  const mbti = validateOnboardingMbtiAssessment(value.mbtiAssessment, name);
  if (!mbti) {
    issues.push({ field: 'mbtiAssessment', message: '请先完成 MBTI 测试' });
  }

  if (issues.length > 0) {
    throw new EmployeeOnboardingRuleError(issues);
  }

  return {
    clientMutationId,
    name,
    employmentType,
    companyName,
    position,
    identityNumber,
    phone,
    entryDate,
    education,
    graduateSchool,
    major,
    graduationDate,
    hobbies,
    mbtiAssessment: mbti!.assessment,
    mbtiType: mbti!.type,
    ...(value.vehiclePlate !== undefined ? { vehiclePlate } : {}),
  };
}

export function buildEmployeeOnboardingFields(
  value: unknown,
): EmployeeOnboardingBitableFields {
  const request = parseEmployeeOnboardingRequest(value);
  return buildEmployeeOnboardingFieldsFromValidatedRequest(request);
}

export function buildEmployeeOnboardingFieldsFromValidatedRequest(
  request: EmployeeOnboardingValidatedRequest,
): EmployeeOnboardingBitableFields {
  return {
    MBTI: request.mbtiType,
    姓名: request.name,
    用工性质: request.employmentType,
    公司名称: request.companyName,
    岗位: request.position,
    身份证号: request.identityNumber,
    联系方式: request.phone,
    入职日期: toShanghaiDateMilliseconds(request.entryDate),
    学历: request.education,
    毕业院校: request.graduateSchool,
    所学专业: request.major,
    毕业时间: request.graduationDate.replaceAll('-', '/'),
    兴趣爱好: [...request.hobbies],
    ...(request.vehiclePlate ? { 车牌号: request.vehiclePlate } : {}),
  };
}

export function toShanghaiDateMilliseconds(value: string): number {
  const match = DATE_PATTERN.exec(value);
  if (!match || !isValidCalendarDate(value)) {
    throw new Error('日期必须是有效的 YYYY-MM-DD 日历日期');
  }
  const [, year, month, day] = match;
  return (
    Date.UTC(Number(year), Number(month) - 1, Number(day)) -
    SHANGHAI_UTC_OFFSET_MILLISECONDS
  );
}

function readMutationId(
  value: unknown,
  issues: EmployeeOnboardingValidationIssue[],
): string {
  if (!isEmployeeOnboardingClientMutationId(value)) {
    addIssue(
      issues,
      'clientMutationId',
      'clientMutationId 必须是 employee-onboarding- 加 UUID v4',
    );
    return '';
  }
  return value;
}

function readRequiredString(
  value: unknown,
  field: string,
  label: string,
  issues: EmployeeOnboardingValidationIssue[],
  maxLength?: number,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    addIssue(issues, field, `${label}不能为空`);
    return '';
  }
  const normalized = value.trim();
  validateTextLength(normalized, field, label, maxLength, issues);
  return normalized;
}

function readOptionalString(
  value: unknown,
  field: string,
  label: string,
  issues: EmployeeOnboardingValidationIssue[],
  maxLength?: number,
  normalize: (value: string) => string = (value) => value,
): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    addIssue(issues, field, `${label}必须是字符串`);
    return '';
  }
  const normalized = normalize(value.trim());
  validateTextLength(normalized, field, label, maxLength, issues);
  return normalized;
}

function validateTextLength(
  value: string,
  field: string,
  label: string,
  maxLength: number | undefined,
  issues: EmployeeOnboardingValidationIssue[],
): void {
  if (maxLength !== undefined && Array.from(value).length > maxLength) {
    addIssue(issues, field, `${label}不能超过 ${maxLength} 个字符`);
  }
}

function readOption(
  value: unknown,
  field: string,
  label: string,
  allowed: ReadonlySet<string>,
  issues: EmployeeOnboardingValidationIssue[],
): string {
  const normalized = readRequiredString(value, field, label, issues);
  if (normalized && !allowed.has(normalized)) {
    addIssue(issues, field, `${label}不在允许选项中`);
  }
  return normalized;
}

function readIdentityNumber(
  value: unknown,
  issues: EmployeeOnboardingValidationIssue[],
): string {
  const normalized = readRequiredString(
    value,
    'identityNumber',
    '身份证号',
    issues,
  ).toUpperCase();
  if (normalized && !isValidIdentityNumber(normalized)) {
    addIssue(issues, 'identityNumber', '身份证号必须是校验位正确的 18 位号码');
  }
  return normalized;
}

function readPhone(
  value: unknown,
  issues: EmployeeOnboardingValidationIssue[],
): string {
  const normalized = readRequiredString(value, 'phone', '联系方式', issues);
  if (normalized && !MAINLAND_MOBILE_PATTERN.test(normalized)) {
    addIssue(issues, 'phone', '联系方式必须是有效的中国大陆 11 位手机号');
  }
  return normalized;
}

function readDate(
  value: unknown,
  field: string,
  label: string,
  issues: EmployeeOnboardingValidationIssue[],
): string {
  const normalized = readRequiredString(value, field, label, issues);
  if (normalized && !isValidCalendarDate(normalized)) {
    addIssue(issues, field, `${label}必须是有效的 YYYY-MM-DD 日历日期`);
  }
  return normalized;
}

function readHobbies(
  value: unknown,
  issues: EmployeeOnboardingValidationIssue[],
): EmployeeOnboardingHobby[] {
  if (!Array.isArray(value) || value.length === 0) {
    addIssue(issues, 'hobbies', '兴趣爱好至少选择一项');
    return [];
  }

  const normalized: string[] = [];
  let hasInvalidItem = false;
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      hasInvalidItem = true;
      continue;
    }
    const hobby = item.trim();
    if (!HOBBY_SET.has(hobby)) {
      hasInvalidItem = true;
      continue;
    }
    if (!normalized.includes(hobby)) normalized.push(hobby);
  }

  if (hasInvalidItem) {
    addIssue(issues, 'hobbies', '兴趣爱好包含不在允许选项中的值');
  }
  if (normalized.length === 0 && !hasInvalidItem) {
    addIssue(issues, 'hobbies', '兴趣爱好至少选择一项');
  }
  return normalized as EmployeeOnboardingHobby[];
}

function isValidIdentityNumber(value: string): boolean {
  if (!IDENTITY_NUMBER_PATTERN.test(value)) return false;

  const birthDate = `${value.slice(6, 10)}-${value.slice(10, 12)}-${value.slice(12, 14)}`;
  if (!isValidCalendarDate(birthDate)) return false;

  const checksum = value
    .slice(0, 17)
    .split('')
    .reduce(
      (sum, digit, index) =>
        sum + Number(digit) * IDENTITY_CHECKSUM_WEIGHTS[index],
      0,
    );
  return IDENTITY_CHECKSUM_CODES[checksum % 11] === value[17];
}

function isValidCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1];
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function addIssue(
  issues: EmployeeOnboardingValidationIssue[],
  field: string,
  message: string,
): void {
  issues.push({ field, message });
}
