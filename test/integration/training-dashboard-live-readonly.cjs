// Explicit local verification; no application bootstrap and no business writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const live = process.argv.includes('--live-readonly');
const mode = live ? 'live-readonly' : 'offline';
if (process.argv.slice(2).some((arg) => !['--offline', '--live-readonly'].includes(arg))) {
  throw new Error('UNSUPPORTED_VERIFICATION_ARGUMENT');
}
const output = path.join(root, 'output/training-sync-fix-20261027');
fs.mkdirSync(output, { recursive: true });
const cache = fs.mkdtempSync(path.join(output, `${mode}-cache-`));
const result = { mode, startedAt: new Date().toISOString(), checks: [], networkWrites: 0 };
function check(value, name) {
  if (!value) throw new Error(name);
  result.checks.push(name);
}
function same(actual, expected, name) {
  try { assert.deepStrictEqual(actual, expected); }
  catch { throw new Error(name); }
  result.checks.push(name);
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function finite(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object') return true;
  return Object.values(value).every(finite);
}
if (live) {
  const dotenv = require('dotenv');
  for (const file of ['.env', '.env.local']) {
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) continue;
    const values = dotenv.parse(fs.readFileSync(absolute));
    for (const [key, value] of Object.entries(values)) {
      if (/^FEISHU_(?:APP_(?:ID|SECRET)|TRAINING_.*|CARD_ACTION_CONSUMER_PROFILE)$/.test(key)) process.env[key] = value;
    }
  }
} else {
  process.env.FEISHU_APP_ID = 'local-training-verification';
  process.env.FEISHU_APP_SECRET = 'local-training-verification';
  process.env.FEISHU_TRAINING_APP_TOKEN = 'local-training-base';
  process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE = 'disabled';
  process.env.FEISHU_BITABLE_MAX_ATTEMPTS = '2';
  process.env.FEISHU_BITABLE_RETRY_BASE_DELAY_MS = '1';
}
process.env.FEISHU_LOCAL_CACHE_DIR = cache;
require('reflect-metadata');
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', moduleResolution: 'node', experimentalDecorators: true, emitDecoratorMetadata: true },
});
require('tsconfig-paths').register({ baseUrl: root, paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] } });
require('@nestjs/common').Logger.overrideLogger(false);
const { getEffectiveFeishuAppCredentials } = require('../../server/common/config/external-services.config.ts');
const fields = require('../../server/modules/bitable-sync/training-dashboard.fields.ts');
const { TrainingDashboardService } = require('../../server/modules/bitable-sync/training-dashboard.service.ts');
const { mapCampusTrainingDashboard } = require('../../server/modules/bitable-sync/training-dashboard.mapper.ts');
const tables = new Map(fields.TRAINING_DASHBOARD_TABLE_CONFIGS.map((config) => [fields.getTrainingTableId(config), config]));
const collected = Object.fromEntries(fields.TRAINING_TABLE_CONFIGS.map((config) => [config.key, []]));
const requestCounts = Object.fromEntries(fields.TRAINING_DASHBOARD_TABLE_CONFIGS.map((config) => [config.key, 0]));
let networkRequests = 0;
let baseToken = process.env.FEISHU_TRAINING_APP_TOKEN?.trim() || '';
const wikiToken = process.env.FEISHU_TRAINING_WIKI_TOKEN?.trim() || fields.DEFAULT_TRAINING_WIKI_TOKEN;
const credentials = getEffectiveFeishuAppCredentials();
let transportFailure = false;
let pending = 0;
const transport = live ? require('axios').create({ maxRedirects: 0, timeout: 30000 }) : null;
const month = '2026-10';
function fixture() {
  const row = (key, values, i = 0) => ({ record_id: `test-${key}-${i}`, fields: values });
  return {
    activeStats: ['A楼', 'B楼'].map((building, i) => row('stats', { 年份: '2026', 月份: '10', 楼栋: building, 本月培训课程数量: 1, 培训人数: 999 }, i)),
    activeScores: Array.from({ length: 1001 }, (_, i) => row('scores', {
      '员工 （文本）': [{ type: 'text', text: `员工${i % 17}` }],
      楼栋: i % 2 ? 'A楼' : 'B楼', '月份（计划）': '2026-10', 月份: '10', 课程: '安全培训', 签到: true, 考试分数: 90,
    }, i)),
    activePlans: [row('plans', { 培训课程名称: '安全培训', 培训年份: '2026', 培训月份: '10', '楼栋/专业': 'A楼' })],
    newHireScores: [row('new', { 人员: '新人', 入职日期: '2026-10-01', 楼栋: 'A楼' })],
    newHireCourses: [], newHirePlans: [],
    sharingSessions: [row('sharing', { 分享主题: '十月分享', 开始时间: '2026-10-01T09:00:00+08:00', 月度: '10', '会议进度（勿动）': '已结束' })],
    sharingScores: [row('ratings', { 主题名: '十月分享', 评分: 8 })], sharingInterests: [],
  };
}
const synthetic = fixture();
async function request(method, urlString, body, options = {}) {
  const url = new URL(urlString);
  if (url.origin !== 'https://open.feishu.cn' || url.username || url.password || url.hash || url.search) throw new Error('NETWORK_ORIGIN_REJECTED');
  const auth = method === 'post' && url.pathname === '/open-apis/auth/v3/tenant_access_token/internal';
  const wiki = method === 'get' && url.pathname === '/open-apis/wiki/v2/spaces/get_node' && options.params?.token === wikiToken;
  const search = /^\/open-apis\/bitable\/v1\/apps\/([^/]+)\/tables\/([^/]+)\/records\/search$/.exec(url.pathname);
  const config = search && method === 'post' && search[1] === baseToken ? tables.get(search[2]) : null;
  if (!auth && !wiki && !config) throw new Error('NON_READ_ENDPOINT_REJECTED');
  if (auth && (body?.app_id !== credentials.appId || body?.app_secret !== credentials.appSecret)) throw new Error('AUTH_PAYLOAD_REJECTED');
  if (config) {
    if (Object.keys(body).some((key) => key !== 'field_names')) throw new Error('SEARCH_BODY_REJECTED');
    assert.deepStrictEqual([...body.field_names].sort(), [...config.fieldNames].sort());
    if (config.key === 'activeScores' && (body.field_names.includes('员工') || !body.field_names.includes('员工 （文本）'))) throw new Error('LEGACY_FIELD_REQUESTED');
    requestCounts[config.key] += 1;
  }
  if (++networkRequests > 120 || Date.now() - Date.parse(result.startedAt) > 180000) throw new Error('READ_BUDGET_EXCEEDED');
  pending += 1;
  try {
    let response;
    if (live) {
      try { response = await transport.request({ method, url: urlString, data: body, ...options, maxRedirects: 0, timeout: 30000 }); }
      catch (error) {
        const sanitized = new Error('READ_HTTP_FAILED');
        sanitized.code = error.code;
        sanitized.response = { status: error.response?.status, data: { code: error.response?.data?.code, msg: 'READ_HTTP_FAILED' } };
        throw sanitized;
      }
    } else if (auth) {
      response = { status: 200, data: { code: 0, tenant_access_token: 'local-only', expire: 7200 } };
    } else if (config) {
      const offset = Number(options.params?.page_token || 0), size = options.params?.page_size || 500;
      if (transportFailure && config.key === 'activeScores' && offset >= 500) {
        const error = new Error('offline-simulated-network-failure'); error.code = 'ECONNRESET'; throw error;
      }
      const records = synthetic[config.key], items = records.slice(offset, offset + size);
      response = { status: 200, data: { code: 0, data: { items, has_more: offset + size < records.length, page_token: String(offset + size) } } };
    } else throw new Error('UNEXPECTED_OFFLINE_WIKI');
    if (wiki && Number(response.data?.code) === 0) {
      if (response.data?.data?.node?.obj_type !== 'bitable') throw new Error('WIKI_NOT_BITABLE');
      baseToken = response.data.data.node.obj_token;
    }
    if (config && !transportFailure) collected[config.key].push(...(response.data?.data?.items || []));
    return response;
  } finally { pending -= 1; }
}
const http = { axiosRef: { post: (url, body, options) => request('post', url, body, options), get: (url, options) => request('get', url, undefined, options) } };
async function settledSnapshot(expectedSavedAt) {
  for (let i = 0; i < 100; i += 1) {
    const file = path.join(cache, 'training-dashboard-sources-v1.json');
    if (fs.existsSync(file)) {
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!expectedSavedAt || snapshot.savedAt === expectedSavedAt) return snapshot;
    }
    await delay(25);
  }
  throw new Error('SUCCESSFUL_SNAPSHOT_NOT_PERSISTED');
}
async function main() {
  if (live) check(credentials.appId === 'cli_a9d1c9fe9d381cee' && !!credentials.appSecret, 'CURRENT_PROJECT_APP_ONLY');
  await assert.rejects(request('post', 'https://open.feishu.cn/open-apis/im/v1/messages', {}), /NON_READ_ENDPOINT_REJECTED/);
  await assert.rejects(request('get', 'https://example.invalid/'), /NETWORK_ORIGIN_REJECTED/);
  check(networkRequests === 0, 'WRITE_AND_FOREIGN_HOST_GUARDS_VERIFIED_BEFORE_READS');
  const service = new TrainingDashboardService(http);
  const fresh = await service.getDashboard(month, true);
  check(fresh.sourceStatus === 'fresh', 'FRESH_FULL_SOURCE_RESPONSE');
  check(Number.isFinite(Date.parse(fresh.syncedAt)), 'SUCCESS_TIMESTAMP_VALID');
  check(finite(fresh), 'ALL_DASHBOARD_NUMBERS_FINITE');
  check(fields.TRAINING_DASHBOARD_TABLE_CONFIGS.every((config) => requestCounts[config.key] > 0), 'ALL_SEVEN_SOURCES_READ');
  same(fresh.summary.monthlyParticipants, fresh.participation.reduce((total, row) => total + row.people, 0), 'PARTICIPATION_SUM_RECONCILES');
  const persisted = await settledSnapshot(fresh.syncedAt);
  same(persisted.savedAt, fresh.syncedAt, 'PERSISTED_SUCCESS_TIMESTAMP_MATCHES_RESPONSE');
  const callsBeforeMonthSwitch = networkRequests;
  const otherMonth = await service.getDashboard('2026-09', false);
  same(networkRequests, callsBeforeMonthSwitch, 'MONTH_SWITCH_REUSES_COMPLETE_BUNDLE');
  same(otherMonth.syncedAt, fresh.syncedAt, 'MONTH_SWITCH_RETAINS_SUCCESS_TIMESTAMP');
  const originalMapper = path.join(output, 'before/server/modules/bitable-sync/training-dashboard.mapper.ts');
  check(fs.existsSync(originalMapper), 'PRE_FIX_MAPPER_AVAILABLE');
  const { mapCampusTrainingDashboard: beforeMapper } = require(originalMapper);
  const legacySources = { ...collected, activeScores: collected.activeScores.map((row) => ({ ...row, fields: { ...row.fields, 员工: row.fields?.['员工 （文本）'] } })) };
  const rawPassScore = process.env.FEISHU_TRAINING_PASS_SCORE?.trim();
  const passScore = rawPassScore ? Number(rawPassScore) : 80;
  const normalizedScore = Number.isFinite(passScore) && passScore >= 0 && passScore <= 100 ? passScore : 80;
  for (const selected of [month, '2026-09']) {
    const before = beforeMapper(legacySources, selected, fresh.syncedAt, normalizedScore);
    const after = mapCampusTrainingDashboard(collected, selected, fresh.syncedAt, normalizedScore);
    same(after, before, `ALL_MAPPER_METRICS_MATCH_NORMALIZED_PRE_FIX_${selected}`);
  }
  if (!live) {
    same(collected.activeScores.length, 1001, 'ALL_1001_ROWS_READ_ACROSS_PAGES');
    same(requestCounts.activeScores, 3, 'THREE_SCORE_PAGES_READ');
    same(fresh.summary.monthlyParticipants, 34, 'REPEATED_COURSES_AND_CROSS_BUILDING_NAMES_COUNT_CORRECTLY');
    same(fresh.details.participants.length, 34, 'PARTICIPANT_DETAILS_RECONCILE');
    transportFailure = true;
    const stale = await service.getDashboard(month, true);
    check(stale.sourceStatus === 'stale', 'PARTIAL_PAGE_FAILURE_REPORTED');
    same(stale.summary, fresh.summary, 'PARTIAL_FAILURE_PRESERVES_GOOD_SUMMARY');
    same(stale.syncedAt, fresh.syncedAt, 'FAILURE_RETAINS_SUCCESS_TIMESTAMP');
    same((await settledSnapshot(fresh.syncedAt)).sources.activeScores.length, 1001, 'PARTIAL_FAILURE_DOES_NOT_REPLACE_SOURCE_BUNDLE');
    transportFailure = false;
    const retried = await service.getDashboard(month, true);
    check(retried.sourceStatus === 'fresh', 'EXPLICIT_RETRY_RECOVERS');
    same(retried.summary, fresh.summary, 'RETRY_PRESERVES_EXPECTED_STATISTICS');
    await settledSnapshot(retried.syncedAt);
  }
  result.counts = Object.fromEntries(Object.entries(persisted.sources).map(([key, rows]) => [key, rows.length]));
  result.pages = requestCounts;
  result.summary = fresh.summary;
  result.participation = fresh.participation.map(({ building, people }) => ({ building, people }));
  result.participantDetails = fresh.details.participants.length;
  result.sourceStatus = fresh.sourceStatus;
  result.syncedAt = fresh.syncedAt;
  result.originalMapperSha256 = crypto.createHash('sha256').update(fs.readFileSync(originalMapper)).digest('hex');
  result.sourceHashes = Object.fromEntries(Object.keys(require.cache)
    .filter((file) => file.startsWith(path.join(root, 'server')) && file.endsWith('.ts'))
    .map((file) => [path.relative(root, file).split(path.sep).join('/'), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
  result.status = 'PASS';
}
main().catch((error) => {
  result.status = 'FAIL';
  result.failure = /^[A-Z0-9_-]+$/.test(String(error.message)) ? error.message : 'VERIFICATION_ASSERTION_FAILED';
  process.exitCode = 1;
}).finally(async () => {
  for (let i = 0; pending && i < 100; i += 1) await delay(50);
  await delay(100);
  const owned = path.resolve(cache);
  if (path.dirname(owned) !== path.resolve(output) || !path.basename(owned).startsWith(`${mode}-cache-`)) throw new Error('CACHE_CLEANUP_SCOPE_MISMATCH');
  fs.rmSync(owned, { recursive: true, force: true });
  result.temporaryCacheRemoved = !fs.existsSync(owned);
  result.networkRequests = networkRequests;
  result.finishedAt = new Date().toISOString();
  result.scriptSha256 = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
  fs.writeFileSync(path.join(output, `${mode}-integration.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
});
