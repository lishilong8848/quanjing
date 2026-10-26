import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseDotEnv } from 'dotenv';
import selfsigned from 'selfsigned';
import { applyAlarmAiKey, checkServiceHealth } from '../../scripts/configure-today-operations-alarm-ai.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nantong-alarm-ai-config-'));
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, '.env'), 'SERVER_PORT=3001\nEXISTING=base\n');
  writeFileSync(join(root, '.env.local'), 'EXISTING=local\r\n', 'utf8');
  return root;
}

async function httpsHealthFixture(t, certificateHost, publicHost, allowSelfSigned) {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const certificate = selfsigned.generate(
    [{ name: 'commonName', value: certificateHost }],
    {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: certificateHost }] },
      ],
    },
  );
  const server = createHttpsServer({ key: certificate.private, cert: certificate.cert }, (_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ role: 'guest', capabilities: [] }));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  writeFileSync(join(root, 'test-ca.pem'), certificate.cert);
  writeFileSync(join(root, '.env'), [
    'SERVER_HOST=0.0.0.0',
    `SERVER_PORT=${server.address().port}`,
    'HTTPS_CERT_PATH=certificate.pem',
    'HTTPS_KEY_PATH=private-key.pem',
    'HTTPS_CA_PATH=test-ca.pem',
    `PUBLIC_BASE_URL=https://${publicHost}`,
    `HTTPS_ALLOW_SELF_SIGNED=${allowSelfSigned}`,
  ].join('\n'));
  return root;
}

test('HTTPS health uses the public certificate name while connecting to the local listener', async (t) => {
  const root = await httpsHealthFixture(t, 'alarm.example.test', 'alarm.example.test', false);
  await checkServiceHealth(root, 'before');
});

test('HTTPS health rejects a wrong public certificate name even when the old self-signed flag is on', async (t) => {
  const root = await httpsHealthFixture(t, 'alarm.example.test', 'wrong.example.test', true);
  await assert.rejects(checkServiceHealth(root, 'before'), /certificate|hostname|altname/iu);
});

function actions(options = {}) {
  const calls = [];
  return {
    calls,
    providerProbe: async () => { calls.push('provider'); if (options.providerFails) throw new Error('provider rejected'); },
    healthCheck: async () => {
      calls.push('health');
      if (options.badCandidateHealth && calls.filter((value) => value === 'health').length === 2) {
        throw new Error('candidate unhealthy');
      }
    },
    stopService: async () => { calls.push('stop'); },
    startService: async () => {
      calls.push('start');
      if (options.startFails && calls.filter((value) => value === 'start').length === 1) {
        throw new Error('candidate start failed');
      }
    },
  };
}

const secret = 'sk-test-sensitive-value-123456';

function withChecksum(payload, field) {
  return {
    ...payload,
    [field]: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}

function writeFinalizedDeployment(root) {
  const deploymentId = 'nantong-test-release';
  const releaseFiles = [{ targetPath: 'package.json', size: 4, sha256: 'a'.repeat(64) }];
  const receipt = withChecksum({
    schemaVersion: 2,
    receiptType: 'nantong-hotfix-installed-release',
    deploymentId,
    appRoot: root,
    runtimeFiles: [{ path: 'dist/server/main.js', size: 1, sha256: 'c'.repeat(64) }],
    activeClientFiles: [{ path: 'dist/client/index.html', size: 1, sha256: 'd'.repeat(64) }],
    releaseFiles,
  }, 'receiptChecksum');
  const journal = withChecksum({
    schemaVersion: 1,
    transactionId: '3de67590-c890-4e8f-91c3-5ae1517dac7f',
    deploymentId,
    appRoot: root,
    intent: 'deploy',
    phase: 'finalized',
    releaseFiles: releaseFiles.map((entry) => ({
      targetPath: entry.targetPath,
      baselineExisted: true,
      baselineSha256: 'b'.repeat(64),
      candidateSha256: entry.sha256,
    })),
  }, 'transactionChecksum');
  writeFileSync(join(root, '.hotfix-installed-release.json'), JSON.stringify(receipt));
  writeFileSync(join(root, '.hotfix-transaction.json'), JSON.stringify(journal));
}

test('a validated finalized deployment journal does not block AI configuration', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFinalizedDeployment(root);
  const operations = actions();
  await applyAlarmAiKey({ appRoot: root, key: secret, ...operations });
  assert.deepEqual(operations.calls, ['health', 'provider', 'stop', 'start', 'health']);
  assert.equal(existsSync(join(root, '.hotfix-transaction.json')), true);
});

for (const [condition, change] of [
  ['unfinished journal', (root) => {
    const path = join(root, '.hotfix-transaction.json');
    const { transactionChecksum: _checksum, ...journal } = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify(withChecksum({ ...journal, phase: 'committed' }, 'transactionChecksum')));
  }],
  ['tampered journal checksum', (root) => {
    const path = join(root, '.hotfix-transaction.json');
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...journal, transactionChecksum: '0'.repeat(64) }));
  }],
  ['mismatched receipt', (root) => {
    const path = join(root, '.hotfix-installed-release.json');
    const { receiptChecksum: _checksum, ...receipt } = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify(withChecksum({ ...receipt, deploymentId: 'other-release' }, 'receiptChecksum')));
  }],
  ['missing receipt', (root) => {
    rmSync(join(root, '.hotfix-installed-release.json'));
  }],
]) {
  test(`${condition} blocks AI configuration before service calls`, async (t) => {
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFinalizedDeployment(root);
    change(root);
    const before = readFileSync(join(root, '.env.local'));
    const operations = actions();
    await assert.rejects(
      applyAlarmAiKey({ appRoot: root, key: secret, ...operations }),
      /Deployment journal is not a verified finalized release/u,
    );
    assert.deepEqual(operations.calls, []);
    assert.deepEqual(readFileSync(join(root, '.env.local')), before);
  });
}

test('a deployment starting during provider validation blocks the config write', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFinalizedDeployment(root);
  const before = readFileSync(join(root, '.env.local'));
  const operations = actions();
  operations.providerProbe = async () => {
    operations.calls.push('provider');
    writeFileSync(join(root, '.maintenance.lock'), 'busy');
  };
  await assert.rejects(
    applyAlarmAiKey({ appRoot: root, key: secret, ...operations }),
    /Deployment state is active/u,
  );
  assert.deepEqual(operations.calls, ['health', 'provider']);
  assert.deepEqual(readFileSync(join(root, '.env.local')), before);
});

test('stores the key only in .env.local and verifies the restarted service', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const operations = actions();
  await applyAlarmAiKey({ appRoot: root, key: secret, ...operations });
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'SERVER_PORT=3001\nEXISTING=base\n');
  assert.match(readFileSync(join(root, '.env.local'), 'utf8'), /EXISTING=local\r\n/);
  assert.match(readFileSync(join(root, '.env.local'), 'utf8'), /TODAY_OPERATIONS_ALARM_AI_API_KEY=/);
  assert.deepEqual(
    (({ TODAY_OPERATIONS_ALARM_AI_BASE_URL, TODAY_OPERATIONS_ALARM_AI_MODEL }) => ({
      TODAY_OPERATIONS_ALARM_AI_BASE_URL,
      TODAY_OPERATIONS_ALARM_AI_MODEL,
    }))(parseDotEnv(readFileSync(join(root, '.env.local')))),
    {
      TODAY_OPERATIONS_ALARM_AI_BASE_URL: 'https://wan.vnet.com/v1/chat/completions',
      TODAY_OPERATIONS_ALARM_AI_MODEL: 'WanWu/Deepseek-Auto',
    },
  );
  assert.deepEqual(operations.calls, ['health', 'provider', 'stop', 'start', 'health']);
});

test('preserves existing provider endpoint and model when configuring only the key', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.env'), 'SERVER_PORT=3001\nTODAY_OPERATIONS_ALARM_AI_BASE_URL=https://example.invalid/v1/chat/completions\nTODAY_OPERATIONS_ALARM_AI_MODEL=existing-model\n');
  const operations = actions();
  await applyAlarmAiKey({ appRoot: root, key: secret, ...operations });
  const local = parseDotEnv(readFileSync(join(root, '.env.local')));
  assert.equal(local.TODAY_OPERATIONS_ALARM_AI_API_KEY, secret);
  assert.equal(local.TODAY_OPERATIONS_ALARM_AI_BASE_URL, undefined);
  assert.equal(local.TODAY_OPERATIONS_ALARM_AI_MODEL, undefined);
});

test('provider rejection leaves configuration and service untouched', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = readFileSync(join(root, '.env.local'));
  const operations = actions({ providerFails: true });
  await assert.rejects(applyAlarmAiKey({ appRoot: root, key: secret, ...operations }), /provider rejected/);
  assert.deepEqual(readFileSync(join(root, '.env.local')), before);
  assert.deepEqual(operations.calls, ['health', 'provider']);
});

test('failed candidate start restores original config and starts the old service', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = readFileSync(join(root, '.env.local'));
  const operations = actions({ startFails: true });
  await assert.rejects(applyAlarmAiKey({ appRoot: root, key: secret, ...operations }), /candidate start failed/);
  assert.deepEqual(readFileSync(join(root, '.env.local')), before);
  assert.deepEqual(operations.calls, ['health', 'provider', 'stop', 'start', 'stop', 'start', 'health']);
});

test('failed candidate health restores original config and starts the old service', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = readFileSync(join(root, '.env.local'));
  const operations = actions({ badCandidateHealth: true });
  await assert.rejects(applyAlarmAiKey({ appRoot: root, key: secret, ...operations }), /candidate unhealthy/);
  assert.deepEqual(readFileSync(join(root, '.env.local')), before);
  assert.deepEqual(operations.calls, ['health', 'provider', 'stop', 'start', 'health', 'stop', 'start', 'health']);
});

test('rejects key with a line break before any side effect', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const operations = actions();
  await assert.rejects(applyAlarmAiKey({ appRoot: root, key: 'bad\nkey', ...operations }), /key/i);
  assert.deepEqual(operations.calls, []);
});

test('a newly created .env.local is removed when candidate health fails', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  rmSync(join(root, '.env.local'));
  const operations = actions({ badCandidateHealth: true });
  await assert.rejects(applyAlarmAiKey({ appRoot: root, key: secret, ...operations }), /candidate unhealthy/);
  assert.equal(existsSync(join(root, '.env.local')), false);
  assert.equal(existsSync(join(root, '.alarm-ai-key-configuration.lock')), false);
});

test('active deployment state blocks config updates before service calls', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.maintenance.lock'), 'busy');
  const operations = actions();
  await assert.rejects(applyAlarmAiKey({ appRoot: root, key: secret, ...operations }), /Deployment state is active/);
  assert.deepEqual(operations.calls, []);
});

test('duplicate key lines fail closed without changing the file', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const local = `${'TODAY_OPERATIONS_ALARM_AI_API_KEY=old\n'.repeat(2)}EXISTING=local\n`;
  writeFileSync(join(root, '.env.local'), local);
  const operations = actions();
  await assert.rejects(applyAlarmAiKey({ appRoot: root, key: secret, ...operations }), /Duplicate alarm AI key/);
  assert.equal(readFileSync(join(root, '.env.local'), 'utf8'), local);
  assert.deepEqual(operations.calls, []);
});

test('post-restart health rejects the actual AI review error state', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(request.url?.includes('today-operations-alarms')
      ? JSON.stringify({ tagReview: { state: 'error', connection: 'error' } })
      : '{}');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  writeFileSync(join(root, '.env.local'), `SERVER_HOST=127.0.0.1\nSERVER_PORT=${address.port}\n`);
  await assert.rejects(checkServiceHealth(root, 'after'), /AI review.*error/);
});

test('post-restart health reports an unverified AI connection without treating it as online', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(request.url?.includes('today-operations-alarms')
      ? JSON.stringify({ tagReview: { state: 'processing', connection: 'unverified' } })
      : '{}');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  writeFileSync(join(root, '.env.local'), `SERVER_HOST=127.0.0.1\nSERVER_PORT=${address.port}\n`);
  assert.deepEqual(await checkServiceHealth(root, 'after'), {
    state: 'processing',
    connection: 'unverified',
  });
});

test('configuration returns the verified post-restart AI state', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const operations = actions();
  operations.healthCheck = async (_root, phase) => {
    operations.calls.push('health');
    return phase === 'after' ? { state: 'processing', connection: 'connecting' } : undefined;
  };
  assert.deepEqual(await applyAlarmAiKey({ appRoot: root, key: secret, ...operations }), {
    state: 'processing',
    connection: 'connecting',
  });
});

test('CLI failure never echoes a supplied key', () => {
  const script = new URL('../../scripts/configure-today-operations-alarm-ai.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(script)], {
    input: 'secret-with\nline-break',
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secret-with/u);
  assert.match(result.stderr, /\[FAILED\]/u);
});

test('double-click wrapper prompts secretly and does not put the key in command arguments', () => {
  const cmd = readFileSync(new URL('../../scripts/configure-today-operations-alarm-ai.cmd', import.meta.url), 'utf8');
  const ps1 = readFileSync(new URL('../../scripts/configure-today-operations-alarm-ai.ps1', import.meta.url), 'utf8');
  assert.match(cmd, /configure-today-operations-alarm-ai\.ps1/u);
  assert.match(ps1, /Read-Host[^\n]*-AsSecureString/u);
  assert.match(ps1, /SecureStringToBSTR/u);
  assert.match(ps1, /ZeroFreeBSTR/u);
  assert.match(ps1, /RedirectStandardInput\s*=\s*\$true/u);
  assert.ok(/Write-Host\s+\$errorOutput\.Trim\(\)/u.test(ps1));
  assert.doesNotMatch(ps1, /-Key\s+\$/u);
});

test('the standalone AI configuration entry stays out of the full-runtime hotfix', () => {
  const packager = readFileSync(new URL('../../scripts/create-safe-full-runtime-hotfix-package.ps1', import.meta.url), 'utf8');
  for (const extension of ['cmd', 'ps1', 'mjs']) {
    assert.ok(
      !new RegExp(`'scripts/configure-today-operations-alarm-ai\\.${extension}'\\s*=`, 'u').test(packager),
      `Standalone ${extension} entry must not be managed by the hotfix`,
    );
  }
});
