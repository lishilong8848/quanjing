import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PurchaseWorkflowUploadFile } from './purchase-workflow.gateway';
import type { PurchaseWebReceiptCommand } from './purchase-web-receipt-command';

export class PurchaseWebReceiptFiles {
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  async save(payload: PurchaseWebReceiptCommand, files: PurchaseWorkflowUploadFile[]): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.directory(this.root);
    const folder = this.folder(payload);
    try { await this.directory(folder); }
    catch (error) {
      if (!missing(error)) throw error;
      if ((await readdir(this.root)).length >= 256) throw new ServiceUnavailableException('签收附件暂存空间已满，请先处理积压任务');
      await mkdir(folder);
    }
    await this.directory(folder);
    const marker = JSON.stringify({ taskId: payload.taskId, fingerprint: payload.fingerprint });
    await this.writeOnce(join(folder, '.owner'), Buffer.from(marker));
    if (await readFile(join(folder, '.owner'), 'utf8') !== marker) throw new ConflictException('原签收附件与本次提交不一致');
    for (let index = 0; index < files.length; index++) {
      await this.writeOnce(join(folder, `file-${index}.bin`), files[index].buffer);
      await this.read(payload, index);
    }
  }

  async read(payload: PurchaseWebReceiptCommand, index: number): Promise<PurchaseWorkflowUploadFile> {
    await this.directory(this.root);
    const folder = this.folder(payload);
    await this.directory(folder);
    const marker = join(folder, '.owner');
    await this.file(marker);
    if (await readFile(marker, 'utf8') !== JSON.stringify({ taskId: payload.taskId, fingerprint: payload.fingerprint })) throw new ConflictException('签收附件归属校验失败');
    const metadata = payload.files[index];
    if (!metadata || !Number.isSafeInteger(index) || index < 0) throw new ConflictException('签收附件索引无效');
    const path = join(folder, `file-${index}.bin`);
    const stats = await this.file(path);
    if (stats.size !== metadata.size) throw new ConflictException('签收附件大小已变化');
    const buffer = await readFile(path);
    await this.file(path);
    if (createHash('sha256').update(buffer).digest('hex') !== metadata.sha256) throw new ConflictException('签收附件内容已变化');
    return { originalname: metadata.name, mimetype: metadata.mime, size: metadata.size, buffer };
  }

  async remove(payload: PurchaseWebReceiptCommand): Promise<void> {
    const folder = this.folder(payload);
    try { await this.directory(this.root); await this.directory(folder); } catch (error) { if (missing(error)) return; throw error; }
    await this.file(join(folder, '.owner'));
    if (await readFile(join(folder, '.owner'), 'utf8') !== JSON.stringify({ taskId: payload.taskId, fingerprint: payload.fingerprint })) throw new ConflictException('签收附件清理归属校验失败');
    const names = await readdir(folder);
    if (names.some(name => name !== '.owner' && !payload.files.some((_file, index) => name === `file-${index}.bin`))) throw new ConflictException('签收附件目录存在未知文件，已保留');
    for (const name of names) await this.file(join(folder, name));
    for (const name of names.filter(name => name !== '.owner')) await unlink(join(folder, name));
    await unlink(join(folder, '.owner'));
    await rmdir(folder);
  }

  private folder(payload: PurchaseWebReceiptCommand): string {
    if (!/^purchase-receipt-[a-f0-9]{64}$/.test(payload.taskId)) throw new ConflictException('签收附件任务标识无效');
    return join(this.root, payload.taskId);
  }
  private async directory(path: string): Promise<void> {
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink() || resolve(await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()) throw new ConflictException('签收附件目录不安全');
  }
  private async file(path: string) {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) throw new ConflictException('签收附件文件不安全');
    return stats;
  }
  private async writeOnce(path: string, bytes: Buffer): Promise<void> {
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await this.file(path);
      if (!(await readFile(path)).equals(bytes)) throw new ConflictException('签收附件已存在且内容不同');
      return;
    }
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
  }
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
