import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, type Hash } from 'node:crypto';
import type {
  EmployeeOnboardingCreateRequest,
  EmployeeOnboardingCreateResponse,
} from '../../../shared/employee-onboarding';
import { EMPLOYEE_ONBOARDING_PHOTO_FILE_RULE } from '../../../shared/employee-onboarding';
import { extractDisplayText } from '@server/common/feishu/bitable-direct-read';
import {
  EmployeeOnboardingCreateIndeterminateError,
  EmployeeOnboardingGateway,
  type EmployeeOnboardingUploadFile,
} from './employee-onboarding.gateway';
import {
  EmployeeOnboardingRuleError,
  buildEmployeeOnboardingFieldsFromValidatedRequest,
  parseEmployeeOnboardingRequest,
  type EmployeeOnboardingValidatedRequest,
} from './employee-onboarding.rules';

type UploadInput =
  | EmployeeOnboardingUploadFile
  | readonly EmployeeOnboardingUploadFile[];

export interface EmployeeOnboardingSubmitFiles {
  photo?: UploadInput;
}

interface NormalizedSubmitFiles {
  photo: NormalizedUploadFile;
}

interface NormalizedUploadFile extends EmployeeOnboardingUploadFile {
  originalname: string;
  mimetype: string;
}

interface InFlightSubmission {
  fingerprint: string;
  promise: Promise<EmployeeOnboardingCreateResponse>;
}

interface CompletedSubmission {
  fingerprint: string;
  expiresAt: number;
  result: EmployeeOnboardingCreateResponse;
}

interface RecoverableAttempt {
  fingerprint: string;
  expiresAt: number;
  photoToken?: string;
  recordId?: string;
}

const ALLOWED_FILE_KEYS = new Set(['photo']);
const COMPLETED_TTL_MS = 10 * 60 * 1000;
const ATTEMPT_TTL_MS = 10 * 60 * 1000;
const MAX_COMPLETED_SUBMISSIONS = 256;
const MAX_RECOVERABLE_ATTEMPTS = 256;
const READBACK_ATTEMPTS = 3;
const READBACK_RETRY_DELAY_MS = 50;
const MAX_FILE_NAME_LENGTH = 180;
const MAX_MIME_LENGTH = 100;
const FILE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{6,256}$/u;
const MIME_EXTENSIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  'image/png': new Set(['png']),
  'image/jpeg': new Set(['jpg', 'jpeg']),
  'image/webp': new Set(['webp']),
};

@Injectable()
export class EmployeeOnboardingService {
  private readonly inFlightByMutation = new Map<string, InFlightSubmission>();
  private readonly completedByMutation = new Map<string, CompletedSubmission>();
  private readonly attemptsByMutation = new Map<string, RecoverableAttempt>();

  constructor(private readonly gateway: EmployeeOnboardingGateway) {}

  async create(
    payload: unknown,
    files: EmployeeOnboardingSubmitFiles,
  ): Promise<EmployeeOnboardingCreateResponse> {
    const request = parseRequest(payload);
    const normalizedFiles = normalizeFiles(files);
    const fingerprint = buildSubmissionFingerprint(request, normalizedFiles);
    const mutationId = request.clientMutationId;
    this.pruneState();

    const completed = this.completedByMutation.get(mutationId);
    if (completed) {
      if (completed.fingerprint !== fingerprint) throw mutationConflict();
      this.completedByMutation.delete(mutationId);
      this.completedByMutation.set(mutationId, completed);
      return completed.result;
    }

    const existingAttempt = this.attemptsByMutation.get(mutationId);
    if (existingAttempt && existingAttempt.fingerprint !== fingerprint) {
      throw mutationConflict();
    }

    const active = this.inFlightByMutation.get(mutationId);
    if (active) {
      if (active.fingerprint !== fingerprint) throw mutationConflict();
      return active.promise;
    }

    const attempt = existingAttempt
      ? this.touchAttempt(mutationId, existingAttempt)
      : this.rememberAttempt(mutationId, fingerprint);
    const promise = this.runSubmission(request, normalizedFiles, attempt).then(
      (result) => {
        this.rememberCompletedResult(mutationId, fingerprint, result);
        if (this.attemptsByMutation.get(mutationId) === attempt) {
          this.attemptsByMutation.delete(mutationId);
        }
        return result;
      },
    );
    this.inFlightByMutation.set(mutationId, { fingerprint, promise });
    const clearInFlight = () => {
      if (this.inFlightByMutation.get(mutationId)?.promise === promise) {
        this.inFlightByMutation.delete(mutationId);
      }
    };
    void promise.then(clearInFlight, clearInFlight);
    return promise;
  }

  private async runSubmission(
    request: EmployeeOnboardingValidatedRequest,
    files: NormalizedSubmitFiles,
    attempt: RecoverableAttempt,
  ): Promise<EmployeeOnboardingCreateResponse> {
    try {
      await this.gateway.fetchFieldMetas();
    } catch (error) {
      throw preserveHttpOrFallback(error, '校验新员工入职字段暂时失败');
    }

    await this.uploadMissingAttachments(files, attempt);
    const fields = buildSubmissionFields(request, files, attempt);

    if (!attempt.recordId) {
      try {
        attempt.recordId = await this.gateway.createRecord(
          fields,
          request.clientMutationId,
        );
      } catch (error) {
        if (
          error instanceof EmployeeOnboardingCreateIndeterminateError ||
          error instanceof HttpException
        ) {
          throw error;
        }
        throw new BadGatewayException('写入新员工入职记录失败');
      }
    }

    const recordId = attempt.recordId;
    await this.confirmExactRecord(recordId, fields);
    try {
      this.gateway.invalidateTargetCache();
    } catch {
      throw new ServiceUnavailableException('刷新新员工入职缓存暂时失败');
    }

    return Object.freeze({
      success: true,
      syncStatus: 'confirmed',
      clientMutationId: request.clientMutationId,
      recordId,
      createdAt: new Date().toISOString(),
    });
  }

  private async uploadMissingAttachments(
    files: NormalizedSubmitFiles,
    attempt: RecoverableAttempt,
  ): Promise<void> {
    const uploads: Promise<void>[] = [];
    if (!attempt.photoToken) {
      uploads.push(
        this.gateway.uploadAttachment(files.photo).then((token) => {
          attempt.photoToken = requireFileToken(token);
        }),
      );
    }
    const results = await Promise.allSettled(uploads);
    const failures = results.flatMap((result) =>
      result.status === 'rejected'
        ? [preserveHttpOrFallback(result.reason, '上传新员工入职附件暂时失败')]
        : [],
    );
    if (failures.length === 0) return;
    throw (
      failures.find(
        (failure) => failure.getStatus() !== HttpStatus.SERVICE_UNAVAILABLE,
      ) ?? failures[0]
    );
  }

  private async confirmExactRecord(
    recordId: string,
    expectedFields: Record<string, unknown>,
  ): Promise<void> {
    let sawSuccessfulResponse = false;
    let lastFailure: HttpException | null = null;
    for (let attempt = 0; attempt < READBACK_ATTEMPTS; attempt += 1) {
      let actual: Record<string, unknown> | null = null;
      try {
        actual = await this.gateway.readRecord(recordId);
        sawSuccessfulResponse = true;
      } catch (error) {
        lastFailure = preserveHttpOrFallback(
          error,
          '读取新员工入职记录暂时失败',
        );
      }
      if (actual && exactRecordMatches(actual, expectedFields)) return;
      if (attempt < READBACK_ATTEMPTS - 1) {
        await delay(READBACK_RETRY_DELAY_MS);
      }
    }
    if (!sawSuccessfulResponse && lastFailure) throw lastFailure;
    throw new BadGatewayException('新员工入职记录读回未确认，未确认提交成功');
  }

  private rememberCompletedResult(
    mutationId: string,
    fingerprint: string,
    result: EmployeeOnboardingCreateResponse,
  ): void {
    this.completedByMutation.delete(mutationId);
    this.completedByMutation.set(mutationId, {
      fingerprint,
      expiresAt: Date.now() + COMPLETED_TTL_MS,
      result,
    });
    trimOldest(this.completedByMutation, MAX_COMPLETED_SUBMISSIONS);
  }

  private rememberAttempt(
    mutationId: string,
    fingerprint: string,
  ): RecoverableAttempt {
    const attempt: RecoverableAttempt = {
      fingerprint,
      expiresAt: Date.now() + ATTEMPT_TTL_MS,
    };
    this.attemptsByMutation.set(mutationId, attempt);
    trimOldest(this.attemptsByMutation, MAX_RECOVERABLE_ATTEMPTS);
    return attempt;
  }

  private touchAttempt(
    mutationId: string,
    attempt: RecoverableAttempt,
  ): RecoverableAttempt {
    attempt.expiresAt = Date.now() + ATTEMPT_TTL_MS;
    this.attemptsByMutation.delete(mutationId);
    this.attemptsByMutation.set(mutationId, attempt);
    return attempt;
  }

  private pruneState(): void {
    const now = Date.now();
    for (const [mutationId, completed] of this.completedByMutation) {
      if (completed.expiresAt <= now) {
        this.completedByMutation.delete(mutationId);
      }
    }
    for (const [mutationId, attempt] of this.attemptsByMutation) {
      if (attempt.expiresAt <= now) {
        this.attemptsByMutation.delete(mutationId);
      }
    }
  }
}

function parseRequest(payload: unknown): EmployeeOnboardingValidatedRequest {
  try {
    return parseEmployeeOnboardingRequest(payload);
  } catch (error) {
    if (!(error instanceof EmployeeOnboardingRuleError)) {
      throw new BadRequestException('新员工入职信息校验失败');
    }
    throw new BadRequestException({
      message: '新员工入职信息校验失败',
      issues: error.issues.map(({ field, message }) => ({ field, message })),
    });
  }
}

function normalizeFiles(
  files: EmployeeOnboardingSubmitFiles,
): NormalizedSubmitFiles {
  if (!isPlainRecord(files)) {
    throw new BadRequestException('新员工入职附件参数无效');
  }
  if (Object.keys(files).some((key) => !ALLOWED_FILE_KEYS.has(key))) {
    throw new BadRequestException('新员工入职附件参数无效');
  }
  const submittedFiles = files as EmployeeOnboardingSubmitFiles;

  const photoFiles = normalizeFileList(submittedFiles.photo);
  if (photoFiles.length !== 1) {
    throw new BadRequestException('证件照必须上传且只能上传一份');
  }
  return {
    photo: normalizeUploadFile(photoFiles[0]),
  };
}

function normalizeFileList(
  input: UploadInput | undefined,
): EmployeeOnboardingUploadFile[] {
  if (input === undefined || input === null) return [];
  return Array.isArray(input)
    ? [...input]
    : [input as EmployeeOnboardingUploadFile];
}

function normalizeUploadFile(
  file: EmployeeOnboardingUploadFile,
): NormalizedUploadFile {
  const invalid = () => {
    throw new BadRequestException('证件照文件无效');
  };
  if (
    !file ||
    !Buffer.isBuffer(file.buffer) ||
    file.buffer.length === 0 ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size !== file.buffer.length ||
    typeof file.originalname !== 'string' ||
    typeof file.mimetype !== 'string'
  ) {
    return invalid();
  }

  const fileName = normalizeFileName(file.originalname);
  const mimeType = file.mimetype.trim().toLowerCase();
  const fileRule = EMPLOYEE_ONBOARDING_PHOTO_FILE_RULE;
  if (
    !fileName ||
    Array.from(fileName).length > MAX_FILE_NAME_LENGTH ||
    !mimeType ||
    mimeType.length > MAX_MIME_LENGTH ||
    /[\r\n]/u.test(mimeType) ||
    file.size > fileRule.maxBytesPerFile ||
    !fileRule.mimeTypes.includes(mimeType as never) ||
    !extensionMatchesMime(fileName, mimeType) ||
    !signatureMatchesMime(file.buffer, mimeType)
  ) {
    return invalid();
  }

  const bufferSnapshot = Buffer.from(file.buffer);
  return {
    buffer: bufferSnapshot,
    originalname: fileName,
    mimetype: mimeType,
    size: bufferSnapshot.length,
  };
}

function normalizeFileName(value: string): string {
  return (
    value
      .trim()
      .split(/[\\/]/u)
      .pop()
      ?.normalize('NFC')
      .replace(/[\x00-\x1f\x7f:*?"<>|]/gu, '_')
      .trim() ?? ''
  );
}

function extensionMatchesMime(fileName: string, mimeType: string): boolean {
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot < 1 || lastDot === fileName.length - 1) return false;
  const extension = fileName.slice(lastDot + 1).toLowerCase();
  return MIME_EXTENSIONS[mimeType]?.has(extension) === true;
}

function signatureMatchesMime(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/png') {
    return (
      buffer.length >= 8 &&
      buffer
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    );
  }
  if (mimeType === 'image/jpeg') {
    return (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    );
  }
  if (mimeType === 'image/webp') {
    return (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }
  return false;
}

function buildSubmissionFingerprint(
  request: EmployeeOnboardingCreateRequest,
  files: NormalizedSubmitFiles,
): string {
  const hash = createHash('sha256');
  appendText(hash, 'employee-onboarding:v1');
  appendText(hash, stableJson(request));
  appendFile(hash, 'photo', files.photo);
  return hash.digest('hex');
}

function appendFile(
  hash: Hash,
  label: string,
  file: NormalizedUploadFile,
): void {
  appendText(hash, label);
  appendText(hash, file.originalname);
  appendText(hash, file.mimetype);
  appendText(hash, String(file.size));
  appendBytes(hash, file.buffer);
}

function appendText(hash: Hash, value: string): void {
  appendBytes(hash, Buffer.from(value, 'utf8'));
}

function appendBytes(hash: Hash, value: Buffer): void {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value.length));
  hash.update(length);
  hash.update(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function buildSubmissionFields(
  request: EmployeeOnboardingValidatedRequest,
  files: NormalizedSubmitFiles,
  attempt: RecoverableAttempt,
): Record<string, unknown> {
  const photoToken = requireFileToken(attempt.photoToken);
  return {
    ...buildEmployeeOnboardingFieldsFromValidatedRequest(request),
    照片: [{ file_token: photoToken }],
  };
}

function requireFileToken(value: unknown): string {
  if (typeof value !== 'string' || !FILE_TOKEN_PATTERN.test(value)) {
    throw new ServiceUnavailableException('处理新员工入职附件暂时失败');
  }
  return value;
}

function exactRecordMatches(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  const expectsVehiclePlate = Object.prototype.hasOwnProperty.call(
    expected,
    '车牌号',
  );
  const businessFields = [
    '姓名',
    '用工性质',
    '公司名称',
    '岗位',
    '身份证号',
    '联系方式',
    '入职日期',
    '学历',
    '毕业院校',
    '所学专业',
    '毕业时间',
    '兴趣爱好',
    'MBTI',
    ...(expectsVehiclePlate ? ['车牌号'] : []),
  ];
  for (const field of businessFields) {
    if (field === 'MBTI') {
      if (extractDisplayText(actual.MBTI, '').trim() !== expected.MBTI) return false;
      continue;
    }
    if (!sameStrictValue(actual[field], expected[field])) return false;
  }
  if (!expectsVehiclePlate && !isEmptyOptionalText(actual.车牌号)) {
    return false;
  }

  const expectedPhotoTokens = strictAttachmentTokens(expected.照片);
  const actualPhotoTokens = strictAttachmentTokens(actual.照片);
  return (
    expectedPhotoTokens !== null &&
    actualPhotoTokens !== null &&
    sameStringArray(actualPhotoTokens, expectedPhotoTokens)
  );
}

function isEmptyOptionalText(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim().length === 0)
  );
}

function sameStrictValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length)
      return false;
    return expected.every((item, index) => actual[index] === item);
  }
  if (typeof expected === 'number') {
    return typeof actual === 'number' && actual === expected;
  }
  if (typeof expected === 'string') {
    return typeof actual === 'string' && actual === expected;
  }
  return false;
}

function strictAttachmentTokens(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const tokens: string[] = [];
  for (const item of value) {
    if (!isPlainRecord(item) || typeof item.file_token !== 'string')
      return null;
    if (!FILE_TOKEN_PATTERN.test(item.file_token)) return null;
    tokens.push(item.file_token);
  }
  return tokens;
}

function sameStringArray(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function mutationConflict(): ConflictException {
  return new ConflictException('clientMutationId 已被不同的新员工入职内容占用');
}

function preserveHttpOrFallback(
  error: unknown,
  fallbackMessage: string,
): HttpException {
  return error instanceof HttpException
    ? error
    : new ServiceUnavailableException(fallbackMessage);
}

function trimOldest<T>(map: Map<string, T>, maximum: number): void {
  while (map.size > maximum) {
    const oldest = map.keys().next().value;
    if (typeof oldest !== 'string') return;
    map.delete(oldest);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (Object.prototype.toString.call(value) !== '[object Object]') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
