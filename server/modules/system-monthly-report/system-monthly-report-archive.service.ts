import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  type OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import * as XLSX from 'xlsx-js-style';
// SDK uses `export =`; TypeScript's import-assignment is required without esModuleInterop.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import COS = require('cos-nodejs-sdk-v5');
import type {
  SystemMonthlyReportHistoryItem,
  SystemMonthlyReportArchiveStatus,
  SystemMonthlyReportArchivePreview,
  SystemMonthlyReportReviewOpinion,
  SystemMonthlyReportSubmissionRequest,
} from '../../../shared/system-monthly-report.interface';
import {
  SYSTEM_MONTHLY_REPORT_MAX_FINAL_ATTACHMENT_BYTES,
  SystemMonthlyReportGateway,
} from './system-monthly-report.gateway';
import {
  SystemMonthlyReportArchiveStore,
  buildSystemMonthlyReportArchiveId,
  type SystemMonthlyReportArchiveEntry,
} from './system-monthly-report-archive.store';
import type {
  SystemMonthlyReportFinalAttachmentSource,
  SystemMonthlyReportFinalRecordSource,
  SystemMonthlyReportReviewOpinionSource,
} from './system-monthly-report.mapper';
import type { SystemMonthlyReportStagedFile } from './system-monthly-report-task.store';

const DEFAULT_BUCKET = 'jy-1421907124';
const DEFAULT_REGION = 'ap-shanghai';
const DEFAULT_PREFIX = 'system-monthly-report/v1';
const MAX_SIGNED_URL_SECONDS = 3600;
const MAX_PREVIEW_ROWS = 200;
const MAX_PREVIEW_COLUMNS = 40;
const MAX_PREVIEW_SHEETS = 12;
const MAX_PREVIEW_CELL_CHARACTERS = 500;
const PREVIEW_CACHE_TTL_MS = 5 * 60 * 1000;

export const SYSTEM_MONTHLY_REPORT_ARCHIVE_OPTIONS =
  'SYSTEM_MONTHLY_REPORT_ARCHIVE_OPTIONS';

export interface SystemMonthlyReportArchiveCosClient {
  putObject(params: COS.PutObjectParams): Promise<unknown>;
  headObject(params: COS.HeadObjectParams): Promise<unknown>;
  deleteObject?(params: COS.DeleteObjectParams): Promise<unknown>;
  getObject?(params: COS.GetObjectParams): Promise<unknown>;
  getObjectUrl(params: COS.GetObjectUrlParams): string;
}

export interface SystemMonthlyReportArchiveOptions {
  cos?: SystemMonthlyReportArchiveCosClient | null;
  env?: NodeJS.ProcessEnv;
  indexPath?: string;
}

export interface SystemMonthlyReportArchiveDownload {
  url: string;
  name: string;
  expiresInSeconds: number;
}

@Injectable()
export class SystemMonthlyReportArchiveService implements OnModuleInit {
  private readonly logger = new Logger(SystemMonthlyReportArchiveService.name);
  private readonly bucket: string;
  private readonly region: string;
  private readonly prefix: string;
  private readonly cos: SystemMonthlyReportArchiveCosClient | null;
  private readonly store: SystemMonthlyReportArchiveStore;
  private queueTail: Promise<void> = Promise.resolve();
  private readonly queuedIds = new Set<string>();
  private readonly previewCache = new Map<
    string,
    { expiresAt: number; value: SystemMonthlyReportArchivePreview }
  >();

  constructor(
    private readonly gateway: SystemMonthlyReportGateway,
    @Optional()
    @Inject(SYSTEM_MONTHLY_REPORT_ARCHIVE_OPTIONS)
    options: SystemMonthlyReportArchiveOptions = {},
  ) {
    const env = options.env || process.env;
    this.bucket =
      readEnv(
        env,
        'COS_SYSTEM_MONTHLY_REPORT_BUCKET',
        'COS_CHANGE_BUCKET',
        'COS_BUCKET',
      ) || DEFAULT_BUCKET;
    this.region =
      readEnv(
        env,
        'COS_SYSTEM_MONTHLY_REPORT_REGION',
        'COS_CHANGE_REGION',
        'COS_REGION',
      ) || DEFAULT_REGION;
    this.prefix = normalizePrefix(
      readEnv(env, 'COS_SYSTEM_MONTHLY_REPORT_PREFIX') || DEFAULT_PREFIX,
    );
    const runtimeDirectory = resolve(
      env.SYSTEM_MONTHLY_REPORT_RUNTIME_DIR ||
        resolve(process.cwd(), '.runtime', 'system-monthly-report'),
    );
    this.store = new SystemMonthlyReportArchiveStore(
      options.indexPath ||
        readEnv(env, 'SYSTEM_MONTHLY_REPORT_ARCHIVE_INDEX_PATH') ||
        join(runtimeDirectory, 'archives.json'),
    );

    if (Object.prototype.hasOwnProperty.call(options, 'cos')) {
      this.cos = options.cos || null;
      return;
    }
    const secretId = readEnv(env, 'COS_SECRET_ID', 'TENCENTCLOUD_SECRET_ID');
    const secretKey = readEnv(env, 'COS_SECRET_KEY', 'TENCENTCLOUD_SECRET_KEY');
    const securityToken = readEnv(
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
            ChunkParallelLimit: 2,
            Timeout: 60_000,
          })
        : null;
  }

  onModuleInit(): void {
    for (const entry of this.store.listRecoverable()) this.enqueue(entry.id);
  }

  discover(sources: SystemMonthlyReportFinalRecordSource[]): void {
    for (const source of sources) {
      for (const attachment of source.attachments) {
        const id = buildSystemMonthlyReportArchiveId(
          source.recordId,
          attachment.fileToken,
        );
        const reserved = this.store.reserve({
          id,
          sourceRecordId: source.recordId,
          sourceFileToken: attachment.fileToken,
          year: source.year,
          month: source.month,
          room: source.room,
          name: safeFileName(attachment.name),
          size: normalizeSourceSize(attachment.size),
          objectKey: buildSystemMonthlyReportArchiveObjectKey(
            this.prefix,
            source,
            attachment,
          ),
          sourceFieldName: '终版月报',
          category: 'final',
        });
        if (
          reserved.created ||
          ['pending', 'syncing'].includes(reserved.entry.status)
        ) {
          this.enqueue(id);
        }
      }
    }
  }

  discoverReviewImages(
    sources: SystemMonthlyReportReviewOpinionSource[],
  ): void {
    for (const source of sources) {
      for (const attachment of source.attachments) {
        const id = buildSystemMonthlyReportArchiveId(
          source.opinion.recordId,
          attachment.fileToken,
        );
        const reserved = this.store.reserve({
          id,
          sourceRecordId: source.opinion.recordId,
          sourceFileToken: attachment.fileToken,
          year: source.opinion.year,
          month: source.opinion.month,
          room: source.opinion.room,
          name: safeFileName(attachment.name),
          size: normalizeSourceSize(attachment.size),
          objectKey: buildSystemMonthlyReportReviewImageObjectKey(
            this.prefix,
            source,
            attachment,
          ),
          sourceFieldName: source.sourceFieldName,
          category: 'review',
          reviewRound: source.opinion.round,
        });
        if (
          reserved.created ||
          ['pending', 'syncing'].includes(reserved.entry.status)
        ) {
          this.enqueue(id);
        }
      }
    }
  }

  decorateReviewOpinions(
    opinions: SystemMonthlyReportReviewOpinion[],
    sources: SystemMonthlyReportReviewOpinionSource[],
  ): SystemMonthlyReportReviewOpinion[] {
    const sourceByKey = new Map(
      sources.map((source) => [
        `${source.opinion.recordId}\u001f${source.opinion.round}`,
        source,
      ]),
    );
    return opinions.map((opinion) => {
      const source = sourceByKey.get(
        `${opinion.recordId}\u001f${opinion.round}`,
      );
      if (!source) return opinion;
      return {
        ...opinion,
        images: source.attachments.map((attachment) => {
          const id = buildSystemMonthlyReportArchiveId(
            source.opinion.recordId,
            attachment.fileToken,
          );
          const entry = this.store.get(id);
          const status = entry?.status || 'pending';
          return {
            id,
            name: safeFileName(attachment.name),
            size: entry?.size || normalizeSourceSize(attachment.size),
            status,
            retryable: status === 'error',
            message: archiveMessage(status, entry?.lastError),
          };
        }),
      };
    });
  }

  decorateHistory(
    history: SystemMonthlyReportHistoryItem[],
    sources: SystemMonthlyReportFinalRecordSource[],
  ): SystemMonthlyReportHistoryItem[] {
    const sourceByRecord = new Map(
      sources.map((source) => [source.recordId, source]),
    );
    return history.map((item) => {
      const source = sourceByRecord.get(item.recordId);
      if (!source) return item;
      const attachments = source.attachments.map((attachment) => {
        const id = buildSystemMonthlyReportArchiveId(
          source.recordId,
          attachment.fileToken,
        );
        const entry = this.store.get(id);
        const status = entry?.status || 'pending';
        return {
          id,
          name: safeFileName(attachment.name),
          size: entry?.size || normalizeSourceSize(attachment.size),
          status,
          retryable: status === 'error',
          message: archiveMessage(status, entry?.lastError),
        };
      });
      const archiveStatus = aggregateArchiveStatus(
        attachments.map((attachment) => attachment.status),
      );
      return {
        ...item,
        archiveStatus,
        archivedAttachmentCount: attachments.filter(
          (attachment) => attachment.status === 'archived',
        ).length,
        attachments,
      };
    });
  }

  getSignedDownload(
    archiveId: string,
    expiresInSeconds = 300,
    disposition: 'attachment' | 'inline' = 'attachment',
  ): SystemMonthlyReportArchiveDownload {
    const entry = this.store.get(archiveId);
    if (!entry) throw new NotFoundException('体系月报归档附件不存在');
    if (entry.status !== 'archived') {
      throw new BadRequestException('体系月报附件尚未完成 COS 归档');
    }
    if (
      !Number.isInteger(expiresInSeconds) ||
      expiresInSeconds < 30 ||
      expiresInSeconds > MAX_SIGNED_URL_SECONDS
    ) {
      throw new BadRequestException('下载链接有效期无效');
    }
    try {
      return {
        url: this.requireCos().getObjectUrl({
          Bucket: this.bucket,
          Region: this.region,
          Key: entry.objectKey,
          Sign: true,
          Method: 'GET',
          Expires: expiresInSeconds,
          Query: {
            'response-content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
            'response-content-type':
              entry.contentType || contentTypeFromName(entry.name),
          },
        }),
        name: entry.name,
        expiresInSeconds,
      };
    } catch {
      throw new ServiceUnavailableException('生成体系月报 COS 下载地址失败');
    }
  }

  async getPreview(
    archiveId: string,
  ): Promise<SystemMonthlyReportArchivePreview> {
    const entry = this.store.get(archiveId);
    if (!entry) throw new NotFoundException('体系月报归档附件不存在');
    if (entry.status !== 'archived') {
      throw new BadRequestException('体系月报附件尚未完成 COS 归档');
    }
    const extension = extname(entry.name).toLowerCase();
    if (extension === '.pdf') {
      return {
        kind: 'pdf',
        ...this.getSignedDownload(archiveId, 300, 'inline'),
      };
    }
    if (extension !== '.xlsx' && extension !== '.xls') {
      throw new BadRequestException('该附件格式暂不支持在线预览');
    }
    const cached = this.previewCache.get(archiveId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const buffer = await this.readArchivedFile(archiveId);
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(buffer, {
        type: 'buffer',
        dense: true,
        sheetRows: MAX_PREVIEW_ROWS + 1,
        cellFormula: false,
        cellHTML: false,
        cellStyles: false,
        bookVBA: false,
        bookFiles: false,
      });
    } catch {
      throw new BadRequestException('该月报无法生成在线预览，请下载后查看');
    }
    const selectedNames = workbook.SheetNames.slice(0, MAX_PREVIEW_SHEETS);
    const sheets = selectedNames.map((name) => {
      const worksheet = workbook.Sheets[name];
      const rows = XLSX.utils
        .sheet_to_json<unknown[]>(worksheet, {
          header: 1,
          raw: false,
          defval: '',
          blankrows: false,
        })
        .slice(0, MAX_PREVIEW_ROWS)
        .map((row) =>
          row
            .slice(0, MAX_PREVIEW_COLUMNS)
            .map((cell) => previewCellText(cell)),
        );
      const dimensions = worksheetDimensions(worksheet, rows);
      return {
        name: String(name).slice(0, 100),
        rows,
        totalRows: dimensions.rows,
        totalColumns: dimensions.columns,
        truncated:
          dimensions.rows > MAX_PREVIEW_ROWS ||
          dimensions.columns > MAX_PREVIEW_COLUMNS,
      };
    });
    const value: SystemMonthlyReportArchivePreview = {
      kind: 'spreadsheet',
      name: entry.name,
      sheets,
      truncated:
        workbook.SheetNames.length > selectedNames.length ||
        sheets.some((sheet) => sheet.truncated),
    };
    this.previewCache.set(archiveId, {
      expiresAt: Date.now() + PREVIEW_CACHE_TTL_MS,
      value,
    });
    return value;
  }

  getArchiveDescriptor(archiveId: string): {
    room: string;
    year: number;
    month: number;
    category: 'final' | 'review';
    reviewRound?: 'initial' | 'recheck';
  } {
    const entry = this.store.get(archiveId);
    if (!entry) throw new NotFoundException('体系月报归档附件不存在');
    return {
      room: entry.room,
      year: entry.year,
      month: entry.month,
      category: entry.category || 'final',
      reviewRound: entry.reviewRound,
    };
  }

  retry(archiveId: string): SystemMonthlyReportArchiveEntry {
    const entry = this.store.get(archiveId);
    if (!entry) throw new NotFoundException('体系月报归档任务不存在');
    if (entry.status !== 'error') {
      throw new BadRequestException('当前归档任务不需要重试');
    }
    const updated = this.store.update(archiveId, {
      status: 'pending',
      lastError: undefined,
    });
    this.enqueue(archiveId);
    return updated;
  }

  listArchivedFinals(
    year: number,
    month: number,
  ): Array<{
    archiveId: string;
    room: string;
    name: string;
  }> {
    const entries = this.store
      .list()
      .filter(
        (entry) =>
          entry.year === year &&
          entry.month === month &&
          entry.status === 'archived' &&
          (entry.category === 'final' ||
            (!entry.category &&
              (entry.sourceFieldName || '终版月报') === '终版月报')),
      );
    const latestSourceByRoom = new Map<
      string,
      { sourceRecordId: string; updatedAt: string }
    >();
    for (const entry of entries) {
      const previous = latestSourceByRoom.get(entry.room);
      if (!previous || entry.updatedAt > previous.updatedAt) {
        latestSourceByRoom.set(entry.room, {
          sourceRecordId: entry.sourceRecordId,
          updatedAt: entry.updatedAt,
        });
      }
    }
    return entries
      .filter(
        (entry) =>
          latestSourceByRoom.get(entry.room)?.sourceRecordId ===
          entry.sourceRecordId,
      )
      .map((entry) => ({
        archiveId: entry.id,
        room: entry.room,
        name: entry.name,
      }))
      .sort((left, right) => left.room.localeCompare(right.room, 'zh-CN'));
  }

  async readArchivedFile(archiveId: string): Promise<Buffer> {
    const entry = this.store.get(archiveId);
    if (!entry || entry.status !== 'archived') {
      throw new BadRequestException('体系月报 COS 附件尚不可打包');
    }
    const cos = this.requireCos();
    if (!cos.getObject)
      throw new ServiceUnavailableException('COS 读取能力不可用');
    const result = await cos.getObject({
      Bucket: this.bucket,
      Region: this.region,
      Key: entry.objectKey,
    });
    const body = responseBody(result);
    if (!body.length || body.length !== entry.size) {
      throw new ServiceUnavailableException('COS 月报附件读取不完整');
    }
    return body;
  }

  async uploadPackage(
    taskId: string,
    fileName: string,
    buffer: Buffer,
  ): Promise<{ objectKey: string }> {
    if (!buffer.length) throw new BadRequestException('月报压缩包不能为空');
    const objectKey = [
      this.prefix,
      'packages',
      safeObjectSegment(taskId),
      safeFileName(fileName),
    ].join('/');
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    await this.requireCos().putObject({
      Bucket: this.bucket,
      Region: this.region,
      Key: objectKey,
      Body: buffer,
      ContentLength: buffer.length,
      ContentType: 'application/zip',
      ContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(safeFileName(fileName))}`,
      CacheControl: 'private, no-store',
      'x-cos-meta-sha256': sha256,
    });
    const head = await this.requireCos().headObject({
      Bucket: this.bucket,
      Region: this.region,
      Key: objectKey,
    });
    if (Number(responseHeader(head, 'content-length')) !== buffer.length) {
      throw new ServiceUnavailableException('COS 月报压缩包大小校验失败');
    }
    return { objectKey };
  }

  async uploadStagedSubmission(
    taskId: string,
    request: SystemMonthlyReportSubmissionRequest,
    file: SystemMonthlyReportStagedFile,
  ): Promise<{ objectKey: string; size: number; sha256: string }> {
    const buffer = await readFile(file.path);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    if (
      !buffer.length ||
      buffer.length !== file.size ||
      sha256 !== file.sha256
    ) {
      throw new BadRequestException('待同步 COS 的月报附件已损坏');
    }
    const objectKey = [
      this.prefix,
      'submissions',
      String(request.reportYear),
      String(request.reportMonth).padStart(2, '0'),
      safeObjectSegment(request.room),
      request.stage,
      safeObjectSegment(taskId),
      safeFileName(request.versionedFileName),
    ].join('/');
    await this.requireCos().putObject({
      Bucket: this.bucket,
      Region: this.region,
      Key: objectKey,
      Body: buffer,
      ContentLength: buffer.length,
      ContentType: normalizeContentType(file.mimeType),
      ContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(safeFileName(request.versionedFileName))}`,
      CacheControl: 'private, no-store',
      'x-cos-meta-sha256': sha256,
    });
    const head = await this.requireCos().headObject({
      Bucket: this.bucket,
      Region: this.region,
      Key: objectKey,
    });
    if (Number(responseHeader(head, 'content-length')) !== buffer.length) {
      throw new ServiceUnavailableException('COS 月报附件大小校验失败');
    }
    return { objectKey, size: buffer.length, sha256 };
  }

  async deleteSubmissionObjects(objectKeys: string[]): Promise<void> {
    if (!objectKeys.length) return;
    const cos = this.requireCos();
    if (!cos.deleteObject) {
      throw new ServiceUnavailableException('对象存储删除能力不可用');
    }
    for (const objectKey of Array.from(new Set(objectKeys))) {
      if (!objectKey.startsWith(`${this.prefix}/submissions/`)) {
        throw new BadRequestException('月报附件对象标识无效');
      }
      await cos.deleteObject({
        Bucket: this.bucket,
        Region: this.region,
        Key: objectKey,
      });
    }
  }

  bindFinalSubmissionObject(
    sourceRecordId: string,
    sourceFileToken: string,
    request: SystemMonthlyReportSubmissionRequest,
    object: { objectKey: string; size: number; sha256: string },
  ): void {
    if (request.stage !== 'final') return;
    const id = buildSystemMonthlyReportArchiveId(
      sourceRecordId,
      sourceFileToken,
    );
    this.store.reserve({
      id,
      sourceRecordId,
      sourceFileToken,
      year: request.reportYear,
      month: request.reportMonth,
      room: request.room,
      name: safeFileName(request.versionedFileName),
      size: object.size,
      objectKey: object.objectKey,
      sourceFieldName: '终版月报',
      category: 'final',
    });
    this.store.update(id, {
      status: 'archived',
      step: 'complete',
      size: object.size,
      sha256: object.sha256,
      lastError: undefined,
    });
  }

  getPackageDownload(objectKey: string, expiresInSeconds = 3600) {
    if (!objectKey.startsWith(`${this.prefix}/packages/`)) {
      throw new BadRequestException('月报压缩包对象标识无效');
    }
    return {
      url: this.requireCos().getObjectUrl({
        Bucket: this.bucket,
        Region: this.region,
        Key: objectKey,
        Sign: true,
        Method: 'GET',
        Expires: expiresInSeconds,
      }),
      expiresInSeconds,
    };
  }

  async waitForIdle(): Promise<void> {
    await this.queueTail;
  }

  private enqueue(id: string): void {
    if (this.queuedIds.has(id)) return;
    this.queuedIds.add(id);
    this.queueTail = this.queueTail
      .then(() => this.process(id))
      .catch((error) => {
        this.logger.error(
          `体系月报 COS 归档任务异常：${safeErrorMessage(error)}`,
        );
      })
      .finally(() => this.queuedIds.delete(id));
  }

  private async process(id: string): Promise<void> {
    let entry = this.store.get(id);
    if (!entry || entry.status === 'archived') return;
    try {
      this.requireCos();
      entry = this.store.update(id, {
        status: 'syncing',
        attempts: entry.attempts + 1,
        lastError: undefined,
      });
      if (entry.step === 'verify') {
        await this.verify(entry);
        this.store.update(id, {
          status: 'archived',
          step: 'complete',
          lastError: undefined,
        });
        return;
      }

      const sourceFieldName = entry.sourceFieldName || '终版月报';
      const genericGateway = this.gateway as SystemMonthlyReportGateway & {
        downloadCollectionAttachment?: SystemMonthlyReportGateway['downloadCollectionAttachment'];
      };
      const downloaded = genericGateway.downloadCollectionAttachment
        ? await genericGateway.downloadCollectionAttachment(
            entry.sourceRecordId,
            entry.sourceFileToken,
            sourceFieldName,
          )
        : await this.gateway.downloadFinalAttachment(
            entry.sourceRecordId,
            entry.sourceFileToken,
          );
      if (
        !downloaded.buffer.length ||
        downloaded.buffer.length >
          SYSTEM_MONTHLY_REPORT_MAX_FINAL_ATTACHMENT_BYTES
      ) {
        throw new Error('飞书终版附件为空或超过 256 MB');
      }
      if (entry.size > 0 && entry.size !== downloaded.buffer.length) {
        throw new Error('飞书终版附件大小与多维表元数据不一致');
      }
      const sha256 = createHash('sha256')
        .update(downloaded.buffer)
        .digest('hex');
      entry = this.store.update(id, {
        status: 'syncing',
        step: 'upload',
        size: downloaded.buffer.length,
        contentType: normalizeContentType(downloaded.contentType),
        sha256,
      });
      const result = await this.requireCos().putObject({
        Bucket: this.bucket,
        Region: this.region,
        Key: entry.objectKey,
        Body: downloaded.buffer,
        ContentLength: downloaded.buffer.length,
        ContentType: entry.contentType,
        ContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
        CacheControl: 'private, no-store',
        'x-cos-meta-sha256': sha256,
      });
      entry = this.store.update(id, {
        status: 'syncing',
        step: 'verify',
        etag: responseText(result, 'ETag'),
      });
      await this.verify(entry);
      this.store.update(id, {
        status: 'archived',
        step: 'complete',
        lastError: undefined,
      });
    } catch (error) {
      this.store.update(id, {
        status: 'error',
        lastError: safeErrorMessage(error),
      });
    }
  }

  private async verify(entry: SystemMonthlyReportArchiveEntry): Promise<void> {
    const result = await this.requireCos().headObject({
      Bucket: this.bucket,
      Region: this.region,
      Key: entry.objectKey,
    });
    const contentLength = Number(responseHeader(result, 'content-length'));
    if (!Number.isSafeInteger(contentLength) || contentLength !== entry.size) {
      throw new Error('COS 归档对象大小校验失败');
    }
    const remoteSha256 = responseHeader(result, 'x-cos-meta-sha256');
    if (remoteSha256 && entry.sha256 && remoteSha256 !== entry.sha256) {
      throw new Error('COS 归档对象摘要校验失败');
    }
  }

  private requireCos(): SystemMonthlyReportArchiveCosClient {
    if (!this.cos) {
      throw new ServiceUnavailableException('体系月报 COS 对象存储尚未配置');
    }
    return this.cos;
  }
}

export function buildSystemMonthlyReportArchiveObjectKey(
  prefix: string,
  source: SystemMonthlyReportFinalRecordSource,
  attachment: SystemMonthlyReportFinalAttachmentSource,
): string {
  const normalizedPrefix = normalizePrefix(prefix);
  const digest = createHash('sha256')
    .update(`${source.recordId}\u001f${attachment.fileToken}`)
    .digest('hex')
    .slice(0, 20);
  return [
    normalizedPrefix,
    String(source.year),
    String(source.month).padStart(2, '0'),
    safeObjectSegment(source.room),
    digest,
    safeFileName(attachment.name),
  ].join('/');
}

export function buildSystemMonthlyReportReviewImageObjectKey(
  prefix: string,
  source: SystemMonthlyReportReviewOpinionSource,
  attachment: SystemMonthlyReportFinalAttachmentSource,
): string {
  const digest = createHash('sha256')
    .update(`${source.opinion.recordId}\u001f${attachment.fileToken}`)
    .digest('hex')
    .slice(0, 20);
  return [
    normalizePrefix(prefix),
    'reviews',
    String(source.opinion.year),
    String(source.opinion.month).padStart(2, '0'),
    safeObjectSegment(source.opinion.room),
    source.opinion.round,
    digest,
    safeFileName(attachment.name),
  ].join('/');
}

function aggregateArchiveStatus(
  statuses: SystemMonthlyReportArchiveStatus[],
): SystemMonthlyReportArchiveStatus {
  if (!statuses.length) return 'pending';
  if (statuses.some((status) => status === 'error')) return 'error';
  if (statuses.every((status) => status === 'archived')) return 'archived';
  if (statuses.some((status) => status === 'syncing')) return 'syncing';
  return 'pending';
}

function archiveMessage(
  status: SystemMonthlyReportArchiveStatus,
  lastError?: string,
): string {
  if (status === 'archived') return 'COS 已归档';
  if (status === 'syncing') return '正在归档到 COS';
  if (status === 'error') return lastError || 'COS 归档失败';
  return '等待归档到 COS';
}

function normalizePrefix(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (
    !normalized ||
    normalized
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('体系月报 COS 前缀配置无效');
  }
  return normalized;
}

function safeObjectSegment(value: string): string {
  return (
    value
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'room'
  );
}

function safeFileName(value: string): string {
  return (
    value
      .normalize('NFKC')
      .replace(/[\r\n\\/:*?"<>|\x00-\x1f]/g, '_')
      .trim()
      .slice(0, 180) || '体系月报终版附件'
  );
}

function normalizeSourceSize(value: number): number {
  return Number.isSafeInteger(value) &&
    value > 0 &&
    value <= SYSTEM_MONTHLY_REPORT_MAX_FINAL_ATTACHMENT_BYTES
    ? value
    : 0;
}

function normalizeContentType(value: string): string {
  const normalized = String(value || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(
    normalized,
  )
    ? normalized
    : 'application/octet-stream';
}

function contentTypeFromName(name: string): string {
  const extension = extname(name).toLowerCase();
  if (extension === '.pdf') return 'application/pdf';
  if (extension === '.xlsx') {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (extension === '.xls') return 'application/vnd.ms-excel';
  return 'application/octet-stream';
}

function previewCellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .slice(0, MAX_PREVIEW_CELL_CHARACTERS);
}

function worksheetDimensions(
  worksheet: XLSX.WorkSheet,
  rows: string[][],
): { rows: number; columns: number } {
  const fullReference =
    (worksheet as XLSX.WorkSheet & { '!fullref'?: string })['!fullref'] ||
    worksheet['!ref'];
  if (fullReference) {
    try {
      const range = XLSX.utils.decode_range(fullReference);
      return {
        rows: Math.max(0, range.e.r - range.s.r + 1),
        columns: Math.max(0, range.e.c - range.s.c + 1),
      };
    } catch {
      // Fall through to the bounded preview dimensions.
    }
  }
  return {
    rows: rows.length,
    columns: rows.reduce((maximum, row) => Math.max(maximum, row.length), 0),
  };
}

function responseHeader(value: unknown, name: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const headers = (value as { headers?: unknown }).headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers))
    return '';
  const record = headers as Record<string, unknown>;
  const found =
    record[name] || record[name.toLowerCase()] || record[name.toUpperCase()];
  return typeof found === 'string' || typeof found === 'number'
    ? String(found).trim()
    : '';
}

function responseText(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' && found.trim() ? found.trim() : undefined;
}

function responseBody(value: unknown): Buffer {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return Buffer.alloc(0);
  const body = (value as { Body?: unknown }).Body;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  return Buffer.alloc(0);
}

function readEnv(env: NodeJS.ProcessEnv, ...names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return '';
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').slice(0, 240);
}
