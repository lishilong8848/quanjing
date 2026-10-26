const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { zipSync, strToU8 } = require('fflate');

const script = path.resolve(__dirname, '../../scripts/assert-current-production-baseline.ps1');
const packager = path.resolve(__dirname, '../../scripts/create-safe-full-runtime-hotfix-package.ps1');
const deploymentId = 'nantong-safe-full-runtime-hotfix-20260928-090930';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('packager freezes the production baseline gate with its build inputs', () => {
  const source = fs.readFileSync(packager, 'utf8');
  const allowlist = source.match(/\$buildFileAllowlist\s*=\s*@\(([\s\S]*?)\)\s*\+\s*\$releaseSourceFileAllowlist/);
  assert.ok(allowlist, 'build file allowlist must be explicit');
  assert.match(allowlist[1], /'scripts\/assert-current-production-baseline\.ps1'/);
});

test('packager binds the executed baseline gate bytes before candidate promotion', () => {
  const source = fs.readFileSync(packager, 'utf8');
  const gateCall = source.indexOf('& $baselineGateToolPath');
  assert.ok(gateCall > 0, 'baseline gate must use its frozen path');
  assert.match(source.slice(0, gateCall), /\$baselineGateControlAtStart\s*=\s*Open-VerifiedControlledFile[\s\S]*?-Share \(\[System\.IO\.FileShare\]::Read\)/);
  assert.match(source.slice(gateCall), /Assert-ReleaseToolUnchanged\s*`\s*-Path \$baselineGateToolPath\s*`\s*-ExpectedSha256 \$baselineGateToolFingerprintAtStart/);
});

test('baseline gate accepts current production and rejects a self-consistent older export', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-baseline-gate-'));
  try {
    const packageRoot = path.join(root, 'packages');
    fs.mkdirSync(packageRoot);
    const installed = {
      packageId: deploymentId,
      baseFingerprint: 'base-current',
      runtimeClosureFingerprint: 'runtime-current',
      payloadFiles: [
        { path: 'dist/server/main.js', sha256: 'a'.repeat(64) },
        { path: 'dist/shared/bridge.js', sha256: 'b'.repeat(64) },
        { path: 'dist/client/main.js', sha256: 'c'.repeat(64) },
      ],
    };
    const inner = zipSync({ 'hotfix-manifest.json': strToU8(JSON.stringify(installed)) });
    const outer = zipSync({ '_hotfix-payload\\hotfix-package.zip': inner });
    const packageName = 'nantong-one-click-hotfix-20260928-090930.zip';
    fs.writeFileSync(path.join(packageRoot, packageName), outer);
    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ production: {
      deploymentId,
      outerPackage: packageName,
      outerSha256: digest(outer),
      innerSha256: digest(inner),
      runtimeClosureFingerprint: installed.runtimeClosureFingerprint,
    } }));
    const baselinePath = path.join(root, 'server-baseline-manifest.json');
    const baseline = { baseFingerprint: installed.baseFingerprint, files: [...installed.payloadFiles] };
    const run = () => spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-BaselineManifestPath', baselinePath,
      '-ProductionReleaseStatePath', statePath,
      '-ProductionPackageRoot', packageRoot,
    ], { encoding: 'utf8', timeout: 20000 });
    fs.writeFileSync(baselinePath, JSON.stringify(baseline));
    const current = run();
    assert.equal(current.status, 0, current.stderr);
    assert.match(current.stdout, /Baseline matches confirmed production/);

    baseline.files[0] = { ...baseline.files[0], sha256: 'd'.repeat(64) };
    fs.writeFileSync(baselinePath, JSON.stringify(baseline));
    const stale = run();
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /not the confirmed production runtime/);

    baseline.files[0] = installed.payloadFiles[0];
    baseline.files.push({ path: 'dist/server/old.js', sha256: 'e'.repeat(64) });
    fs.writeFileSync(baselinePath, JSON.stringify(baseline));
    const extra = run();
    assert.notEqual(extra.status, 0);
    assert.match(extra.stderr, /unexpected strict runtime file/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
