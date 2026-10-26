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
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { Agent as HttpsAgent } from 'node:https';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHANGE_TABLE_ID = 'tbl8f743982e48e1';
const CHANGE_SUMMARY_REPORT_TABLE_ID = 'tbl73b701bc3e2a1';
const CHANGE_TABLE_NAME = '计划变更日历';
const CHANGE_SUMMARY_REPORT_TABLE_NAME = '变更关单需提交附件';
const DEFAULT_CHANGE_SOURCE_URL =
  'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE';
const DEFAULT_BASE_URL = 'https://127.0.0.1:3001';
const DEFAULT_STATE_PATH = resolve(
  process.cwd(),
  'output/diagnostics/change-summary-report-real-self-test-state.json',
);
const SUMMARY_ACCEPTANCE_MAX_MS = 1000;
const MAX_DOCUMENT_BYTES = 200 * 1024 * 1024;
const DEFAULT_PDF_BYTES = 4096;
const MAX_SYNC_POLL_ATTEMPTS = 360;
const CHANGE_CUTOFF_MS = Date.parse('2026-06-01T00:00:00+08:00');
const RECORD_ID_PATTERN = /^rec[A-Za-z0-9_-]{8,80}$/;
const OBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{12,80}$/;
const CREATE_MUTATION_ID_PATTERN =
  /^change-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADJUSTMENT_MUTATION_ID_PATTERN =
  /^change-adjustment-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUMMARY_MUTATION_ID_PATTERN =
  /^change-summary-report-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MARKER_PATTERN = /^CODEX-SELFTEST-CHANGE-SUMMARY-\d{13}-[0-9a-f]{8}$/;
const CLEANUP_REASON_PATTERN =
  /^CODEX-SELFTEST-CHANGE-ADJUST-\d{13}-[0-9a-f]{8}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const STATE_KEYS = [
  'version',
  'createMutationId',
  'cleanupAdjustmentMutationId',
  'summaryMutationId',
  'changeRecordId',
  'summaryReportRecordId',
  'marker',
  'cleanupReasonMarker',
  'summaryFingerprint',
  'disposition',
  'cleanupPhase',
  'attachments',
];
const DISPOSITIONS = new Set([
  'prepared',
  'create-attempted',
  'create-confirmed',
  'summary-attempted',
  'summary-accepted',
  'summary-failed',
  'summary-confirmed',
  'definitely-not-written',
  'unknown-result',
]);
const CLEANUP_PHASES = new Set([
  'none',
  'objects-delete-armed',
  'objects-deleted',
  'summary-delete-armed',
  'summary-deleted',
  'change-delete-armed',
  'change-deleted',
]);
const OPERATIONS = new Set([
  'prime-local-api',
  'load-personnel',
  'stage-change-document',
  'submit-change',
  'wait-change-sync',
  'verify-change',
  'stage-summary-document',
  'submit-summary',
  'wait-summary-sync',
  'verify-summary',
  'replay-summary',
  'tamper-summary',
  'cleanup',
  'unknown',
]);
const MAIN_FIELD_NAMES = [
  '变更简述',
  '变更重要风险点（简述）',
  '变更提交人',
  '申请提交人',
  '变更进度',
  '变更等级（阿里）',
  '变更提交审核流程（内部）',
  '计划开始日期（阿里）',
  '计划结束日期（阿里）',
  '变更文档',
  '变更总结报告',
];
const SUMMARY_FIELD_NAMES = [
  '变更关联',
  '变更总结报告（风险低及以上）',
  '变更总结请求唯一ID',
  '变更总结请求指纹',
];
const CSRF_COOKIE_NAME = 'suda-csrf-token';
const CSRF_HEADER_NAME = 'x-suda-csrf-token';
const ACCESS_SESSION_COOKIE_NAME = 'vnet_access_session';

export class UnsafeChangeSummarySelfTestCleanupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeChangeSummarySelfTestCleanupError';
  }
}

export function selectExactLocalSubmitter(people) {
  if (!Array.isArray(people)) throw new Error('本地人员缓存格式无效');
  const grouped = new Map();
  for (const person of people) {
    const name = clean(person?.supervisorText || person?.name);
    const key = normalizeExactName(name);
    if (!key) continue;
    const names = grouped.get(key) || [];
    names.push(name);
    grouped.set(key, names);
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

export function buildPastCompletedSchedule(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('真实自测当前时间无效');
  }
  const today = shanghaiDateKey(now);
  const previous = new Date(`${today}T00:00:00+08:00`);
  previous.setTime(previous.getTime() - 24 * 60 * 60 * 1000);
  const date = shanghaiDateKey(previous);
  const schedule = {
    startAt: `${date}T09:00`,
    endAt: `${date}T18:00`,
  };
  if (
    parseShanghaiLocal(schedule.startAt) < CHANGE_CUTOFF_MS ||
    parseShanghaiLocal(schedule.endAt) >= now.getTime()
  ) {
    throw new Error('当前日期无法生成2026年6月以后且已结束的自测时段');
  }
  return schedule;
}

export function buildSummaryRequestFingerprint(request) {
  const canonical = {
    version: 5,
    submitterName: clean(request?.submitterName).normalize('NFKC').trim(),
    changeRecordId: clean(request?.changeRecordId),
    summaryDocuments: Array.isArray(request?.summaryDocuments)
      ? request.summaryDocuments.map((document) => ({
          name: clean(document?.name || document?.originalname),
          type: clean(document?.type || document?.mimetype).toLowerCase(),
          size: document?.size,
          objectStorage: {
            id: clean(document?.objectStorage?.id),
            filePath: clean(document?.objectStorage?.filePath),
            bucketId: clean(document?.objectStorage?.bucketId),
          },
        }))
      : [],
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function assertFastSummaryAcceptance(response, expected) {
  const mutationId = clean(expected?.mutationId);
  const changeRecordId = clean(expected?.changeRecordId);
  const elapsedMs = Number(expected?.elapsedMs);
  const maxElapsedMs = Number(
    expected?.maxElapsedMs ?? SUMMARY_ACCEPTANCE_MAX_MS,
  );
  if (
    response?.success !== true ||
    response?.pendingSync !== true ||
    clean(response?.taskId) !== mutationId ||
    clean(response?.clientMutationId) !== mutationId ||
    clean(response?.changeRecordId) !== changeRecordId ||
    !SUMMARY_MUTATION_ID_PATTERN.test(mutationId) ||
    !RECORD_ID_PATTERN.test(changeRecordId) ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 ||
    !Number.isFinite(maxElapsedMs) ||
    maxElapsedMs <= 0 ||
    maxElapsedMs > SUMMARY_ACCEPTANCE_MAX_MS ||
    elapsedMs > maxElapsedMs
  ) {
    throw new Error('变更总结快速受理响应未达到约定');
  }
  return { taskId: mutationId, elapsedMs };
}

export async function waitForChangeSummaryReportCompletion(
  accepted,
  expected,
  dependencies,
) {
  const mutationId = clean(expected?.mutationId);
  const changeRecordId = clean(expected?.changeRecordId);
  if (
    accepted?.success !== true ||
    clean(accepted?.taskId) !== mutationId ||
    clean(accepted?.clientMutationId) !== mutationId ||
    clean(accepted?.changeRecordId) !== changeRecordId
  ) {
    throw new Error('变更总结受理身份不一致');
  }
  if (accepted.pendingSync !== true) {
    const recordId = clean(accepted.summaryReportRecordId);
    if (!RECORD_ID_PATTERN.test(recordId)) {
      throw new Error('变更总结完成响应缺少收口记录');
    }
    return {
      ...accepted,
      status: 'completed',
      phase: 'completed',
      summaryReportRecordId: recordId,
    };
  }
  if (typeof dependencies?.getChangeSummaryReportTask !== 'function') {
    throw new Error('变更总结后台任务查询能力不可用');
  }
  const configuredAttempts = Number(dependencies.summaryPollMaxAttempts);
  const maxAttempts =
    Number.isSafeInteger(configuredAttempts) &&
    configuredAttempts > 0 &&
    configuredAttempts <= MAX_SYNC_POLL_ATTEMPTS
      ? configuredAttempts
      : MAX_SYNC_POLL_ATTEMPTS;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const task = await dependencies.getChangeSummaryReportTask(mutationId);
    if (
      clean(task?.taskId) !== mutationId ||
      clean(task?.clientMutationId) !== mutationId ||
      clean(task?.changeRecordId) !== changeRecordId
    ) {
      throw new Error('变更总结后台任务三重身份不一致');
    }
    if (task.status === 'failed') {
      const error = new Error('变更总结后台同步明确失败');
      error.summaryTaskFailed = true;
      error.summaryReportRecordId = clean(task.summaryReportRecordId);
      throw error;
    }
    if (task.status === 'completed' && task.phase === 'completed') {
      const recordId = clean(task.summaryReportRecordId);
      if (task.success !== true || !RECORD_ID_PATTERN.test(recordId)) {
        throw new Error('变更总结后台完成结果无效');
      }
      return task;
    }
    if (!['pending', 'running'].includes(task.status)) {
      throw new Error('变更总结后台任务状态无效');
    }
    if (attempt < maxAttempts - 1) {
      await (dependencies.waitBeforePoll
        ? dependencies.waitBeforePoll(1000)
        : delay(1000));
    }
  }
  throw Object.assign(new Error('变更总结后台同步超时'), {
    writeDisposition: 'unknown-result',
  });
}

export async function runChangeSummaryReportSelfTest(options, dependencies) {
  const now = dependencies.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('真实自测当前时间无效');
  }
  const createUuid = dependencies.randomUUID?.() ?? createRandomUUID();
  const cleanupUuid = dependencies.randomUUID?.() ?? createRandomUUID();
  const summaryUuid = dependencies.randomUUID?.() ?? createRandomUUID();
  const createMutationId = `change-request-${createUuid}`;
  const cleanupAdjustmentMutationId = `change-adjustment-${cleanupUuid}`;
  const summaryMutationId = `change-summary-report-${summaryUuid}`;
  const marker = `CODEX-SELFTEST-CHANGE-SUMMARY-${now.getTime()}-${String(
    createUuid,
  )
    .slice(0, 8)
    .toLowerCase()}`;
  const cleanupReasonMarker = `CODEX-SELFTEST-CHANGE-ADJUST-${now.getTime()}-${String(
    cleanupUuid,
  )
    .slice(0, 8)
    .toLowerCase()}`;
  let state = validateChangeSummarySelfTestState({
    version: 1,
    createMutationId,
    cleanupAdjustmentMutationId,
    summaryMutationId,
    changeRecordId: '',
    summaryReportRecordId: '',
    marker,
    cleanupReasonMarker,
    summaryFingerprint: '',
    disposition: 'prepared',
    cleanupPhase: 'none',
    attachments: [],
  });
  let operation = 'prime-local-api';
  let operationError = null;
  let cleanupError = null;
  let cleanupResult = null;
  let result = null;

  const persist = async (next) => {
    state = validateChangeSummarySelfTestState(next);
    await dependencies.writeState(state);
  };

  try {
    await dependencies.primeLocalApi?.();
    await persist(state);
    operation = 'load-personnel';
    const submitterName = selectExactLocalSubmitter(
      await dependencies.fetchLocalPeople(),
    );
    const schedule = buildPastCompletedSchedule(now);

    operation = 'stage-change-document';
    const rawChangeDocument = await dependencies.stageDocument(
      createMutationId,
      'change',
      options,
    );
    const recoverableChangeDocument = recoverStagedDocument(rawChangeDocument);
    if (recoverableChangeDocument) {
      await persist(
        registerAttachment(state, recoverableChangeDocument, 'change'),
      );
    }
    const changeDocument = validateStagedDocument(rawChangeDocument);
    if (!recoverableChangeDocument) {
      await persist(registerAttachment(state, changeDocument, 'change'));
    }
    const createRequest = {
      clientMutationId: createMutationId,
      submitterName,
      stagedDocuments: [changeDocument],
      nature: '标准变更',
      summary: marker,
      changeType: '计划性变更',
      workType: '维护',
      buildings: ['H楼'],
      plannedStartAt: schedule.startAt,
      plannedEndAt: schedule.endAt,
      discipline: '电气',
      level: '低',
      riskSummary: `自测清理校验：${marker}`,
    };
    operation = 'submit-change';
    await persist({ ...state, disposition: 'create-attempted' });
    const acceptedCreate = await dependencies.postChangeRequest(createRequest);
    assertChangeRequestResponse(acceptedCreate, createMutationId);
    const changeRecordId = responseRecordId(acceptedCreate);
    await persist({
      ...state,
      changeRecordId,
      disposition: 'create-confirmed',
    });
    operation = 'wait-change-sync';
    const completedCreate = await waitForChangeRequestCompletion(
      acceptedCreate,
      createMutationId,
      dependencies,
    );
    if (responseRecordId(completedCreate) !== changeRecordId) {
      throw new Error('变更申请后台同步返回了不同记录');
    }
    operation = 'verify-change';
    await verifyEligibleMainRecord(
      state,
      { submitterName, schedule },
      dependencies,
    );

    operation = 'stage-summary-document';
    const rawSummaryDocument = await dependencies.stageDocument(
      summaryMutationId,
      'summary',
      options,
    );
    const recoverableSummaryDocument =
      recoverStagedDocument(rawSummaryDocument);
    if (recoverableSummaryDocument) {
      await persist(
        registerAttachment(state, recoverableSummaryDocument, 'summary'),
      );
    }
    const summaryDocument = validateStagedDocument(rawSummaryDocument);
    if (!recoverableSummaryDocument) {
      await persist(registerAttachment(state, summaryDocument, 'summary'));
    }
    const summaryRequest = {
      clientMutationId: summaryMutationId,
      submitterName,
      changeRecordId,
      summaryDocuments: [summaryDocument],
    };
    const summaryFingerprint = buildSummaryRequestFingerprint(summaryRequest);
    await persist({
      ...state,
      summaryFingerprint,
      disposition: 'summary-attempted',
    });

    operation = 'submit-summary';
    const monotonicNow =
      dependencies.monotonicNow || (() => globalThis.performance.now());
    const startedAt = monotonicNow();
    const acceptedSummary =
      await dependencies.postChangeSummaryReport(summaryRequest);
    const elapsedMs = monotonicNow() - startedAt;
    const acceptance = assertFastSummaryAcceptance(acceptedSummary, {
      mutationId: summaryMutationId,
      changeRecordId,
      elapsedMs,
      maxElapsedMs:
        options?.maxAcceptanceMs ?? dependencies.maxAcceptanceMs ?? 1000,
    });
    await persist({ ...state, disposition: 'summary-accepted' });
    operation = 'wait-summary-sync';
    const completedSummary = await waitForChangeSummaryReportCompletion(
      acceptedSummary,
      { mutationId: summaryMutationId, changeRecordId },
      dependencies,
    );
    const summaryReportRecordId = clean(completedSummary.summaryReportRecordId);
    await persist({
      ...state,
      summaryReportRecordId,
      disposition: 'summary-confirmed',
    });
    operation = 'verify-summary';
    const verification = await verifyCompletedSummary(
      state,
      { submitterName, schedule },
      dependencies,
    );

    operation = 'replay-summary';
    const replay = await dependencies.postChangeSummaryReport(summaryRequest);
    assertSummaryReplayResponse(replay, state);
    operation = 'tamper-summary';
    const tamperConflictVerified = await expectConflict(() =>
      dependencies.postChangeSummaryReport({
        ...summaryRequest,
        submitterName: `${submitterName}X`,
      }),
    );
    result = {
      ok: true,
      acceptedWithinMs: acceptance.elapsedMs,
      replayVerified: true,
      tamperConflictVerified,
      strictReadbackVerified: verification.strictReadbackVerified,
      storageAccessibleVerified: verification.storageAccessibleVerified,
      createRequestRef: safeRef(createMutationId),
      summaryRequestRef: safeRef(summaryMutationId),
      changeRecordRef: safeRef(changeRecordId),
      summaryRecordRef: safeRef(summaryReportRecordId),
    };
  } catch (error) {
    operationError = tagOperation(error, operation);
    const disposition = classifyRunFailureDisposition(state, error);
    try {
      await persist({
        ...state,
        ...(clean(error?.summaryReportRecordId) && !state.summaryReportRecordId
          ? { summaryReportRecordId: clean(error.summaryReportRecordId) }
          : {}),
        disposition,
      });
    } catch (stateError) {
      operationError = new AggregateError(
        [operationError, stateError],
        '变更总结真实自测失败，保存恢复状态也失败',
      );
    }
  } finally {
    try {
      cleanupResult = await cleanupChangeSummaryReportState(
        state,
        dependencies,
      );
    } catch (error) {
      cleanupError = tagOperation(error, 'cleanup');
    }
  }

  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      '变更总结真实自测失败，自动清理也未能安全完成',
    );
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  if (result && cleanupResult?.summaryBindingVerified !== true) {
    throw new Error('变更总结 COS 绑定关系未通过严格清理端点证明');
  }
  return {
    ...result,
    boundStorageVerified: cleanupResult?.summaryBindingVerified === true,
    cleaned: cleanupResult?.cleaned === true,
    residualCount: cleanupResult?.residualCount ?? 0,
    objectResidualCount: cleanupResult?.objectResidualCount ?? 0,
  };
}

async function waitForChangeRequestCompletion(
  response,
  mutationId,
  dependencies,
) {
  assertChangeRequestResponse(response, mutationId);
  if (response.pendingSync !== true) return response;
  if (clean(response.taskId) !== mutationId) {
    throw new Error('变更申请后台任务标识无效');
  }
  const configured = Number(dependencies.changeRequestPollMaxAttempts);
  const maxAttempts =
    Number.isSafeInteger(configured) && configured > 0
      ? Math.min(configured, MAX_SYNC_POLL_ATTEMPTS)
      : MAX_SYNC_POLL_ATTEMPTS;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const responseValue =
      await dependencies.getChangeRequestSyncTask(mutationId);
    const task = responseValue?.success === true ? responseValue.task : null;
    if (!task || clean(task.id) !== mutationId) {
      throw new Error('变更申请后台任务回读失败');
    }
    if (task.status === 'failed') {
      throw Object.assign(new Error('变更申请后台同步明确失败'), {
        writeDisposition: 'confirmed-post-commit-pending',
      });
    }
    if (task.status === 'completed') {
      assertChangeRequestResponse(task.result, mutationId);
      return task.result;
    }
    if (!['pending', 'running'].includes(task.status)) {
      throw new Error('变更申请后台任务状态无效');
    }
    if (attempt < maxAttempts - 1) {
      await (dependencies.waitBeforePoll
        ? dependencies.waitBeforePoll(1000)
        : delay(1000));
    }
  }
  throw Object.assign(new Error('变更申请后台同步超时'), {
    writeDisposition: 'unknown-result',
  });
}

async function verifyEligibleMainRecord(state, expected, dependencies) {
  const records = await queryWithRetry(
    () => dependencies.queryMainByMarker(state.marker),
    dependencies,
    (items) => items.length === 1,
  );
  if (records.length !== 1) {
    throw new Error('变更主表 marker 严格回查未恰好命中 1 条');
  }
  const record = records[0];
  assertMainIdentity(state, record, false);
  const fields = asFields(record);
  if (
    displayValues(fields['变更提交人'] ?? fields['申请提交人']).join('') !==
    expected.submitterName
  ) {
    throw new Error('变更提交人未精确回填');
  }
  if (normalizeLabel(fields['变更进度']) !== '已结束') {
    throw new Error('测试变更尚未处于已结束状态');
  }
  const level = normalizeLabel(fields['变更等级（阿里）']);
  if (level !== '低') throw new Error('测试变更等级未精确回填为低');
  const workflow = normalizeLabel(fields['变更提交审核流程（内部）']);
  if (['退回', '返回', '驳回'].some((value) => workflow.includes(value))) {
    throw new Error('测试变更流程处于退回状态');
  }
  if (
    fieldEpochMs(fields['计划开始日期（阿里）']) !==
      parseShanghaiLocal(expected.schedule.startAt) ||
    fieldEpochMs(fields['计划结束日期（阿里）']) !==
      parseShanghaiLocal(expected.schedule.endAt)
  ) {
    throw new Error('测试变更计划时间回填不一致');
  }
  if (attachmentTokens(fields['变更文档']).length !== 1) {
    throw new Error('测试变更方案附件未严格回填');
  }
  if (summaryLookupTokens(fields['变更总结报告']).length !== 0) {
    throw new Error('测试变更创建时总结字段必须为空');
  }
  return record;
}

async function verifyCompletedSummary(state, expected, dependencies) {
  const [mainRecords, mutationRecords, relationRecords] = await Promise.all([
    queryWithRetry(
      () => dependencies.queryMainByMarker(state.marker),
      dependencies,
      (items) => items.length === 1,
    ),
    queryWithRetry(
      () => dependencies.querySummaryByMutation(state.summaryMutationId),
      dependencies,
      (items) => items.length === 1,
    ),
    queryWithRetry(
      () => dependencies.querySummaryByChangeRecord(state.changeRecordId),
      dependencies,
      (items) => items.length === 1,
    ),
  ]);
  if (
    mainRecords.length !== 1 ||
    mutationRecords.length !== 1 ||
    relationRecords.length !== 1
  ) {
    throw new Error('变更总结主表/收口表严格回查未各命中 1 条');
  }
  const main = mainRecords[0];
  const closing = mutationRecords[0];
  assertMainIdentity(state, main, false);
  if (recordId(relationRecords[0]) !== recordId(closing)) {
    throw new Error('变更总结 relation 与 mutation 命中了不同记录');
  }
  const closingIdentity = assertSummaryIdentity(state, closing, false);
  if (recordId(closing) !== state.summaryReportRecordId) {
    throw new Error('变更总结收口记录与任务结果不一致');
  }
  const lookupTokens = summaryLookupTokens(asFields(main)['变更总结报告']);
  if (
    lookupTokens.length !== closingIdentity.fileTokens.length ||
    lookupTokens.some((token) => !closingIdentity.fileTokens.includes(token))
  ) {
    throw new Error('变更总结主表 Lookup 尚未与收口附件一致');
  }
  await verifyEligibleMainRecord(state, expected, {
    ...dependencies,
    queryMainByMarker: async () => [main],
  }).catch((error) => {
    if (!String(error?.message).includes('总结字段必须为空')) throw error;
  });
  const summaryAttachment = state.attachments.find(
    (attachment) => attachment.kind === 'summary',
  );
  if (!summaryAttachment || closingIdentity.fileTokens.length !== 1) {
    throw new Error('变更总结自测附件身份不完整');
  }
  const accessible = await dependencies.verifyStorageAccessible({
    attachment: summaryAttachment,
  });
  if (accessible !== true) throw new Error('变更总结 COS 对象访问校验失败');
  return { strictReadbackVerified: true, storageAccessibleVerified: true };
}

export async function cleanupChangeSummaryReportState(
  stateInput,
  dependencies,
) {
  await dependencies.primeLocalApi?.();
  let state = validateChangeSummarySelfTestState(stateInput);
  const persist = async (next) => {
    state = validateChangeSummarySelfTestState(next);
    await dependencies.writeState(state);
  };

  const summaryMayAlreadyBeDeleted = [
    'summary-delete-armed',
    'summary-deleted',
    'change-delete-armed',
    'change-deleted',
  ].includes(state.cleanupPhase);
  let exactSummaryRecord = null;
  if (state.summaryReportRecordId) {
    exactSummaryRecord = await getRecordWithRetry(
      () => dependencies.getSummaryById(state.summaryReportRecordId),
      dependencies,
    );
    if (exactSummaryRecord) {
      assertSummaryIdentity(state, exactSummaryRecord, false);
    } else if (!summaryMayAlreadyBeDeleted) {
      throw new UnsafeChangeSummarySelfTestCleanupError(
        '已知总结 recordId 精确回读为空，拒绝清理',
      );
    }
  }

  let mainRecords = await queryWithRetry(
    () => dependencies.queryMainByMarker(state.marker),
    dependencies,
    (items) => items.length > 0,
  );
  let summaryByMutation = await queryWithRetry(
    () => dependencies.querySummaryByMutation(state.summaryMutationId),
    dependencies,
    (items) => items.length > 0,
  );
  let summaryByRelation = state.changeRecordId
    ? await queryWithRetry(
        () => dependencies.querySummaryByChangeRecord(state.changeRecordId),
        dependencies,
        (items) => items.length > 0,
      )
    : [];
  assertUnambiguous(mainRecords, '变更主表 marker');
  assertUnambiguous(summaryByMutation, '总结 mutation');
  assertUnambiguous(summaryByRelation, '总结 relation');

  let mainRecord = mainRecords[0] || null;
  if (mainRecord) {
    const adoptedMissingChangeId = state.changeRecordId === '';
    const adopted = assertMainIdentity(
      state,
      mainRecord,
      adoptedMissingChangeId,
    );
    if (adoptedMissingChangeId) {
      await persist({ ...state, changeRecordId: adopted });
      summaryByRelation = await queryWithRetry(
        () => dependencies.querySummaryByChangeRecord(state.changeRecordId),
        dependencies,
        (items) => items.length > 0,
      );
      assertUnambiguous(summaryByRelation, '总结 relation');
    }
    const exact = await dependencies.getMainById(state.changeRecordId);
    if (!exact) {
      throw new UnsafeChangeSummarySelfTestCleanupError(
        '主变更精确 recordId 回读为空，拒绝清理',
      );
    }
    assertMainIdentity(state, exact, false);
    mainRecord = exact;
  }

  let summaryRecord = summaryByMutation[0] || summaryByRelation[0] || null;
  if (
    summaryByMutation[0] &&
    summaryByRelation[0] &&
    recordId(summaryByMutation[0]) !== recordId(summaryByRelation[0])
  ) {
    throw new UnsafeChangeSummarySelfTestCleanupError(
      '总结 mutation 与 relation 身份不一致，拒绝清理',
    );
  }
  if (exactSummaryRecord) {
    if (
      summaryRecord &&
      recordId(summaryRecord) !== recordId(exactSummaryRecord)
    ) {
      throw new UnsafeChangeSummarySelfTestCleanupError(
        '总结筛选结果与精确 recordId 身份不一致，拒绝清理',
      );
    }
    summaryRecord = exactSummaryRecord;
  }
  if (summaryRecord) {
    if (!state.changeRecordId || !mainRecord) {
      throw new UnsafeChangeSummarySelfTestCleanupError(
        '找到总结记录但主变更身份不完整，拒绝清理',
      );
    }
    const adopted = assertSummaryIdentity(
      state,
      summaryRecord,
      state.summaryReportRecordId === '',
    ).recordId;
    if (!state.summaryReportRecordId) {
      await persist({ ...state, summaryReportRecordId: adopted });
    }
    if (!exactSummaryRecord) {
      exactSummaryRecord = await getRecordWithRetry(
        () => dependencies.getSummaryById(state.summaryReportRecordId),
        dependencies,
      );
    }
    if (!exactSummaryRecord) {
      throw new UnsafeChangeSummarySelfTestCleanupError(
        '总结精确 recordId 回读为空，拒绝清理',
      );
    }
    assertSummaryIdentity(state, exactSummaryRecord, false);
    summaryRecord = exactSummaryRecord;
  }

  const summaryWasNeverSubmitted =
    state.summaryFingerprint === '' &&
    state.summaryReportRecordId === '' &&
    !state.attachments.some((attachment) => attachment.kind === 'summary');
  const summaryCanNeverAppear =
    new Set([
      'prepared',
      'create-attempted',
      'create-confirmed',
      'summary-failed',
      'definitely-not-written',
    ]).has(state.disposition) ||
    (state.disposition === 'unknown-result' && summaryWasNeverSubmitted);
  if (
    !summaryRecord &&
    !summaryCanNeverAppear &&
    ![
      'summary-delete-armed',
      'summary-deleted',
      'change-delete-armed',
      'change-deleted',
    ].includes(state.cleanupPhase)
  ) {
    throw new UnsafeChangeSummarySelfTestCleanupError(
      '总结写入结果未知或仍在后台执行，已保留状态和对象',
    );
  }
  const mainCanNeverAppear = state.disposition === 'definitely-not-written';
  if (
    !mainRecord &&
    !mainCanNeverAppear &&
    !['change-delete-armed', 'change-deleted'].includes(state.cleanupPhase)
  ) {
    throw new UnsafeChangeSummarySelfTestCleanupError(
      '主变更写入结果未知或已确认但尚未回查到，已保留状态和对象',
    );
  }

  if (state.cleanupPhase === 'none') {
    await persist({ ...state, cleanupPhase: 'objects-delete-armed' });
  }
  const objectCleanup = await cleanupObjects(
    state,
    { mainRecord, summaryRecord },
    dependencies,
  );
  if (
    state.cleanupPhase === 'none' ||
    state.cleanupPhase === 'objects-delete-armed'
  ) {
    await persist({ ...state, cleanupPhase: 'objects-deleted' });
  }

  if (summaryRecord) {
    if (state.cleanupPhase !== 'summary-delete-armed') {
      await persist({ ...state, cleanupPhase: 'summary-delete-armed' });
    }
    await dependencies.deleteSummaryRecordById(state.summaryReportRecordId);
    await persist({ ...state, cleanupPhase: 'summary-deleted' });
  } else if (
    state.cleanupPhase === 'summary-delete-armed' ||
    state.cleanupPhase === 'objects-deleted'
  ) {
    await persist({ ...state, cleanupPhase: 'summary-deleted' });
  }

  if (mainRecord) {
    if (state.cleanupPhase !== 'change-delete-armed') {
      await persist({ ...state, cleanupPhase: 'change-delete-armed' });
    }
    await dependencies.deleteMainRecordById(state.changeRecordId);
    await persist({ ...state, cleanupPhase: 'change-deleted' });
  } else if (
    state.cleanupPhase === 'summary-deleted' ||
    state.cleanupPhase === 'change-delete-armed'
  ) {
    await persist({ ...state, cleanupPhase: 'change-deleted' });
  }

  const mustFinalizeFailedSummaryLedgers =
    state.disposition === 'summary-failed' &&
    state.cleanupPhase === 'change-deleted' &&
    state.summaryReportRecordId === '';
  if (mustFinalizeFailedSummaryLedgers) {
    await assertExternalBaseAbsent(state, dependencies);
    await assertExternalObjectsAbsent(state, dependencies);
    if (typeof dependencies.finalizeFailedSummaryCleanup !== 'function') {
      throw new UnsafeChangeSummarySelfTestCleanupError(
        '变更总结失败台账清理能力未配置',
      );
    }
    await dependencies.finalizeFailedSummaryCleanup({
      changeRequestMutationId: state.createMutationId,
      clientMutationId: state.summaryMutationId,
      changeRecordId: state.changeRecordId,
      summaryMarker: state.marker,
      summaryFingerprint: state.summaryFingerprint,
      changeObjectIds: state.attachments
        .filter((attachment) => attachment.kind === 'change')
        .map((attachment) => attachment.id),
      summaryObjectIds: state.attachments
        .filter((attachment) => attachment.kind === 'summary')
        .map((attachment) => attachment.id),
    });
  }

  for (let pass = 0; pass < 2; pass += 1) {
    await assertExternalBaseAbsent(state, dependencies);
    await dependencies.verifyMutationLedgersSanitized?.(state);
    if (pass === 0) await dependencies.waitBeforeRecheck?.(250);
  }
  await assertExternalObjectsAbsent(state, dependencies);
  await dependencies.removeState();
  return {
    cleaned: true,
    summaryBindingVerified: objectCleanup.summaryBindingVerified,
    residualCount: 0,
    objectResidualCount: 0,
    changeRecordRef: state.changeRecordId
      ? safeRef(state.changeRecordId)
      : null,
    summaryRecordRef: state.summaryReportRecordId
      ? safeRef(state.summaryReportRecordId)
      : null,
  };
}

async function assertExternalBaseAbsent(state, dependencies) {
  const [
    markerResidual,
    mutationResidual,
    relationResidual,
    exactMain,
    exactSummary,
  ] = await Promise.all([
    dependencies.queryMainByMarker(state.marker),
    dependencies.querySummaryByMutation(state.summaryMutationId),
    state.changeRecordId
      ? dependencies.querySummaryByChangeRecord(state.changeRecordId)
      : Promise.resolve([]),
    state.changeRecordId
      ? dependencies.getMainById(state.changeRecordId)
      : Promise.resolve(null),
    state.summaryReportRecordId
      ? dependencies.getSummaryById(state.summaryReportRecordId)
      : Promise.resolve(null),
  ]);
  if (
    !Array.isArray(markerResidual) ||
    !Array.isArray(mutationResidual) ||
    !Array.isArray(relationResidual) ||
    markerResidual.length ||
    mutationResidual.length ||
    relationResidual.length ||
    exactMain ||
    exactSummary
  ) {
    throw new UnsafeChangeSummarySelfTestCleanupError(
      'Base 精确双查仍存在自测残留',
    );
  }
}

async function assertExternalObjectsAbsent(state, dependencies) {
  let objectResidualCount = 0;
  for (const attachment of state.attachments) {
    if (!(await dependencies.isAttachmentAbsent(attachment))) {
      objectResidualCount += 1;
    }
  }
  if (objectResidualCount !== 0) {
    throw new UnsafeChangeSummarySelfTestCleanupError(
      `对象存储仍残留 ${objectResidualCount} 个附件`,
    );
  }
}

async function cleanupObjects(state, records, dependencies) {
  let summaryBindingVerified = false;
  const summaryAttachments = state.attachments.filter(
    (item) => item.kind === 'summary',
  );
  const summaryFileTokens = records.summaryRecord
    ? assertSummaryIdentity(state, records.summaryRecord, false).fileTokens
    : [];
  const mainFields = records.mainRecord ? asFields(records.mainRecord) : {};
  const submitterName = displayValues(
    mainFields['变更提交人'] ?? mainFields['申请提交人'],
  ).join('');
  const summaryFileTokenByObjectId = new Map(
    summaryAttachments.map((attachment, index) => [
      attachment.id,
      summaryFileTokens[index],
    ]),
  );
  for (const attachment of [
    ...summaryAttachments,
    ...state.attachments.filter((item) => item.kind === 'change'),
  ]) {
    let absent = await dependencies.isAttachmentAbsent(attachment);
    if (!absent) {
      if (attachment.kind === 'summary' && records.summaryRecord) {
        const response = await dependencies.deleteSummaryBoundAttachment({
          summaryReportRecordId: state.summaryReportRecordId,
          changeRecordId: state.changeRecordId,
          changeRequestMutationId: state.createMutationId,
          clientMutationId: state.summaryMutationId,
          objectId: attachment.id,
          summaryMarker: state.marker,
          submitterName,
          fileToken: summaryFileTokenByObjectId.get(attachment.id),
        });
        if (
          response?.success !== true ||
          clean(response?.objectId) !== attachment.id ||
          response?.missing === true
        ) {
          throw new UnsafeChangeSummarySelfTestCleanupError(
            '变更总结 COS 绑定清理回执无效',
          );
        }
        summaryBindingVerified = true;
      } else if (attachment.kind === 'change' && records.mainRecord) {
        await dependencies.deleteChangeBoundAttachment({
          recordId: state.changeRecordId,
          summaryMarker: state.marker,
          adjustmentMutationId: state.cleanupAdjustmentMutationId,
          adjustmentReasonMarker: state.cleanupReasonMarker,
          adjustmentConfirmed: false,
          objectId: attachment.id,
          ownerMutationId: attachment.ownerMutationId,
        });
      } else if (
        (attachment.kind === 'summary' &&
          (['summary-failed', 'definitely-not-written'].includes(
            state.disposition,
          ) ||
            (state.disposition === 'create-confirmed' &&
              state.summaryFingerprint === ''))) ||
        (attachment.kind === 'change' &&
          state.disposition === 'definitely-not-written')
      ) {
        await dependencies.deleteStagedAttachment(attachment);
      } else {
        throw new UnsafeChangeSummarySelfTestCleanupError(
          '附件可能仍被后台任务绑定，拒绝删除',
        );
      }
      absent = await dependencies.isAttachmentAbsent(attachment);
    }
    if (!absent) {
      throw new UnsafeChangeSummarySelfTestCleanupError(
        '对象存储附件删除后仍可见',
      );
    }
  }
  return { summaryBindingVerified };
}

function assertMainIdentity(state, record, allowAdoption) {
  const id = recordId(record);
  if (!RECORD_ID_PATTERN.test(id)) {
    throw new UnsafeChangeSummarySelfTestCleanupError(
      '主变更记录标识无效，拒绝清理',
    );
  }
  if (!allowAdoption && id !== state.changeRecordId) {
    throw new UnsafeChangeSummarySelfTestCleanupError(
      '主变更 recordId 不一致，拒绝清理',
    );
  }
  const fields = asFields(record);
  if (fieldText(fields['变更简述']) !== state.marker) {
    throw new UnsafeChangeSummarySelfTestCleanupError(
      '主变更 marker 不一致，拒绝清理',
    );
  }
  if (
    fieldText(fields['变更重要风险点（简述）']) !==
    `自测清理校验：${state.marker}`
  ) {
    throw new UnsafeChangeSummarySelfTestCleanupError(
      '主变更风险 marker 不一致，拒绝清理',
    );
  }
  return id;
}

function assertSummaryIdentity(state, record, allowAdoption) {
  const id = recordId(record);
  if (!RECORD_ID_PATTERN.test(id)) {
    throw new UnsafeChangeSummarySelfTestCleanupError(
      '总结收口记录标识无效，拒绝清理',
    );
  }
  if (!allowAdoption && id !== state.summaryReportRecordId) {
    throw new UnsafeChangeSummarySelfTestCleanupError(
      '总结收口 recordId 不一致，拒绝清理',
    );
  }
  const fields = asFields(record);
  if (
    fieldText(fields['变更总结请求唯一ID']) !== state.summaryMutationId ||
    fieldText(fields['变更总结请求指纹']) !== state.summaryFingerprint
  ) {
    throw new UnsafeChangeSummarySelfTestCleanupError(
      '总结请求唯一ID或指纹不一致，拒绝清理',
    );
  }
  const relationIds = linkedRecordIds(fields['变更关联']);
  if (relationIds.length !== 1 || relationIds[0] !== state.changeRecordId) {
    throw new UnsafeChangeSummarySelfTestCleanupError(
      '总结关联主变更身份不一致，拒绝清理',
    );
  }
  const fileTokens = attachmentTokens(fields['变更总结报告（风险低及以上）']);
  const expectedCount = state.attachments.filter(
    (attachment) => attachment.kind === 'summary',
  ).length;
  if (fileTokens.length !== expectedCount || fileTokens.length < 1) {
    throw new UnsafeChangeSummarySelfTestCleanupError(
      '总结附件令牌数量不一致，拒绝清理',
    );
  }
  return { recordId: id, fileTokens };
}

export function validateChangeSummarySelfTestState(value) {
  const exactKeys =
    isObject(value) &&
    Object.keys(value).sort().join('\0') === [...STATE_KEYS].sort().join('\0');
  const createMutationId = clean(value?.createMutationId);
  const cleanupAdjustmentMutationId = clean(value?.cleanupAdjustmentMutationId);
  const summaryMutationId = clean(value?.summaryMutationId);
  const changeRecordId = clean(value?.changeRecordId);
  const summaryReportRecordId = clean(value?.summaryReportRecordId);
  const marker = clean(value?.marker);
  const cleanupReasonMarker = clean(value?.cleanupReasonMarker);
  const summaryFingerprint = clean(value?.summaryFingerprint);
  const disposition = clean(value?.disposition);
  const cleanupPhase = clean(value?.cleanupPhase);
  const attachments = Array.isArray(value?.attachments)
    ? value.attachments
    : null;
  const validAttachments =
    attachments !== null &&
    attachments.length <= 10 &&
    attachments.every((attachment) => {
      if (
        !isObject(attachment) ||
        Object.keys(attachment).sort().join('\0') !==
          'id\0kind\0ownerMutationId'
      ) {
        return false;
      }
      const kind = attachment.kind;
      const expectedOwner =
        kind === 'change'
          ? createMutationId
          : kind === 'summary'
            ? summaryMutationId
            : '';
      return (
        OBJECT_ID_PATTERN.test(clean(attachment.id)) &&
        attachment.ownerMutationId === expectedOwner
      );
    }) &&
    new Set(attachments.map((attachment) => attachment.id)).size ===
      attachments.length;
  const summaryStarted = ![
    'prepared',
    'create-attempted',
    'create-confirmed',
    'definitely-not-written',
    'unknown-result',
  ].includes(disposition);
  if (
    !exactKeys ||
    value.version !== 1 ||
    value.createMutationId !== createMutationId ||
    !CREATE_MUTATION_ID_PATTERN.test(createMutationId) ||
    value.cleanupAdjustmentMutationId !== cleanupAdjustmentMutationId ||
    !ADJUSTMENT_MUTATION_ID_PATTERN.test(cleanupAdjustmentMutationId) ||
    value.summaryMutationId !== summaryMutationId ||
    !SUMMARY_MUTATION_ID_PATTERN.test(summaryMutationId) ||
    value.changeRecordId !== changeRecordId ||
    (changeRecordId && !RECORD_ID_PATTERN.test(changeRecordId)) ||
    value.summaryReportRecordId !== summaryReportRecordId ||
    (summaryReportRecordId && !RECORD_ID_PATTERN.test(summaryReportRecordId)) ||
    value.marker !== marker ||
    !MARKER_PATTERN.test(marker) ||
    value.cleanupReasonMarker !== cleanupReasonMarker ||
    !CLEANUP_REASON_PATTERN.test(cleanupReasonMarker) ||
    value.summaryFingerprint !== summaryFingerprint ||
    (summaryFingerprint && !FINGERPRINT_PATTERN.test(summaryFingerprint)) ||
    (summaryStarted && !FINGERPRINT_PATTERN.test(summaryFingerprint)) ||
    value.disposition !== disposition ||
    !DISPOSITIONS.has(disposition) ||
    value.cleanupPhase !== cleanupPhase ||
    !CLEANUP_PHASES.has(cleanupPhase) ||
    !validAttachments
  ) {
    throw new UnsafeChangeSummarySelfTestCleanupError(
      '变更总结真实自测状态文件无效，拒绝清理',
    );
  }
  return {
    version: 1,
    createMutationId,
    cleanupAdjustmentMutationId,
    summaryMutationId,
    changeRecordId,
    summaryReportRecordId,
    marker,
    cleanupReasonMarker,
    summaryFingerprint,
    disposition,
    cleanupPhase,
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      ownerMutationId: attachment.ownerMutationId,
      kind: attachment.kind,
    })),
  };
}

function validateStagedDocument(document) {
  const id = clean(document?.objectStorage?.id);
  const url = clean(document?.objectStorage?.url);
  const size = Number(document?.size);
  if (
    !OBJECT_ID_PATTERN.test(id) ||
    url !==
      `/api/duty-schedules/change-attachments/${encodeURIComponent(id)}/download` ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_DOCUMENT_BYTES ||
    !clean(document?.objectStorage?.filePath) ||
    !clean(document?.objectStorage?.bucketId)
  ) {
    throw new Error('COS 暂存文档响应校验失败');
  }
  return document;
}

function recoverStagedDocument(document) {
  const id = clean(document?.objectStorage?.id);
  const url = clean(document?.objectStorage?.url);
  if (
    !OBJECT_ID_PATTERN.test(id) ||
    url !==
      `/api/duty-schedules/change-attachments/${encodeURIComponent(id)}/download`
  ) {
    return null;
  }
  return { objectStorage: { id } };
}

function registerAttachment(state, document, kind) {
  if (!['change', 'summary'].includes(kind)) {
    throw new Error('自测附件类型无效');
  }
  const id = clean(document?.objectStorage?.id);
  if (state.attachments.some((attachment) => attachment.id === id)) {
    throw new Error('自测附件标识重复');
  }
  return validateChangeSummarySelfTestState({
    ...state,
    attachments: [
      ...state.attachments,
      {
        id,
        ownerMutationId:
          kind === 'change' ? state.createMutationId : state.summaryMutationId,
        kind,
      },
    ],
  });
}

function assertChangeRequestResponse(response, mutationId) {
  if (
    response?.success !== true ||
    clean(response?.clientMutationId) !== mutationId ||
    !RECORD_ID_PATTERN.test(responseRecordId(response))
  ) {
    throw new Error('变更申请响应校验失败');
  }
}

function assertSummaryReplayResponse(response, state) {
  if (
    response?.success !== true ||
    clean(response?.clientMutationId) !== state.summaryMutationId ||
    clean(response?.taskId) !== state.summaryMutationId ||
    clean(response?.changeRecordId) !== state.changeRecordId ||
    clean(response?.summaryReportRecordId) !== state.summaryReportRecordId
  ) {
    throw new Error('变更总结幂等重放响应身份不一致');
  }
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

function classifyRunFailureDisposition(state, error) {
  if (state.disposition === 'summary-confirmed') return 'summary-confirmed';
  if (error?.summaryTaskFailed === true) return 'summary-failed';
  if (state.disposition === 'summary-accepted') return 'unknown-result';
  if (state.disposition === 'summary-attempted') {
    return classifyMutationError(error) === 'definitely-not-written'
      ? 'summary-failed'
      : 'unknown-result';
  }
  if (state.disposition === 'create-confirmed') return 'create-confirmed';
  if (state.disposition === 'create-attempted') {
    return classifyMutationError(error);
  }
  return 'definitely-not-written';
}

function classifyMutationError(error) {
  const disposition = clean(
    error?.response?.data?.writeDisposition || error?.writeDisposition,
  );
  const recordState = clean(
    error?.response?.data?.recordState || error?.recordState,
  );
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
  const status = Number(error?.response?.status ?? error?.status);
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

function assertUnambiguous(records, label) {
  if (!Array.isArray(records)) {
    throw new UnsafeChangeSummarySelfTestCleanupError(
      `${label} 回查格式无效，拒绝清理`,
    );
  }
  if (records.length > 1) {
    throw new UnsafeChangeSummarySelfTestCleanupError(
      `${label} 命中 ${records.length} 条，拒绝清理`,
    );
  }
}

async function queryWithRetry(operation, dependencies, settled) {
  const attempts = typeof dependencies.waitBeforeRecheck === 'function' ? 8 : 1;
  let records = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    records = await operation();
    if (!Array.isArray(records)) throw new Error('Base 严格回查格式无效');
    if (settled(records) || attempt === attempts - 1) return records;
    await dependencies.waitBeforeRecheck(500 * (attempt + 1));
  }
  return records;
}

async function getRecordWithRetry(operation, dependencies) {
  const attempts = typeof dependencies.waitBeforeRecheck === 'function' ? 8 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const record = await operation();
    if (record || attempt === attempts - 1) return record || null;
    await dependencies.waitBeforeRecheck(500 * (attempt + 1));
  }
  return null;
}

function responseRecordId(response) {
  return clean(response?.record?.bitableRecordId || response?.record?.id);
}

function recordId(record) {
  return clean(record?.record_id || record?.id);
}

function asFields(record) {
  return isObject(record?.fields) ? record.fields : {};
}

function fieldText(value) {
  return displayValues(value).join('').trim();
}

function displayValues(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(displayValues);
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return text ? [text] : [];
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
  return [
    ...new Set(
      value
        .map((item) =>
          clean(item?.file_token || item?.fileToken || item?.token),
        )
        .filter(Boolean),
    ),
  ];
}

function summaryLookupTokens(value) {
  const tokens = new Set();
  const queue = [{ value, depth: 0 }];
  let visited = 0;
  const seen = new WeakSet();
  while (queue.length > 0) {
    const current = queue.shift();
    visited += 1;
    if (visited > 4096 || current.depth > 64) {
      throw new Error('变更总结 Lookup 结构超出安全范围');
    }
    const entry = current.value;
    if (entry === null || entry === undefined) continue;
    if (Array.isArray(entry)) {
      if (entry.length > 512) throw new Error('变更总结 Lookup 数组过大');
      for (const item of entry)
        queue.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (!isObject(entry)) continue;
    if (seen.has(entry)) throw new Error('变更总结 Lookup 存在循环引用');
    seen.add(entry);
    for (const key of ['file_token', 'token', 'attachmentToken']) {
      const token = clean(entry[key]);
      if (token) tokens.add(token);
    }
    for (const key of ['raw_value', 'value', 'link_value', 'items']) {
      if (Object.prototype.hasOwnProperty.call(entry, key)) {
        queue.push({ value: entry[key], depth: current.depth + 1 });
      }
    }
  }
  return [...tokens];
}

function linkedRecordIds(value) {
  const ids = new Set();
  const queue = [value];
  let visited = 0;
  while (queue.length > 0) {
    const entry = queue.shift();
    visited += 1;
    if (visited > 1024) throw new Error('关联记录结构超出安全范围');
    if (Array.isArray(entry)) {
      queue.push(...entry);
      continue;
    }
    if (typeof entry === 'string') {
      const id = clean(entry);
      if (RECORD_ID_PATTERN.test(id)) ids.add(id);
      continue;
    }
    if (!isObject(entry)) continue;
    for (const key of ['record_id', 'recordId', 'id']) {
      const id = clean(entry[key]);
      if (RECORD_ID_PATTERN.test(id)) ids.add(id);
    }
    for (const key of [
      'value',
      'link_value',
      'items',
      'record_ids',
      'link_record_ids',
    ]) {
      if (Object.prototype.hasOwnProperty.call(entry, key))
        queue.push(entry[key]);
    }
  }
  return [...ids];
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

function normalizeLabel(value) {
  return fieldText(value).normalize('NFKC').replace(/\s+/gu, '');
}

function normalizeExactName(value) {
  return clean(value).normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function parseShanghaiLocal(value) {
  const timestamp = Date.parse(`${value}:00+08:00`);
  if (!Number.isFinite(timestamp)) throw new Error('自测时间格式无效');
  return timestamp;
}

function shanghaiDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeRef(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function tagOperation(error, operation) {
  const safeOperation = OPERATIONS.has(operation) ? operation : 'unknown';
  if (error && typeof error === 'object') {
    try {
      error.selfTestOperation = safeOperation;
      return error;
    } catch {
      // Foreign frozen errors are wrapped below.
    }
  }
  const wrapped = new Error(
    error instanceof Error ? error.message : String(error),
    {
      cause: error,
    },
  );
  wrapped.selfTestOperation = safeOperation;
  return wrapped;
}

export function createSummaryCleanupProof(input, encodedSecret) {
  const secret = decodeSecret(encodedSecret);
  if (!secret) throw new Error('变更总结自测清理签名配置无效');
  return createHmac('sha256', secret)
    .update(
      [
        'vnet-change-summary-report-self-test-cleanup-v2',
        clean(input.summaryReportRecordId),
        clean(input.changeRecordId),
        clean(input.changeRequestMutationId),
        clean(input.clientMutationId),
        clean(input.objectId),
        clean(input.summaryMarker),
        clean(input.submitterName).normalize('NFKC').trim(),
        clean(input.fileToken),
        String(input.expiresAt),
      ].join('\n'),
    )
    .digest('base64url');
}

export function createFailedSummaryCleanupProof(input, encodedSecret) {
  const secret = decodeSecret(encodedSecret);
  if (!secret) throw new Error('变更总结失败收口签名配置无效');
  const canonicalObjectIds = (value) =>
    JSON.stringify(
      (Array.isArray(value) ? value : []).map((item) => clean(item)).sort(),
    );
  return createHmac('sha256', secret)
    .update(
      [
        'vnet-change-summary-report-failed-self-test-cleanup-v1',
        clean(input.changeRequestMutationId),
        clean(input.clientMutationId),
        clean(input.changeRecordId),
        clean(input.summaryMarker),
        clean(input.summaryFingerprint),
        canonicalObjectIds(input.changeObjectIds),
        canonicalObjectIds(input.summaryObjectIds),
        String(input.expiresAt),
      ].join('\n'),
    )
    .digest('base64url');
}

export async function verifyLocalMutationLedgersSanitized(input, options = {}) {
  const state = validateChangeSummarySelfTestState(input);
  const mayHaveSkippedAllMutationLedgers =
    state.disposition === 'definitely-not-written' &&
    state.changeRecordId === '' &&
    state.summaryReportRecordId === '' &&
    state.summaryFingerprint === '' &&
    state.attachments.length === 0;
  const targets = [
    {
      directory: resolve(
        clean(options.changeRequestLedgerDir) ||
          clean(process.env.CHANGE_REQUEST_MUTATION_LEDGER_DIR) ||
          join(process.cwd(), 'data', 'change-request-mutations'),
      ),
      mutationId: state.createMutationId,
      proofDigestsRequired: false,
    },
    {
      directory: resolve(
        clean(options.summaryReportLedgerDir) ||
          clean(process.env.CHANGE_SUMMARY_REPORT_MUTATION_LEDGER_DIR) ||
          join(process.cwd(), 'data', 'change-summary-report-mutations'),
      ),
      mutationId: state.summaryMutationId,
      proofDigestsRequired: true,
    },
  ];
  let verifiedLedgerCount = 0;

  for (const target of targets) {
    const mutationHash = createHash('sha256')
      .update(target.mutationId)
      .digest('hex');
    const names = await readdir(target.directory).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    if (
      names.some(
        (name) =>
          name === target.mutationId ||
          name.startsWith(`${target.mutationId}.`),
      )
    ) {
      throw new UnsafeChangeSummarySelfTestCleanupError(
        '本地幂等台账仍存在自测明文残留',
      );
    }
    const tombstoneName = `self-test-cleaned-${mutationHash}.json`;
    if (!names.includes(tombstoneName)) {
      if (mayHaveSkippedAllMutationLedgers) continue;
      throw new UnsafeChangeSummarySelfTestCleanupError(
        '本地幂等台账缺少自测清理墓碑',
      );
    }
    let tombstone;
    try {
      tombstone = JSON.parse(
        await readFile(join(target.directory, tombstoneName), 'utf8'),
      );
    } catch {
      throw new UnsafeChangeSummarySelfTestCleanupError(
        '本地幂等台账自测清理墓碑损坏',
      );
    }
    const allowedKeys = new Set([
      'version',
      'state',
      'mutationHash',
      'cleanedAt',
      ...(target.proofDigestsRequired ? ['proofDigests'] : []),
    ]);
    if (
      !tombstone ||
      typeof tombstone !== 'object' ||
      Array.isArray(tombstone) ||
      Object.keys(tombstone).some((key) => !allowedKeys.has(key)) ||
      tombstone.version !== 1 ||
      tombstone.state !== 'self-test-cleaned' ||
      tombstone.mutationHash !== mutationHash ||
      typeof tombstone.cleanedAt !== 'string' ||
      !Number.isFinite(Date.parse(tombstone.cleanedAt)) ||
      (target.proofDigestsRequired &&
        (!Array.isArray(tombstone.proofDigests) ||
          tombstone.proofDigests.some(
            (digest) => !/^[0-9a-f]{64}$/.test(clean(digest)),
          )))
    ) {
      throw new UnsafeChangeSummarySelfTestCleanupError(
        '本地幂等台账自测清理墓碑损坏',
      );
    }
    verifiedLedgerCount += 1;
  }
  return { verified: true, ledgerCount: verifiedLedgerCount };
}

export function createChangeCleanupProof(input, encodedSecret) {
  const secret = decodeSecret(encodedSecret);
  if (!secret) throw new Error('变更自测清理签名配置无效');
  return createHmac('sha256', secret)
    .update(
      [
        'vnet-change-self-test-cleanup-v1',
        clean(input.recordId),
        clean(input.summaryMarker),
        clean(input.adjustmentMutationId),
        clean(input.adjustmentReasonMarker),
        input.adjustmentConfirmed === true ? '1' : '0',
        clean(input.objectId),
        clean(input.ownerMutationId),
        String(input.expiresAt),
      ].join('\n'),
    )
    .digest('base64url');
}

function decodeSecret(value) {
  const encoded = clean(value);
  try {
    const secret = Buffer.from(encoded, 'base64');
    return secret.length === 32 && secret.toString('base64') === encoded
      ? secret
      : null;
  } catch {
    return null;
  }
}

export function createLoopbackApiSession({
  baseUrl,
  client,
  accessSessionToken,
  expectedRole = 'duty_editor',
}) {
  const origin = loopbackOrigin(baseUrl);
  const sessionValue = clean(accessSessionToken);
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(sessionValue)) {
    throw new TypeError('本地 API 权限会话无效');
  }
  const accessCookie = `${ACCESS_SESSION_COOKIE_NAME}=${sessionValue}`;
  let primed = false;
  let csrf = '';
  return {
    prime: async () => {
      const documentResponse = await client.get('/', {
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      csrf = extractCsrf(documentResponse?.headers);
      const sessionResponse = await client.get('/api/access/session', {
        headers: { Cookie: accessCookie },
      });
      if (sessionResponse?.data?.role !== expectedRole) {
        throw new Error('本地 API 权限会话校验失败');
      }
      primed = true;
      return { role: expectedRole, csrfEnabled: Boolean(csrf) };
    },
    get: async (path, config = {}) => {
      assertLoopbackPath(origin, path);
      return client.get(path, {
        ...config,
        headers: { ...(config.headers || {}), Cookie: accessCookie },
      });
    },
    post: async (path, data, config = {}) => {
      assertLoopbackPath(origin, path);
      if (!primed) throw new TypeError('本地 API 会话尚未初始化');
      const headers = { ...(config.headers || {}) };
      headers.Cookie = accessCookie;
      if (csrf) {
        headers.Cookie = `${CSRF_COOKIE_NAME}=${csrf}; ${accessCookie}`;
        headers[CSRF_HEADER_NAME] = csrf;
      }
      return client.post(path, data, { ...config, headers });
    },
  };
}

function loopbackOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('本地 API 地址无效');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '::1'].includes(
      url.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
    ) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== '/')
  ) {
    throw new TypeError('本地 API 地址必须是回环地址根路径');
  }
  return url.origin;
}

function assertLoopbackPath(origin, path) {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    new URL(path, `${origin}/`).origin !== origin
  ) {
    throw new TypeError('本地 API 请求必须使用同源相对路径');
  }
}

function extractCsrf(headers) {
  const raw = headers?.['set-cookie'] ?? headers?.get?.('set-cookie');
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const matches = values
    .filter((value) => typeof value === 'string')
    .map((value) => value.split(';', 1)[0])
    .filter((value) => value.startsWith(`${CSRF_COOKIE_NAME}=`))
    .map((value) => value.slice(CSRF_COOKIE_NAME.length + 1));
  if (matches.length === 0) return '';
  if (matches.length !== 1 || !/^[A-Za-z0-9_-]{40,80}$/.test(matches[0])) {
    throw new TypeError('CSRF Cookie 格式无效');
  }
  return matches[0];
}

async function writeSmallPdfFixture(path, marker) {
  const rendered = renderPdf(DEFAULT_PDF_BYTES, marker);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rendered, { flag: 'wx', mode: 0o600 });
  const details = await stat(path);
  if (!details.isFile() || details.size !== DEFAULT_PDF_BYTES) {
    throw new Error('小型 PDF 自测文件生成失败');
  }
  return {
    absolutePath: path,
    filename: `${basename(path, '.pdf')}.pdf`,
    mimeType: 'application/pdf',
    size: details.size,
  };
}

function renderPdf(targetSize, marker) {
  let streamLength = targetSize - 600;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const prefixParts = ['%PDF-1.7\n%\xE2\xE3\xCF\xD3\n'];
    const offsets = [];
    const pushObject = (body) => {
      offsets.push(Buffer.byteLength(prefixParts.join(''), 'binary'));
      prefixParts.push(body);
    };
    pushObject('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    pushObject('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
    pushObject(
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R >>\nendobj\n',
    );
    offsets.push(Buffer.byteLength(prefixParts.join(''), 'binary'));
    prefixParts.push(
      `4 0 obj\n<< /Length ${streamLength} /SelfTest (${clean(marker).slice(0, 64)}) >>\nstream\n`,
    );
    const prefix = prefixParts.join('');
    const contentTail = '\nendstream\nendobj\n';
    const xrefOffset =
      Buffer.byteLength(prefix, 'binary') +
      streamLength +
      Buffer.byteLength(contentTail, 'binary');
    const suffix = `${contentTail}xref\n0 5\n0000000000 65535 f \n${offsets
      .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
      .join(
        '',
      )}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    const total =
      Buffer.byteLength(prefix, 'binary') +
      streamLength +
      Buffer.byteLength(suffix, 'binary');
    if (total === targetSize) {
      return Buffer.concat([
        Buffer.from(prefix, 'binary'),
        Buffer.alloc(streamLength, 0x20),
        Buffer.from(suffix, 'binary'),
      ]);
    }
    streamLength += targetSize - total;
  }
  throw new Error('无法生成指定大小的 PDF 自测文件');
}

async function createRealDependencies({ baseUrl, statePath }) {
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
    ]) || parsedSource.tableId;
  const configuredSummaryTableId =
    configModule.readEnv('FEISHU_CHANGE_DRILL_REPORT_TABLE_ID') ||
    CHANGE_SUMMARY_REPORT_TABLE_ID;
  if (
    configuredTableId !== CHANGE_TABLE_ID ||
    configuredSummaryTableId !== CHANGE_SUMMARY_REPORT_TABLE_ID
  ) {
    throw new Error('变更总结真实自测 Base 表配置与固定目标不一致');
  }
  const summaryTableName =
    configModule.readEnv('FEISHU_CHANGE_DRILL_REPORT_TABLE_NAME') ||
    CHANGE_SUMMARY_REPORT_TABLE_NAME;
  const appToken = await bitableModule.resolveBitableAppToken(httpService, {
    appToken:
      configModule.readEnv('FEISHU_CALENDAR_CHANGE_APP_TOKEN', [
        'FEISHU_CHANGE_CALENDAR_APP_TOKEN',
        'FEISHU_CHANGE_MANAGEMENT_APP_TOKEN',
      ]) || parsedSource.appToken,
    wikiToken:
      configModule.readEnv('FEISHU_CALENDAR_CHANGE_WIKI_TOKEN', [
        'FEISHU_CHANGE_CALENDAR_WIKI_TOKEN',
        'FEISHU_CHANGE_MANAGEMENT_WIKI_TOKEN',
      ]) || parsedSource.wikiToken,
    tableName: CHANGE_TABLE_NAME,
  });
  const gateway = new workflowModule.InventoryWorkflowGateway(httpService);
  const access = new accessModule.UnifiedAccessService();
  if (!access.isAccessControlEnabled() || !access.isConfigured()) {
    throw new Error('变更总结真实自测要求启用并安全配置统一访问控制');
  }
  const editorSession = access.issueTrustedSession({
    role: 'duty_editor',
    purchaseBuilding: null,
  });
  const adminSession = access.issueTrustedSession({
    role: 'admin',
    purchaseBuilding: null,
  });
  const cleanupSecret = clean(
    process.env.LOCAL_ACCESS_SESSION_SECRET ||
      process.env.LOCAL_ADMIN_SESSION_SECRET,
  );
  const client = axios.create(localAxiosConfig(baseUrl));
  const localApi = createLoopbackApiSession({
    baseUrl,
    client,
    accessSessionToken: editorSession.token,
  });
  const adminApi = createLoopbackApiSession({
    baseUrl,
    client,
    accessSessionToken: adminSession.token,
    expectedRole: 'admin',
  });
  const fixtureDir = join(
    dirname(statePath),
    '.change-summary-self-test-files',
  );

  const fetchExact = (tableId, tableName, fieldNames, fieldName, value) =>
    bitableModule.fetchBitableRecords(httpService, {
      appToken,
      tableId,
      tableName,
      fieldNames,
      filter: {
        conjunction: 'and',
        conditions: [{ field_name: fieldName, operator: 'is', value: [value] }],
      },
      cacheTtlMs: 0,
      forceRefresh: true,
      allowStale: false,
      strict: true,
    });
  const getRecord = async (tableId, tableName, id) => {
    try {
      return await gateway.getRecord(appToken, tableId, id, tableName);
    } catch (error) {
      if (
        error instanceof workflowModule.InventoryWorkflowRecordNotFoundError
      ) {
        return null;
      }
      throw error;
    }
  };
  const stageDocument = async (ownerMutationId, kind) => {
    await mkdir(fixtureDir, { recursive: true });
    const path = join(fixtureDir, `${ownerMutationId}-${kind}.pdf`);
    await unlinkIfExists(path);
    const descriptor = await writeSmallPdfFixture(path, kind);
    const form = new FormData();
    form.append('ownerMutationId', ownerMutationId);
    form.append('file', createReadStream(path), {
      filename: `${kind}-self-test.pdf`,
      contentType: descriptor.mimeType,
      knownLength: descriptor.size,
    });
    try {
      const response = await localApi.post(
        '/api/duty-schedules/change-attachments/stage',
        form,
        {
          headers: form.getHeaders(),
          maxBodyLength: 2 * 1024 * 1024,
          maxContentLength: 2 * 1024 * 1024,
          timeout: 120_000,
        },
      );
      return response.data?.document;
    } finally {
      await unlinkIfExists(path);
    }
  };

  return {
    now: () => new Date(),
    monotonicNow: () => globalThis.performance.now(),
    randomUUID: () => createRandomUUID(),
    verifyMutationLedgersSanitized: (state) =>
      verifyLocalMutationLedgersSanitized(state),
    primeLocalApi: async () => {
      await localApi.prime();
      await adminApi.prime();
    },
    fetchLocalPeople: async () => {
      const response = await localApi.get(
        '/api/bitable/person-profiles?scope=leave',
      );
      const submitters = response.data?.changeRequestSubmitters;
      if (!Array.isArray(submitters)) {
        throw new Error('本地人员缓存接口响应无效');
      }
      return submitters.map((name) => ({ supervisorText: clean(name) }));
    },
    stageDocument,
    postChangeRequest: async (request) =>
      (
        await localApi.post('/api/duty-schedules/change-request', request, {
          timeout: 120_000,
        })
      ).data,
    getChangeRequestSyncTask: async (taskId) =>
      (
        await localApi.get(
          `/api/duty-schedules/change-request-sync/${encodeURIComponent(taskId)}`,
          { timeout: 30_000 },
        )
      ).data,
    postChangeSummaryReport: async (request) =>
      (
        await localApi.post(
          '/api/duty-schedules/change-summary-report',
          request,
          { timeout: 30_000 },
        )
      ).data,
    getChangeSummaryReportTask: async (taskId) =>
      (
        await localApi.get(
          `/api/duty-schedules/change-summary-report-sync/${encodeURIComponent(taskId)}`,
          { timeout: 30_000 },
        )
      ).data,
    queryMainByMarker: (marker) =>
      fetchExact(
        CHANGE_TABLE_ID,
        CHANGE_TABLE_NAME,
        MAIN_FIELD_NAMES,
        '变更简述',
        marker,
      ),
    querySummaryByMutation: (mutationId) =>
      fetchExact(
        CHANGE_SUMMARY_REPORT_TABLE_ID,
        summaryTableName,
        SUMMARY_FIELD_NAMES,
        '变更总结请求唯一ID',
        mutationId,
      ),
    querySummaryByChangeRecord: (changeRecordId) =>
      fetchExact(
        CHANGE_SUMMARY_REPORT_TABLE_ID,
        summaryTableName,
        SUMMARY_FIELD_NAMES,
        '变更关联',
        changeRecordId,
      ),
    getMainById: (id) => getRecord(CHANGE_TABLE_ID, CHANGE_TABLE_NAME, id),
    getSummaryById: (id) =>
      getRecord(CHANGE_SUMMARY_REPORT_TABLE_ID, summaryTableName, id),
    verifyStorageAccessible: async ({ attachment }) => {
      try {
        await localApi.get(
          `/api/duty-schedules/change-attachments/${encodeURIComponent(attachment.id)}/download`,
          { maxRedirects: 0, timeout: 30_000 },
        );
        return false;
      } catch (error) {
        return Number(error?.response?.status) === 302;
      }
    },
    finalizeFailedSummaryCleanup: async (request) => {
      const payload = { ...request, expiresAt: Date.now() + 60_000 };
      const proof = createFailedSummaryCleanupProof(payload, cleanupSecret);
      const response = await adminApi.post(
        '/api/duty-schedules/change-summary-report/self-test/finalize-failed-cleanup',
        payload,
        {
          headers: {
            'x-change-summary-failed-self-test-cleanup-proof': proof,
          },
          timeout: 120_000,
        },
      );
      if (response.data?.success !== true) {
        throw new Error('变更总结失败台账清理回执无效');
      }
      return response.data;
    },
    deleteSummaryBoundAttachment: async (request) => {
      const payload = { ...request, expiresAt: Date.now() + 60_000 };
      const proof = createSummaryCleanupProof(payload, cleanupSecret);
      const response = await adminApi.post(
        '/api/duty-schedules/change-summary-report/self-test/cleanup-bound-attachment',
        payload,
        {
          headers: {
            'x-change-summary-self-test-cleanup-proof': proof,
          },
          timeout: 120_000,
        },
      );
      return response.data;
    },
    deleteChangeBoundAttachment: async (request) => {
      const payload = { ...request, expiresAt: Date.now() + 60_000 };
      const proof = createChangeCleanupProof(payload, cleanupSecret);
      await adminApi.post(
        '/api/duty-schedules/change-adjustment/self-test/cleanup-bound-attachment',
        payload,
        {
          headers: { 'x-change-self-test-cleanup-proof': proof },
          timeout: 120_000,
        },
      );
    },
    deleteStagedAttachment: async ({ id, ownerMutationId }) => {
      try {
        await localApi.post(
          `/api/duty-schedules/change-attachments/${encodeURIComponent(id)}/delete`,
          { ownerMutationId },
          { timeout: 120_000 },
        );
      } catch (error) {
        if (Number(error?.response?.status) !== 404) throw error;
      }
    },
    isAttachmentAbsent: async ({ id }) => {
      const response = await adminApi.get(
        `/api/duty-schedules/change-attachments/${encodeURIComponent(
          id,
        )}/self-test-deletion-state`,
        { timeout: 30_000 },
      );
      const state = clean(response.data?.state);
      if (
        response.data?.success !== true ||
        clean(response.data?.objectId) !== id ||
        !['present', 'cleanup-pending', 'absent'].includes(state)
      ) {
        throw new Error('变更附件可信删除状态响应无效');
      }
      return state === 'absent';
    },
    deleteSummaryRecordById: (id) =>
      gateway.deleteRecord(
        appToken,
        CHANGE_SUMMARY_REPORT_TABLE_ID,
        id,
        summaryTableName,
      ),
    deleteMainRecordById: (id) =>
      gateway.deleteRecord(appToken, CHANGE_TABLE_ID, id, CHANGE_TABLE_NAME),
    writeState: (value) => atomicWriteJson(statePath, value),
    removeState: () => unlinkIfExists(statePath),
    waitBeforePoll: delay,
    waitBeforeRecheck: delay,
  };
}

function localAxiosConfig(baseUrl) {
  const origin = loopbackOrigin(baseUrl);
  const url = new URL(origin);
  const config = {
    baseURL: origin,
    timeout: 30_000,
    validateStatus: (status) => status >= 200 && status < 300,
  };
  return url.protocol === 'https:'
    ? { ...config, httpsAgent: new HttpsAgent({ rejectUnauthorized: false }) }
    : config;
}

export function parseArguments(args) {
  const command = args[0] && !args[0].startsWith('--') ? args[0] : 'run';
  if (!['run', 'cleanup-only'].includes(command)) {
    throw new Error('命令必须是 run 或 cleanup-only');
  }
  const baseUrl = clean(
    optionValue(args, '--base-url') || DEFAULT_BASE_URL,
  ).replace(/\/+$/, '');
  loopbackOrigin(baseUrl);
  const statePath = resolve(optionValue(args, '--state') || DEFAULT_STATE_PATH);
  const maxAcceptanceRaw = optionValue(args, '--max-acceptance-ms');
  const maxAcceptanceMs = maxAcceptanceRaw
    ? Number(maxAcceptanceRaw)
    : SUMMARY_ACCEPTANCE_MAX_MS;
  if (
    !Number.isSafeInteger(maxAcceptanceMs) ||
    maxAcceptanceMs < 100 ||
    maxAcceptanceMs > SUMMARY_ACCEPTANCE_MAX_MS
  ) {
    throw new Error('--max-acceptance-ms 必须是 100 至 1000 的整数');
  }
  return { command, baseUrl, statePath, maxAcceptanceMs };
}

function optionValue(args, name) {
  const positions = args.flatMap((value, index) =>
    value === name ? [index] : [],
  );
  if (positions.length > 1) throw new Error(`${name} 只能指定一次`);
  return positions.length === 1 ? args[positions[0] + 1] || '' : '';
}

async function main(setStage = () => undefined) {
  setStage('arguments');
  const parsed = parseArguments(process.argv.slice(2));
  setStage('state');
  if (parsed.command === 'cleanup-only') {
    const state = validateChangeSummarySelfTestState(
      await readJsonState(parsed.statePath, true),
    );
    setStage('dependencies');
    const dependencies = await createRealDependencies(parsed);
    setStage('cleanup');
    const result = await cleanupChangeSummaryReportState(state, dependencies);
    printSafe({ ok: true, mode: 'cleanup-only', ...result });
    return;
  }
  if (await readJsonState(parsed.statePath, false)) {
    throw new Error('存在未清理的变更总结真实自测状态，请先运行 cleanup-only');
  }
  setStage('dependencies');
  const dependencies = await createRealDependencies(parsed);
  setStage('execute');
  const result = await runChangeSummaryReportSelfTest(
    { maxAcceptanceMs: parsed.maxAcceptanceMs },
    dependencies,
  );
  printSafe(result);
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await unlinkIfExists(temporary);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function readJsonState(path, required) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) return null;
    if (error?.code === 'ENOENT') throw new Error('变更总结自测状态文件不存在');
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

function classifySafeReason(error) {
  const candidates =
    error instanceof AggregateError ? [error, ...error.errors] : [error];
  const messages = [];
  let status = null;
  for (const candidate of candidates) {
    if (
      Number.isFinite(Number(candidate?.response?.status)) &&
      status === null
    ) {
      status = Number(candidate.response.status);
    }
    const data = candidate?.response?.data;
    if (typeof data === 'string') messages.push(data);
    if (typeof data?.message === 'string') messages.push(data.message);
    if (typeof data?.error === 'string') messages.push(data.error);
  }
  const combined = messages.join('\n');
  const rules = [
    [/提交人|人员/, 'request-submitter'],
    [/附件|文档/, 'request-document'],
    [/时间|日期/, 'request-time'],
    [/字段|多维表/, 'bitable-schema'],
    [/请求标识|幂等|指纹/, 'idempotency'],
    [/对象存储|COS/, 'object-storage'],
  ];
  for (const [pattern, reason] of rules) {
    if (pattern.test(combined)) return reason;
  }
  return status === null ? 'unknown' : `http-${status}`;
}

export function buildSafeCliError(error, stage = 'execute') {
  const safeStage = new Set([
    'startup',
    'arguments',
    'state',
    'dependencies',
    'execute',
    'cleanup',
  ]).has(stage)
    ? stage
    : 'execute';
  let code = 'SELF_TEST_FAILED';
  if (error instanceof UnsafeChangeSummarySelfTestCleanupError) {
    code = 'UNSAFE_CLEANUP';
  } else if (error instanceof AggregateError) {
    code = 'SELF_TEST_AND_CLEANUP_FAILED';
  } else if (safeStage === 'cleanup') {
    code = 'CLEANUP_FAILED';
  }
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  const operation = OPERATIONS.has(clean(error?.selfTestOperation))
    ? clean(error.selfTestOperation)
    : 'unknown';
  return {
    stage: safeStage,
    operation,
    reason: classifySafeReason(error),
    code,
    safeRef: safeRef(`${name}\0${message}`),
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
      `${JSON.stringify({ ok: false, error: buildSafeCliError(error, activeStage) })}\n`,
    );
    process.exitCode = 1;
  });
}
