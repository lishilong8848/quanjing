'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { ordinaryPath } = require('../../scripts/diagnostics/collect-feishu-login.cjs');
const collector = path.resolve(__dirname, '../../scripts/diagnostics/collect-feishu-login.cjs');

test('refuses missing application without leaking environment or stack', () => {
  const result = spawnSync(process.execPath, [collector, path.join(os.tmpdir(), 'nonexistent-login-diagnostic-root')],
    { encoding: 'utf8', env: { ...process.env, LOCAL_ACCESS_SESSION_SECRET: 'must-not-export-secret' } });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'LOGIN_DIAGNOSTIC_REFUSED_OR_UNAVAILABLE\n');
});

test('rejects alternate stream paths', () => {
  assert.throws(() => ordinaryPath(path.resolve('file.json:secret')), /UNSAFE_PATH/);
});

test('installed runtime reads synthetic named accounts without writes or secret export', {
  skip: !process.env.FEISHU_DIAG_RUNTIME_ROOT,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-login-diagnostics-'));
  try {
    const appId = 'cli_diagnostic_fixture';
    const account = { name: '蒋杰', kind: 'feishu', role: 'building_admin', building: 'B楼', buildings: ['B楼'],
      appId, openId: 'ou_synthetic_diagnostic', enabled: true, deleted: false, version: 1, source: 'configuration' };
    account.identityHash = crypto.createHash('sha256').update(`${appId}\0${account.openId}`).digest('hex');
    account.id = `feishu-${account.identityHash}`;
    const file = path.join(root, 'accounts.json');
    const bytes = JSON.stringify({ schemaVersion: 1, revision: 1, legacySessionsRevoked: true, accounts: { [account.id]: account }, cardRules: {}, audit: [], mutations: {} });
    fs.writeFileSync(file, bytes);
    const secret = Buffer.alloc(32, 11).toString('base64');
    const result = spawnSync(process.execPath, [collector, process.env.FEISHU_DIAG_RUNTIME_ROOT], { encoding: 'utf8', env: {
      ...process.env, NODE_PATH: path.resolve(__dirname, '../../node_modules'), ACCESS_CONFIGURATION_FILE: file,
      FEISHU_APP_ID: appId, FEISHU_ACCESS_APPROVED_GRANTS_ENABLED: 'false', LOCAL_ACCESS_SESSION_SECRET: secret,
    }, timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.configurationStableDuringRead, true);
    assert.equal(report.rows.length, 4);
    assert.deepEqual(report.rows[0].accounts.map(row => [row.principalResolved, row.issued, row.readable, row.fingerprintMatches]), [[true, true, true, true]]);
    assert.equal(report.rows[1].accounts.length, 0);
    for (const privateValue of [secret, account.openId, account.id, file, 'passwordHash']) assert.ok(!result.stdout.includes(privateValue));
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.deepEqual(fs.readdirSync(root), ['accounts.json']);
    if (process.platform === 'win32') {
      const wrapper = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.resolve(__dirname, '../../scripts/diagnostics/Collect-FeishuLogin.ps1'),
        '-AppRoot', process.env.FEISHU_DIAG_RUNTIME_ROOT, '-OutputDirectory', root], { encoding: 'utf8', env: {
        ...process.env, NODE_PATH: path.resolve(__dirname, '../../node_modules'), ACCESS_CONFIGURATION_FILE: file,
        FEISHU_APP_ID: appId, FEISHU_ACCESS_APPROVED_GRANTS_ENABLED: 'false', LOCAL_ACCESS_SESSION_SECRET: secret,
      }, timeout: 30000 });
      assert.equal(wrapper.status, 0, wrapper.stdout + wrapper.stderr);
      const files = fs.readdirSync(root);
      assert.equal(files.length, 2);
      const reportFile = files.find(value => value.startsWith('feishu-login-diagnostics-'));
      const persisted = fs.readFileSync(path.join(root, reportFile), 'utf8');
      assert.equal(JSON.parse(persisted).rows[0].name, '蒋杰');
      assert.equal(JSON.parse(persisted).rows[0].accounts[0].readable, true);
      assert.ok(!persisted.includes(secret));
      assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
