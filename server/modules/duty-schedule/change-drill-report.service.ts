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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  validateChangeDrillReport,
  type ChangeDrillReportCreateRequest,
  type ChangeDrillReportCreateResponse,
} from '../../../shared/change-drill-report';
import type { ChangeAdjustmentLifecycleStatus } from '../../../shared/change-adjustment';

export const CHANGE_DRILL_REPORT_SERVICE_OPTIONS =
  'CHANGE_DRILL_REPORT_SERVICE_OPTIONS';

export interface ChangeDrillReportTargetSnapshot {
  recordId: string;
  level: string | null;
  lifecycleStatus: ChangeAdjustmentLifecycleStatus;
  buildings: string[];
}

export interface ChangeDrillReportStoredFile {
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

export interface PersistedChangeDrillReportSnapshot {
  recordId: string;
  clientMutationId: string;
  fingerprint: string;
  changeRecordId: string;
  buildings: string[];
  reportFileTokens: string[];
}

export interface ChangeDrillReportCreateInput {
  clientMutationId: string;
  fingerprint: string;
  clientToken: string;
  changeRecordId: string;
  buildings: string[];
  reportFileTokens: string[];
}

export interface ChangeDrillReportExecutionPorts {
  readChangeStrict(
    recordId: string,
  ): Promise<ChangeDrillReportTargetSnapshot | null>;
  findReportByMutationId(
    clientMutationId: string,
  ): Promise<PersistedChangeDrillReportSnapshot | null>;
  resolveOwnedStorage(
    id: string,
    ownerMutationId: string,
  ): Promise<ChangeDrillReportStoredFile>;
  uploadToBitable(input: {
    file: ChangeDrillReportStoredFile;
    clientMutationId: string;
  }): Promise<string>;
  createReport(input: ChangeDrillReportCreateInput): Promise<string>;
  bindStorageToRecord(input: {
    id: string;
    recordId: string;
    fileToken: string;
    ownerMutationId: string;
  }): Promise<void>;
}

export interface ChangeDrillReportServiceOptions {
  ledgerDir?: string;
  now?: () => Date;
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

interface ChangeDrillReportLedger {
  version: 1;
  clientMutationId: string;
  fingerprint: string;
  changeRecordId: string;
  buildings: string[];
  phase: 'pending' | 'uploaded' | 'created' | 'completed';
  sourceFiles: SourceFileSnapshot[];
  uploaded: UploadedFileSnapshot[];
  reportRecordId?: string;
  response?: ChangeDrillReportCreateResponse;
  createdAt: string;
  updatedAt: string;
}

interface RequestEnvelope {
  request: ChangeDrillReportCreateRequest;
  fingerprint: string;
}

interface InFlightEntry {
  fingerprint: string;
  promise: Promise<ChangeDrillReportCreateResponse>;
}

const ELIGIBLE_LEVELS = new Set(['高', '中']);

@Injectable()
export class ChangeDrillReportService {
  private readonly ledgerDir: string;
  private readonly now: () => Date;
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly memoryLedgers = new Map<string, ChangeDrillReportLedger>();

  constructor(
    @Optional()
    @Inject(CHANGE_DRILL_REPORT_SERVICE_OPTIONS)
    options: ChangeDrillReportServiceOptions = {},
  ) {
    this.ledgerDir =
      options.ledgerDir ??
      (process.env.NODE_ENV === 'test'
        ? ''
        : process.env.CHANGE_DRILL_REPORT_MUTATION_LEDGER_DIR?.trim() ||
          join(process.cwd(), 'data', 'change-drill-report-mutations'));
    this.now = options.now || (() => new Date());
  }

  async execute(
    request: ChangeDrillReportCreateRequest,
    ports: ChangeDrillReportExecutionPorts,
  ): Promise<ChangeDrillReportCreateResponse> {
    const envelope = this.buildEnvelope(request);
    const existing = this.inFlight.get(request.clientMutationId);
    if (existing) {
      if (existing.fingerprint !== envelope.fingerprint) {
        throw new ConflictException(
          '相同 clientMutationId 正在处理不同的演练报告',
        );
      }
      return existing.promise;
    }

    const promise = this.executeOnce(envelope, ports);
    this.inFlight.set(request.clientMutationId, {
      fingerprint: envelope.fingerprint,
      promise,
    });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(request.clientMutationId)?.promise === promise) {
        this.inFlight.delete(request.clientMutationId);
      }
    }
  }

  private async executeOnce(
    envelope: RequestEnvelope,
    ports: ChangeDrillReportExecutionPorts,
  ): Promise<ChangeDrillReportCreateResponse> {
    const { request, fingerprint } = envelope;
    let ledger = await this.loadLedger(request.clientMutationId);
    if (ledger && ledger.fingerprint !== fingerprint) {
      throw new ConflictException(
        '相同 clientMutationId 已用于不同的演练报告内容',
      );
    }
    if (ledger?.phase === 'completed' && ledger.response) {
      return ledger.response;
    }

    if (!ledger) {
      const persisted = await ports.findReportByMutationId(
        request.clientMutationId,
      );
      if (persisted) {
        this.assertPersistedReportMatches(persisted, request, fingerprint);
        ledger = await this.saveLedger({
          version: 1,
          clientMutationId: request.clientMutationId,
          fingerprint,
          changeRecordId: request.changeRecordId,
          buildings: [...request.buildings],
          phase: 'created',
          sourceFiles: [],
          uploaded: request.reportDocuments.map((document, index) => ({
            storageId: document.objectStorage.id,
            fileToken: persisted.reportFileTokens[index] || '',
          })),
          reportRecordId: persisted.recordId,
          createdAt: this.now().toISOString(),
          updatedAt: this.now().toISOString(),
        });
      }
    }

    if (!ledger) {
      const target = await ports.readChangeStrict(request.changeRecordId);
      if (!target) {
        throw new NotFoundException('未找到待提交演练报告的变更记录');
      }
      this.assertEligibleTarget(target, request.changeRecordId);
      const sourceFiles = await this.resolveSourceFiles(request, ports);
      const timestamp = this.now().toISOString();
      ledger = await this.saveLedger({
        version: 1,
        clientMutationId: request.clientMutationId,
        fingerprint,
        changeRecordId: request.changeRecordId,
        buildings: [...request.buildings],
        phase: 'pending',
        sourceFiles,
        uploaded: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    if (ledger.sourceFiles.length === 0) {
      ledger.sourceFiles = await this.resolveSourceFiles(request, ports);
      ledger = await this.saveLedger(ledger);
    }

    if (!ledger.reportRecordId) {
      ledger = await this.uploadMissingReports(ledger, ports);
      const persisted = await ports.findReportByMutationId(
        request.clientMutationId,
      );
      if (persisted) {
        this.assertPersistedReportMatches(
          persisted,
          request,
          fingerprint,
          ledger.uploaded.map(({ fileToken }) => fileToken),
        );
        ledger.reportRecordId = persisted.recordId;
      } else {
        ledger.reportRecordId = await ports.createReport({
          clientMutationId: request.clientMutationId,
          fingerprint,
          clientToken: this.toClientToken(request.clientMutationId),
          changeRecordId: request.changeRecordId,
          buildings: [...request.buildings],
          reportFileTokens: ledger.uploaded.map(({ fileToken }) => fileToken),
        });
      }
      ledger.phase = 'created';
      ledger = await this.saveLedger(ledger);
    }

    for (const uploaded of ledger.uploaded) {
      if (!uploaded.fileToken) continue;
      await ports.bindStorageToRecord({
        id: uploaded.storageId,
        recordId: ledger.reportRecordId,
        fileToken: uploaded.fileToken,
        ownerMutationId: request.clientMutationId,
      });
    }

    const response: ChangeDrillReportCreateResponse = {
      success: true,
      clientMutationId: request.clientMutationId,
      changeRecordId: request.changeRecordId,
      reportRecordId: ledger.reportRecordId,
      buildings: [...request.buildings],
      message: '演练报告已同步飞书多维表',
    };
    ledger.phase = 'completed';
    ledger.response = response;
    await this.saveLedger(ledger);
    return response;
  }

  private buildEnvelope(request: unknown): RequestEnvelope {
    const errors = validateChangeDrillReport(request);
    if (errors.length > 0) {
      throw new BadRequestException(errors[0].message);
    }
    const typed = request as ChangeDrillReportCreateRequest;
    const normalized: ChangeDrillReportCreateRequest = {
      clientMutationId: typed.clientMutationId.trim(),
      changeRecordId: typed.changeRecordId.trim(),
      buildings: [...typed.buildings],
      reportDocuments: typed.reportDocuments.map((document) => ({
        ...document,
        name: document.name?.trim(),
        originalname: document.originalname?.trim(),
        type: document.type?.trim(),
        mimetype: document.mimetype?.trim(),
        objectStorage: {
          ...document.objectStorage,
          id: document.objectStorage.id.trim(),
          filePath: document.objectStorage.filePath.trim(),
          bucketId: document.objectStorage.bucketId.trim(),
          url: document.objectStorage.url.trim(),
        },
      })),
    };
    return {
      request: normalized,
      fingerprint: createHash('sha256')
        .update(
          JSON.stringify({
            changeRecordId: normalized.changeRecordId,
            buildings: [...normalized.buildings].sort(),
            reportDocuments: normalized.reportDocuments
              .map((document) => ({
                id: document.objectStorage.id,
                name: document.name || document.originalname || '',
                size: document.size,
                type: document.type || document.mimetype || '',
              }))
              .sort((left, right) => left.id.localeCompare(right.id)),
          }),
        )
        .digest('hex'),
    };
  }

  private assertEligibleTarget(
    target: ChangeDrillReportTargetSnapshot,
    requestedRecordId: string,
  ): void {
    if (target.recordId !== requestedRecordId) {
      throw new BadRequestException('演练报告关联的变更记录不一致');
    }
    if (
      !ELIGIBLE_LEVELS.has(String(target.level || '').trim()) ||
      target.lifecycleStatus === 'finished'
    ) {
      throw new BadRequestException('演练报告仅支持中、高风险且未结束的变更');
    }
  }

  private async resolveSourceFiles(
    request: ChangeDrillReportCreateRequest,
    ports: ChangeDrillReportExecutionPorts,
  ): Promise<SourceFileSnapshot[]> {
    const files: SourceFileSnapshot[] = [];
    for (const document of request.reportDocuments) {
      const stored = await ports.resolveOwnedStorage(
        document.objectStorage.id,
        request.clientMutationId,
      );
      const expectedName = String(
        document.name || document.originalname || '',
      ).trim();
      const expectedMime = String(
        document.type || document.mimetype || '',
      ).trim();
      if (
        stored.id !== document.objectStorage.id ||
        stored.filePath !== document.objectStorage.filePath ||
        stored.bucketId !== document.objectStorage.bucketId ||
        stored.url !== document.objectStorage.url ||
        stored.name !== expectedName ||
        stored.size !== document.size ||
        stored.mimeType !== expectedMime
      ) {
        throw new BadRequestException('演练报告附件与对象存储信息不一致');
      }
      files.push({
        id: stored.id,
        filePath: stored.filePath,
        bucketId: stored.bucketId,
        url: stored.url,
        name: stored.name,
        size: stored.size,
        mimeType: stored.mimeType,
        sha256: stored.sha256,
      });
    }
    return files;
  }

  private async uploadMissingReports(
    ledger: ChangeDrillReportLedger,
    ports: ChangeDrillReportExecutionPorts,
  ): Promise<ChangeDrillReportLedger> {
    const uploadedByStorage = new Map(
      ledger.uploaded.map((item) => [item.storageId, item.fileToken]),
    );
    for (const source of ledger.sourceFiles) {
      if (uploadedByStorage.has(source.id)) continue;
      const fileToken = await ports.uploadToBitable({
        file: source,
        clientMutationId: ledger.clientMutationId,
      });
      ledger.uploaded.push({ storageId: source.id, fileToken });
      uploadedByStorage.set(source.id, fileToken);
      ledger = await this.saveLedger(ledger);
    }
    ledger.phase = 'uploaded';
    return this.saveLedger(ledger);
  }

  assertPersistedReportMatches(
    persisted: PersistedChangeDrillReportSnapshot,
    request: ChangeDrillReportCreateRequest,
    fingerprint: string,
    expectedReportFileTokens?: readonly string[],
  ): void {
    const persistedBuildings = [...persisted.buildings].sort();
    const requestedBuildings = [...request.buildings].sort();
    const persistedTokens = [...persisted.reportFileTokens].sort();
    const expectedTokens = expectedReportFileTokens
      ? [...expectedReportFileTokens].sort()
      : null;
    if (
      persisted.clientMutationId !== request.clientMutationId ||
      persisted.fingerprint !== fingerprint ||
      persisted.changeRecordId !== request.changeRecordId ||
      persistedBuildings.join('\u0000') !== requestedBuildings.join('\u0000') ||
      persisted.reportFileTokens.length !== request.reportDocuments.length ||
      persisted.reportFileTokens.some((fileToken) => !fileToken) ||
      (expectedTokens !== null &&
        persistedTokens.join('\u0000') !== expectedTokens.join('\u0000'))
    ) {
      throw new ServiceUnavailableException(
        '相同 clientMutationId 已对应不同的演练报告记录',
      );
    }
  }

  private toClientToken(clientMutationId: string): string {
    const match = /^change-drill-report-([0-9a-f-]{36})$/i.exec(
      clientMutationId,
    );
    if (!match) {
      throw new BadRequestException('演练报告请求标识无效');
    }
    return match[1].toLowerCase();
  }

  private async loadLedger(
    clientMutationId: string,
  ): Promise<ChangeDrillReportLedger | null> {
    if (!this.ledgerDir) {
      return this.memoryLedgers.get(clientMutationId) || null;
    }
    try {
      const raw = await readFile(this.ledgerPath(clientMutationId), 'utf8');
      return JSON.parse(raw) as ChangeDrillReportLedger;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async saveLedger(
    ledger: ChangeDrillReportLedger,
  ): Promise<ChangeDrillReportLedger> {
    const next: ChangeDrillReportLedger = {
      ...ledger,
      buildings: [...ledger.buildings],
      sourceFiles: ledger.sourceFiles.map((file) => ({ ...file })),
      uploaded: ledger.uploaded.map((item) => ({ ...item })),
      updatedAt: this.now().toISOString(),
    };
    if (!this.ledgerDir) {
      this.memoryLedgers.set(next.clientMutationId, next);
      return next;
    }
    await mkdir(this.ledgerDir, { recursive: true });
    const destination = this.ledgerPath(next.clientMutationId);
    const temporary = `${destination}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, JSON.stringify(next), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, destination);
    return next;
  }

  private ledgerPath(clientMutationId: string): string {
    return join(this.ledgerDir, `${clientMutationId}.json`);
  }
}
