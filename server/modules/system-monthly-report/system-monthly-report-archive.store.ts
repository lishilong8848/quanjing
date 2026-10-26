import { ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { SystemMonthlyReportArchiveStatus } from '../../../shared/system-monthly-report.interface';

export type SystemMonthlyReportArchiveStep =
  | 'download'
  | 'upload'
  | 'verify'
  | 'complete';

export interface SystemMonthlyReportArchiveEntry {
  id: string;
  sourceRecordId: string;
  sourceFileToken: string;
  year: number;
  month: number;
  room: string;
  name: string;
  size: number;
  objectKey: string;
  sourceFieldName?: '终版月报' | '初审问题截图' | '复审问题截图';
  category?: 'final' | 'review';
  reviewRound?: 'initial' | 'recheck';
  status: SystemMonthlyReportArchiveStatus;
  step: SystemMonthlyReportArchiveStep;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  contentType?: string;
  sha256?: string;
  etag?: string;
  lastError?: string;
}

export type SystemMonthlyReportArchiveReservation = Omit<
  SystemMonthlyReportArchiveEntry,
  'status' | 'step' | 'attempts' | 'createdAt' | 'updatedAt'
>;

interface ArchiveLedgerFile {
  version: 1;
  entries: SystemMonthlyReportArchiveEntry[];
}

export function buildSystemMonthlyReportArchiveId(
  sourceRecordId: string,
  sourceFileToken: string,
): string {
  const digest = createHash('sha256')
    .update(`${sourceRecordId}\u001f${sourceFileToken}`)
    .digest('hex')
    .slice(0, 28);
  return `monthly-archive-${digest}`;
}

export class SystemMonthlyReportArchiveStore {
  private readonly entries: SystemMonthlyReportArchiveEntry[];

  constructor(private readonly filePath: string) {
    this.entries = this.load();
  }

  reserve(input: SystemMonthlyReportArchiveReservation): {
    created: boolean;
    entry: SystemMonthlyReportArchiveEntry;
  } {
    const existing = this.entries.find((item) => item.id === input.id);
    if (existing) {
      if (
        existing.sourceRecordId !== input.sourceRecordId ||
        existing.sourceFileToken !== input.sourceFileToken ||
        existing.objectKey !== input.objectKey
      ) {
        throw new ConflictException('体系月报归档标识已被不同附件占用');
      }
      return { created: false, entry: clone(existing) };
    }
    if (
      this.entries.some(
        (item) =>
          item.sourceRecordId === input.sourceRecordId &&
          item.sourceFileToken === input.sourceFileToken,
      )
    ) {
      throw new ConflictException('体系月报附件归档台账冲突');
    }
    const now = new Date().toISOString();
    const entry: SystemMonthlyReportArchiveEntry = {
      ...clone(input),
      status: 'pending',
      step: 'download',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.entries.push(entry);
    this.persist();
    return { created: true, entry: clone(entry) };
  }

  get(id: string): SystemMonthlyReportArchiveEntry | null {
    return clone(this.entries.find((entry) => entry.id === id) || null);
  }

  list(): SystemMonthlyReportArchiveEntry[] {
    return this.entries.map(clone);
  }

  listRecoverable(): SystemMonthlyReportArchiveEntry[] {
    return this.entries
      .filter((entry) => ['pending', 'syncing'].includes(entry.status))
      .map(clone);
  }

  update(
    id: string,
    patch: Partial<
      Omit<
        SystemMonthlyReportArchiveEntry,
        | 'id'
        | 'sourceRecordId'
        | 'sourceFileToken'
        | 'year'
        | 'month'
        | 'room'
        | 'name'
        | 'objectKey'
        | 'createdAt'
      >
    >,
  ): SystemMonthlyReportArchiveEntry {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) throw new NotFoundException('体系月报归档任务不存在');
    if (
      Object.prototype.hasOwnProperty.call(patch, 'lastError') &&
      patch.lastError === undefined
    ) {
      delete entry.lastError;
    }
    Object.assign(entry, clone(patch), {
      updatedAt: patch.updatedAt || new Date().toISOString(),
    });
    this.persist();
    return clone(entry);
  }

  private load(): SystemMonthlyReportArchiveEntry[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(
        readFileSync(this.filePath, 'utf8'),
      ) as ArchiveLedgerFile;
      return parsed.version === 1 && Array.isArray(parsed.entries)
        ? parsed.entries
        : [];
    } catch (error) {
      throw new Error(
        `无法读取体系月报 COS 归档台账：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      writeFileSync(
        temporaryPath,
        JSON.stringify({
          version: 1,
          entries: this.entries,
        } satisfies ArchiveLedgerFile),
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
