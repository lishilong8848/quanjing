import {
  CHANGE_REQUEST_MAX_DOCUMENT_COUNT,
  CHANGE_REQUEST_MAX_DOCUMENT_SIZE,
  CHANGE_REQUEST_SUBMITTER_NAME_MAX_LENGTH,
  isAllowedChangeRequestDocument,
  isSafeChangeAttachmentUrl,
  type ChangeRequestDocumentInput,
  type ChangeRequestStagedDocument,
} from './change-request';

export const CHANGE_SUMMARY_REPORT_MAX_DOCUMENT_COUNT =
  CHANGE_REQUEST_MAX_DOCUMENT_COUNT;
export const CHANGE_SUMMARY_REPORT_MAX_DOCUMENT_SIZE =
  CHANGE_REQUEST_MAX_DOCUMENT_SIZE;
export const CHANGE_SUMMARY_REPORT_SUBMITTER_NAME_MAX_LENGTH =
  CHANGE_REQUEST_SUBMITTER_NAME_MAX_LENGTH;
export const CHANGE_SUMMARY_REPORT_MUTATION_ID_PREFIX =
  'change-summary-report-' as const;

export interface ChangeSummaryReportDraft {
  submitterName: string;
  changeRecordId: string;
  summaryDocuments: ChangeRequestStagedDocument[];
}

export interface ChangeSummaryReportCreateRequest extends ChangeSummaryReportDraft {
  clientMutationId: string;
}

export interface ChangeSummaryReportCreateResponse {
  success: boolean;
  clientMutationId: string;
  changeRecordId: string;
  summaryReportRecordId?: string;
  pendingSync?: boolean;
  taskId: string;
  message: string;
}

export type ChangeSummaryReportSyncPhase =
  | 'accepted'
  | 'validating'
  | 'uploading'
  | 'record-created'
  | 'readback-confirmed'
  | 'binding'
  | 'completed'
  | 'failed';

export type ChangeSummaryReportSyncStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

export interface ChangeSummaryReportSyncTaskResponse {
  success: boolean;
  taskId: string;
  clientMutationId: string;
  changeRecordId: string;
  status: ChangeSummaryReportSyncStatus;
  phase: ChangeSummaryReportSyncPhase;
  summaryReportRecordId?: string;
  error?: string;
  message: string;
  updatedAt: string;
}

export interface ChangeSummaryReportAbandonRequest {
  clientMutationId: string;
  changeRecordId: string;
  submitterName: string;
}

export type ChangeSummaryReportAbandonPhase =
  | ChangeSummaryReportSyncPhase
  | 'cleanup-partial'
  | 'abandoned';

export interface ChangeSummaryReportAbandonResponse {
  success: true;
  clientMutationId: string;
  changeRecordId: string;
  canAbandon: boolean;
  abandoned: boolean;
  phase: ChangeSummaryReportAbandonPhase;
  message: string;
}

export type ChangeSummaryReportValidationField =
  | 'payload'
  | 'clientMutationId'
  | keyof ChangeSummaryReportDraft;

export interface ChangeSummaryReportValidationError {
  field: ChangeSummaryReportValidationField;
  message: string;
}

const CHANGE_SUMMARY_REPORT_MUTATION_ID_PATTERN =
  /^change-summary-report-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FEISHU_RECORD_ID_PATTERN = /^rec[A-Za-z0-9]{8,64}$/;

export function createEmptyChangeSummaryReportDraft(): ChangeSummaryReportDraft {
  return {
    submitterName: '',
    changeRecordId: '',
    summaryDocuments: [],
  };
}

export function parseChangeSummaryReportPayload(
  payload: unknown,
): ChangeSummaryReportCreateRequest {
  let parsed = payload;
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      throw new Error('变更总结 payload 不是有效 JSON');
    }
  }

  if (!isRecord(parsed)) {
    throw new Error('变更总结 payload 必须是 JSON 对象');
  }

  const errors = validateChangeSummaryReport(parsed);
  if (errors.length > 0) {
    throw new Error(errors[0].message);
  }
  if (!Array.isArray(parsed.summaryDocuments)) {
    throw new Error('请上传 1-5 个变更总结文档');
  }

  return {
    clientMutationId: trimmedString(parsed.clientMutationId),
    submitterName: normalizeChangeSummaryReportSubmitterName(
      parsed.submitterName,
    ),
    changeRecordId: trimmedString(parsed.changeRecordId),
    summaryDocuments: parsed.summaryDocuments.map(normalizeStagedDocument),
  };
}

export function validateChangeSummaryReport(
  request: unknown,
): ChangeSummaryReportValidationError[] {
  if (!isRecord(request)) {
    return [{ field: 'payload', message: '变更总结数据格式无效' }];
  }

  const errors: ChangeSummaryReportValidationError[] = [];
  if (
    !CHANGE_SUMMARY_REPORT_MUTATION_ID_PATTERN.test(
      trimmedString(request.clientMutationId),
    )
  ) {
    addError(
      errors,
      'clientMutationId',
      '请求标识必须是 change-summary-report-UUID',
    );
  }

  const submitterName = normalizeChangeSummaryReportSubmitterName(
    request.submitterName,
  );
  if (!submitterName) {
    addError(errors, 'submitterName', '请选择变更提交人');
  } else if (
    [...submitterName].length > CHANGE_SUMMARY_REPORT_SUBMITTER_NAME_MAX_LENGTH
  ) {
    addError(
      errors,
      'submitterName',
      `变更提交人不能超过 ${CHANGE_SUMMARY_REPORT_SUBMITTER_NAME_MAX_LENGTH} 字`,
    );
  }

  if (!FEISHU_RECORD_ID_PATTERN.test(trimmedString(request.changeRecordId))) {
    addError(errors, 'changeRecordId', '请选择有效的变更记录');
  }

  validateSummaryDocuments(request.summaryDocuments, errors);
  return errors;
}

function validateSummaryDocuments(
  value: unknown,
  errors: ChangeSummaryReportValidationError[],
): void {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > CHANGE_SUMMARY_REPORT_MAX_DOCUMENT_COUNT
  ) {
    addError(
      errors,
      'summaryDocuments',
      `请上传 1-${CHANGE_SUMMARY_REPORT_MAX_DOCUMENT_COUNT} 个变更总结文档`,
    );
    return;
  }

  const attachmentReferences = new Set<string>();
  for (const document of value) {
    if (!isRecord(document)) {
      addError(errors, 'summaryDocuments', '变更总结文档格式无效');
      return;
    }
    if (
      typeof document.size !== 'number' ||
      !Number.isFinite(document.size) ||
      document.size < 0 ||
      document.size > CHANGE_SUMMARY_REPORT_MAX_DOCUMENT_SIZE
    ) {
      addError(errors, 'summaryDocuments', '单个变更总结文档不能超过 200 MiB');
      return;
    }

    const normalizedDocument = getNormalizedDocumentInput(document);
    if (!normalizedDocument) {
      addError(errors, 'summaryDocuments', '变更总结文档格式无效');
      return;
    }
    if (!isAllowedChangeRequestDocument(normalizedDocument)) {
      addError(
        errors,
        'summaryDocuments',
        '变更总结文档仅支持 PDF、Word、Excel、PNG、JPG、JPEG',
      );
      return;
    }

    const objectStorage = getObjectStorageMetadata(document.objectStorage);
    if (!objectStorage) {
      addError(
        errors,
        'summaryDocuments',
        '变更总结文档缺少有效的对象存储信息',
      );
      return;
    }

    const references = [
      `id:${objectStorage.id}`,
      `path:${objectStorage.bucketId}\u0000${objectStorage.filePath}`,
      `url:${objectStorage.url}`,
    ];
    if (references.some((reference) => attachmentReferences.has(reference))) {
      addError(errors, 'summaryDocuments', '变更总结文档不能重复');
      return;
    }
    references.forEach((reference) => attachmentReferences.add(reference));
  }
}

function getNormalizedDocumentInput(
  value: Record<string, unknown>,
): ChangeRequestDocumentInput | null {
  const optionalStringFields = [
    'name',
    'originalname',
    'type',
    'mimetype',
  ] as const;
  if (
    optionalStringFields.some(
      (field) => field in value && typeof value[field] !== 'string',
    ) ||
    typeof value.size !== 'number'
  ) {
    return null;
  }

  return {
    ...(typeof value.name === 'string' ? { name: value.name.trim() } : {}),
    ...(typeof value.originalname === 'string'
      ? { originalname: value.originalname.trim() }
      : {}),
    ...(typeof value.type === 'string' ? { type: value.type.trim() } : {}),
    ...(typeof value.mimetype === 'string'
      ? { mimetype: value.mimetype.trim() }
      : {}),
    size: value.size,
  };
}

function getObjectStorageMetadata(value: unknown): {
  id: string;
  filePath: string;
  bucketId: string;
  url: string;
} | null {
  if (!isRecord(value)) {
    return null;
  }
  const metadata = {
    id: trimmedString(value.id),
    filePath: trimmedString(value.filePath),
    bucketId: trimmedString(value.bucketId),
    url: trimmedString(value.url),
  };
  return metadata.id &&
    metadata.filePath &&
    metadata.bucketId &&
    isSafeChangeAttachmentUrl(metadata.url)
    ? metadata
    : null;
}

function normalizeStagedDocument(value: unknown): ChangeRequestStagedDocument {
  if (!isRecord(value) || typeof value.size !== 'number') {
    throw new Error('变更总结文档格式无效');
  }
  const objectStorage = getObjectStorageMetadata(value.objectStorage);
  if (!objectStorage) {
    throw new Error('变更总结文档缺少有效的对象存储信息');
  }

  return {
    ...(typeof value.name === 'string' ? { name: value.name.trim() } : {}),
    ...(typeof value.originalname === 'string'
      ? { originalname: value.originalname.trim() }
      : {}),
    ...(typeof value.type === 'string' ? { type: value.type.trim() } : {}),
    ...(typeof value.mimetype === 'string'
      ? { mimetype: value.mimetype.trim() }
      : {}),
    size: value.size,
    objectStorage: { ...objectStorage },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeChangeSummaryReportSubmitterName(
  value: unknown,
): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : '';
}

function addError(
  errors: ChangeSummaryReportValidationError[],
  field: ChangeSummaryReportValidationField,
  message: string,
): void {
  errors.push({ field, message });
}
