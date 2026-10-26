import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  copyFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const checker = join(
  root,
  'scripts/ensure-inventory-outbound-approval-fields.mjs',
);
const preflight = join(root, 'scripts/ensure-purchase-inventory-config.mjs');
const fields = [
  [
    '出库工作流状态',
    3,
    {
      options: ['待路由', '待审批', '已通过', '已驳回', '同步异常'].map(
        (name) => ({ name }),
      ),
    },
  ],
  ['出库当前审批人', 11, { multiple: true }],
  ['出库实际审批人', 11, { multiple: false }],
  ['出库审批时间', 5],
  ...[
    '出库审批策略版本',
    '出库驳回原因',
    '出库审批动作标识',
    '出库工作流错误',
    '出库审批快照',
    '出库审批投递台账',
  ].map((name) => [name, 1]),
  [
    '出库审批收尾状态',
    3,
    { options: ['待收尾', '已完成'].map((name) => ({ name })) },
  ],
  ['出库审批结果投递台账', 1],
].map(([field_name, type, property]) => ({ field_name, type, property }));

async function fixture(t, handler) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ method: req.method, path: req.url });
    if (req.url.endsWith('/auth/v3/tenant_access_token/internal')) {
      return send(res, 200, {
        code: 0,
        tenant_access_token: 'test-tenant-secret',
      });
    }
    handler(req, res, calls);
  });
  await new Promise((resolveListen) =>
    server.listen(0, '127.0.0.1', resolveListen),
  );
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const env = {
    ...process.env,
    FEISHU_APP_ID: 'cli_fixture_app',
    FEISHU_APP_SECRET: 'fixture-secret',
    FEISHU_WAREHOUSE_APP_TOKEN: 'fixture-base',
    FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID: 'tblf193d86c22a1056',
    LARK_OPENAPI_BASE_URL: `http://127.0.0.1:${server.address().port}/open-apis`,
  };
  // No real configuration, proxy, application state or preload reaches the child.
  for (const key of Object.keys(env)) {
    if (
      /^(CONTRACT_|COS_|TENCENTCLOUD_|NODE_OPTIONS|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)/i.test(
        key,
      )
    )
      delete env[key];
    if (
      /^(FEISHU_|PURCHASE_)/.test(key) &&
      ![
        'FEISHU_APP_ID',
        'FEISHU_APP_SECRET',
        'FEISHU_WAREHOUSE_APP_TOKEN',
        'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID',
      ].includes(key)
    )
      delete env[key];
  }
  env.CONTRACT_ATTACHMENT_STORAGE_ENABLED = 'false';
  return { env, calls };
}

function send(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

async function run(script, args, env, executable = process.execPath) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, [script, ...args], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

function fieldReads(calls) {
  return calls.filter((call) =>
    call.path.includes('/tblf193d86c22a1056/fields'),
  );
}
function assertReadOnly(calls) {
  assert.ok(
    calls.every(
      (call) =>
        call.method === 'GET' ||
        call.path.endsWith('/auth/v3/tenant_access_token/internal'),
    ),
  );
}

test('transient HTTP503 retries a read and recovers without writes', async (t) => {
  let attempts = 0;
  const f = await fixture(t, (req, res) => {
    if (++attempts === 1) return send(res, 503, { msg: 'unavailable' });
    send(res, 200, { code: 0, data: { items: fields } });
  });
  const result = await run(checker, ['--dry-run', '--require-ready'], f.env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fieldReads(f.calls).length, 2);
  assert.match(result.stderr, /retry.*attempt=1\/3/);
  assertReadOnly(f.calls);
});

test('AbortSignal timeout is retried with its name rather than numeric DOMException code', async (t) => {
  const f = await fixture(t, () => {});
  const app = await mkdtemp(join(tmpdir(), 'nt-outbound-timeout-'));
  t.after(() => rm(app, { recursive: true, force: true }));
  const preload = join(app, 'short-timeout.mjs');
  await writeFile(
    preload,
    'const original = AbortSignal.timeout; AbortSignal.timeout = ms => original(ms === 15000 ? 200 : ms);',
  );
  const result = await run(
    '--import',
    [pathToFileURL(preload).href, checker, '--dry-run', '--require-ready'],
    f.env,
  );
  assert.equal(result.code, 1);
  assert.equal(fieldReads(f.calls).length, 3);
  assert.match(result.stderr, /cause=TimeoutError/);
  assertReadOnly(f.calls);
});

test('ready outbound gate passes full activation without changing environment or writing remote business data', async (t) => {
  const f = await fixture(t, (req, res) =>
    send(res, 200, {
      code: 0,
      data: {
        items: req.url.includes('/tblf193d86c22a1056/fields')
          ? fields
          : ['楼栋', '库房示例人员019员', '库房管理人'].map((field_name) => ({
              field_name,
              type: 1,
            })),
      },
    }),
  );
  const app = await mkdtemp(join(tmpdir(), 'nt-outbound-ready-'));
  t.after(() => rm(app, { recursive: true, force: true }));
  const environment = {
    ...f.env,
    CONTRACT_ATTACHMENT_STORAGE_ENABLED: 'false',
    ...Object.fromEntries(
      [
        'FEISHU_PURCHASE_INVENTORY_APP_TOKEN',
        'FEISHU_PURCHASE_SUBMISSION_TABLE_ID',
        'FEISHU_PURCHASE_EXECUTION_TABLE_ID',
        'FEISHU_ITEM_CATEGORY_TABLE_ID',
        'FEISHU_INVENTORY_LEDGER_TABLE_ID',
        'FEISHU_INBOUND_TABLE_ID',
        'FEISHU_OUTBOUND_TABLE_ID',
      ].map((key) => [key, 'tble3a9d2db4eecf8086']),
    ),
    PURCHASE_MANAGER_APPROVER_OPEN_ID: 'ou_fixture_manager',
    FEISHU_PURCHASE_ORGANIZATION_TABLE_ID: 'tbl70a37a14162e0978006',
    PURCHASE_WORKFLOW_APPROVER_OPEN_IDS: 'ou_fixture_first,ou_fixture_second',
    PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID: 'ou_fixture_admin',
    FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN: 'fixture-verification',
    FEISHU_PURCHASE_CARD_ENCRYPT_KEY: 'fixture-encryption',
    PUBLIC_BASE_URL: 'https://ops.example.com',
    FEISHU_WAREHOUSE_MANAGER_APP_TOKEN: 'fixture-manager-base',
    FEISHU_WAREHOUSE_MANAGER_TABLE_ID: 'tbl49cc42318f7ed4',
  };
  const original =
    Object.entries(environment)
      .filter(([key]) =>
        /^(FEISHU_|PURCHASE_|LARK_|CONTRACT_|PUBLIC_)/.test(key),
      )
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n';
  await writeFile(join(app, '.env'), original);
  const result = await run(
    preflight,
    [
      '--root',
      app,
      '--activate-workflow',
      '--api-base-url',
      f.env.LARK_OPENAPI_BASE_URL,
    ],
    environment,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /schema is ready before downtime/);
  assert.match(result.stdout, /activation is ready/);
  assert.equal(await readFile(join(app, '.env'), 'utf8'), original);
  assertReadOnly(f.calls);
});

test('PowerShell5 actual installer preflight captures UTF8 schema error and rejects before the next stop step', async (t) => {
  const f = await fixture(t, (req, res) =>
    send(res, 200, { code: 0, data: { items: [] } }),
  );
  const app = await mkdtemp(join(tmpdir(), 'nt-outbound-ps5-'));
  t.after(() => rm(app, { recursive: true, force: true }));
  await writeFile(
    join(app, '.env'),
    'CONTRACT_ATTACHMENT_STORAGE_ENABLED=false\n',
  );
  const installer = await readFile(
    join(root, 'scripts/create-safe-full-runtime-hotfix-package.ps1'),
    'utf8',
  );
  const start = installer.indexOf(
    'function Invoke-CandidateStartupConfigurationPreflight {',
  );
  const end = installer.indexOf(
    'function Assert-DependencyProofMatchesManifest {',
    start,
  );
  assert.ok(start > 0 && end > start);
  const actualCall = installer.lastIndexOf(
    '  Invoke-CandidateStartupConfigurationPreflight `',
  );
  const stop = installer.indexOf(
    '    Stop-AppProcesses -Root $appRootPath',
    actualCall,
  );
  assert.ok(actualCall > end && stop > actualCall);
  const quote = (text) => "'" + text.replaceAll("'", "''") + "'";
  const ps =
    `\uFEFF$ErrorActionPreference='Stop'\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n` +
    `function Get-TrustedHotfixNodeExecutable { param($Root) return ${quote(process.execPath)} }\n` +
    'function Assert-PathHasNoReparsePointAncestors { param($Path) }\nfunction Assert-FinalPathContainedByRoot { param($Root,$Path) }\nfunction Assert-NoAlternateDataStreamsAtPath { param($Path) }\n' +
    installer.slice(start, end) +
    '\n' +
    `try { Invoke-CandidateStartupConfigurationPreflight -Root ${quote(app)} -StageReleaseRoot ${quote(root)}; Write-Host 'UNSAFE_STOP_REACHED'; exit 0 } catch { Write-Host $_.Exception.Message; exit 1 }\n`;
  const script = join(app, 'test-prestop.ps1');
  await writeFile(script, ps);
  const result = await run(
    '-NoProfile',
    ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    f.env,
    'powershell.exe',
  );
  assert.equal(result.code, 1);
  assert.match(result.stdout, /OUTBOUND_PREFLIGHT_SCHEMA/);
  assert.match(result.stdout, /出库工作流状态/);
  assert.match(result.stdout, /preflight failed before downtime/);
  assert.ok(!result.stdout.includes('UNSAFE_STOP_REACHED'));
  assertReadOnly(f.calls);
});

test('persistent transient failure stops after exactly three attempts with cause and elapsed time', async (t) => {
  const f = await fixture(t, (req, res) =>
    send(res, 503, { msg: 'unavailable' }),
  );
  const result = await run(checker, ['--dry-run', '--require-ready'], f.env);
  assert.equal(result.code, 1);
  assert.equal(fieldReads(f.calls).length, 3);
  assert.match(result.stderr, /OUTBOUND_PREFLIGHT_HTTP/);
  assert.match(result.stderr, /http=503/);
  assert.match(result.stderr, /elapsedMs=\d+/);
  assertReadOnly(f.calls);
});

test('socket reset retains a safe cause and retries only readonly requests', async (t) => {
  const f = await fixture(t, (req, res) => req.socket.destroy());
  const result = await run(checker, ['--dry-run', '--require-ready'], f.env);
  assert.equal(result.code, 1);
  assert.equal(fieldReads(f.calls).length, 3);
  assert.match(result.stderr, /OUTBOUND_PREFLIGHT_NETWORK/);
  assert.match(result.stderr, /UND_ERR_SOCKET|ECONNRESET/);
  assertReadOnly(f.calls);
});

test('permission failure is not retried and echoed secrets are redacted', async (t) => {
  const f = await fixture(t, (req, res) =>
    send(res, 403, {
      code: 99991672,
      msg: 'fixture-secret test-tenant-secret cli_fixture_app fixture-base tblf193d86c22a1056 forbidden',
    }),
  );
  const result = await run(checker, ['--dry-run', '--require-ready'], f.env);
  assert.equal(result.code, 1);
  assert.equal(fieldReads(f.calls).length, 1);
  assert.match(result.stderr, /http=403.*code=99991672/);
  for (const secret of [
    'fixture-secret',
    'test-tenant-secret',
    'cli_fixture_app',
    'fixture-base',
    'tblf193d86c22a1056',
  ])
    assert.ok(!result.stderr.includes(secret));
});

test('even short credential values cannot be echoed in API failure messages', async (t) => {
  const f = await fixture(t, (req, res) =>
    send(res, 403, { code: 99991672, msg: 'secret=xy forbidden' }),
  );
  const result = await run(checker, ['--dry-run', '--require-ready'], {
    ...f.env,
    FEISHU_APP_SECRET: 'xy',
  });
  assert.equal(result.code, 1);
  assert.ok(!result.stderr.includes('xy'));
});

test('apply field creation is never retried even on HTTP503', async (t) => {
  const f = await fixture(t, (req, res) =>
    req.method === 'POST'
      ? send(res, 503, { msg: 'unavailable' })
      : send(res, 200, { code: 0, data: { items: [] } }),
  );
  const result = await run(checker, ['--apply'], f.env);
  assert.equal(result.code, 1);
  assert.equal(
    f.calls.filter(
      (call) => call.method === 'POST' && call.path.includes('/fields'),
    ).length,
    1,
  );
});

test('enabled outbound gate rejects missing fields in candidate preflight before configuration mutation', async (t) => {
  const f = await fixture(t, (req, res) =>
    send(res, 200, { code: 0, data: { items: [] } }),
  );
  const app = await mkdtemp(join(tmpdir(), 'nt-outbound-prestop-'));
  t.after(() => rm(app, { recursive: true, force: true }));
  const original =
    Object.entries(f.env)
      .filter(([key]) => /^(FEISHU_|LARK_OPENAPI_)/.test(key))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n';
  await writeFile(join(app, '.env'), original);
  const result = await run(
    preflight,
    [
      '--root',
      app,
      '--activate-workflow',
      '--api-base-url',
      f.env.LARK_OPENAPI_BASE_URL,
    ],
    f.env,
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /OUTBOUND_PREFLIGHT_SCHEMA/);
  assert.match(result.stderr, /before downtime/);
  assert.match(result.stderr, /出库工作流状态/);
  assert.equal(fieldReads(f.calls).length, 1);
  assert.equal(await readFile(join(app, '.env'), 'utf8'), original);
  assertReadOnly(f.calls);
});

test('startup failures do not universally recommend field migration', async () => {
  for (const relative of ['deploy/start.ps1', 'start.ps1']) {
    const source = await readFile(join(root, relative), 'utf8');
    const gate = source.slice(
      source.indexOf('function Assert-InventoryOutboundApprovalSchema'),
      source.indexOf('function Assert-InventoryOutboundApprovalSchema') + 2200,
    );
    assert.ok(
      !gate.includes(
        '[ERROR] Run: npm run migrate:inventory-outbound-approval-fields',
      ),
    );
    assert.match(gate, /read-only.*failed|failed.*read-only/i);
  }
});

test('non-JSON gateway HTTP503 still retries as HTTP, not a permanent JSON error', async (t) => {
  let attempts = 0;
  const f = await fixture(t, (req, res) => {
    if (++attempts === 1) {
      res.writeHead(503);
      return res.end('<html>unavailable</html>');
    }
    send(res, 200, { code: 0, data: { items: fields } });
  });
  const result = await run(checker, ['--dry-run', '--require-ready'], f.env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fieldReads(f.calls).length, 2);
});

test('long rate-limit window is rejected without retrying early or leaking credentials', async (t) => {
  const f = await fixture(t, (req, res) =>
    send(
      res,
      429,
      { code: 99991400, msg: 'limited' },
      { 'x-ogw-ratelimit-reset': '52' },
    ),
  );
  const result = await run(checker, ['--dry-run', '--require-ready'], f.env);
  assert.equal(result.code, 1);
  assert.equal(fieldReads(f.calls).length, 1);
  assert.match(result.stderr, /code=99991400/);
});

test('HTTP-date Retry-After is respected rather than retried early', async (t) => {
  const f = await fixture(t, (req, res) =>
    send(
      res,
      429,
      { code: 99991400, msg: 'limited' },
      { 'Retry-After': new Date(Date.now() + 60000).toUTCString() },
    ),
  );
  const result = await run(checker, ['--dry-run', '--require-ready'], f.env);
  assert.equal(result.code, 1);
  assert.equal(fieldReads(f.calls).length, 1);
});

test('missing and incompatible schemas never retry or mutate fields', async (t) => {
  for (const actual of [[], [{ ...fields[0], type: 1 }, ...fields.slice(1)]]) {
    const f = await fixture(t, (req, res) =>
      send(res, 200, { code: 0, data: { items: actual } }),
    );
    const result = await run(checker, ['--dry-run', '--require-ready'], f.env);
    assert.equal(result.code, 1);
    assert.equal(fieldReads(f.calls).length, 1);
    assert.match(result.stderr, /OUTBOUND_PREFLIGHT_SCHEMA/);
    assertReadOnly(f.calls);
  }
});

test('candidate staged checker is used instead of old installed checker and .env.local overrides process values', async (t) => {
  const f = await fixture(t, (req, res) =>
    send(res, 200, { code: 0, data: { items: [] } }),
  );
  const parent = await mkdtemp(join(tmpdir(), 'nt-outbound-stage-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const app = join(parent, 'app'),
    scripts = join(parent, 'stage/release-root/scripts');
  await mkdir(join(app, 'scripts'), { recursive: true });
  await mkdir(scripts, { recursive: true });
  const runtime = join(parent, 'stage/dist/server/modules/contract-management');
  await mkdir(runtime, { recursive: true });
  await writeFile(
    join(runtime, 'contract-attachment-storage.service.js'),
    "throw Error('disabled contract storage must not load')",
  );
  for (const name of [
    'ensure-purchase-inventory-config.mjs',
    'ensure-inventory-outbound-approval-fields.mjs',
    'verify-contract-storage-startup.mjs',
    'verify-feishu-access-startup.mjs',
  ])
    await copyFile(join(root, 'scripts', name), join(scripts, name));
  const accessRuntime = join(parent, 'stage/dist/server/common/access');
  await mkdir(accessRuntime, { recursive: true });
  await writeFile(join(accessRuntime, 'feishu-access.service.js'), 'module.exports.FeishuAccessService=class {};');
  await writeFile(
    join(app, 'scripts/ensure-inventory-outbound-approval-fields.mjs'),
    "throw Error('must not use installed checker')",
  );
  await writeFile(
    join(app, '.env'),
    'CONTRACT_ATTACHMENT_STORAGE_ENABLED=false\nFEISHU_WAREHOUSE_OUTBOUND_TABLE_ID=tblWrong\n',
  );
  await writeFile(
    join(app, '.env.local'),
    'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID="tblf193d86c22a1056" # local override\n',
  );
  const result = await run(
    join(scripts, 'ensure-purchase-inventory-config.mjs'),
    [
      '--root',
      app,
      '--activate-workflow',
      '--api-base-url',
      f.env.LARK_OPENAPI_BASE_URL,
    ],
    { ...f.env, NODE_PATH: join(root, 'node_modules'), FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID: 'tblAlsoWrong' },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /OUTBOUND_PREFLIGHT_SCHEMA/);
  assert.equal(fieldReads(f.calls).length, 1);
  assert.ok(!result.stderr.includes('must not use installed checker'));
  assertReadOnly(f.calls);
});
