import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { FilePublicationGroup, PreparedFilePublication } from './file-publication.gateway';

export const publicationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type PublicationStatus = 'syncing' | 'pending' | 'publishing' | 'published' | 'archived' | 'rejected' | 'failed';

export interface PublicationFile {
  id: string;
  name: string;
  size: number;
}

export interface PublicationUpload extends PublicationFile {
  path: string;
}

type Delivery = {
  groupId: string;
  firstAttemptAt: number;
  messageId?: string;
  needsCheck?: true;
  phase?: 'queued' | 'sending' | 'failed';
  message?: string;
};

export interface PublicationBatch {
  id: string;
  requestId: string;
  fingerprint: string;
  publisherId: string;
  publisher: string;
  sourceUrl: string;
  title: string;
  code: string;
  status: PublicationStatus;
  mode?: 'archive';
  submittedAt: string;
  metadata: Record<string, string>;
  groups: FilePublicationGroup[];
  schemaVersion?: string;
  files: PublicationFile[];
  prepared?: PreparedFilePublication;
  recordId?: string;
  commitStartedAt?: number;
  reviewed?: { decision: 'approve' | 'reject'; actorId: string; actor: string; at: string; reason?: string };
  publishedAt?: string;
  deliveries: Delivery[];
  retryReceipts?: Record<string, string[]>;
  failures: number;
  nextAttemptAt: number;
  error?: string;
}

function isError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

@Injectable()
export class FilePublicationStore {
  private readonly root = resolve(process.env.FILE_PUBLICATION_STATE_DIR?.trim() || 'data/file-publications');

  async read(id: string): Promise<PublicationBatch | null> {
    let content: string;
    try {
      content = await readFile(join(this.batchDirectory(id), 'batch.json'), 'utf8');
    } catch (error) {
      if (isError(error, 'ENOENT')) return null;
      throw error;
    }
    const batch = JSON.parse(content) as PublicationBatch;
    if (batch.id !== id || !Array.isArray(batch.files) || !Array.isArray(batch.deliveries)) {
      throw new ServiceUnavailableException('文件发布台账不可读取');
    }
    return batch;
  }

  async list(): Promise<PublicationBatch[]> {
    let directories;
    try {
      directories = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (isError(error, 'ENOENT')) return [];
      throw error;
    }
    const batches: PublicationBatch[] = [];
    for (const entry of directories) {
      if (!entry.isDirectory() || !publicationIdPattern.test(entry.name)) continue;
      const batch = await this.read(entry.name);
      if (batch) batches.push(batch);
    }
    return batches.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  }

  async create(batch: PublicationBatch, uploads: PublicationUpload[]): Promise<void> {
    const target = this.batchDirectory(batch.id);
    await mkdir(this.root, { recursive: true });
    const stage = await mkdtemp(join(this.root, '.submission-'));
    try {
      for (const file of uploads) {
        const stored = join(stage, this.fileName(file.id));
        await copyFile(file.path, stored, constants.COPYFILE_EXCL);
        const handle = await open(stored, 'r+');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      await this.writeAtomic(join(stage, 'batch.json'), batch);
      await rename(stage, target);
    } finally {
      if (dirname(resolve(stage)) === this.root) {
        await rm(stage, { force: true, recursive: true });
      }
    }
  }

  save(batch: PublicationBatch): Promise<void> {
    return this.writeAtomic(join(this.batchDirectory(batch.id), 'batch.json'), batch);
  }

  filePath(batchId: string, fileId: string): string {
    return join(this.batchDirectory(batchId), this.fileName(fileId));
  }

  private batchDirectory(id: string): string {
    if (!publicationIdPattern.test(id)) throw new Error('文件发布批次编号无效');
    return join(this.root, id);
  }

  private fileName(id: string): string {
    if (!publicationIdPattern.test(id)) throw new Error('文件发布附件编号无效');
    return id + '.attachment';
  }

  private async writeAtomic(target: string, batch: PublicationBatch): Promise<void> {
    const next = target + '.' + randomUUID() + '.tmp';
    const handle = await open(next, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(JSON.stringify(batch), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(next, target);
    } finally {
      await unlink(next).catch((error: unknown) => {
        if (!isError(error, 'ENOENT')) throw error;
      });
    }
  }
}
