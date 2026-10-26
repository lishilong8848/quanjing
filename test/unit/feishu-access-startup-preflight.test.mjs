import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const script = path.join(root, 'scripts/verify-feishu-access-startup.mjs');
test('activation checks candidate access configuration before contract/network checks', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/ensure-purchase-inventory-config.mjs'), 'utf8');
  assert.ok(source.includes('await verifyFeishuAccessStartupAtRoot(options.root)'), 'missing candidate access pre-stop gate');
  assert.ok(source.indexOf('await verifyFeishuAccessStartupAtRoot(options.root)') < source.indexOf('await verifyContractStartupAtRoot(options.root)'));
  assert.ok(fs.readFileSync(path.join(root, 'scripts/create-safe-full-runtime-hotfix-package.ps1'), 'utf8').includes("'scripts/verify-feishu-access-startup.mjs' = 'scripts/verify-feishu-access-startup.mjs'"));
});
test('real candidate constructor: invalid flag and duplicate roles fail without network or writes', async () => {
  if (!fs.existsSync(script)) { assert.fail('missing readonly access checker'); }
  const { verifyFeishuAccessStartupAtRoot } = await import(pathToFileURL(script));
  const require = createRequire(path.join(root, 'package.json'));
  const ts = require('typescript');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-access-preflight-'));
  try {
    for (const relative of ['server/common/access/feishu-access.service.ts', 'server/common/access/feishu-access-approved-grants.ts', 'shared/access-control.interface.ts']) {
      const target = path.join(fixture, 'dist', relative.replace(/\.ts$/, '.js'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true } }).outputText);
    }
    fs.writeFileSync(path.join(fixture, 'package.json'), '{}');
    const options = { scriptRoot: fixture, dependencyRoot: path.join(root, 'node_modules'), environment: {} };
    fs.writeFileSync(path.join(fixture, '.env'), 'FEISHU_APP_ID=cli_test\nFEISHU_ACCESS_APPROVED_GRANTS_ENABLED=true\n');
    const before = fs.readFileSync(path.join(fixture, '.env'));
    assert.deepEqual(await verifyFeishuAccessStartupAtRoot(fixture, options), { status: 'verified-readonly', readonly: true, writes: 0, networkCalls: 0 });
    fs.writeFileSync(path.join(fixture, '.env.local'), 'FEISHU_ACCESS_APPROVED_GRANTS_ENABLED=unexpected\n');
    await assert.rejects(verifyFeishuAccessStartupAtRoot(fixture, options), /FEISHU_ACCESS_CONFIGURATION_INVALID/);
    fs.writeFileSync(path.join(fixture, '.env.local'), 'FEISHU_ACCESS_ADMIN_OPEN_IDS=ou_test\nFEISHU_ACCESS_EDITOR_OPEN_IDS=ou_test\n');
    await assert.rejects(verifyFeishuAccessStartupAtRoot(fixture, options), /FEISHU_ACCESS_CONFIGURATION_INVALID/);
    fs.writeFileSync(path.join(fixture, '.env.local'), 'FEISHU_ACCESS_APPROVED_GRANTS_ENABLED=false\n');
    assert.equal((await verifyFeishuAccessStartupAtRoot(fixture, options)).status, 'verified-readonly');
    assert.deepEqual(fs.readFileSync(path.join(fixture, '.env')), before);
    assert.equal(fs.existsSync(path.join(fixture, '.runtime')), false);
    await assert.rejects(verifyFeishuAccessStartupAtRoot(fixture, { ...options, scriptRoot: path.join(fixture, 'missing-stage/release-root') }), /FEISHU_ACCESS_CANDIDATE_RUNTIME_MISSING/);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
