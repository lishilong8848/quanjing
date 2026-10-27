'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const preparedPath = path.join(root, 'output/release-next-after-20261005-182903/alarm-review-real-entry-version-contract-prepared-20261006-v1.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const prepared = JSON.parse(fs.readFileSync(preparedPath, 'utf8'));
assert.equal(sha(process.execPath), prepared.node.sha256, 'ACTUAL_NODE_DRIFT');
for (const file of [__filename, path.join(__dirname, 'server.cjs'), path.join(root, 'server/modules/bitable-sync/alarm-review.rules.ts')]) {
  const item = prepared.inputs.find(value => path.resolve(root, value.file) === file);
  assert(item, 'VERSION_CONTRACT_INPUT_NOT_BOUND'); assert.equal(sha(file), item.sha256, 'VERSION_CONTRACT_INPUT_DRIFT');
}
const began = Date.now();
for (const key of Object.keys(process.env)) if (!['SystemRoot', 'WINDIR', 'PATH'].includes(key)) delete process.env[key];
process.env.DISABLE_V8_COMPILE_CACHE = '1';
let networkRejected = 0, writesRejected = 0;
const denyNetwork = () => { networkRejected++; throw new Error('PURE_NETWORK_FORBIDDEN'); };
const denyWrite = () => { writesRejected++; throw new Error('PURE_WRITE_FORBIDDEN'); };
for (const api of ['http', 'https']) { const module = require('node:' + api); module.request = denyNetwork; module.get = denyNetwork; module.createServer = denyNetwork; }
for (const api of ['net', 'tls']) { const module = require('node:' + api); module.connect = denyNetwork; module.createConnection = denyNetwork; module.createServer = denyNetwork; }
require('node:dgram').createSocket = denyNetwork;
globalThis.fetch = denyNetwork;
const cp = require('node:child_process');
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = denyNetwork;
for (const key of ['writeFileSync', 'appendFileSync', 'writeSync', 'mkdirSync', 'unlinkSync', 'rmdirSync', 'truncateSync', 'chmodSync', 'renameSync', 'rmSync', 'copyFileSync', 'cpSync', 'linkSync', 'symlinkSync', 'writeFile', 'appendFile', 'write', 'mkdir', 'unlink', 'rmdir', 'rm', 'rename', 'truncate', 'chmod', 'copyFile', 'cp', 'link', 'symlink', 'createWriteStream', 'mkdtemp', 'mkdtempSync']) if (fs[key]) fs[key] = denyWrite;
for (const key of ['writeFile', 'appendFile', 'mkdir', 'unlink', 'rmdir', 'rm', 'rename', 'truncate', 'chmod', 'copyFile', 'cp', 'link', 'symlink', 'mkdtemp']) if (fs.promises[key]) fs.promises[key] = async () => denyWrite();
const writing = flags => typeof flags === 'number'
  ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
  : /[wa+]/.test(flags);
const openSync = fs.openSync; fs.openSync = function(file, flags, ...args) { if (writing(flags)) denyWrite(); return openSync.call(this, file, flags, ...args); };
const open = fs.open; fs.open = function(file, flags, ...args) { if (writing(flags)) denyWrite(); return open.call(this, file, flags, ...args); };
const promiseOpen = fs.promises.open; fs.promises.open = async function(file, flags, ...args) { if (writing(flags)) denyWrite(); return promiseOpen.call(this, file, flags, ...args); };
require('reflect-metadata');
require('ts-node').register({ skipProject: true, transpileOnly: true, compilerOptions: { module: 'commonjs', moduleResolution: 'node', experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true } });
require('tsconfig-paths').register({ baseUrl: root, paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] } });
const rules = require(path.join(root, 'server/modules/bitable-sync/alarm-review.rules.ts'));
const loadedApplicationFiles = Object.keys(require.cache).filter(file => file.startsWith(path.join(root, 'server') + path.sep) || file.startsWith(path.join(root, 'shared') + path.sep)).map(file => path.relative(root, file).replace(/\\/g, '/')).sort();
const expectedApplicationFiles = ['server/common/config/external-services.config.ts', 'server/common/feishu/bitable-direct-read.ts', 'server/modules/bitable-sync/alarm-review.rules.ts', 'shared/today-operations-alarm-review.interface.ts'].sort();
assert.deepEqual(loadedApplicationFiles, expectedApplicationFiles, 'PURE_APPLICATION_IMPORT_BOUNDARY');
const fields = { 人工复核结果: '自定义回复', 复核回复: '合成复核结论：已经核查，待现场确认。', 复核责任人: [{ id: 'recSyntheticPersonA' }] };
const body = { recordIds: ['recSyntheticAlarmA', 'recSyntheticAlarmB'], outcome: '自定义回复', customReply: fields.复核回复, responsibleRecordId: 'recSyntheticPersonA', clientMutationId: 'alarm-review-contract00000001', expectedVersions: { recSyntheticAlarmA: 'synthetic-reviewed', recSyntheticAlarmB: 'unreviewed' } };
assert.throws(() => rules.normalizeAlarmReviewRequest(body), error => error.getStatus() === 400 && error.message === '复核清单已变化，请重新打开后提交');
const version = rules.reviewVersion(fields);
assert.match(version, /^[a-f0-9]{64}$/);
const accepted = rules.normalizeAlarmReviewRequest({ ...body, expectedVersions: { ...body.expectedVersions, recSyntheticAlarmA: version } });
assert.equal(accepted.expectedVersions.recSyntheticAlarmA, version);
assert.equal(accepted.expectedVersions.recSyntheticAlarmB, 'unreviewed');
assert.equal(accepted.recordIds.length, 2);
assert.equal(networkRejected, 0); assert.equal(writesRejected, 0);
console.log(JSON.stringify({ status: 'actual-version-contract-pure-passed', preparedSha256: sha(preparedPath), nodeSha256: sha(process.execPath), toolSha256: sha(__filename), invalidSyntheticVersionRejected400: true, actualReviewVersionAccepted: true, loadedApplicationFiles, networkRejected, writesRejected, serviceStarted: false, browserExecuted: false, compilerExecuted: false, elapsedMs: Date.now()-began }));
