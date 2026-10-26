import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import COS = require('cos-nodejs-sdk-v5');
import { readEnv } from '@server/common/config/external-services.config';

const DEFAULT_BUCKET = 'jy-1421907124';
const DEFAULT_REGION = 'ap-shanghai';
const DEFAULT_PREFIX = 'attendance/correction-evidence/v1';
const SIGNED_URL_SECONDS = 300;

export const ATTENDANCE_CORRECTION_EVIDENCE_STORAGE_OPTIONS =
  'ATTENDANCE_CORRECTION_EVIDENCE_STORAGE_OPTIONS';

export interface AttendanceCorrectionEvidenceCosClient {
  putObject(params: COS.PutObjectParams): Promise<unknown>;
  headObject(params: COS.HeadObjectParams): Promise<unknown>;
  getObjectUrl(params: COS.GetObjectUrlParams): string;
}

export interface AttendanceCorrectionEvidenceStorageOptions {
  cos?: AttendanceCorrectionEvidenceCosClient | null;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface AttendanceCorrectionEvidenceObjectRef {
  processInstanceId: string;
  index: number;
}

export interface AttendanceCorrectionEvidenceSignedImage {
  url: string;
  contentType: string;
  expiresAt: string;
}

interface EvidenceSource {
  buffer: Buffer;
  contentType: string;
}

@Injectable()
export class AttendanceCorrectionEvidenceStorageService {
  private readonly bucket: string;
  private readonly region: string;
  private readonly prefix: string;
  private readonly cos: AttendanceCorrectionEvidenceCosClient | null;
  private readonly now: () => Date;
  private readonly inFlight = new Map<
    string,
    Promise<AttendanceCorrectionEvidenceSignedImage>
  >();

  constructor(
    @Optional()
    @Inject(ATTENDANCE_CORRECTION_EVIDENCE_STORAGE_OPTIONS)
    options: AttendanceCorrectionEvidenceStorageOptions = {},
  ) {
    const env = options.env || process.env;
    this.bucket =
      readSetting(env, 'COS_ATTENDANCE_BUCKET') ||
      readSetting(env, 'COS_CHANGE_BUCKET') ||
      readSetting(env, 'COS_BUCKET') ||
      DEFAULT_BUCKET;
    this.region =
      readSetting(env, 'COS_ATTENDANCE_REGION') ||
      readSetting(env, 'COS_CHANGE_REGION') ||
      readSetting(env, 'COS_REGION') ||
      DEFAULT_REGION;
    this.prefix = normalizePrefix(
      readSetting(env, 'COS_ATTENDANCE_PREFIX') || DEFAULT_PREFIX,
    );
    this.now = options.now || (() => new Date());
    if (Object.prototype.hasOwnProperty.call(options, 'cos')) {
      this.cos = options.cos || null;
      return;
    }
    const secretId = readEnv('COS_SECRET_ID', ['TENCENTCLOUD_SECRET_ID']);
    const secretKey = readEnv('COS_SECRET_KEY', ['TENCENTCLOUD_SECRET_KEY']);
    const securityToken = readEnv('COS_SESSION_TOKEN', [
      'TENCENTCLOUD_SESSION_TOKEN',
    ]);
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

  isConfigured(): boolean {
    return Boolean(this.cos);
  }

  ensureStored(
    ref: AttendanceCorrectionEvidenceObjectRef,
    load: () => Promise<EvidenceSource>,
  ): Promise<AttendanceCorrectionEvidenceSignedImage> {
    const key = this.objectKey(ref);
    const active = this.inFlight.get(key);
    if (active) return active;
    const operation = this.ensureStoredOnce(key, load).finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    });
    this.inFlight.set(key, operation);
    return operation;
  }

  async getStored(
    ref: AttendanceCorrectionEvidenceObjectRef,
  ): Promise<AttendanceCorrectionEvidenceSignedImage | null> {
    const objectKey = this.objectKey(ref);
    const cos = this.requireCos();
    try {
      const head = await cos.headObject({
        Bucket: this.bucket,
        Region: this.region,
        Key: objectKey,
      });
      return this.signObject(
        cos,
        objectKey,
        responseHeader(head, 'content-type'),
      );
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new ServiceUnavailableException('补卡举证对象存储读取失败');
    }
  }

  private async ensureStoredOnce(
    objectKey: string,
    load: () => Promise<EvidenceSource>,
  ): Promise<AttendanceCorrectionEvidenceSignedImage> {
    const cos = this.requireCos();
    const existing = await this.getStoredByKey(cos, objectKey);
    if (existing) return existing;
    let contentType = '';
    {
      const source = await load();
      const normalizedContentType = normalizeImageContentType(
        source.contentType,
      );
      if (!source.buffer.length) {
        throw new ServiceUnavailableException('补卡举证图片为空');
      }
      const sha256 = createHash('sha256').update(source.buffer).digest('hex');
      try {
        await cos.putObject({
          Bucket: this.bucket,
          Region: this.region,
          Key: objectKey,
          Body: source.buffer,
          ContentLength: source.buffer.length,
          ContentType: normalizedContentType,
          CacheControl: 'private, max-age=300',
          'x-cos-meta-sha256': sha256,
        });
        const verified = await cos.headObject({
          Bucket: this.bucket,
          Region: this.region,
          Key: objectKey,
        });
        if (
          Number(responseHeader(verified, 'content-length')) !==
          source.buffer.length
        ) {
          throw new Error('size mismatch');
        }
        contentType =
          responseHeader(verified, 'content-type') || normalizedContentType;
      } catch {
        throw new ServiceUnavailableException('补卡举证对象存储写入失败');
      }
    }
    return this.signObject(cos, objectKey, contentType);
  }

  private async getStoredByKey(
    cos: AttendanceCorrectionEvidenceCosClient,
    objectKey: string,
  ): Promise<AttendanceCorrectionEvidenceSignedImage | null> {
    try {
      const head = await cos.headObject({
        Bucket: this.bucket,
        Region: this.region,
        Key: objectKey,
      });
      return this.signObject(
        cos,
        objectKey,
        responseHeader(head, 'content-type'),
      );
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new ServiceUnavailableException('补卡举证对象存储读取失败');
    }
  }

  private signObject(
    cos: AttendanceCorrectionEvidenceCosClient,
    objectKey: string,
    contentType: string,
  ): AttendanceCorrectionEvidenceSignedImage {
    const expiresAt = new Date(
      this.now().getTime() + SIGNED_URL_SECONDS * 1000,
    ).toISOString();
    try {
      return {
        url: cos.getObjectUrl({
          Bucket: this.bucket,
          Region: this.region,
          Key: objectKey,
          Sign: true,
          Method: 'GET',
          Expires: SIGNED_URL_SECONDS,
          Query: {
            'response-content-type': normalizeImageContentType(
              contentType || 'image/jpeg',
            ),
            'response-content-disposition': 'inline',
          },
        }),
        contentType: normalizeImageContentType(contentType || 'image/jpeg'),
        expiresAt,
      };
    } catch {
      throw new ServiceUnavailableException('生成补卡举证访问地址失败');
    }
  }

  private objectKey(ref: AttendanceCorrectionEvidenceObjectRef): string {
    if (!ref.processInstanceId.trim() || !Number.isSafeInteger(ref.index)) {
      throw new ServiceUnavailableException('补卡举证对象标识无效');
    }
    const processKey = createHash('sha256')
      .update(ref.processInstanceId.trim())
      .digest('hex');
    return `${this.prefix}/${processKey}/${ref.index}`;
  }

  private requireCos(): AttendanceCorrectionEvidenceCosClient {
    if (!this.cos) {
      throw new ServiceUnavailableException('补卡举证对象存储未配置');
    }
    return this.cos;
  }
}

function readSetting(env: NodeJS.ProcessEnv, name: string): string {
  return String(env[name] || '').trim();
}

function normalizePrefix(value: string): string {
  return value.trim().replace(/^\/+|\/+$/gu, '');
}

function normalizeImageContentType(value: string): string {
  const normalized = value.split(';')[0].trim().toLowerCase();
  if (normalized === 'image/jpg') return 'image/jpeg';
  return /^image\/(png|jpeg|webp|gif)$/u.test(normalized)
    ? normalized
    : 'image/jpeg';
}

function responseHeader(response: unknown, name: string): string {
  if (!response || typeof response !== 'object') return '';
  const headers = (response as { headers?: Record<string, unknown> }).headers;
  if (!headers) return '';
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    statusCode?: number;
    status?: number;
    code?: string;
  };
  return (
    candidate.statusCode === 404 ||
    candidate.status === 404 ||
    ['NoSuchKey', 'NotFound'].includes(String(candidate.code || ''))
  );
}
