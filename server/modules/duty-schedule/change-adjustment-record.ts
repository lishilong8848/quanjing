import type {
  ChangeInfo,
  ChangeInfoDocument,
} from '../../../shared/api.interface';
import type { ChangeAdjustmentRecordSnapshot } from './change-adjustment.service';

export const CHANGE_ADJUSTMENT_RECORD_FIELDS = {
  title: ['fld4Mb34MM', '变更简述', '变更编码&描述', '变更名称', '内容'],
  plannedStartAt: [
    'fldVD5BNEQ',
    '计划开始日期（阿里）',
    '计划开始时间',
    '计划开始日期',
    '计划时间',
  ],
  plannedEndAt: [
    'fldrl38KPS',
    '计划结束日期（阿里）',
    '计划结束时间',
    '计划结束日期',
  ],
  actualStartAt: ['fldu91qLqi', '实际开始时间', '实际开始日期', '实际开始'],
  actualEndAt: ['fldnKfcbCa', '实际结束时间', '实际结束日期', '实际结束'],
  plannedDelayStartAt: [
    'fldDnCn6n4',
    '计划延迟开始日期',
    '计划延迟开始',
    '计划延迟开始时间',
    '计划延期开始',
    '延期开始',
  ],
  plannedDelayEndAt: [
    'fldThF1p25',
    '计划延迟结束日期',
    '计划延迟结束',
    '计划延迟结束时间',
    '计划延期结束',
    '延期结束',
  ],
  reason: ['延期理由'],
  evidence: ['fldQqzl4HN', '延期举证'],
  documents: ['fld0qzcXDh', '变更文档', '变更方案'],
  submitter: ['fld9oFnegn', 'fldmngj6bh', '变更提交人', '申请提交人'],
  workflowStatus: ['fld2MxlOnp', '变更提交审核流程（内部）'],
  summaryReport: ['flddJ80cXx', '变更总结报告'],
  requestUniqueId: ['调整请求唯一ID'],
  requestFingerprint: ['调整请求指纹'],
} as const;

const DEFAULT_ATTACHMENT_PROXY_BASE = '/api/duty-schedules/change-records';
const SAFE_RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_FILE_TOKEN = /^[A-Za-z0-9_-]{1,500}$/;
const SAFE_DIRECT_SUMMARY_FILE_TOKEN = /^box(?:cn)?[A-Za-z0-9_-]{4,494}$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_DEPTH = 64;
const MAX_NODES = 4096;
const MAX_ARRAY_LENGTH = 512;
const MAX_KEYS = 64;
const SUMMARY_ATTACHMENT_TOKEN_KEYS = [
  'file_token',
  'token',
  'attachmentToken',
] as const;
const SUMMARY_LOOKUP_CONTAINER_KEYS = [
  'raw_value',
  'value',
  'link_value',
  'items',
] as const;
const SUMMARY_LOOKUP_METADATA_KEYS = new Set([
  'type',
  'name',
  'text',
  'url',
  'tmp_url',
  'size',
  'mime_type',
  'mimeType',
  'extra',
  'timeStamp',
  'field_id',
  'record_id',
  'id',
  'multiple',
]);

export interface ChangeAdjustmentBaseRecord {
  id?: string;
  record_id?: string;
  fields?: Record<string, unknown>;
  created_time?: number | string;
  last_modified_time?: number | string;
  revision?: string | number;
  version?: string | number;
}

export interface ChangeAttachmentStorageResolution {
  id: string;
  filePath: string;
  bucketId: string;
  url: string;
}

export interface ChangeAttachmentStorageResolverInput {
  recordId: string;
  fileToken: string;
  kind: 'scheme' | 'evidence';
}

export type ChangeAttachmentStorageResolver = (
  input: ChangeAttachmentStorageResolverInput,
) =>
  | ChangeAttachmentStorageResolution
  | null
  | undefined
  | Promise<ChangeAttachmentStorageResolution | null | undefined>;

export interface ChangeAdjustmentRecordMapperOptions {
  attachmentProxyBasePath?: string;
  resolveStorage?: ChangeAttachmentStorageResolver;
}

export interface ParseChangeAttachmentFieldOptions {
  fieldLabel: string;
  recordId: string;
  attachmentProxyBasePath?: string;
}

export class ChangeAdjustmentRecordMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChangeAdjustmentRecordMappingError';
  }
}

interface FoundField {
  found: boolean;
  value: unknown;
}

interface ParsedRecordFields {
  recordId: string;
  title: string;
  plannedStartAt: string;
  plannedEndAt: string;
  actualStartAt: string | null;
  actualEndAt: string | null;
  plannedDelayStartAt: string | null;
  plannedDelayEndAt: string | null;
  reason: string | null;
  documents: ChangeInfoDocument[];
  evidence: ChangeInfoDocument[];
  submitterName: string | null;
  workflowStatus: string | null;
  hasSummaryReport: boolean;
  adjustmentMutationId: string | null;
  adjustmentFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
  version?: string | number;
}

export function buildChangeAttachmentProxyUrl(
  recordId: string,
  fileToken: string,
  basePath = DEFAULT_ATTACHMENT_PROXY_BASE,
): string {
  const normalizedBase = normalizeProxyBasePath(basePath);
  return `${normalizedBase}/${encodeURIComponent(recordId)}/attachments/${encodeURIComponent(fileToken)}`;
}

export function parseChangeAttachmentField(
  field: unknown,
  options: ParseChangeAttachmentFieldOptions,
): ChangeInfoDocument[] {
  assertSafeRecordId(options.recordId);
  if (field === null || field === undefined || field === '') return [];
  if (!Array.isArray(field)) {
    throw mappingError(`${options.fieldLabel}必须是附件数组`);
  }

  const seen = new Set<string>();
  return field.map((entry, index) => {
    if (!isRecord(entry)) {
      throw mappingError(`${options.fieldLabel}第 ${index + 1} 个附件格式无效`);
    }

    const fileToken = requiredSafeFileToken(
      entry.file_token ?? entry.fileToken,
      options.fieldLabel,
      index,
    );
    if (seen.has(fileToken)) {
      throw mappingError(`${options.fieldLabel}附件标识重复`);
    }
    seen.add(fileToken);

    const name = requiredAttachmentName(
      entry.name ?? entry.file_name ?? entry.fileName,
      options.fieldLabel,
      index,
    );
    const size = requiredAttachmentSize(entry.size, options.fieldLabel, index);
    const rawMimeType = entry.type ?? entry.mime_type ?? entry.mimeType;
    const mimeType =
      rawMimeType === null || rawMimeType === undefined
        ? 'application/octet-stream'
        : requiredSafeText(
            rawMimeType,
            `${options.fieldLabel}第 ${index + 1} 个附件类型`,
            255,
          );

    return {
      fileToken,
      name,
      size,
      mimeType,
      url: buildChangeAttachmentProxyUrl(
        options.recordId,
        fileToken,
        options.attachmentProxyBasePath,
      ),
      objectStorage: null,
    };
  });
}

export async function extendChangeInfoWithAdjustmentRecord(
  publicRecord: ChangeInfo,
  record: ChangeAdjustmentBaseRecord,
  options: ChangeAdjustmentRecordMapperOptions = {},
): Promise<ChangeInfo | null> {
  const parsed = await parseAndHydrateRecord(publicRecord, record, options);
  return parsed ? createPublicRecord(publicRecord, parsed) : null;
}

export async function mapChangeAdjustmentRecordSnapshot(
  record: ChangeAdjustmentBaseRecord,
  publicRecord: ChangeInfo,
  options: ChangeAdjustmentRecordMapperOptions = {},
): Promise<ChangeAdjustmentRecordSnapshot | null> {
  const parsed = await parseAndHydrateRecord(publicRecord, record, options);
  if (!parsed) return null;

  return {
    recordId: parsed.recordId,
    publicRecord: createPublicRecord(publicRecord, parsed),
    version: parsed.version,
    updatedAt: parsed.updatedAt,
    plannedStartAt: parsed.plannedStartAt,
    plannedEndAt: parsed.plannedEndAt,
    actualStartAt: parsed.actualStartAt,
    actualEndAt: parsed.actualEndAt,
    plannedDelayStartAt: parsed.plannedDelayStartAt,
    plannedDelayEndAt: parsed.plannedDelayEndAt,
    reason: parsed.reason,
    documents: cloneDocuments(parsed.documents),
    evidence: cloneDocuments(parsed.evidence),
    adjustmentMutationId: parsed.adjustmentMutationId,
    adjustmentFingerprint: parsed.adjustmentFingerprint,
  };
}

export function applyChangeAdjustmentSnapshotToChangeInfo(
  snapshot: ChangeAdjustmentRecordSnapshot,
  overrides: Partial<
    Pick<
      ChangeInfo,
      | 'scheduleStatus'
      | 'plannedDelayStartDate'
      | 'plannedDelayEndDate'
      | 'delayReason'
      | 'updatedAt'
    >
  > = {},
): ChangeInfo {
  return {
    ...snapshot.publicRecord,
    id: snapshot.recordId,
    bitableRecordId: snapshot.recordId,
    plannedDelayStartDate: toOptionalIso(snapshot.plannedDelayStartAt),
    plannedDelayEndDate: toOptionalIso(snapshot.plannedDelayEndAt),
    delayReason: normalizeNullableText(snapshot.reason, '延期理由', 1000),
    planDocuments: cloneDocuments(snapshot.documents),
    delayEvidence: cloneDocuments(snapshot.evidence || []),
    updatedAt:
      normalizeOptionalDate(snapshot.updatedAt, '更新时间') ||
      snapshot.publicRecord.updatedAt,
    ...overrides,
  };
}

async function parseAndHydrateRecord(
  publicRecord: ChangeInfo,
  record: ChangeAdjustmentBaseRecord,
  options: ChangeAdjustmentRecordMapperOptions,
): Promise<ParsedRecordFields | null> {
  const recordId = String(record.record_id || record.id || '').trim();
  if (!recordId) return null;
  assertSafeRecordId(recordId);
  const publicRecordId = String(
    publicRecord.bitableRecordId || publicRecord.id || '',
  ).trim();
  if (publicRecordId && publicRecordId !== recordId) {
    throw mappingError('定向回读记录标识不一致');
  }

  const fields = isRecord(record.fields) ? record.fields : {};
  const plannedStartAt = requiredDateFromFields(
    fields,
    CHANGE_ADJUSTMENT_RECORD_FIELDS.plannedStartAt,
    publicRecord.startDate,
    '计划开始日期',
  );
  const plannedEndAt = requiredDateFromFields(
    fields,
    CHANGE_ADJUSTMENT_RECORD_FIELDS.plannedEndAt,
    publicRecord.endDate,
    '计划结束日期',
  );
  const actualStartAt = optionalDateFromFields(
    fields,
    CHANGE_ADJUSTMENT_RECORD_FIELDS.actualStartAt,
    publicRecord.actualStartDate,
    '实际开始日期',
  );
  const actualEndAt = optionalDateFromFields(
    fields,
    CHANGE_ADJUSTMENT_RECORD_FIELDS.actualEndAt,
    publicRecord.actualEndDate,
    '实际结束日期',
  );
  const plannedDelayStartAt = optionalDateFromFields(
    fields,
    CHANGE_ADJUSTMENT_RECORD_FIELDS.plannedDelayStartAt,
    publicRecord.plannedDelayStartDate,
    '计划延迟开始日期',
  );
  const plannedDelayEndAt = optionalDateFromFields(
    fields,
    CHANGE_ADJUSTMENT_RECORD_FIELDS.plannedDelayEndAt,
    publicRecord.plannedDelayEndDate,
    '计划延迟结束日期',
  );

  const titleField = findField(fields, CHANGE_ADJUSTMENT_RECORD_FIELDS.title);
  const title = titleField.found
    ? requiredPublicText(titleField.value, '变更标题', 500)
    : requiredPublicText(publicRecord.title, '变更标题', 500);
  const reasonField = findField(fields, CHANGE_ADJUSTMENT_RECORD_FIELDS.reason);
  const reason = reasonField.found
    ? normalizeNullableText(reasonField.value, '延期理由', 1000)
    : normalizeNullableText(publicRecord.delayReason, '延期理由', 1000);
  const submitterField = findField(
    fields,
    CHANGE_ADJUSTMENT_RECORD_FIELDS.submitter,
  );
  const submitterName = submitterField.found
    ? extractSubmitterName(submitterField.value)
    : normalizeNullableText(publicRecord.submitterName, '申请提交人', 64);
  const workflowField = findField(
    fields,
    CHANGE_ADJUSTMENT_RECORD_FIELDS.workflowStatus,
  );
  const workflowStatus = workflowField.found
    ? normalizeWorkflowStatus(workflowField.value)
    : null;
  const summaryReportField = findField(
    fields,
    CHANGE_ADJUSTMENT_RECORD_FIELDS.summaryReport,
  );
  const hasSummaryReport = summaryReportField.found
    ? hasSafeSummaryReport(summaryReportField.value)
    : false;
  const mutationField = findField(
    fields,
    CHANGE_ADJUSTMENT_RECORD_FIELDS.requestUniqueId,
  );
  const fingerprintField = findField(
    fields,
    CHANGE_ADJUSTMENT_RECORD_FIELDS.requestFingerprint,
  );
  const adjustmentMutationId = mutationField.found
    ? normalizeOpaqueMarker(mutationField.value, '调整请求唯一ID')
    : null;
  const adjustmentFingerprint = fingerprintField.found
    ? normalizeOpaqueMarker(fingerprintField.value, '调整请求指纹')
    : null;

  const documentField = findField(
    fields,
    CHANGE_ADJUSTMENT_RECORD_FIELDS.documents,
  );
  const evidenceField = findField(
    fields,
    CHANGE_ADJUSTMENT_RECORD_FIELDS.evidence,
  );
  const documents = parseChangeAttachmentField(
    documentField.found ? documentField.value : undefined,
    {
      fieldLabel: '变更文档',
      recordId,
      attachmentProxyBasePath: options.attachmentProxyBasePath,
    },
  );
  const evidence = parseChangeAttachmentField(
    evidenceField.found ? evidenceField.value : undefined,
    {
      fieldLabel: '延期举证',
      recordId,
      attachmentProxyBasePath: options.attachmentProxyBasePath,
    },
  );
  assertNoCrossFieldDuplicateTokens(documents, evidence);
  await hydrateObjectStorage(
    documents,
    evidence,
    recordId,
    options.resolveStorage,
  );

  const updatedAt =
    normalizeOptionalDate(record.last_modified_time, '更新时间') ||
    requiredDateValue(publicRecord.updatedAt, '更新时间');
  const createdAt =
    normalizeOptionalDate(record.created_time, '创建时间') ||
    requiredDateValue(publicRecord.createdAt, '创建时间');

  return {
    recordId,
    title,
    plannedStartAt,
    plannedEndAt,
    actualStartAt,
    actualEndAt,
    plannedDelayStartAt,
    plannedDelayEndAt,
    reason,
    documents,
    evidence,
    submitterName,
    workflowStatus,
    hasSummaryReport,
    adjustmentMutationId,
    adjustmentFingerprint,
    createdAt,
    updatedAt,
    version: normalizeVersion(record),
  };
}

function createPublicRecord(
  source: ChangeInfo,
  parsed: ParsedRecordFields,
): ChangeInfo {
  return {
    ...source,
    id: parsed.recordId,
    bitableRecordId: parsed.recordId,
    title: parsed.title,
    startDate: parsed.plannedStartAt,
    endDate: parsed.plannedEndAt,
    actualStartDate: parsed.actualStartAt,
    actualEndDate: parsed.actualEndAt,
    plannedDelayStartDate: parsed.plannedDelayStartAt,
    plannedDelayEndDate: parsed.plannedDelayEndAt,
    submitterName: parsed.submitterName,
    workflowStatus: parsed.workflowStatus,
    hasSummaryReport: parsed.hasSummaryReport,
    // Base formula/status values are display-only. The adjustment core owns lifecycle.
    scheduleStatus: null,
    planDocuments: cloneDocuments(parsed.documents),
    delayReason: parsed.reason,
    delayEvidence: cloneDocuments(parsed.evidence),
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    adjustmentUpdatedAt: parsed.updatedAt,
  };
}

async function hydrateObjectStorage(
  documents: ChangeInfoDocument[],
  evidence: ChangeInfoDocument[],
  recordId: string,
  resolver?: ChangeAttachmentStorageResolver,
): Promise<void> {
  if (!resolver) return;
  const entries = [
    ...documents.map((document) => ({ document, kind: 'scheme' as const })),
    ...evidence.map((document) => ({ document, kind: 'evidence' as const })),
  ];
  for (const entry of entries) {
    const resolved = await resolver({
      recordId,
      fileToken: entry.document.fileToken,
      kind: entry.kind,
    });
    entry.document.objectStorage = resolved
      ? validateStorageResolution(resolved)
      : null;
  }
}

function validateStorageResolution(
  value: ChangeAttachmentStorageResolution,
): ChangeAttachmentStorageResolution {
  if (!isRecord(value)) {
    throw mappingError('对象存储元数据格式无效');
  }
  const id = requiredOpaqueText(value.id, '对象存储标识', 500);
  const bucketId = requiredOpaqueText(
    value.bucketId,
    '对象存储存储桶标识',
    255,
  );
  const filePath = requiredSafeText(value.filePath, '对象存储路径', 1024);
  if (
    filePath.startsWith('/') ||
    filePath.includes('\\') ||
    filePath
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw mappingError('对象存储路径格式无效');
  }
  const url = requiredSafeText(value.url, '对象存储访问地址', 4096);
  if (!isSafeHttpOrRelativeUrl(url)) {
    throw mappingError('对象存储访问地址格式无效');
  }
  return { id, filePath, bucketId, url };
}

function assertNoCrossFieldDuplicateTokens(
  documents: ChangeInfoDocument[],
  evidence: ChangeInfoDocument[],
): void {
  const documentTokens = new Set(documents.map((item) => item.fileToken));
  if (evidence.some((item) => documentTokens.has(item.fileToken))) {
    throw mappingError('变更文档与延期举证的附件标识重复');
  }
}

function requiredDateFromFields(
  fields: Record<string, unknown>,
  aliases: readonly string[],
  fallback: unknown,
  label: string,
): string {
  const field = findField(fields, aliases);
  return requiredDateValue(field.found ? field.value : fallback, label);
}

function optionalDateFromFields(
  fields: Record<string, unknown>,
  aliases: readonly string[],
  fallback: unknown,
  label: string,
): string | null {
  const field = findField(fields, aliases);
  return normalizeOptionalDate(field.found ? field.value : fallback, label);
}

function requiredDateValue(value: unknown, label: string): string {
  const date = normalizeOptionalDate(value, label);
  if (!date) throw mappingError(`${label}不能为空`);
  return date;
}

function normalizeOptionalDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value)) {
    const present = value.filter(
      (entry) => entry !== null && entry !== undefined && entry !== '',
    );
    if (present.length === 0) return null;
    if (present.length !== 1) throw mappingError(`${label}格式无效`);
    return normalizeOptionalDate(present[0], label);
  }
  if (isRecord(value)) {
    for (const key of ['timestamp', 'date', 'text', 'value']) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        return normalizeOptionalDate(value[key], label);
      }
    }
    throw mappingError(`${label}格式无效`);
  }

  let timestamp: number;
  if (typeof value === 'number') {
    timestamp = normalizeEpoch(value);
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (!text || CONTROL_CHARACTERS.test(text)) {
      throw mappingError(`${label}格式无效`);
    }
    if (/^\d{10}$/.test(text)) {
      timestamp = Number(text) * 1000;
    } else if (/^\d{13}$/.test(text)) {
      timestamp = Number(text);
    } else {
      let normalized = text.replace(/\//g, '-').replace(/\s+/, 'T');
      if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
        normalized = `${normalized}T00:00:00+08:00`;
      } else if (
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(
          normalized,
        )
      ) {
        normalized = `${normalized}+08:00`;
      }
      timestamp = Date.parse(normalized);
    }
  } else {
    throw mappingError(`${label}格式无效`);
  }
  if (!Number.isFinite(timestamp)) {
    throw mappingError(`${label}格式无效`);
  }
  try {
    return new Date(timestamp).toISOString();
  } catch {
    throw mappingError(`${label}格式无效`);
  }
}

function normalizeEpoch(value: number): number {
  if (!Number.isFinite(value)) return Number.NaN;
  return Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
}

function normalizeVersion(
  record: ChangeAdjustmentBaseRecord,
): string | number | undefined {
  const explicit = record.version ?? record.revision;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    if (
      typeof explicit === 'number' &&
      Number.isSafeInteger(explicit) &&
      explicit >= 0
    ) {
      return explicit;
    }
    if (typeof explicit === 'string') {
      return requiredOpaqueText(explicit, '记录版本', 255);
    }
    throw mappingError('记录版本格式无效');
  }
  if (record.last_modified_time !== undefined) {
    const timestamp = Date.parse(
      requiredDateValue(record.last_modified_time, '更新时间'),
    );
    return timestamp;
  }
  return undefined;
}

function findField(
  fields: Record<string, unknown>,
  aliases: readonly string[],
): FoundField {
  for (const alias of aliases) {
    if (
      Object.prototype.hasOwnProperty.call(fields, alias) &&
      fields[alias] !== undefined
    ) {
      return { found: true, value: fields[alias] };
    }
  }
  return { found: false, value: undefined };
}

function extractSubmitterName(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const names: string[] = [];
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let visitedNodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    visitedNodes += 1;
    assertTraversalBudget(current.depth, visitedNodes, '申请提交人格式无效');
    const entry = current.value;
    if (entry === null || entry === undefined || entry === '') continue;
    if (typeof entry === 'string') {
      names.push(requiredSafeText(entry, '申请提交人', 64));
      continue;
    }
    if (typeof entry !== 'object') {
      throw mappingError('申请提交人格式无效');
    }
    trackTraversalObject(entry, seen, '申请提交人格式无效');
    if (safeIsArray(entry, '申请提交人格式无效')) {
      const entries = readSafeArrayValues(entry, '申请提交人格式无效');
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        stack.push({ value: entries[index], depth: current.depth + 1 });
      }
      continue;
    }

    const properties = readSafePlainDataProperties(entry, '申请提交人格式无效');
    const name = properties.has('name')
      ? properties.get('name')
      : properties.get('text');
    if (typeof name !== 'string') {
      throw mappingError('申请提交人格式无效');
    }
    names.push(requiredSafeText(name, '申请提交人', 64));
  }

  const unique = [...new Set(names)];
  if (unique.length === 0) return null;
  const result = unique.join('、');
  if (result.length > 64) throw mappingError('申请提交人过长');
  return result;
}

function normalizeWorkflowStatus(value: unknown): string | null {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  ) {
    return null;
  }
  return normalizeNullableText(value, '变更提交审核流程（内部）', 500);
}

function hasSafeSummaryReport(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let visitedNodes = 0;
  let present = false;

  while (stack.length > 0) {
    const current = stack.pop()!;
    visitedNodes += 1;
    assertTraversalBudget(current.depth, visitedNodes, '变更总结报告格式无效');
    const entry = current.value;
    if (entry === null || entry === undefined) continue;
    if (typeof entry === 'string') {
      if (entry !== '') {
        isSafeDirectSummaryFileToken(entry);
        present = true;
      }
      continue;
    }
    if (typeof entry !== 'object') {
      throw mappingError('变更总结报告格式无效');
    }
    trackTraversalObject(entry, seen, '变更总结报告格式无效');

    if (safeIsArray(entry, '变更总结报告格式无效')) {
      const entries = readSafeArrayValues(entry, '变更总结报告格式无效');
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        stack.push({ value: entries[index], depth: current.depth + 1 });
      }
      continue;
    }

    const properties = readSafePlainDataProperties(
      entry,
      '变更总结报告格式无效',
    );
    if (properties.size === 0) {
      throw mappingError('变更总结报告格式无效');
    }

    for (const [key, propertyValue] of properties) {
      if (
        SUMMARY_ATTACHMENT_TOKEN_KEYS.includes(
          key as (typeof SUMMARY_ATTACHMENT_TOKEN_KEYS)[number],
        )
      ) {
        requiredSummaryFileToken(propertyValue);
        present = true;
        continue;
      }
      if (
        SUMMARY_LOOKUP_CONTAINER_KEYS.includes(
          key as (typeof SUMMARY_LOOKUP_CONTAINER_KEYS)[number],
        )
      ) {
        stack.push({ value: propertyValue, depth: current.depth + 1 });
        continue;
      }
      if (SUMMARY_LOOKUP_METADATA_KEYS.has(key)) {
        assertSafeSummaryMetadata(propertyValue);
        continue;
      }
      throw mappingError('变更总结报告格式无效');
    }
  }

  return present;
}

function isSafeDirectSummaryFileToken(value: string): true {
  if (
    !SAFE_FILE_TOKEN.test(value) ||
    !SAFE_DIRECT_SUMMARY_FILE_TOKEN.test(value) ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw mappingError('变更总结报告格式无效');
  }
  return true;
}

function requiredSummaryFileToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !SAFE_FILE_TOKEN.test(value) ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw mappingError('变更总结报告格式无效');
  }
  return value;
}

function assertTraversalBudget(
  depth: number,
  visitedNodes: number,
  errorMessage: string,
): void {
  if (depth > MAX_DEPTH || visitedNodes > MAX_NODES) {
    throw mappingError(errorMessage);
  }
}

function trackTraversalObject(
  value: object,
  seen: WeakSet<object>,
  errorMessage: string,
): void {
  if (seen.has(value)) throw mappingError(errorMessage);
  seen.add(value);
}

function safeIsArray(value: object, errorMessage: string): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    throw mappingError(errorMessage);
  }
}

function readSafeArrayValues(
  value: unknown[],
  errorMessage: string,
): unknown[] {
  let prototype: object | null;
  let keys: PropertyKey[];
  let descriptors: Record<string, PropertyDescriptor | undefined>;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(descriptors);
    lengthDescriptor = descriptors.length;
  } catch {
    throw mappingError(errorMessage);
  }
  if (
    prototype !== Array.prototype ||
    !lengthDescriptor ||
    !('value' in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > MAX_ARRAY_LENGTH
  ) {
    throw mappingError(errorMessage);
  }

  const length = lengthDescriptor.value as number;
  if (keys.length !== length + 1) throw mappingError(errorMessage);
  const values = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw mappingError(errorMessage);
    }
    values[index] = descriptor.value;
  }
  return values;
}

function readSafePlainDataProperties(
  value: object,
  errorMessage: string,
): Map<string, unknown> {
  let prototype: object | null;
  let keys: PropertyKey[];
  let descriptors: Record<string, PropertyDescriptor | undefined>;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(descriptors);
  } catch {
    throw mappingError(errorMessage);
  }
  if (prototype !== Object.prototype || keys.length > MAX_KEYS) {
    throw mappingError(errorMessage);
  }

  const properties = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== 'string') throw mappingError(errorMessage);
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw mappingError(errorMessage);
    }
    properties.set(key, descriptor.value);
  }
  return properties;
}

function assertSafeSummaryMetadata(value: unknown): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw mappingError('变更总结报告格式无效');
  }
}

function normalizeOpaqueMarker(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  return requiredOpaqueText(value, label, 500);
}

function requiredPublicText(
  value: unknown,
  label: string,
  max: number,
): string {
  const values = extractTextValues(value, label, max);
  const result = values.join('、');
  if (!result) throw mappingError(`${label}不能为空`);
  if (result.length > max) throw mappingError(`${label}过长`);
  return result;
}

function normalizeNullableText(
  value: unknown,
  label: string,
  max: number,
): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = requiredPublicText(value, label, max);
  return text || null;
}

function extractTextValues(
  value: unknown,
  label: string,
  max: number,
): string[] {
  const values: string[] = [];
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let visitedNodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    visitedNodes += 1;
    assertTraversalBudget(current.depth, visitedNodes, `${label}格式无效`);
    const entry = current.value;
    if (typeof entry === 'string' || typeof entry === 'number') {
      values.push(requiredSafeText(String(entry), label, max));
      continue;
    }
    if (typeof entry !== 'object' || entry === null) {
      throw mappingError(`${label}格式无效`);
    }
    trackTraversalObject(entry, seen, `${label}格式无效`);
    if (safeIsArray(entry, `${label}格式无效`)) {
      const entries = readSafeArrayValues(entry, `${label}格式无效`);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        stack.push({ value: entries[index], depth: current.depth + 1 });
      }
      continue;
    }

    const properties = readSafePlainDataProperties(entry, `${label}格式无效`);
    let selected = false;
    for (const key of ['text', 'name', 'value']) {
      if (properties.has(key)) {
        stack.push({
          value: properties.get(key),
          depth: current.depth + 1,
        });
        selected = true;
        break;
      }
    }
    if (!selected) throw mappingError(`${label}格式无效`);
  }

  return values;
}

function requiredAttachmentName(
  value: unknown,
  label: string,
  index: number,
): string {
  const name = requiredSafeText(
    value,
    `${label}第 ${index + 1} 个附件文件名`,
    255,
  );
  if (name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw mappingError(`${label}第 ${index + 1} 个附件文件名格式无效`);
  }
  return name;
}

function requiredAttachmentSize(
  value: unknown,
  label: string,
  index: number,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw mappingError(`${label}第 ${index + 1} 个附件大小格式无效`);
  }
  return value;
}

function requiredSafeFileToken(
  value: unknown,
  label: string,
  index: number,
): string {
  if (typeof value !== 'string' || !SAFE_FILE_TOKEN.test(value)) {
    throw mappingError(`${label}第 ${index + 1} 个附件标识格式无效`);
  }
  return value;
}

function requiredOpaqueText(
  value: unknown,
  label: string,
  max: number,
): string {
  const text = requiredSafeText(value, label, max);
  if (/[/\\?#&%]/.test(text)) throw mappingError(`${label}格式无效`);
  return text;
}

function requiredSafeText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw mappingError(`${label}格式无效`);
  const text = value.trim();
  if (!text || text.length > max || CONTROL_CHARACTERS.test(text)) {
    throw mappingError(`${label}格式无效`);
  }
  return text;
}

function assertSafeRecordId(recordId: string): void {
  if (!SAFE_RECORD_ID.test(recordId)) {
    throw mappingError('变更记录标识格式无效');
  }
}

function normalizeProxyBasePath(value: string): string {
  const trimmed = String(value || '').trim();
  if (
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    CONTROL_CHARACTERS.test(trimmed) ||
    trimmed.includes('?') ||
    trimmed.includes('#') ||
    trimmed.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw mappingError('附件代理路径格式无效');
  }
  return trimmed.replace(/\/+$/, '');
}

function isSafeHttpOrRelativeUrl(value: string): boolean {
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function toOptionalIso(value: unknown): string | null {
  return normalizeOptionalDate(value, '日期时间');
}

function cloneDocuments(
  value: readonly ChangeInfoDocument[],
): ChangeInfoDocument[] {
  return value.map((document) => ({
    ...document,
    objectStorage: document.objectStorage
      ? { ...document.objectStorage }
      : null,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mappingError(message: string): ChangeAdjustmentRecordMappingError {
  return new ChangeAdjustmentRecordMappingError(message);
}
