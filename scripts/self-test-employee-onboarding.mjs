import axios from 'axios';
import FormData from 'form-data';
import { createHash, randomUUID as createRandomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { Agent as HttpsAgent } from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'https://127.0.0.1:3001';
const DEFAULT_STATE_PATH = resolve(
  process.cwd(),
  'output/diagnostics/employee-onboarding-real-self-test-state.json',
);
const CSRF_COOKIE_NAME = 'suda-csrf-token';
const CSRF_HEADER_NAME = 'x-suda-csrf-token';
const CSRF_TOKEN_PATTERNS = [/^[A-Za-z0-9_-]{43}$/u, /^[a-f0-9]{40}-\d{10}$/u];
const MUTATION_ID_PATTERN =
  /^employee-onboarding-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RECORD_ID_PATTERN = /^rec[A-Za-z0-9_-]+$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const FILE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{6,256}$/u;
const SYNTHETIC_NAME_PATTERN = /^CODEX-SELFTEST-EMPLOYEE-\d{13}-[0-9a-f]{8}$/u;
const STATE_KEYS = [
  'version',
  'mutationId',
  'nameHash',
  'recordId',
  'stage',
  'createdAt',
  'updatedAt',
];
const STATE_STAGES = new Set([
  'prepared',
  'submitting',
  'confirmed',
  'cleanup-pending',
  'cleanup-confirmed',
]);
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const PNG_FIXTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const BANK_SOURCE_SHA256 = JSON.parse(readFileSync(resolve(process.cwd(), 'shared/mbti-attached-bank.json'), 'utf8')).sourceSha256;

export class UnsafeEmployeeOnboardingCleanupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeEmployeeOnboardingCleanupError';
  }
}

export function createEmployeeOnboardingFixture({
  now = new Date(),
  randomUUID = createRandomUUID,
} = {}) {
  const timestamp = requireDate(now).getTime();
  const uuid = clean(randomUUID());
  if (!UUID_V4_PATTERN.test(uuid)) {
    throw new TypeError('新员工入职真实自测 UUID 无效');
  }

  const name = `CODEX-SELFTEST-EMPLOYEE-${timestamp}-${uuid.slice(0, 8).toLowerCase()}`;
  const photoBuffer = Buffer.from(PNG_FIXTURE);
  const request = Object.freeze({
    clientMutationId: `employee-onboarding-${uuid.toLowerCase()}`,
    name,
    companyName: '南通承宏云计算有限公司',
    position: '运维实习生',
    identityNumber: '110101199001010015',
    phone: '19900001234',
    entryDate: shanghaiDateKey(timestamp),
    education: '本科',
    graduateSchool: 'CODEX自动化测试院校',
    major: '自动化测试',
    graduationDate: '2026-06-30',
    hobbies: Object.freeze(['阅读', '跑步']),
    vehiclePlate: '苏FTEST1',
    mbtiAssessment: Object.freeze({ participantName: name, version: 'full', answers: Object.freeze(Array(93).fill('A')), sourceSha256: BANK_SOURCE_SHA256 }),
  });
  const photo = Object.freeze({
    buffer: photoBuffer,
    filename: 'employee-self-test-photo.png',
    mimeType: 'image/png',
    size: photoBuffer.length,
  });
  return Object.freeze({
    request,
    nameHash: hashText(name),
    photo,
  });
}

export function expectedEmployeeOnboardingFields(fixture) {
  const request = validateFixture(fixture).request;
  return {
    姓名: request.name,
    用工性质: resolveEmploymentType(request.companyName),
    公司名称: request.companyName,
    岗位: request.position,
    身份证号: request.identityNumber,
    联系方式: request.phone,
    入职日期: toShanghaiDateMilliseconds(request.entryDate),
    学历: request.education,
    毕业院校: request.graduateSchool,
    所学专业: request.major,
    毕业时间: request.graduationDate.replaceAll('-', '/'),
    兴趣爱好: [...request.hobbies],
    车牌号: request.vehiclePlate,
    照片: [{ file_token: 'synthetic-photo-attachment' }],
  };
}

export function assertEmployeeOnboardingRecord(actual, fixture) {
  if (!isObject(actual)) {
    throw new Error('员工信息池精确回读格式无效');
  }
  const expected = expectedEmployeeOnboardingFields(fixture);
  for (const field of [
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
    '车牌号',
  ]) {
    if (!sameStrictValue(actual[field], expected[field])) {
      throw new Error(`员工信息池字段 ${field} 精确回读不一致`);
    }
  }
  readAttachmentProofs(actual.照片, [fixture.photo], '照片');
  return true;
}

export function validateEmployeeOnboardingSelfTestState(value) {
  const hasExactKeys =
    isObject(value) &&
    Object.keys(value).sort().join('\0') === [...STATE_KEYS].sort().join('\0');
  const mutationId = clean(value?.mutationId);
  const nameHash = clean(value?.nameHash);
  const recordId = clean(value?.recordId);
  const stage = clean(value?.stage);
  const createdAt = clean(value?.createdAt);
  const updatedAt = clean(value?.updatedAt);
  const requiresRecordId =
    stage === 'confirmed' ||
    stage === 'cleanup-pending' ||
    stage === 'cleanup-confirmed';

  if (
    !hasExactKeys ||
    value.version !== 1 ||
    value.mutationId !== mutationId ||
    !MUTATION_ID_PATTERN.test(mutationId) ||
    value.nameHash !== nameHash ||
    !HASH_PATTERN.test(nameHash) ||
    value.recordId !== recordId ||
    (recordId !== '' && !RECORD_ID_PATTERN.test(recordId)) ||
    value.stage !== stage ||
    !STATE_STAGES.has(stage) ||
    (requiresRecordId && !recordId) ||
    value.createdAt !== createdAt ||
    !isIsoTimestamp(createdAt) ||
    value.updatedAt !== updatedAt ||
    !isIsoTimestamp(updatedAt) ||
    Date.parse(updatedAt) < Date.parse(createdAt)
  ) {
    throw new UnsafeEmployeeOnboardingCleanupError(
      '新员工入职真实自测状态格式无效，拒绝清理',
    );
  }

  return {
    version: 1,
    mutationId,
    nameHash,
    recordId,
    stage,
    createdAt,
    updatedAt,
  };
}

export async function cleanupEmployeeOnboardingState(stateInput, dependencies) {
  const state = validateEmployeeOnboardingSelfTestState(stateInput);
  assertCleanupDependencies(dependencies);

  if (!state.recordId) {
    if (state.stage !== 'prepared') {
      throw new UnsafeEmployeeOnboardingCleanupError(
        '提交结果可能未知且没有精确 recordId，拒绝猜测清理',
      );
    }
    await dependencies.removeState();
    return { deleted: false, confirmedAbsent: true, alreadyClean: true };
  }

  const exact = await dependencies.readRecordById(state.recordId);
  if (exact === null) {
    if (state.stage !== 'cleanup-confirmed') {
      throw new UnsafeEmployeeOnboardingCleanupError(
        '精确 recordId 首次回读为空且没有已确认的清理状态，已保留恢复状态',
      );
    }
    await dependencies.removeState();
    return { deleted: false, confirmedAbsent: true, alreadyClean: true };
  }
  assertCleanupIdentity(state, exact);

  const cleanupPending = validateEmployeeOnboardingSelfTestState({
    ...state,
    stage: 'cleanup-pending',
    updatedAt: cleanupTimestamp(state, dependencies),
  });
  await dependencies.writeState(cleanupPending);
  await dependencies.deleteRecordById(state.recordId);
  const cleanupConfirmed = validateEmployeeOnboardingSelfTestState({
    ...cleanupPending,
    stage: 'cleanup-confirmed',
    updatedAt: cleanupTimestamp(cleanupPending, dependencies),
  });
  await dependencies.writeState(cleanupConfirmed);

  const residual = await dependencies.readRecordById(state.recordId);
  if (residual !== null) {
    throw new UnsafeEmployeeOnboardingCleanupError(
      '精确删除后 recordId 仍可回读，已保留恢复状态',
    );
  }
  await dependencies.removeState();
  return {
    deleted: true,
    confirmedAbsent: true,
    recordRef: safeRef(state.recordId),
  };
}

export function assertCleanupIdentity(stateInput, fields) {
  const state = validateEmployeeOnboardingSelfTestState(stateInput);
  if (
    !isObject(fields) ||
    hashText(strictText(fields.姓名)) !== state.nameHash
  ) {
    throw new UnsafeEmployeeOnboardingCleanupError(
      '精确 recordId 的测试身份校验失败，拒绝删除',
    );
  }
  return state.recordId;
}

export async function runEmployeeOnboardingSelfTest(dependencies) {
  assertRunDependencies(dependencies);
  const fixture = createEmployeeOnboardingFixture({
    now: dependencies.now(),
    randomUUID: dependencies.randomUUID,
  });
  const createdAt = dependencies.now().toISOString();
  let state = validateEmployeeOnboardingSelfTestState({
    version: 1,
    mutationId: fixture.request.clientMutationId,
    nameHash: fixture.nameHash,
    recordId: '',
    stage: 'prepared',
    createdAt,
    updatedAt: createdAt,
  });
  let result = null;
  let cleanupResult = null;
  let operationError = null;
  let cleanupError = null;

  await dependencies.writeState(state);
  try {
    await dependencies.primeLocalApi();
    state = validateEmployeeOnboardingSelfTestState({
      ...state,
      stage: 'submitting',
      updatedAt: monotonicTimestamp(state.updatedAt, dependencies.now()),
    });
    await dependencies.writeState(state);

    const response = await dependencies.postEmployeeOnboarding(fixture);
    assertSubmissionResponse(response, fixture.request.clientMutationId);
    state = validateEmployeeOnboardingSelfTestState({
      ...state,
      recordId: response.recordId,
      stage: 'confirmed',
      updatedAt: monotonicTimestamp(state.updatedAt, dependencies.now()),
    });
    await dependencies.writeState(state);

    const fields = await dependencies.readRecordById(state.recordId);
    if (fields === null) {
      throw new Error('员工信息池精确 recordId 回读为空');
    }
    assertEmployeeOnboardingRecord(fields, fixture);
    result = {
      ok: true,
      mutationRef: safeRef(state.mutationId),
      recordRef: safeRef(state.recordId),
    };
  } catch (error) {
    operationError = error;
  } finally {
    try {
      cleanupResult = await cleanupEmployeeOnboardingState(state, dependencies);
    } catch (error) {
      cleanupError = error;
    }
  }

  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      '新员工入职真实自测失败，自动清理也未确认',
    );
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return {
    ...result,
    cleaned: cleanupResult?.confirmedAbsent === true,
  };
}

export function createLoopbackApiSession({ baseUrl, client }) {
  const origin = loopbackOrigin(baseUrl);
  if (
    !client ||
    typeof client.get !== 'function' ||
    typeof client.post !== 'function'
  ) {
    throw new TypeError('本地 API 客户端无效');
  }
  let csrfToken = '';

  return {
    prime: async () => {
      const response = await client.get('/', {
        maxRedirects: 0,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'sec-fetch-dest': 'document',
        },
      });
      csrfToken = extractCsrfToken(response?.headers);
      return { csrfEnabled: true };
    },
    post: async (path, data, config = {}) => {
      assertSameLoopbackPath(origin, path);
      if (!csrfToken) {
        throw new TypeError('本地 API 会话尚未获取合法 CSRF Cookie');
      }
      const suppliedHeaders = isObject(config.headers) ? config.headers : {};
      const reserved = new Set(['cookie', CSRF_HEADER_NAME]);
      if (
        Object.keys(suppliedHeaders).some((name) =>
          reserved.has(name.toLowerCase()),
        )
      ) {
        throw new TypeError('CSRF 请求头由本地 API 会话统一管理');
      }
      return client.post(path, data, {
        ...config,
        maxRedirects: 0,
        headers: {
          ...suppliedHeaders,
          Cookie: `${CSRF_COOKIE_NAME}=${csrfToken}`,
          [CSRF_HEADER_NAME]: csrfToken,
        },
      });
    },
  };
}

export function parseEmployeeOnboardingSelfTestArguments(args) {
  const values = [...args];
  const command = values[0]?.startsWith('--')
    ? 'run'
    : clean(values.shift()) || 'run';
  if (!['run', 'cleanup-only'].includes(command)) {
    throw new Error('命令必须是 run 或 cleanup-only');
  }
  let baseUrl = DEFAULT_BASE_URL;
  let statePath = DEFAULT_STATE_PATH;
  while (values.length > 0) {
    const option = values.shift();
    const value = clean(values.shift());
    if (!value) throw new Error('自测命令参数缺少值');
    if (option === '--base-url') baseUrl = loopbackOrigin(value);
    else if (option === '--state') statePath = resolve(value);
    else throw new Error('不支持的自测命令参数');
  }
  return { command, baseUrl, statePath };
}

export function buildSafeCliError(error, stage = 'execute') {
  return {
    code:
      error instanceof UnsafeEmployeeOnboardingCleanupError
        ? 'UNSAFE_CLEANUP_BLOCKED'
        : 'SELF_TEST_FAILED',
    stage: clean(stage) || 'execute',
  };
}

async function createRealDependencies({ baseUrl, statePath }) {
  await import('../dist/server/runtime-env.js');
  const gatewayModule =
    await import('../dist/server/modules/bitable-sync/employee-onboarding.gateway.js');
  const gateway = new gatewayModule.EmployeeOnboardingGateway({
    axiosRef: axios,
  });
  const localApi = createLoopbackApiSession({
    baseUrl,
    client: axios.create(createEmployeeOnboardingLocalAxiosConfig(baseUrl)),
  });

  return {
    now: () => new Date(),
    randomUUID: () => createRandomUUID(),
    primeLocalApi: () => localApi.prime(),
    postEmployeeOnboarding: async (fixture) => {
      const form = new FormData();
      form.append('payload', JSON.stringify(fixture.request));
      form.append('photo', fixture.photo.buffer, {
        filename: fixture.photo.filename,
        contentType: fixture.photo.mimeType,
        knownLength: fixture.photo.size,
      });
      const response = await localApi.post(
        '/api/bitable/employee-onboarding',
        form,
        {
          headers: form.getHeaders(),
          maxBodyLength: 25 * 1024 * 1024,
          maxContentLength: 25 * 1024 * 1024,
          timeout: 120_000,
        },
      );
      return response.data;
    },
    readRecordById: (recordId) => gateway.readRecord(recordId),
    deleteRecordById: (recordId) => gateway.deleteRecordForSelfTest(recordId),
    writeState: (state) => atomicWriteState(statePath, state),
    removeState: () => unlinkIfExists(statePath),
  };
}

async function main(setStage = () => undefined) {
  setStage('arguments');
  const { command, baseUrl, statePath } =
    parseEmployeeOnboardingSelfTestArguments(process.argv.slice(2));
  setStage('state');
  const existing = await readState(statePath, false);
  setStage('dependencies');
  const dependencies = await createRealDependencies({ baseUrl, statePath });

  if (command === 'cleanup-only') {
    if (!existing) throw new Error('没有可清理的新员工入职真实自测状态');
    setStage('cleanup');
    const cleanup = await cleanupEmployeeOnboardingState(
      existing,
      dependencies,
    );
    printSafe({
      ok: true,
      mode: 'cleanup-only',
      deleted: cleanup.deleted,
      confirmedAbsent: cleanup.confirmedAbsent,
      recordRef: cleanup.recordRef || null,
    });
    return;
  }

  if (existing) {
    throw new Error(
      '存在未清理的新员工入职真实自测状态，请先运行 cleanup-only',
    );
  }
  setStage('run');
  const result = await runEmployeeOnboardingSelfTest(dependencies);
  printSafe({ ok: true, mode: 'run', ...result });
}

function validateFixture(fixture) {
  if (
    !isObject(fixture) ||
    !isObject(fixture.request) ||
    !MUTATION_ID_PATTERN.test(clean(fixture.request.clientMutationId)) ||
    !SYNTHETIC_NAME_PATTERN.test(clean(fixture.request.name)) ||
    !HASH_PATTERN.test(clean(fixture.nameHash)) ||
    hashText(fixture.request.name) !== fixture.nameHash ||
    !isFileDescriptor(fixture.photo)
  ) {
    throw new TypeError('新员工入职真实自测夹具无效');
  }
  return fixture;
}

function isFileDescriptor(value) {
  return (
    isObject(value) &&
    Buffer.isBuffer(value.buffer) &&
    value.buffer.length > 0 &&
    value.size === value.buffer.length &&
    clean(value.filename).endsWith('.png') &&
    value.mimeType === 'image/png'
  );
}

function resolveEmploymentType(companyName) {
  if (companyName === '南通承宏云计算有限公司') return '420';
  if (companyName === '北京智航万恒') return '102';
  return '生态';
}

function readAttachmentProofs(value, expectedFiles, field) {
  if (!Array.isArray(value) || value.length !== expectedFiles.length) {
    throw new Error(`员工信息池字段 ${field} 附件数量不一致`);
  }
  return value.map((item, index) => {
    const token = clean(item?.file_token);
    if (!isObject(item) || !FILE_TOKEN_PATTERN.test(token)) {
      throw new Error(`员工信息池字段 ${field} 附件标识无效`);
    }
    for (const nameKey of ['name', 'file_name', 'fileName', 'filename']) {
      if (
        Object.prototype.hasOwnProperty.call(item, nameKey) &&
        clean(item[nameKey]) !== expectedFiles[index].filename
      ) {
        throw new Error(`员工信息池字段 ${field} 附件文件名不一致`);
      }
    }
    return token;
  });
}

function assertSubmissionResponse(response, mutationId) {
  if (
    !isObject(response) ||
    Object.keys(response).sort().join('\0') !==
      ['success', 'syncStatus', 'clientMutationId', 'recordId', 'createdAt']
        .sort()
        .join('\0') ||
    response.success !== true ||
    response.syncStatus !== 'confirmed' ||
    response.clientMutationId !== mutationId ||
    !RECORD_ID_PATTERN.test(clean(response.recordId)) ||
    !isIsoTimestamp(clean(response.createdAt))
  ) {
    throw new Error('新员工入职创建响应格式无效');
  }
}

function assertRunDependencies(value) {
  const functions = [
    'now',
    'randomUUID',
    'primeLocalApi',
    'postEmployeeOnboarding',
    'readRecordById',
    'deleteRecordById',
    'writeState',
    'removeState',
  ];
  if (
    !isObject(value) ||
    functions.some((key) => typeof value[key] !== 'function')
  ) {
    throw new TypeError('新员工入职真实自测依赖无效');
  }
}

function assertCleanupDependencies(value) {
  const functions = [
    'readRecordById',
    'deleteRecordById',
    'writeState',
    'removeState',
  ];
  if (
    !isObject(value) ||
    functions.some((key) => typeof value[key] !== 'function')
  ) {
    throw new TypeError('新员工入职真实自测清理依赖无效');
  }
}

function cleanupTimestamp(state, dependencies) {
  const candidate =
    typeof dependencies.now === 'function' ? dependencies.now() : new Date();
  return monotonicTimestamp(state.updatedAt, candidate);
}

function monotonicTimestamp(previous, candidate) {
  const date = requireDate(candidate);
  const minimum = Date.parse(previous);
  return new Date(Math.max(date.getTime(), minimum)).toISOString();
}

function sameStrictValue(actual, expected) {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => actual[index] === item)
    );
  }
  return typeof actual === typeof expected && actual === expected;
}

function strictText(value) {
  if (typeof value !== 'string' || !value) {
    throw new UnsafeEmployeeOnboardingCleanupError(
      '精确 recordId 缺少测试身份字段，拒绝删除',
    );
  }
  return value;
}

function toShanghaiDateMilliseconds(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new TypeError('自测日期无效');
  return (
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) -
    SHANGHAI_OFFSET_MS
  );
}

function shanghaiDateKey(timestamp) {
  return new Date(timestamp + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function hashText(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function safeRef(value) {
  return hashText(value).slice(0, 12);
}

function requireDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('自测时间无效');
  return date;
}

function isIsoTimestamp(value) {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
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
    !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
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
    path.includes('\\') ||
    new URL(path, `${origin}/`).origin !== origin
  ) {
    throw new TypeError('本地 API 请求必须使用同源相对路径');
  }
}

function extractCsrfToken(headers) {
  let values = [];
  if (headers && typeof headers.getSetCookie === 'function') {
    values = headers.getSetCookie();
  } else {
    const raw = headers?.['set-cookie'] ?? headers?.get?.('set-cookie');
    values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  }
  const tokens = values
    .filter((value) => typeof value === 'string')
    .map((value) => value.split(';', 1)[0])
    .filter((value) => value.startsWith(`${CSRF_COOKIE_NAME}=`))
    .map((value) => value.slice(CSRF_COOKIE_NAME.length + 1));
  if (
    tokens.length !== 1 ||
    !CSRF_TOKEN_PATTERNS.some((pattern) => pattern.test(tokens[0]))
  ) {
    throw new TypeError('CSRF Cookie 格式无效');
  }
  return tokens[0];
}

export function createEmployeeOnboardingLocalAxiosConfig(baseUrl) {
  const origin = loopbackOrigin(baseUrl);
  return {
    baseURL: origin,
    timeout: 120_000,
    maxRedirects: 0,
    ...(origin.startsWith('https:')
      ? { httpsAgent: new HttpsAgent({ rejectUnauthorized: false }) }
      : {}),
  };
}

async function atomicWriteState(path, state) {
  const validated = validateEmployeeOnboardingSelfTestState(state);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${createRandomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(validated)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await unlinkIfExists(temporaryPath);
  }
}

async function readState(path, required) {
  try {
    return validateEmployeeOnboardingSelfTestState(
      JSON.parse(await readFile(path, 'utf8')),
    );
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) return null;
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

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
