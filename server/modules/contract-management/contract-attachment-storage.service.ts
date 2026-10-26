import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  ServiceUnavailableException,
  type OnModuleInit,
} from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import COS = require('cos-nodejs-sdk-v5');
import type {
  ContractCreateAttachmentResult,
  ContractManagementDashboard,
  ContractManagementItem,
} from '../../../shared/contract-management.interface';
import {
  getFeishuAuthPayload,
  readEnv,
} from '../../common/config/external-services.config';
import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import {
  decryptContractBuffer,
  encryptContractBuffer,
  isEncryptedContractEnvelope,
  parseContractEncryptionKey,
} from './contract-attachment-crypto';
import {
  createProcessLockOwner,
  normalizeProcessLockOwner,
  processLockOwnerMayBeAlive,
} from '../../common/process-lock-owner';

const DEFAULT_BUCKET = 'jy-1421907124';
const DEFAULT_REGION = 'ap-shanghai';
const DEFAULT_SECURE_PREFIX = 'nantong-supply-chain/secure-contracts';
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_CONCURRENT_SYNCS = 1;
const MAX_CONTRACT_PAGES = 300;
const PAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_PAGE_CACHE_ENTRIES = 36;
const PREVIEW_PROCESSOR_READY_POLL_MS = 5_000;
const PREVIEW_DIRECTORY_PREFIX = 'vnet-contract-preview-';
const LEGACY_PREVIEW_DIRECTORY_STALE_MS = 60 * 60 * 1000;
const CONTRACT_STORAGE_INDEX_META_KEY = '__vnet_contract_storage_index_meta__';
const TOMBSTONE = Buffer.from(
  'This object has been migrated to protected contract storage.',
  'utf8',
);
const LOCAL_PROCESSOR_ENVIRONMENT_KEYS = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'COMSPEC',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'VIRTUAL_ENV',
  'PYTHONHOME',
  'PYTHONPATH',
  'OMP_NUM_THREADS',
]);

interface SourceAttachment {
  name: string;
  url: string;
  fileToken?: string;
}

interface LegacyStorageIndexEntry {
  objectKey: string;
  url?: string;
  syncedAt?: string;
}

interface SecurePageEntry {
  page: number;
  objectKey: string;
  width: number;
  height: number;
  bytes: number;
}

interface SecureStorageIndexEntry {
  version: 3;
  accessId: string;
  storageId: string;
  contractRecordId: string;
  name: string;
  state: 'queued' | 'processing' | 'ready' | 'failed';
  objectKey?: string;
  legacyObjectKey?: string;
  legacyProtectedAt?: string;
  obsoleteObjectKeys?: string[];
  sha256?: string;
  bytes?: number;
  pageCount: number;
  pages: SecurePageEntry[];
  createdAt: string;
  updatedAt: string;
  error?: string;
}

type StorageIndexEntry = LegacyStorageIndexEntry | SecureStorageIndexEntry;
type ContractStorageIndex = Record<string, unknown>;

export function buildContractStorageIndexObjectKey(
  prefix: string,
  configuredObjectKey?: string,
): string {
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, '');
  if (!normalizedPrefix) throw new Error('合同安全存储前缀不能为空');
  const normalizedObjectKey = configuredObjectKey?.replace(/^\/+|\/+$/g, '');
  if (!normalizedObjectKey) {
    return `${normalizedPrefix}/metadata/contract-index.vnetc`;
  }
  if (
    !normalizedObjectKey.startsWith(`${normalizedPrefix}/`) ||
    !normalizedObjectKey.endsWith('.vnetc')
  ) {
    throw new Error('合同 COS 索引对象必须位于安全存储前缀内');
  }
  return normalizedObjectKey;
}

export function parseContractStorageIndex(
  content: Buffer | string,
): ContractStorageIndex {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.isBuffer(content) ? content.toString('utf8') : content,
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid shape');
    }
    return parsed as ContractStorageIndex;
  } catch {
    throw new Error('合同附件索引格式无效');
  }
}

export function buildVersionedContractStorageIndex(
  index: ContractStorageIndex,
  revision: number,
): ContractStorageIndex {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('合同附件索引版本号无效');
  }
  return {
    ...index,
    [CONTRACT_STORAGE_INDEX_META_KEY]: {
      version: 1,
      revision,
    },
  };
}

function getContractStorageIndexRevision(index: ContractStorageIndex): number {
  const metadata = index[CONTRACT_STORAGE_INDEX_META_KEY];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return 0;
  }
  const revision = (metadata as { revision?: unknown }).revision;
  return Number.isSafeInteger(revision) && Number(revision) >= 0
    ? Number(revision)
    : 0;
}

function stripContractStorageIndexMetadata(
  index: ContractStorageIndex,
): ContractStorageIndex {
  const result = { ...index };
  delete result[CONTRACT_STORAGE_INDEX_META_KEY];
  return result;
}

export function selectContractStorageIndex(
  cosIndex: ContractStorageIndex | null,
  localIndex: ContractStorageIndex | null,
): {
  index: ContractStorageIndex;
  source: 'cos' | 'local' | 'empty';
} {
  if (
    cosIndex &&
    localIndex &&
    getContractStorageIndexRevision(cosIndex) === 0 &&
    getContractStorageIndexRevision(localIndex) === 0
  ) {
    const merged = mergeLegacyContractStorageIndexes(cosIndex, localIndex);
    if (JSON.stringify(merged) !== JSON.stringify(cosIndex)) {
      return { index: merged, source: 'local' };
    }
  }
  if (
    cosIndex &&
    localIndex &&
    getContractStorageIndexRevision(localIndex) >
      getContractStorageIndexRevision(cosIndex)
  ) {
    return { index: localIndex, source: 'local' };
  }
  if (cosIndex) return { index: cosIndex, source: 'cos' };
  if (localIndex) return { index: localIndex, source: 'local' };
  return { index: {}, source: 'empty' };
}

function mergeLegacyContractStorageIndexes(
  cosIndex: ContractStorageIndex,
  localIndex: ContractStorageIndex,
): ContractStorageIndex {
  const merged = { ...cosIndex };
  for (const [indexKey, localValue] of Object.entries(localIndex)) {
    const cosValue = cosIndex[indexKey];
    if (cosValue === undefined) {
      merged[indexKey] = localValue;
      continue;
    }
    merged[indexKey] = selectNewerLegacyStorageEntry(cosValue, localValue);
  }
  return merged;
}

function selectNewerLegacyStorageEntry(
  cosValue: unknown,
  localValue: unknown,
): unknown {
  const progress = (value: unknown): number => {
    if (!value || typeof value !== 'object') return 0;
    const entry = value as {
      state?: unknown;
    };
    if (entry.state === 'failed') return 4;
    if (entry.state === 'ready') return 3;
    if (entry.state === 'processing') return 2;
    if (entry.state === 'queued') return 1;
    return 0;
  };
  const sha256 = (value: unknown): string => {
    if (!value || typeof value !== 'object') return '';
    const digest = (value as { sha256?: unknown }).sha256;
    return typeof digest === 'string' ? digest : '';
  };
  const localProgress = progress(localValue);
  const cosProgress = progress(cosValue);
  const localSha256 = sha256(localValue);
  if (
    localSha256 &&
    localSha256 === sha256(cosValue) &&
    (localProgress >= 3 || cosProgress >= 3) &&
    localProgress !== cosProgress
  ) {
    return localProgress > cosProgress ? localValue : cosValue;
  }

  const updatedAt = (value: unknown): number => {
    if (!value || typeof value !== 'object') return 0;
    const raw = (value as { updatedAt?: unknown }).updatedAt;
    if (typeof raw !== 'string') return 0;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const localUpdatedAt = updatedAt(localValue);
  const cosUpdatedAt = updatedAt(cosValue);
  if (localUpdatedAt !== cosUpdatedAt) {
    return localUpdatedAt > cosUpdatedAt ? localValue : cosValue;
  }
  return localProgress > cosProgress ? localValue : cosValue;
}

interface StorageJob {
  indexKey: string;
  source: SourceAttachment;
  contentMatchKey?: string;
}

interface RenderManifest {
  pageCount: number;
  pages: Array<{
    page: number;
    file: string;
    width: number;
    height: number;
    bytes: number;
  }>;
}

interface DownloadedAttachment {
  buffer: Buffer;
  contentType: string;
}

interface CachedPage {
  buffer: Buffer;
  expiresAt: number;
}

export function buildSecureContractObjectKey(
  prefix: string,
  storageId: string,
  kind: 'original' | number,
): string {
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, '');
  if (!normalizedPrefix) throw new Error('合同安全存储前缀不能为空');
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(storageId)) {
    throw new Error('合同附件存储标识无效');
  }
  return kind === 'original'
    ? `${normalizedPrefix}/${storageId}/original.vnetc`
    : `${normalizedPrefix}/${storageId}/pages/${String(kind).padStart(4, '0')}.vnetc`;
}

export function buildCosPublicObjectUrl(
  bucket: string,
  region: string,
  objectKey: string,
): string {
  if (
    !/^[a-z0-9][a-z0-9-]{2,62}$/.test(bucket) ||
    !/^[a-z0-9][a-z0-9-]{1,30}$/.test(region) ||
    !objectKey
  ) {
    throw new Error('COS 公开对象地址参数无效');
  }
  const encodedKey = objectKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://${bucket}.cos.${region}.myqcloud.com/${encodedKey}`;
}

export function buildSafeAttachmentDto<
  T extends {
    accessId: string;
    name: string;
    state: string;
    pageCount?: number;
  },
>(input: T): ContractManagementItem['attachments'][number] {
  const previewStatus =
    input.state === 'ready'
      ? 'ready'
      : input.state === 'failed'
        ? 'failed'
        : 'processing';
  return {
    accessId: input.accessId,
    name: input.name,
    previewStatus,
    pageCount: Math.max(0, Number(input.pageCount) || 0),
  };
}

export function assertPdfAttachment(buffer: Buffer): void {
  if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-', 'ascii'))) {
    throw new Error('合同附件不是有效 PDF');
  }
}

export function isMigrationTombstone(buffer: Buffer): boolean {
  return buffer.equals(TOMBSTONE);
}

export function isOfficialFeishuBatchDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'open.feishu.cn' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443') &&
      url.pathname === '/open-apis/drive/v1/medias/batch_get_tmp_download_url'
    );
  } catch {
    return false;
  }
}

const TRUSTED_FEISHU_DOWNLOAD_DOMAINS = [
  'feishu.cn',
  'feishucdn.com',
  'larksuite.com',
  'larksuitecdn.com',
  'byteimg.com',
  'bytefcdn.com',
  'volces.com',
  'volccdn.com',
];

export function isTrustedFeishuAttachmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443')
    ) {
      return false;
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return TRUSTED_FEISHU_DOWNLOAD_DOMAINS.some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

export function shouldQueueSecureAttachment(input: {
  state: string;
  legacyObjectKey?: string;
  legacyProtectedAt?: string;
  obsoleteObjectKeys?: string[];
}): boolean {
  if (input.state === 'failed') return false;
  return (
    input.state !== 'ready' ||
    Boolean(input.legacyObjectKey && !input.legacyProtectedAt) ||
    Boolean(input.obsoleteObjectKeys?.length)
  );
}

export function isContractPreviewProcessorReady(
  readyFilePath: string,
  fileExists: (path: string) => boolean = existsSync,
): boolean {
  const normalizedPath = readyFilePath.trim();
  return !normalizedPath || fileExists(normalizedPath);
}

export function buildRenderPreviewArguments(
  outputDirectory: string,
  watermarkId: string,
): string[] {
  return ['--output-dir', outputDirectory, `--watermark-id=${watermarkId}`];
}

export function normalizeSecureStorageIndexEntry(
  value: unknown,
): SecureStorageIndexEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (entry.version !== 2 && entry.version !== 3) return null;
  if (
    typeof entry.accessId !== 'string' ||
    !entry.accessId ||
    typeof entry.name !== 'string' ||
    !Array.isArray(entry.pages)
  ) {
    return null;
  }
  const state = ['queued', 'processing', 'ready', 'failed'].includes(
    String(entry.state),
  )
    ? (entry.state as SecureStorageIndexEntry['state'])
    : 'queued';
  const validStorageId =
    typeof entry.storageId === 'string' &&
    /^[A-Za-z0-9_-]{10,80}$/.test(entry.storageId);
  const storageId = validStorageId
    ? (entry.storageId as string)
    : randomBytes(24).toString('base64url');
  const pages = entry.pages as SecurePageEntry[];
  const objectKey = optionalString(entry.objectKey);
  const pageObjectKeys = pages.flatMap((page) =>
    typeof page?.objectKey === 'string' ? [page.objectKey] : [],
  );
  const needsRelocation = Boolean(
    objectKey &&
    (!objectKey.endsWith(`/${storageId}/original.vnetc`) ||
      pageObjectKeys.some(
        (pageObjectKey) => !pageObjectKey.includes(`/${storageId}/pages/`),
      )),
  );
  const existingObsoleteObjectKeys = Array.isArray(entry.obsoleteObjectKeys)
    ? entry.obsoleteObjectKeys.filter(
        (candidate): candidate is string => typeof candidate === 'string',
      )
    : [];
  const obsoleteObjectKeys = needsRelocation
    ? [objectKey as string, ...pageObjectKeys, ...existingObsoleteObjectKeys]
    : existingObsoleteObjectKeys;
  const rawPageCount =
    typeof entry.pageCount === 'number' && Number.isFinite(entry.pageCount)
      ? Math.max(0, Math.trunc(entry.pageCount))
      : entry.pages.length;
  const hasValidPageManifest =
    rawPageCount >= 1 &&
    rawPageCount <= MAX_CONTRACT_PAGES &&
    pages.length === rawPageCount &&
    pages.every(
      (page, index) => Number.isInteger(page?.page) && page.page === index + 1,
    );
  const normalizedState =
    state === 'ready' && !hasValidPageManifest ? 'queued' : state;
  return {
    version: 3,
    accessId: entry.accessId,
    storageId,
    contractRecordId:
      typeof entry.contractRecordId === 'string' ? entry.contractRecordId : '',
    name: entry.name,
    state:
      needsRelocation && normalizedState !== 'failed'
        ? 'queued'
        : normalizedState,
    objectKey,
    legacyObjectKey: optionalString(entry.legacyObjectKey),
    legacyProtectedAt: optionalString(entry.legacyProtectedAt),
    obsoleteObjectKeys: obsoleteObjectKeys.length
      ? [...new Set(obsoleteObjectKeys)]
      : undefined,
    sha256: optionalString(entry.sha256),
    bytes:
      typeof entry.bytes === 'number' && Number.isFinite(entry.bytes)
        ? entry.bytes
        : undefined,
    pageCount: rawPageCount,
    pages,
    createdAt:
      typeof entry.createdAt === 'string'
        ? entry.createdAt
        : new Date().toISOString(),
    updatedAt:
      typeof entry.updatedAt === 'string'
        ? entry.updatedAt
        : new Date().toISOString(),
    error: optionalString(entry.error),
  };
}

export function normalizeStorageIndexEntryForStartup(
  indexKey: string,
  value: unknown,
): SecureStorageIndexEntry | null {
  const secure = normalizeSecureStorageIndexEntry(value);
  if (secure) return secure;
  if (!isLegacyEntry(value)) return null;
  const separator = indexKey.indexOf(':');
  const contractRecordId = separator > 0 ? indexKey.slice(0, separator) : '';
  const rawName = basename(value.objectKey) || '合同原件.pdf';
  let name = rawName;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    name = rawName;
  }
  return createSecureStorageIndexEntry(contractRecordId, name, value);
}

export function enqueueRecoverableWrite(
  previous: Promise<void>,
  write: () => Promise<void>,
): { operation: Promise<void>; continuation: Promise<void> } {
  const operation = previous.catch(() => undefined).then(write);
  return {
    operation,
    continuation: operation.catch(() => undefined),
  };
}

export async function acquireExclusiveProcessLock(
  lockPath: string,
): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomBytes(24).toString('base64url');
  const payload = JSON.stringify(createProcessLockOwner(token));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, payload, { encoding: 'utf8', flag: 'wx' });
      return async () => {
        try {
          const current = JSON.parse(await readFile(lockPath, 'utf8')) as {
            token?: unknown;
          };
          if (current.token === token) await rm(lockPath, { force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner = null;
      try {
        owner = normalizeProcessLockOwner(
          JSON.parse(await readFile(lockPath, 'utf8')),
        );
      } catch {
        throw new Error('合同附件迁移锁无效，请人工检查运行状态');
      }
      if (!owner) {
        throw new Error('合同附件迁移锁无效，请人工检查运行状态');
      }
      const lockModifiedAtMs = (await stat(lockPath)).mtimeMs;
      if (processLockOwnerMayBeAlive(owner, lockModifiedAtMs)) {
        throw new Error('合同附件迁移正在由另一个进程处理');
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new Error('合同附件迁移锁获取失败');
}

export function buildStartupRecoveryJobs(
  index: Record<string, unknown>,
): StorageJob[] {
  return Object.entries(index).flatMap(([indexKey, value]) => {
    const entry = normalizeSecureStorageIndexEntry(value);
    if (!entry || !shouldQueueSecureAttachment(entry)) return [];
    const canResume = Boolean(
      (entry.objectKey && entry.sha256) ||
      (entry.legacyObjectKey && !entry.legacyProtectedAt),
    );
    return canResume
      ? [{ indexKey, source: { name: entry.name, url: '' } }]
      : [];
  });
}

export function shouldRemoveStalePreviewDirectory(
  name: string,
  modifiedAtMs: number,
  nowMs: number,
  isProcessAlive: (pid: number) => boolean,
): boolean {
  if (!name.startsWith(PREVIEW_DIRECTORY_PREFIX)) return false;
  const owner = name.match(/^vnet-contract-preview-(\d+)-/);
  if (owner) return !isProcessAlive(Number(owner[1]));
  return nowMs - modifiedAtMs >= LEGACY_PREVIEW_DIRECTORY_STALE_MS;
}

@Injectable()
export class ContractAttachmentStorageService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ContractAttachmentStorageService.name);
  private readonly storageEnabled = !['false', '0', 'off', 'no'].includes(
    readEnv('CONTRACT_ATTACHMENT_STORAGE_ENABLED').toLowerCase(),
  );
  private readonly bucket =
    readEnv('COS_CONTRACT_BUCKET') || readEnv('COS_BUCKET') || DEFAULT_BUCKET;
  private readonly region =
    readEnv('COS_CONTRACT_REGION') || readEnv('COS_REGION') || DEFAULT_REGION;
  private readonly securePrefix =
    readEnv('COS_CONTRACT_SECURE_PREFIX') || DEFAULT_SECURE_PREFIX;
  private readonly secretId = readEnv('COS_SECRET_ID', [
    'TENCENTCLOUD_SECRET_ID',
  ]);
  private readonly secretKey = readEnv('COS_SECRET_KEY', [
    'TENCENTCLOUD_SECRET_KEY',
  ]);
  private readonly securityToken = readEnv('COS_SESSION_TOKEN', [
    'TENCENTCLOUD_SESSION_TOKEN',
  ]);
  private readonly indexPath =
    readEnv('COS_CONTRACT_INDEX_PATH') ||
    join(process.cwd(), '.runtime', 'contract-attachment-cos-index.json');
  private readonly indexObjectKey = buildContractStorageIndexObjectKey(
    this.securePrefix,
    readEnv('COS_CONTRACT_INDEX_OBJECT_KEY'),
  );
  private readonly encryptionKey = this.storageEnabled
    ? loadEncryptionKey()
    : null;
  private readonly cos =
    this.storageEnabled && this.secretId && this.secretKey
      ? new COS({
          SecretId: this.secretId,
          SecretKey: this.secretKey,
          SecurityToken: this.securityToken || undefined,
          FileParallelLimit: MAX_CONCURRENT_SYNCS,
          Timeout: 60_000,
        })
      : null;
  private readonly queue: StorageJob[] = [];
  private readonly queuedKeys = new Set<string>();
  private readonly accessIndex = new Map<string, SecureStorageIndexEntry>();
  private readonly pageCache = new Map<string, CachedPage>();
  private readonly inFlightStorageJobs = new Set<Promise<void>>();
  private activeJobs = 0;
  private failedJobs = 0;
  private lastError = '';
  private index: Record<string, StorageIndexEntry> = {};
  private indexRevision = 0;
  private indexLoaded: Promise<void> | null = null;
  private persistChain = Promise.resolve();
  private tenantToken: { value: string; expiresAt: number } | null = null;
  private releaseMigrationLock: (() => Promise<void>) | null = null;
  private previewProcessorRetryTimer: ReturnType<typeof setTimeout> | null =
    null;
  private destroyed = false;

  constructor(private readonly httpService: HttpService) {}

  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      if (!this.storageEnabled) return;
      try {
        await cleanupStalePreviewDirectories();
      } catch (error) {
        this.logger.warn(`合同预览临时目录清理失败：${safeErrorMessage(error)}`);
      }
      if (this.isConfigured()) {
        this.releaseMigrationLock = await acquireExclusiveProcessLock(
          `${this.indexPath}.migration.lock`,
        );
      }
      try {
        await this.ensureIndexLoaded();
      } catch (error) {
        await this.releaseMigrationLock?.();
        this.releaseMigrationLock = null;
        throw error;
      }
      if (this.isConfigured()) {
        this.logger.log('合同附件安全存储已启用（AES-256-GCM + 分页水印预览）');
        const recoveryJobs = buildStartupRecoveryJobs(this.index);
        if (recoveryJobs.length) {
          setImmediate(() => this.enqueue(recoveryJobs));
        }
        return;
      }
      this.logger.warn(
        '合同附件安全存储未完整配置：公开原件链接不会返回前端，预览与下载保持关闭',
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    this.destroyed = true;
    if (this.previewProcessorRetryTimer) {
      clearTimeout(this.previewProcessorRetryTimer);
      this.previewProcessorRetryTimer = null;
    }
    await Promise.allSettled([...this.inFlightStorageJobs]);
    await this.persistChain;
    await this.releaseMigrationLock?.();
    this.releaseMigrationLock = null;
  }

  getStatus() {
    const entries = [...this.accessIndex.values()];
    return {
      configured: this.isConfigured(),
      encryptionConfigured: Boolean(this.encryptionKey),
      queued: this.queue.length,
      active: this.activeJobs,
      indexed: entries.length,
      ready: entries.filter((entry) => entry.state === 'ready').length,
      legacyProtected: entries.filter(
        (entry) => !entry.legacyObjectKey || Boolean(entry.legacyProtectedAt),
      ).length,
      processing: entries.filter(
        (entry) => entry.state === 'queued' || entry.state === 'processing',
      ).length,
      failed: entries.filter((entry) => entry.state === 'failed').length,
      failedJobs: this.failedJobs,
      lastError: this.lastError || null,
    };
  }

  async enrichAndSchedule(
    dashboard: ContractManagementDashboard,
    executionRecords: BitableRecordItem[],
  ): Promise<ContractManagementDashboard> {
    await this.ensureIndexLoaded();
    const sourceByRecord = new Map(
      executionRecords.map((record) => [
        record.record_id || record.id || '',
        extractSourceAttachments(record.fields?.['合同附件']),
      ]),
    );
    const pendingJobs: StorageJob[] = [];
    const attachmentsByContractRecordId = new Map<
      string,
      ContractManagementItem['attachments']
    >();
    let changed = false;

    const resolveAttachments = (
      contractRecordId: string,
      sourceAttachments: SourceAttachment[],
    ) => {
      const prepared = this.prepareContractAttachments(
        contractRecordId,
        sourceAttachments,
      );
      changed = changed || prepared.changed;
      if (this.isConfigured()) pendingJobs.push(...prepared.jobs);
      const attachments = prepared.presentationIndexKeys.flatMap(
        (indexKey, sourceIndex) => {
          const entry = this.index[indexKey];
          if (!isSecureEntry(entry)) return [];
          return [
            {
              ...buildSafeAttachmentDto(entry),
              name: sourceAttachments[sourceIndex]?.name || entry.name,
            },
          ];
        },
      );
      attachmentsByContractRecordId.set(contractRecordId, attachments);
      return attachments;
    };

    for (const [contractRecordId, sourceAttachments] of sourceByRecord) {
      if (!contractRecordId) continue;
      resolveAttachments(contractRecordId, sourceAttachments);
    }

    const enrichContract = (contract: ContractManagementItem) => {
      return {
        ...contract,
        attachments:
          attachmentsByContractRecordId.get(contract.recordId) ||
          contract.attachments,
      };
    };

    const contracts = dashboard.contracts.map(enrichContract);
    const activeById = new Map(
      contracts.map((contract) => [contract.recordId, contract]),
    );
    const contractRisks = dashboard.contractRisks.map(
      (contract) =>
        activeById.get(contract.recordId) || enrichContract(contract),
    );
    if (changed) this.persistIndexInBackground();
    if (pendingJobs.length) setImmediate(() => this.enqueue(pendingJobs));

    return {
      ...dashboard,
      contracts,
      contractRisks,
      paymentFollowUps: dashboard.paymentFollowUps.map((item) => ({
        ...item,
        attachments:
          attachmentsByContractRecordId.get(item.contractRecordId) ||
          item.attachments,
      })),
    };
  }

  refreshDashboardAttachmentStates(
    dashboard: ContractManagementDashboard,
  ): ContractManagementDashboard {
    let changed = false;
    const refreshAttachments = (
      contractRecordId: string,
      attachments: ContractManagementItem['attachments'],
    ): ContractManagementItem['attachments'] =>
      attachments.map((attachment) => {
        const current = this.accessIndex.get(attachment.accessId);
        const normalizedName = normalizeContractAttachmentBusinessName(
          attachment.name,
        );
        const verifiedCandidates = [...this.accessIndex.values()]
          .filter(
            (candidate) =>
              candidate.contractRecordId === contractRecordId &&
              candidate.state === 'ready' &&
              candidate.pages.length > 0 &&
              normalizeContractAttachmentBusinessName(candidate.name) ===
                normalizedName,
          )
          .sort(
            (left, right) =>
              Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
          );
        const entry = verifiedCandidates[0] || current;
        if (!entry) return attachment;
        const latest = {
          ...buildSafeAttachmentDto(entry),
          name: attachment.name,
        };
        if (
          latest.accessId === attachment.accessId &&
          latest.name === attachment.name &&
          latest.previewStatus === attachment.previewStatus &&
          latest.pageCount === attachment.pageCount
        ) {
          return attachment;
        }
        changed = true;
        return latest;
      });
    const refreshContract = (
      contract: ContractManagementItem,
    ): ContractManagementItem => {
      const attachments = refreshAttachments(
        contract.recordId,
        contract.attachments,
      );
      return attachments === contract.attachments ||
        attachments.every(
          (attachment, index) => attachment === contract.attachments[index],
        )
        ? contract
        : { ...contract, attachments };
    };
    const refreshFollowUp = (
      item: ContractManagementDashboard['paymentFollowUps'][number],
    ) => {
      const attachments = refreshAttachments(
        item.contractRecordId,
        item.attachments,
      );
      return attachments.every(
        (attachment, index) => attachment === item.attachments[index],
      )
        ? item
        : { ...item, attachments };
    };

    const contracts = dashboard.contracts.map(refreshContract);
    const unsignedContracts = dashboard.unsignedContracts.map(refreshContract);
    const contractRisks = dashboard.contractRisks.map(refreshContract);
    const paymentFollowUps = dashboard.paymentFollowUps.map(refreshFollowUp);
    return changed
      ? {
          ...dashboard,
          contracts,
          unsignedContracts,
          contractRisks,
          paymentFollowUps,
        }
      : dashboard;
  }

  async syncContractRecordAttachments(
    contractRecordId: string,
    value: unknown,
  ): Promise<ContractCreateAttachmentResult[]> {
    this.assertStorageEnabled();
    await this.ensureIndexLoaded();
    const recordId = contractRecordId.trim();
    if (!recordId) throw new BadRequestException('合同记录标识无效');
    const sourceAttachments = extractSourceAttachments(value);
    if (!sourceAttachments.length) {
      throw new BadRequestException('合同附件字段未返回可同步的 PDF');
    }
    const prepared = this.prepareContractAttachments(
      recordId,
      sourceAttachments,
    );
    if (prepared.changed) await this.persistIndex();
    for (const job of prepared.jobs) await this.sync(job);

    const entries = prepared.indexKeys.map((indexKey) => {
      const entry = this.index[indexKey];
      if (!isSecureEntry(entry) || entry.state !== 'ready') {
        throw new Error('合同附件安全存储未完成');
      }
      return entry;
    });
    return entries.map(buildSafeAttachmentDto);
  }

  async removeContractRecordAttachments(
    contractRecordId: string,
  ): Promise<number> {
    this.assertStorageEnabled();
    await this.ensureIndexLoaded();
    const recordId = contractRecordId.trim();
    if (!recordId) throw new BadRequestException('合同记录标识无效');
    const matches = Object.entries(this.index).flatMap(([indexKey, value]) => {
      const entry = isSecureEntry(value) ? value : null;
      return entry?.contractRecordId === recordId ? [{ indexKey, entry }] : [];
    });
    if (!matches.length) return 0;

    for (const { indexKey, entry } of matches) {
      const objectKeys = dedupeStrings([
        entry.objectKey,
        ...entry.pages.map((page) => page.objectKey),
        ...(entry.obsoleteObjectKeys || []),
      ]);
      for (const objectKey of objectKeys) {
        if (!this.isSafeSecureObjectKey(objectKey)) continue;
        if (!this.cos) {
          throw new ServiceUnavailableException('合同附件对象存储未配置');
        }
        await this.cos.deleteObject({
          Bucket: this.bucket,
          Region: this.region,
          Key: objectKey,
        });
      }
      delete this.index[indexKey];
      this.accessIndex.delete(entry.accessId);
      this.queuedKeys.delete(indexKey);
      for (const cacheKey of this.pageCache.keys()) {
        if (cacheKey.startsWith(`${entry.accessId}:`)) {
          this.pageCache.delete(cacheKey);
        }
      }
    }
    const removedKeys = new Set(matches.map((item) => item.indexKey));
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (removedKeys.has(this.queue[index].indexKey))
        this.queue.splice(index, 1);
    }
    await this.persistIndex();
    return matches.length;
  }

  async getManifest(accessId: string) {
    if (!this.storageEnabled) {
      return {
        accessId,
        name: '',
        previewStatus: 'failed' as const,
        pageCount: 0,
        originalAvailable: false,
        unavailableReason: 'storage_not_configured' as const,
      };
    }
    const entry = await this.getEntry(accessId);
    if (!this.isConfigured()) {
      return {
        accessId: entry.accessId,
        name: entry.name,
        previewStatus: 'failed' as const,
        pageCount: 0,
        originalAvailable: false,
        unavailableReason: 'storage_not_configured' as const,
      };
    }
    return {
      accessId: entry.accessId,
      name: entry.name,
      previewStatus: buildSafeAttachmentDto(entry).previewStatus,
      pageCount: entry.pageCount,
      originalAvailable: Boolean(entry.objectKey && entry.sha256),
    };
  }

  async getPreviewPage(accessId: string, pageNumber: number) {
    this.assertStorageEnabled();
    const entry = await this.getEntry(accessId);
    if (entry.state !== 'ready') {
      throw new BadRequestException('合同在线预览仍在处理中');
    }
    const page = entry.pages.find((item) => item.page === pageNumber);
    if (!page) throw new NotFoundException('合同预览页不存在');
    const cacheKey = `${accessId}:${pageNumber}`;
    const cached = this.pageCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { buffer: cached.buffer, contentType: 'image/jpeg' };
    }
    const buffer = await this.readEncryptedObject(page.objectKey);
    this.cachePage(cacheKey, buffer);
    return { buffer, contentType: 'image/jpeg' };
  }

  async getOriginal(accessId: string) {
    this.assertStorageEnabled();
    const entry = await this.getEntry(accessId);
    if (!entry.objectKey || !entry.sha256) {
      throw new BadRequestException('合同原件仍在安全迁移中');
    }
    const buffer = await this.readEncryptedObject(entry.objectKey);
    assertPdfAttachment(buffer);
    if (entry.sha256 && sha256Buffer(buffer) !== entry.sha256) {
      throw new Error('合同原件完整性校验失败');
    }
    return {
      buffer,
      name: safeDownloadFileName(entry.name),
      contentType: 'application/pdf',
    };
  }

  private isConfigured(): boolean {
    return Boolean(this.storageEnabled && this.cos && this.encryptionKey);
  }

  private assertStorageEnabled(): void {
    if (!this.storageEnabled) {
      throw new ServiceUnavailableException('合同附件存储已禁用');
    }
  }

  private prepareContractAttachments(
    contractRecordId: string,
    sourceAttachments: SourceAttachment[],
  ): {
    indexKeys: string[];
    presentationIndexKeys: string[];
    jobs: StorageJob[];
    changed: boolean;
  } {
    let changed = false;
    const jobs: StorageJob[] = [];
    const presentationIndexKeys: string[] = [];
    const indexKeys = sourceAttachments.map((source, sourceIndex) => {
      const { indexKey, previousKey, contentMatchKey } =
        resolveContractAttachmentIndexKey(
          this.index,
          contractRecordId,
          source,
          sourceIndex,
        );
      let current = this.index[indexKey];
      if (!current && previousKey) {
        current = this.index[previousKey];
        this.index[indexKey] = current;
        delete this.index[previousKey];
        changed = true;
      }
      const entry = isSecureEntry(current)
        ? current
        : this.createSecureEntry(contractRecordId, source, current);
      if (entry !== current) {
        this.index[indexKey] = entry;
        this.accessIndex.set(entry.accessId, entry);
        changed = true;
      }
      if (shouldQueueSecureAttachment(entry)) {
        jobs.push({ indexKey, source, contentMatchKey });
      }
      const verifiedCandidate = contentMatchKey
        ? this.index[contentMatchKey]
        : undefined;
      presentationIndexKeys.push(
        entry.state !== 'ready' &&
          isSecureEntry(verifiedCandidate) &&
          verifiedCandidate.state === 'ready' &&
          verifiedCandidate.pages.length > 0
          ? contentMatchKey
          : indexKey,
      );
      return indexKey;
    });
    return { indexKeys, presentationIndexKeys, jobs, changed };
  }

  private isSafeSecureObjectKey(objectKey: string): boolean {
    const prefix = this.securePrefix.replace(/^\/+|\/+$/g, '');
    return Boolean(
      objectKey &&
      prefix &&
      objectKey.startsWith(`${prefix}/`) &&
      objectKey !== this.indexObjectKey,
    );
  }

  private enqueue(jobs: StorageJob[]): void {
    if (this.destroyed || !this.storageEnabled) return;
    for (const job of jobs) {
      if (this.queuedKeys.has(job.indexKey)) continue;
      const entry = this.index[job.indexKey];
      if (!isSecureEntry(entry) || !shouldQueueSecureAttachment(entry)) {
        continue;
      }
      this.queue.push(job);
      this.queuedKeys.add(job.indexKey);
    }
    this.drainQueue();
  }

  private isPreviewProcessorReady(): boolean {
    return isContractPreviewProcessorReady(
      readEnv('CONTRACT_PREVIEW_READY_FILE'),
    );
  }

  private schedulePreviewProcessorRetry(): void {
    if (this.destroyed || this.previewProcessorRetryTimer) return;
    this.previewProcessorRetryTimer = setTimeout(() => {
      this.previewProcessorRetryTimer = null;
      this.drainQueue();
    }, PREVIEW_PROCESSOR_READY_POLL_MS);
    this.previewProcessorRetryTimer.unref?.();
  }

  private drainQueue(): void {
    if (this.destroyed) return;
    if (!this.isPreviewProcessorReady()) {
      this.schedulePreviewProcessorRetry();
      return;
    }
    while (this.activeJobs < MAX_CONCURRENT_SYNCS && this.queue.length > 0) {
      const job = this.queue.shift() as StorageJob;
      this.activeJobs += 1;
      const task = this.sync(job)
        .catch((error: unknown) => {
          this.failedJobs += 1;
          this.lastError = safeErrorMessage(error);
          this.logger.warn(
            `合同附件安全迁移失败：${safeFileLabel(job.source.name)}（${this.lastError}）`,
          );
        })
        .finally(() => {
          this.queuedKeys.delete(job.indexKey);
          this.activeJobs -= 1;
          this.drainQueue();
        });
      this.inFlightStorageJobs.add(task);
      void task.finally(() => {
        this.inFlightStorageJobs.delete(task);
      });
    }
  }

  private async sync(job: StorageJob): Promise<void> {
    const entry = this.index[job.indexKey];
    if (!isSecureEntry(entry) || !shouldQueueSecureAttachment(entry)) return;
    if (!this.cos || !this.encryptionKey) {
      throw new ServiceUnavailableException('合同附件安全存储未配置');
    }
    const contentMatchEntry = job.contentMatchKey
      ? this.index[job.contentMatchKey]
      : undefined;
    entry.state = 'processing';
    entry.error = undefined;
    entry.updatedAt = new Date().toISOString();

    let temporaryDirectory = '';
    try {
      await this.persistIndex();
      const downloaded = await this.loadAttachmentForSync(entry, job.source);
      assertPdfAttachment(downloaded.buffer);
      const digest = sha256Buffer(downloaded.buffer);
      if (entry.sha256 && entry.sha256 !== digest) {
        throw new Error('合同安全原件恢复校验失败');
      }
      if (
        job.contentMatchKey &&
        isSecureEntry(contentMatchEntry) &&
        canReuseContractAttachmentContent(contentMatchEntry, digest)
      ) {
        this.index[job.indexKey] = contentMatchEntry;
        delete this.index[job.contentMatchKey];
        this.accessIndex.set(entry.accessId, contentMatchEntry);
        contentMatchEntry.updatedAt = new Date().toISOString();
        await this.persistIndex();
        return;
      }
      const objectKey = buildSecureContractObjectKey(
        this.securePrefix,
        entry.storageId,
        'original',
      );
      await this.putEncryptedObject(objectKey, downloaded.buffer);
      const verifiedOriginal = await this.readEncryptedObject(objectKey);
      if (sha256Buffer(verifiedOriginal) !== digest) {
        throw new Error('合同原件密文回读校验失败');
      }

      entry.objectKey = objectKey;
      entry.sha256 = digest;
      entry.bytes = downloaded.buffer.length;
      entry.updatedAt = new Date().toISOString();
      await this.persistIndex();

      temporaryDirectory = await createPreviewTemporaryDirectory();
      const manifest = await this.renderPreview(
        downloaded.buffer,
        temporaryDirectory,
        entry.accessId,
      );
      const pages: SecurePageEntry[] = [];
      for (const rendered of manifest.pages) {
        if (!/^page-\d{4}\.jpg$/.test(rendered.file)) {
          throw new Error('合同预览脚本返回了无效文件名');
        }
        const pageBuffer = await readFile(
          join(temporaryDirectory, rendered.file),
        );
        const pageObjectKey = buildSecureContractObjectKey(
          this.securePrefix,
          entry.storageId,
          rendered.page,
        );
        await this.putEncryptedObject(pageObjectKey, pageBuffer);
        const verifiedPage = await this.readEncryptedObject(pageObjectKey);
        if (sha256Buffer(verifiedPage) !== sha256Buffer(pageBuffer)) {
          throw new Error(`合同预览第 ${rendered.page} 页密文校验失败`);
        }
        pages.push({
          page: rendered.page,
          objectKey: pageObjectKey,
          width: rendered.width,
          height: rendered.height,
          bytes: rendered.bytes,
        });
      }

      entry.pages = pages;
      entry.pageCount = pages.length;
      entry.state = 'ready';
      entry.updatedAt = new Date().toISOString();
      await this.persistIndex();

      if (entry.legacyObjectKey && !entry.legacyProtectedAt) {
        await this.cos.putObject({
          Bucket: this.bucket,
          Region: this.region,
          Key: entry.legacyObjectKey,
          Body: TOMBSTONE,
          ContentLength: TOMBSTONE.length,
          ContentType: 'application/octet-stream',
          CacheControl: 'no-store',
        });
        const protectedValue = await this.readObject(entry.legacyObjectKey);
        if (!protectedValue.equals(TOMBSTONE)) {
          throw new Error('历史公开合同对象覆盖校验失败');
        }
        await this.verifyLegacyPublicObjectProtected(entry.legacyObjectKey);
        entry.legacyProtectedAt = new Date().toISOString();
        entry.updatedAt = entry.legacyProtectedAt;
        await this.persistIndex();
      }

      if (entry.obsoleteObjectKeys?.length) {
        await this.deleteObsoleteSecureObjects(entry);
        entry.obsoleteObjectKeys = undefined;
        entry.updatedAt = new Date().toISOString();
        await this.persistIndex();
      }
    } catch (error) {
      const secureAssetsAvailable = Boolean(
        entry.objectKey && entry.sha256 && entry.pages.length > 0,
      );
      entry.state = secureAssetsAvailable ? 'queued' : 'failed';
      entry.error = safeErrorMessage(error);
      entry.updatedAt = new Date().toISOString();
      await this.persistIndex();
      throw error;
    } finally {
      if (temporaryDirectory)
        await cleanupTemporaryDirectory(temporaryDirectory);
    }
  }

  private async renderPreview(
    pdf: Buffer,
    outputDirectory: string,
    accessId: string,
  ): Promise<RenderManifest> {
    const result = await runPythonScript(
      join(process.cwd(), 'scripts', 'render-contract-pdf.py'),
      buildRenderPreviewArguments(outputDirectory, accessId),
      pdf,
      10 * 60 * 1000,
      1024 * 1024,
    );
    const parsed = JSON.parse(result) as RenderManifest;
    if (
      !Number.isInteger(parsed.pageCount) ||
      !Array.isArray(parsed.pages) ||
      parsed.pages.length !== parsed.pageCount
    ) {
      throw new Error('合同预览脚本返回格式无效');
    }
    return parsed;
  }

  private async putEncryptedObject(
    objectKey: string,
    plaintext: Buffer,
  ): Promise<void> {
    this.assertStorageEnabled();
    if (!this.cos || !this.encryptionKey) {
      throw new ServiceUnavailableException('合同附件安全存储未配置');
    }
    const encrypted = encryptContractBuffer(
      plaintext,
      this.encryptionKey,
      objectKey,
    );
    await this.cos.putObject({
      Bucket: this.bucket,
      Region: this.region,
      Key: objectKey,
      Body: encrypted,
      ContentLength: encrypted.length,
      ContentType: 'application/octet-stream',
      CacheControl: 'private, no-store',
    });
  }

  private async loadAttachmentForSync(
    entry: SecureStorageIndexEntry,
    source: SourceAttachment,
  ): Promise<DownloadedAttachment> {
    if (entry.objectKey && entry.sha256) {
      return {
        buffer: await this.readEncryptedObject(entry.objectKey),
        contentType: 'application/pdf',
      };
    }
    if (entry.legacyObjectKey && !entry.legacyProtectedAt) {
      const legacy = await this.readObject(entry.legacyObjectKey);
      if (!isMigrationTombstone(legacy)) {
        return { buffer: legacy, contentType: 'application/pdf' };
      }
      const orphanObjectKey = buildSecureContractObjectKey(
        this.securePrefix,
        entry.storageId,
        'original',
      );
      try {
        return {
          buffer: await this.readEncryptedObject(orphanObjectKey),
          contentType: 'application/pdf',
        };
      } catch (error) {
        if (source.url) return this.downloadAttachment(source);
        throw error;
      }
    }
    return this.downloadAttachment(source);
  }

  private async deleteObsoleteSecureObjects(
    entry: SecureStorageIndexEntry,
  ): Promise<void> {
    if (!this.cos) {
      throw new ServiceUnavailableException('合同附件对象存储未配置');
    }
    const activeKeys = new Set([
      entry.objectKey,
      ...entry.pages.map((page) => page.objectKey),
    ]);
    for (const objectKey of new Set(entry.obsoleteObjectKeys || [])) {
      if (!objectKey || activeKeys.has(objectKey)) continue;
      await this.cos.deleteObject({
        Bucket: this.bucket,
        Region: this.region,
        Key: objectKey,
      });
    }
  }

  private async readEncryptedObject(objectKey: string): Promise<Buffer> {
    if (!this.encryptionKey) {
      throw new ServiceUnavailableException('合同附件加密密钥未配置');
    }
    const encrypted = await this.readObject(objectKey);
    if (!isEncryptedContractEnvelope(encrypted)) {
      throw new Error('合同附件密文格式无效');
    }
    return decryptContractBuffer(encrypted, this.encryptionKey, objectKey);
  }

  private async readObject(objectKey: string): Promise<Buffer> {
    this.assertStorageEnabled();
    if (!this.cos) {
      throw new ServiceUnavailableException('合同附件对象存储未配置');
    }
    const result = await this.cos.getObject({
      Bucket: this.bucket,
      Region: this.region,
      Key: objectKey,
    });
    const body = (result as { Body?: unknown }).Body;
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === 'string') return Buffer.from(body);
    if (body instanceof Uint8Array) return Buffer.from(body);
    throw new Error('合同附件对象存储返回了无效内容');
  }

  private async verifyLegacyPublicObjectProtected(
    objectKey: string,
  ): Promise<void> {
    const response = await fetch(
      buildCosPublicObjectUrl(this.bucket, this.region, objectKey),
      {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        headers: {
          Range: 'bytes=0-1023',
          'Cache-Control': 'no-cache, no-store, max-age=0',
          Pragma: 'no-cache',
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.status === 403 || response.status === 404) return;
    if (response.status !== 200 && response.status !== 206) {
      throw new Error('历史公开合同地址匿名验证失败');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('历史公开合同地址未返回可验证内容');
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      while (bytes < 1024) {
        const current = await reader.read();
        if (current.done) break;
        const chunk = Buffer.from(current.value);
        chunks.push(chunk.subarray(0, Math.max(0, 1024 - bytes)));
        bytes += chunk.length;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (Buffer.concat(chunks).includes(Buffer.from('%PDF-', 'ascii'))) {
      throw new Error('历史公开合同地址仍可匿名读取 PDF');
    }
  }

  private async downloadAttachment(
    attachment: SourceAttachment,
  ): Promise<DownloadedAttachment> {
    let downloadUrl = attachment.url;
    if (isOfficialFeishuBatchDownloadUrl(downloadUrl)) {
      const tenantAccessToken = await this.getTenantAccessToken();
      downloadUrl = await this.resolveFeishuTmpDownloadUrl(
        downloadUrl,
        tenantAccessToken,
      );
    }
    if (!isTrustedFeishuAttachmentUrl(downloadUrl)) {
      throw new Error('飞书附件下载地址无效');
    }
    const response = await this.httpService.axiosRef.get<ArrayBuffer>(
      downloadUrl,
      {
        responseType: 'arraybuffer',
        timeout: 60_000,
        maxContentLength: MAX_ATTACHMENT_BYTES,
        maxBodyLength: MAX_ATTACHMENT_BYTES,
        maxRedirects: 0,
      },
    );
    const buffer = Buffer.from(response.data);
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new Error('合同附件超过 100MB 限制');
    }
    return {
      buffer,
      contentType: String(
        response.headers['content-type'] || 'application/pdf',
      ),
    };
  }

  private async resolveFeishuTmpDownloadUrl(
    batchUrl: string,
    tenantAccessToken: string,
  ): Promise<string> {
    if (!isOfficialFeishuBatchDownloadUrl(batchUrl)) {
      throw new Error('飞书附件批量下载地址无效');
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await this.httpService.axiosRef.get(batchUrl, {
          headers: { Authorization: `Bearer ${tenantAccessToken}` },
          timeout: 30_000,
          maxRedirects: 0,
        });
        const candidates = response.data?.data?.tmp_download_urls;
        if (Array.isArray(candidates)) {
          for (const candidate of candidates) {
            if (
              typeof candidate === 'string' &&
              isTrustedFeishuAttachmentUrl(candidate)
            ) {
              return candidate;
            }
            if (candidate && typeof candidate === 'object') {
              const item = candidate as Record<string, unknown>;
              const url =
                item.tmp_download_url || item.tmpDownloadUrl || item.url;
              if (typeof url === 'string' && isTrustedFeishuAttachmentUrl(url))
                return url;
            }
          }
        }
        throw new Error('飞书未返回附件临时下载地址');
      } catch (error) {
        if (!isFeishuRateLimitError(error) || attempt === 3) throw error;
        await delay(1000 * 2 ** attempt);
      }
    }
    throw new Error('飞书附件临时下载地址重试失败');
  }

  private async getTenantAccessToken(): Promise<string> {
    if (this.tenantToken && this.tenantToken.expiresAt > Date.now()) {
      return this.tenantToken.value;
    }
    const response = await this.httpService.axiosRef.post(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      getFeishuAuthPayload(),
      { timeout: 30_000 },
    );
    const value = String(response.data?.tenant_access_token || '').trim();
    if (!value) throw new Error('获取飞书访问令牌失败');
    const expiresIn = Number(response.data?.expire || 7200);
    this.tenantToken = {
      value,
      expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1000,
    };
    return value;
  }

  private createSecureEntry(
    contractRecordId: string,
    source: SourceAttachment,
    previous: StorageIndexEntry | undefined,
  ): SecureStorageIndexEntry {
    return createSecureStorageIndexEntry(
      contractRecordId,
      source.name,
      previous,
    );
  }

  private async getEntry(accessId: string): Promise<SecureStorageIndexEntry> {
    await this.ensureIndexLoaded();
    const entry = this.accessIndex.get(accessId);
    if (!entry) throw new NotFoundException('合同附件不存在');
    return entry;
  }

  private async ensureIndexLoaded(): Promise<void> {
    if (!this.storageEnabled) return;
    if (this.indexLoaded) return this.indexLoaded;
    this.indexLoaded = (async () => {
      let cosIndex: ContractStorageIndex | null = null;
      let localIndex: ContractStorageIndex | null = null;
      if (this.isConfigured()) {
        try {
          cosIndex = parseContractStorageIndex(
            await this.readEncryptedObject(this.indexObjectKey),
          );
        } catch (error) {
          const cosError = error as {
            statusCode?: unknown;
            code?: unknown;
          };
          const missing =
            Number(cosError.statusCode) === 404 ||
            ['NoSuchKey', 'NoSuchObject'].includes(String(cosError.code));
          if (!missing) {
            this.logger.error(
              `合同 COS 索引读取失败：${safeErrorMessage(error)}`,
            );
            throw error;
          }
        }
      }
      try {
        const content = await readFile(this.indexPath, 'utf8');
        localIndex = parseContractStorageIndex(content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          localIndex = null;
        } else if (cosIndex) {
          this.logger.warn(
            `合同本地索引缓存无效，已使用 COS 索引恢复：${safeErrorMessage(error)}`,
          );
        } else {
          this.logger.error(`合同附件索引读取失败：${safeErrorMessage(error)}`);
          throw error;
        }
      }
      const selected = selectContractStorageIndex(cosIndex, localIndex);
      this.indexRevision = getContractStorageIndexRevision(selected.index);
      this.index = stripContractStorageIndexMetadata(selected.index) as Record<
        string,
        StorageIndexEntry
      >;
      let changed = false;
      for (const [indexKey, value] of Object.entries(this.index)) {
        const normalized = normalizeStorageIndexEntryForStartup(
          indexKey,
          value,
        );
        if (normalized) {
          this.index[indexKey] = normalized;
          this.accessIndex.set(normalized.accessId, normalized);
          if (JSON.stringify(value) !== JSON.stringify(normalized)) {
            changed = true;
          }
        }
      }
      if (
        selected.source === 'cos' ||
        (selected.source === 'local' && this.isConfigured()) ||
        changed
      ) {
        await this.persistIndex();
      }
      if (selected.source === 'cos') {
        this.logger.log('合同附件与付款条款映射已从 COS 索引加载');
      } else if (selected.source === 'local' && this.isConfigured()) {
        this.logger.log('合同本地索引已迁移到 COS 加密索引');
      }
    })();
    return this.indexLoaded;
  }

  private persistIndexInBackground(): void {
    if (!this.storageEnabled) return;
    void this.persistIndex().catch((error: unknown) => {
      this.lastError = safeErrorMessage(error);
      this.logger.error(`合同附件索引后台持久化失败：${this.lastError}`);
    });
  }

  private persistIndex(): Promise<void> {
    if (!this.storageEnabled) {
      return Promise.reject(
        new ServiceUnavailableException('合同附件存储已禁用'),
      );
    }
    const queued = enqueueRecoverableWrite(this.persistChain, async () => {
      await mkdir(dirname(this.indexPath), { recursive: true });
      const temporaryPath = `${this.indexPath}.tmp`;
      const nextRevision = this.indexRevision + 1;
      const persistedIndex = buildVersionedContractStorageIndex(
        { ...this.index },
        nextRevision,
      );
      const serializedIndex = JSON.stringify(persistedIndex, null, 2);
      await writeFile(temporaryPath, serializedIndex, 'utf8');
      await rename(temporaryPath, this.indexPath);
      this.indexRevision = nextRevision;
      if (this.isConfigured()) {
        await this.putEncryptedObject(
          this.indexObjectKey,
          Buffer.from(serializedIndex, 'utf8'),
        );
      }
    });
    this.persistChain = queued.continuation;
    return queued.operation;
  }

  private cachePage(key: string, buffer: Buffer): void {
    const now = Date.now();
    for (const [cacheKey, value] of this.pageCache) {
      if (value.expiresAt <= now) this.pageCache.delete(cacheKey);
    }
    while (this.pageCache.size >= MAX_PAGE_CACHE_ENTRIES) {
      const first = this.pageCache.keys().next().value as string | undefined;
      if (!first) break;
      this.pageCache.delete(first);
    }
    this.pageCache.set(key, { buffer, expiresAt: now + PAGE_CACHE_TTL_MS });
  }
}

function extractSourceAttachments(value: unknown): SourceAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const source = item as Record<string, unknown>;
    const url = displayText(source.tmp_url || source.url);
    if (!url) return [];
    return [
      {
        name: displayText(source.name) || '合同附件.pdf',
        url,
        fileToken:
          displayText(source.file_token || source.fileToken || source.token) ||
          undefined,
      },
    ];
  });
}

function displayText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value))
    return value.map(displayText).filter(Boolean).join('');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of ['text', 'name', 'value', 'url', 'tmp_url']) {
    const text = displayText(record[key]);
    if (text) return text;
  }
  return '';
}

export function extractFeishuAttachmentToken(value: string): string {
  try {
    const url = new URL(value);
    for (const key of ['file_tokens', 'file_token']) {
      const token = url.searchParams.get(key)?.split(',')[0]?.trim();
      if (token) return token;
    }
    const pathMatch = url.pathname.match(/\/medias\/([^/]+)\/download\/?$/i);
    if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]).trim();
  } catch {
    return '';
  }
  return '';
}

export function buildContractAttachmentIndexKey(
  contractRecordId: string,
  attachment: SourceAttachment,
  sourceIndex = 0,
): string {
  const fileToken =
    attachment.fileToken?.trim() ||
    extractFeishuAttachmentToken(attachment.url);
  const identity = fileToken
    ? fileToken
    : `slot:${sourceIndex}:${sha256Text(
        attachment.name.trim().normalize('NFKC').toLocaleLowerCase(),
      ).slice(0, 20)}`;
  return `${contractRecordId}:${identity}`;
}

export function normalizeContractAttachmentBusinessName(value: string): string {
  return value
    .trim()
    .normalize('NFKC')
    .replace(/^[a-f0-9]{16}-/i, '')
    .toLocaleLowerCase();
}

export function resolveContractAttachmentIndexKey(
  index: Record<string, unknown>,
  contractRecordId: string,
  attachment: SourceAttachment,
  sourceIndex = 0,
): { indexKey: string; previousKey?: string; contentMatchKey?: string } {
  const indexKey = buildContractAttachmentIndexKey(
    contractRecordId,
    attachment,
    sourceIndex,
  );
  const hasCurrentEntry = Object.prototype.hasOwnProperty.call(index, indexKey);

  const legacyUrlKey = `${contractRecordId}:${sha256Text(attachment.url).slice(
    0,
    32,
  )}`;
  if (
    !hasCurrentEntry &&
    legacyUrlKey !== indexKey &&
    Object.prototype.hasOwnProperty.call(index, legacyUrlKey)
  ) {
    return { indexKey, previousKey: legacyUrlKey };
  }

  const hasStableToken = Boolean(
    attachment.fileToken?.trim() ||
    extractFeishuAttachmentToken(attachment.url),
  );
  const normalizedName = normalizeContractAttachmentBusinessName(
    attachment.name,
  );
  const legacyKeyPrefix = `${contractRecordId}:`;
  const candidates = Object.entries(index).filter(([candidateKey, value]) => {
    if (candidateKey === indexKey || !value || typeof value !== 'object') {
      return false;
    }
    if (!candidateKey.startsWith(legacyKeyPrefix)) return false;
    const entry = value as {
      contractRecordId?: unknown;
      name?: unknown;
    };
    return (
      entry.contractRecordId === contractRecordId &&
      typeof entry.name === 'string' &&
      normalizeContractAttachmentBusinessName(entry.name) === normalizedName
    );
  });
  if (candidates.length === 1) {
    if (!hasStableToken) {
      return { indexKey, previousKey: candidates[0][0] };
    }
    return { indexKey, contentMatchKey: candidates[0][0] };
  }

  return { indexKey };
}

export function canReuseContractAttachmentContent(
  value: unknown,
  digest: string,
): boolean {
  if (!value || typeof value !== 'object') return false;
  const entry = value as {
    state?: unknown;
    sha256?: unknown;
    objectKey?: unknown;
    pages?: unknown;
  };
  return (
    entry.state === 'ready' &&
    entry.sha256 === digest &&
    typeof entry.objectKey === 'string' &&
    Array.isArray(entry.pages) &&
    entry.pages.length > 0
  );
}

function createSecureStorageIndexEntry(
  contractRecordId: string,
  name: string,
  previous: unknown,
): SecureStorageIndexEntry {
  const now = new Date().toISOString();
  return {
    version: 3,
    accessId: randomBytes(18).toString('base64url'),
    storageId: randomBytes(24).toString('base64url'),
    contractRecordId,
    name: name || '合同原件.pdf',
    state: 'queued',
    legacyObjectKey: isLegacyEntry(previous) ? previous.objectKey : undefined,
    pageCount: 0,
    pages: [],
    createdAt: now,
    updatedAt: now,
  };
}

function isSecureEntry(value: unknown): value is SecureStorageIndexEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<SecureStorageIndexEntry>;
  return (
    entry.version === 3 &&
    typeof entry.accessId === 'string' &&
    typeof entry.storageId === 'string' &&
    typeof entry.name === 'string' &&
    Array.isArray(entry.pages)
  );
}

function isLegacyEntry(value: unknown): value is LegacyStorageIndexEntry {
  if (!value || typeof value !== 'object') return false;
  const version = (value as { version?: unknown }).version;
  if (version === 2 || version === 3) return false;
  return (
    typeof (value as LegacyStorageIndexEntry).objectKey === 'string' &&
    !isSecureEntry(value)
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function loadEncryptionKey(): Buffer | null {
  try {
    const value = readEnv('CONTRACT_ATTACHMENT_ENCRYPTION_KEY');
    return value ? parseContractEncryptionKey(value) : null;
  } catch {
    return null;
  }
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Buffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeDownloadFileName(value: string): string {
  const normalized = value
    .replace(/[\r\n\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim()
    .slice(0, 160);
  return normalized.toLowerCase().endsWith('.pdf')
    ? normalized || '合同原件.pdf'
    : `${normalized || '合同原件'}.pdf`;
}

function safeFileLabel(value: string): string {
  return basename(value)
    .replace(/[\r\n]/g, ' ')
    .slice(0, 80);
}

export function buildLocalProcessorEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      LOCAL_PROCESSOR_ENVIRONMENT_KEYS.has(key.toUpperCase())
    ) {
      environment[key] = value;
    }
  }
  environment.PYTHONUTF8 = '1';
  environment.PYTHONIOENCODING = 'utf-8';
  return environment;
}

export async function runPythonScript(
  scriptPath: string,
  args: string[],
  input: Buffer | undefined,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      readEnv('PYTHON_EXECUTABLE') || 'python',
      [scriptPath, ...args],
      {
        cwd: process.cwd(),
        windowsHide: true,
        shell: false,
        env: buildLocalProcessorEnvironment(process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let stdinClosedEarly = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('合同本地处理超时'));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        child.kill();
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < 16 * 1024) stderr.push(Buffer.from(chunk));
      stderrBytes += chunk.length;
    });
    child.stdin.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code === 'EPIPE' ||
        code === 'EOF' ||
        /\b(?:EPIPE|EOF)\b/i.test(error.message)
      ) {
        stdinClosedEarly = true;
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutBytes > maxOutputBytes) {
        reject(new Error('合同本地处理输出超过限制'));
        return;
      }
      if (code !== 0) {
        const message = Buffer.concat(stderr)
          .toString('utf8')
          .replace(/[\r\n]+/g, ' ')
          .slice(-300);
        reject(new Error(`合同本地处理失败${message ? `：${message}` : ''}`));
        return;
      }
      if (stdinClosedEarly) {
        reject(new Error('合同本地处理未完整读取输入'));
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString('utf8').trim());
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function cleanupTemporaryDirectory(path: string): Promise<void> {
  const root = `${resolve(tmpdir())}${sep}`.toLowerCase();
  const target = resolve(path);
  if (
    !target.toLowerCase().startsWith(root) ||
    !basename(target).startsWith(PREVIEW_DIRECTORY_PREFIX)
  ) {
    throw new Error('拒绝清理非合同临时目录');
  }
  await rm(target, { recursive: true, force: true });
}

async function createPreviewTemporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), `${PREVIEW_DIRECTORY_PREFIX}${process.pid}-`));
}

async function cleanupStalePreviewDirectories(): Promise<void> {
  const root = tmpdir();
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !entry.name.startsWith(PREVIEW_DIRECTORY_PREFIX)
    ) {
      continue;
    }
    const path = join(root, entry.name);
    try {
      const metadata = await stat(path);
      if (
        shouldRemoveStalePreviewDirectory(
          entry.name,
          metadata.mtimeMs,
          Date.now(),
          isProcessAlive,
        )
      ) {
        await cleanupTemporaryDirectory(path);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isFeishuRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const response = (error as { response?: { data?: { code?: unknown } } })
    .response;
  return Number(response?.data?.code) === 99991400;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '未知错误';
  return error.message
    .replace(/(secret|token|authorization|cookie)[=:]\s*[^\s&]+/gi, '$1=***')
    .slice(0, 300);
}
