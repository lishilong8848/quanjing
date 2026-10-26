import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import COS = require('cos-nodejs-sdk-v5');
import {
  createProcessLockOwner,
  normalizeProcessLockOwner,
  processLockOwnerMayBeAlive,
  type ProcessLockOwner,
} from '../../common/process-lock-owner';

const DEFAULT_BUCKET = 'jy-1421907124';
const DEFAULT_REGION = 'ap-shanghai';
const DEFAULT_PREFIX = 'change-attachments/v1';
const DEFAULT_INDEX_FILE = 'change-attachment-cos-index.json';
const INDEX_VERSION = 1;
const MAX_RANGE_BYTES = 4 * 1024 * 1024;
const MAX_WHOLE_READ_BYTES = 20 * 1024 * 1024;
const MAX_SIGNED_URL_SECONDS = 3600;
const FILE_COPY_CHUNK_BYTES = 1024 * 1024;
const MAX_OWNER_MUTATION_ID_LENGTH = 200;
const MAX_RECORD_ID_LENGTH = 200;
const MAX_FILE_TOKEN_LENGTH = 512;
const MAX_MIME_TYPE_LENGTH = 255;
const MAX_ERROR_LENGTH = 200;
const MIN_SERVER_ACCESS_TOKEN_LENGTH = 24;
const MAX_SERVER_ACCESS_TOKEN_LENGTH = 512;
const DEFAULT_UPLOAD_CONCURRENCY = 2;
const DEFAULT_UPLOAD_QUEUE_LIMIT = 8;
const MAX_UPLOAD_CONCURRENCY = 8;
const MAX_UPLOAD_QUEUE_LIMIT = 64;
const DEFAULT_STAGED_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TEMP_SNAPSHOT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;
const MIN_MAINTENANCE_INTERVAL_MS = 10 * 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MUTATION_MAX_FILES = 5;

export const CHANGE_ATTACHMENT_MAX_BYTES = 200 * 1024 * 1024;
export const CHANGE_ATTACHMENT_MUTATION_MAX_FILES = DEFAULT_MUTATION_MAX_FILES;
export const CHANGE_ATTACHMENT_MUTATION_MAX_BYTES =
  DEFAULT_MUTATION_MAX_FILES * CHANGE_ATTACHMENT_MAX_BYTES;
export const CHANGE_ATTACHMENT_STORAGE_OPTIONS =
  'CHANGE_ATTACHMENT_STORAGE_OPTIONS';

export interface ChangeAttachmentCosClient {
  putObject(params: COS.PutObjectParams): Promise<unknown>;
  getObject(params: COS.GetObjectParams): Promise<unknown>;
  deleteObject(params: COS.DeleteObjectParams): Promise<unknown>;
  getObjectUrl(params: COS.GetObjectUrlParams): string;
}

export interface ChangeAttachmentStorageOptions {
  cos?: ChangeAttachmentCosClient | null;
  indexPath?: string;
  env?: NodeJS.ProcessEnv;
  idFactory?: () => string;
  now?: () => Date;
  serverAccessToken?: string;
}

export type ChangeAttachmentAccessContext =
  | { ownerMutationId: string; serverAccessToken?: never }
  | { serverAccessToken: string; ownerMutationId?: never };

export interface ChangeAttachmentDiskFile {
  path: string;
  name: string;
  mimetype: string;
  size: number;
}

export interface ChangeAttachmentMetadata {
  id: string;
  filePath: string;
  bucketId: string;
  url: string;
  name: string;
  size: number;
  mimeType: string;
  sha256: string;
}

export interface TrustedBoundChangeAttachmentMetadata extends ChangeAttachmentMetadata {
  boundRecordId: string;
  fileToken: string;
}

export interface TrustedSelfTestBoundChangeAttachmentMetadata extends TrustedBoundChangeAttachmentMetadata {
  ownerMutationId: string;
}

export interface TrustedSelfTestBoundChangeAttachmentExpectation {
  id: string;
  recordId: string;
  fileToken: string;
  ownerMutationId: string;
}

export type TrustedChangeAttachmentDeletionState =
  | 'present'
  | 'cleanup-pending'
  | 'absent';

type ChangeAttachmentState = 'staged' | 'bound' | 'cleanup-pending';

interface ChangeAttachmentIndexEntry extends ChangeAttachmentMetadata {
  region: string;
  ownerMutationId: string;
  state: ChangeAttachmentState;
  recordId?: string;
  fileToken?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

interface ChangeAttachmentIndexFile {
  version: 1;
  entries: Record<string, ChangeAttachmentIndexEntry>;
  journal?: Record<string, ChangeAttachmentJournalEntry>;
}

interface ChangeAttachmentJournalEntry {
  id: string;
  operation: 'upload-cleanup' | 'delete-cleanup';
  bucketId: string;
  region: string;
  filePath: string;
  createdAt: string;
  ownerMutationId?: string;
  size?: number;
}

type ChangeAttachmentIndexLockFile = ProcessLockOwner;

type ValidatedAttachmentAccess =
  | { kind: 'owner'; ownerMutationId: string }
  | { kind: 'server' };

function envValue(env: NodeJS.ProcessEnv, ...names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return '';
}

function positiveIntegerSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`变更附件配置 ${name} 无效`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`变更附件配置 ${name} 无效`);
  }
  return value;
}

function normalizePrefix(value: string): string {
  const prefix = value.replace(/^\/+|\/+$/g, '');
  const segments = prefix.split('/');
  if (
    !prefix ||
    prefix.includes('\\') ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        !/^[A-Za-z0-9._-]+$/.test(segment),
    )
  ) {
    throw new Error('变更附件存储前缀无效');
  }
  return prefix;
}

function safeFileName(value: string): string {
  const name = basename(value.replace(/\\/g, '/'))
    .replace(/[\r\n/:*?"<>|\x00-\x1f]/g, '_')
    .trim()
    .slice(0, 180);
  return name || '变更方案附件';
}

function normalizeMimeType(value: string): string {
  const mimeType = value.trim() || 'application/octet-stream';
  if (
    mimeType.length > MAX_MIME_TYPE_LENGTH ||
    /[\x00-\x1f\x7f]/.test(mimeType)
  ) {
    throw new BadRequestException('变更附件内容类型无效');
  }
  return mimeType;
}

function isBoundedTrimmedString(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

function hasOnlyKeys(value: object, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function secretsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function publicMetadata(
  entry: ChangeAttachmentIndexEntry,
): ChangeAttachmentMetadata {
  return {
    id: entry.id,
    filePath: entry.filePath,
    bucketId: entry.bucketId,
    url: entry.url,
    name: entry.name,
    size: entry.size,
    mimeType: entry.mimeType,
    sha256: entry.sha256,
  };
}

function responseBody(value: unknown): Buffer {
  const body = (value as { Body?: unknown } | null)?.Body;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  throw new ServiceUnavailableException('变更附件存储返回了无效内容');
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface StagedFileSnapshot extends FileIdentity {
  path: string;
  sha256: string;
}

function fileIdentity(value: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}): FileIdentity {
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function comparablePath(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function assertPathHasNoLinks(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new BadRequestException('变更附件源路径不能包含符号链接或重解析点');
    }
  }
  if (comparablePath(await realpath(absolute)) !== comparablePath(absolute)) {
    throw new BadRequestException('变更附件源路径不能包含符号链接或重解析点');
  }
}

async function writeFully(
  handle: FileHandle,
  buffer: Buffer,
  length: number,
): Promise<void> {
  let offset = 0;
  while (offset < length) {
    const result = await handle.write(buffer, offset, length - offset);
    if (result.bytesWritten <= 0) {
      throw new ServiceUnavailableException('变更附件暂存文件写入失败');
    }
    offset += result.bytesWritten;
  }
}

class WholeObjectLimitSink extends Writable {
  readonly chunks: Buffer[] = [];
  totalBytes = 0;
  exceeded = false;

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    if (this.totalBytes + value.length > MAX_WHOLE_READ_BYTES) {
      this.exceeded = true;
      callback(new Error('whole-object-limit-exceeded'));
      return;
    }
    this.chunks.push(Buffer.from(value));
    this.totalBytes += value.length;
    callback();
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.totalBytes);
  }
}

class BoundedUploadGate {
  private active = 0;
  private readonly waiters: Array<(release: () => void) => void> = [];
  private readonly idleWaiters: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly queueLimit: number,
  ) {}

  acquire(): Promise<() => void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }
    if (this.waiters.length >= this.queueLimit) {
      return Promise.reject(
        new ServiceUnavailableException('变更附件上传任务繁忙，请稍后重试'),
      );
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  waitForIdle(): Promise<void> {
    if (this.active === 0 && this.waiters.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next(this.createRelease());
        return;
      }
      this.active -= 1;
      if (this.active === 0) {
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
    };
  }
}

@Injectable()
export class ChangeAttachmentStorageService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ChangeAttachmentStorageService.name);
  private readonly bucket: string;
  private readonly region: string;
  private readonly prefix: string;
  private readonly indexPath: string;
  private readonly cos: ChangeAttachmentCosClient | null;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly serverAccessToken: string | null;
  private readonly stagedTtlMs: number;
  private readonly tempSnapshotTtlMs: number;
  private readonly maintenanceIntervalMs: number;
  private readonly mutationMaxFiles: number;
  private readonly mutationMaxBytes: number;
  private readonly uploadGate: BoundedUploadGate;
  private entries: Record<string, ChangeAttachmentIndexEntry> = {};
  private journal: Record<string, ChangeAttachmentJournalEntry> = {};
  private indexLoaded: Promise<void> | null = null;
  private mutationChain: Promise<void> = Promise.resolve();
  private maintenanceInFlight: Promise<void> | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private readonly activeSnapshotPaths = new Set<string>();
  private readonly activeUploadIds = new Set<string>();
  private readonly indexLockPath: string;
  private readonly indexLockToken = randomBytes(18).toString('base64url');
  private indexLockAcquired = false;

  constructor(
    @Optional()
    @Inject(CHANGE_ATTACHMENT_STORAGE_OPTIONS)
    options: ChangeAttachmentStorageOptions = {},
  ) {
    const env = options.env || process.env;
    this.bucket =
      envValue(env, 'COS_CHANGE_BUCKET', 'COS_BUCKET') || DEFAULT_BUCKET;
    this.region =
      envValue(env, 'COS_CHANGE_REGION', 'COS_REGION') || DEFAULT_REGION;
    this.prefix = normalizePrefix(
      envValue(env, 'COS_CHANGE_PREFIX') || DEFAULT_PREFIX,
    );
    this.indexPath =
      options.indexPath ||
      envValue(env, 'COS_CHANGE_INDEX_PATH') ||
      join(process.cwd(), '.runtime', DEFAULT_INDEX_FILE);
    this.indexLockPath = `${this.indexPath}.lock`;
    this.idFactory =
      options.idFactory || (() => randomBytes(18).toString('base64url'));
    this.now = options.now || (() => new Date());
    const uploadConcurrency = positiveIntegerSetting(
      env,
      'CHANGE_ATTACHMENT_UPLOAD_CONCURRENCY',
      DEFAULT_UPLOAD_CONCURRENCY,
      1,
      MAX_UPLOAD_CONCURRENCY,
    );
    const uploadQueueLimit = positiveIntegerSetting(
      env,
      'CHANGE_ATTACHMENT_UPLOAD_QUEUE_LIMIT',
      DEFAULT_UPLOAD_QUEUE_LIMIT,
      1,
      MAX_UPLOAD_QUEUE_LIMIT,
    );
    this.uploadGate = new BoundedUploadGate(
      uploadConcurrency,
      uploadQueueLimit,
    );
    this.stagedTtlMs = positiveIntegerSetting(
      env,
      'CHANGE_ATTACHMENT_STAGED_TTL_MS',
      DEFAULT_STAGED_TTL_MS,
      1_000,
      MAX_TTL_MS,
    );
    this.tempSnapshotTtlMs = positiveIntegerSetting(
      env,
      'CHANGE_ATTACHMENT_TEMP_SNAPSHOT_TTL_MS',
      DEFAULT_TEMP_SNAPSHOT_TTL_MS,
      1_000,
      MAX_TTL_MS,
    );
    this.maintenanceIntervalMs = positiveIntegerSetting(
      env,
      'CHANGE_ATTACHMENT_MAINTENANCE_INTERVAL_MS',
      DEFAULT_MAINTENANCE_INTERVAL_MS,
      MIN_MAINTENANCE_INTERVAL_MS,
      MAX_TTL_MS,
    );
    this.mutationMaxFiles = positiveIntegerSetting(
      env,
      'CHANGE_ATTACHMENT_MUTATION_MAX_FILES',
      CHANGE_ATTACHMENT_MUTATION_MAX_FILES,
      1,
      CHANGE_ATTACHMENT_MUTATION_MAX_FILES,
    );
    this.mutationMaxBytes = positiveIntegerSetting(
      env,
      'CHANGE_ATTACHMENT_MUTATION_MAX_BYTES',
      CHANGE_ATTACHMENT_MUTATION_MAX_BYTES,
      1,
      CHANGE_ATTACHMENT_MUTATION_MAX_BYTES,
    );
    const configuredServerAccessToken = Object.prototype.hasOwnProperty.call(
      options,
      'serverAccessToken',
    )
      ? typeof options.serverAccessToken === 'string'
        ? options.serverAccessToken.trim()
        : ''
      : envValue(env, 'CHANGE_ATTACHMENT_SERVER_ACCESS_TOKEN');
    if (
      configuredServerAccessToken &&
      (configuredServerAccessToken.length < MIN_SERVER_ACCESS_TOKEN_LENGTH ||
        configuredServerAccessToken.length > MAX_SERVER_ACCESS_TOKEN_LENGTH)
    ) {
      throw new Error('变更附件服务端访问令牌配置无效');
    }
    this.serverAccessToken = configuredServerAccessToken || null;

    if (Object.prototype.hasOwnProperty.call(options, 'cos')) {
      this.cos = options.cos || null;
      return;
    }
    const secretId = envValue(env, 'COS_SECRET_ID', 'TENCENTCLOUD_SECRET_ID');
    const secretKey = envValue(
      env,
      'COS_SECRET_KEY',
      'TENCENTCLOUD_SECRET_KEY',
    );
    const securityToken = envValue(
      env,
      'COS_SESSION_TOKEN',
      'TENCENTCLOUD_SESSION_TOKEN',
    );
    this.cos =
      secretId && secretKey
        ? new COS({
            SecretId: secretId,
            SecretKey: secretKey,
            SecurityToken: securityToken || undefined,
            FileParallelLimit: 1,
            ChunkParallelLimit: 3,
            ChunkSize: MAX_RANGE_BYTES,
            SliceSize: MAX_RANGE_BYTES,
            Timeout: 60_000,
          })
        : null;
  }

  async onModuleInit(): Promise<void> {
    await this.ensureIndexLoaded();
    await this.runMaintenanceSweep();
    this.startMaintenanceTimer();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    await this.uploadGate.waitForIdle();
    await this.maintenanceInFlight?.catch(() => undefined);
    await this.mutationChain.catch(() => undefined);
    await this.releaseIndexLock();
  }

  async stageFromDisk(
    file: ChangeAttachmentDiskFile,
    ownerMutationId: string,
  ): Promise<ChangeAttachmentMetadata> {
    await this.ensureIndexLoaded();
    const cos = this.requireCos();
    const mutationId =
      typeof ownerMutationId === 'string' ? ownerMutationId.trim() : '';
    if (!isBoundedTrimmedString(mutationId, MAX_OWNER_MUTATION_ID_LENGTH)) {
      throw new BadRequestException('变更附件请求标识无效');
    }
    const mimeType = normalizeMimeType(file.mimetype || '');
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new BadRequestException('变更附件不能为空');
    }
    if (file.size > CHANGE_ATTACHMENT_MAX_BYTES) {
      throw new BadRequestException('单个变更方案附件不能超过 200MB');
    }
    const releaseUploadSlot = await this.uploadGate.acquire();
    let snapshot: StagedFileSnapshot | null = null;
    let activeUploadId = '';
    try {
      snapshot = await this.createStagedSnapshot(file);
      const uploadIntent = await this.runMutation(async () => {
        this.assertMutationQuota(mutationId, snapshot!.size);
        const id = this.createUniqueId();
        const name = safeFileName(file.name);
        const filePath = `${this.prefix}/${id}/${name}`;
        this.assertSafeFilePath(filePath);
        const timestamp = this.now().toISOString();
        const entry: ChangeAttachmentIndexEntry = {
          id,
          filePath,
          bucketId: this.bucket,
          region: this.region,
          url: `/api/duty-schedules/change-attachments/${encodeURIComponent(id)}/download`,
          name,
          size: snapshot.size,
          mimeType,
          sha256: snapshot.sha256,
          ownerMutationId: mutationId,
          state: 'staged',
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const journalEntry: ChangeAttachmentJournalEntry = {
          id,
          operation: 'upload-cleanup',
          bucketId: this.bucket,
          region: this.region,
          filePath,
          createdAt: timestamp,
          ownerMutationId: mutationId,
          size: snapshot!.size,
        };
        this.activeUploadIds.add(id);
        try {
          await this.commitEntries(this.entries, {
            ...this.journal,
            [id]: journalEntry,
          });
        } catch (error) {
          this.activeUploadIds.delete(id);
          throw error;
        }
        return { entry, journalEntry };
      });
      activeUploadId = uploadIntent.entry.id;
      let uploadAttempted = false;
      try {
        uploadAttempted = true;
        const uploadHeaders = {
          Bucket: this.bucket,
          Region: this.region,
          Key: uploadIntent.entry.filePath,
          CacheControl: 'private, no-store',
          ContentType: mimeType,
          ContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(uploadIntent.entry.name)}`,
          'x-cos-meta-sha256': snapshot.sha256,
        };
        const body = createReadStream(snapshot.path);
        try {
          await this.executeCosOperation(() =>
            cos.putObject({
              ...uploadHeaders,
              Body: body,
              ContentLength: snapshot.size,
            }),
          );
        } finally {
          body.destroy();
          await finished(body).catch(() => undefined);
        }
        const uploadedSnapshot = fileIdentity(await stat(snapshot.path));
        if (uploadedSnapshot.size > CHANGE_ATTACHMENT_MAX_BYTES) {
          throw new BadRequestException('单个变更方案附件不能超过 200MB');
        }
        if (!sameFileIdentity(snapshot, uploadedSnapshot)) {
          throw new BadRequestException('变更附件暂存文件在上传期间发生变化');
        }

        await this.runMutation(async () => {
          const persistedIntent = this.journal[uploadIntent.entry.id];
          if (
            !persistedIntent ||
            persistedIntent.operation !== 'upload-cleanup' ||
            persistedIntent.filePath !== uploadIntent.entry.filePath
          ) {
            throw new ServiceUnavailableException(
              '变更附件上传状态已失效，请重新上传',
            );
          }
          const settledJournal = { ...this.journal };
          delete settledJournal[uploadIntent.entry.id];
          await this.commitEntries(
            { ...this.entries, [uploadIntent.entry.id]: uploadIntent.entry },
            settledJournal,
          );
        });
        return publicMetadata(uploadIntent.entry);
      } catch (error) {
        if (uploadAttempted) {
          try {
            await this.executeCosOperation(() =>
              cos.deleteObject({
                Bucket: this.bucket,
                Region: this.region,
                Key: uploadIntent.entry.filePath,
              }),
            );
            await this.runMutation(async () => {
              const currentIntent = this.journal[uploadIntent.entry.id];
              if (
                currentIntent?.operation !== 'upload-cleanup' ||
                currentIntent.filePath !== uploadIntent.entry.filePath
              ) {
                return;
              }
              const settledJournal = { ...this.journal };
              delete settledJournal[uploadIntent.entry.id];
              await this.commitEntries(this.entries, settledJournal);
            });
          } catch {
            this.logger.warn(
              `变更附件 ${uploadIntent.entry.id} 上传失败后对象回收未完成`,
            );
          }
        }
        throw error;
      }
    } finally {
      if (activeUploadId) this.activeUploadIds.delete(activeUploadId);
      if (snapshot) {
        this.activeSnapshotPaths.delete(comparablePath(snapshot.path));
        await rm(snapshot.path, { force: true });
      }
      releaseUploadSlot();
    }
  }

  async resolveOwned(
    id: string,
    ownerMutationId: string,
  ): Promise<ChangeAttachmentMetadata> {
    const normalizedOwnerMutationId =
      typeof ownerMutationId === 'string' ? ownerMutationId.trim() : '';
    if (
      !isBoundedTrimmedString(
        normalizedOwnerMutationId,
        MAX_OWNER_MUTATION_ID_LENGTH,
      )
    ) {
      throw new BadRequestException('变更附件请求标识无效');
    }
    const entry = await this.getEntry(id);
    if (entry.state === 'cleanup-pending') {
      throw new NotFoundException('变更附件不存在或正在清理');
    }
    if (entry.ownerMutationId !== normalizedOwnerMutationId) {
      throw new BadRequestException('变更附件不属于当前请求');
    }
    return publicMetadata(entry);
  }

  async bindToRecord(
    id: string,
    recordId: string,
    fileToken: string,
    accessContext: ChangeAttachmentAccessContext,
  ): Promise<ChangeAttachmentMetadata> {
    return this.runMutation(async () => {
      const entry = await this.getEntry(id);
      this.assertEntryAccess(entry, accessContext);
      const normalizedRecordId =
        typeof recordId === 'string' ? recordId.trim() : '';
      const normalizedFileToken =
        typeof fileToken === 'string' ? fileToken.trim() : '';
      if (
        !isBoundedTrimmedString(normalizedRecordId, MAX_RECORD_ID_LENGTH) ||
        !isBoundedTrimmedString(normalizedFileToken, MAX_FILE_TOKEN_LENGTH)
      ) {
        throw new BadRequestException('变更附件绑定信息不完整');
      }
      if (entry.state === 'cleanup-pending') {
        throw new BadRequestException('变更附件正在清理，不能绑定');
      }
      if (
        entry.state === 'bound' &&
        (entry.recordId !== normalizedRecordId ||
          entry.fileToken !== normalizedFileToken)
      ) {
        throw new BadRequestException('变更附件已绑定到其他记录');
      }
      const tokenOwner = Object.values(this.entries).find(
        (candidate) =>
          candidate.id !== entry.id &&
          candidate.fileToken === normalizedFileToken,
      );
      if (tokenOwner) {
        throw new BadRequestException('变更附件文件令牌已被其他附件使用');
      }
      const updatedEntry: ChangeAttachmentIndexEntry = {
        ...entry,
        state: 'bound',
        recordId: normalizedRecordId,
        fileToken: normalizedFileToken,
        updatedAt: this.now().toISOString(),
        lastError: undefined,
      };
      await this.commitEntries({ ...this.entries, [entry.id]: updatedEntry });
      return publicMetadata(updatedEntry);
    });
  }

  async listByRecord(
    recordId: string,
    accessContext: ChangeAttachmentAccessContext,
  ): Promise<ChangeAttachmentMetadata[]> {
    await this.ensureIndexLoaded();
    const access = this.validateAccessContext(accessContext);
    const normalized = typeof recordId === 'string' ? recordId.trim() : '';
    if (!normalized) return [];
    if (!isBoundedTrimmedString(normalized, MAX_RECORD_ID_LENGTH)) {
      throw new BadRequestException('变更附件记录标识无效');
    }
    const matchingEntries = Object.values(this.entries).filter(
      (entry) => entry.state === 'bound' && entry.recordId === normalized,
    );
    const visibleEntries =
      access.kind === 'server'
        ? matchingEntries
        : matchingEntries.filter(
            (entry) => entry.ownerMutationId === access.ownerMutationId,
          );
    if (matchingEntries.length > 0 && visibleEntries.length === 0) {
      throw new ForbiddenException('变更附件访问凭据无效');
    }
    return visibleEntries
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(publicMetadata);
  }

  async findByFileToken(
    fileToken: string,
    accessContext: ChangeAttachmentAccessContext,
  ): Promise<ChangeAttachmentMetadata | null> {
    await this.ensureIndexLoaded();
    return this.findByFileTokenWithAccess(
      fileToken,
      this.validateAccessContext(accessContext),
    );
  }

  async findByFileTokenForTrustedServer(
    fileToken: string,
  ): Promise<TrustedBoundChangeAttachmentMetadata | null> {
    await this.ensureIndexLoaded();
    const normalized = typeof fileToken === 'string' ? fileToken.trim() : '';
    if (!normalized) return null;
    if (!isBoundedTrimmedString(normalized, MAX_FILE_TOKEN_LENGTH)) {
      throw new BadRequestException('变更附件文件令牌无效');
    }
    const entry = Object.values(this.entries).find(
      (candidate) =>
        candidate.state === 'bound' && candidate.fileToken === normalized,
    );
    if (!entry?.recordId || !entry.fileToken) return null;
    return {
      ...publicMetadata(entry),
      boundRecordId: entry.recordId,
      fileToken: entry.fileToken,
    };
  }

  async findBoundByIdForTrustedServer(
    id: string,
  ): Promise<TrustedSelfTestBoundChangeAttachmentMetadata | null> {
    await this.ensureIndexLoaded();
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    const entry = Object.prototype.hasOwnProperty.call(
      this.entries,
      normalizedId,
    )
      ? this.entries[normalizedId]
      : undefined;
    if (!entry) {
      return null;
    }
    if (entry.state === 'cleanup-pending') {
      this.assertCleanupPendingJournal(entry);
    }
    if (
      (entry.state !== 'bound' && entry.state !== 'cleanup-pending') ||
      !entry.recordId ||
      !entry.fileToken
    ) {
      return null;
    }
    return {
      ...publicMetadata(entry),
      boundRecordId: entry.recordId,
      fileToken: entry.fileToken,
      ownerMutationId: entry.ownerMutationId,
    };
  }

  async findBoundByIdForTrustedSelfTest(
    id: string,
  ): Promise<TrustedSelfTestBoundChangeAttachmentMetadata | null> {
    return this.findBoundByIdForTrustedServer(id);
  }

  async getDeletionStateForTrustedServer(
    id: string,
  ): Promise<TrustedChangeAttachmentDeletionState> {
    await this.ensureIndexLoaded();
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    if (!/^[A-Za-z0-9_-]{12,80}$/.test(normalizedId)) {
      throw new BadRequestException('变更附件标识无效');
    }
    const entry = Object.prototype.hasOwnProperty.call(
      this.entries,
      normalizedId,
    )
      ? this.entries[normalizedId]
      : undefined;
    if (!entry) return 'absent';
    if (entry.state === 'cleanup-pending') {
      this.assertCleanupPendingJournal(entry);
      return 'cleanup-pending';
    }
    return 'present';
  }

  private findByFileTokenWithAccess(
    fileToken: string,
    access: ValidatedAttachmentAccess,
  ): ChangeAttachmentMetadata | null {
    const normalized = typeof fileToken === 'string' ? fileToken.trim() : '';
    if (!normalized) return null;
    if (!isBoundedTrimmedString(normalized, MAX_FILE_TOKEN_LENGTH)) {
      throw new BadRequestException('变更附件文件令牌无效');
    }
    const entry = Object.values(this.entries).find(
      (candidate) =>
        candidate.state === 'bound' && candidate.fileToken === normalized,
    );
    if (
      entry &&
      access.kind === 'owner' &&
      entry.ownerMutationId !== access.ownerMutationId
    ) {
      throw new ForbiddenException('变更附件访问凭据无效');
    }
    return entry ? publicMetadata(entry) : null;
  }

  async readRange(
    id: string,
    start: number,
    end: number,
    accessContext: ChangeAttachmentAccessContext,
  ): Promise<Buffer> {
    const entry = await this.getReadableEntry(id, accessContext);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start
    ) {
      throw new BadRequestException('变更附件读取范围无效');
    }
    const requestedBytes = end - start + 1;
    if (requestedBytes > MAX_RANGE_BYTES) {
      throw new BadRequestException('变更附件单次读取不能超过 4MB');
    }
    if (end >= entry.size) {
      throw new BadRequestException('变更附件读取范围无效');
    }
    const result = await this.executeCosOperation(() =>
      this.requireCos().getObject({
        Bucket: entry.bucketId,
        Region: entry.region,
        Key: entry.filePath,
        Range: `bytes=${start}-${end}`,
      }),
    );
    const body = responseBody(result);
    if (body.length !== requestedBytes || body.length > MAX_RANGE_BYTES) {
      throw new ServiceUnavailableException('变更附件分段读取结果不完整');
    }
    return body;
  }

  async readAll(
    id: string,
    accessContext: ChangeAttachmentAccessContext,
  ): Promise<Buffer> {
    const entry = await this.getReadableEntry(id, accessContext);
    if (entry.size > MAX_WHOLE_READ_BYTES) {
      throw new BadRequestException('超过 20MB 的变更附件必须分段读取');
    }
    const sink = new WholeObjectLimitSink();
    try {
      await this.requireCos().getObject({
        Bucket: entry.bucketId,
        Region: entry.region,
        Key: entry.filePath,
        Output: sink,
      });
    } catch {
      if (sink.exceeded) {
        throw new BadRequestException('超过 20MB 的变更附件必须分段读取');
      }
      throw new ServiceUnavailableException('变更附件对象存储操作失败');
    }
    const body = sink.toBuffer();
    if (body.length !== entry.size) {
      throw new ServiceUnavailableException('变更附件整体读取结果不完整');
    }
    return body;
  }

  async getSignedDownloadUrl(
    id: string,
    expiresSeconds: number,
    accessContext: ChangeAttachmentAccessContext,
  ): Promise<string> {
    const entry = await this.getReadableEntry(id, accessContext);
    return this.createSignedDownloadUrl(entry, expiresSeconds);
  }

  async getSignedDownloadUrlForTrustedServer(
    id: string,
    expiresSeconds: number,
  ): Promise<string> {
    const entry = await this.getEntry(id);
    if (entry.state === 'cleanup-pending') {
      throw new NotFoundException('变更附件不存在或正在清理');
    }
    this.assertSafeFilePath(entry.filePath);
    return this.createSignedDownloadUrl(entry, expiresSeconds);
  }

  private createSignedDownloadUrl(
    entry: ChangeAttachmentIndexEntry,
    expiresSeconds: number,
  ): string {
    if (
      !Number.isInteger(expiresSeconds) ||
      expiresSeconds < 1 ||
      expiresSeconds > MAX_SIGNED_URL_SECONDS
    ) {
      throw new BadRequestException('变更附件下载链接有效期无效');
    }
    try {
      return this.requireCos().getObjectUrl({
        Bucket: entry.bucketId,
        Region: entry.region,
        Key: entry.filePath,
        Sign: true,
        Method: 'GET',
        Expires: expiresSeconds,
      });
    } catch {
      throw new ServiceUnavailableException('变更附件对象存储操作失败');
    }
  }

  async delete(
    id: string,
    accessContext: ChangeAttachmentAccessContext,
  ): Promise<boolean> {
    return this.deleteWithAccess(id, this.validateAccessContext(accessContext));
  }

  async deleteForTrustedServer(id: string): Promise<boolean> {
    return this.deleteWithAccess(id, { kind: 'server' });
  }

  async deleteBoundForTrustedServer(
    expectation: TrustedSelfTestBoundChangeAttachmentExpectation,
  ): Promise<boolean> {
    return this.deleteWithAccess(
      expectation?.id,
      { kind: 'server' },
      undefined,
      expectation,
    );
  }

  async deleteBoundForTrustedSelfTest(
    expectation: TrustedSelfTestBoundChangeAttachmentExpectation,
  ): Promise<boolean> {
    return this.deleteBoundForTrustedServer(expectation);
  }

  private deleteWithAccess(
    id: string,
    access: ValidatedAttachmentAccess,
    stagedCreatedAtOrBefore?: number,
    expectedBinding?: TrustedSelfTestBoundChangeAttachmentExpectation,
  ): Promise<boolean> {
    return this.runMutation(async () => {
      const normalizedId = typeof id === 'string' ? id.trim() : '';
      const entry = Object.prototype.hasOwnProperty.call(
        this.entries,
        normalizedId,
      )
        ? this.entries[normalizedId]
        : undefined;
      if (!entry) return false;
      this.assertValidatedEntryAccess(entry, access);
      const cleanupPending = entry.state === 'cleanup-pending';
      if (cleanupPending) {
        this.assertCleanupPendingJournal(entry);
      }
      if (
        expectedBinding &&
        ((entry.state !== 'bound' && entry.state !== 'cleanup-pending') ||
          entry.id !== String(expectedBinding.id || '').trim() ||
          entry.recordId !== String(expectedBinding.recordId || '').trim() ||
          entry.fileToken !== String(expectedBinding.fileToken || '').trim() ||
          entry.ownerMutationId !==
            String(expectedBinding.ownerMutationId || '').trim())
      ) {
        throw new ConflictException('自测附件绑定关系不一致，拒绝删除');
      }
      if (
        stagedCreatedAtOrBefore !== undefined &&
        (entry.state !== 'staged' ||
          Date.parse(entry.createdAt) > stagedCreatedAtOrBefore)
      ) {
        return false;
      }
      if (access.kind === 'owner' && entry.state !== 'staged') {
        throw new ForbiddenException('已绑定附件只能由服务端删除');
      }
      this.assertSafeFilePath(entry.filePath);
      if (!cleanupPending) {
        const timestamp = this.now().toISOString();
        const pendingEntry: ChangeAttachmentIndexEntry = {
          ...entry,
          state: 'cleanup-pending',
          updatedAt: timestamp,
          lastError: '对象删除等待执行',
        };
        const journalEntry: ChangeAttachmentJournalEntry = {
          id: entry.id,
          operation: 'delete-cleanup',
          bucketId: entry.bucketId,
          region: entry.region,
          filePath: entry.filePath,
          createdAt: timestamp,
        };
        await this.commitEntries(
          { ...this.entries, [entry.id]: pendingEntry },
          { ...this.journal, [entry.id]: journalEntry },
        );
      }
      try {
        await this.executeCosDelete({
          Bucket: entry.bucketId,
          Region: entry.region,
          Key: entry.filePath,
        });
      } catch {
        throw new ServiceUnavailableException(
          '变更附件删除失败，已安排后台清理',
        );
      }
      const nextEntries = { ...this.entries };
      const nextJournal = { ...this.journal };
      delete nextEntries[entry.id];
      delete nextJournal[entry.id];
      await this.commitEntries(nextEntries, nextJournal);
      return true;
    });
  }

  async cleanup(
    id: string,
    accessContext: ChangeAttachmentAccessContext,
  ): Promise<boolean> {
    return this.delete(id, accessContext);
  }

  private recoverPendingCleanup(id: string): Promise<void> {
    return this.runMutation(async () => {
      const journalEntry = this.journal[id];
      const indexedEntry = this.entries[id];
      if (!journalEntry && indexedEntry?.state !== 'cleanup-pending') return;
      const target =
        journalEntry ||
        (indexedEntry
          ? {
              id: indexedEntry.id,
              operation: 'delete-cleanup' as const,
              bucketId: indexedEntry.bucketId,
              region: indexedEntry.region,
              filePath: indexedEntry.filePath,
              createdAt: indexedEntry.updatedAt,
            }
          : null);
      if (!target) return;
      this.assertSafeFilePath(target.filePath);
      try {
        await this.executeCosDelete({
          Bucket: target.bucketId,
          Region: target.region,
          Key: target.filePath,
        });
      } catch {
        throw new ServiceUnavailableException('变更附件后台清理暂未完成');
      }
      const nextEntries = { ...this.entries };
      const nextJournal = { ...this.journal };
      delete nextEntries[id];
      delete nextJournal[id];
      await this.commitEntries(nextEntries, nextJournal);
    });
  }

  private startMaintenanceTimer(): void {
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(() => {
      void this.runMaintenanceSweep().catch(() => {
        this.logger.warn('变更附件定时清理暂未完成，稍后将自动重试');
      });
    }, this.maintenanceIntervalMs);
    this.maintenanceTimer.unref?.();
  }

  private async runMaintenanceSweep(): Promise<void> {
    if (this.maintenanceInFlight) {
      await this.maintenanceInFlight;
      return;
    }
    const operation = this.performMaintenanceSweep();
    this.maintenanceInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.maintenanceInFlight === operation) {
        this.maintenanceInFlight = null;
      }
    }
  }

  private async performMaintenanceSweep(): Promise<void> {
    await this.cleanupOwnedStagingSnapshots();
    const pendingIds = new Set([
      ...Object.keys(this.journal),
      ...Object.values(this.entries)
        .filter((entry) => entry.state === 'cleanup-pending')
        .map((entry) => entry.id),
    ]);
    for (const id of pendingIds) {
      if (this.activeUploadIds.has(id)) continue;
      try {
        await this.recoverPendingCleanup(id);
      } catch {
        this.logger.warn(`变更附件 ${id} 后台清理未完成，已保留待重试状态`);
      }
    }
    await this.reclaimExpiredStagedObjects();
  }

  private async reclaimExpiredStagedObjects(): Promise<void> {
    const cutoff = this.now().getTime() - this.stagedTtlMs;
    const expiredIds = Object.values(this.entries)
      .filter(
        (entry) =>
          entry.state === 'staged' &&
          !this.activeUploadIds.has(entry.id) &&
          Date.parse(entry.createdAt) <= cutoff,
      )
      .map((entry) => entry.id);
    for (const id of expiredIds) {
      try {
        await this.deleteWithAccess(id, { kind: 'server' }, cutoff);
      } catch {
        this.logger.warn(`过期变更附件 ${id} 回收未完成，稍后将自动重试`);
      }
    }
  }

  private async cleanupOwnedStagingSnapshots(): Promise<void> {
    const stagingDirectory = join(
      dirname(this.indexPath),
      '.change-attachment-staging',
    );
    let names: string[];
    try {
      names = await readdir(stagingDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const cutoff = this.now().getTime() - this.tempSnapshotTtlMs;
    for (const name of names) {
      if (!/^stage-\d+-[a-f0-9]{36}$/.test(name)) continue;
      const snapshotPath = join(stagingDirectory, name);
      if (this.activeSnapshotPaths.has(comparablePath(snapshotPath))) continue;
      try {
        const metadata = await lstat(snapshotPath);
        if (metadata.mtimeMs > cutoff) continue;
        if (!metadata.isFile() && !metadata.isSymbolicLink()) continue;
        await rm(snapshotPath, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  private async getReadableEntry(
    id: string,
    accessContext: ChangeAttachmentAccessContext,
  ): Promise<ChangeAttachmentIndexEntry> {
    const entry = await this.getEntry(id);
    if (entry.state === 'cleanup-pending') {
      throw new NotFoundException('变更附件不存在或正在清理');
    }
    this.assertEntryAccess(entry, accessContext);
    this.assertSafeFilePath(entry.filePath);
    return entry;
  }

  private async getEntry(id: string): Promise<ChangeAttachmentIndexEntry> {
    await this.ensureIndexLoaded();
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    const entry = Object.prototype.hasOwnProperty.call(
      this.entries,
      normalizedId,
    )
      ? this.entries[normalizedId]
      : undefined;
    if (!entry) throw new NotFoundException('变更附件不存在');
    return entry;
  }

  private requireCos(): ChangeAttachmentCosClient {
    if (!this.cos) {
      throw new ServiceUnavailableException('变更附件对象存储未配置');
    }
    return this.cos;
  }

  private async executeCosOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new ServiceUnavailableException('变更附件对象存储操作失败');
    }
  }

  private async executeCosDelete(
    params: COS.DeleteObjectParams,
  ): Promise<void> {
    try {
      await this.requireCos().deleteObject(params);
    } catch (error) {
      const candidate =
        error && typeof error === 'object'
          ? (error as { code?: unknown; Code?: unknown })
          : null;
      const code = String(candidate?.code || candidate?.Code || '').trim();
      if (code === 'NoSuchKey') return;
      throw new ServiceUnavailableException('变更附件对象存储操作失败');
    }
  }

  private assertCleanupPendingJournal(
    entry: ChangeAttachmentIndexEntry,
  ): ChangeAttachmentJournalEntry {
    const journal = this.journal[entry.id];
    if (
      entry.state !== 'cleanup-pending' ||
      !journal ||
      journal.id !== entry.id ||
      journal.operation !== 'delete-cleanup' ||
      journal.bucketId !== entry.bucketId ||
      journal.region !== entry.region ||
      journal.filePath !== entry.filePath
    ) {
      throw new ConflictException('变更附件待清理状态不一致，拒绝继续');
    }
    return journal;
  }

  private validateAccessContext(
    context: ChangeAttachmentAccessContext,
  ): ValidatedAttachmentAccess {
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      throw new ForbiddenException('变更附件访问凭据无效');
    }
    const keys = Object.keys(context);
    if (
      keys.length === 1 &&
      keys[0] === 'ownerMutationId' &&
      isBoundedTrimmedString(
        context.ownerMutationId,
        MAX_OWNER_MUTATION_ID_LENGTH,
      )
    ) {
      return { kind: 'owner', ownerMutationId: context.ownerMutationId };
    }
    if (
      keys.length === 1 &&
      keys[0] === 'serverAccessToken' &&
      typeof context.serverAccessToken === 'string' &&
      context.serverAccessToken.length >= MIN_SERVER_ACCESS_TOKEN_LENGTH &&
      context.serverAccessToken.length <= MAX_SERVER_ACCESS_TOKEN_LENGTH &&
      this.serverAccessToken &&
      secretsEqual(context.serverAccessToken, this.serverAccessToken)
    ) {
      return { kind: 'server' };
    }
    throw new ForbiddenException('变更附件访问凭据无效');
  }

  private assertEntryAccess(
    entry: ChangeAttachmentIndexEntry,
    context: ChangeAttachmentAccessContext,
  ): void {
    this.assertValidatedEntryAccess(entry, this.validateAccessContext(context));
  }

  private assertValidatedEntryAccess(
    entry: ChangeAttachmentIndexEntry,
    access: ValidatedAttachmentAccess,
  ): void {
    if (
      access.kind === 'owner' &&
      access.ownerMutationId !== entry.ownerMutationId
    ) {
      throw new ForbiddenException('变更附件访问凭据无效');
    }
  }

  private async createStagedSnapshot(
    file: ChangeAttachmentDiskFile,
  ): Promise<StagedFileSnapshot> {
    await assertPathHasNoLinks(file.path);
    const sourcePathMetadata = await lstat(file.path);
    if (!sourcePathMetadata.isFile() || sourcePathMetadata.isSymbolicLink()) {
      throw new BadRequestException('变更附件不是有效文件');
    }

    const source = await open(file.path, 'r');
    const stagingDirectory = join(
      dirname(this.indexPath),
      '.change-attachment-staging',
    );
    const stagingPath = join(
      stagingDirectory,
      `stage-${process.pid}-${randomBytes(18).toString('hex')}`,
    );
    const comparableStagingPath = comparablePath(stagingPath);
    this.activeSnapshotPaths.add(comparableStagingPath);
    let destination: FileHandle | null = null;
    try {
      const sourceBefore = fileIdentity(await source.stat());
      if (!sameFileIdentity(sourceBefore, fileIdentity(sourcePathMetadata))) {
        throw new BadRequestException('变更附件源文件在校验期间发生变化');
      }
      if (sourceBefore.size <= 0) {
        throw new BadRequestException('变更附件不能为空');
      }
      if (sourceBefore.size > CHANGE_ATTACHMENT_MAX_BYTES) {
        throw new BadRequestException('单个变更方案附件不能超过 200MB');
      }
      if (sourceBefore.size !== file.size) {
        throw new BadRequestException('变更附件声明大小与实际大小不一致');
      }

      await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
      await chmod(stagingDirectory, 0o700);
      destination = await open(stagingPath, 'wx', 0o600);
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(FILE_COPY_CHUNK_BYTES);
      let copiedBytes = 0;
      while (true) {
        const { bytesRead } = await source.read(
          buffer,
          0,
          buffer.length,
          copiedBytes,
        );
        if (bytesRead === 0) break;
        copiedBytes += bytesRead;
        if (copiedBytes > CHANGE_ATTACHMENT_MAX_BYTES) {
          throw new BadRequestException('单个变更方案附件不能超过 200MB');
        }
        hash.update(buffer.subarray(0, bytesRead));
        await writeFully(destination, buffer, bytesRead);
      }

      const sourceAfter = fileIdentity(await source.stat());
      await assertPathHasNoLinks(file.path);
      const sourcePathAfter = await lstat(file.path);
      if (
        !sameFileIdentity(sourceBefore, sourceAfter) ||
        !sameFileIdentity(sourceAfter, fileIdentity(sourcePathAfter)) ||
        copiedBytes !== sourceBefore.size ||
        copiedBytes !== file.size
      ) {
        throw new BadRequestException('变更附件源文件在暂存期间发生变化');
      }
      await destination.sync();
      await destination.close();
      destination = null;
      await chmod(stagingPath, 0o400);
      const stagedIdentity = fileIdentity(await stat(stagingPath));
      if (stagedIdentity.size !== copiedBytes) {
        throw new ServiceUnavailableException('变更附件暂存文件不完整');
      }
      return {
        ...stagedIdentity,
        path: stagingPath,
        sha256: hash.digest('hex'),
      };
    } catch (error) {
      this.activeSnapshotPaths.delete(comparableStagingPath);
      await destination?.close().catch(() => undefined);
      await rm(stagingPath, { force: true });
      throw error;
    } finally {
      await source.close();
    }
  }

  private assertMutationQuota(ownerMutationId: string, size: number): void {
    const ownedEntries = Object.values(this.entries).filter(
      (entry) => entry.ownerMutationId === ownerMutationId,
    );
    const ownedUploadIntents = Object.values(this.journal).filter(
      (entry) =>
        entry.operation === 'upload-cleanup' &&
        entry.ownerMutationId === ownerMutationId &&
        Number.isSafeInteger(entry.size),
    );
    if (
      ownedEntries.length + ownedUploadIntents.length >=
      this.mutationMaxFiles
    ) {
      throw new BadRequestException(
        `同一次变更申请最多暂存 ${this.mutationMaxFiles} 个附件`,
      );
    }
    const usedBytes = [...ownedEntries, ...ownedUploadIntents].reduce(
      (total, entry) => total + Number(entry.size || 0),
      0,
    );
    if (usedBytes > this.mutationMaxBytes - size) {
      throw new BadRequestException('同一次变更申请的附件总量超过限制');
    }
  }

  private createUniqueId(): string {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = this.idFactory();
      if (
        /^[A-Za-z0-9_-]{12,80}$/.test(id) &&
        !Object.prototype.hasOwnProperty.call(this.entries, id) &&
        !Object.prototype.hasOwnProperty.call(this.journal, id)
      )
        return id;
    }
    throw new ServiceUnavailableException('无法生成变更附件存储标识');
  }

  private assertSafeFilePath(filePath: string): void {
    const prefix = `${this.prefix}/`;
    if (
      !filePath.startsWith(prefix) ||
      filePath.includes('\\') ||
      filePath.includes('\0') ||
      filePath
        .split('/')
        .some((segment) => segment === '.' || segment === '..' || !segment)
    ) {
      throw new BadRequestException('变更附件索引内容不安全');
    }
  }

  private async ensureIndexLoaded(): Promise<void> {
    if (!this.indexLoaded) this.indexLoaded = this.initializeIndex();
    await this.indexLoaded;
  }

  private async initializeIndex(): Promise<void> {
    await this.acquireIndexLock();
    try {
      await this.loadIndex();
    } catch (error) {
      await this.releaseIndexLock();
      throw error;
    }
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(async () => {
      await this.ensureIndexLoaded();
      return operation();
    });
    this.mutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async loadIndex(): Promise<void> {
    let source: string;
    try {
      source = await readFile(this.indexPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries = {};
        this.journal = {};
        return;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new Error('变更附件索引损坏，已拒绝启动');
    }
    if (!this.isValidIndex(parsed)) {
      throw new Error('变更附件索引内容不安全，已拒绝启动');
    }
    this.entries = parsed.entries;
    this.journal = parsed.journal || {};
  }

  private isValidIndex(value: unknown): value is ChangeAttachmentIndexFile {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false;
    if (!hasOnlyKeys(value, ['version', 'entries', 'journal'])) return false;
    const index = value as Partial<ChangeAttachmentIndexFile>;
    if (
      index.version !== INDEX_VERSION ||
      !index.entries ||
      typeof index.entries !== 'object' ||
      Array.isArray(index.entries) ||
      (index.journal !== undefined &&
        (!index.journal ||
          typeof index.journal !== 'object' ||
          Array.isArray(index.journal)))
    ) {
      return false;
    }
    const entries = index.entries as Record<string, unknown>;
    const journal = (index.journal || {}) as Record<string, unknown>;
    const fileTokens = new Set<string>();
    for (const [id, candidate] of Object.entries(entries)) {
      if (!this.isValidEntry(id, candidate)) return false;
      const entry = candidate as ChangeAttachmentIndexEntry;
      if (entry.fileToken) {
        if (fileTokens.has(entry.fileToken)) return false;
        fileTokens.add(entry.fileToken);
      }
    }
    for (const [id, candidate] of Object.entries(journal)) {
      if (!this.isValidJournalEntry(id, candidate)) return false;
      const journalEntry = candidate as ChangeAttachmentJournalEntry;
      const indexedEntry = entries[id] as
        | ChangeAttachmentIndexEntry
        | undefined;
      if (journalEntry.operation === 'upload-cleanup' && indexedEntry) {
        return false;
      }
      if (
        journalEntry.operation === 'delete-cleanup' &&
        (!indexedEntry ||
          indexedEntry.state !== 'cleanup-pending' ||
          indexedEntry.bucketId !== journalEntry.bucketId ||
          indexedEntry.region !== journalEntry.region ||
          indexedEntry.filePath !== journalEntry.filePath)
      ) {
        return false;
      }
    }
    return true;
  }

  private isValidJournalEntry(id: string, value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false;
    if (
      !hasOnlyKeys(value, [
        'id',
        'operation',
        'bucketId',
        'region',
        'filePath',
        'createdAt',
        'ownerMutationId',
        'size',
      ])
    ) {
      return false;
    }
    const entry = value as Partial<ChangeAttachmentJournalEntry>;
    const hasOwnerMutationId = Object.prototype.hasOwnProperty.call(
      value,
      'ownerMutationId',
    );
    const hasSize = Object.prototype.hasOwnProperty.call(value, 'size');
    const uploadIntentMetadataValid =
      hasOwnerMutationId === hasSize &&
      (!hasOwnerMutationId ||
        (isBoundedTrimmedString(
          entry.ownerMutationId,
          MAX_OWNER_MUTATION_ID_LENGTH,
        ) &&
          Number.isSafeInteger(entry.size) &&
          Number(entry.size) > 0 &&
          Number(entry.size) <= CHANGE_ATTACHMENT_MAX_BYTES));
    return (
      id === entry.id &&
      /^[A-Za-z0-9_-]{12,80}$/.test(id) &&
      (entry.operation === 'upload-cleanup' ||
        entry.operation === 'delete-cleanup') &&
      entry.bucketId === this.bucket &&
      entry.region === this.region &&
      typeof entry.filePath === 'string' &&
      this.isCanonicalObjectPath(id, entry.filePath) &&
      isCanonicalTimestamp(entry.createdAt) &&
      ((entry.operation === 'upload-cleanup' && uploadIntentMetadataValid) ||
        (entry.operation === 'delete-cleanup' &&
          !hasOwnerMutationId &&
          !hasSize))
    );
  }

  private isValidEntry(
    id: string,
    value: unknown,
  ): value is ChangeAttachmentIndexEntry {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false;
    if (
      !hasOnlyKeys(value, [
        'id',
        'filePath',
        'bucketId',
        'region',
        'url',
        'name',
        'size',
        'mimeType',
        'sha256',
        'ownerMutationId',
        'state',
        'recordId',
        'fileToken',
        'createdAt',
        'updatedAt',
        'lastError',
      ])
    ) {
      return false;
    }
    const entry = value as Partial<ChangeAttachmentIndexEntry>;
    const stateValid =
      entry.state === 'staged' ||
      entry.state === 'bound' ||
      entry.state === 'cleanup-pending';
    if (!stateValid) return false;
    const hasRecordId = Object.prototype.hasOwnProperty.call(value, 'recordId');
    const hasFileToken = Object.prototype.hasOwnProperty.call(
      value,
      'fileToken',
    );
    const hasLastError = Object.prototype.hasOwnProperty.call(
      value,
      'lastError',
    );
    const bindingPairValid =
      hasRecordId === hasFileToken &&
      (!hasRecordId ||
        (isBoundedTrimmedString(entry.recordId, MAX_RECORD_ID_LENGTH) &&
          isBoundedTrimmedString(entry.fileToken, MAX_FILE_TOKEN_LENGTH)));
    const stateFieldsValid =
      (entry.state === 'staged' &&
        !hasRecordId &&
        !hasFileToken &&
        !hasLastError) ||
      (entry.state === 'bound' &&
        hasRecordId &&
        hasFileToken &&
        bindingPairValid &&
        !hasLastError) ||
      (entry.state === 'cleanup-pending' &&
        bindingPairValid &&
        hasLastError &&
        isBoundedTrimmedString(entry.lastError, MAX_ERROR_LENGTH));
    if (!stateFieldsValid) return false;
    return (
      id === entry.id &&
      /^[A-Za-z0-9_-]{12,80}$/.test(id) &&
      entry.bucketId === this.bucket &&
      entry.region === this.region &&
      entry.url ===
        `/api/duty-schedules/change-attachments/${encodeURIComponent(id)}/download` &&
      isBoundedTrimmedString(entry.name, 180) &&
      safeFileName(entry.name) === entry.name &&
      typeof entry.filePath === 'string' &&
      entry.filePath === `${this.prefix}/${id}/${entry.name}` &&
      this.isCanonicalObjectPath(id, entry.filePath) &&
      Number.isSafeInteger(entry.size) &&
      Number(entry.size) > 0 &&
      Number(entry.size) <= CHANGE_ATTACHMENT_MAX_BYTES &&
      isBoundedTrimmedString(entry.mimeType, MAX_MIME_TYPE_LENGTH) &&
      typeof entry.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(entry.sha256) &&
      isBoundedTrimmedString(
        entry.ownerMutationId,
        MAX_OWNER_MUTATION_ID_LENGTH,
      ) &&
      isCanonicalTimestamp(entry.createdAt) &&
      isCanonicalTimestamp(entry.updatedAt) &&
      Date.parse(entry.updatedAt) >= Date.parse(entry.createdAt)
    );
  }

  private isCanonicalObjectPath(id: string, filePath: string): boolean {
    const objectPrefix = `${this.prefix}/${id}/`;
    if (!filePath.startsWith(objectPrefix)) return false;
    const name = filePath.slice(objectPrefix.length);
    if (!isBoundedTrimmedString(name, 180) || safeFileName(name) !== name) {
      return false;
    }
    try {
      this.assertSafeFilePath(filePath);
      return filePath === `${objectPrefix}${name}`;
    } catch {
      return false;
    }
  }

  private async commitEntries(
    entries: Record<string, ChangeAttachmentIndexEntry>,
    journal: Record<string, ChangeAttachmentJournalEntry> = this.journal,
  ): Promise<void> {
    await mkdir(dirname(this.indexPath), { recursive: true });
    const temporaryPath = `${this.indexPath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
    try {
      const document: ChangeAttachmentIndexFile = {
        version: INDEX_VERSION,
        entries,
        journal,
      };
      await writeFile(temporaryPath, JSON.stringify(document, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryPath, this.indexPath);
      this.entries = entries;
      this.journal = journal;
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async acquireIndexLock(): Promise<void> {
    if (this.indexLockAcquired) return;
    await mkdir(dirname(this.indexLockPath), { recursive: true });
    const lockDocument = createProcessLockOwner(this.indexLockToken);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const handle = await open(this.indexLockPath, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify(lockDocument), 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.indexLockAcquired = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      const owner = await this.readIndexLock();
      let lockModifiedAtMs: number;
      try {
        lockModifiedAtMs = (await stat(this.indexLockPath)).mtimeMs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!owner || processLockOwnerMayBeAlive(owner, lockModifiedAtMs)) {
        throw new ServiceUnavailableException('变更附件索引已被另一实例占用');
      }
      const stalePath = `${this.indexLockPath}.stale-${this.indexLockToken}`;
      try {
        await rename(this.indexLockPath, stalePath);
        await rm(stalePath, { force: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'EEXIST') throw error;
      }
    }
    throw new ServiceUnavailableException('无法取得变更附件索引独占锁');
  }

  private async readIndexLock(): Promise<ChangeAttachmentIndexLockFile | null> {
    let source: string;
    try {
      source = await readFile(this.indexLockPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      return normalizeProcessLockOwner(JSON.parse(source));
    } catch {
      return null;
    }
  }

  private async releaseIndexLock(): Promise<void> {
    if (!this.indexLockAcquired) return;
    try {
      const owner = await this.readIndexLock();
      if (owner?.token === this.indexLockToken) {
        await rm(this.indexLockPath, { force: true });
      }
    } finally {
      this.indexLockAcquired = false;
    }
  }
}
