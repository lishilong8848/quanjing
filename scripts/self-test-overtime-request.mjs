import axios from 'axios';
import FormData from 'form-data';
import { createHash, randomUUID as createRandomUUID } from 'node:crypto';
import { readFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { Agent as HttpsAgent } from 'node:https';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OVERTIME_TABLE_ID = 'tblf1bbd02a2b049';
const DEFAULT_OVERTIME_SOURCE_URL = 'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE';
const DEFAULT_BASE_URL = 'https://127.0.0.1:3001';
const DEFAULT_STATE_PATH = resolve(
  process.cwd(),
  'output/diagnostics/overtime-request-real-self-test-state.json',
);
const HOUR_MS = 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;
const STATE_KEYS = [
  'version',
  'requestUniqueId',
  'fingerprint',
  'recordId',
  'reasonMarker',
  'disposition',
];
const STATE_DISPOSITIONS = new Set([
  'prepared',
  'confirmed',
  'definitely-not-written',
  'unknown-result',
]);
const SCRIPT_MUTATION_ID_PATTERN =
  /^overtime-request-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCRIPT_REASON_MARKER_PATTERN = /^Codex真实验证-加班-\d{13}-[0-9a-f]{8}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const BASE_RECORD_ID_PATTERN = /^rec[A-Za-z0-9_-]+$/;
const CSRF_COOKIE_NAME = 'suda-csrf-token';
const CSRF_HEADER_NAME = 'x-suda-csrf-token';
const CSRF_TOKEN_PATTERNS = [/^[A-Za-z0-9_-]{43}$/, /^[a-f0-9]{40}-\d{10}$/];
const IMAGE_MIME_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);
const OVERTIME_SELF_TEST_PHASES = new Set([
  'prime',
  'fetch-local',
  'fetch-eligible',
  'select-candidate',
  'state-persist',
  'submit-first',
  'verify-first',
  'replay',
  'tamper',
  'cleanup',
]);
const overtimeSelfTestErrorPhases = new WeakMap();
const BASE_FIELD_NAMES = [
  '加班人员',
  '加班人员姓名',
  '加班开始时间',
  '加班结束时间',
  '加班时长',
  '加班举证',
  '加班原因',
  '加班审批（示例人员001）',
  '加班审批（经理）',
  '请求唯一ID',
  '请求指纹',
];

export class UnsafeOvertimeCleanupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeOvertimeCleanupError';
  }
}

async function runInOvertimeSelfTestPhase(phase, operation) {
  if (!OVERTIME_SELF_TEST_PHASES.has(phase)) {
    throw new TypeError('加班真实自测阶段无效');
  }
  try {
    return await operation();
  } catch (error) {
    const phaseError = isWeakMapKey(error)
      ? error
      : new Error('加班真实自测阶段失败');
    overtimeSelfTestErrorPhases.set(phaseError, phase);
    throw phaseError;
  }
}

function findOvertimeSelfTestErrorPhase(error) {
  if (!isWeakMapKey(error)) return null;
  const directPhase = overtimeSelfTestErrorPhases.get(error);
  if (OVERTIME_SELF_TEST_PHASES.has(directPhase)) return directPhase;
  if (error instanceof AggregateError) {
    for (const nestedError of error.errors) {
      const nestedPhase = findOvertimeSelfTestErrorPhase(nestedError);
      if (nestedPhase) return nestedPhase;
    }
  }
  return null;
}

export function selectOvertimeCandidate({
  people,
  schedules,
  eligibleStaffKeys,
  now,
  calculateImpact,
}) {
  if (!Array.isArray(people) || !Array.isArray(schedules)) {
    throw new Error('本地人员或排班数据格式无效');
  }
  if (typeof calculateImpact !== 'function') {
    throw new Error('加班工时计算器不可用');
  }

  const scheduledNames = new Set(
    schedules
      .flatMap((schedule) => splitStaffNames(schedule?.dutyStaffActual))
      .map(normalizeName)
      .filter(Boolean),
  );
  const eligibleNames = Array.isArray(eligibleStaffKeys)
    ? new Set(eligibleStaffKeys.map(normalizeName).filter(Boolean))
    : null;
  const staffShiftByName = new Map();
  people.forEach((person) => {
    const key = normalizeName(person?.supervisorText);
    const shift = clean(person?.shift);
    if (key && shift && !staffShiftByName.has(key)) {
      staffShiftByName.set(key, shift);
    }
  });
  const staffNames = [
    ...new Map(
      people
            .map((person) => clean(person?.supervisorText))
            .filter((name) => scheduledNames.has(normalizeName(name)))
            .filter(
              (name) => !eligibleNames || eligibleNames.has(normalizeName(name)),
            )
        .map((name) => [normalizeName(name), name]),
    ).values(),
  ].sort((left, right) => left.localeCompare(right, 'zh-CN'));
  if (staffNames.length === 0) {
    throw new Error('本地缓存中没有同时具备人员资料和真实排班的人员');
  }

  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) {
    throw new Error('自测当前时间无效');
  }
  const firstStartMs =
    Math.floor(nowDate.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS;
  const currentMonth = shanghaiMonthKey(nowDate.getTime());
  const monthEndMs = Date.parse(`${currentMonth}-01T00:00:00+08:00`);
  const nextMonthMs = addShanghaiMonths(monthEndMs, 1);

  for (const staffName of staffNames) {
    for (
      let startMs = firstStartMs;
      startMs + HOUR_MS <= nextMonthMs;
      startMs += HOUR_MS
    ) {
      if (shanghaiMonthKey(startMs) !== currentMonth) break;
      const startAt = formatShanghaiIso(startMs);
      const endAt = formatShanghaiIso(startMs + HOUR_MS);
      const impact = calculateImpact(schedules, {
        staffName,
        startAt,
        endAt,
        staffShift: staffShiftByName.get(normalizeName(staffName)) || null,
      });
      if (
        impact?.canSubmit === true &&
        impact?.isWholeHour === true &&
        impact?.invalidRangeReason === null &&
        impact?.payableHours >= 1 &&
        Array.isArray(impact?.conflictingSchedules) &&
        impact.conflictingSchedules.length === 0
      ) {
        return { staffName, startAt, endAt, impact };
      }
    }
  }
  throw new Error('当月今天以后没有可用于加班真实自测的无冲突整点时段');
}

export function extractEligibleOvertimeStaffKeys(records) {
  if (!Array.isArray(records)) return [];
  const matchingRecordIndexes = new Map();
  const candidates = records.map((record, index) => {
    const fields = asFields(record);
    const userField = pickRecordField(fields, ['员工姓名', '人员']);
    const firstUser = Array.isArray(userField) ? userField[0] : null;
    const userName = isObject(firstUser) ? clean(firstUser.name) : '';
    const displayName =
      fieldText(
        pickRecordField(fields, ['姓名', '员工姓名', '人员', '人员（文本）']),
      ) || userName;
    const displayKey = normalizeName(displayName);
    const userKey = normalizeName(userName);
    for (const key of new Set([displayKey, userKey].filter(Boolean))) {
      const indexes = matchingRecordIndexes.get(key) || new Set();
      indexes.add(index);
      matchingRecordIndexes.set(key, indexes);
    }
    const userId =
      isObject(firstUser) && 'id' in firstUser ? clean(firstUser.id) : '';
    return {
      displayKey,
      userKey,
      valid:
        Array.isArray(userField) &&
        userField.length === 1 &&
        Boolean(userId) &&
        Boolean(displayKey) &&
        (!userKey || userKey === displayKey),
    };
  });

  return [
    ...new Set(
      candidates
        .filter(
          (candidate) =>
            candidate.valid &&
            matchingRecordIndexes.get(candidate.displayKey)?.size === 1,
        )
        .map((candidate) => candidate.displayKey),
    ),
  ].sort();
}

export function computeOvertimeRequestFingerprint(
  request,
  screenshot,
  impactComparisonKey,
) {
  const payload = {
    staffName: normalizeWhitespace(request?.staffName),
    startAt: clean(request?.startAt),
    endAt: clean(request?.endAt),
    reason: normalizeWhitespace(request?.reason),
    expectedImpact: impactComparisonKey,
  };
  const hash = createHash('sha256').update(JSON.stringify(payload));
  hash.update('\0');
  hash.update(clean(screenshot?.filename));
  hash.update('\0');
  hash.update(clean(screenshot?.mimeType));
  hash.update('\0');
  hash.update(String(Number(screenshot?.size) || 0));
  hash.update('\0');
  hash.update(
    Buffer.isBuffer(screenshot?.buffer) ? screenshot.buffer : Buffer.alloc(0),
  );
  return hash.digest('hex');
}

export function classifyOvertimeRequestError(error) {
  const response = isObject(error?.response) ? error.response : null;
  const data = isObject(response?.data) ? response.data : null;
  const disposition =
    clean(data?.writeDisposition) || clean(error?.writeDisposition);
  if (disposition === 'definitely-not-written') {
    return 'definitely-not-written';
  }
  if (disposition === 'unknown-result') return 'unknown-result';

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

export async function runOvertimeRequestSelfTest(options, dependencies) {
  const screenshot = validateScreenshotDescriptor(options?.screenshot);
  const now = dependencies.now?.() ?? new Date();
  const randomUUID = dependencies.randomUUID?.() ?? createRandomUUID();
  const clientMutationId = `overtime-request-${randomUUID}`;
  const reasonMarker = `Codex真实验证-加班-${now.getTime()}-${String(randomUUID).slice(0, 8).toLowerCase()}`;
  let state = null;
  let operationError = null;
  let cleanupError = null;
  let cleanupResult = null;
  let result = null;

  try {
    await runInOvertimeSelfTestPhase('prime', () =>
      dependencies.primeLocalApi?.(),
    );
    const [people, schedules, eligibleStaffKeys] = await Promise.all([
      runInOvertimeSelfTestPhase('fetch-local', () =>
        dependencies.fetchLocalPeople(),
      ),
      runInOvertimeSelfTestPhase('fetch-local', () =>
        dependencies.fetchLocalSchedules(now),
      ),
      typeof dependencies.fetchEligibleStaffKeys === 'function'
        ? runInOvertimeSelfTestPhase('fetch-eligible', () =>
            dependencies.fetchEligibleStaffKeys(),
          )
        : Promise.resolve(undefined),
    ]);
    const candidateDetails = await runInOvertimeSelfTestPhase(
      'select-candidate',
      () => {
        const candidate = selectOvertimeCandidate({
          people,
          schedules,
          eligibleStaffKeys,
          now,
          calculateImpact: dependencies.calculateImpact,
        });
        const impactComparisonKey = dependencies.impactComparisonKey(
          candidate.impact,
        );
        if (!impactComparisonKey) {
          throw new Error('计算出的加班排班影响无效');
        }
        const request = {
          clientMutationId,
          staffName: candidate.staffName,
          startAt: candidate.startAt,
          endAt: candidate.endAt,
          reason: reasonMarker,
          expectedImpact: candidate.impact,
        };
        const requestFingerprint = computeOvertimeRequestFingerprint(
          request,
          screenshot,
          impactComparisonKey,
        );
        const verification = {
          staffName: candidate.staffName,
          startAt: candidate.startAt,
          endAt: candidate.endAt,
          payableHours: candidate.impact.payableHours,
        };
        return {
          candidate,
          impactComparisonKey,
          request,
          requestFingerprint,
          verification,
        };
      },
    );
    const {
      candidate,
      impactComparisonKey,
      request,
      requestFingerprint,
      verification,
    } = candidateDetails;
    state = await runInOvertimeSelfTestPhase('state-persist', () =>
      validateState({
        version: 1,
        requestUniqueId: clientMutationId,
        fingerprint: requestFingerprint,
        recordId: '',
        reasonMarker,
        disposition: 'prepared',
      }),
    );
    await runInOvertimeSelfTestPhase('state-persist', () =>
      dependencies.writeState(state),
    );

    const firstResponse = await runInOvertimeSelfTestPhase(
      'submit-first',
      async () => {
        const response = await dependencies.postOvertimeRequest(
          request,
          screenshot,
        );
        assertSubmissionResponse({
          response,
          request,
          expectedCreated: 1,
          requestFingerprint,
          impactComparisonKey,
          compareImpact: dependencies.impactComparisonKey,
        });
        return response;
      },
    );
    state = await runInOvertimeSelfTestPhase('state-persist', () =>
      validateState({
        ...state,
        recordId: firstResponse.recordId,
        disposition: 'confirmed',
      }),
    );
    await runInOvertimeSelfTestPhase('state-persist', () =>
      dependencies.writeState(state),
    );

    await runInOvertimeSelfTestPhase('verify-first', () =>
      verifyPersistedOvertimeRecord(state, verification, dependencies),
    );

    const replayResponse = await runInOvertimeSelfTestPhase(
      'replay',
      async () => {
        const response = await dependencies.postOvertimeRequest(
          request,
          screenshot,
        );
        assertSubmissionResponse({
          response,
          request,
          expectedCreated: 0,
          requestFingerprint,
          impactComparisonKey,
          compareImpact: dependencies.impactComparisonKey,
        });
        if (response.recordId !== firstResponse.recordId) {
          throw new Error('幂等重放返回了不同的 Base recordId');
        }
        return response;
      },
    );

    const tamperedRequest = {
      ...request,
      reason: `${request.reason}-篡改`,
    };
    const tamperConflictVerified = await runInOvertimeSelfTestPhase(
      'tamper',
      async () => {
        try {
          await dependencies.postOvertimeRequest(tamperedRequest, screenshot);
        } catch (error) {
          const status = Number(error?.response?.status ?? error?.status);
          const disposition = clean(
            error?.response?.data?.writeDisposition ?? error?.writeDisposition,
          );
          if (status === 409 && disposition === 'definitely-not-written') {
            return true;
          }
          throw error;
        }
        throw new Error('同一请求 ID 的篡改内容未被 409 拒绝');
      },
    );

    result = {
      ok: true,
      created: firstResponse.created,
      replayCreated: replayResponse.created,
      tamperConflictVerified,
      requestRef: createSafeRef(clientMutationId),
      recordRef: createSafeRef(firstResponse.recordId),
    };
  } catch (error) {
    operationError = error;
    if (state) {
      const disposition = classifyOvertimeRequestError(error);
      state = validateState({
        ...state,
        disposition,
      });
      try {
        await runInOvertimeSelfTestPhase('state-persist', () =>
          dependencies.writeState(state),
        );
      } catch (stateError) {
        operationError = new AggregateError(
          [error, stateError],
          '加班真实自测失败，写入恢复状态也失败',
        );
      }
    }
  } finally {
    if (state) {
      try {
        cleanupResult = await runInOvertimeSelfTestPhase('cleanup', () =>
          cleanupOvertimeRequestState(state, dependencies),
        );
      } catch (error) {
        cleanupError = error;
      }
    }
  }

  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      '加班真实自测失败，自动清理也未能安全完成',
    );
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return {
    ...result,
    cleaned: cleanupResult?.deleted === true,
    residualCount: cleanupResult?.residualCount ?? 0,
  };
}

export async function verifyPersistedOvertimeRecord(
  state,
  verification,
  dependencies,
) {
  const records = await queryUniqueRecordsWithRetry(
    state.requestUniqueId,
    dependencies,
  );
  if (records.length !== 1) {
    throw new Error(`按请求唯一ID回查必须恰好 1 条，实际 ${records.length} 条`);
  }
  const record = records[0];
  assertCleanupIdentity(state, record, false);
  assertFullOvertimeRecord(verification, record);
  return record;
}

export async function cleanupOvertimeRequestState(stateInput, dependencies) {
  let state = validateState(stateInput);
  const records = await queryUniqueRecordsWithRetry(
    state.requestUniqueId,
    dependencies,
  );
  if (records.length === 0) {
    if (state.disposition === 'unknown-result') {
      throw new UnsafeOvertimeCleanupError(
        '写入结果未知且尚未回查到记录，无法证明不存在延迟写入；已保留状态文件',
      );
    }
    await dependencies.removeState();
    return { deleted: false, residualCount: 0, alreadyClean: true };
  }
  if (records.length !== 1) {
    throw new UnsafeOvertimeCleanupError(
      `请求唯一ID命中 ${records.length} 条记录，拒绝删除并保留状态文件`,
    );
  }

  const candidate = records[0];
  const candidateRecordId = assertCleanupIdentity(
    state,
    candidate,
    !state.recordId,
  );
  if (!state.recordId) {
    state = validateState({
      ...state,
      recordId: candidateRecordId,
    });
    await dependencies.writeState(state);
  }

  const recordId = state.recordId;
  const exactRecord = await dependencies.getBaseRecordById(recordId);
  assertCleanupIdentity(state, exactRecord, false);
  await dependencies.deleteBaseRecordById(recordId);

  const residual = await dependencies.queryBaseByUniqueId(
    state.requestUniqueId,
  );
  if (!Array.isArray(residual) || residual.length !== 0) {
    throw new UnsafeOvertimeCleanupError(
      `精确删除后请求唯一ID仍残留 ${Array.isArray(residual) ? residual.length : '未知'} 条记录；已保留状态文件`,
    );
  }
  await dependencies.removeState();
  return {
    deleted: true,
    residualCount: 0,
    recordRef: createSafeRef(recordId),
  };
}

export function assertCleanupIdentity(
  state,
  record,
  allowRecordIdAdoption = false,
) {
  const recordId = getRecordId(record);
  if (!recordId) {
    throw new UnsafeOvertimeCleanupError('记录缺少 recordId，拒绝删除');
  }
  if (!BASE_RECORD_ID_PATTERN.test(recordId)) {
    throw new UnsafeOvertimeCleanupError('recordId 格式无效，拒绝删除');
  }
  if (!allowRecordIdAdoption && recordId !== state.recordId) {
    throw new UnsafeOvertimeCleanupError('recordId 不一致，拒绝删除');
  }
  const fields = asFields(record);
  if (fieldText(fields['请求唯一ID']) !== state.requestUniqueId) {
    throw new UnsafeOvertimeCleanupError('请求唯一ID 不一致，拒绝删除');
  }
  if (fieldText(fields['加班原因']) !== state.reasonMarker) {
    throw new UnsafeOvertimeCleanupError('加班原因 marker 不一致，拒绝删除');
  }
  if (fieldText(fields['请求指纹']) !== state.fingerprint) {
    throw new UnsafeOvertimeCleanupError('请求指纹不一致，拒绝删除');
  }
  return recordId;
}

function assertFullOvertimeRecord(verification, record) {
  const fields = asFields(record);
  if (fieldText(fields['加班人员姓名']) !== verification.staffName) {
    throw new Error('Base 加班人员姓名与提交请求不一致');
  }
  const userValues = displayValues(fields['加班人员']);
  if (userValues.length === 0 || !userValues.includes(verification.staffName)) {
    throw new Error('Base 加班人员用户字段未正确回填');
  }
  if (
    fieldEpochMs(fields['加班开始时间']) !== Date.parse(verification.startAt)
  ) {
    throw new Error('Base 加班开始时间与提交请求不一致');
  }
  if (fieldEpochMs(fields['加班结束时间']) !== Date.parse(verification.endAt)) {
    throw new Error('Base 加班结束时间与提交请求不一致');
  }
  const hours = Number(fieldText(fields['加班时长']));
  if (!Number.isFinite(hours) || hours !== verification.payableHours) {
    throw new Error('Base 加班时长与计算结果不一致');
  }
  if (!hasAttachment(fields['加班举证'])) {
    throw new Error('Base 加班举证附件为空');
  }
  for (const fieldName of ['加班审批（示例人员001）', '加班审批（经理）']) {
    if (fieldText(fields[fieldName]).replace(/\s+/g, '') === '同意') {
      throw new Error(`${fieldName}不得由真实自测写为同意`);
    }
  }
}

function assertSubmissionResponse({
  response,
  request,
  expectedCreated,
  requestFingerprint,
  impactComparisonKey,
  compareImpact,
}) {
  if (
    response?.success !== true ||
    response?.created !== expectedCreated ||
    !BASE_RECORD_ID_PATTERN.test(clean(response?.recordId)) ||
    response?.clientMutationId !== request.clientMutationId ||
    response?.requestFingerprint !== requestFingerprint ||
    compareImpact(response?.impact) !== impactComparisonKey
  ) {
    throw new Error(
      expectedCreated === 1
        ? '首次加班提交响应校验失败'
        : '加班幂等重放响应校验失败',
    );
  }
}

async function queryUniqueRecordsWithRetry(clientMutationId, dependencies) {
  const attempts = typeof dependencies.waitBeforeRecheck === 'function' ? 5 : 1;
  let records = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    records = await dependencies.queryBaseByUniqueId(clientMutationId);
    if (!Array.isArray(records)) {
      throw new Error('Base 唯一ID回查结果格式无效');
    }
    if (records.length > 0 || attempt === attempts - 1) return records;
    await dependencies.waitBeforeRecheck(500 * (attempt + 1));
  }
  return records;
}

function validateScreenshotDescriptor(screenshot) {
  if (
    !isObject(screenshot) ||
    !Buffer.isBuffer(screenshot.buffer) ||
    !clean(screenshot.filename) ||
    !clean(screenshot.mimeType) ||
    Number(screenshot.size) !== screenshot.buffer.length ||
    screenshot.buffer.length === 0 ||
    screenshot.buffer.length > 10 * 1024 * 1024
  ) {
    throw new Error('加班举证截图无效');
  }
  return screenshot;
}

function validateState(value) {
  const requestUniqueId = clean(value?.requestUniqueId);
  const fingerprint = clean(value?.fingerprint);
  const recordId = clean(value?.recordId);
  const reasonMarker = clean(value?.reasonMarker);
  const disposition = clean(value?.disposition);
  const hasExactKeys =
    isObject(value) &&
    Object.keys(value).sort().join('\0') === [...STATE_KEYS].sort().join('\0');
  if (
    !hasExactKeys ||
    value.version !== 1 ||
    value.requestUniqueId !== requestUniqueId ||
    !SCRIPT_MUTATION_ID_PATTERN.test(requestUniqueId) ||
    value.fingerprint !== fingerprint ||
    !FINGERPRINT_PATTERN.test(fingerprint) ||
    value.reasonMarker !== reasonMarker ||
    !SCRIPT_REASON_MARKER_PATTERN.test(reasonMarker) ||
    value.recordId !== recordId ||
    (recordId !== '' && !BASE_RECORD_ID_PATTERN.test(recordId)) ||
    value.disposition !== disposition ||
    !STATE_DISPOSITIONS.has(disposition)
  ) {
    throw new UnsafeOvertimeCleanupError('状态文件格式无效，拒绝清理');
  }
  return {
    version: 1,
    requestUniqueId,
    fingerprint,
    recordId,
    reasonMarker,
    disposition,
  };
}

export function createLoopbackApiSession({ baseUrl, client }) {
  const origin = loopbackOrigin(baseUrl);
  const clientType = typeof client;
  if (
    !client ||
    (clientType !== 'object' && clientType !== 'function') ||
    typeof client.get !== 'function' ||
    typeof client.post !== 'function'
  ) {
    throw new TypeError('本地 API 客户端无效');
  }

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
      primed = true;
      return { csrfEnabled: csrfToken !== '' };
    },
    get: async (path, config = {}) => {
      assertSameLoopbackPath(origin, path);
      return client.get(path, config);
    },
    post: async (path, data, config = {}) => {
      assertSameLoopbackPath(origin, path);
      if (!primed) {
        throw new TypeError('本地 API 会话尚未安全初始化');
      }
      const suppliedHeaders = isObject(config.headers) ? config.headers : {};
      assertNoReservedCsrfHeaders(suppliedHeaders);
      const headers = { ...suppliedHeaders };
      if (csrfToken) {
        headers.Cookie = `${CSRF_COOKIE_NAME}=${csrfToken}`;
        headers[CSRF_HEADER_NAME] = csrfToken;
      }
      return client.post(path, data, { ...config, headers });
    },
  };
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
  const resolved = new URL(path, `${origin}/`);
  if (resolved.origin !== origin) {
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
      if (separator < 0) return null;
      return {
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

function assertNoReservedCsrfHeaders(headers) {
  const reserved = new Set(['cookie', CSRF_HEADER_NAME]);
  if (Object.keys(headers).some((name) => reserved.has(name.toLowerCase()))) {
    throw new TypeError('CSRF 请求头由本地 API 会话统一管理');
  }
}

async function createRealDependencies({ baseUrl, statePath }) {
  await import('../dist/server/runtime-env.js');
  const impactModule =
    await import('../dist/shared/overtime-request-impact.js');
  const configModule =
    await import('../dist/server/common/config/external-services.config.js');
  const bitableModule =
    await import('../dist/server/common/feishu/bitable-direct-read.js');
  const personProfileModule =
    await import('../dist/server/modules/bitable-sync/person-profile-source.js');
  const workflowModule =
    await import('../dist/server/modules/inventory-management/inventory-workflow.gateway.js');
  const httpService = { axiosRef: axios };
  const sourceUrl = configModule.readEnv('FEISHU_LEAVE_SUBSTITUTE_SOURCE_URL', [
    'FEISHU_LEAVE_REQUEST_SOURCE_URL',
  ]) || DEFAULT_OVERTIME_SOURCE_URL;
  const parsedSource = configModule.parseFeishuBitableLink(sourceUrl);
  const configuredTableId =
    configModule.readEnv('FEISHU_LEAVE_SUBSTITUTE_TABLE_ID', [
      'FEISHU_LEAVE_REQUEST_TABLE_ID',
    ]) || parsedSource.tableId;
  if (configuredTableId !== OVERTIME_TABLE_ID) {
    throw new Error('加班真实自测 Base 表配置与固定目标表不一致');
  }
  const appToken = await bitableModule.resolveBitableAppToken(httpService, {
    appToken:
      configModule.readEnv('FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN', [
        'FEISHU_LEAVE_REQUEST_APP_TOKEN',
      ]) || parsedSource.appToken,
    wikiToken:
      configModule.readEnv('FEISHU_LEAVE_SUBSTITUTE_WIKI_TOKEN', [
        'FEISHU_LEAVE_REQUEST_WIKI_TOKEN',
      ]) || parsedSource.wikiToken,
    tableName: '请休假与加班申请',
  });
  const personProfileSourceUrl =
    configModule.readEnv('FEISHU_LEAVE_PERSON_PROFILE_SOURCE_URL') ||
    `https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE`;
  const parsedPersonProfileSource =
    configModule.parseFeishuBitableLink(personProfileSourceUrl);
  const personProfileTableId =
    configModule.readEnv('FEISHU_LEAVE_PERSON_PROFILE_TABLE_ID') ||
    parsedPersonProfileSource.tableId ||
    personProfileModule.DEFAULT_LEAVE_PERSON_PROFILE_TABLE_ID;
  const personProfilePlan = personProfileModule.resolvePersonProfileReadPlan(
    'leave',
    { leaveTableId: personProfileTableId },
  );
  const personProfileAppToken = await bitableModule.resolveBitableAppToken(
    httpService,
    {
      appToken:
        configModule.readEnv('FEISHU_LEAVE_PERSON_PROFILE_APP_TOKEN', [
          'FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN',
          'FEISHU_LEAVE_REQUEST_APP_TOKEN',
        ]) || parsedPersonProfileSource.appToken,
      wikiToken:
        configModule.readEnv('FEISHU_LEAVE_PERSON_PROFILE_WIKI_TOKEN', [
          'FEISHU_LEAVE_SUBSTITUTE_WIKI_TOKEN',
          'FEISHU_LEAVE_REQUEST_WIKI_TOKEN',
        ]) || parsedPersonProfileSource.wikiToken,
      tableName: personProfilePlan.tableName,
    },
  );
  const gateway = new workflowModule.InventoryWorkflowGateway(httpService);
  const localClient = axios.create(localAxiosConfig(baseUrl));
  const localApi = createLoopbackApiSession({ baseUrl, client: localClient });

  return {
    now: () => new Date(),
    randomUUID: () => createRandomUUID(),
    calculateImpact: impactModule.calculateOvertimeRequestImpact,
    impactComparisonKey: impactModule.createOvertimeRequestImpactComparisonKey,
    primeLocalApi: () => localApi.prime(),
    fetchLocalPeople: async () => {
      const response = await localApi.get(
        '/api/bitable/person-profiles?scope=leave',
      );
      const organizations = response.data?.organizations;
      if (!Array.isArray(organizations)) {
        throw new Error('本地人员接口响应格式无效');
      }
      return organizations;
    },
    fetchLocalSchedules: async (now) => {
      const month = shanghaiMonthKey(now.getTime());
      const [year, monthNumber] = month.split('-');
      const response = await localApi.get(
        `/api/monthly-schedules/${year}/${Number(monthNumber)}`,
      );
      const schedules = response.data?.schedules;
      if (!Array.isArray(schedules)) {
        throw new Error('本地排班接口响应格式无效');
      }
      return schedules;
    },
    fetchEligibleStaffKeys: async () => {
      const records = await bitableModule.fetchBitableRecords(httpService, {
        appToken: personProfileAppToken,
        tableId: personProfilePlan.tableId,
        viewId: personProfilePlan.viewId,
        fieldNames: personProfilePlan.fieldNames,
        tableName: personProfilePlan.tableName,
        cacheTtlMs: 0,
        forceRefresh: true,
        allowStale: false,
        strict: true,
      });
      return extractEligibleOvertimeStaffKeys(records);
    },
    postOvertimeRequest: async (request, screenshot) => {
      const form = new FormData();
      form.append('payload', JSON.stringify(request));
      form.append('screenshot', screenshot.buffer, {
        filename: screenshot.filename,
        contentType: screenshot.mimeType,
        knownLength: screenshot.size,
      });
      const response = await localApi.post(
        '/api/duty-schedules/overtime-request',
        form,
        {
          headers: form.getHeaders(),
          maxBodyLength: 11 * 1024 * 1024,
          maxContentLength: 11 * 1024 * 1024,
          timeout: 120_000,
        },
      );
      return response.data;
    },
    queryBaseByUniqueId: async (clientMutationId) =>
      bitableModule.fetchBitableRecords(httpService, {
        appToken,
        tableId: OVERTIME_TABLE_ID,
        tableName: '请休假与加班申请',
        fieldNames: BASE_FIELD_NAMES,
        filter: {
          conjunction: 'and',
          conditions: [
            {
              field_name: '请求唯一ID',
              operator: 'is',
              value: [clientMutationId],
            },
          ],
        },
        cacheTtlMs: 0,
        forceRefresh: true,
        allowStale: false,
        strict: true,
      }),
    getBaseRecordById: (recordId) =>
      gateway.getRecord(
        appToken,
        OVERTIME_TABLE_ID,
        recordId,
        '请休假与加班申请',
      ),
    deleteBaseRecordById: (recordId) =>
      gateway.deleteRecord(
        appToken,
        OVERTIME_TABLE_ID,
        recordId,
        '请休假与加班申请',
      ),
    writeState: (state) => atomicWriteJson(statePath, state),
    removeState: () => unlinkIfExists(statePath),
    waitBeforeRecheck: delay,
  };
}

async function main(setStage = () => undefined) {
  setStage('arguments');
  const { command, baseUrl, screenshotPath, statePath } = parseArguments(
    process.argv.slice(2),
  );
  if (command === 'cleanup-only') {
    setStage('state');
    const state = await readJsonState(statePath, true);
    setStage('dependencies');
    const dependencies = await createRealDependencies({ baseUrl, statePath });
    setStage('cleanup');
    const result = await cleanupOvertimeRequestState(state, dependencies);
    printSafe({
      ok: true,
      mode: 'cleanup-only',
      deleted: result.deleted,
      residualCount: result.residualCount,
      recordRef: result.recordRef || null,
    });
    return;
  }

  setStage('state');
  const existingState = await readJsonState(statePath, false);
  if (existingState) {
    throw new Error(
      `存在未清理的加班真实自测状态，请先运行 cleanup-only --state ${statePath}`,
    );
  }
  setStage('screenshot');
  const screenshot = await loadScreenshot(screenshotPath);
  setStage('dependencies');
  const dependencies = await createRealDependencies({ baseUrl, statePath });
  setStage('execute');
  const result = await runOvertimeRequestSelfTest({ screenshot }, dependencies);
  printSafe(result);
}

function parseArguments(args) {
  const command = args[0] && !args[0].startsWith('--') ? args[0] : 'run';
  if (!['run', 'cleanup-only'].includes(command)) {
    throw new Error('命令必须是 run 或 cleanup-only');
  }
  const baseUrl = clean(
    optionValue(args, '--base-url') || DEFAULT_BASE_URL,
  ).replace(/\/+$/, '');
  const statePath = resolve(optionValue(args, '--state') || DEFAULT_STATE_PATH);
  const screenshotPath = clean(optionValue(args, '--screenshot'));
  if (command === 'run') {
    if (!screenshotPath) {
      throw new Error('run 模式必须传 --screenshot <绝对图片路径>');
    }
    if (!isAbsolute(screenshotPath)) {
      throw new Error('--screenshot 必须是绝对路径');
    }
  }
  return { command, baseUrl, screenshotPath, statePath };
}

async function loadScreenshot(path) {
  if (!isAbsolute(path)) throw new Error('--screenshot 必须是绝对路径');
  const extension = extname(path).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES.get(extension);
  if (!mimeType) throw new Error('截图仅支持 PNG、JPG、JPEG、WebP');
  const buffer = await readFile(path);
  if (buffer.length === 0 || buffer.length > 10 * 1024 * 1024) {
    throw new Error('截图必须大于 0 且不超过 10MB');
  }
  return {
    absolutePath: path,
    filename: basename(path),
    mimeType,
    size: buffer.length,
    buffer,
  };
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
  if (url.protocol === 'https:' && isLoopbackHost(url.hostname)) {
    return {
      ...config,
      httpsAgent: new HttpsAgent({ rejectUnauthorized: false }),
    };
  }
  return config;
}

function isLoopbackHost(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  );
}

function splitStaffNames(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => clean(item).split(/[\s,，、;；/]+/))
    .map(clean)
    .filter(Boolean);
}

function normalizeName(value) {
  return clean(value).replace(/\s+/g, '').toLocaleLowerCase('zh-CN');
}

function normalizeWhitespace(value) {
  return clean(value).replace(/\s+/g, ' ');
}

function addShanghaiMonths(epochMs, months) {
  const wallClock = new Date(epochMs + SHANGHAI_OFFSET_MS);
  return (
    Date.UTC(wallClock.getUTCFullYear(), wallClock.getUTCMonth() + months, 1) -
    SHANGHAI_OFFSET_MS
  );
}

function shanghaiMonthKey(epochMs) {
  return new Date(epochMs + SHANGHAI_OFFSET_MS).toISOString().slice(0, 7);
}

function formatShanghaiIso(epochMs) {
  return `${new Date(epochMs + SHANGHAI_OFFSET_MS)
    .toISOString()
    .slice(0, 19)}+08:00`;
}

function asFields(record) {
  return isObject(record?.fields) ? record.fields : {};
}

function pickRecordField(fields, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(fields, name)) return fields[name];
  }
  return undefined;
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

function fieldEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
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

function hasAttachment(value) {
  return (
    Array.isArray(value) &&
    value.some(
      (item) =>
        isObject(item) &&
        Boolean(clean(item.file_token || item.fileToken || item.url)),
    )
  );
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await unlinkIfExists(temporaryPath);
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

async function readJsonState(path, required) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) return null;
    if (error?.code === 'ENOENT') {
      throw new Error(`状态文件不存在：${path}`);
    }
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

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || '' : '';
}

function createSafeRef(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

export function buildSafeCliError(error, stage = 'execute') {
  const allowedStages = new Set([
    'startup',
    'arguments',
    'state',
    'screenshot',
    'dependencies',
    'execute',
    'cleanup',
  ]);
  const safeStage = allowedStages.has(stage) ? stage : 'execute';
  let code = 'SELF_TEST_FAILED';
  if (error instanceof UnsafeOvertimeCleanupError) {
    code = 'UNSAFE_CLEANUP';
  } else if (error instanceof AggregateError) {
    code = 'SELF_TEST_AND_CLEANUP_FAILED';
  } else if (safeStage === 'cleanup') {
    code = 'CLEANUP_FAILED';
  }
  const errorName = error instanceof Error ? error.name : typeof error;
  const errorMessage = error instanceof Error ? error.message : String(error);
  const result = {
    stage: safeStage,
    code,
    safeRef: createSafeRef(`${errorName}\0${errorMessage}`),
  };
  const phase = findOvertimeSelfTestErrorPhase(error);
  return phase ? { ...result, phase } : result;
}

function printSafe(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWeakMapKey(value) {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  );
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
