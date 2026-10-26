import {
  CHANGE_REQUEST_MAX_DOCUMENT_COUNT,
  CHANGE_REQUEST_MAX_DOCUMENT_SIZE,
  isAllowedChangeRequestDocument,
  isSafeChangeAttachmentUrl,
  type ChangeRequestDocumentInput,
} from './change-request';
import type { ChangeInfo } from './api.interface';

export const CHANGE_ADJUSTMENT_REASON_MAX_LENGTH = 1000;
export const CHANGE_ADJUSTMENT_EVIDENCE_MAX_COUNT = 5;
export const CHANGE_ADJUSTMENT_EVIDENCE_MAX_SIZE = 20 * 1024 * 1024;

export const CHANGE_ADJUSTMENT_LIFECYCLE_STATUSES = [
  'not-started',
  'in-progress',
  'finished',
] as const;

export type ChangeAdjustmentLifecycleStatus =
  (typeof CHANGE_ADJUSTMENT_LIFECYCLE_STATUSES)[number];

export interface ChangeAdjustmentObjectStorageMetadata {
  id: string;
  filePath: string;
  bucketId: string;
  url: string;
}

export interface ChangeAdjustmentFileInput extends ChangeRequestDocumentInput {
  readonly objectStorage?: ChangeAdjustmentObjectStorageMetadata;
}

export interface ChangeAdjustmentDraft {
  recordId: string;
  expectedUpdatedAt?: string;
  expectedVersion?: string | number;
  plannedDelayStartDate: string | null;
  plannedDelayEndDate: string | null;
  reason: string;
  retainedDocumentTokens: string[];
  removedDocumentTokens: string[];
  newSchemeDocuments: ChangeAdjustmentFileInput[];
  evidenceDocuments: ChangeAdjustmentFileInput[];
}

export interface ChangeAdjustmentRequest extends ChangeAdjustmentDraft {
  clientMutationId: string;
}

export interface ChangeAdjustmentResponse {
  success: boolean;
  clientMutationId: string;
  record: ChangeInfo;
  message: string;
}

export interface ChangeAdjustmentValidationContext {
  readonly lifecycleStatus: ChangeAdjustmentLifecycleStatus;
  readonly effectiveStartDate: string;
  readonly effectiveEndDate: string;
  /** Authoritative server time. Omit only for non-authoritative UI previews. */
  readonly currentTime?: string;
  readonly availableDocumentTokens?: readonly string[];
}

export type ChangeAdjustmentValidationField =
  | 'payload'
  | 'clientMutationId'
  | 'recordId'
  | 'expectedVersion'
  | 'expectedUpdatedAt'
  | 'lifecycleStatus'
  | 'plannedDelayStartDate'
  | 'plannedDelayEndDate'
  | 'reason'
  | 'retainedDocumentTokens'
  | 'removedDocumentTokens'
  | 'newSchemeDocuments'
  | 'evidenceDocuments';

export interface ChangeAdjustmentValidationError {
  field: ChangeAdjustmentValidationField;
  message: string;
}

const CHANGE_ADJUSTMENT_MUTATION_ID_PATTERN =
  /^change-adjustment-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;
const EVIDENCE_MIME_TYPES_BY_EXTENSION: Readonly<
  Record<string, readonly string[]>
> = {
  '.pdf': ['application/pdf'],
  '.png': ['image/png'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
};

export function createEmptyChangeAdjustmentDraft(): ChangeAdjustmentDraft {
  return {
    recordId: '',
    expectedUpdatedAt: '',
    expectedVersion: undefined,
    plannedDelayStartDate: '',
    plannedDelayEndDate: '',
    reason: '',
    retainedDocumentTokens: [],
    removedDocumentTokens: [],
    newSchemeDocuments: [],
    evidenceDocuments: [],
  };
}

export function validateChangeAdjustment(
  request: unknown,
  context: ChangeAdjustmentValidationContext,
): ChangeAdjustmentValidationError[] {
  if (!isRecord(request)) {
    return [{ field: 'payload', message: '变更调整数据格式无效' }];
  }

  const errors: ChangeAdjustmentValidationError[] = [];
  const mutationId = trimmedString(request.clientMutationId);
  if (!CHANGE_ADJUSTMENT_MUTATION_ID_PATTERN.test(mutationId)) {
    addError(
      errors,
      'clientMutationId',
      '请求标识必须是 change-adjustment-UUID',
    );
  }
  if (!trimmedString(request.recordId)) {
    addError(errors, 'recordId', '缺少变更记录 ID');
  }

  validateExpectedVersion(request, errors);
  validateReason(request.reason, errors);

  const retainedTokens = validateTokens(
    request.retainedDocumentTokens,
    'retainedDocumentTokens',
    errors,
  );
  const removedTokens = validateTokens(
    request.removedDocumentTokens,
    'removedDocumentTokens',
    errors,
  );
  if (
    retainedTokens !== null &&
    removedTokens !== null &&
    retainedTokens.some((token) => removedTokens.includes(token))
  ) {
    addError(errors, 'retainedDocumentTokens', '保留和删除的方案不能重复');
    addError(errors, 'removedDocumentTokens', '保留和删除的方案不能重复');
  }
  validateAvailableTokens(retainedTokens, removedTokens, context, errors);

  const newSchemeDocuments = validateSchemeDocuments(
    request.newSchemeDocuments,
    errors,
  );
  const schemeCount =
    (retainedTokens?.length ?? 0) + (newSchemeDocuments?.length ?? 0);
  if (
    retainedTokens !== null &&
    newSchemeDocuments !== null &&
    (schemeCount < 1 || schemeCount > CHANGE_REQUEST_MAX_DOCUMENT_COUNT)
  ) {
    addError(
      errors,
      'newSchemeDocuments',
      `调整后须保留 1-${CHANGE_REQUEST_MAX_DOCUMENT_COUNT} 个变更方案`,
    );
  }

  validateEvidenceDocuments(request.evidenceDocuments, errors);
  validateSchedule(request, context, errors);

  return errors;
}

function validateExpectedVersion(
  request: Record<string, unknown>,
  errors: ChangeAdjustmentValidationError[],
): void {
  const hasVersion =
    (typeof request.expectedVersion === 'string' &&
      request.expectedVersion.trim().length > 0) ||
    (typeof request.expectedVersion === 'number' &&
      Number.isFinite(request.expectedVersion) &&
      request.expectedVersion >= 0);
  const updatedAt = trimmedString(request.expectedUpdatedAt);
  const hasUpdatedAt =
    updatedAt.length > 0 && parseDateTime(updatedAt) !== null;

  if (request.expectedUpdatedAt !== undefined && updatedAt && !hasUpdatedAt) {
    addError(errors, 'expectedUpdatedAt', '记录更新时间格式无效');
  }
  if (!hasVersion && !hasUpdatedAt) {
    addError(errors, 'expectedVersion', '缺少记录版本或更新时间');
  }
}

function validateReason(
  value: unknown,
  errors: ChangeAdjustmentValidationError[],
): void {
  const reason = trimmedString(value);
  if (!reason) {
    addError(errors, 'reason', '请填写调整理由');
    return;
  }
  if ([...reason].length > CHANGE_ADJUSTMENT_REASON_MAX_LENGTH) {
    addError(
      errors,
      'reason',
      `调整理由不能超过 ${CHANGE_ADJUSTMENT_REASON_MAX_LENGTH} 字`,
    );
  }
}

function validateTokens(
  value: unknown,
  field: 'retainedDocumentTokens' | 'removedDocumentTokens',
  errors: ChangeAdjustmentValidationError[],
): string[] | null {
  if (!Array.isArray(value)) {
    addError(errors, field, '方案附件标识格式无效');
    return null;
  }
  const tokens = value.map(trimmedString);
  if (
    tokens.some((token) => !token) ||
    new Set(tokens).size !== tokens.length
  ) {
    addError(errors, field, '方案附件标识必须非空且不能重复');
    return null;
  }
  return tokens;
}

function validateSchemeDocuments(
  value: unknown,
  errors: ChangeAdjustmentValidationError[],
): ChangeAdjustmentFileInput[] | null {
  if (!Array.isArray(value)) {
    addError(errors, 'newSchemeDocuments', '新方案附件格式无效');
    return null;
  }
  const documents = value as ChangeAdjustmentFileInput[];
  for (const document of documents) {
    if (
      !isValidFileSize(document, CHANGE_REQUEST_MAX_DOCUMENT_SIZE) ||
      !isAllowedChangeRequestDocument(document) ||
      !isValidObjectStorageMetadata(document?.objectStorage)
    ) {
      addError(
        errors,
        'newSchemeDocuments',
        '新方案附件格式无效、超过 200 MiB 或缺少对象存储信息',
      );
      break;
    }
  }
  return documents;
}

function validateEvidenceDocuments(
  value: unknown,
  errors: ChangeAdjustmentValidationError[],
): void {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > CHANGE_ADJUSTMENT_EVIDENCE_MAX_COUNT
  ) {
    addError(
      errors,
      'evidenceDocuments',
      `请上传 1-${CHANGE_ADJUSTMENT_EVIDENCE_MAX_COUNT} 个延期举证`,
    );
    return;
  }

  for (const document of value as ChangeAdjustmentFileInput[]) {
    if (
      !isValidFileSize(document, CHANGE_ADJUSTMENT_EVIDENCE_MAX_SIZE) ||
      !isAllowedEvidenceDocument(document) ||
      !isValidObjectStorageMetadata(document?.objectStorage)
    ) {
      addError(
        errors,
        'evidenceDocuments',
        '延期举证仅支持图片/PDF，单个不能超过 20 MiB，且须完成对象存储',
      );
      break;
    }
  }
}

function validateSchedule(
  request: Record<string, unknown>,
  context: ChangeAdjustmentValidationContext,
  errors: ChangeAdjustmentValidationError[],
): void {
  const effectiveStart = parseDateTime(context.effectiveStartDate);
  const effectiveEnd = parseDateTime(context.effectiveEndDate);
  const currentTime =
    context.currentTime === undefined
      ? null
      : parseDateTime(context.currentTime);
  if (
    effectiveStart === null ||
    effectiveEnd === null ||
    effectiveEnd <= effectiveStart ||
    (context.currentTime !== undefined && currentTime === null)
  ) {
    addError(errors, 'lifecycleStatus', '变更当前有效时间范围无效');
    return;
  }
  if (!CHANGE_ADJUSTMENT_LIFECYCLE_STATUSES.includes(context.lifecycleStatus)) {
    addError(errors, 'lifecycleStatus', '变更状态无效');
    return;
  }
  if (context.lifecycleStatus === 'finished') {
    addError(errors, 'lifecycleStatus', '已结束的变更不能调整');
    return;
  }

  const startValue = trimmedString(request.plannedDelayStartDate);
  const endValue = trimmedString(request.plannedDelayEndDate);
  let adjustedStart: number | null = null;
  if (context.lifecycleStatus === 'not-started') {
    adjustedStart = validateRequiredDate(
      startValue,
      'plannedDelayStartDate',
      '请选择调整后的开始时间',
      errors,
    );
  } else if (startValue) {
    addError(errors, 'plannedDelayStartDate', '进行中的变更不能调整开始时间');
  }

  const adjustedEnd = validateRequiredDate(
    endValue,
    'plannedDelayEndDate',
    '请选择调整后的结束时间',
    errors,
  );
  const comparisonStart = adjustedStart ?? effectiveStart;
  if (
    adjustedEnd !== null &&
    comparisonStart !== null &&
    adjustedEnd <= comparisonStart
  ) {
    addError(errors, 'plannedDelayEndDate', '调整结束时间必须晚于有效开始时间');
  }
  if (
    adjustedEnd !== null &&
    currentTime !== null &&
    adjustedEnd <= currentTime
  ) {
    addError(errors, 'plannedDelayEndDate', '调整结束时间必须晚于当前时间');
  }
}

function validateRequiredDate(
  value: string,
  field: 'plannedDelayStartDate' | 'plannedDelayEndDate',
  requiredMessage: string,
  errors: ChangeAdjustmentValidationError[],
): number | null {
  if (!value) {
    addError(errors, field, requiredMessage);
    return null;
  }
  const parsed = parseDateTime(value);
  if (parsed === null) {
    addError(errors, field, `${requiredMessage.replace('请选择', '')}格式无效`);
  }
  return parsed;
}

function parseDateTime(value: string): number | null {
  const localMatch = LOCAL_DATE_TIME_PATTERN.exec(value);
  if (localMatch) {
    const year = Number(localMatch[1]);
    const month = Number(localMatch[2]);
    const day = Number(localMatch[3]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
      return null;
    }
    return Date.parse(`${value}:00+08:00`);
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function daysInMonth(year: number, month: number): number {
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ];
}

function isAllowedEvidenceDocument(
  document: ChangeAdjustmentFileInput,
): boolean {
  const name = (document.originalname || document.name || '').trim();
  const extension = /\.[^.]+$/.exec(name.toLowerCase())?.[0] || '';
  const allowedMimeTypes = EVIDENCE_MIME_TYPES_BY_EXTENSION[extension];
  if (!allowedMimeTypes) {
    return false;
  }
  const mimeType = (document.mimetype || document.type || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  return !mimeType || allowedMimeTypes.includes(mimeType);
}

function isValidFileSize(
  document: ChangeAdjustmentFileInput,
  maxSize: number,
): boolean {
  return (
    Number.isFinite(document?.size) &&
    document.size >= 0 &&
    document.size <= maxSize
  );
}

function isValidObjectStorageMetadata(
  value: unknown,
): value is ChangeAdjustmentObjectStorageMetadata {
  if (!isRecord(value)) {
    return false;
  }
  const url = trimmedString(value.url);
  return (
    Boolean(trimmedString(value.id)) &&
    Boolean(trimmedString(value.filePath)) &&
    Boolean(trimmedString(value.bucketId)) &&
    isSafeChangeAttachmentUrl(url)
  );
}

function validateAvailableTokens(
  retainedTokens: string[] | null,
  removedTokens: string[] | null,
  context: ChangeAdjustmentValidationContext,
  errors: ChangeAdjustmentValidationError[],
): void {
  if (context.availableDocumentTokens === undefined) {
    return;
  }
  const availableTokens = new Set(
    context.availableDocumentTokens.map((token) => token.trim()),
  );
  if (
    retainedTokens !== null &&
    retainedTokens.some((token) => !availableTokens.has(token))
  ) {
    addError(errors, 'retainedDocumentTokens', '保留方案不属于当前记录');
  }
  if (
    removedTokens !== null &&
    removedTokens.some((token) => !availableTokens.has(token))
  ) {
    addError(errors, 'removedDocumentTokens', '删除方案不属于当前记录');
  }
}

function addError(
  errors: ChangeAdjustmentValidationError[],
  field: ChangeAdjustmentValidationField,
  message: string,
): void {
  errors.push({ field, message });
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
