'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, 'output/release-next-after-20261005-182903');
const owned = path.join(output, 'alarm-review-live-owned-20261006-f9b9836f'), ledger = path.join(owned, 'ledger.json');
const title = 'TEST-异常复核-20261006-f9b9836f', recordId = 'recvxgGL0OOod9';
const base = 'JeMdbI3JjawMj1s1YGSc3MoBn7c', table = 'tblD7hi70s6U6rlU';
const personId = 'recuSBqPEuWsww', openId = 'ou_a6644e62a43b916c6bc26148cf74f208', principal = 'TEST-alarm-review-20261006-f9b9836f';
const presetId = 'alarm-review-task-aa77889c-ebf6-4da2-8c0e-388394bcec89', mutation = 'alarm-review-live20261006-f9b9836f-preset';
const manifestSha = '071c677e832fc03f94ab37bb17bbd85bb9c6e9eb6876f804772adb4ea05e773b';
const beforeSha = '280a46d3a64fe9d8414bbeb7a10827c82b4057574d49ab25b6cb392bf342fabe';
const snapshot = path.join(owned, 'ledger-before-continuation.json'), sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const started = performance.now(), startedUtc = new Date().toISOString(), observations = [], requests = [], taskIds = [];
let service, stage = 'ownership', phase = '', fields, puts = 0, gets = 0, injected = false;
async function main() {
  assert.deepEqual(process.argv.slice(2), ['--approved-continuation', recordId, manifestSha, beforeSha]);
  const manifestBytes = fs.readFileSync(path.join(output, 'alarm-review-live-record-owned-20261006.json'));
  assert.equal(sha(manifestBytes), manifestSha); const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.created, true); assert.equal(manifest.createdCount, 1); assert.equal(manifest.recordId, recordId);
  assert.equal(manifest.title, title); assert.equal(manifest.baseToken, base); assert.equal(manifest.tableId, table);
  const originalBytes = fs.readFileSync(ledger); assert.equal(sha(originalBytes), beforeSha);
  const original = JSON.parse(originalBytes); assert.equal(original.tasks.length, 1);
  const savedPreset = original.tasks[0]; assert.equal(savedPreset.id, presetId); assert.equal(savedPreset.clientMutationId, mutation);
  assert.equal(savedPreset.principal, principal); assert.equal(savedPreset.userId, openId); assert.equal(savedPreset.responsibleRecordId, personId);
  assert.equal(savedPreset.outcome, '人工复核无问题'); assert.equal(savedPreset.lease, null);
  assert.equal(savedPreset.items.length, 1); assert.equal(savedPreset.items[0].recordId, recordId); assert.equal(savedPreset.items[0].state, 'error');
  assert.equal(savedPreset.request.expectedVersions[recordId], 'unreviewed'); assert.equal(fs.existsSync(snapshot), false, 'No continuation rerun');
  stage = 'credential-source';
  const project = require('dotenv').parse(fs.readFileSync(path.join(root, '.env')));
  assert.equal(project.FEISHU_APP_ID?.trim(), 'cli_a9d1c9fe9d381cee'); assert.ok(project.FEISHU_APP_SECRET?.trim());
  process.env.FEISHU_APP_ID = project.FEISHU_APP_ID; process.env.FEISHU_APP_SECRET = project.FEISHU_APP_SECRET;
  assert.ok(!process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE); assert.ok(!process.env.TODAY_OPERATIONS_ALARM_BITABLE_URL);
  for (const key of ['TODAY_OPERATIONS_ALARM_FEISHU_APP_ID', 'FEISHU_RISK_INSPECTION_APP_ID', 'ALI_MONTHLY_REPORT_FEISHU_APP_ID']) assert.ok(!process.env[key]);
  process.env.FEISHU_LOCAL_CACHE_DIR = path.join(owned, 'cache'); process.env.DISABLE_V8_COMPILE_CACHE = '1';
  stage = 'source-loading'; require('reflect-metadata');
  require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs', moduleResolution: 'node', esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true } });
  require('tsconfig-paths').register({ baseUrl: root, paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] } });
  const load = file => require(path.join(root, file));
  const { AlarmReviewService } = load('server/modules/bitable-sync/alarm-review.service.ts');
  const { AlarmReviewStore } = load('server/modules/bitable-sync/alarm-review.store.ts');
  const { AlarmReviewGateway } = load('server/modules/bitable-sync/alarm-review.gateway.ts');
  const { reviewVersion, reviewMatches } = load('server/modules/bitable-sync/alarm-review.rules.ts');
  const { extractDisplayText } = load('server/common/feishu/bitable-direct-read.ts');
  const { HttpService } = require('@nestjs/axios'), axios = require('axios'); const sourceLoadingMs = performance.now() - started;
  const recordUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables/${table}/records/${recordId}`;
  const fieldsUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables/${table}/fields`;
  const client = axios.create({ timeout: 8000 }); let ownershipRead = false;
  function requestPhase(config) {
    if (config.url === 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal') return 'auth';
    if (config.url === 'https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node') return 'wiki';
    if (config.url === fieldsUrl) return 'fields'; if (config.url === recordUrl) return 'owned-record'; return 'rejected';
  }
  client.interceptors.request.use(config => {
    const method = (config.method || 'get').toLowerCase(), kind = requestPhase(config);
    requests.push({ phase: kind, method });
    if (method === 'post' && kind === 'auth') { assert.equal(config.data.app_id, 'cli_a9d1c9fe9d381cee'); return config; }
    if (method === 'get' && kind === 'wiki') { assert.equal(config.params.token, 'SOwsw315aiBJjgkl48ccoxIPntc'); return config; }
    if (method === 'get' && kind === 'fields') return config;
    assert.equal(kind, 'owned-record', 'Only owned record may be accessed');
    if (method === 'get') { if (phase === 'custom-fail' && !injected) { injected = true; throw new Error('TEST transport failure before sending record GET'); } gets++; return config; }
    assert.equal(method, 'put'); assert.equal(ownershipRead, true);
    assert.deepEqual(Object.keys(config.data.fields).sort(), ['人工复核结果', '复核回复', '复核责任人'].sort());
    assert.deepEqual(config.data.fields.复核责任人, [{ id: openId }]); puts++; return config;
  });
  client.interceptors.response.use(response => {
    const apiCode = Number(response.data?.code); observations.push({ requestPhase: requestPhase(response.config), httpStatus: response.status, apiCode: Number.isFinite(apiCode) ? apiCode : null });
    if (response.config.url === recordUrl && response.config.method === 'get' && response.data?.code === 0) {
      assert.equal(response.data.data.record.record_id, recordId); const value = response.data.data.record.fields;
      assert.equal(extractDisplayText(value.告警内容).trim(), title); assert.equal(extractDisplayText(value.受理描述).trim(), 'TEST原受理描述不得改变');
      assert.equal(extractDisplayText(value.确认描述).trim(), 'TEST原确认描述不得改变'); ownershipRead = true;
    } return response;
  }, error => {
    const networkCode = ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'ERR_NETWORK', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(error?.code) ? error.code : null;
    const apiCode = Number(error?.response?.data?.code);
    observations.push({ requestPhase: error?.config ? requestPhase(error.config) : 'before-send-or-unknown', exceptionClass: error?.constructor?.name || 'unknown', httpStatus: Number.isInteger(error?.response?.status) ? error.response.status : null, apiCode: Number.isFinite(apiCode) ? apiCode : null, networkCode }); throw error;
  });
  const people = { getCachedActivePersonnelDirectory: async () => ({ personnel: [{ recordId: personId, openId, name: '马进宇', position: '', buildings: [] }] }) };
  const alarms = { patchHumanReview: (id, value) => { assert.equal(id, recordId); fields = value; } };
  const fresh = () => { const store = new AlarmReviewStore(ledger); service = new AlarmReviewService(store, new AlarmReviewGateway(new HttpService(client)), people, alarms); return store; };
  assert.equal(sha(fs.readFileSync(ledger)), beforeSha); fs.writeFileSync(snapshot, originalBytes, { flag: 'wx' }); assert.equal(sha(fs.readFileSync(snapshot)), beforeSha);
  let store = fresh(); stage = phase = 'recover-original-preset';
  const preset = service.recover(mutation, 'admin', principal); assert.equal(preset.id, presetId); taskIds.push(preset.id);
  service.retry(preset.id, 'admin', principal);
  async function successful(task, outcome, reply, expectedPuts) {
    await service.processReady(); const status = service.status(task.id, 'admin', principal);
    assert.equal(status.items.length, 1); assert.equal(status.items[0].state, 'success'); assert.ok(reviewMatches(fields, outcome, openId, reply)); assert.equal(puts, expectedPuts);
    observations.push({ phase, state: 'success', semanticReadback: true, originalDescriptionsPreserved: true, puts });
  }
  await successful(preset, '人工复核无问题', undefined, 1);
  assert.equal((await service.submit(savedPreset.request, 'admin', principal)).id, presetId);
  service.onModuleDestroy(); store = fresh(); await service.processReady(); assert.equal(puts, 1);
  const request = (suffix, outcome, customReply) => ({ recordIds: [recordId], outcome, responsibleRecordId: personId, clientMutationId: `alarm-review-live20261006-f9b9836f-${suffix}`, expectedVersions: { [recordId]: reviewVersion(fields) }, ...(customReply ? { customReply } : {}) });
  async function submitSame(input) { const first = await service.submit(input, 'admin', principal), again = await service.submit(input, 'admin', principal); assert.equal(first.id, again.id); taskIds.push(first.id); return first; }
  stage = phase = 'custom-fail'; const reply = 'TEST自定义回复：已核对，待现场复查。'; const custom = await submitSame(request('custom', '自定义回复', reply));
  await service.processReady(); assert.equal(service.status(custom.id, 'admin', principal).items[0].state, 'error'); assert.equal(puts, 1); assert.equal(injected, true);
  observations.push({ phase, state: 'expected-injected-error-before-send', puts }); service.onModuleDestroy(); store = fresh(); stage = phase = 'custom-restart-retry';
  assert.equal(service.recover(custom.clientMutationId, 'admin', principal).customReply, reply); service.retry(custom.id, 'admin', principal); await successful(custom, '自定义回复', reply, 2);
  service.onModuleDestroy(); store = fresh(); await service.processReady(); assert.equal(puts, 2);
  stage = phase = 'preset-clear'; const clear = await submitSame(request('clear', '已通知现场跟进')); await successful(clear, '已通知现场跟进', undefined, 3);
  const saved = JSON.parse(fs.readFileSync(ledger, 'utf8')); assert.equal(saved.tasks.length, 3); assert.equal(saved.tasks[0].id, presetId);
  assert.ok(saved.tasks.every(task => task.lease === null && task.items.every(item => item.state === 'success')));
  service.onModuleDestroy(); assert.equal(service.timer, null); assert.equal(fs.existsSync(`${ledger}.lock`), false);
  assert.deepEqual(fs.readdirSync(owned).filter(name => name.endsWith('.tmp') || name.endsWith('.lock')), []);
  console.log(JSON.stringify({ status: 'real-business-continuation-passed-cleanup-pending-manual-delete', startedUtc, endedUtc: new Date().toISOString(), elapsedMs: performance.now() - started, sourceLoadingMs, recordId, taskIds, originalTaskRecovered: true, credentialSource: 'project-dotenv-this-child-only', originalLedgerSnapshotSha256: beforeSha, observations, requests, actualRecordPuts: puts, actualRecordGets: gets, taskCount: saved.tasks.length, pendingTasks: store.listReady().length, activeLeases: 0, ledgerLockPresent: false, intervalStarted: false, notificationsSent: false, productionLedgerAccessed: false, realPageVerified: false, cleanup: 'pending-manual-delete', originalWholePolicyRedAndP95Unresolved: true }));
}
main().catch(error => { if (service) service.onModuleDestroy(); console.error(JSON.stringify({ status: 'real-business-continuation-failed', stage, exceptionClass: error?.constructor?.name || 'unknown', actualRecordPuts: puts, actualRecordGets: gets, injectedTransportFailure: injected, observations, requests, elapsedMs: performance.now() - started, cleanup: 'pending-manual-delete' })); process.exitCode = 1; });
