import type { ChangeInfo } from './api.interface';

export const CHANGE_REQUEST_NATURES = ['标准变更', '非标准变更'] as const;
export const CHANGE_REQUEST_TYPES = ['计划性变更', '紧急变更'] as const;
export const CHANGE_REQUEST_WORK_TYPES = [
  '维护',
  '检修',
  '施工',
  '其他',
  '升级改善',
] as const;
export const CHANGE_REQUEST_BUILDINGS = [
  'A楼',
  'B楼',
  'C楼',
  'D楼',
  'E楼',
  '110站',
  'H楼',
] as const;
export const CHANGE_REQUEST_DISCIPLINES = [
  '电气',
  '暖通',
  '弱电',
  '消防',
  '其他',
] as const;
export const CHANGE_REQUEST_LEVELS = ['高', '中', '低', '超低'] as const;

export const CHANGE_REQUEST_SUMMARY_MAX_LENGTH = 500;
export const CHANGE_REQUEST_RISK_SUMMARY_MAX_LENGTH = 2000;
export const CHANGE_REQUEST_SUBMITTER_NAME_MAX_LENGTH = 64;
export const CHANGE_REQUEST_MAX_DOCUMENT_COUNT = 5;
export const CHANGE_REQUEST_MAX_DOCUMENT_SIZE = 200 * 1024 * 1024;
export const CHANGE_REQUEST_ATTACHMENT_PARTIAL_FAILURE_CODE =
  'CHANGE_REQUEST_ATTACHMENT_PARTIAL_FAILURE' as const;

export type ChangeRequestNature = (typeof CHANGE_REQUEST_NATURES)[number];
export type ChangeRequestType = (typeof CHANGE_REQUEST_TYPES)[number];
export type ChangeRequestWorkType = (typeof CHANGE_REQUEST_WORK_TYPES)[number];
export type ChangeRequestBuilding = (typeof CHANGE_REQUEST_BUILDINGS)[number];
export type ChangeRequestDiscipline =
  (typeof CHANGE_REQUEST_DISCIPLINES)[number];
export type ChangeRequestLevel = (typeof CHANGE_REQUEST_LEVELS)[number];

export interface ChangeRequestObjectStorageMetadata {
  id: string;
  filePath: string;
  bucketId: string;
  url: string;
}

export interface ChangeRequestStagedDocument extends ChangeRequestDocumentInput {
  readonly objectStorage: ChangeRequestObjectStorageMetadata;
}

export interface ChangeRequestPerson {
  /** Public, irreversible identifier; the Feishu account stays on the server. */
  id: string;
  name: string;
  description?: string;
}

export interface ChangeRequestPeopleResponse {
  people: ChangeRequestPerson[];
  snapshotAt: number;
}

export interface ChangeRequestDraft {
  submitterId?: string;
  /** Optional in the transport type for legacy callers; submission validation requires it. */
  submitterName?: string;
  /** Object-storage references used by the non-blocking submission path. */
  stagedDocuments?: ChangeRequestStagedDocument[];
  nature?: ChangeRequestNature;
  meetingStartAt: string;
  meetingEndAt: string;
  summary: string;
  changeType?: ChangeRequestType;
  workType?: ChangeRequestWorkType;
  buildings: ChangeRequestBuilding[];
  plannedStartAt: string;
  plannedEndAt: string;
  discipline?: ChangeRequestDiscipline;
  level?: ChangeRequestLevel;
  riskSummary: string;
}

export interface ChangeRequestCreateRequest {
  clientMutationId: string;
  submitterId?: string;
  /** Optional in the transport type for legacy callers; submission validation requires it. */
  submitterName?: string;
  /** Object-storage references used by the non-blocking submission path. */
  stagedDocuments?: ChangeRequestStagedDocument[];
  nature: ChangeRequestNature;
  meetingStartAt?: string;
  meetingEndAt?: string;
  summary: string;
  changeType: ChangeRequestType;
  workType: ChangeRequestWorkType;
  buildings: ChangeRequestBuilding[];
  plannedStartAt: string;
  plannedEndAt: string;
  discipline: ChangeRequestDiscipline;
  level: ChangeRequestLevel;
  riskSummary: string;
}

export interface ChangeRequestCreateResponse {
  success: boolean;
  clientMutationId: string;
  record: ChangeInfo;
  pendingSync?: boolean;
  taskId?: string;
  message: string;
}

export interface ChangeAttachmentStageResponse {
  success: boolean;
  document: ChangeRequestStagedDocument;
}

export interface ChangeAttachmentDeleteResponse {
  success: boolean;
  id: string;
}

export type ChangeRequestDocumentSyncStage = 'upload' | 'record-link';
export type ChangeRequestDocumentSyncStatus =
  | 'attached'
  | 'uploaded_pending_attach'
  | 'upload_failed';

export interface ChangeRequestDocumentSyncResult {
  name: string;
  size: number;
  status: ChangeRequestDocumentSyncStatus;
  stage: ChangeRequestDocumentSyncStage;
  retryable: boolean;
  message?: string;
}

export type ChangeRequestRecordState = 'not-created' | 'unknown' | 'created';
export type ChangeRequestRetryAction =
  | 'retry-same-mutation'
  | 'manual-reconcile';

export interface ChangeRequestAttachmentPartialFailure {
  code: typeof CHANGE_REQUEST_ATTACHMENT_PARTIAL_FAILURE_CODE;
  clientMutationId: string;
  recordState: ChangeRequestRecordState;
  recordCreated: boolean | null;
  retryAction: ChangeRequestRetryAction;
  recordId: string;
  record: ChangeInfo;
  documents: ChangeRequestDocumentSyncResult[];
  message: string;
}

export type ChangeRequestValidationField =
  | 'payload'
  | 'clientMutationId'
  | keyof ChangeRequestDraft
  | 'documents';

export interface ChangeRequestValidationError {
  field: ChangeRequestValidationField;
  message: string;
}

export interface ChangeRequestDocumentInput {
  readonly name?: string;
  readonly originalname?: string;
  readonly type?: string;
  readonly mimetype?: string;
  readonly size: number;
}

export interface ChangeRequestValidationContext {
  readonly documents?: readonly ChangeRequestDocumentInput[];
  /** Legacy multer naming retained for older controllers. */
  readonly files?: readonly ChangeRequestDocumentInput[];
  readonly documentCount?: number;
}

const CHANGE_REQUEST_MUTATION_ID_PATTERN =
  /^change-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

const DOCUMENT_MIME_TYPES_BY_EXTENSION: Readonly<
  Record<string, readonly string[]>
> = {
  '.pdf': ['application/pdf'],
  '.doc': ['application/msword'],
  '.docx': [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  '.xls': ['application/vnd.ms-excel'],
  '.xlsx': [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
  '.png': ['image/png'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
};

export function createEmptyChangeRequestDraft(): ChangeRequestDraft {
  return {
    submitterName: '',
    stagedDocuments: [],
    nature: undefined,
    meetingStartAt: '',
    meetingEndAt: '',
    summary: '',
    changeType: undefined,
    workType: undefined,
    buildings: [],
    plannedStartAt: '',
    plannedEndAt: '',
    discipline: undefined,
    level: undefined,
    riskSummary: '',
  };
}

export function parseChangeRequestPayload(
  payload: unknown,
): ChangeRequestCreateRequest {
  let parsed = payload;
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      throw new Error('变更申请 payload 不是有效 JSON');
    }
  }

  if (!isRecord(parsed)) {
    throw new Error('变更申请 payload 必须是 JSON 对象');
  }

  return parsed as unknown as ChangeRequestCreateRequest;
}

export function validateChangeRequest(
  request: unknown,
  context?: ChangeRequestValidationContext,
): ChangeRequestValidationError[] {
  if (!isRecord(request)) {
    return [{ field: 'payload', message: '变更申请数据格式无效' }];
  }

  const errors: ChangeRequestValidationError[] = [];
  if (
    request.submitterId !== undefined &&
    (typeof request.submitterId !== 'string' ||
      !/^cr-person-[a-f0-9]{64}$/.test(request.submitterId))
  ) {
    addError(errors, 'submitterName', '提交人标识无效，请重新搜索选择');
  }
  const clientMutationId = getTrimmedString(request.clientMutationId);
  if (!CHANGE_REQUEST_MUTATION_ID_PATTERN.test(clientMutationId)) {
    addError(errors, 'clientMutationId', '请求标识必须是 change-request-UUID');
  }

  validateRequiredText(
    request.submitterName,
    'submitterName',
    '请选择变更提交人',
    CHANGE_REQUEST_SUBMITTER_NAME_MAX_LENGTH,
    errors,
  );

  const nature = validateOption(
    request.nature,
    CHANGE_REQUEST_NATURES,
    'nature',
    '请选择变更性质',
    errors,
  );
  validateOption(
    request.changeType,
    CHANGE_REQUEST_TYPES,
    'changeType',
    '请选择变更类型',
    errors,
  );
  validateOption(
    request.workType,
    CHANGE_REQUEST_WORK_TYPES,
    'workType',
    '请选择作业类型',
    errors,
  );
  validateOption(
    request.discipline,
    CHANGE_REQUEST_DISCIPLINES,
    'discipline',
    '请选择专业',
    errors,
  );
  validateOption(
    request.level,
    CHANGE_REQUEST_LEVELS,
    'level',
    '请选择变更等级',
    errors,
  );
  validateBuildings(request.buildings, errors);

  validateRequiredText(
    request.summary,
    'summary',
    '请填写变更简述',
    CHANGE_REQUEST_SUMMARY_MAX_LENGTH,
    errors,
  );
  validateRequiredText(
    request.riskSummary,
    'riskSummary',
    '请填写变更重要风险点',
    CHANGE_REQUEST_RISK_SUMMARY_MAX_LENGTH,
    errors,
  );

  const plannedStart = validateRequiredDateTime(
    request.plannedStartAt,
    'plannedStartAt',
    '请选择计划开始时间',
    errors,
  );
  const plannedEnd = validateRequiredDateTime(
    request.plannedEndAt,
    'plannedEndAt',
    '请选择计划结束时间',
    errors,
  );
  if (
    plannedStart !== null &&
    plannedEnd !== null &&
    plannedEnd <= plannedStart
  ) {
    addError(errors, 'plannedEndAt', '计划结束时间必须晚于开始时间');
  }

  const meetingStartValue = getTrimmedString(request.meetingStartAt);
  const meetingEndValue = getTrimmedString(request.meetingEndAt);
  let meetingStart: number | null = null;
  let meetingEnd: number | null = null;

  if (nature === '非标准变更' && !meetingStartValue) {
    addError(errors, 'meetingStartAt', '请选择会议开始时间');
  } else if (meetingStartValue) {
    meetingStart = parseLocalDateTime(meetingStartValue);
    if (meetingStart === null) {
      addError(errors, 'meetingStartAt', '会议开始时间格式无效');
    }
  }

  if (meetingEndValue) {
    meetingEnd = parseLocalDateTime(meetingEndValue);
    if (meetingEnd === null) {
      addError(errors, 'meetingEndAt', '会议结束时间格式无效');
    }
  }
  if (
    meetingStart !== null &&
    meetingEnd !== null &&
    meetingEnd <= meetingStart
  ) {
    addError(errors, 'meetingEndAt', '会议结束时间必须晚于开始时间');
  }

  const legacyDocuments = getLegacyDocuments(context);
  const legacyDocumentCount =
    legacyDocuments?.length ?? context?.documentCount ?? 0;
  const hasStagedDocuments =
    Array.isArray(request.stagedDocuments) &&
    request.stagedDocuments.length > 0;
  if (legacyDocumentCount > 0 && hasStagedDocuments) {
    addError(errors, 'documents', '不能同时提交文件和对象存储引用');
  }
  if (legacyDocumentCount > 0) {
    validateDocuments(
      { documents: legacyDocuments, documentCount: legacyDocumentCount },
      errors,
    );
  } else if (hasOwnProperty(request, 'stagedDocuments')) {
    validateStagedDocuments(request.stagedDocuments, errors);
  } else if (context !== undefined) {
    validateDocuments(context, errors);
  }

  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function addError(
  errors: ChangeRequestValidationError[],
  field: ChangeRequestValidationField,
  message: string,
): void {
  errors.push({ field, message });
}

function validateOption<T extends string>(
  value: unknown,
  options: readonly T[],
  field: ChangeRequestValidationField,
  message: string,
  errors: ChangeRequestValidationError[],
): T | null {
  const normalized = getTrimmedString(value);
  if (!options.includes(normalized as T)) {
    addError(errors, field, message);
    return null;
  }
  return normalized as T;
}

function validateBuildings(
  value: unknown,
  errors: ChangeRequestValidationError[],
): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (building) =>
        typeof building !== 'string' ||
        !CHANGE_REQUEST_BUILDINGS.includes(
          building.trim() as ChangeRequestBuilding,
        ),
    )
  ) {
    addError(errors, 'buildings', '请至少选择一个有效的变更楼栋');
  }
}

function validateRequiredText(
  value: unknown,
  field: 'submitterName' | 'summary' | 'riskSummary',
  requiredMessage: string,
  maxLength: number,
  errors: ChangeRequestValidationError[],
): void {
  const normalized = getTrimmedString(value);
  if (!normalized) {
    addError(errors, field, requiredMessage);
    return;
  }
  if ([...normalized].length > maxLength) {
    addError(
      errors,
      field,
      `${requiredMessage.replace('请填写', '')}不能超过 ${maxLength} 字`,
    );
  }
}

function validateRequiredDateTime(
  value: unknown,
  field: 'plannedStartAt' | 'plannedEndAt',
  requiredMessage: string,
  errors: ChangeRequestValidationError[],
): number | null {
  const normalized = getTrimmedString(value);
  if (!normalized) {
    addError(errors, field, requiredMessage);
    return null;
  }
  const parsed = parseLocalDateTime(normalized);
  if (parsed === null) {
    addError(errors, field, `${requiredMessage.replace('请选择', '')}格式无效`);
  }
  return parsed;
}

function parseLocalDateTime(value: string): number | null {
  const match = LOCAL_DATE_TIME_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }

  return (((year * 12 + month) * 32 + day) * 24 + hour) * 60 + minute;
}

function daysInMonth(year: number, month: number): number {
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1];
}

function validateDocuments(
  context: ChangeRequestValidationContext,
  errors: ChangeRequestValidationError[],
): void {
  const documents = getLegacyDocuments(context);
  const documentCount = documents?.length ?? context.documentCount ?? 0;
  if (
    !Number.isInteger(documentCount) ||
    documentCount < 1 ||
    documentCount > CHANGE_REQUEST_MAX_DOCUMENT_COUNT
  ) {
    addError(
      errors,
      'documents',
      `请上传 1-${CHANGE_REQUEST_MAX_DOCUMENT_COUNT} 个变更文档`,
    );
  }

  if (!documents) {
    return;
  }

  for (const document of documents) {
    if (
      !Number.isFinite(document?.size) ||
      document.size < 0 ||
      document.size > CHANGE_REQUEST_MAX_DOCUMENT_SIZE
    ) {
      addError(errors, 'documents', '单个变更文档不能超过 200 MiB');
      continue;
    }

    if (!isAllowedChangeRequestDocument(document)) {
      addError(
        errors,
        'documents',
        '变更文档仅支持 PDF、Word、Excel、PNG、JPG、JPEG',
      );
    }
  }
}

function validateStagedDocuments(
  value: unknown,
  errors: ChangeRequestValidationError[],
): void {
  if (!Array.isArray(value)) {
    addError(errors, 'documents', '暂存变更文档格式无效');
    return;
  }

  validateDocuments(
    { documents: value as ChangeRequestStagedDocument[] },
    errors,
  );
  for (const document of value as ChangeRequestStagedDocument[]) {
    if (!isValidObjectStorageMetadata(document?.objectStorage)) {
      addError(errors, 'documents', '变更文档缺少有效的对象存储信息');
      break;
    }
  }
}

function isValidObjectStorageMetadata(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Boolean(getTrimmedString(value.id)) &&
    Boolean(getTrimmedString(value.filePath)) &&
    Boolean(getTrimmedString(value.bucketId)) &&
    isSafeChangeAttachmentUrl(value.url)
  );
}

function getLegacyDocuments(
  context?: ChangeRequestValidationContext,
): readonly ChangeRequestDocumentInput[] | undefined {
  if (context?.documents && context.documents.length > 0) {
    return context.documents;
  }
  return context?.files ?? context?.documents;
}

function hasOwnProperty(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

const CHANGE_ATTACHMENT_DOWNLOAD_PATH_PATTERN =
  /^\/api\/duty-schedules\/change-attachments\/[A-Za-z0-9_-]{1,160}\/download$/;

export function isSafeChangeAttachmentUrl(value: unknown): boolean {
  const normalized = getTrimmedString(value);
  if (CHANGE_ATTACHMENT_DOWNLOAD_PATH_PATTERN.test(normalized)) {
    return true;
  }
  if (!normalized || normalized.startsWith('/')) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === 'local' ||
    hostname.endsWith('.local')
  ) {
    return false;
  }
  if (isNonPublicIpv4(hostname) || isNonPublicIpv6(hostname)) {
    return false;
  }
  return hostname.includes('.') || hostname.includes(':');
}

function isNonPublicIpv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)
  ) {
    return false;
  }
  const [first, second] = parts.map(Number);
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function isNonPublicIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!normalized.includes(':')) {
    return false;
  }
  return (
    normalized === '::' ||
    normalized === '::1' ||
    /^f[cd]/.test(normalized) ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('::ffff:10.') ||
    normalized.startsWith('::ffff:169.254.') ||
    normalized.startsWith('::ffff:192.168.')
  );
}

export function isAllowedChangeRequestDocument(
  document: ChangeRequestDocumentInput,
): boolean {
  const name = (document.originalname || document.name || '').trim();
  const extensionMatch = /\.[^.]+$/.exec(name.toLowerCase());
  const extension = extensionMatch?.[0] || '';
  const allowedMimeTypes = DOCUMENT_MIME_TYPES_BY_EXTENSION[extension];
  if (!allowedMimeTypes) {
    return false;
  }

  const mimeType = (document.mimetype || document.type || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  return !mimeType || allowedMimeTypes.includes(mimeType);
}
