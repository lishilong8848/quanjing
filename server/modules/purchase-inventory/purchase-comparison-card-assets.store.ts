import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { createProcessLockOwner, normalizeProcessLockOwner, processLockOwnerMayBeAlive } from '../../common/process-lock-owner';

const HASH = /^[a-f0-9]{64}$/;
const IMAGE = /^img_[A-Za-z0-9_-]{1,300}$/;
const MAX_ENTRIES = 2_000;
const MAX_BYTES = 2 * 1024 * 1024;
type Cache = { version: 1; entries: Record<string, { imageKey: string; createdAt: string }> };
const unavailable = () => new ServiceUnavailableException('采购比价图片缓存暂不可用，请重试原通知任务');

/** Cache only opaque source fingerprints and confirmed image keys, never media tokens or URLs. */
export class PurchaseComparisonCardAssetsStore {
  private readonly pending = new Map<string, Promise<string>>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly filePath = process.env.PURCHASE_COMPARISON_CARD_ASSETS_FILE || join(process.cwd(), '.runtime', 'purchase-comparison-card-assets.json')) {}

  async getOrCreate(sourceFingerprint: string, create: () => Promise<string>): Promise<string> {
    if (!HASH.test(sourceFingerprint)) throw unavailable();
    const pending = this.pending.get(sourceFingerprint);
    if (pending) return pending;
    const operation = this.queue.then(() => this.prepare(sourceFingerprint, create));
    this.queue = operation.catch(() => undefined);
    this.pending.set(sourceFingerprint, operation);
    try { return await operation; } finally { this.pending.delete(sourceFingerprint); }
  }

  private async prepare(key: string, create: () => Promise<string>): Promise<string> {
    let lock: number | undefined;
    const lockPath = `${this.filePath}.lock`, owner = createProcessLockOwner(randomUUID());
    let temporary: string | undefined;
    try {
      const existing = this.read().entries[key];
      if (existing) return existing.imageKey;
      assertOrdinary(this.filePath);
      mkdirSync(dirname(this.filePath), { recursive: true });
      assertOrdinary(lockPath);
      lock = acquire(lockPath);
      writeFileSync(lock, JSON.stringify(owner));
      const current = this.read();
      if (current.entries[key]) return current.entries[key].imageKey;
      const imageKey = await create();
      if (!IMAGE.test(imageKey)) throw unavailable();
      current.entries[key] = { imageKey, createdAt: new Date().toISOString() };
      const ordered = Object.entries(current.entries).sort((a, b) => b[1].createdAt.localeCompare(a[1].createdAt));
      current.entries = Object.fromEntries(ordered.slice(0, MAX_ENTRIES));
      const bytes = Buffer.from(JSON.stringify(current));
      if (bytes.length > MAX_BYTES) throw unavailable();
      temporary = `${this.filePath}.${owner.token}.tmp`;
      assertOrdinary(temporary);
      const descriptor = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      assertOrdinary(this.filePath);
      renameSync(temporary, this.filePath);
      temporary = undefined;
      return imageKey;
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      // External preparation failures are retried by the existing notification outbox.
      throw unavailable();
    } finally {
      try {
        if (temporary && existsSync(temporary)) unlinkSync(temporary);
        if (lock !== undefined) closeSync(lock);
        if (readOwner(lockPath)?.token === owner.token) unlinkSync(lockPath);
      } catch { throw unavailable(); }
    }
  }

  private read(): Cache {
    assertOrdinary(this.filePath);
    if (!existsSync(this.filePath)) return { version: 1, entries: {} };
    const value: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
    if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'entries,version' || value.version !== 1 || !isRecord(value.entries) || Object.keys(value.entries).length > MAX_ENTRIES) throw unavailable();
    for (const [key, entry] of Object.entries(value.entries)) {
      if (!HASH.test(key) || !isRecord(entry) || Object.keys(entry).sort().join(',') !== 'createdAt,imageKey' ||
        typeof entry.imageKey !== 'string' || !IMAGE.test(entry.imageKey) || typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt))) throw unavailable();
    }
    return value as Cache;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function assertOrdinary(file: string): void {
  if (!isAbsolute(file) || file.slice(parse(file).root.length).includes(':') || /[\x00-\x1f]/.test(file)) throw unavailable();
  const full = resolve(file);
  for (let cursor = full; ; cursor = dirname(cursor)) {
    try {
      const info = lstatSync(cursor);
      if (info.isSymbolicLink() || realpathSync.native(cursor).toLowerCase() !== cursor.toLowerCase() ||
        (cursor === full ? !info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES : !info.isDirectory())) throw unavailable();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (dirname(cursor) === cursor) break;
  }
}
function readOwner(file: string) {
  try { assertOrdinary(file); return normalizeProcessLockOwner(JSON.parse(readFileSync(file, 'utf8'))); } catch { return null; }
}
function acquire(file: string): number {
  try { return openSync(file, 'wx', 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = readOwner(file);
    if (!owner || processLockOwnerMayBeAlive(owner, lstatSync(file).mtimeMs)) throw new ConflictException('采购比价图片正在准备，请重试原通知任务');
    const recovery = `${file}.recovery`;
    assertOrdinary(recovery);
    let guard: number;
    try { guard = openSync(recovery, 'wx', 0o600); } catch { throw new ConflictException('采购比价图片缓存正在恢复'); }
    try {
      const latest = readOwner(file);
      if (!latest || latest.token !== owner.token || processLockOwnerMayBeAlive(latest, lstatSync(file).mtimeMs)) throw new ConflictException('采购比价图片正在准备');
      unlinkSync(file);
      return openSync(file, 'wx', 0o600);
    } finally { closeSync(guard); unlinkSync(recovery); }
  }
}
