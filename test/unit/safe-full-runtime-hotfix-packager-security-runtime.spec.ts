import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const projectRoot = process.cwd();
const packagerPath = path.join(
  projectRoot,
  'scripts',
  'create-safe-full-runtime-hotfix-package.ps1',
);
const powershellPath = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const portableNodeRoot = path.join(
  projectRoot,
  'output',
  'runtime-tools',
  'node-v24.15.0-win-x64',
);
const portableNodePath = path.join(portableNodeRoot, 'node.exe');
const portableNpmPath = path.join(
  portableNodeRoot,
  'node_modules',
  'npm',
  'bin',
  'npm-cli.js',
);

function extractPrimitiveSource() {
  const source = fs.readFileSync(packagerPath, 'utf8');
  const start = source.indexOf('function Get-RelativeUnixPath');
  const mainInvocation = source.indexOf(
    '$workspacePackagingLease = $null',
    start,
  );
  if (start < 0 || mainInvocation <= start) {
    throw new Error('packager primitive boundary was not found');
  }
  return source.slice(start, mainInvocation);
}

function extractReservationPrimitiveSource() {
  const source = fs.readFileSync(packagerPath, 'utf8');
  const start = source.indexOf(
    "if (-not ('NantongHotfixPackagerNativeMethods' -as [type]))",
  );
  const end = source.indexOf('function Publish-AtomicFile', start);
  if (start < 0 || end <= start) {
    throw new Error('reservation primitive boundary was not found');
  }
  return source.slice(start, end);
}

function writeHarness(
  root: string,
  body: string,
  primitiveSource = extractPrimitiveSource(),
) {
  const harnessPath = path.join(root, `harness-${cryptoRandom()}.ps1`);
  fs.writeFileSync(
    harnessPath,
    [
      'Set-StrictMode -Version Latest',
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.IO.Compression',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      primitiveSource,
      body,
    ].join('\r\n'),
    'utf8',
  );
  return harnessPath;
}

function cryptoRandom() {
  return createHash('sha256')
    .update(`${Date.now()}:${Math.random()}:${process.pid}`)
    .digest('hex')
    .slice(0, 20);
}

function runHarness(
  harnessPath: string,
  args: string[] = [],
  timeoutMs = 30_000,
) {
  return spawnSync(
    powershellPath,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harnessPath, ...args],
    { encoding: 'utf8', timeout: timeoutMs },
  );
}

function sha256(text: string | Buffer) {
  return createHash('sha256').update(text).digest('hex');
}

type BaselineEntry = { path: string; size: number; sha256: string };

function fingerprintEntries(entries: BaselineEntry[]) {
  return sha256(
    [...entries]
      .sort((left, right) =>
        Buffer.from(left.path).compare(Buffer.from(right.path)),
      )
      .map((entry) => `${entry.path}:${entry.size}:${entry.sha256}`)
      .join('\n'),
  );
}

function exportPlanFingerprint(entries: BaselineEntry[]) {
  return sha256(
    [...entries]
      .sort((left, right) =>
        Buffer.from(left.path).compare(Buffer.from(right.path)),
      )
      .map((entry) => `payload\0${entry.path}\0${entry.size}\0${entry.sha256}`)
      .join('\n'),
  );
}

function createBaselineFixture(root: string) {
  const baselineRoot = path.join(root, 'baseline');
  fs.mkdirSync(path.join(baselineRoot, 'dist/server'), { recursive: true });
  fs.mkdirSync(path.join(baselineRoot, 'dist/shared'), { recursive: true });
  fs.mkdirSync(path.join(baselineRoot, 'dist/client'), { recursive: true });
  const contents: Record<string, string> = {
    'package.json': '{"name":"baseline"}',
    'package-lock.json': '{"lockfileVersion":3}',
    'start.ps1': "Write-Host 'start'",
    'start.cmd': '@echo off',
    'dist/server/main.js': 'module.exports = {};',
    'dist/shared/index.js': 'module.exports = {};',
    'dist/client/main.js': 'console.log("client")',
  };
  const entries = Object.entries(contents).map(([relativePath, content]) => {
    const fullPath = path.join(baselineRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    const bytes = Buffer.from(content);
    return { path: relativePath, size: bytes.length, sha256: sha256(bytes) };
  });
  const distFingerprints = Object.fromEntries(
    ['dist/server', 'dist/shared', 'dist/client'].map((runtimeRoot) => [
      runtimeRoot,
      fingerprintEntries(
        entries.filter((entry) => entry.path.startsWith(`${runtimeRoot}/`)),
      ),
    ]),
  );
  const manifest = {
    schemaVersion: 3,
    exportType: 'server-hotfix-baseline-read-only',
    exportPlanAlgorithm: 'webpack-main-runtime-map-v1',
    baseFingerprint: '1'.repeat(64),
    baselineFingerprint: fingerprintEntries(entries),
    exportPlanFingerprint: exportPlanFingerprint(entries),
    distFingerprints,
    files: entries,
    nonExportedRuntimeFiles: [],
    fileCount: entries.length,
    baselineFileCount: entries.length,
    nonExportedRuntimeFileCount: 0,
    uncompressedBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
  };
  fs.writeFileSync(
    path.join(root, 'server-baseline-manifest.json'),
    JSON.stringify(manifest),
  );
}

describe('safe full-runtime hotfix packager security primitives', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hotfix-packager-security-'),
    );
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('selects an independent source without changing the workspace ownership root', () => {
    const selected = path.join(tempRoot, 'output', 'release-source-inputs', 'frozen');
    fs.mkdirSync(selected, { recursive: true });
    const harness = writeHarness(tempRoot, [
      '$root = [string]$args[0]',
      '$selected = [string]$args[1]',
      'if ((Resolve-BuildSourceRoot -ProjectRoot $root) -cne $root) { throw "DEFAULT_CHANGED" }',
      'if ((Resolve-BuildSourceRoot -ProjectRoot $root -SelectedRoot $selected) -cne $selected) { throw "SELECTION_FAILED" }',
      '$rejected = 0',
      'foreach ($bad in @($root, (Join-Path $root "output"), (Join-Path $root "missing"), ($selected + "/../"))) {',
      '  try { Resolve-BuildSourceRoot -ProjectRoot $root -SelectedRoot $bad | Out-Null } catch { $rejected++ }',
      '}',
      'if ($rejected -ne 4) { throw "UNSAFE_INPUT_ACCEPTED" }',
      'Write-Output "SOURCE_SELECTION_OK"',
    ].join('\r\n'));
    const result = runHarness(harness, [tempRoot, selected]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SOURCE_SELECTION_OK');
  });

  it('allows only one owner to reserve a same-second formal package id', async () => {
    const outputRoot = path.join(tempRoot, 'output');
    fs.mkdirSync(outputRoot);
    const harness = writeHarness(
      tempRoot,
      [
        '$OutputRoot = [string]$args[0]',
        '$OwnerToken = [string]$args[1]',
        '$ReleasePath = [string]$args[2]',
        "$reservation = New-PackageOutputReservation -OutputRoot $OutputRoot -PackageId 'same-second' -OwnerToken $OwnerToken",
        'try {',
        "  Write-Output 'ACQUIRED'",
        '  $deadline = [DateTime]::UtcNow.AddSeconds(60)',
        '  while (-not (Test-Path -LiteralPath $ReleasePath -PathType Leaf)) {',
        "    if ([DateTime]::UtcNow -ge $deadline) { throw 'Timed out waiting for release signal.' }",
        '    Start-Sleep -Milliseconds 20',
        '  }',
        '} finally {',
        '  Close-PackageOutputReservation -Reservation $reservation',
        '}',
      ].join('\r\n'),
      extractReservationPrimitiveSource(),
    );
    const releasePath = path.join(outputRoot, 'release-owner-one');
    const first = spawn(
      powershellPath,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        harness,
        outputRoot,
        'owner-one',
        releasePath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const reservationPath = path.join(outputRoot, 'same-second.reservation');
    const deadline = Date.now() + 10_000;
    while (
      !fs.existsSync(reservationPath) &&
      first.exitCode === null &&
      Date.now() < deadline
    ) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    expect(fs.existsSync(reservationPath)).toBe(true);

    try {
      const second = runHarness(harness, [
        outputRoot,
        'owner-two',
        releasePath,
      ]);
      expect(second.status).not.toBe(0);
      expect(`${second.stdout}\n${second.stderr}`).toContain(
        'Formal package id is already reserved',
      );
    } finally {
      fs.writeFileSync(releasePath, 'release');
      await new Promise<void>((resolvePromise, rejectPromise) => {
        first.once('error', rejectPromise);
        first.once('close', (code) =>
          code === 0
            ? resolvePromise()
            : rejectPromise(new Error(`reservation owner exited ${code}`)),
        );
      });
    }
    expect(fs.existsSync(reservationPath)).toBe(false);
  }, 70_000);

  it('preserves the reservation dispose failure when owned-file cleanup also fails', () => {
    const identitySource = path.join(tempRoot, 'identity-source.reservation');
    const mismatchedTarget = path.join(tempRoot, 'mismatched.reservation');
    fs.writeFileSync(identitySource, 'identity-source');
    fs.writeFileSync(mismatchedTarget, 'mismatched-target');
    const harness = writeHarness(
      tempRoot,
      [
        '$IdentitySource = [string]$args[0]',
        '$MismatchedTarget = [string]$args[1]',
        '$controlled = Open-VerifiedControlledFile -Path $IdentitySource -Share ([System.IO.FileShare]::Read) -Label "identity source"',
        '$identity = $controlled.Identity',
        '$controlled.Stream.Dispose()',
        '$throwingStream = [pscustomobject]@{}',
        '$throwingStream | Add-Member -MemberType ScriptMethod -Name Dispose -Value { throw "dispose-primary" }',
        '$reservation = [pscustomobject]@{ Stream = $throwingStream; Path = $MismatchedTarget; Identity = $identity }',
        'try {',
        '  Close-PackageOutputReservation -Reservation $reservation',
        '  throw "reservation close unexpectedly succeeded"',
        '} catch {',
        '  if ($_.Exception.Message -notmatch "dispose-primary") { throw "primary failure was masked: $($_.Exception.Message)" }',
        '}',
      ].join('\r\n'),
      extractReservationPrimitiveSource(),
    );

    const result = runHarness(harness, [identitySource, mismatchedTarget]);
    expect({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual(expect.objectContaining({ status: 0 }));
    expect(fs.existsSync(mismatchedTarget)).toBe(true);
  });

  it('waits through a short-lived file lock when cleaning an isolated build workspace', async () => {
    const workspaceName = `nantong-hotfix-build-20260829-120000-${cryptoRandom().padEnd(32, '0')}`;
    const workspace = path.join(os.tmpdir(), workspaceName);
    const lockedFile = path.join(workspace, 'locked.txt');
    const readyFile = path.join(tempRoot, 'lock-ready');
    fs.mkdirSync(workspace);
    fs.writeFileSync(lockedFile, 'locked');
    const lockerScript = path.join(tempRoot, 'locker.ps1');
    fs.writeFileSync(
      lockerScript,
      [
        'param([string]$Target,[string]$Ready)',
        '$stream = [System.IO.FileStream]::new($Target,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::None)',
        'try {',
        '  Set-Content -LiteralPath $Ready -Value "ready" -NoNewline',
        '  Start-Sleep -Milliseconds 2500',
        '} finally {',
        '  $stream.Dispose()',
        '}',
      ].join('\r\n'),
      'utf8',
    );
    const cleanupHarness = writeHarness(
      tempRoot,
      'Remove-CleanBuildWorkspace -Path ([string]$args[0])',
      extractReservationPrimitiveSource(),
    );
    const locker = spawn(
      powershellPath,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        lockerScript,
        lockedFile,
        readyFile,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    try {
      const deadline = Date.now() + 10_000;
      while (
        !fs.existsSync(readyFile) &&
        locker.exitCode === null &&
        Date.now() < deadline
      ) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }
      expect(fs.existsSync(readyFile)).toBe(true);
      const result = runHarness(cleanupHarness, [workspace]);
      expect({
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      }).toEqual(expect.objectContaining({ status: 0 }));
      expect(fs.existsSync(workspace)).toBe(false);
    } finally {
      if (locker.exitCode === null) {
        await new Promise<void>((resolvePromise) =>
          locker.once('close', () => resolvePromise()),
        );
      }
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }, 20_000);

  it('removes an isolated build workspace containing npm cache paths longer than MAX_PATH', () => {
    const workspaceName = `nantong-hotfix-build-20260829-120001-${cryptoRandom().padEnd(32, '0')}`;
    const workspace = path.join(os.tmpdir(), workspaceName);
    const longCacheFile = path.join(
      workspace,
      'npm-cache',
      '_cacache',
      'content-v2',
      'sha512',
      '00',
      '00',
      'a'.repeat(128),
    );
    expect(longCacheFile.length).toBeGreaterThan(260);
    fs.mkdirSync(path.dirname(longCacheFile), { recursive: true });
    fs.writeFileSync(longCacheFile, 'cached package data');
    const cleanupHarness = writeHarness(
      tempRoot,
      'Remove-CleanBuildWorkspace -Path ([string]$args[0]) -MaxAttempts 1',
      extractReservationPrimitiveSource(),
    );

    try {
      const result = runHarness(cleanupHarness, [workspace]);
      expect({
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      }).toEqual(expect.objectContaining({ status: 0 }));
      expect(fs.existsSync(workspace)).toBe(false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects a non-file owned-output cleanup target instead of treating it as absent', () => {
    const directoryTarget = path.join(tempRoot, 'directory-target');
    fs.mkdirSync(directoryTarget);
    const harness = writeHarness(
      tempRoot,
      [
        '$Target = [string]$args[0]',
        '$identity = [pscustomobject]@{ VolumeSerialNumber = 1; FileIndexHigh = 1; FileIndexLow = 1; NumberOfLinks = 1 }',
        'Remove-OwnedOutputFileWithRetry -Path $Target -ExpectedIdentity $identity -Label "directory target"',
      ].join('\r\n'),
      extractReservationPrimitiveSource(),
    );

    const result = runHarness(harness, [directoryTarget]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Owned output cleanup target is not a file',
    );
    expect(fs.existsSync(directoryTarget)).toBe(true);
  });

  it('prepares and verifies the ZIP and partial SHA without publishing the ready marker', () => {
    const stageRoot = path.join(tempRoot, 'prepared-stage');
    fs.mkdirSync(stageRoot);
    fs.writeFileSync(path.join(stageRoot, 'payload.txt'), 'trusted payload');
    const partialZip = path.join(tempRoot, 'prepared.owner.zip.partial');
    const zipPath = path.join(tempRoot, 'prepared.zip');
    const partialSha = path.join(tempRoot, 'prepared.owner.sha.partial');
    const shaPath = path.join(tempRoot, 'prepared.zip.sha256');
    const harness = writeHarness(
      tempRoot,
      [
        '$StageRoot = [string]$args[0]',
        '$PartialZip = [string]$args[1]',
        '$ZipPath = [string]$args[2]',
        '$PartialSha = [string]$args[3]',
        '$ShaPath = [string]$args[4]',
        '$expected = Get-ArchiveExpectedEntries -Root $StageRoot',
        '$partialIdentity = New-HotfixArchiveFromDirectory -StageRoot $StageRoot -ArchivePath $PartialZip -ExpectedEntries $expected',
        '$prepared = Prepare-VerifiedHotfixArchive -PartialZipPath $PartialZip -ZipPath $ZipPath -PartialShaPath $PartialSha -ExpectedEntries $expected -ExpectedPartialZipIdentity $partialIdentity -MaxArchiveBytes 1MB -MaxUncompressedBytes 1MB',
        'if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) { throw "verified ZIP was not prepared" }',
        'if (-not (Test-Path -LiteralPath $PartialSha -PathType Leaf)) { throw "partial ready marker was not prepared" }',
        'if (Test-Path -LiteralPath $ShaPath) { throw "ready marker was published before explicit commit" }',
      ].join('\r\n'),
    );

    const result = runHarness(harness, [
      stageRoot,
      partialZip,
      zipPath,
      partialSha,
      shaPath,
    ]);
    expect({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual(expect.objectContaining({ status: 0 }));
    expect(fs.existsSync(zipPath)).toBe(true);
    expect(fs.existsSync(partialSha)).toBe(true);
    expect(fs.existsSync(shaPath)).toBe(false);
  });

  it('atomically commits a verified partial SHA as the final ready marker', () => {
    const stageRoot = path.join(tempRoot, 'commit-stage');
    fs.mkdirSync(stageRoot);
    fs.writeFileSync(path.join(stageRoot, 'payload.txt'), 'trusted payload');
    const partialZip = path.join(tempRoot, 'commit.owner.zip.partial');
    const zipPath = path.join(tempRoot, 'commit.zip');
    const partialSha = path.join(tempRoot, 'commit.owner.sha.partial');
    const shaPath = path.join(tempRoot, 'commit.zip.sha256');
    const harness = writeHarness(
      tempRoot,
      [
        '$StageRoot = [string]$args[0]',
        '$PartialZip = [string]$args[1]',
        '$ZipPath = [string]$args[2]',
        '$PartialSha = [string]$args[3]',
        '$ShaPath = [string]$args[4]',
        '$expected = Get-ArchiveExpectedEntries -Root $StageRoot',
        '$partialIdentity = New-HotfixArchiveFromDirectory -StageRoot $StageRoot -ArchivePath $PartialZip -ExpectedEntries $expected',
        '$prepared = Prepare-VerifiedHotfixArchive -PartialZipPath $PartialZip -ZipPath $ZipPath -PartialShaPath $PartialSha -ExpectedEntries $expected -ExpectedPartialZipIdentity $partialIdentity -MaxArchiveBytes 1MB -MaxUncompressedBytes 1MB',
        'Publish-VerifiedReadyMarker -PartialShaPath $PartialSha -ShaPath $ShaPath -ExpectedPartialShaIdentity $prepared.PartialShaIdentity -ExpectedPartialShaHash $prepared.PartialShaHash -ZipPath $ZipPath -ExpectedZipIdentity $prepared.ZipIdentity -ExpectedArchiveHash $prepared.ArchiveHash -ExpectedEntries $expected -MaxArchiveBytes 1MB -MaxUncompressedBytes 1MB',
      ].join('\r\n'),
    );

    const result = runHarness(harness, [
      stageRoot,
      partialZip,
      zipPath,
      partialSha,
      shaPath,
    ]);
    expect({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual(expect.objectContaining({ status: 0 }));
    expect(fs.existsSync(partialSha)).toBe(false);
    expect(fs.existsSync(shaPath)).toBe(true);
    const expectedHash = createHash('sha256')
      .update(fs.readFileSync(zipPath))
      .digest('hex');
    expect(fs.readFileSync(shaPath, 'ascii').trim()).toBe(
      `${expectedHash.toUpperCase()}  ${path.basename(zipPath)}`,
    );
  });

  it.each([
    [
      'prepared ZIP',
      'Set-Content -LiteralPath $ZipPath -Value "tampered ZIP" -NoNewline',
    ],
    [
      'partial SHA',
      'Set-Content -LiteralPath $PartialSha -Value "tampered ready marker" -NoNewline',
    ],
  ])(
    'refuses a tampered %s and never publishes the ready marker',
    (_label, tamper) => {
      const stageRoot = path.join(tempRoot, `tamper-stage-${cryptoRandom()}`);
      fs.mkdirSync(stageRoot);
      fs.writeFileSync(path.join(stageRoot, 'payload.txt'), 'trusted payload');
      const partialZip = path.join(
        tempRoot,
        `tamper-${cryptoRandom()}.zip.partial`,
      );
      const zipPath = path.join(tempRoot, `tamper-${cryptoRandom()}.zip`);
      const partialSha = path.join(
        tempRoot,
        `tamper-${cryptoRandom()}.sha.partial`,
      );
      const shaPath = `${zipPath}.sha256`;
      const harness = writeHarness(
        tempRoot,
        [
          '$StageRoot = [string]$args[0]',
          '$PartialZip = [string]$args[1]',
          '$ZipPath = [string]$args[2]',
          '$PartialSha = [string]$args[3]',
          '$ShaPath = [string]$args[4]',
          '$expected = Get-ArchiveExpectedEntries -Root $StageRoot',
          '$partialIdentity = New-HotfixArchiveFromDirectory -StageRoot $StageRoot -ArchivePath $PartialZip -ExpectedEntries $expected',
          '$prepared = Prepare-VerifiedHotfixArchive -PartialZipPath $PartialZip -ZipPath $ZipPath -PartialShaPath $PartialSha -ExpectedEntries $expected -ExpectedPartialZipIdentity $partialIdentity -MaxArchiveBytes 1MB -MaxUncompressedBytes 1MB',
          tamper,
          'Publish-VerifiedReadyMarker -PartialShaPath $PartialSha -ShaPath $ShaPath -ExpectedPartialShaIdentity $prepared.PartialShaIdentity -ExpectedPartialShaHash $prepared.PartialShaHash -ZipPath $ZipPath -ExpectedZipIdentity $prepared.ZipIdentity -ExpectedArchiveHash $prepared.ArchiveHash -ExpectedEntries $expected -MaxArchiveBytes 1MB -MaxUncompressedBytes 1MB',
        ].join('\r\n'),
      );

      const result = runHarness(harness, [
        stageRoot,
        partialZip,
        zipPath,
        partialSha,
        shaPath,
      ]);
      expect(result.status).not.toBe(0);
      expect(fs.existsSync(shaPath)).toBe(false);
    },
  );

  it('rejects stage drift against the exact archive evidence set', () => {
    const stageRoot = path.join(tempRoot, 'stage');
    fs.mkdirSync(path.join(stageRoot, 'dist/server'), { recursive: true });
    fs.mkdirSync(path.join(stageRoot, 'dist/shared'), { recursive: true });
    fs.mkdirSync(path.join(stageRoot, 'dist/client'), { recursive: true });
    fs.mkdirSync(path.join(stageRoot, 'release-root'), { recursive: true });
    fs.writeFileSync(path.join(stageRoot, 'dist/server/main.js'), 'server-v1');
    fs.writeFileSync(path.join(stageRoot, 'dist/shared/index.js'), 'shared-v1');
    fs.writeFileSync(path.join(stageRoot, 'dist/client/main.js'), 'client-v1');
    fs.writeFileSync(path.join(stageRoot, 'release-root/package.json'), '{}');
    fs.writeFileSync(
      path.join(stageRoot, 'release-root/package-lock.json'),
      '{"lockfileVersion":3}',
    );
    const harness = writeHarness(
      tempRoot,
      [
        '$StageRoot = [string]$args[0]',
        '$before = Get-ArchiveExpectedEntries -Root $StageRoot',
        "$clientReport = [pscustomobject]@{ ok = $true; missingAssets = @(); expectedAssets = @('main.js'); activeChunkAssets = @('main.js') }",
        '$build = Get-RuntimeBuildFingerprintFromArchiveEntries -Entries $before',
        '$client = Get-ActiveClientAssetProofFromArchiveEntries -Entries $before -ClientReport $clientReport -MaxActiveChunkCount 10',
        "$lock = Get-ExactArchiveEntry -Entries $before -Path 'release-root/package-lock.json'",
        "$package = Get-ExactArchiveEntry -Entries $before -Path 'release-root/package.json'",
        "Set-Content -LiteralPath (Join-Path $StageRoot 'dist/server/main.js') -Value 'server-v2' -NoNewline",
        '$after = Get-ArchiveExpectedEntries -Root $StageRoot',
        'Assert-ArchiveEvidenceBinding -Entries $after -ExpectedBuildFingerprint $build -ClientReport $clientReport -ExpectedClientFingerprint $client.Fingerprint -ExpectedPackageSha256 $package.sha256 -ExpectedPackageLockSha256 $lock.sha256 -MaxActiveChunkCount 10',
      ].join('\r\n'),
    );

    const result = runHarness(harness, [stageRoot]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Archive evidence no longer matches the gated runtime build',
    );
  });

  it('fails closed when a moved ZIP is replaced before published reopen and never emits the ready marker', () => {
    const stageRoot = path.join(tempRoot, 'stage');
    fs.mkdirSync(stageRoot);
    fs.writeFileSync(path.join(stageRoot, 'payload.txt'), 'trusted payload');
    const partialZip = path.join(tempRoot, 'candidate.owner.zip.partial');
    const zipPath = path.join(tempRoot, 'candidate.zip');
    const partialSha = path.join(tempRoot, 'candidate.owner.sha.partial');
    const shaPath = path.join(tempRoot, 'candidate.zip.sha256');
    const harness = writeHarness(
      tempRoot,
      [
        '$StageRoot = [string]$args[0]',
        '$PartialZip = [string]$args[1]',
        '$ZipPath = [string]$args[2]',
        '$PartialSha = [string]$args[3]',
        '$ShaPath = [string]$args[4]',
        '$expected = Get-ArchiveExpectedEntries -Root $StageRoot',
        '[System.IO.Compression.ZipFile]::CreateFromDirectory($StageRoot,$PartialZip,[System.IO.Compression.CompressionLevel]::Optimal,$false)',
        '$hook = { param($PublishedPath) Remove-Item -LiteralPath $PublishedPath -Force; Set-Content -LiteralPath $PublishedPath -Value "forged" -NoNewline }',
        'Prepare-VerifiedHotfixArchive -PartialZipPath $PartialZip -ZipPath $ZipPath -PartialShaPath $PartialSha -ExpectedEntries $expected -MaxArchiveBytes 1MB -MaxUncompressedBytes 1MB -AfterZipMoveHook $hook',
      ].join('\r\n'),
    );

    const result = runHarness(harness, [
      stageRoot,
      partialZip,
      zipPath,
      partialSha,
      shaPath,
    ]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Published ZIP identity changed before verification',
    );
    expect(fs.existsSync(shaPath)).toBe(false);
  });

  it('freezes the release tool and uses only a verified baseline snapshot', () => {
    const baselineExportRoot = path.join(tempRoot, 'baseline-export');
    const baselineSnapshotRoot = path.join(tempRoot, 'baseline-snapshot');
    fs.mkdirSync(baselineExportRoot);
    createBaselineFixture(baselineExportRoot);
    const releaseTool = path.join(tempRoot, 'packager.ps1');
    fs.writeFileSync(releaseTool, "Write-Output 'v1'");
    const harness = writeHarness(
      tempRoot,
      [
        '$BaselineRoot = [string]$args[0]',
        '$SnapshotRoot = [string]$args[1]',
        '$ReleaseTool = [string]$args[2]',
        '$initial = Assert-BaselineExportManifest -ExportRoot $BaselineRoot',
        '$initialManifestHash = (Get-FileHash -LiteralPath (Join-Path $BaselineRoot "server-baseline-manifest.json") -Algorithm SHA256).Hash.ToLowerInvariant()',
        '$releaseHash = (Get-FileHash -LiteralPath $ReleaseTool -Algorithm SHA256).Hash.ToLowerInvariant()',
        '$snapshot = New-VerifiedBaselineSnapshot -SourceExportRoot $BaselineRoot -DestinationExportRoot $SnapshotRoot -InitialExport $initial -InitialManifestSha256 $initialManifestHash',
        'Set-Content -LiteralPath (Join-Path $BaselineRoot \'baseline/package.json\') -Value \'{"name":"drifted"}\' -NoNewline',
        'Set-Content -LiteralPath $ReleaseTool -Value "Write-Output \'v2\'" -NoNewline',
        '$snapshotPackage = Get-Content -LiteralPath (Join-Path $snapshot.BaselineRoot "package.json") -Raw',
        'if ($snapshotPackage -cne \'{"name":"baseline"}\') { throw "Baseline snapshot was not isolated." }',
        'try { Assert-BaselineExportSourceUnchanged -SourceExportRoot $BaselineRoot -InitialExport $initial -InitialManifestSha256 $initialManifestHash; throw "baseline drift was accepted" } catch { if ($_.Exception.Message -eq "baseline drift was accepted") { throw } }',
        'Assert-ReleaseToolUnchanged -Path $ReleaseTool -ExpectedSha256 $releaseHash',
      ].join('\r\n'),
    );

    const result = runHarness(harness, [
      baselineExportRoot,
      baselineSnapshotRoot,
      releaseTool,
    ]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Release tool changed after code freeze',
    );
  });

  it('rejects a disguised npm entry and strips inherited build environment variables', () => {
    if (!fs.existsSync(portableNodePath) || !fs.existsSync(portableNpmPath)) {
      throw new Error('portable Node 24.15.0 build distribution is missing');
    }
    const outputPath = path.join(tempRoot, 'child-env.json');
    const childScript = path.join(tempRoot, 'capture-env.js');
    const npmrc = path.join(tempRoot, 'empty.npmrc');
    fs.writeFileSync(npmrc, '');
    fs.writeFileSync(`${npmrc}.global`, '');
    fs.writeFileSync(
      childScript,
      `require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.env));`,
    );
    const harness = writeHarness(
      tempRoot,
      [
        '$NodePath = [string]$args[0]',
        '$NpmPath = [string]$args[1]',
        '$OutputPath = [string]$args[2]',
        '$ChildScript = [string]$args[3]',
        '$Npmrc = [string]$args[4]',
        '$disguised = Join-Path (Split-Path -Parent $NpmPath) "npx-cli.js"',
        'try { Resolve-VerifiedBuildTools -NodePath $NodePath -NpmPath $disguised; throw "disguised npm was accepted" } catch { if ($_.Exception.Message -eq "disguised npm was accepted") { throw } }',
        '$tools = Resolve-VerifiedBuildTools -NodePath $NodePath -NpmPath $NpmPath',
        "$env:NODE_OPTIONS = '--require=C:\\poison.js'",
        "$env:NODE_PATH = 'C:\\poison-modules'",
        "$env:NPM_CONFIG_REGISTRY = 'https://poison.invalid'",
        "$env:HOTFIX_SECRET_SHOULD_NOT_LEAK = 'secret'",
        'Invoke-CheckedNodeCommand -BuildTools $tools -WorkingDirectory (Split-Path -Parent $ChildScript) -Arguments @($ChildScript,$OutputPath) -Label "environment capture" -NpmConfigPath $Npmrc',
      ].join('\r\n'),
    );

    const result = runHarness(harness, [
      portableNodePath,
      portableNpmPath,
      outputPath,
      childScript,
      npmrc,
    ]);
    expect({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual(expect.objectContaining({ status: 0 }));
    const childEnvironment = JSON.parse(
      fs.readFileSync(outputPath, 'utf8'),
    ) as Record<string, string>;
    expect(childEnvironment.NODE_OPTIONS).toBeUndefined();
    expect(childEnvironment.NODE_PATH).toBeUndefined();
    expect(childEnvironment.NPM_CONFIG_REGISTRY).toBeUndefined();
    expect(childEnvironment.HOTFIX_SECRET_SHOULD_NOT_LEAK).toBeUndefined();
    expect(childEnvironment.CLIENT_BASE_PATH).toBe('/');
    expect(childEnvironment.NODE_ENV).toBe('production');
  }, 30_000);

  it('treats native stderr as captured output and trusts an explicit zero exit code', () => {
    if (!fs.existsSync(portableNodePath) || !fs.existsSync(portableNpmPath)) {
      throw new Error('portable Node 24.15.0 build distribution is missing');
    }
    const commandScript = path.join(tempRoot, 'warning-command.mjs');
    const gateScript = path.join(tempRoot, 'warning-gate.mjs');
    const npmrc = path.join(tempRoot, 'empty-warning.npmrc');
    fs.writeFileSync(
      commandScript,
      "process.stderr.write('npm warn deprecated harmless\\n'); process.stdout.write('command-ok\\n');",
    );
    fs.writeFileSync(
      gateScript,
      "process.stderr.write('gate warning\\n'); process.stdout.write(JSON.stringify({ok:true})+'\\n');",
    );
    fs.writeFileSync(npmrc, '');
    fs.writeFileSync(`${npmrc}.global`, '');
    const harness = writeHarness(
      tempRoot,
      [
        '$NodePath = [string]$args[0]',
        '$NpmPath = [string]$args[1]',
        '$CommandScript = [string]$args[2]',
        '$GateScript = [string]$args[3]',
        '$Npmrc = [string]$args[4]',
        '$tools = Resolve-VerifiedBuildTools -NodePath $NodePath -NpmPath $NpmPath',
        'Invoke-CheckedNodeCommand -BuildTools $tools -WorkingDirectory (Split-Path -Parent $CommandScript) -Arguments @($CommandScript) -Label "warning command" -NpmConfigPath $Npmrc',
        '$report = Invoke-NodeJsonGate -BuildTools $tools -ScriptPath $GateScript -WorkingDirectory (Split-Path -Parent $GateScript) -Arguments @() -Label "warning gate" -NpmConfigPath $Npmrc',
        'if (-not [bool]$report.ok) { throw "warning gate report was not accepted" }',
      ].join('\r\n'),
    );

    const result = runHarness(
      harness,
      [
        portableNodePath,
        portableNpmPath,
        commandScript,
        gateScript,
        npmrc,
      ],
      60_000,
    );
    expect({
      status: result.status,
      signal: result.signal,
      errorCode: result.error?.code,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual(expect.objectContaining({ status: 0 }));
    expect(result.stdout).toContain('command-ok');
  }, 70_000);

  it('still rejects a native command that writes stderr and exits nonzero', () => {
    if (!fs.existsSync(portableNodePath) || !fs.existsSync(portableNpmPath)) {
      throw new Error('portable Node 24.15.0 build distribution is missing');
    }
    const commandScript = path.join(tempRoot, 'failing-command.mjs');
    const npmrc = path.join(tempRoot, 'empty-failing.npmrc');
    fs.writeFileSync(
      commandScript,
      "process.stderr.write('real failure\\n'); process.exitCode = 7;",
    );
    fs.writeFileSync(npmrc, '');
    fs.writeFileSync(`${npmrc}.global`, '');
    const harness = writeHarness(
      tempRoot,
      [
        '$NodePath = [string]$args[0]',
        '$NpmPath = [string]$args[1]',
        '$CommandScript = [string]$args[2]',
        '$Npmrc = [string]$args[3]',
        '$tools = Resolve-VerifiedBuildTools -NodePath $NodePath -NpmPath $NpmPath',
        'Invoke-CheckedNodeCommand -BuildTools $tools -WorkingDirectory (Split-Path -Parent $CommandScript) -Arguments @($CommandScript) -Label "failing command" -NpmConfigPath $Npmrc',
      ].join('\r\n'),
    );

    const result = runHarness(harness, [
      portableNodePath,
      portableNpmPath,
      commandScript,
      npmrc,
    ]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'failing command failed with exit code 7',
    );
  }, 30_000);
});
