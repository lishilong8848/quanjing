'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'output/release-next-after-20261005-182903');
const manifestPath = path.join(output, 'alarm-review-live-record-owned-20261006.json');
const owned = path.join(output, 'alarm-review-live-owned-20261006-f9b9836f');
const title = 'TEST-异常复核-20261006-f9b9836f';
const base = 'JeMdbI3JjawMj1s1YGSc3MoBn7c', table = 'tbld976fa6fc1832';
const personId = 'recuSBqPEuWsww', openId = 'PUBLIC_EXAMPLE_FEISHU_TYPHOON_PATH_TEST_OPEN_ID';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
let service, stage = 'authorization', phase = '', fields, injected = false, puts = 0, gets = 0;
const started = performance.now(), startedUtc = new Date().toISOString();
const observations = [], taskIds = [];
async function main() {
  assert.equal(process.argv.length, 5); assert.equal(process.argv[2], '--approved-live');
  const recordId = process.argv[3]; assert.match(recordId, /^rec[A-Za-z0-9]+$/); assert.match(process.argv[4], /^[a-f0-9]{64}$/);
  const manifestBytes = fs.readFileSync(manifestPath); assert.equal(sha(manifestBytes), process.argv[4]);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.created, true); assert.equal(manifest.createdCount, 1); assert.equal(manifest.recordId, recordId);
  assert.equal(manifest.title, title); assert.equal(manifest.baseToken, base); assert.equal(manifest.tableId, table);
  assert.equal(fs.existsSync(owned), false, 'Owned ledger directory already exists; no rerun');
  stage = 'source-loading';
  require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
  assert.equal(process.env.FEISHU_APP_ID, 'cli_0831564613853b26'); assert.ok(process.env.FEISHU_APP_SECRET);
  assert.ok(!process.env.TODAY_OPERATIONS_ALARM_BITABLE_URL);
  for (const key of ['TODAY_OPERATIONS_ALARM_FEISHU_APP_ID', 'FEISHU_RISK_INSPECTION_APP_ID', 'ALI_MONTHLY_REPORT_FEISHU_APP_ID']) assert.ok(!process.env[key]);
  process.env.FEISHU_LOCAL_CACHE_DIR = path.join(owned, 'cache'); process.env.DISABLE_V8_COMPILE_CACHE = '1';
  require('reflect-metadata');
  require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs', moduleResolution: 'node', esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true } });
  require('tsconfig-paths').register({ baseUrl: root, paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] } });
  const load = file => require(path.join(root, file));
  const { AlarmReviewService } = load('server/modules/bitable-sync/alarm-review.service.ts');
  const { AlarmReviewStore } = load('server/modules/bitable-sync/alarm-review.store.ts');
  const { AlarmReviewGateway } = load('server/modules/bitable-sync/alarm-review.gateway.ts');
  const { reviewVersion, reviewMatches } = load('server/modules/bitable-sync/alarm-review.rules.ts');
  const { extractDisplayText } = load('server/common/feishu/bitable-direct-read.ts');
  const { HttpService } = require('@nestjs/axios'), axios = require('axios');
  const sourceLoadingMs = performance.now() - started;
  const recordUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables/${table}/records/${recordId}`;
  const fieldsUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables/${table}/fields`;
  const client = axios.create({ timeout: 8000 }); let ownershipRead = false;
  client.interceptors.request.use(config => {
    const method = (config.method || 'get').toLowerCase(), url = config.url;
    if (method === 'post' && url === 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal') { assert.equal(config.data.app_id, 'cli_0831564613853b26'); return config; }
    if (method === 'get' && url === 'https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node') { assert.equal(config.params.token, 'SOwsw315aiBJjgkl48ccoxIPntc'); return config; }
    if (method === 'get' && url === fieldsUrl) return config;
    assert.equal(url, recordUrl, 'Only newly owned record may be accessed');
    if (method === 'get') {
      if (phase === 'custom-fail' && !injected) { injected = true; throw new Error('TEST transport failure before sending record GET'); }
      gets++; return config;
    }
    assert.equal(method, 'put'); assert.equal(ownershipRead, true);
    assert.deepEqual(Object.keys(config.data.fields).sort(), ['人工复核结果', '复核回复', '复核示例人员019'].sort());
    assert.deepEqual(config.data.fields.复核示例人员019, [{ id: openId }]); puts++; return config;
  });
  client.interceptors.response.use(response => {
    if (response.config.url === recordUrl && response.config.method === 'get' && response.data?.code === 0) {
      assert.equal(response.data.data.record.record_id, recordId);
      const value = response.data.data.record.fields;
      assert.equal(extractDisplayText(value.告警内容).trim(), title); assert.equal(extractDisplayText(value.受理描述).trim(), 'TEST原受理描述不得改变'); assert.equal(extractDisplayText(value.确认描述).trim(), 'TEST原确认描述不得改变');
      ownershipRead = true;
    }
    return response;
  });
  const ledger = path.join(owned, 'ledger.json'), principal = 'TEST-alarm-review-20261006-f9b9836f';
  const people = { getCachedActivePersonnelDirectory: async () => ({ personnel: [{ recordId: personId, openId, name: '示例人员020', position: '', buildings: [] }] }) };
  const alarms = { patchHumanReview: (id, value) => { assert.equal(id, recordId); fields = value; } };
  const fresh = () => { const store = new AlarmReviewStore(ledger); service = new AlarmReviewService(store, new AlarmReviewGateway(new HttpService(client)), people, alarms); return store; };
  const request = (suffix, outcome, customReply) => ({ recordIds: [recordId], outcome, responsibleRecordId: personId, clientMutationId: `alarm-review-live20261006-f9b9836f-${suffix}`, expectedVersions: { [recordId]: fields ? reviewVersion(fields) : 'unreviewed' }, ...(customReply ? { customReply } : {}) });
  let store = fresh();
  async function submitSame(input) { const first = await service.submit(input, 'admin', principal); const again = await service.submit(input, 'admin', principal); assert.equal(first.id, again.id); taskIds.push(first.id); return first; }
  async function successful(task, outcome, reply, expectedPuts) {
    await service.processReady(); const status = service.status(task.id, 'admin', principal); assert.equal(status.items.length, 1); assert.equal(status.items[0].state, 'success');
    assert.ok(reviewMatches(fields, outcome, openId, reply)); assert.equal(puts, expectedPuts);
    observations.push({ phase, state: 'success', semanticReadback: true, originalDescriptionsPreserved: true, puts });
  }
  stage = phase = 'preset-pending-restart';
  const presetRequest = request('preset', '人工复核无问题'), preset = await submitSame(presetRequest);
  service.onModuleDestroy(); store = fresh(); assert.equal(service.recover(preset.clientMutationId, 'admin', principal).id, preset.id);
  await successful(preset, '人工复核无问题', undefined, 1);
  assert.equal((await service.submit(presetRequest, 'admin', principal)).id, preset.id); await service.processReady(); assert.equal(puts, 1);
  stage = phase = 'custom-fail'; const reply = 'TEST自定义回复：已核对，待现场复查。';
  const custom = await submitSame(request('custom', '自定义回复', reply)); await service.processReady();
  assert.equal(service.status(custom.id, 'admin', principal).items[0].state, 'error'); assert.equal(puts, 1); assert.equal(injected, true);
  observations.push({ phase, state: 'expected-injected-error-before-send', puts });
  service.onModuleDestroy(); store = fresh(); stage = phase = 'custom-restart-retry';
  assert.equal(service.recover(custom.clientMutationId, 'admin', principal).customReply, reply); service.retry(custom.id, 'admin', principal);
  await successful(custom, '自定义回复', reply, 2);
  service.onModuleDestroy(); store = fresh(); await service.processReady(); assert.equal(puts, 2);
  stage = phase = 'preset-clear'; const clear = await submitSame(request('clear', '已通知现场跟进'));
  await successful(clear, '已通知现场跟进', undefined, 3);
  const saved = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.equal(saved.tasks.length, 3); assert.ok(saved.tasks.every(task => task.lease === null && task.items.every(item => item.state === 'success')));
  service.onModuleDestroy(); assert.equal(service.timer, null); assert.equal(fs.existsSync(`${ledger}.lock`), false);
  assert.deepEqual(fs.readdirSync(owned).filter(name => name.endsWith('.tmp') || name.endsWith('.lock')), []);
  console.log(JSON.stringify({ status: 'real-business-semantic-passed-cleanup-pending-manual-delete', startedUtc, endedUtc: new Date().toISOString(), elapsedMs: performance.now() - started, sourceLoadingMs, recordId, title, taskIds, observations, actualRecordPuts: puts, actualRecordGets: gets, ownedLedger: ledger, taskCount: saved.tasks.length, pendingTasks: store.listReady().length, activeLeases: 0, ledgerLockPresent: false, intervalStarted: false, notificationsSent: false, originalLedgerAccessed: false, realPageVerified: false, cleanup: 'pending-manual-delete', originalWholePolicyRedAndP95Unresolved: true }));
}
main().catch(error => { if (service) service.onModuleDestroy(); console.error(JSON.stringify({ status: 'real-business-semantic-failed', stage, exceptionClass: error?.constructor?.name || 'unknown', recordId: process.argv[3], actualRecordPuts: puts, actualRecordGets: gets, injectedTransportFailure: injected, elapsedMs: performance.now() - started, cleanup: 'pending-manual-delete', directoryRetained: fs.existsSync(owned) })); process.exitCode = 1; });
