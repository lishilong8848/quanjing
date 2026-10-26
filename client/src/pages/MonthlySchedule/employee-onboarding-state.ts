import {
  EMPLOYEE_ONBOARDING_CLIENT_MUTATION_ID_PREFIX,
  EMPLOYEE_ONBOARDING_COMPANIES,
  EMPLOYEE_ONBOARDING_EDUCATIONS,
  EMPLOYEE_ONBOARDING_HOBBIES,
  EMPLOYEE_ONBOARDING_PHOTO_FILE_RULE,
  EMPLOYEE_ONBOARDING_POSITIONS,
  EMPLOYEE_ONBOARDING_TEXT_LIMITS,
  isEmployeeOnboardingClientMutationId,
  isEmployeeOnboardingCreateResponse,
  type EmployeeOnboardingCreateRequest,
  type EmployeeOnboardingCreateResponse,
  type EmployeeOnboardingFormValues,
  type EmployeeOnboardingHobby,
  type EmployeeOnboardingMbtiAssessment,
} from '@shared/employee-onboarding';
import { validateOnboardingMbtiAssessment } from '@shared/employee-onboarding-mbti';

export const EMPLOYEE_ONBOARDING_STORAGE_KEY =
  'monthly-schedule.employee-onboarding.mutation';

const LEDGER_VERSION = 1 as const;
const MAINLAND_MOBILE_PATTERN = /^1[3-9]\d{9}$/u;
const IDENTITY_NUMBER_PATTERN = /^\d{17}[\dX]$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
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

const COMPANIES = new Set<string>(EMPLOYEE_ONBOARDING_COMPANIES);
const POSITIONS = new Set<string>(EMPLOYEE_ONBOARDING_POSITIONS);
const EDUCATIONS = new Set<string>(EMPLOYEE_ONBOARDING_EDUCATIONS);
const HOBBIES = new Set<string>(EMPLOYEE_ONBOARDING_HOBBIES);

const PHOTO_EXTENSIONS_BY_MIME: Readonly<Record<string, readonly string[]>> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
};
export interface EmployeeOnboardingDraft {
  name: string;
  companyName: string;
  position: string;
  identityNumber: string;
  phone: string;
  entryDate: string;
  education: string;
  graduateSchool: string;
  major: string;
  graduationDate: string;
  hobbies: string[];
  vehiclePlate?: string;
  mbtiAssessment: EmployeeOnboardingMbtiAssessment | null;
}

export interface EmployeeOnboardingFileSelection {
  photo: File | null;
}

export type EmployeeOnboardingValidationField =
  | keyof EmployeeOnboardingDraft
  | 'photo';

export type EmployeeOnboardingValidationErrors = Partial<
  Record<EmployeeOnboardingValidationField, string>
>;

export type EmployeeOnboardingValidationResult =
  | {
      status: 'valid';
      values: EmployeeOnboardingFormValues;
      photo: File;
    }
  | {
      status: 'validation';
      errors: EmployeeOnboardingValidationErrors;
    };

export type EmployeeOnboardingLedgerStage =
  | 'in-flight'
  | 'editable-error'
  | 'conflict'
  | 'unknown-result';

export interface EmployeeOnboardingLedger {
  version: 1;
  clientMutationId: string;
  revision: number;
  stage: EmployeeOnboardingLedgerStage;
}

export interface EmployeeOnboardingMutationToken {
  readonly clientMutationId: string;
  readonly revision: number;
}

export type EmployeeOnboardingSnapshotValues = Readonly<
  Omit<EmployeeOnboardingFormValues, 'hobbies' | 'mbtiAssessment'> & {
    hobbies: readonly EmployeeOnboardingHobby[];
    mbtiAssessment: Readonly<EmployeeOnboardingMbtiAssessment>;
  }
>;

export interface EmployeeOnboardingSubmissionSnapshot {
  readonly values: EmployeeOnboardingSnapshotValues;
  readonly photo: File;
}

export type EmployeeOnboardingBeginResult =
  | {
      status: 'validation';
      errors: EmployeeOnboardingValidationErrors;
    }
  | { status: 'storage-error' }
  | { status: 'duplicate'; token: EmployeeOnboardingMutationToken }
  | {
      status: 'blocked-conflict';
      ledger: EmployeeOnboardingLedger;
      recovery: EmployeeOnboardingSubmissionSnapshot | null;
    }
  | {
      status: 'blocked-unknown-change';
      ledger: EmployeeOnboardingLedger;
      recovery: EmployeeOnboardingSubmissionSnapshot | null;
    }
  | {
      status: 'accepted';
      snapshot: EmployeeOnboardingSubmissionSnapshot;
      request: Readonly<EmployeeOnboardingCreateRequest>;
      token: EmployeeOnboardingMutationToken;
      closeImmediately: true;
      reusedMutationId: boolean;
    };

export type EmployeeOnboardingResolution =
  | { status: 'stale' }
  | {
      status: 'storage-error';
      recovery: EmployeeOnboardingSubmissionSnapshot;
      confirmedResponse?: EmployeeOnboardingCreateResponse;
    }
  | {
      status: 'editable-error' | 'conflict' | 'unknown-result';
      recovery: EmployeeOnboardingSubmissionSnapshot;
    }
  | {
      status: 'confirmed';
      response: EmployeeOnboardingCreateResponse;
    };

interface EmployeeOnboardingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface EmployeeOnboardingBinding {
  ledger: EmployeeOnboardingLedger;
  snapshot: EmployeeOnboardingSubmissionSnapshot;
  request: Readonly<EmployeeOnboardingCreateRequest>;
}

export interface EmployeeOnboardingCoordinator {
  begin(
    draft:
      | EmployeeOnboardingDraft
      | EmployeeOnboardingFormValues
      | EmployeeOnboardingSnapshotValues,
    files: EmployeeOnboardingFileSelection,
  ): EmployeeOnboardingBeginResult;
  resolveFailure(
    token: EmployeeOnboardingMutationToken,
    error: unknown,
  ): EmployeeOnboardingResolution;
  resolveSuccess(
    token: EmployeeOnboardingMutationToken,
    response: unknown,
  ): EmployeeOnboardingResolution;
  abandonConflict():
    | { status: 'cleared' }
    | { status: 'not-conflict' | 'stale' | 'storage-error' };
  getRecovery(): EmployeeOnboardingSubmissionSnapshot | null;
  getLedger(): EmployeeOnboardingLedger | null;
}

export interface CreateEmployeeOnboardingCoordinatorOptions {
  storage?: EmployeeOnboardingStorage | null;
}

export function validateEmployeeOnboardingDraft(
  draft:
    | EmployeeOnboardingDraft
    | EmployeeOnboardingFormValues
    | EmployeeOnboardingSnapshotValues,
  files: EmployeeOnboardingFileSelection,
): EmployeeOnboardingValidationResult {
  const errors: EmployeeOnboardingValidationErrors = {};
  const name = readRequiredText(
    draft.name,
    'name',
    '姓名',
    EMPLOYEE_ONBOARDING_TEXT_LIMITS.name,
    errors,
  );
  const companyName = readOption(
    draft.companyName,
    'companyName',
    '公司名称',
    COMPANIES,
    errors,
  );
  const position = readOption(
    draft.position,
    'position',
    '岗位',
    POSITIONS,
    errors,
  );
  const identityNumber = readRequiredText(
    draft.identityNumber,
    'identityNumber',
    '身份证号',
    undefined,
    errors,
  ).toUpperCase();
  if (identityNumber && !isValidIdentityNumber(identityNumber)) {
    errors.identityNumber = '身份证号必须是校验位正确的 18 位号码';
  }
  const phone = readRequiredText(
    draft.phone,
    'phone',
    '联系方式',
    undefined,
    errors,
  );
  if (phone && !MAINLAND_MOBILE_PATTERN.test(phone)) {
    errors.phone = '联系方式必须是有效的中国大陆 11 位手机号';
  }
  const entryDate = readDate(draft.entryDate, 'entryDate', '入职日期', errors);
  const education = readOption(
    draft.education,
    'education',
    '学历',
    EDUCATIONS,
    errors,
  );
  const graduateSchool = readRequiredText(
    draft.graduateSchool,
    'graduateSchool',
    '毕业院校',
    EMPLOYEE_ONBOARDING_TEXT_LIMITS.graduateSchool,
    errors,
  );
  const major = readRequiredText(
    draft.major,
    'major',
    '所学专业',
    EMPLOYEE_ONBOARDING_TEXT_LIMITS.major,
    errors,
  );
  const graduationDate = readDate(
    draft.graduationDate,
    'graduationDate',
    '毕业日期',
    errors,
  );
  const hobbies = readHobbies(draft.hobbies, errors);
  const vehiclePlate = readOptionalText(
    draft.vehiclePlate,
    'vehiclePlate',
    '车牌号',
    EMPLOYEE_ONBOARDING_TEXT_LIMITS.vehiclePlate,
    errors,
    (value) => value.toUpperCase(),
  );

  const mbti = validateOnboardingMbtiAssessment(draft.mbtiAssessment, name);
  if (!mbti) errors.mbtiAssessment = '请先完成 MBTI 测试';

  const selectedPhoto = files?.photo;
  if (!isFile(selectedPhoto)) {
    errors.photo = '请选择 1 张证件照';
  } else {
    validateFile(
      selectedPhoto,
      EMPLOYEE_ONBOARDING_PHOTO_FILE_RULE.maxBytesPerFile,
      PHOTO_EXTENSIONS_BY_MIME,
      'photo',
      '证件照',
      errors,
    );
  }

  if (Object.keys(errors).length > 0 || !isFile(selectedPhoto) || !mbti) {
    return { status: 'validation', errors };
  }

  return {
    status: 'valid',
    values: {
      name,
      companyName: companyName as EmployeeOnboardingFormValues['companyName'],
      position: position as EmployeeOnboardingFormValues['position'],
      identityNumber,
      phone,
      entryDate,
      education: education as EmployeeOnboardingFormValues['education'],
      graduateSchool,
      major,
      graduationDate,
      hobbies,
      mbtiAssessment: mbti.assessment,
      ...(vehiclePlate ? { vehiclePlate } : {}),
    },
    photo: selectedPhoto,
  };
}

export function createEmployeeOnboardingCoordinator(
  options: CreateEmployeeOnboardingCoordinatorOptions = {},
): EmployeeOnboardingCoordinator {
  const storage =
    options.storage === undefined ? getSessionStorage() : options.storage;
  let storageUsable = storage !== null;
  let ledger: EmployeeOnboardingLedger | null = null;
  let binding: EmployeeOnboardingBinding | null = null;
  let revision = 0;

  if (storage) {
    try {
      const raw = storage.getItem(EMPLOYEE_ONBOARDING_STORAGE_KEY);
      if (raw !== null) {
        const parsed = parseLedger(raw);
        if (parsed) {
          ledger = parsed;
          revision = parsed.revision;
        } else {
          storage.removeItem(EMPLOYEE_ONBOARDING_STORAGE_KEY);
        }
      }
    } catch {
      storageUsable = false;
    }
  }

  const comparePersistedLedger = (
    expected: EmployeeOnboardingLedger | null,
  ): 'matched' | 'conflict' | 'error' => {
    if (!storage || !storageUsable) return 'error';
    try {
      const raw = storage.getItem(EMPLOYEE_ONBOARDING_STORAGE_KEY);
      const current = raw === null ? null : parseLedger(raw);
      if (raw !== null && current === null) {
        storageUsable = false;
        return 'error';
      }
      return areLedgersEqual(current, expected) ? 'matched' : 'conflict';
    } catch {
      storageUsable = false;
      return 'error';
    }
  };

  const persist = (
    next: EmployeeOnboardingLedger,
    expected: EmployeeOnboardingLedger | null,
  ): 'written' | 'conflict' | 'error' => {
    const comparison = comparePersistedLedger(expected);
    if (comparison !== 'matched') return comparison;
    try {
      storage.setItem(
        EMPLOYEE_ONBOARDING_STORAGE_KEY,
        JSON.stringify({
          version: next.version,
          clientMutationId: next.clientMutationId,
          revision: next.revision,
          stage: next.stage,
        }),
      );
      return 'written';
    } catch {
      storageUsable = false;
      return 'error';
    }
  };

  const begin: EmployeeOnboardingCoordinator['begin'] = (draft, files) => {
    if (!storageUsable || !storage) return { status: 'storage-error' };
    if (binding?.ledger.stage === 'in-flight') {
      return {
        status: 'duplicate',
        token: createToken(binding.ledger),
      };
    }
    const conflictLedger =
      binding?.ledger.stage === 'conflict'
        ? binding.ledger
        : binding === null && ledger?.stage === 'conflict'
          ? ledger
          : null;
    if (conflictLedger) {
      return {
        status: 'blocked-conflict',
        ledger: freezeLedger(conflictLedger),
        recovery: binding?.snapshot ?? null,
      };
    }

    const validation = validateEmployeeOnboardingDraft(draft, files);
    if (validation.status === 'validation') return validation;

    const candidate = freezeSnapshot(validation);
    const persistedPendingLedger =
      binding === null &&
      ledger !== null &&
      (ledger.stage === 'unknown-result' || ledger.stage === 'in-flight')
        ? ledger
        : null;
    const hasSameSnapshot =
      binding !== null && areSnapshotsEqual(binding.snapshot, candidate);
    if (binding?.ledger.stage === 'unknown-result' && !hasSameSnapshot) {
      return {
        status: 'blocked-unknown-change',
        ledger: freezeLedger(binding.ledger),
        recovery: binding.snapshot,
      };
    }

    let reusedMutationId = false;
    let clientMutationId: string;
    if (persistedPendingLedger) {
      reusedMutationId = true;
      clientMutationId = persistedPendingLedger.clientMutationId;
    } else if (
      binding !== null &&
      hasSameSnapshot &&
      (binding.ledger.stage === 'unknown-result' ||
        binding.ledger.stage === 'editable-error')
    ) {
      reusedMutationId = true;
      clientMutationId = binding.ledger.clientMutationId;
    } else {
      clientMutationId = createEmployeeOnboardingMutationId();
    }
    const nextRevision = revision + 1;
    const nextLedger: EmployeeOnboardingLedger = {
      version: LEDGER_VERSION,
      clientMutationId,
      revision: nextRevision,
      stage: 'in-flight',
    };
    if (persist(nextLedger, ledger) !== 'written') {
      return { status: 'storage-error' };
    }

    const request = freezeRequest(clientMutationId, candidate.values);
    ledger = nextLedger;
    revision = nextRevision;
    binding = { ledger: nextLedger, snapshot: candidate, request };
    return {
      status: 'accepted',
      snapshot: candidate,
      request,
      token: createToken(nextLedger),
      closeImmediately: true,
      reusedMutationId,
    };
  };

  const setFailureStage = (
    token: EmployeeOnboardingMutationToken,
    stage: 'editable-error' | 'conflict' | 'unknown-result',
  ): EmployeeOnboardingResolution => {
    if (!isCurrentToken(binding, token)) return { status: 'stale' };
    const currentBinding = binding;
    const nextLedger: EmployeeOnboardingLedger = {
      ...currentBinding.ledger,
      stage,
    };
    const persisted = persist(nextLedger, currentBinding.ledger);
    if (persisted === 'conflict') return { status: 'stale' };
    if (persisted === 'error') {
      return {
        status: 'storage-error',
        recovery: currentBinding.snapshot,
      };
    }
    ledger = nextLedger;
    binding = { ...currentBinding, ledger: nextLedger };
    return { status: stage, recovery: binding.snapshot };
  };

  return {
    begin,
    resolveFailure(token, error) {
      return setFailureStage(token, classifyFailure(error));
    },
    resolveSuccess(token, response) {
      if (!isCurrentToken(binding, token)) return { status: 'stale' };
      const currentBinding = binding;
      if (
        !isEmployeeOnboardingCreateResponse(response) ||
        response.clientMutationId !== token.clientMutationId
      ) {
        return setFailureStage(token, 'unknown-result');
      }

      if (!storage || !storageUsable) {
        return {
          status: 'storage-error',
          recovery: currentBinding.snapshot,
          confirmedResponse: response,
        };
      }
      const comparison = comparePersistedLedger(currentBinding.ledger);
      if (comparison === 'conflict') return { status: 'stale' };
      if (comparison === 'error') {
        return {
          status: 'storage-error',
          recovery: currentBinding.snapshot,
          confirmedResponse: response,
        };
      }
      try {
        storage.removeItem(EMPLOYEE_ONBOARDING_STORAGE_KEY);
      } catch {
        storageUsable = false;
        return {
          status: 'storage-error',
          recovery: currentBinding.snapshot,
          confirmedResponse: response,
        };
      }
      ledger = null;
      binding = null;
      return { status: 'confirmed', response };
    },
    abandonConflict() {
      if (!storage || !storageUsable) return { status: 'storage-error' };
      const conflictLedger =
        binding?.ledger.stage === 'conflict'
          ? binding.ledger
          : binding === null && ledger?.stage === 'conflict'
            ? ledger
            : null;
      if (!conflictLedger) return { status: 'not-conflict' };

      const comparison = comparePersistedLedger(conflictLedger);
      if (comparison === 'conflict') return { status: 'stale' };
      if (comparison === 'error') return { status: 'storage-error' };
      try {
        storage.removeItem(EMPLOYEE_ONBOARDING_STORAGE_KEY);
      } catch {
        storageUsable = false;
        return { status: 'storage-error' };
      }
      ledger = null;
      binding = null;
      return { status: 'cleared' };
    },
    getRecovery() {
      return binding?.snapshot ?? null;
    },
    getLedger() {
      return ledger ? freezeLedger(ledger) : null;
    },
  };
}

export function createEmployeeOnboardingMutationId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID !== 'function') {
    throw new Error('当前浏览器不支持安全的提交标识');
  }
  const uuid = randomUUID.call(globalThis.crypto);
  if (!UUID_V4_PATTERN.test(uuid)) {
    throw new Error('当前浏览器无法生成安全的提交标识');
  }
  return `${EMPLOYEE_ONBOARDING_CLIENT_MUTATION_ID_PREFIX}${uuid.toLowerCase()}`;
}

function readRequiredText(
  value: unknown,
  field: keyof EmployeeOnboardingDraft,
  label: string,
  maxLength: number | undefined,
  errors: EmployeeOnboardingValidationErrors,
): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    errors[field] = `${label}为必填项`;
    return normalized;
  }
  validateTextLength(normalized, field, label, maxLength, errors);
  return normalized;
}

function readOptionalText(
  value: unknown,
  field: keyof EmployeeOnboardingDraft,
  label: string,
  maxLength: number,
  errors: EmployeeOnboardingValidationErrors,
  normalize: (value: string) => string,
): string {
  if (value === undefined) return '';
  const normalized = typeof value === 'string' ? normalize(value.trim()) : '';
  if (typeof value !== 'string') {
    errors[field] = `${label}格式不正确`;
    return '';
  }
  validateTextLength(normalized, field, label, maxLength, errors);
  return normalized;
}

function validateTextLength(
  value: string,
  field: keyof EmployeeOnboardingDraft,
  label: string,
  maxLength: number | undefined,
  errors: EmployeeOnboardingValidationErrors,
): void {
  if (maxLength !== undefined && Array.from(value).length > maxLength) {
    errors[field] = `${label}不能超过 ${maxLength} 个字符`;
  }
}

function readOption(
  value: unknown,
  field: keyof EmployeeOnboardingDraft,
  label: string,
  allowed: ReadonlySet<string>,
  errors: EmployeeOnboardingValidationErrors,
): string {
  const normalized = readRequiredText(value, field, label, undefined, errors);
  if (normalized && !allowed.has(normalized)) {
    errors[field] = `${label}不在允许选项中`;
  }
  return normalized;
}

function readDate(
  value: unknown,
  field: 'entryDate' | 'graduationDate',
  label: string,
  errors: EmployeeOnboardingValidationErrors,
): string {
  const normalized = readRequiredText(value, field, label, undefined, errors);
  if (normalized && !isValidCalendarDate(normalized)) {
    errors[field] = `${label}必须是有效的 YYYY-MM-DD 日历日期`;
  }
  return normalized;
}

function readHobbies(
  value: unknown,
  errors: EmployeeOnboardingValidationErrors,
): EmployeeOnboardingHobby[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.hobbies = '兴趣爱好至少选择一项';
    return [];
  }
  const normalized: string[] = [];
  for (const item of value) {
    const hobby = typeof item === 'string' ? item.trim() : '';
    if (!hobby || !HOBBIES.has(hobby)) {
      errors.hobbies = '兴趣爱好包含不在允许选项中的值';
      continue;
    }
    if (!normalized.includes(hobby)) normalized.push(hobby);
  }
  if (normalized.length === 0 && !errors.hobbies) {
    errors.hobbies = '兴趣爱好至少选择一项';
  }
  return normalized as EmployeeOnboardingHobby[];
}

function validateFile(
  file: File,
  maxBytes: number,
  extensionsByMime: Readonly<Record<string, readonly string[]>>,
  field: 'photo',
  label: string,
  errors: EmployeeOnboardingValidationErrors,
): boolean {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    errors[field] = `${label}不能为空文件`;
    return false;
  }
  if (file.size > maxBytes) {
    errors[field] = `${label}单个文件不能超过 10 MiB`;
    return false;
  }
  const allowedExtensions = extensionsByMime[file.type];
  const lowerName = file.name.toLowerCase();
  if (
    !allowedExtensions ||
    !allowedExtensions.some((extension) => lowerName.endsWith(extension))
  ) {
    errors[field] = `${label}的文件类型与扩展名不匹配`;
    return false;
  }
  return true;
}

function isFile(value: unknown): value is File {
  if (!isRecord(value)) return false;
  return (
    Object.prototype.toString.call(value) === '[object File]' &&
    typeof value.name === 'string' &&
    typeof value.type === 'string' &&
    typeof value.size === 'number' &&
    typeof value.slice === 'function' &&
    typeof value.arrayBuffer === 'function'
  );
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

function freezeSnapshot(
  validation: Extract<EmployeeOnboardingValidationResult, { status: 'valid' }>,
): EmployeeOnboardingSubmissionSnapshot {
  const hobbies = Object.freeze([...validation.values.hobbies]);
  const mbtiAssessment = Object.freeze({
    ...validation.values.mbtiAssessment,
    answers: Object.freeze([...validation.values.mbtiAssessment.answers]),
  });
  const values = Object.freeze({ ...validation.values, hobbies, mbtiAssessment });
  return Object.freeze({
    values,
    photo: validation.photo,
  });
}

function freezeRequest(
  clientMutationId: string,
  values: EmployeeOnboardingSnapshotValues,
): Readonly<EmployeeOnboardingCreateRequest> {
  return Object.freeze({
    ...values,
    hobbies: Object.freeze([...values.hobbies]),
    mbtiAssessment: Object.freeze({
      ...values.mbtiAssessment,
      answers: Object.freeze([...values.mbtiAssessment.answers]),
    }),
    clientMutationId,
  }) as Readonly<EmployeeOnboardingCreateRequest>;
}

function areSnapshotsEqual(
  left: EmployeeOnboardingSubmissionSnapshot,
  right: EmployeeOnboardingSubmissionSnapshot,
): boolean {
  const leftValues = left.values;
  const rightValues = right.values;
  return (
    leftValues.name === rightValues.name &&
    leftValues.companyName === rightValues.companyName &&
    leftValues.position === rightValues.position &&
    leftValues.identityNumber === rightValues.identityNumber &&
    leftValues.phone === rightValues.phone &&
    leftValues.entryDate === rightValues.entryDate &&
    leftValues.education === rightValues.education &&
    leftValues.graduateSchool === rightValues.graduateSchool &&
    leftValues.major === rightValues.major &&
    leftValues.graduationDate === rightValues.graduationDate &&
    (leftValues.vehiclePlate ?? '') === (rightValues.vehiclePlate ?? '') &&
    leftValues.hobbies.length === rightValues.hobbies.length &&
    leftValues.hobbies.every(
      (hobby, index) => hobby === rightValues.hobbies[index],
    ) &&
    leftValues.mbtiAssessment.participantName === rightValues.mbtiAssessment.participantName &&
    leftValues.mbtiAssessment.version === rightValues.mbtiAssessment.version &&
    leftValues.mbtiAssessment.sourceSha256 === rightValues.mbtiAssessment.sourceSha256 &&
    leftValues.mbtiAssessment.answers.length === rightValues.mbtiAssessment.answers.length &&
    leftValues.mbtiAssessment.answers.every(
      (answer, index) => answer === rightValues.mbtiAssessment.answers[index],
    ) &&
    left.photo === right.photo
  );
}

function createToken(
  ledger: EmployeeOnboardingLedger,
): EmployeeOnboardingMutationToken {
  return Object.freeze({
    clientMutationId: ledger.clientMutationId,
    revision: ledger.revision,
  });
}

function isCurrentToken(
  binding: EmployeeOnboardingBinding | null,
  token: EmployeeOnboardingMutationToken,
): binding is EmployeeOnboardingBinding {
  return (
    binding !== null &&
    binding.ledger.clientMutationId === token.clientMutationId &&
    binding.ledger.revision === token.revision
  );
}

function classifyFailure(
  error: unknown,
): 'editable-error' | 'conflict' | 'unknown-result' {
  let current: unknown = error;
  for (let depth = 0; depth <= 3; depth += 1) {
    if (!isRecord(current)) break;
    const response = isRecord(current.response) ? current.response : null;
    const status = Number(
      current.status ?? current.statusCode ?? response?.status,
    );
    if (status === 409) return 'conflict';
    if ([400, 401, 403, 413, 422, 429].includes(status)) {
      return 'editable-error';
    }
    if (status === 408 || status === 425 || status >= 500) {
      return 'unknown-result';
    }
    const name = String(current.name ?? '');
    const code = String(current.code ?? '').toUpperCase();
    const message = String(current.message ?? '');
    if (
      name === 'AbortError' ||
      [
        'ECONNABORTED',
        'ECONNREFUSED',
        'ECONNRESET',
        'EAI_AGAIN',
        'ENETDOWN',
        'ENETUNREACH',
        'ENOTFOUND',
        'ERR_CANCELED',
        'ERR_NETWORK',
        'ETIMEDOUT',
      ].includes(code) ||
      /network|failed to fetch|timeout|timed out|socket|connection reset/iu.test(
        message,
      ) ||
      (current.request !== undefined && current.response === undefined)
    ) {
      return 'unknown-result';
    }
    current = current.cause;
  }
  return 'unknown-result';
}

function parseLedger(raw: string): EmployeeOnboardingLedger | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    const keys = Object.keys(value).sort();
    if (
      keys.length !== 4 ||
      keys[0] !== 'clientMutationId' ||
      keys[1] !== 'revision' ||
      keys[2] !== 'stage' ||
      keys[3] !== 'version'
    ) {
      return null;
    }
    if (
      value.version !== LEDGER_VERSION ||
      !isEmployeeOnboardingClientMutationId(value.clientMutationId) ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 1 ||
      !['in-flight', 'editable-error', 'conflict', 'unknown-result'].includes(
        String(value.stage),
      )
    ) {
      return null;
    }
    return {
      version: LEDGER_VERSION,
      clientMutationId: value.clientMutationId,
      revision: Number(value.revision),
      stage: value.stage as EmployeeOnboardingLedgerStage,
    };
  } catch {
    return null;
  }
}

function freezeLedger(
  ledger: EmployeeOnboardingLedger,
): EmployeeOnboardingLedger {
  return Object.freeze({ ...ledger });
}

function areLedgersEqual(
  left: EmployeeOnboardingLedger | null,
  right: EmployeeOnboardingLedger | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.version === right.version &&
    left.clientMutationId === right.clientMutationId &&
    left.revision === right.revision &&
    left.stage === right.stage
  );
}

function getSessionStorage(): EmployeeOnboardingStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
