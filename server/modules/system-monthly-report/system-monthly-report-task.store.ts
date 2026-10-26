import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname } from 'path';
import type {
  SystemMonthlyReportReviewRequest,
  SystemMonthlyReportStage,
  SystemMonthlyReportSubmissionDeletionRequest,
  SystemMonthlyReportSubmissionRequest,
  SystemMonthlyReportTask,
  SystemMonthlyReportSyncBranch,
} from '../../../shared/system-monthly-report.interface';

export interface SystemMonthlyReportStagedFile {
  key: string;
  path: string;
  originalName: string;
  mimeType: string;
  size: number;
  sha256: string;
}

export interface SystemMonthlyReportTaskLedgerEntry {
  principalFingerprint: string;
  requestFingerprint: string;
  task: SystemMonthlyReportTask;
  payload:
    | { kind: 'submission'; request: SystemMonthlyReportSubmissionRequest }
    | {
        kind: 'deletion';
        request: SystemMonthlyReportSubmissionDeletionRequest;
      }
    | { kind: 'review'; request: SystemMonthlyReportReviewRequest };
  files: SystemMonthlyReportStagedFile[];
  uploadedTokens: Record<string, string[]>;
  cosObjects?: Record<
    string,
    { objectKey: string; size: number; sha256: string }
  >;
}

interface LedgerFile {
  version: 1;
  entries: SystemMonthlyReportTaskLedgerEntry[];
}

export class SystemMonthlyReportTaskStore {
  private readonly entries: SystemMonthlyReportTaskLedgerEntry[];

  constructor(private readonly filePath: string) {
    this.entries = this.load();
  }

  reserve(entry: SystemMonthlyReportTaskLedgerEntry): {
    created: boolean;
    entry: SystemMonthlyReportTaskLedgerEntry;
  } {
    const existing = this.entries.find(
      (item) => item.task.clientMutationId === entry.task.clientMutationId,
    );
    if (existing) {
      const sameRequest =
        existing.principalFingerprint === entry.principalFingerprint &&
        existing.requestFingerprint === entry.requestFingerprint &&
        existing.task.action === entry.task.action &&
        existing.task.targetRecordId === entry.task.targetRecordId;
      if (!sameRequest) {
        throw new ConflictException('clientMutationId 已被不同请求占用');
      }
      return { created: false, entry: clone(existing) };
    }
    if (this.entries.some((item) => item.task.id === entry.task.id)) {
      throw new ConflictException('任务编号冲突');
    }
    this.entries.push(clone(entry));
    this.persist();
    return { created: true, entry: clone(entry) };
  }

  findTask(taskId: string): SystemMonthlyReportTask | null {
    return clone(this.findEntry(taskId)?.task || null);
  }

  findByMutation(
    clientMutationId: string,
  ): SystemMonthlyReportTaskLedgerEntry | null {
    return clone(
      this.entries.find(
        (entry) => entry.task.clientMutationId === clientMutationId,
      ) || null,
    );
  }

  getEntry(taskId: string): SystemMonthlyReportTaskLedgerEntry {
    const entry = this.findEntry(taskId);
    if (!entry) throw new NotFoundException('月报同步任务不存在');
    return clone(entry);
  }

  listRecoverable(): SystemMonthlyReportTaskLedgerEntry[] {
    return this.entries
      .filter((entry) => ['accepted', 'syncing'].includes(entry.task.status))
      .map(clone);
  }

  listSubmissionObjectKeys(
    target: {
      room: string;
      reportYear: number;
      reportMonth: number;
      stage: SystemMonthlyReportStage;
    },
    excludeTaskId?: string,
  ): string[] {
    const keys = this.entries.flatMap((entry) => {
      if (
        entry.task.id === excludeTaskId ||
        entry.payload.kind !== 'submission'
      ) {
        return [];
      }
      const request = entry.payload.request;
      if (
        request.room.trim() !== target.room.trim() ||
        request.reportYear !== target.reportYear ||
        request.reportMonth !== target.reportMonth ||
        request.stage !== target.stage
      ) {
        return [];
      }
      return Object.values(entry.cosObjects || {}).map(
        (item) => item.objectKey,
      );
    });
    return Array.from(new Set(keys)).sort();
  }

  updateTask(
    taskId: string,
    patch: Partial<Omit<SystemMonthlyReportTask, 'id' | 'clientMutationId'>>,
  ): SystemMonthlyReportTask {
    const entry = this.requireEntry(taskId);
    entry.task = {
      ...entry.task,
      ...patch,
      updatedAt: patch.updatedAt || new Date().toISOString(),
    };
    this.persist();
    return clone(entry.task);
  }

  updateUploadedTokens(
    taskId: string,
    uploadedTokens: Record<string, string[]>,
  ): void {
    const entry = this.requireEntry(taskId);
    entry.uploadedTokens = clone(uploadedTokens);
    this.persist();
  }

  updateSyncBranch(
    taskId: string,
    branch: 'feishu' | 'cos',
    value: SystemMonthlyReportSyncBranch,
  ): void {
    const entry = this.requireEntry(taskId);
    const pending: SystemMonthlyReportSyncBranch = {
      status: 'pending',
      message: '等待同步',
    };
    entry.task.sync = {
      feishu: entry.task.sync?.feishu || pending,
      cos: entry.task.sync?.cos || pending,
      [branch]: clone(value),
    };
    entry.task.updatedAt = new Date().toISOString();
    this.persist();
  }

  updateCosObjects(
    taskId: string,
    cosObjects: NonNullable<SystemMonthlyReportTaskLedgerEntry['cosObjects']>,
  ): void {
    const entry = this.requireEntry(taskId);
    entry.cosObjects = clone(cosObjects);
    this.persist();
  }

  clearFiles(taskId: string): void {
    const entry = this.requireEntry(taskId);
    entry.files = [];
    this.persist();
  }

  private requireEntry(taskId: string): SystemMonthlyReportTaskLedgerEntry {
    const entry = this.findEntry(taskId);
    if (!entry) throw new NotFoundException('月报同步任务不存在');
    return entry;
  }

  private findEntry(
    taskId: string,
  ): SystemMonthlyReportTaskLedgerEntry | undefined {
    return this.entries.find((entry) => entry.task.id === taskId);
  }

  private load(): SystemMonthlyReportTaskLedgerEntry[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(
        readFileSync(this.filePath, 'utf8'),
      ) as LedgerFile;
      return parsed.version === 1 && Array.isArray(parsed.entries)
        ? parsed.entries
        : [];
    } catch (error) {
      throw new Error(
        `无法读取体系月报同步台账：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private persist(): void {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      writeFileSync(
        temporaryPath,
        JSON.stringify({
          version: 1,
          entries: this.entries,
        } satisfies LedgerFile),
        'utf8',
      );
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      throw error;
    }
  }
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
