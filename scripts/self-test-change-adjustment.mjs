import axios from 'axios';
import FormData from 'form-data';
import {
  createHash,
  createHmac,
  randomUUID as createRandomUUID,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { Agent as HttpsAgent } from 'node:https';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHANGE_TABLE_ID = 'tblBvg6wCYSX3hcg';
const CHANGE_TABLE_NAME = '计划变更日历';
const DEFAULT_CHANGE_SOURCE_URL =
  'https://vnet.feishu.cn/wiki/JhiVwgfoIimAqEk8YwEc09sknGd?table=tblBvg6wCYSX3hcg&view=vewew3vfZT';
const DEFAULT_BASE_URL = 'https://127.0.0.1:3001';
const DEFAULT_STATE_PATH = resolve(
  process.cwd(),
  'output/diagnostics/change-adjustment-real-self-test-state.json',
);
const WHOLE_UPLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
const MAX_SCHEME_BYTES = 200 * 1024 * 1024;
const MIN_SCHEME_BYTES = 1024;
const DEFAULT_LARGE_PDF_BYTES = WHOLE_UPLOAD_LIMIT_BYTES + 64 * 1024;
const CHANGE_REQUEST_SYNC_POLL_MAX_ATTEMPTS = 360;
const BASE_RECORD_ID_PATTERN = /^rec[A-Za-z0-9_-]+$/;
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{12,80}$/;
const CREATE_MUTATION_ID_PATTERN =
  /^change-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADJUSTMENT_MUTATION_ID_PATTERN =
  /^change-adjustment-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUMMARY_MARKER_PATTERN = /^CODEX-SELFTEST-CHANGE-\d{13}-[0-9a-f]{8}$/;
const ADJUSTMENT_REASON_MARKER_PATTERN =
  /^CODEX-SELFTEST-CHANGE-ADJUST-\d{13}-[0-9a-f]{8}$/;
const STATE_KEYS = [
  'version',
  'createMutationId',
  'adjustmentMutationId',
  'recordId',
  'summaryMarker',
  'adjustmentReasonMarker',
  'disposition',
  'cleanupPhase',
  'attachments',
];
const STATE_DISPOSITIONS = new Set([
  'prepared',
  'create-confirmed',
  'adjustment-confirmed',
  'definitely-not-written',
  'unknown-result',
]);
const CLEANUP_PHASES = new Set([
  'none',
  'objects-delete-armed',
  'objects-deleted',
  'base-delete-armed',
  'base-deleted',
]);
const SELF_TEST_OPERATIONS = new Set([
  'prime-local-api',
  'load-personnel',
  'validate-submitter-field',
  'stage-initial-scheme',
  'submit-create',
  'wait-create-sync',
  'verify-created',
  'replay-create',
  'tamper-create',
  'stage-replacement-scheme',
  'stage-evidence',
  'refresh-adjustment-version',
  'submit-adjustment',
  'verify-adjusted',
  'replay-adjustment',
  'tamper-adjustment',
  'cleanup',
  'unknown',
]);
const BASE_FIELD_NAMES = [
  '变更简述',
  '变更重要风险点（简述）',
  '变更提交人',
  '计划开始日期（阿里）',
  '计划结束日期（阿里）',
  '计划延迟开始日期',
  '计划延迟结束日期',
  '延期理由',
  '延期举证',
  '变更文档',
  '调整请求唯一ID',
  '调整请求指纹',
];
const CSRF_COOKIE_NAME = 'suda-csrf-token';
const CSRF_HEADER_NAME = 'x-suda-csrf-token';
const CSRF_TOKEN_PATTERNS = [/^[A-Za-z0-9_-]{43}$/, /^[a-f0-9]{40}-\d{10}$/];
const ACCESS_SESSION_COOKIE_NAME = 'vnet_access_session';
const ACCESS_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_ACCESS_SESSION_TOKEN_LENGTH = 4096;
const PNG_FIXTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

export class UnsafeChangeSelfTestCleanupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeChangeSelfTestCleanupError';
  }
}

export function selectExactLocalSubmitter(people) {
  if (!Array.isArray(people)) {
    throw new Error('本地人员缓存格式无效');
  }
  const grouped = new Map();
  for (const person of people) {
    const name = clean(person?.supervisorText || person?.name);
    const key = normalizeName(name);
    if (!key) continue;
    const entries = grouped.get(key) || [];
    entries.push(name);
    grouped.set(key, entries);
  }
  const candidates = [...grouped.values()]
    .filter((names) => names.length === 1)
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  if (candidates.length === 0) {
    throw new Error('本地人员缓存中没有唯一可精确匹配的提交人');
  }
  return candidates[0];
}

export function assertWritableChangeSubmitterField(schemas) {
  if (!Array.isArray(schemas)) {
    throw new Error('计划变更日历字段列表格式无效');
  }
  const field = schemas.find(
    (item) =>
      item?.fieldName === '变更提交人' &&
      Number(item?.type) === 11 &&
      item?.writable === true,
  );
  if (!field) {
    throw new Error('计划变更日历缺少可写的人员字段“变更提交人”');
  }
  return { fieldName: '变更提交人', type: 11, writable: true };
}

export async function writeLargePdfFixture(
  path,
  targetSize = DEFAULT_LARGE_PDF_BYTES,
  variant = 'fixture',
) {
  if (
    !isAbsolute(path) ||
    !Number.isSafeInteger(targetSize) ||
    targetSize < MIN_SCHEME_BYTES ||
    targetSize > MAX_SCHEME_BYTES
  ) {
    throw new Error('PDF 自测文件必须至少 1 KiB 且不超过 200 MiB');
  }
  const layout = buildPdfLayout(targetSize, clean(variant) || 'fixture');
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'wx', 0o600);
  try {
    await writeHandleFully(handle, Buffer.from(layout.prefix, 'binary'));
    const padding = Buffer.alloc(1024 * 1024, 0x20);
    let remaining = layout.streamLength;
    while (remaining > 0) {
      const length = Math.min(remaining, padding.length);
      await writeHandleFully(handle, padding.subarray(0, length));
      remaining -= length;
    }
    await writeHandleFully(handle, Buffer.from(layout.suffix, 'binary'));
    await handle.sync();
  } finally {
    await handle.close();
  }
  const descriptor = await inspectLargePdfFixture(path);
  if (!descriptor.valid || descriptor.size !== targetSize) {
    await unlinkIfExists(path);
    throw new Error('PDF 自测文件生成后校验失败');
  }
  return {
    absolutePath: path,
    filename: basename(path),
    mimeType: 'application/pdf',
    size: descriptor.size,
  };
}

export async function inspectLargePdfFixture(path) {
  if (!isAbsolute(path) || extname(path).toLowerCase() !== '.pdf') {
    return { valid: false, aboveWholeUploadLimit: false, size: 0 };
  }
  let details;
  let handle;
  try {
    details = await stat(path);
    if (!details.isFile()) {
      return { valid: false, aboveWholeUploadLimit: false, size: 0 };
    }
    handle = await open(path, 'r');
    const head = Buffer.alloc(8);
    const tail = Buffer.alloc(Math.min(details.size, 4096));
    await handle.read(head, 0, head.length, 0);
    await handle.read(
      tail,
      0,
      tail.length,
      Math.max(0, details.size - tail.length),
    );
    const tailText = tail.toString('binary');
    const valid =
      head.toString('binary') === '%PDF-1.7' &&
      tailText.includes('\nxref\n') &&
      tailText.includes('\ntrailer\n') &&
      /startxref\n\d+\n%%EOF\n$/.test(tailText);
    return {
      valid,
      aboveWholeUploadLimit: details.size > WHOLE_UPLOAD_LIMIT_BYTES,
      size: details.size,
    };
  } catch {
    return { valid: false, aboveWholeUploadLimit: false, size: 0 };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function validateSchemeFixtureExpectation(
  fixture,
  requestedSchemeBytes = null,
) {
  const expectedSchemeBytes = normalizeOptionalSchemeBytes(
    requestedSchemeBytes,
  );
  const size = Number(fixture?.size);
  const crossesWholeUploadLimit = size > WHOLE_UPLOAD_LIMIT_BYTES;
  const sizeMatches =
    expectedSchemeBytes === null
      ? crossesWholeUploadLimit
      : size === expectedSchemeBytes &&
        crossesWholeUploadLimit ===
          (expectedSchemeBytes > WHOLE_UPLOAD_LIMIT_BYTES);
  if (
    fixture?.valid !== true ||
    !Number.isSafeInteger(size) ||
    size < MIN_SCHEME_BYTES ||
    size > MAX_SCHEME_BYTES ||
    fixture?.aboveWholeUploadLimit !== crossesWholeUploadLimit ||
    !sizeMatches
  ) {
    throw new Error(
      expectedSchemeBytes === null
        ? '--scheme 必须是大于 20 MiB 且不超过 200 MiB 的有效 PDF'
        : '--scheme 必须是与 --scheme-bytes 完全一致且不超过 200 MiB 的有效 PDF',
    );
  }
  return fixture;
}

function buildPdfLayout(targetSize, variant) {
  let streamLength = targetSize - 600;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const layout = renderPdfLayout(streamLength, variant);
    const difference = targetSize - layout.totalSize;
    if (difference === 0) return layout;
    streamLength += difference;
    if (streamLength < 1) break;
  }
  throw new Error('无法精确生成指定大小的 PDF 自测文件');
}

function renderPdfLayout(streamLength, variant) {
  const parts = ['%PDF-1.7\n%\xE2\xE3\xCF\xD3\n'];
  const offsets = [];
  const pushObject = (body) => {
    offsets.push(byteLength(parts.join('')));
    parts.push(body);
  };
  pushObject('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  pushObject('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  pushObject(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R >>\nendobj\n',
  );
  offsets.push(byteLength(parts.join('')));
  parts.push(
    `4 0 obj\n<< /Length ${streamLength} /SelfTest (${escapePdfText(variant)}) >>\nstream\n`,
  );
  const prefix = parts.join('');
  const contentTail = '\nendstream\nendobj\n';
  const xrefOffset =
    byteLength(prefix) + streamLength + byteLength(contentTail);
  const xref = [
    'xref\n0 5\n',
    '0000000000 65535 f \n',
    ...offsets.map(
      (offset) => `${String(offset).padStart(10, '0')} 00000 n \n`,
    ),
    'trailer\n<< /Size 5 /Root 1 0 R >>\n',
    `startxref\n${xrefOffset}\n%%EOF\n`,
  ].join('');
  const suffix = `${contentTail}${xref}`;
  return {
    prefix,
    suffix,
    streamLength,
    totalSize: byteLength(prefix) + streamLength + byteLength(suffix),
  };
}

function escapePdfText(value) {
  return value.replace(/[()\\]/g, (character) => `\\${character}`).slice(0, 64);
}

function byteLength(value) {
  return Buffer.byteLength(value, 'binary');
}

async function writeHandleFully(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (bytesWritten <= 0) throw new Error('PDF 自测文件写入不完整');
    offset += bytesWritten;
  }
}

export async function runChangeAdjustmentSelfTest(options, dependencies) {
  const requestedSchemeBytes = normalizeOptionalSchemeBytes(
    options?.schemeBytes,
  );
  const now = dependencies.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('真实自测当前时间无效');
  }
  const createUuid = dependencies.randomUUID?.() ?? createRandomUUID();
  const adjustmentUuid = dependencies.randomUUID?.() ?? createRandomUUID();
  const createMutationId = `change-request-${createUuid}`;
  const adjustmentMutationId = `change-adjustment-${adjustmentUuid}`;
  const summaryMarker = `CODEX-SELFTEST-CHANGE-${now.getTime()}-${String(
    createUuid,
  )
    .slice(0, 8)
    .toLowerCase()}`;
  const adjustmentReasonMarker = `CODEX-SELFTEST-CHANGE-ADJUST-${now.getTime()}-${String(
    adjustmentUuid,
  )
    .slice(0, 8)
    .toLowerCase()}`;
  let state = validateChangeSelfTestState({
    version: 1,
    createMutationId,
    adjustmentMutationId,
    recordId: '',
    summaryMarker,
    adjustmentReasonMarker,
    disposition: 'prepared',
    cleanupPhase: 'none',
    attachments: [],
  });
  let operationError = null;
  let cleanupError = null;
  let cleanupResult = null;
  let result = null;
  let baseCreateAttempted = false;
  let selfTestOperation = 'prime-local-api';

  const persist = async (next) => {
    state = validateChangeSelfTestState(next);
    await dependencies.writeState(state);
  };

  try {
    await dependencies.primeLocalApi?.();
    await persist(state);
    selfTestOperation = 'load-personnel';
    const people = await dependencies.fetchLocalPeople();
    const submitterName = selectExactLocalSubmitter(people);
    const schedule = buildFutureSchedule(now);

    selfTestOperation = 'stage-initial-scheme';
    const initialDocument = validateStagedDocument(
      await dependencies.stageLargeScheme(createMutationId, 'initial', options),
      'initial',
      requestedSchemeBytes,
    );
    await persist(
      registerAttachment(
        state,
        initialDocument.objectStorage.id,
        createMutationId,
      ),
    );

    const createRequest = {
      clientMutationId: createMutationId,
      submitterName,
      stagedDocuments: [initialDocument],
      nature: '标准变更',
      summary: summaryMarker,
      changeType: '计划性变更',
      workType: '维护',
      buildings: ['H楼'],
      plannedStartAt: schedule.startAt,
      plannedEndAt: schedule.endAt,
      discipline: '电气',
      level: '低',
      riskSummary: `自测清理校验：${summaryMarker}`,
    };
    selfTestOperation = 'submit-create';
    baseCreateAttempted = true;
    const acceptedCreate = await dependencies.postChangeRequest(createRequest);
    assertMutationResponse(acceptedCreate, createMutationId, '首次变更申请');
    const recordId = getResponseRecordId(acceptedCreate);
    await persist({
      ...state,
      recordId,
      disposition: 'create-confirmed',
    });
    selfTestOperation = 'validate-submitter-field';
    await dependencies.assertWritableSubmitterField?.();
    selfTestOperation = 'wait-create-sync';
    const firstCreate = await waitForChangeRequestSyncCompletion(
      acceptedCreate,
      createMutationId,
      dependencies,
    );
    if (getResponseRecordId(firstCreate) !== recordId) {
      throw new Error('变更申请后台同步返回了不同记录');
    }

    selfTestOperation = 'verify-created';
    const createdRecord = await verifyCreatedRecord(
      state,
      {
        submitterName,
        startAt: schedule.startAt,
        endAt: schedule.endAt,
      },
      dependencies,
    );
    const originalDocumentToken = attachmentTokens(
      asFields(createdRecord)['变更文档'],
    )[0];
    selfTestOperation = 'replay-create';
    const acceptedReplay = await dependencies.postChangeRequest(createRequest);
    const createReplay = await waitForChangeRequestSyncCompletion(
      acceptedReplay,
      createMutationId,
      dependencies,
    );
    if (getResponseRecordId(createReplay) !== recordId) {
      throw new Error('变更申请幂等重放返回了不同记录');
    }
    selfTestOperation = 'tamper-create';
    const createTamperConflictVerified = await expectConflict(() =>
      dependencies.postChangeRequest({
        ...createRequest,
        summary: `${summaryMarker}-tampered`,
      }),
    );

    selfTestOperation = 'stage-replacement-scheme';
    const replacementDocument = validateStagedDocument(
      await dependencies.stageLargeScheme(
        adjustmentMutationId,
        'replacement',
        options,
      ),
      'replacement',
      requestedSchemeBytes,
    );
    await persist(
      registerAttachment(
        state,
        replacementDocument.objectStorage.id,
        adjustmentMutationId,
      ),
    );
    selfTestOperation = 'stage-evidence';
    const evidenceDocument = validateStagedDocument(
      await dependencies.stageEvidence(adjustmentMutationId, options),
      'evidence',
    );
    await persist(
      registerAttachment(
        state,
        evidenceDocument.objectStorage.id,
        adjustmentMutationId,
      ),
    );

    const preAdjustmentRecord = await dependencies.getBaseRecordById(recordId);
    if (!preAdjustmentRecord) {
      throw new Error('提交调整前未找到已创建的变更记录');
    }
    assertBaseIdentity(state, preAdjustmentRecord, false);
    const preAdjustmentTokens = attachmentTokens(
      asFields(preAdjustmentRecord)['变更文档'],
    );
    if (
      preAdjustmentTokens.length !== 1 ||
      preAdjustmentTokens[0] !== originalDocumentToken
    ) {
      throw new Error('提交调整前变更方案已发生变化');
    }
    selfTestOperation = 'refresh-adjustment-version';
    const localChange =
      typeof dependencies.getLocalChangeById === 'function'
        ? await dependencies.getLocalChangeById(
            recordId,
            Number(schedule.startAt.slice(0, 4)),
          )
        : null;
    if (localChange) {
      const localRecordId = clean(
        localChange.bitableRecordId || localChange.id,
      );
      if (
        localRecordId !== recordId ||
        clean(localChange.title) !== state.summaryMarker ||
        !attachmentTokens(localChange.planDocuments).includes(
          originalDocumentToken,
        )
      ) {
        throw new Error('本地变更版本回读身份不一致');
      }
    }
    const expectedUpdatedAt = resolveExpectedUpdatedAt(
      localChange?.adjustmentUpdatedAt,
      preAdjustmentRecord?.last_modified_time,
    );

    const adjustedSchedule = buildAdjustedSchedule(schedule);
    const adjustmentRequest = {
      clientMutationId: adjustmentMutationId,
      recordId,
      expectedUpdatedAt,
      plannedDelayStartDate: adjustedSchedule.startAt,
      plannedDelayEndDate: adjustedSchedule.endAt,
      reason: adjustmentReasonMarker,
      retainedDocumentTokens: [],
      removedDocumentTokens: [originalDocumentToken],
      newSchemeDocuments: [replacementDocument],
      evidenceDocuments: [evidenceDocument],
    };
    selfTestOperation = 'submit-adjustment';
    const firstAdjustment =
      await dependencies.postChangeAdjustment(adjustmentRequest);
    assertMutationResponse(
      firstAdjustment,
      adjustmentMutationId,
      '首次变更调整',
    );
    if (getResponseRecordId(firstAdjustment) !== recordId) {
      throw new Error('变更调整返回了其他记录');
    }
    await persist({ ...state, disposition: 'adjustment-confirmed' });

    selfTestOperation = 'verify-adjusted';
    await verifyAdjustedRecord(
      state,
      {
        startAt: adjustedSchedule.startAt,
        endAt: adjustedSchedule.endAt,
        originalDocumentToken,
      },
      dependencies,
    );
    selfTestOperation = 'replay-adjustment';
    const adjustmentReplay =
      await dependencies.postChangeAdjustment(adjustmentRequest);
    assertMutationResponse(
      adjustmentReplay,
      adjustmentMutationId,
      '变更调整幂等重放',
    );
    if (getResponseRecordId(adjustmentReplay) !== recordId) {
      throw new Error('变更调整幂等重放返回了不同记录');
    }
    selfTestOperation = 'tamper-adjustment';
    const adjustmentTamperConflictVerified = await expectConflict(() =>
      dependencies.postChangeAdjustment({
        ...adjustmentRequest,
        reason: `${adjustmentReasonMarker}-tampered`,
      }),
    );

    result = {
      ok: true,
      createReplayVerified: true,
      createTamperConflictVerified,
      adjustmentReplayVerified: true,
      adjustmentTamperConflictVerified,
      createRequestRef: createSafeRef(createMutationId),
      adjustmentRequestRef: createSafeRef(adjustmentMutationId),
      recordRef: createSafeRef(recordId),
    };
  } catch (error) {
    operationError = tagSelfTestOperation(error, selfTestOperation);
    const disposition = baseCreateAttempted
      ? classifyMutationError(error)
      : 'definitely-not-written';
    try {
      await persist({ ...state, disposition });
    } catch (stateError) {
      operationError = new AggregateError(
        [error, stateError],
        '变更真实自测失败，保存恢复状态也失败',
      );
    }
  } finally {
    try {
      cleanupResult = await cleanupChangeAdjustmentState(state, dependencies);
    } catch (error) {
      cleanupError = tagSelfTestOperation(error, 'cleanup');
    }
  }

  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      '变更真实自测失败，自动清理也未能安全完成',
    );
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return {
    ...result,
    cleaned: cleanupResult?.cleaned === true,
    residualCount: cleanupResult?.residualCount ?? 0,
    objectResidualCount: cleanupResult?.objectResidualCount ?? 0,
  };
}

function buildFutureSchedule(now) {
  const future = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const date = shanghaiDateKey(future);
  return { startAt: `${date}T09:00`, endAt: `${date}T18:00` };
}

function buildAdjustedSchedule(schedule) {
  const date = schedule.startAt.slice(0, 10);
  return { startAt: `${date}T10:00`, endAt: `${date}T20:00` };
}

function shanghaiDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function registerAttachment(state, id, ownerMutationId) {
  const normalizedId = clean(id);
  if (!ATTACHMENT_ID_PATTERN.test(normalizedId)) {
    throw new Error('对象存储附件标识无效');
  }
  if (
    ownerMutationId !== state.createMutationId &&
    ownerMutationId !== state.adjustmentMutationId
  ) {
    throw new Error('对象存储附件所属请求无效');
  }
  if (state.attachments.some((item) => item.id === normalizedId)) {
    throw new Error('对象存储附件标识重复');
  }
  return validateChangeSelfTestState({
    ...state,
    attachments: [...state.attachments, { id: normalizedId, ownerMutationId }],
  });
}

function normalizeOptionalSchemeBytes(value) {
  if (value === null || value === undefined) return null;
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_SCHEME_BYTES ||
    value > MAX_SCHEME_BYTES
  ) {
    throw new Error('方案自测文件大小必须在 1 KiB 至 200 MiB 之间');
  }
  return value;
}

export function validateStagedDocument(
  document,
  label,
  requestedSchemeBytes = null,
) {
  const id = clean(document?.objectStorage?.id);
  const url = clean(document?.objectStorage?.url);
  const size = Number(document?.size);
  const expectedSchemeBytes = normalizeOptionalSchemeBytes(
    requestedSchemeBytes,
  );
  const schemeSizeValid =
    expectedSchemeBytes === null
      ? size > WHOLE_UPLOAD_LIMIT_BYTES && size <= MAX_SCHEME_BYTES
      : size === expectedSchemeBytes &&
        (size > WHOLE_UPLOAD_LIMIT_BYTES) ===
          (expectedSchemeBytes > WHOLE_UPLOAD_LIMIT_BYTES);
  if (
    !ATTACHMENT_ID_PATTERN.test(id) ||
    url !==
      `/api/duty-schedules/change-attachments/${encodeURIComponent(id)}/download` ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    (label !== 'evidence' && !schemeSizeValid) ||
    (label === 'evidence' && size > WHOLE_UPLOAD_LIMIT_BYTES)
  ) {
    throw new Error(`${label} 附件暂存响应校验失败`);
  }
  return document;
}

function assertMutationResponse(response, mutationId, label) {
  if (
    response?.success !== true ||
    response?.clientMutationId !== mutationId ||
    !BASE_RECORD_ID_PATTERN.test(getResponseRecordId(response))
  ) {
    throw new Error(`${label}响应校验失败`);
  }
}

export async function waitForChangeRequestSyncCompletion(
  response,
  mutationId,
  dependencies,
) {
  assertMutationResponse(response, mutationId, '变更申请');
  if (response.pendingSync !== true) return response;

  const taskId = clean(response.taskId);
  const acceptedRecordId = getResponseRecordId(response);
  if (taskId !== mutationId || !CREATE_MUTATION_ID_PATTERN.test(taskId)) {
    throw createPostCommitSyncError('变更申请后台任务标识无效');
  }
  if (typeof dependencies?.getChangeRequestSyncTask !== 'function') {
    throw createPostCommitSyncError('变更申请后台任务查询能力不可用');
  }

  const configuredAttempts = Number(dependencies.changeRequestSyncPollMaxAttempts);
  const maxAttempts =
    Number.isSafeInteger(configuredAttempts) &&
    configuredAttempts > 0 &&
    configuredAttempts <= CHANGE_REQUEST_SYNC_POLL_MAX_ATTEMPTS
      ? configuredAttempts
      : CHANGE_REQUEST_SYNC_POLL_MAX_ATTEMPTS;
  const waitBeforePoll =
    typeof dependencies.waitBeforeSyncPoll === 'function'
      ? dependencies.waitBeforeSyncPoll
      : dependencies.waitBeforeRecheck;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const taskResponse = await dependencies.getChangeRequestSyncTask(taskId);
    const task = taskResponse?.success === true ? taskResponse.task : null;
    if (!task || task.id !== taskId) {
      throw createPostCommitSyncError('变更申请后台任务回读失败');
    }
    if (task.status === 'failed') {
      const failedRecordId = clean(task.result?.recordId);
      if (failedRecordId && failedRecordId !== acceptedRecordId) {
        throw createPostCommitSyncError('变更申请后台任务记录标识不一致');
      }
      throw createPostCommitSyncError(
        '变更申请正式记录已创建，但后台附件同步失败',
      );
    }
    if (task.status === 'completed') {
      const completed = task.result;
      assertMutationResponse(completed, mutationId, '变更申请后台同步');
      if (
        completed.pendingSync === true ||
        getResponseRecordId(completed) !== acceptedRecordId
      ) {
        throw createPostCommitSyncError('变更申请后台同步结果校验失败');
      }
      return completed;
    }
    if (!['pending', 'running'].includes(task.status)) {
      throw createPostCommitSyncError('变更申请后台任务状态无效');
    }
    if (attempt < maxAttempts - 1) {
      if (typeof waitBeforePoll === 'function') {
        await waitBeforePoll(1000);
      } else {
        await delay(1000);
      }
    }
  }
  throw createPostCommitSyncError('变更申请后台附件同步超时');
}

function createPostCommitSyncError(message) {
  return Object.assign(new Error(message), {
    writeDisposition: 'confirmed-post-commit-pending',
    recordState: 'created',
  });
}

function getResponseRecordId(response) {
  return clean(response?.record?.bitableRecordId || response?.record?.id);
}

async function expectConflict(operation) {
  try {
    await operation();
  } catch (error) {
    if (Number(error?.response?.status ?? error?.status) === 409) return true;
    throw error;
  }
  throw new Error('相同请求 ID 的篡改内容未被 409 拒绝');
}

async function verifyCreatedRecord(state, expected, dependencies) {
  const records = await queryRecordsWithRetry(
    () => dependencies.queryBaseByMarker(state.summaryMarker),
    dependencies,
    (items) => items.length > 0,
  );
  if (records.length !== 1) {
    throw new Error(
      `按变更唯一 marker 回查必须恰好 1 条，实际 ${records.length} 条`,
    );
  }
  const record = records[0];
  assertBaseIdentity(state, record, false);
  const fields = asFields(record);
  if (!displayValues(fields['变更提交人']).includes(expected.submitterName)) {
    throw new Error('Base 变更提交人未正确回填');
  }
  if (
    fieldEpochMs(fields['计划开始日期（阿里）']) !==
      parseShanghaiLocal(expected.startAt) ||
    fieldEpochMs(fields['计划结束日期（阿里）']) !==
      parseShanghaiLocal(expected.endAt)
  ) {
    throw new Error('Base 变更计划时间与申请不一致');
  }
  const tokens = attachmentTokens(fields['变更文档']);
  if (tokens.length !== 1) {
    throw new Error('Base 变更方案附件必须恰好 1 个');
  }
  return record;
}

async function verifyAdjustedRecord(state, expected, dependencies) {
  const [markerRecords, adjustmentRecords] = await Promise.all([
    queryRecordsWithRetry(
      () => dependencies.queryBaseByMarker(state.summaryMarker),
      dependencies,
      (items) => items.length > 0,
    ),
    queryRecordsWithRetry(
      () => dependencies.queryBaseByAdjustmentId(state.adjustmentMutationId),
      dependencies,
      (items) => items.length > 0,
    ),
  ]);
  if (markerRecords.length !== 1 || adjustmentRecords.length !== 1) {
    throw new Error('变更调整的 marker/ID 严格回查未各命中 1 条');
  }
  const record = markerRecords[0];
  if (getRecordId(adjustmentRecords[0]) !== getRecordId(record)) {
    throw new Error('变更调整唯一 ID 命中了其他记录');
  }
  assertBaseIdentity(state, record, false, true);
  const fields = asFields(record);
  if (
    fieldEpochMs(fields['计划延迟开始日期']) !==
      parseShanghaiLocal(expected.startAt) ||
    fieldEpochMs(fields['计划延迟结束日期']) !==
      parseShanghaiLocal(expected.endAt)
  ) {
    throw new Error('Base 延期时间与调整请求不一致');
  }
  const documents = attachmentTokens(fields['变更文档']);
  const evidence = attachmentTokens(fields['延期举证']);
  if (
    documents.length !== 1 ||
    documents[0] === expected.originalDocumentToken ||
    evidence.length < 1
  ) {
    throw new Error('Base 方案替换或延期举证回填未通过');
  }
  const fingerprint = fieldText(fields['调整请求指纹']);
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) {
    throw new Error('Base 调整请求指纹未正确回填');
  }
  return record;
}

function resolveExpectedUpdatedAt(responseValue, recordValue) {
  // Prefer the same force-refreshed ChangeInfo.updatedAt used by the browser.
  // The raw Base metadata remains a fallback for isolated unit dependencies.
  for (const value of [responseValue, recordValue]) {
    const parsed = dateTimeToEpoch(value);
    if (parsed !== null) return new Date(parsed).toISOString();
  }
  throw new Error('变更申请回读缺少可用的更新时间');
}

export async function cleanupChangeAdjustmentState(stateInput, dependencies) {
  await dependencies.primeLocalApi?.();
  let state = validateChangeSelfTestState(stateInput);
  const persist = async (next) => {
    state = validateChangeSelfTestState(next);
    await dependencies.writeState(state);
  };
  let records = await queryRecordsWithRetry(
    () => dependencies.queryBaseByMarker(state.summaryMarker),
    dependencies,
    (items) => items.length > 0,
  );
  if (records.length > 1) {
    throw new UnsafeChangeSelfTestCleanupError(
      `变更唯一 marker 命中 ${records.length} 条记录，拒绝删除`,
    );
  }

  if (records.length === 1) {
    const candidate = records[0];
    const adoptedId = assertBaseIdentity(
      state,
      candidate,
      state.recordId === '',
      state.disposition === 'adjustment-confirmed',
    );
    if (!state.recordId) {
      await persist({ ...state, recordId: adoptedId });
    }
    if (state.disposition === 'adjustment-confirmed') {
      const byAdjustment = await dependencies.queryBaseByAdjustmentId(
        state.adjustmentMutationId,
      );
      if (
        !Array.isArray(byAdjustment) ||
        byAdjustment.length !== 1 ||
        getRecordId(byAdjustment[0]) !== state.recordId
      ) {
        throw new UnsafeChangeSelfTestCleanupError(
          '调整请求唯一 ID 与待删记录不一致',
        );
      }
    }
    const exact = await dependencies.getBaseRecordById(state.recordId);
    if (!exact) {
      throw new UnsafeChangeSelfTestCleanupError(
        '精确 recordId 回读为空，拒绝继续清理',
      );
    }
    assertBaseIdentity(
      state,
      exact,
      false,
      state.disposition === 'adjustment-confirmed',
    );

    if (state.cleanupPhase === 'none') {
      await persist({ ...state, cleanupPhase: 'objects-delete-armed' });
    }
    await cleanupSelfTestAttachments(state, dependencies, true);
    if (
      state.cleanupPhase === 'none' ||
      state.cleanupPhase === 'objects-delete-armed'
    ) {
      await persist({ ...state, cleanupPhase: 'objects-deleted' });
    }
    if (state.cleanupPhase !== 'base-delete-armed') {
      await persist({ ...state, cleanupPhase: 'base-delete-armed' });
    }
    await dependencies.deleteBaseRecordById(state.recordId);
    await persist({ ...state, cleanupPhase: 'base-deleted' });
  } else if (
    state.cleanupPhase === 'base-delete-armed' ||
    state.cleanupPhase === 'base-deleted'
  ) {
    if (!state.recordId) {
      throw new UnsafeChangeSelfTestCleanupError(
        '已启动 Base 删除但状态中缺少 recordId',
      );
    }
    const exact = await dependencies.getBaseRecordById(state.recordId);
    if (exact) {
      throw new UnsafeChangeSelfTestCleanupError(
        '唯一 marker 查询为空但 recordId 仍存在，拒绝清理对象',
      );
    }
    if (state.cleanupPhase !== 'base-deleted') {
      await persist({ ...state, cleanupPhase: 'base-deleted' });
    }
  } else if (
    state.disposition === 'unknown-result' ||
    state.disposition === 'create-confirmed' ||
    state.disposition === 'adjustment-confirmed' ||
    state.recordId
  ) {
    throw new UnsafeChangeSelfTestCleanupError(
      '写入结果未知或已确认，但尚未严格回查到记录；已保留状态和对象',
    );
  }

  records = await queryRecordsWithRetry(
    () => dependencies.queryBaseByMarker(state.summaryMarker),
    dependencies,
    (items) => items.length === 0,
  );
  if (records.length !== 0) {
    throw new UnsafeChangeSelfTestCleanupError(
      `Base 删除后变更 marker 仍残留 ${records.length} 条记录`,
    );
  }
  const adjustmentResidual = await queryRecordsWithRetry(
    () => dependencies.queryBaseByAdjustmentId(state.adjustmentMutationId),
    dependencies,
    (items) => items.length === 0,
  );
  if (adjustmentResidual.length !== 0) {
    throw new UnsafeChangeSelfTestCleanupError(
      `Base 删除后调整唯一 ID 仍残留 ${adjustmentResidual.length} 条记录`,
    );
  }

  const objectResidualCount = await cleanupSelfTestAttachments(
    state,
    dependencies,
    records.length > 0 ||
      !['base-delete-armed', 'base-deleted'].includes(state.cleanupPhase),
  );
  if (objectResidualCount !== 0) {
    throw new UnsafeChangeSelfTestCleanupError(
      `对象存储清理后仍残留 ${objectResidualCount} 个附件`,
    );
  }
  await dependencies.removeState();
  return {
    cleaned: true,
    residualCount: 0,
    objectResidualCount: 0,
    recordRef: state.recordId ? createSafeRef(state.recordId) : null,
  };
}

async function cleanupSelfTestAttachments(state, dependencies, allowDelete) {
  let residualCount = 0;
  for (const attachment of state.attachments) {
    let absent = await dependencies.isAttachmentAbsent(attachment);
    if (!absent && allowDelete) {
      await dependencies.deleteAttachment({
        ...attachment,
        recordId: state.recordId,
        summaryMarker: state.summaryMarker,
        adjustmentMutationId: state.adjustmentMutationId,
        adjustmentReasonMarker: state.adjustmentReasonMarker,
        adjustmentConfirmed: state.disposition === 'adjustment-confirmed',
      });
      absent = await dependencies.isAttachmentAbsent(attachment);
    }
    if (!absent) residualCount += 1;
  }
  if (residualCount !== 0) {
    throw new UnsafeChangeSelfTestCleanupError(
      `对象存储清理后仍残留 ${residualCount} 个附件`,
    );
  }
  return residualCount;
}

function assertBaseIdentity(
  state,
  record,
  allowRecordIdAdoption,
  requireAdjustmentIdentity = false,
) {
  const recordId = getRecordId(record);
  if (!BASE_RECORD_ID_PATTERN.test(recordId)) {
    throw new UnsafeChangeSelfTestCleanupError(
      'Base 记录缺少有效 recordId，拒绝删除',
    );
  }
  if (!allowRecordIdAdoption && recordId !== state.recordId) {
    throw new UnsafeChangeSelfTestCleanupError('recordId 不一致，拒绝删除');
  }
  const fields = asFields(record);
  if (fieldText(fields['变更简述']) !== state.summaryMarker) {
    throw new UnsafeChangeSelfTestCleanupError(
      '变更唯一 marker 不一致，拒绝删除',
    );
  }
  if (
    fieldText(fields['变更重要风险点（简述）']) !==
    `自测清理校验：${state.summaryMarker}`
  ) {
    throw new UnsafeChangeSelfTestCleanupError(
      '变更风险清理 marker 不一致，拒绝删除',
    );
  }
  if (
    requireAdjustmentIdentity &&
    (fieldText(fields['调整请求唯一ID']) !== state.adjustmentMutationId ||
      fieldText(fields['延期理由']) !== state.adjustmentReasonMarker)
  ) {
    throw new UnsafeChangeSelfTestCleanupError(
      '调整唯一 ID 或理由 marker 不一致，拒绝删除',
    );
  }
  return recordId;
}

export function validateChangeSelfTestState(value) {
  const hasExactKeys =
    isObject(value) &&
    Object.keys(value).sort().join('\0') === [...STATE_KEYS].sort().join('\0');
  const createMutationId = clean(value?.createMutationId);
  const adjustmentMutationId = clean(value?.adjustmentMutationId);
  const recordId = clean(value?.recordId);
  const summaryMarker = clean(value?.summaryMarker);
  const adjustmentReasonMarker = clean(value?.adjustmentReasonMarker);
  const disposition = clean(value?.disposition);
  const cleanupPhase = clean(value?.cleanupPhase);
  const attachments = Array.isArray(value?.attachments)
    ? value.attachments
    : null;
  const validAttachments =
    attachments !== null &&
    attachments.length <= 10 &&
    attachments.every(
      (item) =>
        isObject(item) &&
        Object.keys(item).sort().join('\0') === 'id\0ownerMutationId' &&
        ATTACHMENT_ID_PATTERN.test(clean(item.id)) &&
        (item.ownerMutationId === createMutationId ||
          item.ownerMutationId === adjustmentMutationId),
    ) &&
    new Set(attachments.map((item) => item.id)).size === attachments.length;
  if (
    !hasExactKeys ||
    value.version !== 1 ||
    value.createMutationId !== createMutationId ||
    !CREATE_MUTATION_ID_PATTERN.test(createMutationId) ||
    value.adjustmentMutationId !== adjustmentMutationId ||
    !ADJUSTMENT_MUTATION_ID_PATTERN.test(adjustmentMutationId) ||
    createMutationId.slice('change-request-'.length) ===
      adjustmentMutationId.slice('change-adjustment-'.length) ||
    value.recordId !== recordId ||
    (recordId !== '' && !BASE_RECORD_ID_PATTERN.test(recordId)) ||
    value.summaryMarker !== summaryMarker ||
    !SUMMARY_MARKER_PATTERN.test(summaryMarker) ||
    value.adjustmentReasonMarker !== adjustmentReasonMarker ||
    !ADJUSTMENT_REASON_MARKER_PATTERN.test(adjustmentReasonMarker) ||
    value.disposition !== disposition ||
    !STATE_DISPOSITIONS.has(disposition) ||
    value.cleanupPhase !== cleanupPhase ||
    !CLEANUP_PHASES.has(cleanupPhase) ||
    !validAttachments
  ) {
    throw new UnsafeChangeSelfTestCleanupError(
      '变更真实自测状态文件无效，拒绝清理',
    );
  }
  return {
    version: 1,
    createMutationId,
    adjustmentMutationId,
    recordId,
    summaryMarker,
    adjustmentReasonMarker,
    disposition,
    cleanupPhase,
    attachments: attachments.map((item) => ({
      id: item.id,
      ownerMutationId: item.ownerMutationId,
    })),
  };
}

function classifyMutationError(error) {
  const response = isObject(error?.response) ? error.response : null;
  const data = isObject(response?.data) ? response.data : null;
  const disposition = clean(data?.writeDisposition || error?.writeDisposition);
  const recordState = clean(data?.recordState || error?.recordState);
  if (disposition === 'rejected' || recordState === 'not-created') {
    return 'definitely-not-written';
  }
  if (
    disposition === 'unknown-result' ||
    disposition === 'confirmed-post-commit-pending' ||
    recordState === 'unknown' ||
    recordState === 'created'
  ) {
    return 'unknown-result';
  }
  const status = Number(response?.status ?? error?.status ?? error?.statusCode);
  if (
    Number.isFinite(status) &&
    status >= 400 &&
    status < 500 &&
    ![408, 409, 425, 429].includes(status)
  ) {
    return 'definitely-not-written';
  }
  return 'unknown-result';
}

async function queryRecordsWithRetry(operation, dependencies, settled) {
  const attempts = typeof dependencies.waitBeforeRecheck === 'function' ? 6 : 1;
  let records = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    records = await operation();
    if (!Array.isArray(records)) {
      throw new Error('Base 严格回查结果格式无效');
    }
    if (settled(records) || attempt === attempts - 1) return records;
    await dependencies.waitBeforeRecheck(500 * (attempt + 1));
  }
  return records;
}

function parseShanghaiLocal(value) {
  const timestamp = Date.parse(`${value}:00+08:00`);
  if (!Number.isFinite(timestamp)) throw new Error('自测时间格式无效');
  return timestamp;
}

function asFields(record) {
  return isObject(record?.fields) ? record.fields : {};
}

function getRecordId(record) {
  return clean(record?.record_id || record?.id);
}

function fieldText(value) {
  return displayValues(value).join('').trim();
}

function displayValues(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(displayValues);
  if (typeof value === 'string' || typeof value === 'number') {
    const result = String(value).trim();
    return result ? [result] : [];
  }
  if (isObject(value)) {
    for (const key of ['name', 'text', 'value', 'user_name']) {
      const nested = displayValues(value[key]);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

function attachmentTokens(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => clean(item?.file_token || item?.fileToken))
    .filter(Boolean);
}

function fieldEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 100_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    if (/^\d{10}$/.test(value)) return Number(value) * 1000;
    if (/^\d{13}$/.test(value)) return Number(value);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = fieldEpochMs(item);
      if (parsed !== null) return parsed;
    }
  }
  if (isObject(value)) {
    for (const key of ['timestamp', 'date', 'value', 'text']) {
      const parsed = fieldEpochMs(value[key]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function dateTimeToEpoch(value) {
  return fieldEpochMs(value);
}

function normalizeName(value) {
  return clean(value).replace(/\s+/g, '').toLocaleLowerCase('zh-CN');
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function tagSelfTestOperation(error, operation) {
  const safeOperation = SELF_TEST_OPERATIONS.has(operation)
    ? operation
    : 'unknown';
  if (error && typeof error === 'object') {
    try {
      error.selfTestOperation = safeOperation;
      if (error.selfTestOperation === safeOperation) return error;
    } catch {
      // Fall through to a safe wrapper for frozen foreign errors.
    }
  }
  const wrapped = new Error(
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
  wrapped.selfTestOperation = safeOperation;
  return wrapped;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createSafeRef(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

export function createLoopbackApiSession({
  baseUrl,
  client,
  accessSessionToken,
  expectedRole = 'duty_editor',
}) {
  const origin = loopbackOrigin(baseUrl);
  if (
    !client ||
    typeof client.get !== 'function' ||
    typeof client.post !== 'function'
  ) {
    throw new TypeError('本地 API 客户端无效');
  }
  const normalizedAccessSessionToken = clean(accessSessionToken);
  if (
    !ACCESS_SESSION_TOKEN_PATTERN.test(normalizedAccessSessionToken) ||
    normalizedAccessSessionToken.length > MAX_ACCESS_SESSION_TOKEN_LENGTH
  ) {
    throw new TypeError('本地 API 权限会话无效');
  }
  const accessSessionCookie = `${ACCESS_SESSION_COOKIE_NAME}=${normalizedAccessSessionToken}`;
  let primed = false;
  let csrfToken = '';
  return {
    prime: async () => {
      const response = await client.get('/', {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'sec-fetch-dest': 'document',
        },
      });
      csrfToken = extractCsrfToken(response?.headers);
      const sessionResponse = await client.get('/api/access/session', {
        headers: { Cookie: accessSessionCookie },
      });
      if (sessionResponse?.data?.role !== expectedRole) {
        throw new Error('本地 API 权限会话校验失败');
      }
      primed = true;
      return { csrfEnabled: csrfToken !== '', role: expectedRole };
    },
    get: async (path, config = {}) => {
      assertSameLoopbackPath(origin, path);
      const suppliedHeaders = isObject(config.headers) ? config.headers : {};
      if (
        Object.keys(suppliedHeaders).some(
          (name) => name.toLowerCase() === 'cookie',
        )
      ) {
        throw new TypeError('权限 Cookie 由本地 API 会话统一管理');
      }
      return client.get(path, {
        ...config,
        headers: { ...suppliedHeaders, Cookie: accessSessionCookie },
      });
    },
    post: async (path, data, config = {}) => {
      assertSameLoopbackPath(origin, path);
      if (!primed) throw new TypeError('本地 API 会话尚未初始化');
      const suppliedHeaders = isObject(config.headers) ? config.headers : {};
      if (
        Object.keys(suppliedHeaders).some((name) =>
          new Set(['cookie', CSRF_HEADER_NAME]).has(name.toLowerCase()),
        )
      ) {
        throw new TypeError('CSRF 请求头由本地 API 会话统一管理');
      }
      const headers = { ...suppliedHeaders };
      headers.Cookie = accessSessionCookie;
      if (csrfToken) {
        headers.Cookie = `${CSRF_COOKIE_NAME}=${csrfToken}; ${accessSessionCookie}`;
        headers[CSRF_HEADER_NAME] = csrfToken;
      }
      return client.post(path, data, { ...config, headers });
    },
  };
}

export function createChangeSelfTestCleanupProof(value, encodedSecret) {
  const secretText = clean(encodedSecret);
  const secret = Buffer.from(secretText, 'base64');
  if (
    secret.length !== 32 ||
    secret.toString('base64') !== secretText ||
    !Number.isSafeInteger(value?.expiresAt)
  ) {
    throw new Error('变更自测清理签名配置无效');
  }
  const payload = [
    'vnet-change-self-test-cleanup-v1',
    clean(value.recordId),
    clean(value.summaryMarker),
    clean(value.adjustmentMutationId),
    clean(value.adjustmentReasonMarker),
    value.adjustmentConfirmed === true ? '1' : '0',
    clean(value.objectId),
    clean(value.ownerMutationId),
    String(value.expiresAt),
  ].join('\n');
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function loopbackOrigin(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError('本地 API 地址无效');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !isLoopbackHost(url.hostname) ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw new TypeError('本地 API 地址必须是回环地址根路径');
  }
  return url.origin;
}

function assertSameLoopbackPath(origin, path) {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\')
  ) {
    throw new TypeError('本地 API 请求必须使用同源相对路径');
  }
  if (new URL(path, `${origin}/`).origin !== origin) {
    throw new TypeError('本地 API 请求不得跨源');
  }
}

function extractCsrfToken(headers) {
  let values = [];
  if (headers && typeof headers.getSetCookie === 'function') {
    values = headers.getSetCookie();
  } else {
    const value = headers?.['set-cookie'] ?? headers?.get?.('set-cookie');
    values = Array.isArray(value) ? value : value ? [value] : [];
  }
  const matches = values
    .filter((value) => typeof value === 'string')
    .map((value) => value.split(';', 1)[0])
    .map((pair) => {
      const separator = pair.indexOf('=');
      return separator < 0
        ? null
        : {
            name: pair.slice(0, separator).trim(),
            value: pair.slice(separator + 1).trim(),
          };
    })
    .filter((pair) => pair?.name === CSRF_COOKIE_NAME);
  if (matches.length === 0) return '';
  if (
    matches.length !== 1 ||
    !CSRF_TOKEN_PATTERNS.some((pattern) => pattern.test(matches[0].value))
  ) {
    throw new TypeError('CSRF Cookie 格式无效');
  }
  return matches[0].value;
}

async function createRealDependencies({
  baseUrl,
  statePath,
  schemePath,
  schemeBytes,
}) {
  const requestedSchemeBytes = normalizeOptionalSchemeBytes(schemeBytes);
  await import('../dist/server/runtime-env.js');
  const configModule =
    await import('../dist/server/common/config/external-services.config.js');
  const bitableModule =
    await import('../dist/server/common/feishu/bitable-direct-read.js');
  const workflowModule =
    await import('../dist/server/modules/inventory-management/inventory-workflow.gateway.js');
  const accessModule =
    await import('../dist/server/common/access/unified-access.service.js');
  const httpService = { axiosRef: axios };
  const sourceUrl =
    configModule.readEnv('FEISHU_CALENDAR_CHANGE_SOURCE_URL', [
      'FEISHU_CHANGE_CALENDAR_SOURCE_URL',
      'FEISHU_CHANGE_MANAGEMENT_SOURCE_URL',
    ]) || DEFAULT_CHANGE_SOURCE_URL;
  const parsedSource = configModule.parseFeishuBitableLink(sourceUrl);
  const configuredTableId =
    configModule.readEnv('FEISHU_CALENDAR_CHANGE_TABLE_ID', [
      'FEISHU_CHANGE_CALENDAR_TABLE_ID',
      'FEISHU_CHANGE_MANAGEMENT_TABLE_ID',
      'FEISHU_FOCUS_CHANGE_TABLE_ID',
      'FEISHU_CHANGE_TABLE_ID',
    ]) || parsedSource.tableId;
  if (configuredTableId !== CHANGE_TABLE_ID) {
    throw new Error('变更真实自测 Base 表配置与固定目标不一致');
  }
  const appToken = await bitableModule.resolveBitableAppToken(httpService, {
    appToken:
      configModule.readEnv('FEISHU_CALENDAR_CHANGE_APP_TOKEN', [
        'FEISHU_CHANGE_CALENDAR_APP_TOKEN',
        'FEISHU_CHANGE_MANAGEMENT_APP_TOKEN',
        'FEISHU_FOCUS_CHANGE_APP_TOKEN',
        'FEISHU_CHANGE_APP_TOKEN',
      ]) || parsedSource.appToken,
    wikiToken:
      configModule.readEnv('FEISHU_CALENDAR_CHANGE_WIKI_TOKEN', [
        'FEISHU_CHANGE_CALENDAR_WIKI_TOKEN',
        'FEISHU_CHANGE_MANAGEMENT_WIKI_TOKEN',
        'FEISHU_FOCUS_CHANGE_WIKI_TOKEN',
        'FEISHU_CHANGE_WIKI_TOKEN',
      ]) || parsedSource.wikiToken,
    tableName: CHANGE_TABLE_NAME,
  });
  const gateway = new workflowModule.InventoryWorkflowGateway(httpService);
  const access = new accessModule.UnifiedAccessService();
  if (!access.isAccessControlEnabled() || !access.isConfigured()) {
    throw new Error('变更真实自测要求启用并安全配置统一访问控制');
  }
  const trustedSession = access.issueTrustedSession({
    role: 'duty_editor',
    purchaseBuilding: null,
  });
  const trustedCleanupSession = access.issueTrustedSession({
    role: 'admin',
    purchaseBuilding: null,
  });
  const cleanupProofSecret = clean(
    process.env.LOCAL_ACCESS_SESSION_SECRET ||
      process.env.LOCAL_ADMIN_SESSION_SECRET,
  );
  const localClient = axios.create(localAxiosConfig(baseUrl));
  const localApi = createLoopbackApiSession({
    baseUrl,
    client: localClient,
    accessSessionToken: trustedSession.token,
  });
  const trustedCleanupApi = createLoopbackApiSession({
    baseUrl,
    client: localClient,
    accessSessionToken: trustedCleanupSession.token,
    expectedRole: 'admin',
  });
  const fixtureDirectory = join(dirname(statePath), '.change-self-test-files');

  const postStagedFile = async (ownerMutationId, descriptor) => {
    const form = new FormData();
    form.append('ownerMutationId', ownerMutationId);
    form.append('file', createReadStream(descriptor.absolutePath), {
      filename: descriptor.filename,
      contentType: descriptor.mimeType,
      knownLength: descriptor.size,
    });
    const response = await localApi.post(
      '/api/duty-schedules/change-attachments/stage',
      form,
      {
        headers: form.getHeaders(),
        maxBodyLength: MAX_SCHEME_BYTES + 1024 * 1024,
        maxContentLength: MAX_SCHEME_BYTES + 1024 * 1024,
        timeout: 10 * 60 * 1000,
      },
    );
    return response.data?.document;
  };

  const stageLargeScheme = async (ownerMutationId, label) => {
    if (schemePath) {
      const inspected = await inspectLargePdfFixture(schemePath);
      validateSchemeFixtureExpectation(inspected, requestedSchemeBytes);
      return postStagedFile(ownerMutationId, {
        absolutePath: schemePath,
        filename: `${label}-${basename(schemePath)}`,
        mimeType: 'application/pdf',
        size: inspected.size,
      });
    }
    await mkdir(fixtureDirectory, { recursive: true });
    const path = join(fixtureDirectory, `${ownerMutationId}-${label}.pdf`);
    await unlinkIfExists(path);
    const descriptor = await writeLargePdfFixture(
      path,
      requestedSchemeBytes ?? DEFAULT_LARGE_PDF_BYTES,
      label,
    );
    try {
      return await postStagedFile(ownerMutationId, descriptor);
    } finally {
      await unlinkIfExists(path);
    }
  };

  return {
    now: () => new Date(),
    randomUUID: () => createRandomUUID(),
    primeLocalApi: async () => {
      await localApi.prime();
      await trustedCleanupApi.prime();
    },
    fetchLocalPeople: async () => {
      const response = await localApi.get(
        '/api/bitable/person-profiles?scope=leave',
      );
      const organizations = response.data?.organizations;
      const submitters = response.data?.changeRequestSubmitters;
      if (!Array.isArray(organizations) || !Array.isArray(submitters)) {
        throw new Error('本地人员缓存接口响应无效');
      }
      return submitters.map((name) => ({ supervisorText: clean(name) }));
    },
    assertWritableSubmitterField: async () => {
      const schemas = await gateway.getFieldSchemas(
        appToken,
        CHANGE_TABLE_ID,
        CHANGE_TABLE_NAME,
      );
      return assertWritableChangeSubmitterField(schemas);
    },
    stageLargeScheme,
    stageEvidence: async (ownerMutationId) => {
      const form = new FormData();
      form.append('ownerMutationId', ownerMutationId);
      form.append('file', PNG_FIXTURE, {
        filename: 'change-adjustment-evidence.png',
        contentType: 'image/png',
        knownLength: PNG_FIXTURE.length,
      });
      const response = await localApi.post(
        '/api/duty-schedules/change-attachments/stage',
        form,
        {
          headers: form.getHeaders(),
          maxBodyLength: 1024 * 1024,
          maxContentLength: 1024 * 1024,
          timeout: 120_000,
        },
      );
      return response.data?.document;
    },
    postChangeRequest: async (request) => {
      const response = await localApi.post(
        '/api/duty-schedules/change-request',
        request,
        { timeout: 10 * 60 * 1000 },
      );
      return response.data;
    },
    getChangeRequestSyncTask: async (taskId) => {
      const response = await localApi.get(
        `/api/duty-schedules/change-request-sync/${encodeURIComponent(taskId)}`,
        { timeout: 30_000 },
      );
      return response.data;
    },
    postChangeAdjustment: async (request) => {
      const response = await localApi.post(
        '/api/duty-schedules/change-adjustment',
        request,
        { timeout: 10 * 60 * 1000 },
      );
      return response.data;
    },
    queryBaseByMarker: (marker) =>
      fetchExactBaseRecords(
        bitableModule,
        httpService,
        appToken,
        '变更简述',
        marker,
      ),
    queryBaseByAdjustmentId: (mutationId) =>
      fetchExactBaseRecords(
        bitableModule,
        httpService,
        appToken,
        '调整请求唯一ID',
        mutationId,
      ),
    getBaseRecordById: async (recordId) => {
      try {
        return await gateway.getRecord(
          appToken,
          CHANGE_TABLE_ID,
          recordId,
          CHANGE_TABLE_NAME,
        );
      } catch (error) {
        if (
          error instanceof workflowModule.InventoryWorkflowRecordNotFoundError
        ) {
          return null;
        }
        throw error;
      }
    },
    getLocalChangeById: async (recordId, year) => {
      const response = await localApi.get(
        `/api/change-info/${encodeURIComponent(String(year))}`,
        { params: { refresh: '1' }, timeout: 120_000 },
      );
      const changes = Array.isArray(response.data?.changes)
        ? response.data.changes
        : [];
      const matches = changes.filter(
        (item) => clean(item?.bitableRecordId || item?.id) === recordId,
      );
      if (matches.length > 1) {
        throw new Error('本地变更列表按 recordId 命中多条记录');
      }
      return matches[0] || null;
    },
    deleteBaseRecordById: (recordId) =>
      gateway.deleteRecord(
        appToken,
        CHANGE_TABLE_ID,
        recordId,
        CHANGE_TABLE_NAME,
      ),
    deleteAttachment: async ({
      id,
      ownerMutationId,
      recordId,
      summaryMarker,
      adjustmentMutationId,
      adjustmentReasonMarker,
      adjustmentConfirmed,
    }) => {
      try {
        await localApi.post(
          `/api/duty-schedules/change-attachments/${encodeURIComponent(id)}/delete`,
          { ownerMutationId },
          { timeout: 120_000 },
        );
        return { missing: false };
      } catch (error) {
        const status = Number(error?.response?.status);
        if (status === 404) return { missing: true };
        if (status !== 403) throw error;
      }
      const cleanupRequest = {
        recordId,
        summaryMarker,
        adjustmentMutationId,
        adjustmentReasonMarker,
        adjustmentConfirmed,
        objectId: id,
        ownerMutationId,
        expiresAt: Date.now() + 60_000,
      };
      const proof = createChangeSelfTestCleanupProof(
        cleanupRequest,
        cleanupProofSecret,
      );
      const response = await trustedCleanupApi.post(
        '/api/duty-schedules/change-adjustment/self-test/cleanup-bound-attachment',
        cleanupRequest,
        {
          headers: { 'x-change-self-test-cleanup-proof': proof },
          timeout: 120_000,
        },
      );
      return { missing: response.data?.missing === true };
    },
    isAttachmentAbsent: async ({ id, ownerMutationId }) => {
      try {
        await localApi.get(
          `/api/duty-schedules/change-attachments/${encodeURIComponent(
            id,
          )}/download?ownerMutationId=${encodeURIComponent(ownerMutationId)}`,
          { maxRedirects: 0, timeout: 30_000 },
        );
        return false;
      } catch (error) {
        const status = Number(error?.response?.status);
        if (status === 404) return true;
        if (status === 302) return false;
        throw error;
      }
    },
    writeState: (state) => atomicWriteJson(statePath, state),
    removeState: () => unlinkIfExists(statePath),
    waitBeforeRecheck: delay,
    waitBeforeSyncPoll: delay,
  };
}

async function fetchExactBaseRecords(
  bitableModule,
  httpService,
  appToken,
  fieldName,
  value,
) {
  return bitableModule.fetchBitableRecords(httpService, {
    appToken,
    tableId: CHANGE_TABLE_ID,
    tableName: CHANGE_TABLE_NAME,
    fieldNames: BASE_FIELD_NAMES,
    filter: {
      conjunction: 'and',
      conditions: [{ field_name: fieldName, operator: 'is', value: [value] }],
    },
    cacheTtlMs: 0,
    forceRefresh: true,
    allowStale: false,
    strict: true,
  });
}

function localAxiosConfig(baseUrl) {
  const url = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !isLoopbackHost(url.hostname)
  ) {
    throw new TypeError('本地 API 地址必须使用 HTTP(S) 回环地址');
  }
  const config = {
    baseURL: url.toString().replace(/\/$/, ''),
    timeout: 30_000,
    validateStatus: (status) => status >= 200 && status < 300,
  };
  return url.protocol === 'https:'
    ? {
        ...config,
        httpsAgent: new HttpsAgent({ rejectUnauthorized: false }),
      }
    : config;
}

function isLoopbackHost(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  );
}

async function main(setStage = () => undefined) {
  setStage('arguments');
  const { command, baseUrl, statePath, schemePath, schemeBytes } =
    parseChangeAdjustmentSelfTestArguments(process.argv.slice(2));
  setStage('state');
  if (command === 'cleanup-only') {
    const state = validateChangeSelfTestState(
      await readJsonState(statePath, true),
    );
    setStage('dependencies');
    const dependencies = await createRealDependencies({
      baseUrl,
      statePath,
      schemePath: '',
      schemeBytes: null,
    });
    setStage('cleanup');
    const result = await cleanupChangeAdjustmentState(state, dependencies);
    printSafe({ ok: true, mode: 'cleanup-only', ...result });
    return;
  }

  const existing = await readJsonState(statePath, false);
  if (existing) {
    throw new Error(
      `存在未清理的变更真实自测状态，请先运行 cleanup-only --state ${statePath}`,
    );
  }
  setStage('dependencies');
  const dependencies = await createRealDependencies({
    baseUrl,
    statePath,
    schemePath,
    schemeBytes,
  });
  setStage('execute');
  const result = await runChangeAdjustmentSelfTest(
    { schemeBytes },
    dependencies,
  );
  printSafe(result);
}

export function parseChangeAdjustmentSelfTestArguments(args) {
  const command = args[0] && !args[0].startsWith('--') ? args[0] : 'run';
  if (!['run', 'cleanup-only'].includes(command)) {
    throw new Error('命令必须是 run 或 cleanup-only');
  }
  const baseUrl = clean(
    optionValue(args, '--base-url') || DEFAULT_BASE_URL,
  ).replace(/\/+$/, '');
  const statePath = resolve(optionValue(args, '--state') || DEFAULT_STATE_PATH);
  const schemeOption = clean(optionValue(args, '--scheme'));
  const schemePath = schemeOption ? resolve(schemeOption) : '';
  if (schemePath && !isAbsolute(schemePath)) {
    throw new Error('--scheme 必须是绝对路径');
  }
  const schemeBytesIndexes = args.flatMap((value, index) =>
    value === '--scheme-bytes' ? [index] : [],
  );
  if (schemeBytesIndexes.length > 1) {
    throw new Error('--scheme-bytes 只能指定一次');
  }
  let schemeBytes = null;
  if (schemeBytesIndexes.length === 1) {
    const raw = args[schemeBytesIndexes[0] + 1] || '';
    if (!/^\d+$/.test(raw)) {
      throw new Error('--scheme-bytes 必须是十进制整数字节数');
    }
    const value = Number(raw);
    if (
      !Number.isSafeInteger(value) ||
      value < MIN_SCHEME_BYTES ||
      value > MAX_SCHEME_BYTES
    ) {
      throw new Error('--scheme-bytes 必须在 1 KiB 至 200 MiB 之间');
    }
    schemeBytes = value;
  }
  return { command, baseUrl, statePath, schemePath, schemeBytes };
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || '' : '';
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await unlinkIfExists(temporaryPath);
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

async function readJsonState(path, required) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) return null;
    if (error?.code === 'ENOENT') throw new Error('变更自测状态文件不存在');
    throw error;
  }
}

async function unlinkIfExists(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function classifySafeSelfTestFailureReason(error) {
  const candidates = error instanceof AggregateError
    ? [error, ...error.errors]
    : [error];
  const messages = [];
  let status = null;

  for (const candidate of candidates) {
    const response = candidate?.response;
    if (!response || typeof response !== 'object') continue;
    if (status === null && Number.isFinite(Number(response.status))) {
      status = Number(response.status);
    }
    const data = response.data;
    if (typeof data === 'string') {
      messages.push(data);
      continue;
    }
    if (!data || typeof data !== 'object') continue;
    if (typeof data.message === 'string') messages.push(data.message);
    if (typeof data.error === 'string') messages.push(data.error);
    if (data.error && typeof data.error === 'object' && typeof data.error.message === 'string') {
      messages.push(data.error.message);
    }
  }

  const combined = messages.join('\n');
  const rules = [
    [/未找到.{0,24}变更提交人|变更提交人.{0,24}未找到/, 'request-submitter-not-found'],
    [/存在多个变更提交人|人员表中完成去重/, 'request-submitter-duplicate'],
    [/飞书账号必须唯一/, 'request-submitter-account-count'],
    [/飞书账号与姓名不一致/, 'request-submitter-account-name-mismatch'],
    [/缺少飞书用户标识/, 'request-submitter-user-id-missing'],
    [/申请提交人|提交人/, 'request-submitter'],
    [/变更文档|文档/, 'request-document'],
    [/附件/, 'request-attachment'],
    [/变更性质|性质/, 'request-nature'],
    [/变更类型/, 'request-type'],
    [/作业类型/, 'request-work-type'],
    [/楼栋/, 'request-building'],
    [/专业/, 'request-discipline'],
    [/等级/, 'request-level'],
    [/风险/, 'request-risk'],
    [/日期|时间/, 'request-time'],
    [/字段|多维表/, 'bitable-schema'],
    [/请求标识|幂等|指纹/, 'idempotency'],
    [/版本已更新|记录已被其他操作更新|无法核对变更记录版本/, 'adjustment-version-conflict'],
    [/变更方案已被其他操作更新/, 'adjustment-scheme-conflict'],
    [/延期举证已被其他操作更新/, 'adjustment-evidence-conflict'],
    [/严格回读|定向回读/, 'adjustment-readback-conflict'],
    [/对象存储附件已变化/, 'adjustment-object-conflict'],
    [/待删除附件与变更记录归属不一致/, 'adjustment-attachment-ownership'],
  ];
  for (const [pattern, reason] of rules) {
    if (pattern.test(combined)) return reason;
  }
  return status === null ? 'unknown' : `http-${status}`;
}

export function buildSafeCliError(error, stage = 'execute') {
  const allowedStages = new Set([
    'startup',
    'arguments',
    'state',
    'dependencies',
    'execute',
    'cleanup',
  ]);
  const safeStage = allowedStages.has(stage) ? stage : 'execute';
  let code = 'SELF_TEST_FAILED';
  if (error instanceof UnsafeChangeSelfTestCleanupError) {
    code = 'UNSAFE_CLEANUP';
  } else if (error instanceof AggregateError) {
    code = 'SELF_TEST_AND_CLEANUP_FAILED';
  } else if (safeStage === 'cleanup') {
    code = 'CLEANUP_FAILED';
  }
  const errorName = error instanceof Error ? error.name : typeof error;
  const errorMessage = error instanceof Error ? error.message : String(error);
  const operation = SELF_TEST_OPERATIONS.has(clean(error?.selfTestOperation))
    ? clean(error.selfTestOperation)
    : 'unknown';
  return {
    stage: safeStage,
    operation,
    reason: classifySafeSelfTestFailureReason(error),
    code,
    safeRef: createSafeRef(`${errorName}\0${errorMessage}`),
  };
}

function printSafe(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href;

if (isMain) {
  let activeStage = 'startup';
  main((stage) => {
    activeStage = stage;
  }).catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: buildSafeCliError(error, activeStage),
      })}\n`,
    );
    process.exitCode = 1;
  });
}
