'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), owned = path.join(root, 'output/release-next-after-20261005-182903/alarm-review-live-owned-20261006-f9b9836f');
const recordId = 'recvxgGL0OOod9', title = 'TEST-异常复核-20261006-f9b9836f', base = 'JeMdbI3JjawMj1s1YGSc3MoBn7c', table = 'tbld976fa6fc1832';
const personId = 'recuSBqPEuWsww', openId = 'PUBLIC_EXAMPLE_FEISHU_TYPHOON_PATH_TEST_OPEN_ID', principal = 'TEST-alarm-review-20261006-f9b9836f';
const customId = 'alarm-review-task-74ce719c-0390-4187-9644-f2989c7e2501', mutation = 'alarm-review-live20261006-f9b9836f-custom', reply = 'TEST自定义回复：已核对，待现场复查。';
const manifestSha = '071c677e832fc03f94ab37bb17bbd85bb9c6e9eb6876f804772adb4ea05e773b', beforeSha = '14f124efbf96a124f95bc526fd2fa0a8ff4aee2faab714a82ee297e487827cb8';
const ledger = path.join(owned, 'ledger.json'), snapshot = path.join(owned, 'ledger-before-body-recovery.json'), sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const started = performance.now(), startedUtc = new Date().toISOString(), observations = [], requests = [];
let service, stage = 'ownership', phase = '', fields, puts = 0, gets = 0;
async function main() {
  assert.deepEqual(process.argv.slice(2), ['--approved-body-recovery', recordId, manifestSha, beforeSha]);
  const manifestBytes = fs.readFileSync(path.join(owned, '../alarm-review-live-record-owned-20261006.json')); assert.equal(sha(manifestBytes), manifestSha);
  const manifest = JSON.parse(manifestBytes); assert.equal(manifest.created, true); assert.equal(manifest.createdCount, 1); assert.equal(manifest.recordId, recordId); assert.equal(manifest.title, title);
  const before = fs.readFileSync(ledger); assert.equal(sha(before), beforeSha); const tasks = JSON.parse(before).tasks; assert.equal(tasks.length, 2);
  assert.equal(tasks[0].id, 'alarm-review-task-aa77889c-ebf6-4da2-8c0e-388394bcec89'); assert.equal(tasks[0].items[0].state, 'success');
  const old = tasks[1]; assert.equal(old.id, customId); assert.equal(old.clientMutationId, mutation); assert.equal(old.principal, principal); assert.equal(old.userId, openId);
  assert.equal(old.responsibleRecordId, personId); assert.equal(old.outcome, '自定义回复'); assert.equal(old.customReply, reply); assert.equal(old.lease, null);
  assert.equal(old.items.length, 1); assert.equal(old.items[0].recordId, recordId); assert.equal(old.items[0].state, 'error'); assert.equal(fs.existsSync(snapshot), false, 'No recovery rerun');
  for (const [file, expected] of [['server/modules/bitable-sync/alarm-review.rules.ts', 'bc5416569421c75bce9ccea70037484ed2d19e5b773f353cb87ee7600f0cc0d0'], ['server/modules/bitable-sync/today-operations-alarm.service.ts', 'f1726476a8c4c529612d5965afb9ae6126e0bec640f7d86c7c6ebab522c2ed56']]) assert.equal(sha(fs.readFileSync(path.join(root, file))), expected);
  stage = 'credential-source'; const project = require('dotenv').parse(fs.readFileSync(path.join(root, '.env')));
  assert.equal(project.FEISHU_APP_ID?.trim(), 'cli_0831564613853b26'); assert.ok(project.FEISHU_APP_SECRET?.trim());
  process.env.FEISHU_APP_ID = project.FEISHU_APP_ID; process.env.FEISHU_APP_SECRET = project.FEISHU_APP_SECRET;
  assert.ok(!process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE); assert.ok(!process.env.TODAY_OPERATIONS_ALARM_BITABLE_URL);
  for (const key of ['TODAY_OPERATIONS_ALARM_FEISHU_APP_ID', 'FEISHU_RISK_INSPECTION_APP_ID', 'ALI_MONTHLY_REPORT_FEISHU_APP_ID']) assert.ok(!process.env[key]);
  process.env.FEISHU_LOCAL_CACHE_DIR = path.join(owned, 'cache'); process.env.DISABLE_V8_COMPILE_CACHE = '1'; stage = 'source-loading'; require('reflect-metadata');
  require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs', moduleResolution: 'node', esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true } });
  require('tsconfig-paths').register({ baseUrl: root, paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] } }); const load = file => require(path.join(root, file));
  const { AlarmReviewService } = load('server/modules/bitable-sync/alarm-review.service.ts'), { AlarmReviewStore } = load('server/modules/bitable-sync/alarm-review.store.ts');
  const { AlarmReviewGateway } = load('server/modules/bitable-sync/alarm-review.gateway.ts'), { reviewVersion, reviewMatches } = load('server/modules/bitable-sync/alarm-review.rules.ts');
  const { extractDisplayText } = load('server/common/feishu/bitable-direct-read.ts'), { HttpService } = require('@nestjs/axios'), axios = require('axios'); const sourceLoadingMs = performance.now() - started;
  const recordUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables/${table}/records/${recordId}`, fieldsUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables/${table}/fields`;
  const client = axios.create({ timeout: 8000 }); let ownershipRead = false;
  const requestPhase = config => config.url === recordUrl ? 'owned-record' : config.url === fieldsUrl ? 'fields' : config.url === 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' ? 'auth' : config.url === 'https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node' ? 'wiki' : 'rejected';
  client.interceptors.request.use(config => {
    const method = (config.method || 'get').toLowerCase(), kind = requestPhase(config); requests.push({ phase: kind, method });
    if (method === 'post' && kind === 'auth') { assert.equal(config.data.app_id, 'cli_0831564613853b26'); return config; }
    if (method === 'get' && kind === 'wiki') { assert.equal(config.params.token, 'SOwsw315aiBJjgkl48ccoxIPntc'); return config; }
    if (method === 'get' && kind === 'fields') return config; assert.equal(kind, 'owned-record');
    if (method === 'get') { gets++; return config; }
    assert.equal(method, 'put'); assert.equal(phase, 'clear'); assert.equal(ownershipRead, true); assert.equal(puts, 0);
    assert.deepEqual(config.data.fields, { 人工复核结果: '已通知现场跟进', 复核示例人员019: [{ id: openId }], 复核回复: '' }); puts++; return config;
  });
  client.interceptors.response.use(response => {
    const apiCode = Number(response.data?.code); observations.push({ requestPhase: requestPhase(response.config), httpStatus: response.status, apiCode: Number.isFinite(apiCode) ? apiCode : null });
    if (response.config.url === recordUrl && response.config.method === 'get' && response.data?.code === 0) {
      assert.equal(response.data.data.record.record_id, recordId); const value = response.data.data.record.fields;
      assert.equal(extractDisplayText(value.告警内容).trim(), title); assert.equal(extractDisplayText(value.受理描述).trim(), 'TEST原受理描述不得改变'); assert.equal(extractDisplayText(value.确认描述).trim(), 'TEST原确认描述不得改变'); ownershipRead = true;
    } return response;
  }, error => { const apiCode = Number(error?.response?.data?.code); observations.push({ requestPhase: error?.config ? requestPhase(error.config) : 'before-send-or-unknown', exceptionClass: error?.constructor?.name || 'unknown', httpStatus: Number.isInteger(error?.response?.status) ? error.response.status : null, apiCode: Number.isFinite(apiCode) ? apiCode : null }); throw error; });
  const people = { getCachedActivePersonnelDirectory: async () => ({ personnel: [{ recordId: personId, openId, name: '示例人员020', position: '', buildings: [] }] }) }, alarms = { patchHumanReview: (id, value) => { assert.equal(id, recordId); fields = value; } };
  const fresh = () => { const store = new AlarmReviewStore(ledger); service = new AlarmReviewService(store, new AlarmReviewGateway(new HttpService(client)), people, alarms); return store; };
  assert.equal(sha(fs.readFileSync(ledger)), beforeSha); fs.writeFileSync(snapshot, before, { flag: 'wx' }); assert.equal(sha(fs.readFileSync(snapshot)), beforeSha);
  let store = fresh(); stage = phase = 'custom-get-only'; const recovered = service.recover(mutation, 'admin', principal); assert.equal(recovered.id, customId); assert.equal(recovered.customReply, reply);
  service.retry(customId, 'admin', principal); await service.processReady(); assert.equal(service.status(customId, 'admin', principal).items[0].state, 'success'); assert.ok(reviewMatches(fields, '自定义回复', openId, reply)); assert.equal(puts, 0); assert.equal(gets, 1);
  assert.equal((await service.submit(old.request, 'admin', principal)).id, customId); service.onModuleDestroy(); store = fresh(); await service.processReady(); assert.equal(puts, 0);
  observations.push({ phase, semanticReadback: true, originalDescriptionsPreserved: true, customPutCount: 0 }); stage = phase = 'clear';
  const clearRequest = { recordIds: [recordId], outcome: '已通知现场跟进', responsibleRecordId: personId, clientMutationId: 'alarm-review-live20261006-f9b9836f-clear', expectedVersions: { [recordId]: reviewVersion(fields) } };
  const clear = await service.submit(clearRequest, 'admin', principal); assert.equal((await service.submit(clearRequest, 'admin', principal)).id, clear.id); await service.processReady();
  assert.equal(service.status(clear.id, 'admin', principal).items[0].state, 'success'); assert.ok(reviewMatches(fields, '已通知现场跟进', openId)); assert.equal(puts, 1); assert.equal(gets, 3);
  assert.equal((await service.submit(clearRequest, 'admin', principal)).id, clear.id); service.onModuleDestroy(); store = fresh(); await service.processReady(); assert.equal(puts, 1);
  const saved = JSON.parse(fs.readFileSync(ledger, 'utf8')); assert.equal(saved.tasks.length, 3); assert.ok(saved.tasks.every(task => task.lease === null && task.items.every(item => item.state === 'success')));
  service.onModuleDestroy(); assert.equal(service.timer, null); assert.equal(fs.existsSync(`${ledger}.lock`), false); assert.deepEqual(fs.readdirSync(owned).filter(name => name.endsWith('.tmp') || name.endsWith('.lock')), []);
  console.log(JSON.stringify({ status: 'real-custom-get-only-and-preset-clear-passed', startedUtc, endedUtc: new Date().toISOString(), elapsedMs: performance.now() - started, sourceLoadingMs, recordId, recoveredTaskId: customId, clearTaskId: clear.id, originalLedgerSnapshotSha256: beforeSha, observations, requests, actualRecordPuts: puts, actualRecordGets: gets, customPuts: 0, taskCount: saved.tasks.length, pendingTasks: store.listReady().length, activeLeases: 0, lockOrTmpPresent: false, intervalStarted: false, notificationsSent: false, cleanup: 'pending-manual-delete', realPageVerified: false, originalWholePolicyRedAndP95Unresolved: true }));
}
main().catch(error => { if (service) service.onModuleDestroy(); console.error(JSON.stringify({ status: 'real-body-recovery-failed', stage, exceptionClass: error?.constructor?.name || 'unknown', observations, requests, actualRecordPuts: puts, actualRecordGets: gets, elapsedMs: performance.now() - started, cleanup: 'pending-manual-delete' })); process.exitCode = 1; });
