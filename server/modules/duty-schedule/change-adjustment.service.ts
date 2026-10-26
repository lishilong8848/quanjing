import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CHANGE_ADJUSTMENT_EVIDENCE_MAX_SIZE,
  validateChangeAdjustment,
  type ChangeAdjustmentFileInput,
  type ChangeAdjustmentLifecycleStatus,
  type ChangeAdjustmentRequest,
  type ChangeAdjustmentResponse,
} from '../../../shared/change-adjustment';
import type {
  ChangeInfo,
  ChangeInfoDocument,
} from '../../../shared/api.interface';
import { CHANGE_REQUEST_MAX_DOCUMENT_SIZE } from '../../../shared/change-request';

export const CHANGE_ADJUSTMENT_SERVICE_OPTIONS =
  'CHANGE_ADJUSTMENT_SERVICE_OPTIONS';

export const CHANGE_ADJUSTMENT_FIELDS = {
  plannedDelayStartAt: '计划延迟开始日期',
  plannedDelayEndAt: '计划延迟结束日期',
  reason: '延期理由',
  evidence: '延期举证',
  documents: '变更文档',
  requestUniqueId: '调整请求唯一ID',
  requestFingerprint: '调整请求指纹',
} as const;

type DateTimeValue = string | number | Date;

export type ChangeAdjustmentAttachmentSnapshot = ChangeInfoDocument;

export interface ChangeAdjustmentRecordSnapshot {
  recordId: string;
  /** Fully mapped non-private API record; attachment URLs must use session access. */
  publicRecord: ChangeInfo;
  version?: string | number;
  updatedAt?: string;
  plannedStartAt: DateTimeValue;
  plannedEndAt: DateTimeValue;
  actualStartAt?: DateTimeValue | null;
  actualEndAt?: DateTimeValue | null;
  plannedDelayStartAt?: DateTimeValue | null;
  plannedDelayEndAt?: DateTimeValue | null;
  reason?: string | null;
  documents: ChangeAdjustmentAttachmentSnapshot[];
  evidence?: ChangeAdjustmentAttachmentSnapshot[];
  adjustmentMutationId?: string | null;
  adjustmentFingerprint?: string | null;
}

export interface ChangeAdjustmentStoredFile {
  id: string;
  filePath: string;
  bucketId: string;
  url: string;
  name: string;
  size: number;
  mimeType: string;
  sha256: string;
  boundRecordId?: string;
  fileToken?: string;
}

export type ChangeAdjustmentAttachmentKind = 'scheme' | 'evidence';

export interface ChangeAdjustmentExecutionPorts {
  /**
   * Must bypass stale list caches and return the requested record only.
   * Existing Base attachments must be mapped to session-authorized app URLs;
   * they must not be resolved with the current adjustment mutation owner.
   */
  readRecordStrict(
    recordId: string,
  ): Promise<ChangeAdjustmentRecordSnapshot | null>;
  /** A thrown error is treated as an unknown write unless it declares rejected. */
  updateRecord(
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<void>;
  /** Adapter must verify the owner mutation; callers only supply an opaque id. */
  resolveOwnedStorage(
    id: string,
    ownerMutationId: string,
  ): Promise<ChangeAdjustmentStoredFile>;
  /** Adapter chooses whole or multipart Feishu upload from authoritative size. */
  uploadToBitable(input: {
    kind: ChangeAdjustmentAttachmentKind;
    file: ChangeAdjustmentStoredFile;
    clientMutationId: string;
  }): Promise<string>;
  bindStorageToRecord(input: {
    id: string;
    recordId: string;
    fileToken: string;
    ownerMutationId: string;
  }): Promise<void>;
  findBoundStorageByFileToken(
    fileToken: string,
  ): Promise<ChangeAdjustmentStoredFile | null>;
  /** Must be idempotent; a missing/already deleted object is success. */
  deleteBoundStorage(input: {
    id: string;
    recordId: string;
    fileToken: string;
    accessContext: 'change-adjustment-post-readback';
  }): Promise<void>;
}

export interface ChangeAdjustmentServiceOptions {
  ledgerDir?: string;
  now?: () => Date;
}

interface UploadedAttachment {
  kind: ChangeAdjustmentAttachmentKind;
  index: number;
  storageId: string;
  fileToken: string;
}

interface SourceAttachment {
  kind: ChangeAdjustmentAttachmentKind;
  index: number;
  storageId: string;
  sha256: string;
  size: number;
  name: string;
  mimeType: string;
}

interface PostCommitBinding {
  storageId: string;
  fileToken: string;
}

interface PostCommitDelete {
  storageId: string;
  fileToken: string;
}

interface StrictTarget {
  lifecycleStatus: ChangeAdjustmentLifecycleStatus;
  plannedDelayStartAt: number | null;
  plannedDelayEndAt: number;
  reason: string;
  documentTokens: string[];
  evidenceTokens: string[];
}

interface ChangeAdjustmentLedgerState {
  version: 1;
  clientMutationId: string;
  fingerprint: string;
  recordId: string;
  phase: 'pending' | 'confirmed' | 'completed';
  sourceFiles: SourceAttachment[];
  uploaded: UploadedAttachment[];
  target?: StrictTarget;
  bindings?: PostCommitBinding[];
  deletes?: PostCommitDelete[];
  response?: ChangeAdjustmentResponse;
  createdAt: string;
  updatedAt: string;
}

interface InFlightMutation {
  fingerprint: string;
  promise: Promise<ChangeAdjustmentResponse>;
}

interface CanonicalFiles {
  schemes: ChangeAdjustmentStoredFile[];
  evidence: ChangeAdjustmentStoredFile[];
}

interface RequestEnvelope {
  clientMutationId: string;
  recordId: string;
  schemeStorageIds: string[];
  evidenceStorageIds: string[];
  fingerprint: string;
  request: ChangeAdjustmentRequest;
}

const LOCAL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;
const MUTATION_ID_PATTERN =
  /^change-adjustment-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class ChangeAdjustmentService {
  private readonly ledgerDir: string;
  private readonly now: () => Date;
  private readonly inFlight = new Map<string, InFlightMutation>();
  private readonly recordWriteTails = new Map<string, Promise<void>>();
  private readonly memoryFingerprints = new Map<string, string>();
  private readonly memoryLedgers = new Map<
    string,
    ChangeAdjustmentLedgerState
  >();

  constructor(
    @Optional()
    @Inject(CHANGE_ADJUSTMENT_SERVICE_OPTIONS)
    options: ChangeAdjustmentServiceOptions = {},
  ) {
    this.ledgerDir =
      options.ledgerDir ??
      (process.env.NODE_ENV === 'test'
        ? ''
        : process.env.CHANGE_ADJUSTMENT_MUTATION_LEDGER_DIR?.trim() ||
          join(process.cwd(), 'data', 'change-adjustment-mutations'));
    this.now = options.now || (() => new Date());
  }

  async execute(
    request: ChangeAdjustmentRequest,
    ports: ChangeAdjustmentExecutionPorts,
  ): Promise<ChangeAdjustmentResponse> {
    const envelope = this.buildEnvelope(request);
    await this.assertImmutableFingerprint(
      envelope.clientMutationId,
      envelope.fingerprint,
    );

    const existing = this.inFlight.get(envelope.clientMutationId);
    if (existing) {
      if (existing.fingerprint !== envelope.fingerprint) {
        throw new ConflictException(
          '相同 clientMutationId 正在处理不同的变更调整',
        );
      }
      return existing.promise;
    }

    const promise = this.withRecordWriteLock(envelope.recordId, () =>
      this.executeLocked(envelope.request, envelope, ports),
    );
    this.inFlight.set(envelope.clientMutationId, {
      fingerprint: envelope.fingerprint,
      promise,
    });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(envelope.clientMutationId)?.promise === promise) {
        this.inFlight.delete(envelope.clientMutationId);
      }
    }
  }

  private async executeLocked(
    request: ChangeAdjustmentRequest,
    envelope: RequestEnvelope,
    ports: ChangeAdjustmentExecutionPorts,
  ): Promise<ChangeAdjustmentResponse> {
    let ledger = await this.loadLedger(
      envelope.clientMutationId,
      envelope.fingerprint,
    );
    if (
      ledger?.recordId !== undefined &&
      ledger.recordId !== envelope.recordId
    ) {
      throw new ConflictException('幂等台账中的变更记录 ID 不一致');
    }
    if (ledger?.phase === 'completed' && ledger.response) {
      return ledger.response;
    }
    if (ledger?.phase === 'confirmed' && ledger.response) {
      await this.finishPostCommit(ledger, ports);
      ledger = await this.completeLedger(ledger);
      return ledger.response!;
    }

    const current = await ports.readRecordStrict(envelope.recordId);
    if (!current) {
      throw new NotFoundException('未找到待调整的变更记录');
    }
    this.assertRecordIdentity(current, envelope.recordId);

    if (ledger?.target && this.hasSameMutationMarker(current, ledger)) {
      try {
        this.assertStrictReadback(current, ledger.target, ledger);
      } catch {
        throw this.unknownResultError(
          envelope.clientMutationId,
          '记录已有同一调整请求标记但严格回读不一致，结果需核对',
        );
      }
      const confirmed = await this.confirmLedger(
        ledger,
        this.buildResponse(current, ledger.target, envelope.clientMutationId),
      );
      await this.finishPostCommit(confirmed, ports);
      const completed = await this.completeLedger(confirmed);
      return completed.response!;
    }
    if (
      current.adjustmentMutationId?.trim() === envelope.clientMutationId &&
      current.adjustmentFingerprint?.trim() !== envelope.fingerprint
    ) {
      throw new ConflictException('当前记录已存在同 ID 不同指纹的调整');
    }

    const lifecycle = this.deriveLifecycle(current);
    this.assertLifecycleAllowsRequest(lifecycle, request);
    this.assertExpectedSnapshot(request, current);
    const currentDocumentTokens = this.readUniqueTokens(
      current.documents,
      '变更文档',
    );
    const currentEvidenceTokens = this.readUniqueTokens(
      current.evidence || [],
      '延期举证',
    );

    const canonicalFiles = await this.resolveCanonicalFiles(envelope, ports);
    const canonicalRequest = this.buildCanonicalRequest(
      request,
      canonicalFiles,
    );
    const validationErrors = validateChangeAdjustment(canonicalRequest, {
      lifecycleStatus: lifecycle.status,
      effectiveStartDate: new Date(lifecycle.effectiveStartAt).toISOString(),
      effectiveEndDate: new Date(lifecycle.effectiveEndAt).toISOString(),
      currentTime: new Date(lifecycle.currentTime).toISOString(),
      availableDocumentTokens: currentDocumentTokens,
    });
    if (validationErrors.length > 0) {
      throw new BadRequestException(validationErrors[0].message);
    }
    this.assertAttachmentPartition(
      currentDocumentTokens,
      canonicalRequest.retainedDocumentTokens,
      canonicalRequest.removedDocumentTokens,
    );

    if (ledger) {
      this.assertLedgerSourceFiles(ledger, canonicalFiles);
    } else {
      ledger = await this.createPendingLedger(envelope, canonicalFiles);
    }
    const schemeTokens = await this.uploadMissing(
      ledger,
      canonicalFiles.schemes,
      'scheme',
      envelope.clientMutationId,
      ports,
    );
    const evidenceTokens = await this.uploadMissing(
      ledger,
      canonicalFiles.evidence,
      'evidence',
      envelope.clientMutationId,
      ports,
    );
    const preWriteRecord = await ports.readRecordStrict(envelope.recordId);
    if (!preWriteRecord) {
      throw new NotFoundException('待调整的变更记录已不存在');
    }
    this.assertRecordIdentity(preWriteRecord, envelope.recordId);
    this.assertExpectedSnapshot(request, preWriteRecord);
    const preWriteDocumentTokens = this.readUniqueTokens(
      preWriteRecord.documents,
      '变更文档',
    );
    const preWriteEvidenceTokens = this.readUniqueTokens(
      preWriteRecord.evidence || [],
      '延期举证',
    );
    if (!this.sameTokenSet(preWriteDocumentTokens, currentDocumentTokens)) {
      throw new ConflictException('变更方案已被其他操作更新，已停止写入');
    }
    if (!this.sameTokenSet(preWriteEvidenceTokens, currentEvidenceTokens)) {
      throw new ConflictException('延期举证已被其他操作更新，已停止写入');
    }
    const preWriteLifecycle = this.deriveLifecycle(preWriteRecord);
    this.assertLifecycleAllowsRequest(preWriteLifecycle, canonicalRequest);
    const preWriteValidationErrors = validateChangeAdjustment(
      canonicalRequest,
      {
        lifecycleStatus: preWriteLifecycle.status,
        effectiveStartDate: new Date(
          preWriteLifecycle.effectiveStartAt,
        ).toISOString(),
        effectiveEndDate: new Date(
          preWriteLifecycle.effectiveEndAt,
        ).toISOString(),
        currentTime: new Date(preWriteLifecycle.currentTime).toISOString(),
        availableDocumentTokens: preWriteDocumentTokens,
      },
    );
    if (preWriteValidationErrors.length > 0) {
      throw new BadRequestException(preWriteValidationErrors[0].message);
    }
    this.assertAttachmentPartition(
      preWriteDocumentTokens,
      canonicalRequest.retainedDocumentTokens,
      canonicalRequest.removedDocumentTokens,
    );
    const target: StrictTarget = {
      lifecycleStatus: preWriteLifecycle.status,
      plannedDelayStartAt:
        preWriteLifecycle.status === 'not-started'
          ? this.parseRequestDateTime(
              canonicalRequest.plannedDelayStartDate,
              '调整开始时间',
            )
          : this.optionalEpoch(preWriteRecord.plannedDelayStartAt),
      plannedDelayEndAt: this.parseRequestDateTime(
        canonicalRequest.plannedDelayEndDate,
        '调整结束时间',
      ),
      reason: canonicalRequest.reason.trim(),
      documentTokens: [
        ...canonicalRequest.retainedDocumentTokens,
        ...schemeTokens,
      ],
      evidenceTokens,
    };
    const bindings: PostCommitBinding[] = [
      ...canonicalFiles.schemes.map((file, index) => ({
        storageId: file.id,
        fileToken: schemeTokens[index],
      })),
      ...canonicalFiles.evidence.map((file, index) => ({
        storageId: file.id,
        fileToken: evidenceTokens[index],
      })),
    ];
    const deletes = await this.resolveSafeDeletes(
      [...canonicalRequest.removedDocumentTokens, ...preWriteEvidenceTokens],
      envelope.recordId,
      ports,
    );
    ledger.target = target;
    ledger.bindings = bindings;
    ledger.deletes = deletes;
    ledger.updatedAt = this.now().toISOString();
    await this.persistLedger(ledger);

    const fields = this.buildBitableFields(
      target,
      preWriteLifecycle.status,
      envelope.clientMutationId,
      envelope.fingerprint,
    );
    try {
      await ports.updateRecord(envelope.recordId, fields);
    } catch (error) {
      if (this.isDefinitiveRejection(error)) throw error;
      throw this.unknownResultError(envelope.clientMutationId);
    }

    let saved: ChangeAdjustmentRecordSnapshot | null;
    try {
      saved = await ports.readRecordStrict(envelope.recordId);
    } catch {
      throw this.unknownResultError(
        envelope.clientMutationId,
        '飞书已写入但定向回读失败',
      );
    }
    if (!saved) {
      throw this.unknownResultError(
        envelope.clientMutationId,
        '飞书已写入但定向回读未找到记录',
      );
    }
    try {
      this.assertStrictReadback(saved, target, ledger);
    } catch {
      throw this.unknownResultError(
        envelope.clientMutationId,
        '飞书严格回读未通过',
      );
    }

    const confirmed = await this.confirmLedger(
      ledger,
      this.buildResponse(saved, target, envelope.clientMutationId),
    );
    await this.finishPostCommit(confirmed, ports);
    return (await this.completeLedger(confirmed)).response!;
  }

  private buildEnvelope(request: ChangeAdjustmentRequest): RequestEnvelope {
    if (!this.isRecord(request)) {
      throw new BadRequestException('变更调整数据格式无效');
    }
    const clientMutationId = this.requiredRequestString(
      request.clientMutationId,
      '请求标识',
      100,
    );
    const recordId = this.requiredRequestString(
      request.recordId,
      '变更记录 ID',
      200,
    );
    if (!MUTATION_ID_PATTERN.test(clientMutationId)) {
      throw new BadRequestException('请求标识必须是 change-adjustment-UUID');
    }
    const expectedVersion = this.normalizeExpectedVersion(
      request.expectedVersion,
    );
    const expectedUpdatedAt = this.optionalRequestString(
      request.expectedUpdatedAt,
      '记录更新时间',
      100,
    );
    const plannedDelayStartDate = this.nullableRequestString(
      request.plannedDelayStartDate,
      '调整开始时间',
      100,
    );
    const plannedDelayEndDate = this.nullableRequestString(
      request.plannedDelayEndDate,
      '调整结束时间',
      100,
    );
    const reason = this.requiredRequestString(request.reason, '调整理由', 1000);
    const retainedDocumentTokens = this.requestTokenArray(
      request.retainedDocumentTokens,
      '保留方案附件',
    );
    const removedDocumentTokens = this.requestTokenArray(
      request.removedDocumentTokens,
      '删除方案附件',
    );
    const schemeStorageIds = this.extractStorageIds(
      request.newSchemeDocuments,
      '新方案附件',
    );
    const evidenceStorageIds = this.extractStorageIds(
      request.evidenceDocuments,
      '延期举证',
    );
    const allStorageIds = [...schemeStorageIds, ...evidenceStorageIds];
    if (new Set(allStorageIds).size !== allStorageIds.length) {
      throw new BadRequestException('对象存储附件不能重复使用');
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          clientMutationId,
          recordId,
          expectedVersion: expectedVersion ?? null,
          expectedUpdatedAt: expectedUpdatedAt || null,
          plannedDelayStartDate,
          plannedDelayEndDate,
          reason,
          retainedDocumentTokens,
          removedDocumentTokens,
          schemeStorageIds,
          evidenceStorageIds,
        }),
      )
      .digest('hex');
    return {
      clientMutationId,
      recordId,
      schemeStorageIds,
      evidenceStorageIds,
      fingerprint,
      request: {
        clientMutationId,
        recordId,
        expectedVersion,
        expectedUpdatedAt,
        plannedDelayStartDate,
        plannedDelayEndDate,
        reason,
        retainedDocumentTokens,
        removedDocumentTokens,
        newSchemeDocuments:
          request.newSchemeDocuments as ChangeAdjustmentFileInput[],
        evidenceDocuments:
          request.evidenceDocuments as ChangeAdjustmentFileInput[],
      },
    };
  }

  private extractStorageIds(value: unknown, label: string): string[] {
    if (!Array.isArray(value)) {
      throw new BadRequestException(`${label}格式无效`);
    }
    return value.map((document) => {
      if (!this.isRecord(document) || !this.isRecord(document.objectStorage)) {
        throw new BadRequestException(`${label}缺少对象存储标识`);
      }
      return this.requiredRequestString(
        document.objectStorage.id,
        `${label}对象存储标识`,
        100,
      );
    });
  }

  private requiredRequestString(
    value: unknown,
    label: string,
    maxLength: number,
  ): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${label}格式无效`);
    }
    const normalized = value.trim();
    if (
      !normalized ||
      normalized.length > maxLength ||
      /[\r\n\0]/.test(normalized)
    ) {
      throw new BadRequestException(`${label}格式无效`);
    }
    return normalized;
  }

  private optionalRequestString(
    value: unknown,
    label: string,
    maxLength: number,
  ): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    return this.requiredRequestString(value, label, maxLength);
  }

  private nullableRequestString(
    value: unknown,
    label: string,
    maxLength: number,
  ): string | null {
    return this.optionalRequestString(value, label, maxLength) || null;
  }

  private normalizeExpectedVersion(
    value: unknown,
  ): string | number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'string') {
      return this.requiredRequestString(value, '记录版本', 255);
    }
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }
    throw new BadRequestException('记录版本格式无效');
  }

  private requestTokenArray(value: unknown, label: string): string[] {
    if (!Array.isArray(value)) {
      throw new BadRequestException(`${label}格式无效`);
    }
    return value.map((token) =>
      this.requiredRequestString(token, `${label}标识`, 500),
    );
  }

  private async resolveCanonicalFiles(
    envelope: RequestEnvelope,
    ports: ChangeAdjustmentExecutionPorts,
  ): Promise<CanonicalFiles> {
    const resolve = async (id: string) => {
      const file = await ports.resolveOwnedStorage(
        id,
        envelope.clientMutationId,
      );
      this.assertStoredFile(file, id);
      return file;
    };
    return {
      schemes: await Promise.all(envelope.schemeStorageIds.map(resolve)),
      evidence: await Promise.all(envelope.evidenceStorageIds.map(resolve)),
    };
  }

  private assertStoredFile(
    file: ChangeAdjustmentStoredFile,
    expectedId: string,
  ): void {
    if (
      !file ||
      file.id !== expectedId ||
      !file.name?.trim() ||
      !file.filePath?.trim() ||
      !file.bucketId?.trim() ||
      !file.url?.trim() ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      !/^[a-f0-9]{64}$/i.test(file.sha256 || '')
    ) {
      throw new BadRequestException('对象存储附件元数据无效');
    }
  }

  private buildCanonicalRequest(
    request: ChangeAdjustmentRequest,
    files: CanonicalFiles,
  ): ChangeAdjustmentRequest {
    const toInput = (
      file: ChangeAdjustmentStoredFile,
    ): ChangeAdjustmentFileInput => ({
      originalname: file.name,
      mimetype: file.mimeType,
      size: file.size,
      objectStorage: {
        id: file.id,
        filePath: file.filePath,
        bucketId: file.bucketId,
        url: file.url,
      },
    });
    return {
      ...request,
      clientMutationId: request.clientMutationId.trim(),
      recordId: request.recordId.trim(),
      expectedUpdatedAt: request.expectedUpdatedAt?.trim(),
      plannedDelayStartDate: request.plannedDelayStartDate?.trim() || null,
      plannedDelayEndDate: request.plannedDelayEndDate?.trim() || null,
      reason: request.reason.trim(),
      retainedDocumentTokens: request.retainedDocumentTokens.map((token) =>
        token.trim(),
      ),
      removedDocumentTokens: request.removedDocumentTokens.map((token) =>
        token.trim(),
      ),
      newSchemeDocuments: files.schemes.map(toInput),
      evidenceDocuments: files.evidence.map(toInput),
    };
  }

  private deriveLifecycle(record: ChangeAdjustmentRecordSnapshot): {
    status: ChangeAdjustmentLifecycleStatus;
    effectiveStartAt: number;
    effectiveEndAt: number;
    currentTime: number;
  } {
    const originalStart = this.requiredEpoch(
      record.plannedStartAt,
      '原计划开始时间',
    );
    const originalEnd = this.requiredEpoch(
      record.plannedEndAt,
      '原计划结束时间',
    );
    const effectiveStartAt =
      this.optionalEpoch(record.plannedDelayStartAt) ?? originalStart;
    const effectiveEndAt =
      this.optionalEpoch(record.plannedDelayEndAt) ?? originalEnd;
    const actualStartAt = this.optionalEpoch(record.actualStartAt);
    const actualEndAt = this.optionalEpoch(record.actualEndAt);
    const currentTime = this.now().getTime();
    if (!Number.isFinite(currentTime)) {
      throw new ServiceUnavailableException('服务器时间无效');
    }
    if (actualEndAt !== null) {
      return {
        status: 'finished',
        effectiveStartAt: actualStartAt ?? effectiveStartAt,
        effectiveEndAt: actualEndAt,
        currentTime,
      };
    }
    if (actualStartAt !== null) {
      if (effectiveEndAt <= actualStartAt) {
        throw new BadRequestException('变更当前有效时间范围无效');
      }
      return {
        status: 'in-progress',
        effectiveStartAt: actualStartAt,
        effectiveEndAt,
        currentTime,
      };
    }
    if (effectiveEndAt <= effectiveStartAt) {
      throw new BadRequestException('变更当前有效时间范围无效');
    }
    const status: ChangeAdjustmentLifecycleStatus =
      currentTime < effectiveStartAt
        ? 'not-started'
        : currentTime < effectiveEndAt
          ? 'in-progress'
          : 'finished';
    return { status, effectiveStartAt, effectiveEndAt, currentTime };
  }

  private assertLifecycleAllowsRequest(
    lifecycle: ReturnType<ChangeAdjustmentService['deriveLifecycle']>,
    request: ChangeAdjustmentRequest,
  ): void {
    if (lifecycle.status === 'finished') {
      throw new BadRequestException('已结束的变更不能调整');
    }
    if (
      lifecycle.status === 'in-progress' &&
      request.plannedDelayStartDate?.trim()
    ) {
      throw new BadRequestException('进行中的变更不能调整开始时间');
    }
  }

  private assertExpectedSnapshot(
    request: ChangeAdjustmentRequest,
    record: ChangeAdjustmentRecordSnapshot,
  ): void {
    let checked = false;
    if (
      request.expectedVersion !== undefined &&
      request.expectedVersion !== ''
    ) {
      if (record.version !== undefined) {
        checked = true;
        if (String(record.version) !== String(request.expectedVersion)) {
          throw new ConflictException('变更记录版本已更新，请重新打开后调整');
        }
      }
    }
    if (request.expectedUpdatedAt?.trim()) {
      if (record.updatedAt?.trim()) {
        checked = true;
        const expected = Date.parse(request.expectedUpdatedAt);
        const actual = Date.parse(record.updatedAt);
        if (!Number.isFinite(expected) || expected !== actual) {
          throw new ConflictException('变更记录已被其他操作更新');
        }
      }
    }
    if (!checked) {
      throw new ConflictException('无法核对变更记录版本，已停止写入');
    }
  }

  private assertAttachmentPartition(
    currentTokens: string[],
    retainedTokens: string[],
    removedTokens: string[],
  ): void {
    const current = new Set(currentTokens);
    const retained = new Set(retainedTokens);
    const removed = new Set(removedTokens);
    if (
      [...retained].some((token) => !current.has(token)) ||
      [...removed].some((token) => !current.has(token))
    ) {
      throw new BadRequestException('保留或删除的方案不属于当前记录');
    }
    if ([...retained].some((token) => removed.has(token))) {
      throw new BadRequestException('保留和删除的方案不能重复');
    }
    if (
      retained.size + removed.size !== current.size ||
      [...current].some((token) => !retained.has(token) && !removed.has(token))
    ) {
      throw new BadRequestException('当前方案必须明确保留或删除');
    }
  }

  private async uploadMissing(
    ledger: ChangeAdjustmentLedgerState,
    files: ChangeAdjustmentStoredFile[],
    kind: ChangeAdjustmentAttachmentKind,
    clientMutationId: string,
    ports: ChangeAdjustmentExecutionPorts,
  ): Promise<string[]> {
    const result: string[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const maxSize =
        kind === 'scheme'
          ? CHANGE_REQUEST_MAX_DOCUMENT_SIZE
          : CHANGE_ADJUSTMENT_EVIDENCE_MAX_SIZE;
      if (file.size > maxSize) {
        throw new BadRequestException(
          kind === 'scheme'
            ? '单个新方案附件不能超过 200 MiB'
            : '单个延期举证不能超过 20 MiB',
        );
      }
      let uploaded = ledger.uploaded.find(
        (candidate) =>
          candidate.kind === kind &&
          candidate.index === index &&
          candidate.storageId === file.id,
      );
      if (!uploaded) {
        const fileToken = (
          await ports.uploadToBitable({ kind, file, clientMutationId })
        ).trim();
        if (!fileToken) {
          throw new ServiceUnavailableException(
            `${kind === 'scheme' ? '变更方案' : '延期举证'}上传未返回附件标识`,
          );
        }
        uploaded = { kind, index, storageId: file.id, fileToken };
        ledger.uploaded.push(uploaded);
        ledger.updatedAt = this.now().toISOString();
        await this.persistLedger(ledger);
      }
      result.push(uploaded.fileToken);
    }
    return result;
  }

  private async resolveSafeDeletes(
    removedTokens: string[],
    recordId: string,
    ports: ChangeAdjustmentExecutionPorts,
  ): Promise<PostCommitDelete[]> {
    const result: PostCommitDelete[] = [];
    for (const token of removedTokens) {
      const stored = await ports.findBoundStorageByFileToken(token);
      if (
        stored?.boundRecordId === recordId &&
        stored.fileToken === token &&
        stored.id
      ) {
        result.push({ storageId: stored.id, fileToken: token });
      }
    }
    return result;
  }

  private buildBitableFields(
    target: StrictTarget,
    lifecycleStatus: ChangeAdjustmentLifecycleStatus,
    clientMutationId: string,
    fingerprint: string,
  ): Record<string, unknown> {
    return {
      ...(lifecycleStatus === 'not-started'
        ? {
            [CHANGE_ADJUSTMENT_FIELDS.plannedDelayStartAt]:
              target.plannedDelayStartAt,
          }
        : {}),
      [CHANGE_ADJUSTMENT_FIELDS.plannedDelayEndAt]: target.plannedDelayEndAt,
      [CHANGE_ADJUSTMENT_FIELDS.reason]: target.reason,
      [CHANGE_ADJUSTMENT_FIELDS.evidence]: target.evidenceTokens.map(
        (fileToken) => ({ file_token: fileToken }),
      ),
      [CHANGE_ADJUSTMENT_FIELDS.documents]: target.documentTokens.map(
        (fileToken) => ({ file_token: fileToken }),
      ),
      [CHANGE_ADJUSTMENT_FIELDS.requestUniqueId]: clientMutationId,
      [CHANGE_ADJUSTMENT_FIELDS.requestFingerprint]: fingerprint,
    };
  }

  private assertStrictReadback(
    record: ChangeAdjustmentRecordSnapshot,
    target: StrictTarget,
    ledger: ChangeAdjustmentLedgerState,
  ): void {
    this.assertRecordIdentity(record, ledger.recordId);
    const actualStart = this.optionalEpoch(record.plannedDelayStartAt);
    const actualEnd = this.optionalEpoch(record.plannedDelayEndAt);
    const documents = this.readUniqueTokens(record.documents, '变更文档');
    const evidence = this.readUniqueTokens(record.evidence || [], '延期举证');
    if (
      actualStart !== target.plannedDelayStartAt ||
      actualEnd !== target.plannedDelayEndAt ||
      (record.reason || '').trim() !== target.reason ||
      !this.sameTokenSet(documents, target.documentTokens) ||
      !this.sameTokenSet(evidence, target.evidenceTokens) ||
      record.adjustmentMutationId?.trim() !== ledger.clientMutationId ||
      record.adjustmentFingerprint?.trim() !== ledger.fingerprint
    ) {
      throw new ConflictException('变更调整严格回读未通过');
    }
  }

  private buildResponse(
    saved: ChangeAdjustmentRecordSnapshot,
    target: StrictTarget,
    clientMutationId: string,
  ): ChangeAdjustmentResponse {
    const plannedDelayStartDate =
      target.plannedDelayStartAt === null
        ? null
        : new Date(target.plannedDelayStartAt).toISOString();
    const plannedDelayEndDate = new Date(
      target.plannedDelayEndAt,
    ).toISOString();
    return {
      success: true,
      clientMutationId,
      record: {
        ...saved.publicRecord,
        id: saved.publicRecord.id || saved.recordId,
        bitableRecordId: saved.recordId,
        plannedDelayStartDate,
        plannedDelayEndDate,
        scheduleStatus: target.lifecycleStatus,
        delayReason: target.reason,
        planDocuments: saved.documents.map((document) =>
          this.toPublicDocument(document, '变更方案'),
        ),
        delayEvidence: (saved.evidence || []).map((document) =>
          this.toPublicDocument(document, '延期举证'),
        ),
        updatedAt: saved.updatedAt || saved.publicRecord.updatedAt,
      },
      message: '变更调整已同步',
    };
  }

  private toPublicDocument(
    document: ChangeAdjustmentAttachmentSnapshot,
    fallbackName: string,
  ): ChangeInfoDocument {
    const url = document.objectStorage?.url || document.url;
    if (!url?.trim()) {
      throw new ServiceUnavailableException(
        `${fallbackName}附件访问地址未生成`,
      );
    }
    return {
      fileToken: document.fileToken,
      name: document.name?.trim() || fallbackName,
      ...(document.size !== undefined ? { size: document.size } : {}),
      ...(document.mimeType !== undefined
        ? { mimeType: document.mimeType }
        : {}),
      url,
      ...(document.objectStorage !== undefined
        ? { objectStorage: document.objectStorage }
        : {}),
    };
  }

  private async finishPostCommit(
    ledger: ChangeAdjustmentLedgerState,
    ports: ChangeAdjustmentExecutionPorts,
  ): Promise<void> {
    try {
      for (const binding of ledger.bindings || []) {
        await ports.bindStorageToRecord({
          id: binding.storageId,
          recordId: ledger.recordId,
          fileToken: binding.fileToken,
          ownerMutationId: ledger.clientMutationId,
        });
      }
      for (const deletion of ledger.deletes || []) {
        await ports.deleteBoundStorage({
          id: deletion.storageId,
          recordId: ledger.recordId,
          fileToken: deletion.fileToken,
          accessContext: 'change-adjustment-post-readback',
        });
      }
    } catch {
      throw new ServiceUnavailableException({
        message: '飞书已确认调整，但附件后置处理未完成，请使用同一请求标识重试',
        writeDisposition: 'confirmed-post-commit-pending',
        clientMutationId: ledger.clientMutationId,
      });
    }
  }

  private async confirmLedger(
    ledger: ChangeAdjustmentLedgerState,
    response: ChangeAdjustmentResponse,
  ): Promise<ChangeAdjustmentLedgerState> {
    ledger.phase = 'confirmed';
    ledger.response = response;
    ledger.updatedAt = this.now().toISOString();
    await this.persistLedger(ledger);
    return ledger;
  }

  private async completeLedger(
    ledger: ChangeAdjustmentLedgerState,
  ): Promise<ChangeAdjustmentLedgerState> {
    ledger.phase = 'completed';
    ledger.updatedAt = this.now().toISOString();
    await this.persistLedger(ledger);
    return ledger;
  }

  private unknownResultError(
    clientMutationId: string,
    message = '变更调整写入结果待确认',
  ): ServiceUnavailableException {
    return new ServiceUnavailableException({
      message: `${message}，请使用同一请求标识重试`,
      writeDisposition: 'unknown-result',
      clientMutationId,
    });
  }

  private isDefinitiveRejection(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { writeDisposition?: unknown }).writeDisposition === 'rejected'
    );
  }

  private hasSameMutationMarker(
    record: ChangeAdjustmentRecordSnapshot,
    ledger: ChangeAdjustmentLedgerState,
  ): boolean {
    return (
      record.adjustmentMutationId?.trim() === ledger.clientMutationId &&
      record.adjustmentFingerprint?.trim() === ledger.fingerprint
    );
  }

  private assertRecordIdentity(
    record: ChangeAdjustmentRecordSnapshot,
    expectedRecordId: string,
  ): void {
    if (
      record.recordId?.trim() !== expectedRecordId ||
      !record.publicRecord ||
      record.publicRecord.bitableRecordId?.trim() !== expectedRecordId
    ) {
      throw new ConflictException('定向回读返回了其他变更记录');
    }
  }

  private readUniqueTokens(
    attachments: ChangeAdjustmentAttachmentSnapshot[],
    label: string,
  ): string[] {
    if (!Array.isArray(attachments)) {
      throw new BadRequestException(`${label}格式无效`);
    }
    const tokens = attachments.map((item) => item?.fileToken?.trim());
    if (
      tokens.some((token) => !token) ||
      new Set(tokens).size !== tokens.length
    ) {
      throw new BadRequestException(`${label}附件标识缺失或重复`);
    }
    return tokens as string[];
  }

  private sameTokenSet(left: string[], right: string[]): boolean {
    if (left.length !== right.length) return false;
    const expected = new Set(right);
    return left.every((token) => expected.has(token));
  }

  private parseRequestDateTime(value: string | null, label: string): number {
    if (!value) throw new BadRequestException(`${label}不能为空`);
    return this.requiredEpoch(value, label);
  }

  private optionalEpoch(
    value: DateTimeValue | null | undefined,
  ): number | null {
    if (value === undefined || value === null || value === '') return null;
    return this.requiredEpoch(value, '日期时间');
  }

  private requiredEpoch(value: DateTimeValue, label: string): number {
    let timestamp: number;
    if (value instanceof Date) {
      timestamp = value.getTime();
    } else if (typeof value === 'number') {
      timestamp = value;
    } else {
      const normalized = value.trim();
      const local = LOCAL_DATE_TIME_PATTERN.exec(normalized);
      timestamp = local
        ? Date.parse(`${normalized}:00+08:00`)
        : Date.parse(normalized);
    }
    if (!Number.isFinite(timestamp)) {
      throw new BadRequestException(`${label}格式无效`);
    }
    return timestamp;
  }

  private async createPendingLedger(
    envelope: RequestEnvelope,
    files: CanonicalFiles,
  ): Promise<ChangeAdjustmentLedgerState> {
    const timestamp = this.now().toISOString();
    const ledger: ChangeAdjustmentLedgerState = {
      version: 1,
      clientMutationId: envelope.clientMutationId,
      fingerprint: envelope.fingerprint,
      recordId: envelope.recordId,
      phase: 'pending',
      sourceFiles: this.toSourceAttachments(files),
      uploaded: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.persistLedger(ledger);
    return ledger;
  }

  private toSourceAttachments(files: CanonicalFiles): SourceAttachment[] {
    const map = (
      entries: ChangeAdjustmentStoredFile[],
      kind: ChangeAdjustmentAttachmentKind,
    ): SourceAttachment[] =>
      entries.map((file, index) => ({
        kind,
        index,
        storageId: file.id,
        sha256: file.sha256.toLowerCase(),
        size: file.size,
        name: file.name,
        mimeType: file.mimeType,
      }));
    return [
      ...map(files.schemes, 'scheme'),
      ...map(files.evidence, 'evidence'),
    ];
  }

  private assertLedgerSourceFiles(
    ledger: ChangeAdjustmentLedgerState,
    files: CanonicalFiles,
  ): void {
    const current = this.toSourceAttachments(files);
    if (
      ledger.sourceFiles.length !== current.length ||
      ledger.sourceFiles.some((source, index) => {
        const candidate = current[index];
        return (
          !candidate ||
          source.kind !== candidate.kind ||
          source.index !== candidate.index ||
          source.storageId !== candidate.storageId ||
          source.sha256 !== candidate.sha256 ||
          source.size !== candidate.size ||
          source.name !== candidate.name ||
          source.mimeType !== candidate.mimeType
        );
      })
    ) {
      throw new ConflictException(
        '同一调整请求的对象存储附件已变化，已停止重放',
      );
    }
  }

  private async assertImmutableFingerprint(
    clientMutationId: string,
    fingerprint: string,
  ): Promise<void> {
    if (!this.ledgerDir) {
      const existing = this.memoryFingerprints.get(clientMutationId);
      if (existing && existing !== fingerprint) {
        throw new ConflictException(
          '相同 clientMutationId 已用于不同的变更调整',
        );
      }
      this.memoryFingerprints.set(clientMutationId, fingerprint);
      return;
    }
    await mkdir(this.ledgerDir, { recursive: true });
    const path = this.fingerprintPath(clientMutationId);
    try {
      await writeFile(path, `${fingerprint}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const persisted = (await readFile(path, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(persisted)) {
      throw new ServiceUnavailableException(
        '变更调整幂等指纹台账损坏，已停止写入',
      );
    }
    if (persisted !== fingerprint) {
      throw new ConflictException('相同 clientMutationId 已用于不同的变更调整');
    }
  }

  private async loadLedger(
    clientMutationId: string,
    fingerprint: string,
  ): Promise<ChangeAdjustmentLedgerState | null> {
    if (!this.ledgerDir) {
      const state = this.memoryLedgers.get(clientMutationId);
      return state ? structuredClone(state) : null;
    }
    let source: string;
    try {
      source = await readFile(this.ledgerPath(clientMutationId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new ServiceUnavailableException('变更调整幂等台账损坏，已停止写入');
    }
    if (!this.isValidLedger(value, clientMutationId, fingerprint)) {
      throw new ServiceUnavailableException(
        '变更调整幂等台账内容无效，已停止写入',
      );
    }
    return value;
  }

  private isValidLedger(
    value: unknown,
    clientMutationId: string,
    fingerprint: string,
  ): value is ChangeAdjustmentLedgerState {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false;
    const state = value as Partial<ChangeAdjustmentLedgerState>;
    const phaseValid =
      state.phase === 'pending' ||
      state.phase === 'confirmed' ||
      state.phase === 'completed';
    const sourceFilesValid =
      Array.isArray(state.sourceFiles) &&
      state.sourceFiles.every((entry) => this.isValidSourceAttachment(entry)) &&
      state.sourceFiles.filter((entry) => entry.kind === 'scheme').length <=
        5 &&
      state.sourceFiles.filter((entry) => entry.kind === 'evidence').length >=
        1 &&
      state.sourceFiles.filter((entry) => entry.kind === 'evidence').length <=
        5 &&
      new Set(
        state.sourceFiles.map(
          (entry) => `${entry.kind}:${entry.index}:${entry.storageId}`,
        ),
      ).size === state.sourceFiles.length;
    const uploadsValid =
      Array.isArray(state.uploaded) &&
      state.uploaded.every((entry) => this.isValidUploadedAttachment(entry)) &&
      new Set(
        state.uploaded.map(
          (entry) => `${entry.kind}:${entry.index}:${entry.storageId}`,
        ),
      ).size === state.uploaded.length &&
      state.uploaded.every((uploaded) =>
        state.sourceFiles?.some(
          (source) =>
            source.kind === uploaded.kind &&
            source.index === uploaded.index &&
            source.storageId === uploaded.storageId,
        ),
      );
    const targetValid =
      state.target === undefined || this.isValidStrictTarget(state.target);
    const bindingsValid =
      state.bindings === undefined ||
      (Array.isArray(state.bindings) &&
        state.bindings.every((entry) => this.isValidBinding(entry)) &&
        new Set(state.bindings.map((entry) => entry.storageId)).size ===
          state.bindings.length);
    const deletesValid =
      state.deletes === undefined ||
      (Array.isArray(state.deletes) &&
        state.deletes.every((entry) => this.isValidDelete(entry)) &&
        new Set(state.deletes.map((entry) => entry.storageId)).size ===
          state.deletes.length);
    const responseValid =
      state.response === undefined ||
      this.isValidResponse(state.response, clientMutationId, state.recordId);
    const phasePayloadValid =
      state.phase === 'pending'
        ? state.response === undefined &&
          (state.target === undefined ||
            (Array.isArray(state.bindings) && Array.isArray(state.deletes)))
        : Boolean(state.target) &&
          Array.isArray(state.bindings) &&
          Array.isArray(state.deletes) &&
          Boolean(state.response);
    const crossReferencesValid =
      state.target === undefined ||
      (targetValid &&
        Array.isArray(state.bindings) &&
        Array.isArray(state.deletes) &&
        state.bindings.length === state.uploaded?.length &&
        state.bindings.every((binding) =>
          state.uploaded?.some(
            (uploaded) =>
              uploaded.storageId === binding.storageId &&
              uploaded.fileToken === binding.fileToken,
          ),
        ) &&
        state.deletes.every(
          (deletion) =>
            !state.target?.documentTokens.includes(deletion.fileToken) &&
            !state.target?.evidenceTokens.includes(deletion.fileToken),
        ) &&
        (state.response === undefined ||
          (responseValid &&
            this.doesResponseMatchTarget(state.response, state.target))));
    return (
      state.version === 1 &&
      state.clientMutationId === clientMutationId &&
      state.fingerprint === fingerprint &&
      typeof state.recordId === 'string' &&
      Boolean(state.recordId.trim()) &&
      phaseValid &&
      sourceFilesValid &&
      uploadsValid &&
      targetValid &&
      bindingsValid &&
      deletesValid &&
      responseValid &&
      phasePayloadValid &&
      crossReferencesValid &&
      typeof state.createdAt === 'string' &&
      Number.isFinite(Date.parse(state.createdAt)) &&
      typeof state.updatedAt === 'string' &&
      Number.isFinite(Date.parse(state.updatedAt))
    );
  }

  private isValidSourceAttachment(value: unknown): value is SourceAttachment {
    if (!this.isRecord(value)) return false;
    return (
      (value.kind === 'scheme' || value.kind === 'evidence') &&
      Number.isSafeInteger(value.index) &&
      Number(value.index) >= 0 &&
      this.isOpaqueId(value.storageId) &&
      typeof value.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(value.sha256) &&
      Number.isSafeInteger(value.size) &&
      Number(value.size) > 0 &&
      Number(value.size) <=
        (value.kind === 'scheme'
          ? CHANGE_REQUEST_MAX_DOCUMENT_SIZE
          : CHANGE_ADJUSTMENT_EVIDENCE_MAX_SIZE) &&
      typeof value.name === 'string' &&
      Boolean(value.name.trim()) &&
      typeof value.mimeType === 'string' &&
      Boolean(value.mimeType.trim())
    );
  }

  private isValidUploadedAttachment(
    value: unknown,
  ): value is UploadedAttachment {
    if (!this.isRecord(value)) return false;
    return (
      (value.kind === 'scheme' || value.kind === 'evidence') &&
      Number.isSafeInteger(value.index) &&
      Number(value.index) >= 0 &&
      this.isOpaqueId(value.storageId) &&
      this.isOpaqueId(value.fileToken)
    );
  }

  private isValidStrictTarget(value: unknown): value is StrictTarget {
    if (!this.isRecord(value)) return false;
    const start = value.plannedDelayStartAt;
    const end = value.plannedDelayEndAt;
    const startValid =
      start === null || (typeof start === 'number' && Number.isFinite(start));
    return (
      (value.lifecycleStatus === 'not-started' ||
        value.lifecycleStatus === 'in-progress') &&
      startValid &&
      typeof end === 'number' &&
      Number.isFinite(end) &&
      (start === null || (typeof start === 'number' && end > start)) &&
      typeof value.reason === 'string' &&
      Boolean(value.reason.trim()) &&
      this.isValidTokenArray(value.documentTokens, 1, 5) &&
      this.isValidTokenArray(value.evidenceTokens, 1, 5)
    );
  }

  private isValidBinding(value: unknown): value is PostCommitBinding {
    return (
      this.isRecord(value) &&
      this.isOpaqueId(value.storageId) &&
      this.isOpaqueId(value.fileToken)
    );
  }

  private isValidDelete(value: unknown): value is PostCommitDelete {
    return (
      this.isRecord(value) &&
      this.isOpaqueId(value.storageId) &&
      this.isOpaqueId(value.fileToken)
    );
  }

  private doesResponseMatchTarget(
    response: ChangeAdjustmentResponse,
    target: StrictTarget,
  ): boolean {
    return (
      response.record.scheduleStatus === target.lifecycleStatus &&
      response.record.delayReason === target.reason &&
      Date.parse(response.record.plannedDelayEndDate || '') ===
        target.plannedDelayEndAt &&
      (target.plannedDelayStartAt === null
        ? response.record.plannedDelayStartDate === null
        : Date.parse(response.record.plannedDelayStartDate || '') ===
          target.plannedDelayStartAt) &&
      this.sameTokenSet(
        (response.record.planDocuments || []).map(
          (document) => document.fileToken,
        ),
        target.documentTokens,
      ) &&
      this.sameTokenSet(
        (response.record.delayEvidence || []).map(
          (document) => document.fileToken,
        ),
        target.evidenceTokens,
      )
    );
  }

  private isValidResponse(
    value: unknown,
    clientMutationId: string,
    recordId: unknown,
  ): value is ChangeAdjustmentResponse {
    if (!this.isRecord(value) || !this.isRecord(value.record)) return false;
    const record = value.record;
    return (
      value.success === true &&
      value.clientMutationId === clientMutationId &&
      typeof value.message === 'string' &&
      record.bitableRecordId === recordId &&
      typeof record.id === 'string' &&
      Boolean(record.id.trim()) &&
      typeof record.title === 'string' &&
      typeof record.startDate === 'string' &&
      Number.isFinite(Date.parse(record.startDate)) &&
      typeof record.endDate === 'string' &&
      Number.isFinite(Date.parse(record.endDate)) &&
      (record.plannedDelayStartDate === null ||
        (typeof record.plannedDelayStartDate === 'string' &&
          Number.isFinite(Date.parse(record.plannedDelayStartDate)))) &&
      typeof record.plannedDelayEndDate === 'string' &&
      Number.isFinite(Date.parse(record.plannedDelayEndDate)) &&
      (record.scheduleStatus === 'not-started' ||
        record.scheduleStatus === 'in-progress') &&
      typeof record.delayReason === 'string' &&
      this.isValidPublicDocuments(record.planDocuments, 1, 5) &&
      this.isValidPublicDocuments(record.delayEvidence, 1, 5) &&
      Array.isArray(record.buildings) &&
      record.buildings.every((building) => typeof building === 'string') &&
      typeof record.isKey === 'boolean' &&
      typeof record.createdAt === 'string' &&
      Number.isFinite(Date.parse(record.createdAt)) &&
      typeof record.updatedAt === 'string' &&
      Number.isFinite(Date.parse(record.updatedAt))
    );
  }

  private isValidPublicDocuments(
    value: unknown,
    minimum: number,
    maximum: number,
  ): value is ChangeInfoDocument[] {
    if (
      !Array.isArray(value) ||
      value.length < minimum ||
      value.length > maximum
    ) {
      return false;
    }
    const tokens = value.map((document) =>
      this.isRecord(document) ? document.fileToken : null,
    );
    return (
      tokens.every((token) => this.isOpaqueId(token)) &&
      new Set(tokens).size === tokens.length &&
      value.every(
        (document) =>
          this.isRecord(document) &&
          typeof document.name === 'string' &&
          Boolean(document.name.trim()) &&
          typeof document.url === 'string' &&
          Boolean(document.url.trim()),
      )
    );
  }

  private isValidTokenArray(
    value: unknown,
    minimum: number,
    maximum: number,
  ): value is string[] {
    return (
      Array.isArray(value) &&
      value.length >= minimum &&
      value.length <= maximum &&
      value.every((token) => this.isOpaqueId(token)) &&
      new Set(value).size === value.length
    );
  }

  private isOpaqueId(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.trim() === value &&
      value.length > 0 &&
      value.length <= 500 &&
      !/[\r\n\0]/.test(value)
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private async persistLedger(
    state: ChangeAdjustmentLedgerState,
  ): Promise<void> {
    if (!this.ledgerDir) {
      this.memoryLedgers.set(state.clientMutationId, structuredClone(state));
      return;
    }
    await mkdir(this.ledgerDir, { recursive: true });
    const target = this.ledgerPath(state.clientMutationId);
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private ledgerKey(clientMutationId: string): string {
    return createHash('sha256').update(clientMutationId).digest('hex');
  }

  private fingerprintPath(clientMutationId: string): string {
    return join(this.ledgerDir, `${this.ledgerKey(clientMutationId)}.sha256`);
  }

  private ledgerPath(clientMutationId: string): string {
    return join(this.ledgerDir, `${this.ledgerKey(clientMutationId)}.json`);
  }

  private async withRecordWriteLock<T>(
    recordId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.recordWriteTails.get(recordId) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.recordWriteTails.set(recordId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.recordWriteTails.get(recordId) === tail) {
        this.recordWriteTails.delete(recordId);
      }
    }
  }
}
