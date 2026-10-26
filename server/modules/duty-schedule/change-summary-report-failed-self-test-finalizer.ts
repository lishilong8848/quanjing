import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

const CHANGE_REQUEST_MUTATION_ID_PATTERN =
  /^change-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUMMARY_MUTATION_ID_PATTERN =
  /^change-summary-report-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECORD_ID_PATTERN = /^rec[A-Za-z0-9_-]{8,80}$/;
const SUMMARY_MARKER_PATTERN =
  /^CODEX-SELFTEST-CHANGE-SUMMARY-\d{13}-[0-9a-f]{8}$/;
const OBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{12,80}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROOF_DOMAIN = 'vnet-change-summary-report-failed-self-test-cleanup-v1';
const REQUEST_KEYS = new Set([
  'changeRequestMutationId',
  'clientMutationId',
  'changeRecordId',
  'summaryMarker',
  'summaryFingerprint',
  'changeObjectIds',
  'summaryObjectIds',
  'expiresAt',
]);

export const FAILED_CHANGE_SUMMARY_SELF_TEST_CLEANUP_PROOF_TTL_MS =
  2 * 60 * 1000;

export interface FailedChangeSummarySelfTestCleanupRequest {
  changeRequestMutationId: string;
  clientMutationId: string;
  changeRecordId: string;
  summaryMarker: string;
  summaryFingerprint: string;
  changeObjectIds: readonly string[];
  summaryObjectIds: readonly string[];
  expiresAt: number;
}

export type FailedChangeSummarySelfTestObjectDeletionState =
  | 'present'
  | 'cleanup-pending'
  | 'absent';

export interface FailedChangeSummarySelfTestCleanupPorts<TResult> {
  readChangeRecordExact(recordId: string): Promise<unknown | null>;
  countChangeRecordsBySummaryMarker(summaryMarker: string): Promise<unknown>;
  countSummaryReportsByMutationId(clientMutationId: string): Promise<unknown>;
  countSummaryReportsByChangeRecordId(changeRecordId: string): Promise<unknown>;
  getObjectDeletionState(objectId: string): Promise<unknown>;
  finalizeLedgers(
    request: FailedChangeSummarySelfTestCleanupRequest,
  ): Promise<TResult>;
}

export function createFailedChangeSummarySelfTestCleanupProof(
  input: FailedChangeSummarySelfTestCleanupRequest,
  encodedSecret: string,
): string {
  const request = normalizeRequest(input);
  const secret = decodeSecret(encodedSecret);
  if (!secret) {
    throw new Error('变更总结失败自测清理签名密钥无效');
  }
  return createHmac('sha256', secret)
    .update(proofPayload(request))
    .digest('base64url');
}

export async function finalizeFailedChangeSummarySelfTestCleanup<TResult>(
  input: FailedChangeSummarySelfTestCleanupRequest,
  proof: string,
  encodedSecret: string,
  ports: FailedChangeSummarySelfTestCleanupPorts<TResult>,
  now = Date.now(),
): Promise<TResult> {
  const request = verifyProof(input, proof, encodedSecret, now);
  const objectIds = [...request.changeObjectIds, ...request.summaryObjectIds];

  const [
    changeRecord,
    markerCount,
    summaryMutationCount,
    summaryRelationCount,
    objectStates,
  ] = await Promise.all([
    ports.readChangeRecordExact(request.changeRecordId),
    ports.countChangeRecordsBySummaryMarker(request.summaryMarker),
    ports.countSummaryReportsByMutationId(request.clientMutationId),
    ports.countSummaryReportsByChangeRecordId(request.changeRecordId),
    Promise.all(
      objectIds.map(async (objectId) => ({
        objectId,
        state: await ports.getObjectDeletionState(objectId),
      })),
    ),
  ]);

  if (changeRecord !== null) {
    throw new ConflictException('变更总结失败自测主记录仍然存在');
  }
  assertZeroCount(markerCount, '变更主记录标记');
  assertZeroCount(summaryMutationCount, '变更总结唯一ID');
  assertZeroCount(summaryRelationCount, '变更总结关联记录');

  for (const { state } of objectStates) {
    if (state === 'present' || state === 'cleanup-pending') {
      throw new ConflictException('变更总结失败自测 COS 对象仍未完成清理');
    }
    if (state !== 'absent') {
      throw new ServiceUnavailableException(
        '变更总结失败自测 COS 对象状态无法确认',
      );
    }
  }

  return ports.finalizeLedgers(request);
}

function verifyProof(
  input: FailedChangeSummarySelfTestCleanupRequest,
  proof: string,
  encodedSecret: string,
  now: number,
): FailedChangeSummarySelfTestCleanupRequest {
  const request = normalizeRequest(input);
  if (
    !Number.isSafeInteger(now) ||
    request.expiresAt < now ||
    request.expiresAt >
      now + FAILED_CHANGE_SUMMARY_SELF_TEST_CLEANUP_PROOF_TTL_MS
  ) {
    throw new ForbiddenException('变更总结失败自测清理签名已失效');
  }

  const secret = decodeSecret(encodedSecret);
  const supplied = String(proof || '').trim();
  if (!secret || !PROOF_PATTERN.test(supplied)) {
    throw new ForbiddenException('变更总结失败自测清理签名无效');
  }
  const expected = createHmac('sha256', secret)
    .update(proofPayload(request))
    .digest();
  const actual = Buffer.from(supplied, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ForbiddenException('变更总结失败自测清理签名无效');
  }
  return request;
}

function normalizeRequest(
  input: FailedChangeSummarySelfTestCleanupRequest,
): FailedChangeSummarySelfTestCleanupRequest {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !REQUEST_KEYS.has(key))
  ) {
    throw new BadRequestException('变更总结失败自测清理请求无效');
  }
  const request = {
    changeRequestMutationId: String(input.changeRequestMutationId || '').trim(),
    clientMutationId: String(input.clientMutationId || '').trim(),
    changeRecordId: String(input.changeRecordId || '').trim(),
    summaryMarker: String(input.summaryMarker || '')
      .normalize('NFKC')
      .trim(),
    summaryFingerprint: String(input.summaryFingerprint || '')
      .trim()
      .toLowerCase(),
    changeObjectIds: normalizeObjectIds(input.changeObjectIds),
    summaryObjectIds: normalizeObjectIds(input.summaryObjectIds),
    expiresAt: input.expiresAt,
  } satisfies FailedChangeSummarySelfTestCleanupRequest;

  if (
    !CHANGE_REQUEST_MUTATION_ID_PATTERN.test(request.changeRequestMutationId) ||
    !SUMMARY_MUTATION_ID_PATTERN.test(request.clientMutationId) ||
    !RECORD_ID_PATTERN.test(request.changeRecordId) ||
    !SUMMARY_MARKER_PATTERN.test(request.summaryMarker) ||
    !SHA256_PATTERN.test(request.summaryFingerprint) ||
    request.changeObjectIds.length < 1 ||
    request.changeObjectIds.length > 5 ||
    request.summaryObjectIds.length < 1 ||
    request.summaryObjectIds.length > 5 ||
    !Number.isSafeInteger(request.expiresAt) ||
    new Set([...request.changeObjectIds, ...request.summaryObjectIds]).size !==
      request.changeObjectIds.length + request.summaryObjectIds.length
  ) {
    throw new BadRequestException('变更总结失败自测清理请求无效');
  }
  return request;
}

function normalizeObjectIds(value: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = value.map((item) => String(item || '').trim()).sort();
  if (
    normalized.some((item) => !OBJECT_ID_PATTERN.test(item)) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new BadRequestException('变更总结失败自测清理对象列表无效');
  }
  return normalized;
}

function proofPayload(
  request: FailedChangeSummarySelfTestCleanupRequest,
): string {
  return [
    PROOF_DOMAIN,
    request.changeRequestMutationId,
    request.clientMutationId,
    request.changeRecordId,
    request.summaryMarker,
    request.summaryFingerprint,
    JSON.stringify(request.changeObjectIds),
    JSON.stringify(request.summaryObjectIds),
    String(request.expiresAt),
  ].join('\n');
}

function decodeSecret(value: string): Buffer | null {
  const encoded = String(value || '').trim();
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    return null;
  }
  try {
    const secret = Buffer.from(encoded, 'base64');
    return secret.length === 32 && secret.toString('base64') === encoded
      ? secret
      : null;
  } catch {
    return null;
  }
}

function assertZeroCount(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ServiceUnavailableException(`${label}查询结果无法确认`);
  }
  if (value !== 0) {
    throw new ConflictException(`${label}仍然存在`);
  }
}
