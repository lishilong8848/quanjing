import {
  CHANGE_REQUEST_BUILDINGS,
  CHANGE_REQUEST_MAX_DOCUMENT_COUNT,
  CHANGE_REQUEST_MAX_DOCUMENT_SIZE,
  isAllowedChangeRequestDocument,
  isSafeChangeAttachmentUrl,
  type ChangeRequestBuilding,
  type ChangeRequestStagedDocument,
} from './change-request';

export const CHANGE_DRILL_REPORT_MAX_DOCUMENT_COUNT =
  CHANGE_REQUEST_MAX_DOCUMENT_COUNT;
export const CHANGE_DRILL_REPORT_MAX_DOCUMENT_SIZE =
  CHANGE_REQUEST_MAX_DOCUMENT_SIZE;
export const CHANGE_DRILL_REPORT_MUTATION_ID_PREFIX =
  'change-drill-report-' as const;

export interface ChangeDrillReportDraft {
  changeRecordId: string;
  buildings: ChangeRequestBuilding[];
  reportDocuments: ChangeRequestStagedDocument[];
}

export interface ChangeDrillReportCreateRequest extends ChangeDrillReportDraft {
  clientMutationId: string;
}

export interface ChangeDrillReportCreateResponse {
  success: boolean;
  clientMutationId: string;
  changeRecordId?: string;
  buildings?: ChangeRequestBuilding[];
  reportRecordId?: string;
  pendingSync?: boolean;
  taskId?: string;
  message: string;
}

export type ChangeDrillReportValidationField =
  | 'payload'
  | 'clientMutationId'
  | keyof ChangeDrillReportDraft;

export interface ChangeDrillReportValidationError {
  field: ChangeDrillReportValidationField;
  message: string;
}

const CHANGE_DRILL_REPORT_MUTATION_ID_PATTERN =
  /^change-drill-report-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FEISHU_RECORD_ID_PATTERN = /^rec[A-Za-z0-9]{8,64}$/;

export function createEmptyChangeDrillReportDraft(): ChangeDrillReportDraft {
  return {
    changeRecordId: '',
    buildings: [],
    reportDocuments: [],
  };
}

export function parseChangeDrillReportPayload(
  payload: unknown,
): ChangeDrillReportCreateRequest {
  let parsed = payload;
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      throw new Error('演练报告 payload 不是有效 JSON');
    }
  }

  if (!isRecord(parsed)) {
    throw new Error('演练报告 payload 必须是 JSON 对象');
  }

  return parsed as unknown as ChangeDrillReportCreateRequest;
}

export function validateChangeDrillReport(
  request: unknown,
): ChangeDrillReportValidationError[] {
  if (!isRecord(request)) {
    return [{ field: 'payload', message: '演练报告数据格式无效' }];
  }

  const errors: ChangeDrillReportValidationError[] = [];
  if (
    !CHANGE_DRILL_REPORT_MUTATION_ID_PATTERN.test(
      trimmedString(request.clientMutationId),
    )
  ) {
    addError(
      errors,
      'clientMutationId',
      '请求标识必须是 change-drill-report-UUID',
    );
  }

  if (!FEISHU_RECORD_ID_PATTERN.test(trimmedString(request.changeRecordId))) {
    addError(errors, 'changeRecordId', '请选择有效的变更记录');
  }

  validateBuildings(request.buildings, errors);
  validateReportDocuments(request.reportDocuments, errors);
  return errors;
}

function validateBuildings(
  value: unknown,
  errors: ChangeDrillReportValidationError[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    addError(errors, 'buildings', '请至少选择一个演练楼栋');
    return;
  }

  const normalized = value.map(trimmedString);
  if (
    normalized.some(
      (building) =>
        !CHANGE_REQUEST_BUILDINGS.includes(building as ChangeRequestBuilding),
    ) ||
    new Set(normalized).size !== normalized.length
  ) {
    addError(errors, 'buildings', '演练楼栋无效或存在重复');
  }
}

function validateReportDocuments(
  value: unknown,
  errors: ChangeDrillReportValidationError[],
): void {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > CHANGE_DRILL_REPORT_MAX_DOCUMENT_COUNT
  ) {
    addError(
      errors,
      'reportDocuments',
      `请上传 1-${CHANGE_DRILL_REPORT_MAX_DOCUMENT_COUNT} 个演练报告`,
    );
    return;
  }

  for (const document of value) {
    if (!isRecord(document)) {
      addError(errors, 'reportDocuments', '演练报告格式无效');
      return;
    }

    if (
      !Number.isFinite(document.size) ||
      Number(document.size) < 0 ||
      Number(document.size) > CHANGE_DRILL_REPORT_MAX_DOCUMENT_SIZE
    ) {
      addError(errors, 'reportDocuments', '单个演练报告不能超过 200 MiB');
      return;
    }

    if (
      !isAllowedChangeRequestDocument(
        document as unknown as ChangeRequestStagedDocument,
      )
    ) {
      addError(
        errors,
        'reportDocuments',
        '演练报告仅支持 PDF、Word、Excel、PNG、JPG、JPEG',
      );
      return;
    }

    if (!isValidObjectStorageMetadata(document.objectStorage)) {
      addError(errors, 'reportDocuments', '演练报告缺少有效的对象存储信息');
      return;
    }
  }
}

function isValidObjectStorageMetadata(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Boolean(trimmedString(value.id)) &&
    Boolean(trimmedString(value.filePath)) &&
    Boolean(trimmedString(value.bucketId)) &&
    isSafeChangeAttachmentUrl(value.url)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function addError(
  errors: ChangeDrillReportValidationError[],
  field: ChangeDrillReportValidationField,
  message: string,
): void {
  errors.push({ field, message });
}
