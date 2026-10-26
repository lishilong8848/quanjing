import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { normalizeChangeSummaryReportSubmitterName } from '../../../shared/change-summary-report';
import { scrubChangeRequestSelfTestLedgerDirectory } from './change-summary-report.service';

const SUMMARY_MUTATION_ID_PATTERN =
  /^change-summary-report-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHANGE_REQUEST_MUTATION_ID_PATTERN =
  /^change-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECORD_ID_PATTERN = /^rec[A-Za-z0-9_-]{8,80}$/;
const SUMMARY_MARKER_PATTERN =
  /^CODEX-SELFTEST-CHANGE-SUMMARY-\d{13}-[0-9a-f]{8}$/;
const OBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{12,80}$/;
const FILE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,500}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ACTIVE_SUMMARY_SUFFIX_PATTERN =
  /^json(?:\.bak|\.\d+\.[0-9a-f]{12}\.tmp)?$/;

export interface FailedChangeSummarySelfTestCleanupInput {
  summaryLedgerDir: string;
  changeRequestLedgerDir: string;
  clientMutationId: string;
  changeRequestMutationId: string;
  changeRecordId: string;
  summaryMarker: string;
  fingerprint: string;
  changeObjectIds: readonly string[];
  summaryObjectIds: readonly string[];
  now?: () => Date;
}

export interface FailedChangeSummarySelfTestCleanupResult {
  alreadyFinalized: boolean;
  changeRequestAlreadyScrubbed: boolean;
}

interface NormalizedCleanupIdentity {
  summaryLedgerDir: string;
  changeRequestLedgerDir: string;
  clientMutationId: string;
  changeRequestMutationId: string;
  changeRecordId: string;
  summaryMarker: string;
  fingerprint: string;
  changeObjectIds: string[];
  summaryObjectIds: string[];
  cleanedAt: Date;
}

export async function finalizeFailedChangeSummarySelfTestLedgers(
  input: FailedChangeSummarySelfTestCleanupInput,
): Promise<FailedChangeSummarySelfTestCleanupResult> {
  const identity = normalizeCleanupIdentity(input);
  await Promise.all([
    mkdir(identity.summaryLedgerDir, { recursive: true }),
    mkdir(identity.changeRequestLedgerDir, { recursive: true }),
  ]);

  const mutationHash = hash(identity.clientMutationId);
  const identityHash = hashCleanupIdentity(identity);
  const tombstoneName = `self-test-cleaned-${mutationHash}.json`;
  const tombstonePath = join(identity.summaryLedgerDir, tombstoneName);
  const prefix = `${identity.clientMutationId}.`;
  const filenames = await readdir(identity.summaryLedgerDir);
  const activeFiles = filenames.filter((name) => name.startsWith(prefix));
  const unknownFiles = activeFiles.filter(
    (name) => !ACTIVE_SUMMARY_SUFFIX_PATTERN.test(name.slice(prefix.length)),
  );
  if (unknownFiles.length > 0) {
    throw new ConflictException('变更总结失败自测台账包含未知文件，拒绝清理');
  }

  const tombstoneExists = filenames.includes(tombstoneName);
  if (tombstoneExists) {
    const tombstoneText = await readFile(tombstonePath, 'utf8');
    const tombstoneFormat = assertCleanupTombstone(
      tombstoneText,
      mutationHash,
      identityHash,
    );
    if (tombstoneFormat === 'legacy') {
      const legacy = parseLedger(tombstoneText);
      await persistCanonicalCleanupTombstone(
        tombstonePath,
        mutationHash,
        identityHash,
        String(legacy.cleanedAt),
      );
    }
  } else {
    const durableFiles = activeFiles.filter(
      (name) =>
        name === `${identity.clientMutationId}.json` ||
        name === `${identity.clientMutationId}.json.bak`,
    );
    if (durableFiles.length === 0) {
      throw new ConflictException('未找到变更总结失败自测台账，拒绝清理');
    }
  }

  const activeSubmitters: string[] = [];
  for (const filename of activeFiles) {
    activeSubmitters.push(
      assertFailedSummaryLedger(
        parseLedger(
          await readFile(join(identity.summaryLedgerDir, filename), 'utf8'),
        ),
        identity,
      ),
    );
  }
  const uniqueSubmitters = new Set(activeSubmitters);
  if (uniqueSubmitters.size > 1) {
    throw new ConflictException(
      '变更总结失败自测活跃台账提交人不一致，拒绝清理',
    );
  }
  const submitterName = activeSubmitters[0];
  let changeRequestAlreadyScrubbed = true;
  if (submitterName) {
    const changeRequestResult = await scrubChangeRequestSelfTestLedgerDirectory(
      {
        ledgerDir: identity.changeRequestLedgerDir,
        changeRequestMutationId: identity.changeRequestMutationId,
        changeRecordId: identity.changeRecordId,
        summaryMarker: identity.summaryMarker,
        submitterName,
        expectedObjectIds: identity.changeObjectIds,
      },
    );
    changeRequestAlreadyScrubbed = changeRequestResult.alreadyScrubbed;
  }

  if (!tombstoneExists) {
    await persistCanonicalCleanupTombstone(
      tombstonePath,
      mutationHash,
      identityHash,
      identity.cleanedAt.toISOString(),
    );
  }

  for (const filename of activeFiles) {
    await unlink(join(identity.summaryLedgerDir, filename)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
  }
  const residual = (await readdir(identity.summaryLedgerDir)).filter((name) =>
    name.startsWith(prefix),
  );
  if (residual.length > 0) {
    throw new ServiceUnavailableException('变更总结失败自测台账未能完整脱敏');
  }

  return {
    alreadyFinalized: tombstoneExists,
    changeRequestAlreadyScrubbed,
  };
}

function normalizeCleanupIdentity(
  input: FailedChangeSummarySelfTestCleanupInput,
): NormalizedCleanupIdentity {
  const summaryLedgerDir = String(input?.summaryLedgerDir || '').trim();
  const changeRequestLedgerDir = String(
    input?.changeRequestLedgerDir || '',
  ).trim();
  const clientMutationId = String(input?.clientMutationId || '').trim();
  const changeRequestMutationId = String(
    input?.changeRequestMutationId || '',
  ).trim();
  const changeRecordId = String(input?.changeRecordId || '').trim();
  const summaryMarker = String(input?.summaryMarker || '')
    .normalize('NFKC')
    .trim();
  const fingerprint = String(input?.fingerprint || '')
    .trim()
    .toLowerCase();
  const changeObjectIds = Array.isArray(input?.changeObjectIds)
    ? input.changeObjectIds.map((id) => String(id || '').trim()).sort()
    : [];
  const summaryObjectIds = Array.isArray(input?.summaryObjectIds)
    ? input.summaryObjectIds.map((id) => String(id || '').trim()).sort()
    : [];
  const now = input.now || (() => new Date());
  let cleanedAt: Date;
  try {
    cleanedAt = now();
  } catch {
    throw new BadRequestException('变更总结自测清理时间无效');
  }
  if (!(cleanedAt instanceof Date) || !Number.isFinite(cleanedAt.getTime())) {
    throw new BadRequestException('变更总结自测清理时间无效');
  }
  if (
    !summaryLedgerDir ||
    !changeRequestLedgerDir ||
    !SUMMARY_MUTATION_ID_PATTERN.test(clientMutationId) ||
    !CHANGE_REQUEST_MUTATION_ID_PATTERN.test(changeRequestMutationId) ||
    !RECORD_ID_PATTERN.test(changeRecordId) ||
    !SUMMARY_MARKER_PATTERN.test(summaryMarker) ||
    !SHA256_PATTERN.test(fingerprint) ||
    (input.now !== undefined && typeof input.now !== 'function')
  ) {
    throw new BadRequestException('变更总结失败自测台账清理请求无效');
  }
  if (
    changeObjectIds.length < 1 ||
    changeObjectIds.length > 5 ||
    changeObjectIds.some((id) => !OBJECT_ID_PATTERN.test(id)) ||
    new Set(changeObjectIds).size !== changeObjectIds.length ||
    summaryObjectIds.length < 1 ||
    summaryObjectIds.length > 5 ||
    summaryObjectIds.some((id) => !OBJECT_ID_PATTERN.test(id)) ||
    new Set(summaryObjectIds).size !== summaryObjectIds.length ||
    changeObjectIds.some((id) => summaryObjectIds.includes(id))
  ) {
    throw new BadRequestException('变更失败自测清理对象标识无效或重叠');
  }
  return {
    summaryLedgerDir,
    changeRequestLedgerDir,
    clientMutationId,
    changeRequestMutationId,
    changeRecordId,
    summaryMarker,
    fingerprint,
    changeObjectIds,
    summaryObjectIds,
    cleanedAt,
  };
}

function assertFailedSummaryLedger(
  ledger: Record<string, unknown>,
  identity: NormalizedCleanupIdentity,
): string {
  const request = isPlainRecord(ledger.request) ? ledger.request : null;
  const uploaded = Array.isArray(ledger.uploaded) ? ledger.uploaded : null;
  const sourceFiles = Array.isArray(ledger.sourceFiles)
    ? ledger.sourceFiles
    : null;
  if (
    ledger.version !== 1 ||
    ledger.phase !== 'failed' ||
    ledger.clientMutationId !== identity.clientMutationId ||
    ledger.changeRecordId !== identity.changeRecordId ||
    ledger.fingerprint !== identity.fingerprint ||
    Object.prototype.hasOwnProperty.call(ledger, 'summaryReportRecordId') ||
    !request ||
    request.clientMutationId !== identity.clientMutationId ||
    request.changeRecordId !== identity.changeRecordId ||
    !uploaded ||
    !sourceFiles
  ) {
    throwIdentityMismatch();
  }
  const submitterName = normalizeChangeSummaryReportSubmitterName(
    request.submitterName,
  );
  if (!submitterName) {
    throw new ConflictException('变更总结失败自测台账提交人缺失，拒绝清理');
  }

  const documents = Array.isArray(request.summaryDocuments)
    ? request.summaryDocuments
    : null;
  const requestObjectIds = documents
    ?.map((document) =>
      isPlainRecord(document) && isPlainRecord(document.objectStorage)
        ? String(document.objectStorage.id || '').trim()
        : '',
    )
    .sort();
  if (
    !requestObjectIds ||
    requestObjectIds.some((id) => !OBJECT_ID_PATTERN.test(id)) ||
    new Set(requestObjectIds).size !== requestObjectIds.length ||
    !sameValues(requestObjectIds, identity.summaryObjectIds)
  ) {
    throwIdentityMismatch();
  }

  const uploadedObjectIds = uploaded
    .map((entry) => {
      if (!isPlainRecord(entry)) return '';
      const storageId = String(entry.storageId || '').trim();
      const fileToken = String(entry.fileToken || '').trim();
      return OBJECT_ID_PATTERN.test(storageId) &&
        FILE_TOKEN_PATTERN.test(fileToken)
        ? storageId
        : '';
    })
    .sort();
  if (
    uploadedObjectIds.some((id) => !id) ||
    new Set(uploadedObjectIds).size !== uploadedObjectIds.length ||
    uploadedObjectIds.some((id) => !identity.summaryObjectIds.includes(id))
  ) {
    throwIdentityMismatch();
  }

  const sourceObjectIds = sourceFiles
    .map((sourceFile) =>
      isPlainRecord(sourceFile) ? String(sourceFile.id || '').trim() : '',
    )
    .sort();
  if (
    sourceObjectIds.some((id) => !OBJECT_ID_PATTERN.test(id)) ||
    new Set(sourceObjectIds).size !== sourceObjectIds.length ||
    (sourceObjectIds.length > 0 &&
      !sameValues(sourceObjectIds, identity.summaryObjectIds))
  ) {
    throwIdentityMismatch();
  }
  return submitterName;
}

function assertCleanupTombstone(
  value: string,
  mutationHash: string,
  identityHash: string,
): 'canonical' | 'legacy' {
  const tombstone = parseLedger(value);
  const commonInvalid =
    tombstone.version !== 1 ||
    tombstone.state !== 'self-test-cleaned' ||
    tombstone.mutationHash !== mutationHash ||
    typeof tombstone.cleanedAt !== 'string' ||
    !Number.isFinite(Date.parse(tombstone.cleanedAt));
  if (commonInvalid) {
    throw new ConflictException('变更总结失败自测清理墓碑损坏');
  }
  const keys = Object.keys(tombstone).sort();
  const canonicalKeys = [
    'cleanedAt',
    'mutationHash',
    'proofDigests',
    'state',
    'version',
  ];
  if (
    sameValues(keys, canonicalKeys) &&
    Array.isArray(tombstone.proofDigests) &&
    tombstone.proofDigests.length === 1 &&
    tombstone.proofDigests[0] === identityHash
  ) {
    return 'canonical';
  }
  const legacyKeys = [
    'cleanedAt',
    'cleanupKind',
    'identityHash',
    'mutationHash',
    'proofDigests',
    'state',
    'version',
  ];
  if (
    sameValues(keys, legacyKeys) &&
    tombstone.cleanupKind === 'failed-change-summary' &&
    tombstone.identityHash === identityHash &&
    Array.isArray(tombstone.proofDigests) &&
    tombstone.proofDigests.length === 0
  ) {
    return 'legacy';
  }
  throw new ConflictException('变更总结失败自测清理墓碑损坏');
}

async function persistCanonicalCleanupTombstone(
  tombstonePath: string,
  mutationHash: string,
  identityHash: string,
  cleanedAt: string,
): Promise<void> {
  if (!Number.isFinite(Date.parse(cleanedAt))) {
    throw new ConflictException('变更总结失败自测清理墓碑损坏');
  }
  const temporary = `${tombstonePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({
      version: 1,
      state: 'self-test-cleaned',
      mutationHash,
      proofDigests: [identityHash],
      cleanedAt,
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  await rename(temporary, tombstonePath).catch(async (error) => {
    await unlink(temporary).catch(() => undefined);
    throw error;
  });
}

function parseLedger(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isPlainRecord(parsed)) return parsed;
  } catch {
    // Durable cleanup data must fail closed.
  }
  throw new ConflictException('变更总结失败自测台账损坏，拒绝清理');
}

function hashCleanupIdentity(identity: NormalizedCleanupIdentity): string {
  return hash(
    JSON.stringify({
      version: 1,
      clientMutationId: identity.clientMutationId,
      changeRequestMutationId: identity.changeRequestMutationId,
      changeRecordId: identity.changeRecordId,
      summaryMarker: identity.summaryMarker,
      fingerprint: identity.fingerprint,
      changeObjectIds: identity.changeObjectIds,
      summaryObjectIds: identity.summaryObjectIds,
    }),
  );
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function throwIdentityMismatch(): never {
  throw new ConflictException('变更总结失败自测台账身份不一致，拒绝清理');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
