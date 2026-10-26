import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const modulePath = resolve('scripts/verify-contract-storage-startup.mjs');
const key = Buffer.alloc(32, 9).toString('base64');
async function verify(options) {
  assert.ok(existsSync(modulePath), 'readonly startup gate must exist before automatic key recovery is shipped');
  return (await import(pathToFileURL(modulePath))).verifyContractStorageStartup(options);
}
const env = { CONTRACT_ATTACHMENT_ENCRYPTION_KEY: key, COS_SECRET_ID: 'synthetic-id', COS_SECRET_KEY: 'synthetic-secret' };

test('configured old key reads and authenticates index without invoking initialization or persistence', async () => {
  const calls = [];
  const result = await verify({ environment: env, createStorage: () => ({
    indexObjectKey: 'test/metadata/index.vnetc', getStatus: () => ({ configured: true }),
    readEncryptedObject: async (name) => { calls.push(name); return Buffer.from('{"__vnet_contract_storage_index_meta__":{"version":1,"revision":1036},"test":{"state":"ready"}}'); },
    onModuleInit: () => { throw new Error('must not initialize'); }, persistIndex: () => { throw new Error('must not persist'); },
  }) });
  assert.equal(result.status, 'verified-readonly');
  assert.equal(result.revision, 1036);
  assert.deepEqual(calls, ['test/metadata/index.vnetc']);
  assert.equal(JSON.stringify(result).includes(key), false);
});

test('absent optional key does not get generated or initialize storage', async () => {
  let created = false;
  const result = await verify({ environment: {}, createStorage: () => { created = true; } });
  assert.equal(result.status, 'not-configured');
  assert.equal(created, false);
});

test('explicitly disabled storage does not validate inherited key or access any object', async () => {
  let created = false;
  const result = await verify({ environment: { ...env, CONTRACT_ATTACHMENT_ENCRYPTION_KEY: 'unused-invalid-test-key', CONTRACT_ATTACHMENT_STORAGE_ENABLED: 'false' }, createStorage: () => { created = true; } });
  assert.equal(result.status, 'disabled');
  assert.equal(created, false);
});

test('invalid key fails before any storage or network call', async () => {
  let created = false;
  await assert.rejects(verify({ environment: { ...env, CONTRACT_ATTACHMENT_ENCRYPTION_KEY: 'bad' }, createStorage: () => { created = true; } }), /CONTRACT_KEY_INVALID/);
  assert.equal(created, false);
});

for (const [label, error, expected] of [
  ['wrong encryption key', new Error('合同附件密文校验失败'), 'CONTRACT_INDEX_DECRYPT_FAILED'],
  ['forbidden identity', Object.assign(new Error('do not disclose synthetic-secret'), { statusCode: 403 }), 'CONTRACT_INDEX_AUTH_FAILED'],
  ['missing object', Object.assign(new Error('missing'), { statusCode: 404 }), 'CONTRACT_INDEX_MISSING'],
  ['TLS or network error', Object.assign(new Error('private endpoint'), { code: 'CERT_HAS_EXPIRED' }), 'CONTRACT_INDEX_READ_FAILED'],
]) {
  test(`${label} fails closed with a sanitized reason`, async () => {
    await assert.rejects(verify({ environment: env, createStorage: () => ({
      indexObjectKey: 'test/metadata/index.vnetc', getStatus: () => ({ configured: true }),
      readEncryptedObject: async () => { throw error; },
      persistIndex: () => { throw new Error('must not persist'); },
    }) }), new RegExp(expected));
  });
}

test('invalid decrypted index refuses startup rather than initializing a replacement', async () => {
  await assert.rejects(verify({ environment: env, createStorage: () => ({
    indexObjectKey: 'test/metadata/index.vnetc', getStatus: () => ({ configured: true }),
    readEncryptedObject: async () => Buffer.from('[]'),
  }) }), /CONTRACT_INDEX_INVALID/);
});

test('staged gate uses staged candidate code, never installed old code, and reports no secret', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'nt-contract-stage-'));
  try {
    const stage = join(fixture, '.hotfix-stage/test');
    const scripts = join(stage, 'release-root/scripts');
    const relative = 'dist/server/modules/contract-management/contract-attachment-storage.service.js';
    const stagedRuntime = join(stage, relative);
    const oldRuntime = join(fixture, relative);
    mkdirSync(scripts, { recursive: true });
    mkdirSync(dirname(stagedRuntime), { recursive: true });
    mkdirSync(dirname(oldRuntime), { recursive: true });
    writeFileSync(oldRuntime, "throw Error('must not load old runtime');");
    writeFileSync(stagedRuntime, `module.exports.ContractAttachmentStorageService=class { constructor(){this.indexObjectKey='synthetic-index';} getStatus(){return {configured:true};} async readEncryptedObject(){return Buffer.from('{"__vnet_contract_storage_index_meta__":{"revision":55}}');} onModuleInit(){throw Error('must not initialize');} };`);
    writeFileSync(join(fixture, 'package.json'), '{}');
    writeFileSync(join(fixture, '.env'), `CONTRACT_ATTACHMENT_ENCRYPTION_KEY=${key}\nCOS_SECRET_ID=synthetic-id\nCOS_SECRET_KEY=synthetic-secret\n`);
    cpSync(modulePath, join(scripts, 'verify-contract-storage-startup.mjs'));
    const require = createRequire(import.meta.url);
    cpSync(dirname(require.resolve('dotenv/package.json')), join(fixture, 'node_modules/dotenv'), { recursive: true });
    mkdirSync(join(fixture, 'node_modules/reflect-metadata'), { recursive: true });
    writeFileSync(join(fixture, 'node_modules/reflect-metadata/index.js'), 'module.exports={};');
    const result = spawnSync(process.execPath, [join(scripts, 'verify-contract-storage-startup.mjs'), '--root', fixture], { cwd: fixture, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, 'staged candidate readonly gate must pass');
    assert.equal(JSON.parse(result.stdout).revision, 55);
    assert.equal(result.stdout.includes(key), false);
    assert.equal(result.stderr, '');
    writeFileSync(join(fixture, '.env'), 'CONTRACT_ATTACHMENT_ENCRYPTION_KEY=invalid-test-key\n');
    const invalid = spawnSync(process.execPath, [join(scripts, 'verify-contract-storage-startup.mjs'), '--root', fixture], { cwd: fixture, encoding: 'utf8', timeout: 15000 });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /CONTRACT_KEY_INVALID/);
    assert.equal(invalid.stderr.includes('invalid-test-key'), false);
    assert.equal(readFileSync(oldRuntime, 'utf8'), "throw Error('must not load old runtime');");
    cpSync(resolve('scripts/ensure-purchase-inventory-config.mjs'), join(scripts, 'ensure-purchase-inventory-config.mjs'));
    cpSync(resolve('scripts/verify-feishu-access-startup.mjs'), join(scripts, 'verify-feishu-access-startup.mjs'));
    const accessRuntime = join(stage, 'dist/server/common/access/feishu-access.service.js');
    mkdirSync(dirname(accessRuntime), { recursive: true });
    writeFileSync(accessRuntime, 'module.exports.FeishuAccessService=class {};');
    const activation = spawnSync(process.execPath, [join(scripts, 'ensure-purchase-inventory-config.mjs'), '--root', fixture, '--activate-workflow'], { cwd: fixture, encoding: 'utf8', timeout: 15000 });
    assert.equal(activation.status, 1, 'actual activation entry must refuse invalid candidate configuration');
    assert.match(activation.stderr, /CONTRACT_KEY_INVALID.*rejected before downtime/);
    assert.equal(activation.stderr.includes('invalid-test-key'), false);
    assert.equal(existsSync(join(fixture, '.env.local')), false, 'configuration repair must not start after gate failure');
    assert.equal(readFileSync(join(fixture, '.env'), 'utf8'), 'CONTRACT_ATTACHMENT_ENCRYPTION_KEY=invalid-test-key\n');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('installer configuration activation is ordered before stopping the current runtime', () => {
  const installer = readFileSync(resolve('scripts/create-safe-full-runtime-hotfix-package.ps1'), 'utf8');
  const gate = installer.indexOf("Candidate startup configuration preflight failed before downtime.");
  const stop = installer.indexOf('Current runtime stopped in');
  assert.ok(gate > 0 && stop > gate);
  assert.ok(installer.includes("'scripts/verify-contract-storage-startup.mjs' = 'scripts/verify-contract-storage-startup.mjs'"));
});

test('archive preflight loads without dependencies beside the extracted release scripts', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'nt-contract-archive-'));
  try {
    const scripts = join(fixture, 'candidate/release-root/scripts');
    const runtime = join(fixture, 'candidate/dist/server/modules/contract-management/contract-attachment-storage.service.js');
    const app = join(fixture, 'app');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(dirname(runtime), { recursive: true });
    mkdirSync(app);
    writeFileSync(runtime, "throw Error('disabled storage must not load');");
    writeFileSync(join(app, '.env'), '\uFEFFCONTRACT_ATTACHMENT_STORAGE_ENABLED="false" # disabled\n');
    cpSync(modulePath, join(scripts, 'verify-contract-storage-startup.mjs'));
    const result = spawnSync(process.execPath, [join(scripts, 'verify-contract-storage-startup.mjs'), '--root', app], { cwd: app, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'disabled');
    assert.equal(existsSync(join(fixture, 'node_modules')), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
