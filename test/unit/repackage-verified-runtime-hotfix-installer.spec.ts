import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

jest.setTimeout(240_000);

const sha256 = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');

const createVerifiedSourceFixture = (root: string) => {
  const stageRoot = path.join(root, 'stage');
  const sourceZipPath = path.join(root, 'verified-source.zip');
  const writeFixtureFile = (relativePath: string, content: string) => {
    const fullPath = path.join(stageRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    const bytes = fs.readFileSync(fullPath);
    return {
      path: relativePath,
      size: bytes.length,
      sha256: sha256(bytes),
    };
  };
  const payload = writeFixtureFile(
    'dist/server/main.js',
    "module.exports = 'verified-runtime-fixture';\r\n",
  );
  const release = writeFixtureFile(
    'release-root/start.ps1',
    "Write-Output 'verified release fixture'\r\n",
  );
  const recovery = writeFixtureFile(
    'operations/deploy/hotfix-recovery-start.ps1',
    "Write-Output 'verified recovery fixture'\r\n",
  );
  const installer = writeFixtureFile(
    'INSTALL-HOTFIX.ps1',
    "Write-Output 'historical installer fixture'\r\n",
  );
  const readme = writeFixtureFile(
    'README.md',
    'Verified runtime repackager fixture.\r\n',
  );
  const manifest = {
    schemaVersion: 5,
    packageId: 'verified-runtime-repackage-fixture',
    createdAt: '2026-09-07T00:00:00.000Z',
    payloadFiles: [payload],
    releaseFiles: [
      {
        ...release,
        targetPath: 'start.ps1',
        baselineExisted: true,
        baselineSha256: sha256('baseline start fixture'),
      },
    ],
    supportFiles: [recovery],
    controlFiles: [installer, readme],
  };
  fs.writeFileSync(
    path.join(stageRoot, 'hotfix-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\r\n`,
    'utf8',
  );
  const archiveScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$stage = [System.IO.Path]::GetFullPath($env:NANTONG_REPACKAGE_FIXTURE_STAGE).TrimEnd('\')
$archive = [System.IO.Compression.ZipFile]::Open(
  $env:NANTONG_REPACKAGE_FIXTURE_ZIP,
  [System.IO.Compression.ZipArchiveMode]::Create
)
try {
  foreach ($file in @(Get-ChildItem -LiteralPath $stage -File -Recurse | Sort-Object FullName)) {
    $relativePath = $file.FullName.Substring($stage.Length + 1).Replace('\', '/')
    $entry = $archive.CreateEntry($relativePath, [System.IO.Compression.CompressionLevel]::Optimal)
    $input = [System.IO.File]::OpenRead($file.FullName)
    $output = $entry.Open()
    try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
  }
} finally {
  $archive.Dispose()
}
`;
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(archiveScript, 'utf16le').toString('base64'),
    ],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        NANTONG_REPACKAGE_FIXTURE_STAGE: stageRoot,
        NANTONG_REPACKAGE_FIXTURE_ZIP: sourceZipPath,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `failed to create verified repackager fixture:\n${result.stdout}\n${result.stderr}`,
    );
  }
  const verifiedSourceSha256 = sha256(fs.readFileSync(sourceZipPath));
  fs.writeFileSync(
    `${sourceZipPath}.sha256`,
    `${verifiedSourceSha256}  ${path.basename(sourceZipPath)}\r\n`,
    'utf8',
  );
  return { sourceZipPath, verifiedSourceSha256 };
};

type ArchiveAudit = {
  sourceFileCount: number;
  outputFileCount: number;
  runtimeFileCount: number;
  sourceExactFileSet: boolean;
  outputExactFileSet: boolean;
  fileSetsEqual: boolean;
  runtimeBytesEqual: boolean;
  runtimeMismatchCount: number;
  runtimeMismatchPaths: string[];
  readmeBytesEqual: boolean;
  manifestInvariantEqual: boolean;
  sourcePackageId: string;
  outputPackageId: string;
  outputCreatedAt: string;
  sourceInstallerSha256: string;
  outputInstallerSha256: string;
  outputInstallerSize: number;
  installerControlPath: string;
  installerControlSha256: string;
  installerControlSize: number;
  sourceRecoverySha256: string;
  outputRecoverySha256: string;
  outputRecoverySize: number;
  recoverySupportPath: string;
  recoverySupportSha256: string;
  recoverySupportSize: number;
  sourceBaselineFingerprint?: string;
  outputBaselineFingerprint?: string;
  outputBaselineFileCount?: number;
  outputReleaseBaselineHashes?: Record<string, string>;
};

const auditArchiveBytes = (
  sourceZipPath: string,
  outputZipPath: string,
): ArchiveAudit => {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Read-Manifest($archive) {
  $entry = $archive.GetEntry('hotfix-manifest.json')
  $reader = New-Object System.IO.StreamReader($entry.Open())
  try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
}
function Get-EntrySha($entry) {
  $stream = $entry.Open()
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose(); $stream.Dispose() }
}
function Test-EntryBytesEqual($left, $right) {
  if ($null -eq $left -or $null -eq $right -or $left.Length -ne $right.Length) { return $false }
  $leftStream = $left.Open(); $rightStream = $right.Open()
  try {
    $leftBuffer = New-Object byte[] 65536; $rightBuffer = New-Object byte[] 65536
    while ($true) {
      $leftCount = $leftStream.Read($leftBuffer, 0, $leftBuffer.Length)
      $rightCount = $rightStream.Read($rightBuffer, 0, $rightBuffer.Length)
      if ($leftCount -ne $rightCount) { return $false }
      if ($leftCount -eq 0) { return $true }
      for ($index = 0; $index -lt $leftCount; $index++) {
        if ($leftBuffer[$index] -ne $rightBuffer[$index]) { return $false }
      }
    }
  } finally { $leftStream.Dispose(); $rightStream.Dispose() }
}
function Get-ExpectedPaths($manifest) {
  return @(
    @($manifest.payloadFiles) + @($manifest.releaseFiles) + @($manifest.supportFiles) + @($manifest.controlFiles) |
      ForEach-Object { [string]$_.path }
  ) + @('hotfix-manifest.json') | Sort-Object
}
function Get-Invariant($manifest) {
  $copy = (($manifest | ConvertTo-Json -Depth 50 -Compress) | ConvertFrom-Json)
  $copy.packageId = '<package-id>'; $copy.createdAt = '<created-at>'
  $installer = @($copy.controlFiles | Where-Object { $_.path -ceq 'INSTALL-HOTFIX.ps1' })[0]
  $installer.size = -1; $installer.sha256 = '<installer-sha256>'
  $recovery = @($copy.supportFiles | Where-Object { $_.path -ceq 'operations/deploy/hotfix-recovery-start.ps1' })[0]
  $recovery.size = -1; $recovery.sha256 = '<recovery-sha256>'
  return $copy | ConvertTo-Json -Depth 50 -Compress
}
$source = [IO.Compression.ZipFile]::OpenRead($env:NANTONG_REPACKAGE_TEST_SOURCE)
$output = [IO.Compression.ZipFile]::OpenRead($env:NANTONG_REPACKAGE_TEST_OUTPUT)
try {
  $sourceManifest = Read-Manifest $source; $outputManifest = Read-Manifest $output
  $sourcePaths = @($source.Entries | ForEach-Object { $_.FullName } | Sort-Object)
  $outputPaths = @($output.Entries | ForEach-Object { $_.FullName } | Sort-Object)
  $sourceExpected = @(Get-ExpectedPaths $sourceManifest); $outputExpected = @(Get-ExpectedPaths $outputManifest)
  $runtimeRecords = @($sourceManifest.payloadFiles) + @($sourceManifest.releaseFiles) + @($sourceManifest.supportFiles)
  $runtimeMismatches = @(
    foreach ($record in $runtimeRecords) {
      if (-not (Test-EntryBytesEqual $source.GetEntry([string]$record.path) $output.GetEntry([string]$record.path))) {
        [string]$record.path
      }
    }
  )
  $installerControl = @($outputManifest.controlFiles | Where-Object { $_.path -ceq 'INSTALL-HOTFIX.ps1' })[0]
  $recoverySupport = @($outputManifest.supportFiles | Where-Object { $_.path -ceq 'operations/deploy/hotfix-recovery-start.ps1' })[0]
  $result = [ordered]@{
    sourceFileCount = $sourcePaths.Count; outputFileCount = $outputPaths.Count; runtimeFileCount = $runtimeRecords.Count
    sourceExactFileSet = (($sourcePaths -join [Environment]::NewLine) -ceq ($sourceExpected -join [Environment]::NewLine))
    outputExactFileSet = (($outputPaths -join [Environment]::NewLine) -ceq ($outputExpected -join [Environment]::NewLine))
    fileSetsEqual = (($sourcePaths -join [Environment]::NewLine) -ceq ($outputPaths -join [Environment]::NewLine))
    runtimeBytesEqual = ($runtimeMismatches.Count -eq 0); runtimeMismatchCount = $runtimeMismatches.Count
    runtimeMismatchPaths = @($runtimeMismatches)
    readmeBytesEqual = (Test-EntryBytesEqual $source.GetEntry('README.md') $output.GetEntry('README.md'))
    manifestInvariantEqual = ((Get-Invariant $sourceManifest) -ceq (Get-Invariant $outputManifest))
    sourcePackageId = [string]$sourceManifest.packageId; outputPackageId = [string]$outputManifest.packageId
    outputCreatedAt = [string]$outputManifest.createdAt
    sourceInstallerSha256 = Get-EntrySha $source.GetEntry('INSTALL-HOTFIX.ps1')
    outputInstallerSha256 = Get-EntrySha $output.GetEntry('INSTALL-HOTFIX.ps1')
    outputInstallerSize = [int64]$output.GetEntry('INSTALL-HOTFIX.ps1').Length
    installerControlPath = [string]$installerControl.path
    installerControlSha256 = [string]$installerControl.sha256
    installerControlSize = [int64]$installerControl.size
    sourceRecoverySha256 = Get-EntrySha $source.GetEntry('operations/deploy/hotfix-recovery-start.ps1')
    outputRecoverySha256 = Get-EntrySha $output.GetEntry('operations/deploy/hotfix-recovery-start.ps1')
    outputRecoverySize = [int64]$output.GetEntry('operations/deploy/hotfix-recovery-start.ps1').Length
    recoverySupportPath = [string]$recoverySupport.path
    recoverySupportSha256 = [string]$recoverySupport.sha256
    recoverySupportSize = [int64]$recoverySupport.size
    sourceBaselineFingerprint = [string]$sourceManifest.baselineFingerprint
    outputBaselineFingerprint = [string]$outputManifest.baselineFingerprint
    outputBaselineFileCount = @($outputManifest.serverBaselineFiles).Count
    outputReleaseBaselineHashes = @{}
  }
  foreach ($record in @($outputManifest.releaseFiles)) {
    $result.outputReleaseBaselineHashes[[string]$record.targetPath] = [string]$record.baselineSha256
  }
  $result | ConvertTo-Json -Compress
} finally { $source.Dispose(); $output.Dispose() }
`;
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedCommand,
    ],
    {
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        NANTONG_REPACKAGE_TEST_SOURCE: sourceZipPath,
        NANTONG_REPACKAGE_TEST_OUTPUT: outputZipPath,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout.trim()) as ArchiveAudit;
};

const extractCurrentInstallerBytes = (generatorPath: string) => {
  const generator = fs.readFileSync(generatorPath, 'utf8');
  const matches = [
    ...generator.matchAll(
      /^\$installer\s*=\s*@'\r?\n([\s\S]*)\r?\n'@\r?\nSet-Content\s+-LiteralPath\s+\(Join-Path\s+\$stageRoot\s+'INSTALL-HOTFIX\.ps1'\)/gm,
    ),
  ];
  expect(matches).toHaveLength(1);
  return Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(`${matches[0][1]}\r\n`, 'utf8'),
  ]);
};

const addZipEntry = (
  sourceZipPath: string,
  outputZipPath: string,
  entryPath: string,
) => {
  fs.copyFileSync(sourceZipPath, outputZipPath);
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$archive = [System.IO.Compression.ZipFile]::Open(
  $env:NANTONG_REPACKAGE_TEST_ZIP,
  [System.IO.Compression.ZipArchiveMode]::Update
)
try {
  $entry = $archive.CreateEntry($env:NANTONG_REPACKAGE_TEST_ENTRY)
  $writer = New-Object System.IO.StreamWriter(
    $entry.Open(),
    [System.Text.UTF8Encoding]::new($false)
  )
  try { $writer.Write('forbidden test entry') } finally { $writer.Dispose() }
} finally {
  $archive.Dispose()
}
`;
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedCommand,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        NANTONG_REPACKAGE_TEST_ZIP: outputZipPath,
        NANTONG_REPACKAGE_TEST_ENTRY: entryPath,
      },
      timeout: 30_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`,
    );
  }
  fs.writeFileSync(
    `${outputZipPath}.sha256`,
    `${sha256(fs.readFileSync(outputZipPath))}  ${path.basename(outputZipPath)}\r\n`,
    'utf8',
  );
};

describe('verified runtime hotfix installer repackager', () => {
  const projectRoot = process.cwd();
  const scriptPath = path.join(
    projectRoot,
    'scripts/repackage-verified-runtime-hotfix-installer.ps1',
  );
  const generatorPath = path.join(
    projectRoot,
    'scripts/create-safe-full-runtime-hotfix-package.ps1',
  );
  const recoveryLauncherPath = path.join(
    projectRoot,
    'deploy/hotfix-recovery-start.ps1',
  );
  let sourceZipPath = process.env.NANTONG_REPACKAGE_SOURCE_HOTFIX_PATH ?? '';
  let verifiedSourceSha256 =
    process.env.NANTONG_REPACKAGE_SOURCE_HOTFIX_SHA256 ?? '';
  const baselineRoot = process.env.NANTONG_REPACKAGE_BASELINE_ROOT ?? '';
  let sourceFixtureRoot: string | undefined;
  const temporaryRoots: string[] = [];

  beforeAll(() => {
    if (sourceZipPath || verifiedSourceSha256) {
      if (!sourceZipPath || !verifiedSourceSha256) {
        throw new Error(
          'NANTONG_REPACKAGE_SOURCE_HOTFIX_PATH and NANTONG_REPACKAGE_SOURCE_HOTFIX_SHA256 must be provided together.',
        );
      }
      return;
    }
    sourceFixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nantong-installer-repackage-source-'),
    );
    const fixture = createVerifiedSourceFixture(sourceFixtureRoot);
    sourceZipPath = fixture.sourceZipPath;
    verifiedSourceSha256 = fixture.verifiedSourceSha256;
  });

  afterAll(() => {
    if (sourceFixtureRoot) {
      fs.rmSync(sourceFixtureRoot, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const makeTemporaryRoot = (label: string) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
    temporaryRoots.push(root);
    return root;
  };

  const runRepackager = (
    outputRoot: string,
    expectedSha256: string,
    inputZipPath = sourceZipPath,
    preservePackageId = false,
    recoveryPath?: string,
    replacementBaselineRoot?: string,
    outputPackageId?: string,
  ) => {
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-SourceHotfixZip',
      inputZipPath,
      '-ExpectedSourceSha256',
      expectedSha256,
      '-InstallerGeneratorPath',
      generatorPath,
      '-OutputRoot',
      outputRoot,
    ];
    if (preservePackageId) {
      args.push('-PreservePackageId');
    }
    if (recoveryPath) {
      args.push('-RecoveryLauncherPath', recoveryPath);
    }
    if (replacementBaselineRoot) {
      args.push('-BaselineRoot', replacementBaselineRoot);
    }
    if (outputPackageId) args.push('-OutputPackageId', outputPackageId);
    return spawnSync('powershell.exe', args, {
      encoding: 'utf8',
      timeout: 180_000,
    });
  };

  it('accepts a fresh ledger-compatible output identity without changing runtime bytes', () => {
    const root = makeTemporaryRoot('nantong-repackage-output-id-');
    const outputRoot = path.join(root, 'output');
    const outputId = 'nantong-safe-full-runtime-hotfix-20261005-182000';
    const result = runRepackager(outputRoot, verifiedSourceSha256, sourceZipPath, false, undefined, undefined, outputId);
    expect(result.status).toBe(0);
    const audit = auditArchiveBytes(sourceZipPath, path.join(outputRoot, `${outputId}.zip`));
    expect(audit.outputPackageId).toBe(outputId);
    expect(audit.runtimeBytesEqual).toBe(true);
    expect(audit.manifestInvariantEqual).toBe(true);
  });

  it.each(['compatible-start-change', 'package-drift', 'lock-drift', 'missing-lock'])('checks baseline dependency family %s independently of managed startup bytes', (kind) => {
    const files = ['package.json', 'package-lock.json', 'start.ps1', 'start.cmd'].map((p) => ({ path: p, sha256: 'a'.repeat(64) }));
    const replacement = files.map((f) => ({ ...f, sha256: f.path === 'start.ps1' ? 'b'.repeat(64) : f.sha256 }));
    if (kind === 'package-drift') replacement[0].sha256 = 'c'.repeat(64);
    if (kind === 'lock-drift') replacement[1].sha256 = 'c'.repeat(64);
    if (kind === 'missing-lock') replacement.splice(1, 1);
    const command = String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:NANTONG_REPACKAGE_FAMILY_TOOL,[ref]$tokens,[ref]$errors)
foreach($statement in $ast.EndBlock.Statements){if($statement -is [Management.Automation.Language.FunctionDefinitionAst]){. ([scriptblock]::Create($statement.Extent.Text))}}
$inputData=$env:NANTONG_REPACKAGE_FAMILY_INPUT|ConvertFrom-Json
Assert-CompatibleBaselineDependencyFamily -SourceManifest $inputData.source -BaselineManifest $inputData.baseline
Write-Output 'DEPENDENCY_FAMILY_ACCEPTED'
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, NANTONG_REPACKAGE_FAMILY_TOOL: scriptPath, NANTONG_REPACKAGE_FAMILY_INPUT: JSON.stringify({ source: { baseFiles: files }, baseline: { baseFiles: replacement } }) },
    });
    if (kind === 'compatible-start-change') {
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('DEPENDENCY_FAMILY_ACCEPTED');
    } else {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Baseline dependency metadata');
    }
  });

  it.each(['../escape', 'nantong-safe-full-runtime-hotfix-20261305-182000'])('rejects invalid explicit output identity %s before producing files', (outputId) => {
    const root = makeTemporaryRoot('nantong-repackage-invalid-id-');
    const outputRoot = path.join(root, 'output');
    const result = runRepackager(outputRoot, verifiedSourceSha256, sourceZipPath, false, undefined, undefined, outputId);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('OutputPackageId');
    expect(fs.existsSync(outputRoot)).toBe(false);
  });

  it('reuses verified runtime bytes and replaces only the installer-bound manifest data', () => {
    expect(fs.existsSync(sourceZipPath)).toBe(true);
    expect(sha256(fs.readFileSync(sourceZipPath))).toBe(verifiedSourceSha256);

    const root = makeTemporaryRoot('nantong-installer-repackage-');
    const outputRoot = path.join(root, 'output');
    const result = runRepackager(outputRoot, verifiedSourceSha256);
    expect(`${result.stdout}\n${result.stderr}`).toContain('[OK] Package:');
    expect(result.status).toBe(0);

    const outputNames = fs.readdirSync(outputRoot);
    const zipNames = outputNames.filter((name) => name.endsWith('.zip'));
    expect(zipNames).toHaveLength(1);
    expect(outputNames.some((name) => name.includes('.partial'))).toBe(false);
    const outputZipPath = path.join(outputRoot, zipNames[0]);
    const sidecarPath = `${outputZipPath}.sha256`;
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(fs.readFileSync(sidecarPath, 'utf8')).toMatch(
      new RegExp(
        `^${sha256(fs.readFileSync(outputZipPath))}  ${zipNames[0]}\\r?\\n?$`,
        'i',
      ),
    );

    const audit = auditArchiveBytes(sourceZipPath, outputZipPath);
    expect(audit.sourceFileCount).toBe(audit.outputFileCount);
    expect(audit.sourceFileCount).toBe(audit.runtimeFileCount + 3);
    expect(audit.runtimeFileCount).toBeGreaterThan(0);
    expect(audit.sourceExactFileSet).toBe(true);
    expect(audit.outputExactFileSet).toBe(true);
    expect(audit.fileSetsEqual).toBe(true);
    expect(audit.runtimeBytesEqual).toBe(true);
    expect(audit.runtimeMismatchCount).toBe(0);
    expect(audit.readmeBytesEqual).toBe(true);
    expect(audit.manifestInvariantEqual).toBe(true);

    const expectedInstallerBytes = extractCurrentInstallerBytes(generatorPath);
    expect(audit.outputInstallerSha256).toBe(sha256(expectedInstallerBytes));
    expect(audit.outputInstallerSize).toBe(expectedInstallerBytes.length);
    if (audit.sourceInstallerSha256 !== sha256(expectedInstallerBytes)) {
      expect(audit.outputInstallerSha256).not.toBe(audit.sourceInstallerSha256);
    } else {
      expect(audit.outputInstallerSha256).toBe(audit.sourceInstallerSha256);
    }
    expect(audit.outputPackageId).not.toBe(audit.sourcePackageId);
    expect(audit.outputPackageId).toMatch(
      /^nantong-runtime-hotfix-\d{8}-\d{9}$/,
    );
    expect(audit.outputPackageId.length).toBeLessThanOrEqual(64);
    expect(audit.outputPackageId).not.toContain(audit.sourcePackageId);
    expect(zipNames[0]).toBe(`${audit.outputPackageId}.zip`);
    expect(Date.parse(audit.outputCreatedAt)).not.toBeNaN();
    expect(audit.installerControlPath).toBe('INSTALL-HOTFIX.ps1');
    expect(audit.installerControlSha256).toBe(audit.outputInstallerSha256);
    expect(audit.installerControlSize).toBe(audit.outputInstallerSize);
  });

  it('can preserve the verified source deployment id for recovery of that exact non-terminal transaction', () => {
    expect(fs.existsSync(sourceZipPath)).toBe(true);
    expect(sha256(fs.readFileSync(sourceZipPath))).toBe(verifiedSourceSha256);

    const root = makeTemporaryRoot('nantong-installer-repackage-same-id-');
    const outputRoot = path.join(root, 'output');
    const result = runRepackager(
      outputRoot,
      verifiedSourceSha256,
      sourceZipPath,
      true,
    );

    expect(result.status).toBe(0);
    const zipNames = fs
      .readdirSync(outputRoot)
      .filter((name) => name.endsWith('.zip'));
    expect(zipNames).toHaveLength(1);
    const outputZipPath = path.join(outputRoot, zipNames[0]);
    const audit = auditArchiveBytes(sourceZipPath, outputZipPath);
    expect(audit.outputPackageId).toBe(audit.sourcePackageId);
    expect(zipNames[0]).toBe(`${audit.sourcePackageId}.zip`);
    expect(audit.runtimeBytesEqual).toBe(true);
    expect(audit.runtimeMismatchCount).toBe(0);
    expect(audit.fileSetsEqual).toBe(true);
    expect(audit.manifestInvariantEqual).toBe(true);
    const expectedInstallerBytes = extractCurrentInstallerBytes(generatorPath);
    expect(audit.outputInstallerSha256).toBe(sha256(expectedInstallerBytes));
    if (audit.sourceInstallerSha256 !== sha256(expectedInstallerBytes)) {
      expect(audit.outputInstallerSha256).not.toBe(audit.sourceInstallerSha256);
    } else {
      expect(audit.outputInstallerSha256).toBe(audit.sourceInstallerSha256);
    }
  });

  (baselineRoot ? it : it.skip)(
    'rebinds a verified schema v6 runtime to the current server baseline without changing runtime bytes',
    () => {
      const baselineManifest = JSON.parse(
        fs.readFileSync(
          path.join(baselineRoot, 'server-baseline-manifest.json'),
          'utf8',
        ).replace(/^\uFEFF/, ''),
      ) as {
        baselineFingerprint: string;
        baselineFileCount: number;
        files: Array<{ path: string; sha256: string }>;
      };
      const root = makeTemporaryRoot('nantong-runtime-baseline-rebind-');
      const outputRoot = path.join(root, 'output');
      const result = runRepackager(
        outputRoot,
        verifiedSourceSha256,
        sourceZipPath,
        false,
        undefined,
        baselineRoot,
      );

      expect(`${result.stdout}\n${result.stderr}`).toContain('[OK] Package:');
      expect(result.status).toBe(0);
      const outputZipPath = path.join(
        outputRoot,
        fs.readdirSync(outputRoot).find((name) => name.endsWith('.zip'))!,
      );
      const audit = auditArchiveBytes(sourceZipPath, outputZipPath);
      expect(audit.runtimeBytesEqual).toBe(true);
      expect(audit.runtimeMismatchCount).toBe(0);
      expect(audit.outputBaselineFingerprint).toBe(
        baselineManifest.baselineFingerprint,
      );
      expect(audit.outputBaselineFileCount).toBe(
        baselineManifest.baselineFileCount,
      );
      expect(audit.outputBaselineFingerprint).not.toBe(
        audit.sourceBaselineFingerprint,
      );
      const resetScript = baselineManifest.files.find(
        (file) => file.path === 'scripts/reset-all-access-passwords.cmd',
      );
      expect(resetScript).toBeDefined();
      expect(
        audit.outputReleaseBaselineHashes?.['scripts/reset-all-access-passwords.cmd'],
      ).toBe(resetScript?.sha256);
    },
  );

  it('replaces only the recovery launcher support bytes while preserving the deployment id', () => {
    expect(fs.existsSync(recoveryLauncherPath)).toBe(true);
    const root = makeTemporaryRoot('nantong-installer-repackage-recovery-');
    const outputRoot = path.join(root, 'output');
    const modifiedRecoveryPath = path.join(root, 'hotfix-recovery-start.ps1');
    fs.writeFileSync(
      modifiedRecoveryPath,
      Buffer.concat([
        fs.readFileSync(recoveryLauncherPath),
        Buffer.from("\r\n# repackager replacement fixture\r\n", 'utf8'),
      ]),
    );
    const expectedRecoveryBytes = fs.readFileSync(modifiedRecoveryPath);

    const result = runRepackager(
      outputRoot,
      verifiedSourceSha256,
      sourceZipPath,
      true,
      modifiedRecoveryPath,
    );

    expect(`${result.stdout}\n${result.stderr}`).toContain('[OK] Package:');
    expect(result.status).toBe(0);
    const zipNames = fs
      .readdirSync(outputRoot)
      .filter((name) => name.endsWith('.zip'));
    expect(zipNames).toHaveLength(1);
    const audit = auditArchiveBytes(
      sourceZipPath,
      path.join(outputRoot, zipNames[0]),
    );

    expect(audit.outputPackageId).toBe(audit.sourcePackageId);
    expect(zipNames[0]).toBe(`${audit.sourcePackageId}.zip`);
    expect(audit.sourceExactFileSet).toBe(true);
    expect(audit.outputExactFileSet).toBe(true);
    expect(audit.fileSetsEqual).toBe(true);
    expect(audit.runtimeBytesEqual).toBe(false);
    expect(audit.runtimeMismatchCount).toBe(1);
    expect(audit.runtimeMismatchPaths).toEqual([
      'operations/deploy/hotfix-recovery-start.ps1',
    ]);
    expect(audit.readmeBytesEqual).toBe(true);
    expect(audit.manifestInvariantEqual).toBe(true);
    expect(audit.outputRecoverySha256).toBe(sha256(expectedRecoveryBytes));
    expect(audit.outputRecoverySha256).not.toBe(audit.sourceRecoverySha256);
    expect(audit.outputRecoverySize).toBe(expectedRecoveryBytes.length);
    expect(audit.recoverySupportPath).toBe(
      'operations/deploy/hotfix-recovery-start.ps1',
    );
    expect(audit.recoverySupportSha256).toBe(audit.outputRecoverySha256);
    expect(audit.recoverySupportSize).toBe(audit.outputRecoverySize);
  });

  it('fails closed before producing output when the expected source SHA-256 is wrong', () => {
    const root = makeTemporaryRoot('nantong-installer-repackage-bad-sha-');
    const outputRoot = path.join(root, 'output');
    const result = runRepackager(outputRoot, '0'.repeat(64));
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Expected source SHA-256 does not match the verified sidecar',
    );
    expect(fs.existsSync(outputRoot) ? fs.readdirSync(outputRoot) : []).toEqual(
      [],
    );
  });

  it.each(['.env.staging', 'dist/client/forbidden.js.map'])(
    'rejects the sensitive archive entry %s before producing output',
    (entryPath) => {
      const root = makeTemporaryRoot('nantong-installer-repackage-sensitive-');
      const maliciousZipPath = path.join(root, 'malicious.zip');
      addZipEntry(sourceZipPath, maliciousZipPath, entryPath);
      const outputRoot = path.join(root, 'output');
      const maliciousSha256 = sha256(fs.readFileSync(maliciousZipPath));

      const result = runRepackager(
        outputRoot,
        maliciousSha256,
        maliciousZipPath,
      );

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(
        new RegExp(
          `Sensitive (?:path|file) is forbidden in a hotfix archive: ${entryPath.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&',
          )}`,
        ),
      );
      expect(
        fs.existsSync(outputRoot) ? fs.readdirSync(outputRoot) : [],
      ).toEqual([]);
    },
  );

  it('cleans its owned temporary directory when output path validation fails', () => {
    const root = makeTemporaryRoot('nantong-installer-repackage-cleanup-');
    const temporaryPrefix = 'nantong-verified-hotfix-repackage-';
    const before = new Set(
      fs
        .readdirSync(os.tmpdir())
        .filter((name) => name.startsWith(temporaryPrefix)),
    );
    const invalidOutputRoot = `${path.join(root, 'output')}|invalid`;

    const result = runRepackager(invalidOutputRoot, verifiedSourceSha256);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /illegal characters in path/i,
    );
    const after = new Set(
      fs
        .readdirSync(os.tmpdir())
        .filter((name) => name.startsWith(temporaryPrefix)),
    );
    expect(after).toEqual(before);
  });
});
