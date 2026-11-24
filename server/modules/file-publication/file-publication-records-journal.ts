import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';

export interface TableMutationReceipt {
  fingerprint: string;
  startedAt: number;
  recordId?: string;
  completed?: true;
  rejection?: { status: 400 | 403; message: string };
}

export class FilePublicationRecordsJournal {
  private readonly directory = resolve(process.env.FILE_PUBLICATION_STATE_DIR?.trim() || 'data/file-publications', 'table-mutations');

  async read(key: string, fingerprint: string): Promise<TableMutationReceipt | undefined> {
    let receipt: TableMutationReceipt;
    try {
      receipt = JSON.parse(await readFile(join(this.directory, key + '.json'), 'utf8')) as TableMutationReceipt;
      if (!receipt || !Number.isFinite(receipt.startedAt) || typeof receipt.fingerprint !== 'string') throw new Error();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new ServiceUnavailableException('操作回执暂不可读取，请使用原请求核对');
    }
    if (receipt.fingerprint !== fingerprint) throw new ConflictException('操作编号已使用，请核对原操作');
    return receipt;
  }

  async save(key: string, receipt: TableMutationReceipt): Promise<void> {
    const target = join(this.directory, key + '.json');
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
      await mkdir(this.directory, { recursive: true });
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(receipt), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
    } catch {
      throw new ServiceUnavailableException('操作回执暂不可保存，请使用原请求核对');
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
