import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import {
  normalizeChangeSummaryReportSubmitterName,
  parseChangeSummaryReportPayload,
  type ChangeSummaryReportAbandonRequest,
  type ChangeSummaryReportAbandonResponse,
  type ChangeSummaryReportCreateRequest,
  type ChangeSummaryReportCreateResponse,
  type ChangeSummaryReportSyncPhase,
  type ChangeSummaryReportSyncTaskResponse,
} from '../../../shared/change-summary-report';

export const CHANGE_SUMMARY_REPORT_SERVICE_OPTIONS =
  'CHANGE_SUMMARY_REPORT_SERVICE_OPTIONS';

export interface ChangeSummaryReportTargetSnapshot {
  recordId: string;
  title: string | null;
  submitterName: string | null;
  progress: string | null;
  level: string | null;
  workflowStatus: string | null;
  hasSummaryReport: boolean;
  plannedStartAt: string | number | Date | null;
  plannedEndAt: string | number | Date | null;
}

export interface ChangeSummaryReportStoredFile {
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

export interface PersistedChangeSummaryReportSnapshot {
  recordId: string;
  clientMutationId: string;
  fingerprint: string;
  changeRecordId: string;
  reportFileTokens: string[];
}

export interface ChangeSummaryReportCreateInput {
  clientMutationId: string;
  fingerprint: string;
  clientToken: string;
  changeRecordId: string;
  reportFileTokens: string[];
}

export interface ChangeSummaryReportExecutionPorts {
  readChangeStrict(
    recordId: string,
  ): Promise<ChangeSummaryReportTargetSnapshot | null>;
  findReportByMutationId(
    clientMutationId: string,
  ): Promise<PersistedChangeSummaryReportSnapshot | null>;
  findReportByChangeRecordId(
    changeRecordId: string,
  ): Promise<PersistedChangeSummaryReportSnapshot | null>;
  resolveOwnedStorage(
    id: string,
    ownerMutationId: string,
  ): Promise<ChangeSummaryReportStoredFile>;
  uploadToBitable(input: {
    file: ChangeSummaryReportStoredFile;
    clientMutationId: string;
  }): Promise<string>;
  createReport(input: ChangeSummaryReportCreateInput): Promise<string>;
  readReportStrict(
    recordId: string,
  ): Promise<PersistedChangeSummaryReportSnapshot | null>;
  bindStorageToRecord(input: {
    id: string;
    recordId: string;
    fileToken: string;
    ownerMutationId: string;
  }): Promise<void>;
  invalidateChangeCaches(): void | Promise<void>;
}

export interface ChangeSummaryReportSelfTestCleanupRequest {
  summaryReportRecordId: string;
  changeRecordId: string;
  changeRequestMutationId: string;
  clientMutationId: string;
  objectId: string;
  summaryMarker: string;
  submitterName: string;
  fileToken: string;
  expiresAt: number;
}

export interface ChangeSummaryReportSelfTestCleanupResponse {
  success: true;
  objectId: string;
  missing: boolean;
}

export interface ChangeSummaryReportCleanupPorts {
  readChangeStrict(
    recordId: string,
  ): Promise<ChangeSummaryReportTargetSnapshot | null>;
  readReportStrict(
    recordId: string,
  ): Promise<PersistedChangeSummaryReportSnapshot | null>;
  findBoundStorageForTrustedSelfTest(objectId: string): Promise<{
    id: string;
    boundRecordId: string;
    fileToken: string;
    ownerMutationId: string;
  } | null>;
  deleteBoundStorageForTrustedSelfTest(input: {
    id: string;
    recordId: string;
    fileToken: string;
    ownerMutationId: string;
  }): Promise<boolean>;
  scrubChangeRequestSelfTestLedger(input: {
    changeRequestMutationId: string;
    changeRecordId: string;
    summaryMarker: string;
    submitterName: string;
  }): Promise<void>;
}

export interface ChangeSummaryReportAbandonPorts {
  readReportStrict(
    recordId: string,
  ): Promise<PersistedChangeSummaryReportSnapshot | null>;
  findReportByMutationId(
    clientMutationId: string,
  ): Promise<PersistedChangeSummaryReportSnapshot | null>;
  findBoundStorage(id: string): Promise<{
    id: string;
    boundRecordId: string;
    fileToken: string;
    ownerMutationId: string;
  } | null>;
  deleteOwnedStorage(id: string, ownerMutationId: string): Promise<boolean>;
  deleteBoundStorage(input: {
    id: string;
    recordId: string;
    fileToken: string;
    ownerMutationId: string;
  }): Promise<boolean>;
  deleteReportStrict(
    input: PersistedChangeSummaryReportSnapshot,
  ): Promise<void>;
  invalidateChangeCaches(): void | Promise<void>;
}

export interface ChangeSummaryReportServiceOptions {
  ledgerDir?: string;
  now?: () => Date;
  schedule?: (callback: () => void) => void;
  onPhase?: (phase: ChangeSummaryReportSyncPhase) => void;
  cleanupSecret?: string;
}

interface SourceFileSnapshot {
  id: string;
  filePath: string;
  bucketId: string;
  url: string;
  name: string;
  size: number;
  mimeType: string;
  sha256: string;
}

interface UploadedFileSnapshot {
  storageId: string;
  fileToken: string;
}

interface ChangeSummaryReportLedger {
  version: 1;
  clientMutationId: string;
  fingerprint: string;
  changeRecordId: string;
  request: ChangeSummaryReportCreateRequest;
  phase: ChangeSummaryReportSyncPhase;
  sourceFiles: SourceFileSnapshot[];
  uploaded: UploadedFileSnapshot[];
  summaryReportRecordId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  cleanupProofDigests?: string[];
  cleanedObjectIds?: string[];
  ownerFingerprintHash?: string;
  abandon?: {
    cleanedObjectIds: string[];
    reportDeleted: boolean;
    completedAt?: string;
  };
}

const CHANGE_SUMMARY_REPORT_CUTOFF = Date.parse('2026-06-01T00:00:00+08:00');
const CHANGE_SUMMARY_REPORT_TASK_ID_PATTERN =
  /^change-summary-report-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHANGE_SUMMARY_REPORT_RECORD_ID_PATTERN = /^rec[A-Za-z0-9_-]{8,80}$/;
const CHANGE_SUMMARY_REPORT_OBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{12,80}$/;
const CHANGE_REQUEST_TASK_ID_PATTERN =
  /^change-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHANGE_SUMMARY_REPORT_SELF_TEST_MARKER_PATTERN =
  /^CODEX-SELFTEST-CHANGE-SUMMARY-\d{13}-[0-9a-f]{8}$/;
const CHANGE_SUMMARY_REPORT_FILE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,500}$/;
const BITABLE_UNRESOLVED_OPTION_ID_PATTERN = /^opt[A-Za-z0-9_-]{3,128}$/;
const CHANGE_SUMMARY_REPORT_CLEANUP_PROOF_TTL_MS = 2 * 60 * 1000;

@Injectable()
export class ChangeSummaryReportService {
  private static readonly allActiveExecutions = new Set<Promise<void>>();
  private readonly ledgerDir: string;
  private readonly now: () => Date;
  private readonly schedule: (callback: () => void) => void;
  private readonly onPhase?: (phase: ChangeSummaryReportSyncPhase) => void;
  private readonly cleanupSecret: string;
  private readonly memoryLedgers = new Map<string, ChangeSummaryReportLedger>();
  private readonly scheduledMutations = new Map<string, symbol>();
  private readonly activeExecutions = new Set<Promise<void>>();
  private readonly changeLocks = new Map<string, Promise<void>>();
  private readonly enqueueLocks = new Map<string, Promise<void>>();
  private readonly cleanupTombstones = new Map<
    string,
    { proofDigests: string[] }
  >();

  constructor(
    @Optional()
    @Inject(CHANGE_SUMMARY_REPORT_SERVICE_OPTIONS)
    options: ChangeSummaryReportServiceOptions = {},
  ) {
    this.ledgerDir =
      options.ledgerDir ??
      (process.env.NODE_ENV === 'test'
        ? ''
        : process.env.CHANGE_SUMMARY_REPORT_MUTATION_LEDGER_DIR?.trim() ||
          join(process.cwd(), 'data', 'change-summary-report-mutations'));
    this.now = options.now || (() => new Date());
    this.schedule =
      options.schedule || ((callback) => queueMicrotask(callback));
    this.onPhase = options.onPhase;
    this.cleanupSecret =
      options.cleanupSecret ??
      String(
        process.env.LOCAL_ACCESS_SESSION_SECRET ||
          process.env.LOCAL_ADMIN_SESSION_SECRET ||
          '',
      ).trim();
  }

  static async waitForAllIdle(): Promise<void> {
    await this.drainTasks(this.allActiveExecutions);
  }

  async waitForIdle(): Promise<void> {
    await ChangeSummaryReportService.drainTasks(this.activeExecutions);
  }

  getMutationLedgerDirectoryForTrustedSelfTest(): string {
    if (!this.ledgerDir) {
      throw new ServiceUnavailableException(
        '变更总结幂等台账未配置，拒绝自测脱敏',
      );
    }
    return this.ledgerDir;
  }

  private static async drainTasks(tasks: Set<Promise<void>>): Promise<void> {
    await Promise.resolve();
    while (tasks.size > 0) {
      await Promise.allSettled([...tasks]);
      await Promise.resolve();
    }
  }

  async enqueue(
    input: unknown,
    ports: ChangeSummaryReportExecutionPorts,
    ownerFingerprint = '',
  ): Promise<ChangeSummaryReportCreateResponse> {
    let request: ChangeSummaryReportCreateRequest;
    try {
      request = parseChangeSummaryReportPayload(input);
    } catch (error) {
      throw new BadRequestException(this.errorMessage(error, true));
    }
    const ownerFingerprintHash =
      hashChangeSummaryOwnerFingerprint(ownerFingerprint);
    return this.withEnqueueLock(request.clientMutationId, () =>
      this.enqueueValidated(request, ports, ownerFingerprintHash),
    );
  }

  private async enqueueValidated(
    request: ChangeSummaryReportCreateRequest,
    ports: ChangeSummaryReportExecutionPorts,
    ownerFingerprintHash: string | undefined,
  ): Promise<ChangeSummaryReportCreateResponse> {
    const fingerprint = buildChangeSummaryReportFingerprint(request);
    let ledger = await this.loadLedger(request.clientMutationId);
    if (ledger && ledger.fingerprint !== fingerprint) {
      throw new ConflictException(
        '相同 clientMutationId 已用于不同的变更总结内容',
      );
    }
    if (
      ledger?.ownerFingerprintHash &&
      ledger.ownerFingerprintHash !== ownerFingerprintHash
    ) {
      throw new ForbiddenException('变更总结请求不属于当前提交会话');
    }
    if (ledger?.abandon?.completedAt) {
      throw new ConflictException('该变更总结请求已放弃，请使用新的请求标识');
    }
    if (ledger?.phase === 'completed') {
      return this.toCreateResponse(ledger, false);
    }
    if (!ledger || ledger.phase === 'failed') {
      this.scheduledMutations.delete(request.clientMutationId);
      const timestamp = this.now().toISOString();
      ledger = await this.saveLedger({
        version: 1,
        clientMutationId: request.clientMutationId,
        fingerprint,
        changeRecordId: request.changeRecordId,
        request,
        phase: 'accepted',
        sourceFiles: ledger?.sourceFiles || [],
        uploaded: ledger?.uploaded || [],
        ...(ledger?.summaryReportRecordId
          ? { summaryReportRecordId: ledger.summaryReportRecordId }
          : {}),
        createdAt: ledger?.createdAt || timestamp,
        updatedAt: timestamp,
        ...(ownerFingerprintHash ? { ownerFingerprintHash } : {}),
      });
      this.onPhase?.('accepted');
    }
    this.scheduleExecution(ledger.clientMutationId, ports);
    return this.toCreateResponse(ledger, true);
  }

  private async withEnqueueLock<T>(
    clientMutationId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.enqueueLocks.get(clientMutationId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.enqueueLocks.set(clientMutationId, tail);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.enqueueLocks.get(clientMutationId) === tail) {
        this.enqueueLocks.delete(clientMutationId);
      }
    }
  }

  async getStatus(
    clientMutationId: string,
    ports: ChangeSummaryReportExecutionPorts,
    ownerFingerprint?: string,
  ): Promise<ChangeSummaryReportSyncTaskResponse> {
    if (!CHANGE_SUMMARY_REPORT_TASK_ID_PATTERN.test(clientMutationId)) {
      throw new BadRequestException('变更总结任务标识无效');
    }
    const ledger = await this.loadLedger(clientMutationId);
    if (!ledger) {
      throw new NotFoundException('未找到变更总结同步任务');
    }
    if (ownerFingerprint !== undefined) {
      const ownerFingerprintHash =
        hashChangeSummaryOwnerFingerprint(ownerFingerprint);
      if (
        !ownerFingerprintHash ||
        !ledger.ownerFingerprintHash ||
        ledger.ownerFingerprintHash !== ownerFingerprintHash
      ) {
        throw new ForbiddenException('变更总结请求不属于当前提交会话');
      }
    }
    if (!['completed', 'failed'].includes(ledger.phase)) {
      this.scheduleExecution(clientMutationId, ports);
    }
    return this.toTaskResponse(ledger);
  }

  async abandon(
    input: ChangeSummaryReportAbandonRequest,
    ownerFingerprint: string,
    ports: ChangeSummaryReportAbandonPorts,
  ): Promise<ChangeSummaryReportAbandonResponse> {
    const request = normalizeChangeSummaryReportAbandonRequest(input);
    const ownerFingerprintHash =
      hashChangeSummaryOwnerFingerprint(ownerFingerprint);
    if (!ownerFingerprintHash) {
      throw new ForbiddenException('当前提交会话无法验证，拒绝放弃变更总结');
    }
    return this.withEnqueueLock(request.clientMutationId, async () => {
      let ledger = await this.requireLedger(request.clientMutationId);
      if (
        ledger.changeRecordId !== request.changeRecordId ||
        normalizeChangeSummaryReportSubmitterName(
          ledger.request.submitterName,
        ) !== request.submitterName
      ) {
        throw new ConflictException('变更总结放弃请求与本地任务身份不一致');
      }
      if (
        !ledger.ownerFingerprintHash ||
        ledger.ownerFingerprintHash !== ownerFingerprintHash
      ) {
        throw new ForbiddenException('变更总结请求不属于当前提交会话');
      }
      if (ledger.abandon?.completedAt) {
        return this.toAbandonResponse(ledger, true, 'abandoned');
      }
      if (ledger.phase === 'completed') {
        return this.toAbandonResponse(ledger, false, 'completed');
      }
      if (ledger.phase !== 'failed') {
        return this.toAbandonResponse(ledger, false, ledger.phase);
      }

      ledger.abandon ||= { cleanedObjectIds: [], reportDeleted: false };
      try {
        let persisted: PersistedChangeSummaryReportSnapshot | null = null;
        if (ledger.summaryReportRecordId) {
          persisted = await ports.readReportStrict(
            ledger.summaryReportRecordId,
          );
        }
        persisted ||= await ports.findReportByMutationId(
          ledger.clientMutationId,
        );
        if (persisted) {
          this.assertPersistedReportMatches(
            persisted,
            ledger.request,
            ledger.fingerprint,
            ledger.uploaded.length
              ? ledger.uploaded.map(({ fileToken }) => fileToken)
              : undefined,
            ledger.summaryReportRecordId || persisted.recordId,
          );
          ledger.summaryReportRecordId ||= persisted.recordId;
        }

        for (const sourceFile of ledger.sourceFiles) {
          if (ledger.abandon.cleanedObjectIds.includes(sourceFile.id)) continue;
          const uploaded = ledger.uploaded.find(
            ({ storageId }) => storageId === sourceFile.id,
          );
          const bound = await ports.findBoundStorage(sourceFile.id);
          if (bound) {
            if (
              !uploaded ||
              !ledger.summaryReportRecordId ||
              bound.id !== sourceFile.id ||
              bound.boundRecordId !== ledger.summaryReportRecordId ||
              bound.ownerMutationId !== ledger.clientMutationId ||
              bound.fileToken !== uploaded.fileToken ||
              (persisted &&
                !persisted.reportFileTokens.includes(bound.fileToken))
            ) {
              throw new ConflictException(
                '变更总结附件绑定身份不一致，拒绝放弃',
              );
            }
            await ports.deleteBoundStorage({
              id: bound.id,
              recordId: bound.boundRecordId,
              fileToken: bound.fileToken,
              ownerMutationId: bound.ownerMutationId,
            });
          } else {
            await ports.deleteOwnedStorage(
              sourceFile.id,
              ledger.clientMutationId,
            );
          }
          ledger.abandon.cleanedObjectIds.push(sourceFile.id);
          ledger = await this.saveLedger(ledger);
        }

        if (persisted && !ledger.abandon.reportDeleted) {
          await ports.deleteReportStrict(persisted);
          const residual = await ports.readReportStrict(persisted.recordId);
          if (residual) {
            throw new ServiceUnavailableException(
              '变更总结收口记录删除后仍可回读',
            );
          }
          ledger.abandon.reportDeleted = true;
          ledger = await this.saveLedger(ledger);
        } else if (!persisted) {
          ledger.abandon.reportDeleted = true;
        }
        await ports.invalidateChangeCaches();
        ledger.abandon.completedAt = this.now().toISOString();
        ledger = await this.saveLedger(ledger);
        return this.toAbandonResponse(ledger, true, 'abandoned');
      } catch {
        ledger = await this.saveLedger(ledger);
        return this.toAbandonResponse(ledger, false, 'cleanup-partial');
      }
    });
  }

  async cleanupBoundAttachment(
    input: ChangeSummaryReportSelfTestCleanupRequest,
    proof: string,
    ports: ChangeSummaryReportCleanupPorts,
  ): Promise<ChangeSummaryReportSelfTestCleanupResponse> {
    const request = verifyChangeSummaryReportCleanupProof(
      input,
      proof,
      this.cleanupSecret,
      this.now().getTime(),
    );
    return this.withEnqueueLock(request.clientMutationId, async () => {
      const proofDigest = createHash('sha256').update(proof).digest('hex');
      const tombstone = await this.loadSelfTestCleanupTombstone(
        request.clientMutationId,
      );
      if (tombstone?.proofDigests.includes(proofDigest)) {
        throw new ConflictException('变更总结自测清理签名已重复使用');
      }
      if (tombstone) {
        throw new ConflictException('变更总结自测任务已经清理');
      }
      let ledger = await this.loadLedger(request.clientMutationId);
      if (ledger?.cleanupProofDigests?.includes(proofDigest)) {
        throw new ConflictException('变更总结自测清理签名已重复使用');
      }

      const persisted = await ports.readReportStrict(
        request.summaryReportRecordId,
      );
      if (!persisted || persisted.recordId !== request.summaryReportRecordId) {
        throw new ConflictException('变更总结收口记录身份不一致，拒绝清理');
      }
      if (persisted.changeRecordId !== request.changeRecordId) {
        throw new ConflictException('变更总结主变更记录身份不一致，拒绝清理');
      }
      if (persisted.clientMutationId !== request.clientMutationId) {
        throw new ConflictException('变更总结请求标识不一致，拒绝清理');
      }
      if (
        !ledger ||
        ledger.phase !== 'completed' ||
        ledger.summaryReportRecordId !== request.summaryReportRecordId ||
        ledger.changeRecordId !== request.changeRecordId
      ) {
        throw new ConflictException('变更总结本地任务身份不一致，拒绝清理');
      }
      if (persisted.fingerprint !== ledger.fingerprint) {
        throw new ConflictException('变更总结收口记录指纹不一致，拒绝清理');
      }
      const target = await ports.readChangeStrict(request.changeRecordId);
      if (!target || target.recordId !== request.changeRecordId) {
        throw new ConflictException(
          '变更总结自测主变更记录身份不一致，拒绝清理',
        );
      }
      if (
        String(target.title || '')
          .normalize('NFKC')
          .trim() !== request.summaryMarker
      ) {
        throw new ConflictException('变更总结自测标记不一致，拒绝清理');
      }
      const authoritativeSubmitter = normalizeChangeSummaryReportSubmitterName(
        target.submitterName,
      );
      if (
        authoritativeSubmitter !== request.submitterName ||
        authoritativeSubmitter !==
          normalizeChangeSummaryReportSubmitterName(
            ledger.request.submitterName,
          )
      ) {
        throw new ConflictException('变更总结自测提交人不一致，拒绝清理');
      }
      const sourceFile = ledger.sourceFiles.find(
        ({ id }) => id === request.objectId,
      );
      const uploadedFile = ledger.uploaded.find(
        ({ storageId }) => storageId === request.objectId,
      );
      if (!sourceFile || !uploadedFile) {
        throw new ConflictException('变更总结附件不属于本地任务，拒绝清理');
      }
      if (
        uploadedFile.fileToken !== request.fileToken ||
        !persisted.reportFileTokens.includes(request.fileToken)
      ) {
        throw new ConflictException('变更总结附件令牌不一致，拒绝清理');
      }

      const bound = await ports.findBoundStorageForTrustedSelfTest(
        request.objectId,
      );
      if (!bound) {
        throw new ConflictException('变更总结附件可信绑定不存在，拒绝清理');
      }
      if (
        bound.id !== request.objectId ||
        bound.boundRecordId !== request.summaryReportRecordId ||
        bound.ownerMutationId !== request.clientMutationId
      ) {
        throw new ConflictException('变更总结附件绑定关系不一致，拒绝清理');
      }
      if (!persisted.reportFileTokens.includes(bound.fileToken)) {
        throw new ConflictException('变更总结附件令牌不一致，拒绝清理');
      }
      if (bound.fileToken !== uploadedFile.fileToken) {
        throw new ConflictException(
          '变更总结附件令牌与本地任务不一致，拒绝清理',
        );
      }
      const deleted = await ports.deleteBoundStorageForTrustedSelfTest({
        id: bound.id,
        recordId: bound.boundRecordId,
        fileToken: bound.fileToken,
        ownerMutationId: bound.ownerMutationId,
      });
      if (!deleted) {
        throw new ServiceUnavailableException('变更总结附件可信删除未确认');
      }

      ledger.cleanupProofDigests = [
        ...(ledger.cleanupProofDigests || []),
        proofDigest,
      ].slice(-20);
      ledger.cleanedObjectIds = Array.from(
        new Set([...(ledger.cleanedObjectIds || []), request.objectId]),
      );
      const allObjectsCleaned = ledger.sourceFiles.every(({ id }) =>
        ledger.cleanedObjectIds?.includes(id),
      );
      if (allObjectsCleaned) {
        await ports.scrubChangeRequestSelfTestLedger({
          changeRequestMutationId: request.changeRequestMutationId,
          changeRecordId: request.changeRecordId,
          summaryMarker: request.summaryMarker,
          submitterName: request.submitterName,
        });
        await this.persistSelfTestCleanupTombstone(ledger, proofDigest);
      } else {
        ledger = await this.saveLedger(ledger);
      }
      return {
        success: true,
        objectId: request.objectId,
        missing: false,
      };
    });
  }

  assertPersistedReportMatches(
    persisted: PersistedChangeSummaryReportSnapshot,
    request: ChangeSummaryReportCreateRequest,
    fingerprint: string,
    expectedFileTokens?: readonly string[],
    expectedRecordId?: string,
  ): void {
    const persistedTokens = [...persisted.reportFileTokens];
    const expectedTokens = expectedFileTokens ? [...expectedFileTokens] : null;
    if (
      (expectedRecordId !== undefined &&
        persisted.recordId !== expectedRecordId) ||
      persisted.clientMutationId !== request.clientMutationId ||
      persisted.fingerprint !== fingerprint ||
      persisted.changeRecordId !== request.changeRecordId ||
      persistedTokens.length !== request.summaryDocuments.length ||
      persistedTokens.some((token) => !token) ||
      (expectedTokens !== null &&
        persistedTokens.join('\u0000') !== expectedTokens.join('\u0000'))
    ) {
      throw new ServiceUnavailableException(
        '变更总结严格回读与当前请求不一致，请使用原请求重试',
      );
    }
  }

  private scheduleExecution(
    clientMutationId: string,
    ports: ChangeSummaryReportExecutionPorts,
  ): void {
    if (this.scheduledMutations.has(clientMutationId)) return;
    const token = Symbol(clientMutationId);
    this.scheduledMutations.set(clientMutationId, token);
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      this.trackExecution(clientMutationId, token, () =>
        this.executeWithChangeLock(clientMutationId, ports),
      );
    };
    try {
      this.schedule(start);
    } catch (error) {
      started = true;
      this.trackExecution(clientMutationId, token, async () => {
        throw error;
      });
    }
  }

  private trackExecution(
    clientMutationId: string,
    token: symbol,
    execute: () => Promise<void>,
  ): void {
    const task = (async () => {
      try {
        await execute();
      } catch (error) {
        await this.persistFailureBestEffort(clientMutationId, error);
      } finally {
        if (this.scheduledMutations.get(clientMutationId) === token) {
          this.scheduledMutations.delete(clientMutationId);
        }
      }
    })();
    this.activeExecutions.add(task);
    ChangeSummaryReportService.allActiveExecutions.add(task);
    const clear = () => {
      this.activeExecutions.delete(task);
      ChangeSummaryReportService.allActiveExecutions.delete(task);
    };
    void task.then(clear, clear);
  }

  private async executeWithChangeLock(
    clientMutationId: string,
    ports: ChangeSummaryReportExecutionPorts,
  ): Promise<void> {
    const ledger = await this.loadLedger(clientMutationId);
    if (!ledger || ['completed', 'failed'].includes(ledger.phase)) return;
    const previous =
      this.changeLocks.get(ledger.changeRecordId) || Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.executeOnce(clientMutationId, ports));
    this.changeLocks.set(ledger.changeRecordId, current);
    try {
      await current;
    } finally {
      if (this.changeLocks.get(ledger.changeRecordId) === current) {
        this.changeLocks.delete(ledger.changeRecordId);
      }
    }
  }

  private async executeOnce(
    clientMutationId: string,
    ports: ChangeSummaryReportExecutionPorts,
  ): Promise<void> {
    let ledger = await this.requireLedger(clientMutationId);
    try {
      ledger = await this.moveTo(ledger, 'validating');
      const existingByMutation = await ports.findReportByMutationId(
        ledger.clientMutationId,
      );
      const existingByChange = await ports.findReportByChangeRecordId(
        ledger.changeRecordId,
      );
      if (
        existingByChange &&
        existingByChange.clientMutationId !== ledger.clientMutationId
      ) {
        throw new ConflictException('该变更已存在变更总结');
      }
      if (
        existingByMutation &&
        existingByChange &&
        existingByMutation.recordId !== existingByChange.recordId
      ) {
        throw new ConflictException('变更总结已有记录身份不一致');
      }
      const expectedFileTokens =
        ledger.uploaded.length > 0
          ? ledger.uploaded.map(({ fileToken }) => fileToken)
          : undefined;
      const reconciledRecordId =
        ledger.summaryReportRecordId ||
        existingByMutation?.recordId ||
        existingByChange?.recordId;
      for (const candidate of [existingByMutation, existingByChange]) {
        if (!candidate) continue;
        this.assertPersistedReportMatches(
          candidate,
          ledger.request,
          ledger.fingerprint,
          expectedFileTokens,
          reconciledRecordId,
        );
      }
      let existing = existingByMutation || existingByChange;
      if (!existing && ledger.summaryReportRecordId) {
        existing = await ports.readReportStrict(ledger.summaryReportRecordId);
      }
      if (existing) {
        this.assertPersistedReportMatches(
          existing,
          ledger.request,
          ledger.fingerprint,
          expectedFileTokens,
          ledger.summaryReportRecordId || existing.recordId,
        );
      }

      const target = await ports.readChangeStrict(ledger.changeRecordId);
      if (!target) {
        throw new NotFoundException('未找到待提交总结的变更记录');
      }
      this.assertEligibleTarget(target, ledger.request, Boolean(existing));

      if (ledger.sourceFiles.length === 0) {
        ledger.sourceFiles = await this.resolveSourceFiles(
          ledger.request,
          ports,
        );
        ledger = await this.saveLedger(ledger);
      }

      if (existing) {
        ledger.summaryReportRecordId ||= existing.recordId;
        if (ledger.uploaded.length === 0) {
          ledger.uploaded = ledger.sourceFiles.map((file, index) => ({
            storageId: file.id,
            fileToken: existing.reportFileTokens[index],
          }));
        }
        ledger = await this.moveTo(ledger, 'record-created');
      }

      if (!ledger.summaryReportRecordId) {
        ledger = await this.moveTo(ledger, 'uploading');
        ledger = await this.uploadMissingFiles(ledger, ports);
        const reconciled = await ports.findReportByMutationId(
          ledger.clientMutationId,
        );
        if (reconciled) {
          this.assertPersistedReportMatches(
            reconciled,
            ledger.request,
            ledger.fingerprint,
            ledger.uploaded.map(({ fileToken }) => fileToken),
          );
          ledger.summaryReportRecordId = reconciled.recordId;
        } else {
          ledger.summaryReportRecordId = await ports.createReport({
            clientMutationId: ledger.clientMutationId,
            fingerprint: ledger.fingerprint,
            clientToken: this.toClientToken(ledger.clientMutationId),
            changeRecordId: ledger.changeRecordId,
            reportFileTokens: ledger.uploaded.map(({ fileToken }) => fileToken),
          });
        }
        ledger = await this.moveTo(ledger, 'record-created');
      }

      const persisted = await ports.readReportStrict(
        ledger.summaryReportRecordId,
      );
      if (!persisted) {
        throw new ServiceUnavailableException(
          '变更总结已写入但严格回读失败，请使用原请求重试',
        );
      }
      this.assertPersistedReportMatches(
        persisted,
        ledger.request,
        ledger.fingerprint,
        ledger.uploaded.map(({ fileToken }) => fileToken),
        ledger.summaryReportRecordId,
      );
      ledger = await this.moveTo(ledger, 'readback-confirmed');

      ledger = await this.moveTo(ledger, 'binding');
      for (const uploaded of ledger.uploaded) {
        await ports.bindStorageToRecord({
          id: uploaded.storageId,
          recordId: ledger.summaryReportRecordId,
          fileToken: uploaded.fileToken,
          ownerMutationId: ledger.clientMutationId,
        });
      }
      await ports.invalidateChangeCaches();
      await this.moveTo(ledger, 'completed');
    } catch (error) {
      await this.persistFailureBestEffort(clientMutationId, error, ledger);
    }
  }

  private async persistFailureBestEffort(
    clientMutationId: string,
    error: unknown,
    fallbackLedger?: ChangeSummaryReportLedger,
  ): Promise<void> {
    let ledger = fallbackLedger || this.memoryLedgers.get(clientMutationId);
    if (!ledger) {
      try {
        ledger = (await this.loadLedger(clientMutationId)) || undefined;
      } catch {
        ledger = this.memoryLedgers.get(clientMutationId);
      }
    }
    if (!ledger) return;

    const failedLedger: ChangeSummaryReportLedger = {
      ...ledger,
      phase: 'failed',
      error: this.errorMessage(error),
    };
    try {
      await this.moveTo(failedLedger, 'failed');
    } catch {
      let updatedAt = ledger.updatedAt;
      try {
        updatedAt = this.now().toISOString();
      } catch {
        // Keep the last valid timestamp in the volatile diagnostic snapshot.
      }
      this.memoryLedgers.set(clientMutationId, {
        ...failedLedger,
        updatedAt,
      });
      try {
        this.onPhase?.('failed');
      } catch {
        // A diagnostic callback must not create a second background rejection.
      }
    }
  }

  private assertEligibleTarget(
    target: ChangeSummaryReportTargetSnapshot,
    request: ChangeSummaryReportCreateRequest,
    allowOwnExistingSummary = false,
  ): void {
    if (target.recordId !== request.changeRecordId) {
      throw new BadRequestException('变更记录标识不一致');
    }
    if (
      normalizeChangeSummaryReportSubmitterName(target.submitterName) !==
      normalizeChangeSummaryReportSubmitterName(request.submitterName)
    ) {
      throw new BadRequestException('所选变更提交人与业务记录不一致');
    }
    if (
      [target.progress, target.level, target.workflowStatus].some((value) =>
        BITABLE_UNRESOLVED_OPTION_ID_PATTERN.test(normalizeLabel(value)),
      )
    ) {
      throw new BadRequestException('变更记录包含未解析的飞书选项，已停止提交');
    }
    if (normalizeLabel(target.progress) !== '已结束') {
      throw new BadRequestException('仅可总结进度为已结束的变更');
    }
    if (normalizeLabel(target.level) === '超低') {
      throw new BadRequestException('变更等级为超低时无需提交变更总结');
    }
    if (!normalizeLabel(target.level)) {
      throw new BadRequestException('变更等级缺失');
    }
    const workflowStatus = normalizeLabel(target.workflowStatus);
    const rejectedWorkflow = ['退回', '返回', '驳回'].find((status) =>
      workflowStatus.includes(status),
    );
    if (rejectedWorkflow) {
      throw new BadRequestException(
        `变更流程为${rejectedWorkflow}时不可提交变更总结`,
      );
    }
    if (target.hasSummaryReport && !allowOwnExistingSummary) {
      throw new ConflictException('该变更已存在变更总结');
    }
    const startAt = parseRecordDate(target.plannedStartAt);
    const endAt = parseRecordDate(target.plannedEndAt);
    if (startAt === null) {
      throw new BadRequestException('计划开始时间无效');
    }
    if (startAt < CHANGE_SUMMARY_REPORT_CUTOFF) {
      throw new BadRequestException('仅支持2026年6月及以后的变更');
    }
    if (endAt === null) {
      throw new BadRequestException('计划结束时间无效');
    }
    if (endAt < startAt) {
      throw new BadRequestException('计划结束时间早于计划开始时间');
    }
  }

  private async resolveSourceFiles(
    request: ChangeSummaryReportCreateRequest,
    ports: ChangeSummaryReportExecutionPorts,
  ): Promise<SourceFileSnapshot[]> {
    const sourceFiles: SourceFileSnapshot[] = [];
    for (const document of request.summaryDocuments) {
      const stored = await ports.resolveOwnedStorage(
        document.objectStorage.id,
        request.clientMutationId,
      );
      const requestedName = (
        document.name ||
        document.originalname ||
        ''
      ).trim();
      const requestedMime = (document.type || document.mimetype || '')
        .trim()
        .toLowerCase();
      if (
        stored.id !== document.objectStorage.id ||
        stored.filePath !== document.objectStorage.filePath ||
        stored.bucketId !== document.objectStorage.bucketId ||
        stored.size !== document.size ||
        (requestedName && stored.name !== requestedName) ||
        (requestedMime && stored.mimeType.toLowerCase() !== requestedMime)
      ) {
        throw new ConflictException('变更总结附件与对象存储暂存快照不一致');
      }
      sourceFiles.push({
        id: stored.id,
        filePath: stored.filePath,
        bucketId: stored.bucketId,
        url: canonicalizeChangeSummaryStorageUrl(stored.url),
        name: stored.name,
        size: stored.size,
        mimeType: stored.mimeType,
        sha256: stored.sha256,
      });
    }
    return sourceFiles;
  }

  private async uploadMissingFiles(
    ledger: ChangeSummaryReportLedger,
    ports: ChangeSummaryReportExecutionPorts,
  ): Promise<ChangeSummaryReportLedger> {
    const uploaded = new Map(
      ledger.uploaded.map((item) => [item.storageId, item.fileToken]),
    );
    for (const sourceFile of ledger.sourceFiles) {
      if (uploaded.has(sourceFile.id)) continue;
      const fileToken = await ports.uploadToBitable({
        file: sourceFile,
        clientMutationId: ledger.clientMutationId,
      });
      if (!fileToken) {
        throw new ServiceUnavailableException('飞书附件上传未返回 file_token');
      }
      ledger.uploaded.push({ storageId: sourceFile.id, fileToken });
      uploaded.set(sourceFile.id, fileToken);
      ledger = await this.saveLedger(ledger);
    }
    return ledger;
  }

  private async moveTo(
    ledger: ChangeSummaryReportLedger,
    phase: ChangeSummaryReportSyncPhase,
  ): Promise<ChangeSummaryReportLedger> {
    const next = await this.saveLedger({
      ...ledger,
      phase,
      ...(phase === 'failed' ? {} : { error: undefined }),
    });
    this.onPhase?.(phase);
    return next;
  }

  private toCreateResponse(
    ledger: ChangeSummaryReportLedger,
    pendingSync: boolean,
  ): ChangeSummaryReportCreateResponse {
    return {
      success: true,
      clientMutationId: ledger.clientMutationId,
      changeRecordId: ledger.changeRecordId,
      ...(ledger.summaryReportRecordId
        ? { summaryReportRecordId: ledger.summaryReportRecordId }
        : {}),
      pendingSync,
      taskId: ledger.clientMutationId,
      message: pendingSync
        ? '变更总结已受理，正在后台同步'
        : '变更总结已同步后台记录',
    };
  }

  private toTaskResponse(
    ledger: ChangeSummaryReportLedger,
  ): ChangeSummaryReportSyncTaskResponse {
    const status =
      ledger.phase === 'completed'
        ? 'completed'
        : ledger.phase === 'failed'
          ? 'failed'
          : ledger.phase === 'accepted'
            ? 'pending'
            : 'running';
    return {
      success: status !== 'failed',
      taskId: ledger.clientMutationId,
      clientMutationId: ledger.clientMutationId,
      changeRecordId: ledger.changeRecordId,
      status,
      phase: ledger.phase,
      ...(ledger.summaryReportRecordId
        ? { summaryReportRecordId: ledger.summaryReportRecordId }
        : {}),
      ...(ledger.error ? { error: ledger.error } : {}),
      message:
        status === 'completed'
          ? '变更总结已同步后台记录'
          : status === 'failed'
            ? ledger.error || '变更总结同步失败'
            : '变更总结正在后台同步',
      updatedAt: ledger.updatedAt,
    };
  }

  private toAbandonResponse(
    ledger: ChangeSummaryReportLedger,
    abandoned: boolean,
    phase: ChangeSummaryReportAbandonResponse['phase'],
  ): ChangeSummaryReportAbandonResponse {
    return {
      success: true,
      clientMutationId: ledger.clientMutationId,
      changeRecordId: ledger.changeRecordId,
      canAbandon: ledger.phase === 'failed' || abandoned,
      abandoned,
      phase,
      message: abandoned
        ? '变更总结失败任务已安全放弃'
        : phase === 'cleanup-partial'
          ? '变更总结放弃清理未完成，可继续重试'
          : '当前变更总结任务不可放弃',
    };
  }

  private async requireLedger(
    clientMutationId: string,
  ): Promise<ChangeSummaryReportLedger> {
    const ledger = await this.loadLedger(clientMutationId);
    if (!ledger) throw new NotFoundException('未找到变更总结同步任务');
    return ledger;
  }

  private async loadLedger(
    clientMutationId: string,
  ): Promise<ChangeSummaryReportLedger | null> {
    if (!this.ledgerDir) {
      return this.assertLedgerTaskBinding(
        clientMutationId,
        this.memoryLedgers.get(clientMutationId) || null,
      );
    }
    const destination = this.ledgerPath(clientMutationId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const path of [destination, `${destination}.bak`]) {
        try {
          const ledger = this.assertLedgerTaskBinding(
            clientMutationId,
            JSON.parse(
              await readFile(path, 'utf8'),
            ) as ChangeSummaryReportLedger,
          );
          if (ledger) this.memoryLedgers.set(clientMutationId, ledger);
          return ledger;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await Promise.resolve();
    }
    return this.assertLedgerTaskBinding(
      clientMutationId,
      this.memoryLedgers.get(clientMutationId) || null,
    );
  }

  private assertLedgerTaskBinding(
    requestedTaskId: string,
    ledger: ChangeSummaryReportLedger | null,
  ): ChangeSummaryReportLedger | null {
    if (ledger && ledger.clientMutationId !== requestedTaskId) {
      throw new ConflictException('变更总结任务标识绑定不一致');
    }
    return ledger;
  }

  private async saveLedger(
    ledger: ChangeSummaryReportLedger,
  ): Promise<ChangeSummaryReportLedger> {
    const next: ChangeSummaryReportLedger = {
      ...ledger,
      request: {
        ...ledger.request,
        summaryDocuments: ledger.request.summaryDocuments.map((document) => ({
          ...document,
          objectStorage: {
            ...document.objectStorage,
            url: canonicalizeChangeSummaryStorageUrl(
              document.objectStorage.url,
            ),
          },
        })),
      },
      sourceFiles: ledger.sourceFiles.map((file) => ({
        ...file,
        url: canonicalizeChangeSummaryStorageUrl(file.url),
      })),
      uploaded: ledger.uploaded.map((file) => ({ ...file })),
      updatedAt: this.now().toISOString(),
    };
    this.memoryLedgers.set(next.clientMutationId, next);
    if (!this.ledgerDir) {
      return next;
    }
    await mkdir(this.ledgerDir, { recursive: true });
    const destination = this.ledgerPath(next.clientMutationId);
    const temporary = `${destination}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, JSON.stringify(next), {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      await rename(temporary, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EEXIST') throw error;
      const backup = `${destination}.bak`;
      await unlink(backup).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
      await rename(destination, backup).catch(
        (renameError: NodeJS.ErrnoException) => {
          if (renameError.code !== 'ENOENT') throw renameError;
        },
      );
      try {
        await rename(temporary, destination);
      } catch (replaceError) {
        await rename(backup, destination).catch(() => undefined);
        throw replaceError;
      }
      await unlink(backup).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
    }
    return next;
  }

  private async loadSelfTestCleanupTombstone(
    clientMutationId: string,
  ): Promise<{ proofDigests: string[] } | null> {
    const cached = this.cleanupTombstones.get(clientMutationId);
    if (cached) return cached;
    if (!this.ledgerDir) return null;
    const path = this.selfTestCleanupTombstonePath(clientMutationId);
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as {
        version?: unknown;
        state?: unknown;
        mutationHash?: unknown;
        proofDigests?: unknown;
      };
      const expectedHash = createHash('sha256')
        .update(clientMutationId)
        .digest('hex');
      if (
        parsed.version !== 1 ||
        parsed.state !== 'self-test-cleaned' ||
        parsed.mutationHash !== expectedHash ||
        !Array.isArray(parsed.proofDigests) ||
        parsed.proofDigests.some(
          (digest) =>
            typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest),
        )
      ) {
        throw new ConflictException('变更总结自测清理墓碑损坏');
      }
      await this.removeSensitiveSelfTestLedger(clientMutationId);
      const tombstone = { proofDigests: [...parsed.proofDigests] as string[] };
      this.memoryLedgers.delete(clientMutationId);
      this.cleanupTombstones.set(clientMutationId, tombstone);
      return tombstone;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async persistSelfTestCleanupTombstone(
    ledger: ChangeSummaryReportLedger,
    proofDigest: string,
  ): Promise<void> {
    const mutationHash = createHash('sha256')
      .update(ledger.clientMutationId)
      .digest('hex');
    const proofDigests = Array.from(
      new Set([...(ledger.cleanupProofDigests || []), proofDigest]),
    ).slice(-20);
    if (this.ledgerDir) {
      await mkdir(this.ledgerDir, { recursive: true });
      const destination = this.selfTestCleanupTombstonePath(
        ledger.clientMutationId,
      );
      const temporary = `${destination}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify({
          version: 1,
          state: 'self-test-cleaned',
          mutationHash,
          proofDigests,
          cleanedAt: this.now().toISOString(),
        }),
        { encoding: 'utf8', mode: 0o600 },
      );
      await rename(temporary, destination);
      await this.removeSensitiveSelfTestLedger(ledger.clientMutationId);
    }
    this.memoryLedgers.delete(ledger.clientMutationId);
    this.cleanupTombstones.set(ledger.clientMutationId, { proofDigests });
  }

  private async removeSensitiveSelfTestLedger(
    clientMutationId: string,
  ): Promise<void> {
    if (!this.ledgerDir) return;
    const ledgerName = `${clientMutationId}.json`;
    const isExactLedgerArtifact = (name: string): boolean =>
      name === ledgerName ||
      name === `${ledgerName}.bak` ||
      (name.startsWith(`${ledgerName}.`) &&
        /^\d+\.[0-9a-f]{12}\.tmp$/.test(name.slice(`${ledgerName}.`.length)));
    const names = await readdir(this.ledgerDir);
    const targets = names.filter(isExactLedgerArtifact);
    for (const name of targets) {
      await unlink(join(this.ledgerDir, name)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        },
      );
    }
    const residual = (await readdir(this.ledgerDir)).filter(
      isExactLedgerArtifact,
    );
    if (residual.length > 0) {
      throw new ServiceUnavailableException('变更总结自测本地任务未能完整脱敏');
    }
  }

  private selfTestCleanupTombstonePath(clientMutationId: string): string {
    const mutationHash = createHash('sha256')
      .update(clientMutationId)
      .digest('hex');
    return join(this.ledgerDir, `self-test-cleaned-${mutationHash}.json`);
  }

  private ledgerPath(clientMutationId: string): string {
    return join(this.ledgerDir, `${clientMutationId}.json`);
  }

  private toClientToken(clientMutationId: string): string {
    const uuid = clientMutationId.slice('change-summary-report-'.length);
    if (!/^[0-9a-f-]{36}$/i.test(uuid)) {
      throw new BadRequestException('变更总结请求标识无效');
    }
    return uuid.toLowerCase();
  }

  private errorMessage(
    error: unknown,
    allowPlainBusinessMessage = false,
  ): string {
    const fallback = '变更总结同步失败，请稍后重试';
    const raw =
      error instanceof Error && error.message ? error.message : fallback;
    const normalizedRaw = raw.normalize('NFKC');
    if (
      /authorization|bearer|token|cookie|password|passwd|secret|credential|api[\s_-]*key|x[\s_-]*api[\s_-]*key|set[\s_-]*cookie/iu.test(
        normalizedRaw,
      )
    ) {
      return fallback;
    }
    const redacted = normalizedRaw
      .replace(
        /(^|[\s,;{(\[?&])(authorization)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\r\n,;}]*)/giu,
        '$1$2=[凭据已隐藏]',
      )
      .replace(/\bbearer(?:\s+|%20)[^\s,;}"']+/giu, 'Bearer [凭据已隐藏]')
      .replace(
        /(^|[\s,;{(\[?&])((?:access[\s_-]*token|refresh[\s_-]*token|tenant[\s_-]*access[\s_-]*token|session(?:[\s_-]*(?:id|token))?|cookie|password|passwd|secret(?:[\s_-]*(?:id|key))?|api[\s_-]*key|authorization|token))\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;}\]]+)/giu,
        '$1$2=[凭据已隐藏]',
      )
      .replace(/https?:\/\/[^\s"'<>]+/giu, '[链接已隐藏]')
      .replace(
        /[?&][A-Za-z0-9_.~-]+=[^&\s]*(?:&[A-Za-z0-9_.~-]+=[^&\s]*)*/gu,
        '[查询参数已隐藏]',
      )
      .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
      .replace(/多维表/gu, '业务记录')
      .replace(/\s+/gu, ' ')
      .trim();
    if (
      (!allowPlainBusinessMessage && !(error instanceof HttpException)) ||
      /\[(?:凭据|链接|查询参数)已隐藏\]/u.test(redacted)
    ) {
      return fallback;
    }
    if (!redacted) return fallback;
    return redacted.length <= 240 ? redacted : `${redacted.slice(0, 239)}…`;
  }
}

function canonicalizeChangeSummaryStorageUrl(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const relativeBase = 'https://change-summary.invalid';
    const parsed = new URL(raw, relativeBase);
    if (parsed.origin === relativeBase && raw.startsWith('/')) {
      return parsed.pathname;
    }
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '';
  }
}

function normalizeChangeSummaryReportAbandonRequest(
  input: ChangeSummaryReportAbandonRequest,
): ChangeSummaryReportAbandonRequest {
  const request = {
    clientMutationId: String(input?.clientMutationId || '').trim(),
    changeRecordId: String(input?.changeRecordId || '').trim(),
    submitterName: normalizeChangeSummaryReportSubmitterName(
      input?.submitterName,
    ),
  };
  if (
    !CHANGE_SUMMARY_REPORT_TASK_ID_PATTERN.test(request.clientMutationId) ||
    !CHANGE_SUMMARY_REPORT_RECORD_ID_PATTERN.test(request.changeRecordId) ||
    !request.submitterName
  ) {
    throw new BadRequestException('变更总结放弃请求无效');
  }
  return request;
}

function hashChangeSummaryOwnerFingerprint(value: string): string | undefined {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(normalized)) return undefined;
  return createHash('sha256').update(normalized).digest('hex');
}

export async function scrubChangeRequestSelfTestLedgerDirectory(input: {
  ledgerDir: string;
  changeRequestMutationId: string;
  changeRecordId: string;
  summaryMarker: string;
  submitterName: string;
  expectedObjectIds?: readonly string[];
}): Promise<{ alreadyScrubbed: boolean }> {
  const ledgerDir = String(input.ledgerDir || '').trim();
  const mutationId = String(input.changeRequestMutationId || '').trim();
  const recordId = String(input.changeRecordId || '').trim();
  const marker = String(input.summaryMarker || '')
    .normalize('NFKC')
    .trim();
  const submitterName = normalizeChangeSummaryReportSubmitterName(
    input.submitterName,
  );
  const expectedObjectIds = Array.isArray(input.expectedObjectIds)
    ? input.expectedObjectIds.map((value) => String(value || '').trim()).sort()
    : null;
  if (
    !ledgerDir ||
    !CHANGE_REQUEST_TASK_ID_PATTERN.test(mutationId) ||
    !CHANGE_SUMMARY_REPORT_RECORD_ID_PATTERN.test(recordId) ||
    !CHANGE_SUMMARY_REPORT_SELF_TEST_MARKER_PATTERN.test(marker) ||
    !submitterName ||
    (expectedObjectIds !== null &&
      (expectedObjectIds.length < 1 ||
        expectedObjectIds.length > 5 ||
        expectedObjectIds.some(
          (objectId) => !CHANGE_SUMMARY_REPORT_OBJECT_ID_PATTERN.test(objectId),
        ) ||
        new Set(expectedObjectIds).size !== expectedObjectIds.length))
  ) {
    throw new BadRequestException('变更申请自测台账清理请求无效');
  }

  await mkdir(ledgerDir, { recursive: true });
  const mutationHash = createHash('sha256').update(mutationId).digest('hex');
  const tombstonePath = join(
    ledgerDir,
    `self-test-cleaned-${mutationHash}.json`,
  );
  const prefix = `${mutationId}.`;
  const filenames = await readdir(ledgerDir);
  const exactFiles = filenames.filter((name) => name.startsWith(prefix));
  const tombstoneExists = filenames.includes(
    `self-test-cleaned-${mutationHash}.json`,
  );
  const allowedSuffix =
    /^(?:sha256|upload\.\d+\.json|record-unknown\.json|manual-reconcile\.json|record\.json|completed\.json)$/;
  if (
    exactFiles.some((name) => !allowedSuffix.test(name.slice(prefix.length)))
  ) {
    throw new ConflictException('变更申请自测台账包含未知文件，拒绝清理');
  }
  if (exactFiles.length === 0) {
    if (!tombstoneExists) {
      throw new ConflictException('未找到变更申请自测台账，拒绝清理');
    }
    assertChangeRequestCleanupTombstone(
      await readFile(tombstonePath, 'utf8'),
      mutationHash,
    );
    return { alreadyScrubbed: true };
  }
  if (tombstoneExists) {
    assertChangeRequestCleanupTombstone(
      await readFile(tombstonePath, 'utf8'),
      mutationHash,
    );
    for (const filename of exactFiles) {
      await unlink(join(ledgerDir, filename)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        },
      );
    }
    const residual = (await readdir(ledgerDir)).filter((name) =>
      name.startsWith(prefix),
    );
    if (residual.length > 0) {
      throw new ServiceUnavailableException('变更申请自测台账未能完整脱敏');
    }
    return { alreadyScrubbed: true };
  }
  const fingerprintPath = join(ledgerDir, `${mutationId}.sha256`);
  const fingerprint = (await readFile(fingerprintPath, 'utf8'))
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new ConflictException('变更申请自测台账指纹损坏，拒绝清理');
  }

  let recordEntry: Record<string, unknown> | null = null;
  let completedEntry: Record<string, unknown> | null = null;
  const persistedObjectIds: string[] = [];
  for (const filename of exactFiles.filter((name) => name.endsWith('.json'))) {
    const entry = parseSelfTestLedgerObject(
      await readFile(join(ledgerDir, filename), 'utf8'),
    );
    if (
      entry.version !== 1 ||
      entry.clientMutationId !== mutationId ||
      entry.fingerprint !== fingerprint
    ) {
      throw new ConflictException('变更申请自测台账身份不一致，拒绝清理');
    }
    const suffix = filename.slice(prefix.length);
    if (suffix === 'record.json') recordEntry = entry;
    if (suffix === 'completed.json') completedEntry = entry;
    if (/^upload\.\d+\.json$/.test(suffix)) {
      const document = isPlainRecord(entry.document) ? entry.document : null;
      const objectId = String(document?.storageId || '').trim();
      if (
        entry.state !== 'uploaded' ||
        !Number.isSafeInteger(entry.index) ||
        !CHANGE_SUMMARY_REPORT_OBJECT_ID_PATTERN.test(objectId)
      ) {
        throw new ConflictException('变更申请自测附件台账损坏，拒绝清理');
      }
      persistedObjectIds.push(objectId);
    }
  }
  persistedObjectIds.sort();
  if (
    expectedObjectIds !== null &&
    (persistedObjectIds.length !== expectedObjectIds.length ||
      persistedObjectIds.some(
        (objectId, index) => objectId !== expectedObjectIds[index],
      ))
  ) {
    throw new ConflictException('变更申请自测附件对象清单不一致，拒绝清理');
  }
  if (
    !recordEntry ||
    recordEntry.state !== 'record-created' ||
    recordEntry.recordId !== recordId ||
    !completedEntry ||
    completedEntry.state !== 'completed' ||
    completedEntry.recordId !== recordId
  ) {
    throw new ConflictException('变更申请自测台账身份不一致，拒绝清理');
  }
  const response = completedEntry.response;
  const completedRecord =
    isPlainRecord(response) && isPlainRecord(response.record)
      ? response.record
      : null;
  if (
    !completedRecord ||
    (completedRecord.id !== recordId &&
      completedRecord.bitableRecordId !== recordId) ||
    String(completedRecord.title || '')
      .normalize('NFKC')
      .trim() !== marker ||
    normalizeChangeSummaryReportSubmitterName(completedRecord.submitterName) !==
      submitterName
  ) {
    throw new ConflictException('变更申请自测台账身份不一致，拒绝清理');
  }

  if (!tombstoneExists) {
    const temporary = `${tombstonePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        version: 1,
        state: 'self-test-cleaned',
        mutationHash,
        cleanedAt: new Date().toISOString(),
      }),
      { encoding: 'utf8', mode: 0o600 },
    );
    await rename(temporary, tombstonePath);
  } else {
    assertChangeRequestCleanupTombstone(
      await readFile(tombstonePath, 'utf8'),
      mutationHash,
    );
  }
  for (const filename of exactFiles) {
    await unlink(join(ledgerDir, filename));
  }
  const residual = (await readdir(ledgerDir)).filter((name) =>
    name.startsWith(prefix),
  );
  if (residual.length > 0) {
    throw new ServiceUnavailableException('变更申请自测台账未能完整脱敏');
  }
  return { alreadyScrubbed: tombstoneExists };
}

function parseSelfTestLedgerObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isPlainRecord(parsed)) return parsed;
  } catch {
    // A malformed durable ledger must fail closed below.
  }
  throw new ConflictException('变更申请自测台账损坏，拒绝清理');
}

function assertChangeRequestCleanupTombstone(
  value: string,
  expectedHash: string,
): void {
  const tombstone = parseSelfTestLedgerObject(value);
  if (
    tombstone.version !== 1 ||
    tombstone.state !== 'self-test-cleaned' ||
    tombstone.mutationHash !== expectedHash
  ) {
    throw new ConflictException('变更申请自测清理墓碑损坏');
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildChangeSummaryReportFingerprint(
  request: ChangeSummaryReportCreateRequest,
): string {
  const canonical = {
    version: 5,
    submitterName: normalizeChangeSummaryReportSubmitterName(
      request.submitterName,
    ),
    changeRecordId: request.changeRecordId.trim(),
    summaryDocuments: request.summaryDocuments.map((document) => ({
      name: (document.name || document.originalname || '').trim(),
      type: (document.type || document.mimetype || '').trim().toLowerCase(),
      size: document.size,
      objectStorage: {
        id: document.objectStorage.id,
        filePath: document.objectStorage.filePath,
        bucketId: document.objectStorage.bucketId,
      },
    })),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function createChangeSummaryReportCleanupProof(
  input: ChangeSummaryReportSelfTestCleanupRequest,
  encodedSecret: string,
): string {
  const request = normalizeChangeSummaryReportCleanupRequest(input);
  const secret = decodeCleanupSecret(encodedSecret);
  if (!secret) throw new Error('变更总结自测清理签名密钥无效');
  return createHmac('sha256', secret)
    .update(changeSummaryReportCleanupProofPayload(request))
    .digest('base64url');
}

function verifyChangeSummaryReportCleanupProof(
  input: ChangeSummaryReportSelfTestCleanupRequest,
  proof: string,
  encodedSecret: string,
  now: number,
): ChangeSummaryReportSelfTestCleanupRequest {
  const request = normalizeChangeSummaryReportCleanupRequest(input);
  if (
    request.expiresAt < now ||
    request.expiresAt > now + CHANGE_SUMMARY_REPORT_CLEANUP_PROOF_TTL_MS
  ) {
    throw new ConflictException('变更总结自测清理签名已失效');
  }
  const secret = decodeCleanupSecret(encodedSecret);
  const supplied = String(proof || '').trim();
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) {
    throw new ConflictException('变更总结自测清理签名无效');
  }
  const expected = createHmac('sha256', secret)
    .update(changeSummaryReportCleanupProofPayload(request))
    .digest();
  const actual = Buffer.from(supplied, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ConflictException('变更总结自测清理签名无效');
  }
  return request;
}

function normalizeChangeSummaryReportCleanupRequest(
  input: ChangeSummaryReportSelfTestCleanupRequest,
): ChangeSummaryReportSelfTestCleanupRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('变更总结自测清理请求无效');
  }
  const request = {
    summaryReportRecordId: String(input.summaryReportRecordId || '').trim(),
    changeRecordId: String(input.changeRecordId || '').trim(),
    changeRequestMutationId: String(input.changeRequestMutationId || '').trim(),
    clientMutationId: String(input.clientMutationId || '').trim(),
    objectId: String(input.objectId || '').trim(),
    summaryMarker: String(input.summaryMarker || '')
      .normalize('NFKC')
      .trim(),
    submitterName: normalizeChangeSummaryReportSubmitterName(
      input.submitterName,
    ),
    fileToken: String(input.fileToken || '').trim(),
    expiresAt: input.expiresAt,
  };
  if (
    !CHANGE_SUMMARY_REPORT_RECORD_ID_PATTERN.test(
      request.summaryReportRecordId,
    ) ||
    !CHANGE_SUMMARY_REPORT_RECORD_ID_PATTERN.test(request.changeRecordId) ||
    !CHANGE_REQUEST_TASK_ID_PATTERN.test(request.changeRequestMutationId) ||
    !CHANGE_SUMMARY_REPORT_TASK_ID_PATTERN.test(request.clientMutationId) ||
    !CHANGE_SUMMARY_REPORT_OBJECT_ID_PATTERN.test(request.objectId) ||
    !CHANGE_SUMMARY_REPORT_SELF_TEST_MARKER_PATTERN.test(
      request.summaryMarker,
    ) ||
    !request.submitterName ||
    !CHANGE_SUMMARY_REPORT_FILE_TOKEN_PATTERN.test(request.fileToken) ||
    !Number.isSafeInteger(request.expiresAt)
  ) {
    throw new BadRequestException('变更总结自测清理请求无效');
  }
  return request;
}

function changeSummaryReportCleanupProofPayload(
  request: ChangeSummaryReportSelfTestCleanupRequest,
): string {
  return [
    'vnet-change-summary-report-self-test-cleanup-v2',
    request.summaryReportRecordId,
    request.changeRecordId,
    request.changeRequestMutationId,
    request.clientMutationId,
    request.objectId,
    request.summaryMarker,
    request.submitterName,
    request.fileToken,
    String(request.expiresAt),
  ].join('\n');
}

function decodeCleanupSecret(value: string): Buffer | null {
  const encoded = String(value || '').trim();
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    return null;
  }
  try {
    const secret = Buffer.from(encoded, 'base64');
    return secret.length === 32 && secret.toString('base64') === encoded
      ? secret
      : null;
  } catch {
    return null;
  }
}

function normalizeLabel(value: string | null | undefined): string {
  return (value || '').normalize('NFKC').replace(/\s+/gu, '');
}

function parseRecordDate(value: string | number | Date | null): number | null {
  if (value === null || value === '') return null;
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const timestamp = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
    return Number.isFinite(new Date(timestamp).getTime()) ? timestamp : null;
  }

  const normalized = value.trim();
  if (!normalized) return null;
  if (/^-?\d{10,13}$/.test(normalized)) {
    return parseRecordDate(Number(normalized));
  }
  const calendarMatch =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(
      normalized,
    );
  if (!calendarMatch) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    calendarMatch;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const daysInMonth =
    month >= 1 && month <= 12
      ? new Date(Date.UTC(year, month, 0)).getUTCDate()
      : 0;
  if (day < 1 || day > daysInMonth) return null;
  if (
    hourText !== undefined &&
    (Number(hourText) > 23 ||
      Number(minuteText) > 59 ||
      Number(secondText) > 59)
  ) {
    return null;
  }
  const timestamp = Date.parse(
    hourText === undefined ? `${normalized}T00:00:00+08:00` : normalized,
  );
  return Number.isFinite(timestamp) ? timestamp : null;
}
