import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { SystemMonthlyReportPackageTask } from '../../../shared/system-monthly-report.interface';

export interface SystemMonthlyReportPackageReservation {
  id: string;
  clientMutationId: string;
  principalFingerprint: string;
  requestFingerprint: string;
  year: number;
  month: number;
  expectedRooms: string[];
  recipientOpenId: string;
}

export interface SystemMonthlyReportPackageEntry extends SystemMonthlyReportPackageReservation {
  task: SystemMonthlyReportPackageTask;
  objectKey?: string;
  messageId?: string;
}

interface PackageLedgerFile {
  version: 1;
  entries: SystemMonthlyReportPackageEntry[];
}

export class SystemMonthlyReportPackageStore {
  private readonly entries: SystemMonthlyReportPackageEntry[];
  constructor(private readonly filePath: string) {
    this.entries = this.load();
  }

  reserve(input: SystemMonthlyReportPackageReservation): {
    created: boolean;
    entry: SystemMonthlyReportPackageEntry;
  } {
    const existing = this.entries.find(
      (item) => item.clientMutationId === input.clientMutationId,
    );
    if (existing) {
      if (
        existing.principalFingerprint !== input.principalFingerprint ||
        existing.requestFingerprint !== input.requestFingerprint ||
        existing.year !== input.year ||
        existing.month !== input.month
      )
        throw new ConflictException('打包 clientMutationId 已被不同请求占用');
      return { created: false, entry: clone(existing) };
    }
    const now = new Date().toISOString();
    const fileName = `华东1部分机房体系月报-${input.year}年${String(input.month).padStart(2, '0')}月-终版汇总.zip`;
    const entry: SystemMonthlyReportPackageEntry = {
      ...clone(input),
      task: {
        id: input.id,
        clientMutationId: input.clientMutationId,
        year: input.year,
        month: input.month,
        status: 'accepted',
        message: '打包任务已受理',
        fileName,
        missingRooms: [],
        packageReady: false,
        notified: false,
        createdAt: now,
        updatedAt: now,
      },
    };
    this.entries.push(entry);
    this.persist();
    return { created: true, entry: clone(entry) };
  }

  get(id: string): SystemMonthlyReportPackageTask | null {
    return clone(this.entries.find((item) => item.id === id)?.task || null);
  }
  getEntry(id: string): SystemMonthlyReportPackageEntry | null {
    return clone(this.entries.find((item) => item.id === id) || null);
  }
  listRecoverable(): SystemMonthlyReportPackageEntry[] {
    return this.entries
      .filter((item) =>
        ['accepted', 'packaging', 'uploading', 'notifying'].includes(
          item.task.status,
        ),
      )
      .map(clone);
  }
  update(
    id: string,
    patch: Partial<SystemMonthlyReportPackageEntry>,
  ): SystemMonthlyReportPackageEntry {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) throw new NotFoundException('月报打包任务不存在');
    const taskPatch: Partial<SystemMonthlyReportPackageTask> = patch.task || {};
    if (
      Object.prototype.hasOwnProperty.call(taskPatch, 'notificationError') &&
      taskPatch.notificationError === undefined
    )
      delete entry.task.notificationError;
    const { task: _task, ...entryPatch } = patch;
    Object.assign(entry, clone(entryPatch));
    entry.task = {
      ...entry.task,
      ...clone(taskPatch),
      updatedAt: new Date().toISOString(),
    };
    this.persist();
    return clone(entry);
  }

  private load(): SystemMonthlyReportPackageEntry[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const value = JSON.parse(
        readFileSync(this.filePath, 'utf8'),
      ) as PackageLedgerFile;
      return value.version === 1 && Array.isArray(value.entries)
        ? value.entries
        : [];
    } catch (error) {
      throw new Error(
        `无法读取体系月报打包台账：${error instanceof Error ? error.message : String(error)}`,
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
        } satisfies PackageLedgerFile),
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
