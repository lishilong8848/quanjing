import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

jest.setTimeout(180_000);
const powerShellTimeoutMs = 90_000;

const scriptPath = join(
  process.cwd(),
  'scripts/create-purchase-two-session-latest-hotfix-package.ps1',
);
const baseArchivePath = join(
  process.cwd(),
  'output/hotfix/purchase-manager-approval-card-hotfix-20260731-151710.zip',
);
const frozenBaseSha256 =
  '752B91D9D9046D208910DBDB069713181FDBA296BDF7555429B243929CA67F71';
const baseArchiveRelativePath =
  'output/hotfix/purchase-manager-approval-card-hotfix-20260731-151710.zip';
const upstreamArchiveRelativePath =
  'output/hotfix/purchase-single-procurement-order-hotfix-20260731-082059.zip';
const upstreamArchiveSha256 =
  '5F346ECDDF34BFD6E58824A17A40A221277F02F574B483715ABD94E51D6A8351';
const baseReadmeRelativePath =
  'README_PURCHASE_MANAGER_APPROVAL_CARD_HOTFIX.md';
const readmeRelativePath = 'README_PURCHASE_TWO_SESSION_LATEST_HOTFIX.md';
const packageType = 'purchase-two-session-latest-combined-hotfix';
const baseServerPaths = [
  'dist/server/modules/purchase-inventory/purchase-application.service.js',
  'dist/server/modules/purchase-inventory/purchase-application.validation.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.module.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.config.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.rules.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.scheduler.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.service.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval-card.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.gateway.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.store.js',
  'dist/server/modules/purchase-inventory/purchase-workflow-callback.controller.js',
  'dist/server/modules/purchase-inventory/purchase-workflow-callback.js',
  'dist/server/scripts/reconcile-purchase-manager-approval-delivery.js',
];
const overlayPaths = [
  'dist/server/modules/purchase-inventory/purchase-workflow.service.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.rules.js',
  'dist/server/modules/inventory-management/purchase-inbound-confirmation.rules.js',
  'dist/server/modules/inventory-management/purchase-inbound-confirmation.service.js',
];
const finalReplacePaths = [...baseServerPaths, ...overlayPaths].sort();
const fixtureClientPaths = [
  'dist/client/index.html',
  ...Array.from(
    { length: 88 },
    (_, index) =>
      `dist/client/chunks/fixture-client-${String(index + 1).padStart(3, '0')}.js`,
  ),
];
const forbiddenPayloadPaths = [
  '../outside.js',
  'dist/client/Node_Modules/pkg/index.js',
  'dist/client/Logs/application.txt',
  'dist/client/Data/cache.json',
  'dist/client/Secrets/key.txt',
  'dist/client/.Runtime/state.json',
  'dist/client/SourceMaps/main.js',
  'dist/client/src/debug.js',
  'dist/client/tests/helper.js',
  'dist/client/Package.JSON',
  'dist/client/main.TS',
  'dist/client/.ENV.Production',
  'dist/client/feature.SpEc.js',
];
const allowedPayloadPaths = [
  'dist/client/chunks/1510.952eae2e.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.store.js',
  'dist/server/modules/inventory-management/purchase-inbound-confirmation.rules.js',
];
const temporaryRoots: string[] = [];

describe('purchase two-session latest combined hotfix package', () => {
  const readScript = () => readFileSync(scriptPath, 'utf8');
  const readRunbook = () =>
    readFileSync(
      join(
        process.cwd(),
        'docs/runbooks/purchase-manager-approval-card-operations.md',
      ),
      'utf8',
    );

  afterAll(() => {
    for (const root of temporaryRoots.reverse()) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pins and verifies the exact frozen base archive before safe extraction or overlay', () => {
    const script = readScript();
    const actualBaseSha256 = createHash('sha256')
      .update(readFileSync(baseArchivePath))
      .digest('hex')
      .toUpperCase();
    const extractedBase = createTemporaryRoot('purchase-frozen-manager-base-');
    extractZip(baseArchivePath, extractedBase);
    const baseManifest = readJson<HotfixManifest>(
      join(extractedBase, 'hotfix-manifest.json'),
    );
    const archiveFiles = listRelativeFiles(extractedBase);

    expect(actualBaseSha256).toBe(frozenBaseSha256);
    expect(script).toContain(
      `$baseArchiveRelativePath = '${baseArchiveRelativePath}'`,
    );
    expect(script).toContain(`$baseArchiveSha256 = '${frozenBaseSha256}'`);
    expect(baseManifest).toMatchObject({
      schemaVersion: 1,
      package: 'purchase-manager-approval-card-hotfix-20260731-151710',
      packageType: 'purchase-manager-approval-card-combined-hotfix',
      baseArchive: upstreamArchiveRelativePath,
      baseArchiveSha256: upstreamArchiveSha256,
      replaceDirectories: ['dist/client'],
      replaceFiles: baseServerPaths,
    });
    expect(baseManifest.files).toHaveLength(104);
    expect(
      baseManifest.files.filter((entry) =>
        entry.path.startsWith('dist/client/'),
      ),
    ).toHaveLength(89);
    expect(archiveFiles).toHaveLength(105);
    expect(archiveFiles).toEqual(
      [
        ...baseManifest.files.map((entry) => entry.path),
        'hotfix-manifest.json',
      ].sort(),
    );
    for (const entry of baseManifest.files) {
      expect(sha256File(join(extractedBase, entry.path))).toBe(entry.sha256);
    }
    for (const contract of [
      'function Assert-SafeArchiveEntries',
      'function Expand-OpenArchiveEntries',
      'function Expand-VerifiedBaseArchiveSnapshot',
      'function Assert-BaseManifest',
      'function Assert-ManifestFileHashes',
      'Base archive SHA256 mismatch.',
      'Base manifest entries do not exactly match the frozen archive.',
      'Base manifest hash mismatch:',
      '$entry.Open()',
    ]) {
      expect(script).toContain(contract);
    }
    expect(script).not.toContain(
      '[System.IO.Compression.ZipFile]::ExtractToDirectory',
    );

    const baseSnapshot = script.indexOf('-Destination $baseSnapshotPath');
    const extraction = script.indexOf(
      'Expand-VerifiedBaseArchiveSnapshot -SnapshotPath $baseSnapshotPath',
    );
    const baseManifestCheck = script.indexOf(
      'Assert-BaseManifest -ExtractedRoot $baseExtractDir',
    );
    const overlay = script.indexOf(
      '-Source (Join-Path $overlaySnapshotRoot $relativePath)',
    );
    expect(baseSnapshot).toBeGreaterThan(-1);
    expect(extraction).toBeGreaterThan(baseSnapshot);
    expect(baseManifestCheck).toBeGreaterThan(extraction);
    expect(overlay).toBeGreaterThan(baseManifestCheck);
  });

  it('overlays exactly four latest-session runtime files and preserves all 14 base replacements', () => {
    const script = readScript();

    expect(readSingleQuotedArray(script, 'baseServerRelativePaths')).toEqual(
      baseServerPaths,
    );
    expect(readSingleQuotedArray(script, 'overlayRelativePaths')).toEqual(
      overlayPaths,
    );
    expect(
      readSingleQuotedArray(script, 'preservedBaseServerRelativePaths'),
    ).toEqual(baseServerPaths);
    expect(script).toContain('Assert-PreservedBaseManifestEntries');
    expect(script).toContain("$preservedBaseClientPrefix = 'dist/client/'");
    expect(new Set(finalReplacePaths).size).toBe(18);
    expect(overlayPaths).not.toContain(
      'dist/server/modules/purchase-inventory/purchase-workflow.gateway.js',
    );
    expect(overlayPaths).not.toContain(
      'dist/server/modules/purchase-inventory/purchase-workflow.store.js',
    );
  });

  it('never copies the current workspace client and builds only the server by default', () => {
    const script = readScript();

    expect(script).toContain('if (!$SkipBuild)');
    expect(script).toContain('npm run build:server');
    expect(script).not.toContain('npm run build:prod');
    expect(script).not.toContain('npm run build:client');
    expect(script).not.toContain(
      "$clientRoot = Join-Path $repoRoot 'dist/client'",
    );
    expect(script).not.toMatch(
      /Copy-(?:Item|RequiredDirectory)[\s\S]{0,180}\$repoRoot[\s\S]{0,180}dist\/client/,
    );
    expect(script).toContain(
      'Copy-VerifiedBaseManifestPayload -ExtractedRoot $baseExtractDir',
    );
  });

  it('keeps the package command surface limited to output and build selection', () => {
    const script = readScript();
    const parameterBlock = script.match(/^param\(([\s\S]*?)\r?\n\)/);

    expect(parameterBlock).not.toBeNull();
    expect(
      Array.from(parameterBlock?.[1].matchAll(/\$(\w+)/g) ?? []).map(
        (entry) => entry[1],
      ),
    ).toEqual(['OutputDir', 'SkipBuild']);
  });

  it('bounds every synchronous PowerShell child process to 90 seconds', () => {
    const testSource = readFileSync(
      join(
        process.cwd(),
        'test/unit/purchase-two-session-latest-hotfix-package.spec.ts',
      ),
      'utf8',
    );

    expect(powerShellTimeoutMs).toBe(90_000);
    const spawnSyncToken = 'spawn' + 'Sync(';
    const spawnCallOffsets: number[] = [];
    let cursor = 0;
    while ((cursor = testSource.indexOf(spawnSyncToken, cursor)) >= 0) {
      spawnCallOffsets.push(cursor);
      cursor += spawnSyncToken.length;
    }
    expect(spawnCallOffsets).toHaveLength(2);
    for (const offset of spawnCallOffsets) {
      const callEnd = testSource.indexOf('\n  });', offset);
      expect(callEnd).toBeGreaterThan(offset);
      expect(testSource.slice(offset, callEnd)).toContain(
        'timeout: powerShellTimeoutMs',
      );
    }
  });

  it('owns one private run root and uses snapshots plus same-handle archive verification', () => {
    const script = readScript();

    for (const contract of [
      "$runId = [Guid]::NewGuid().ToString('N')",
      "'.owner-token'",
      'function Assert-OwnedRunRoot',
      'function Remove-OwnedRunRoot',
      'function Copy-FileSnapshot',
      'function Copy-OverlaySnapshots',
      'function Expand-VerifiedBaseArchiveSnapshot',
      'function Expand-OpenArchiveEntries',
      '[IO.FileShare]::Read',
      'ComputeHash($stream)',
      '[System.IO.Compression.ZipArchive]::new(',
      '$stream,',
      '$entry.Open()',
      'return $archiveHash',
      'Move-Item -LiteralPath $tempZipPath -Destination $zipPath',
      'Move-Item -LiteralPath $tempSidecarPath -Destination $sidecarPath',
    ]) {
      expect(script).toContain(contract);
    }
    expect(script).not.toContain(
      '[System.IO.Compression.ZipFile]::ExtractToDirectory',
    );
    const overlaySnapshot = script.indexOf(
      'Copy-OverlaySnapshots -SnapshotRoot $overlaySnapshotRoot',
    );
    const baseExpansion = script.indexOf(
      'Expand-VerifiedBaseArchiveSnapshot -SnapshotPath $baseSnapshotPath',
    );
    expect(overlaySnapshot).toBeGreaterThan(-1);
    expect(baseExpansion).toBeGreaterThan(overlaySnapshot);
  });

  it('protects ownership and rechecks identities immediately before deletion', () => {
    const script = readScript();
    const initialize = readPowerShellFunctionSource(
      script,
      'Initialize-OwnedRunRoot',
    );
    const removeRoot = readPowerShellFunctionSource(
      script,
      'Remove-OwnedRunRoot',
    );
    const rollback = readPowerShellFunctionSource(
      script,
      'Rollback-OwnedPublishedLeaves',
    );
    const removeArchive = readPowerShellFunctionSource(
      script,
      'Remove-OwnedPublishedArchiveLeaf',
    );
    const removeSidecar = readPowerShellFunctionSource(
      script,
      'Remove-OwnedPublishedSidecarLeaf',
    );

    expect(initialize).toContain('Protect-OwnedRunRootAcl -RunRoot $RunRoot');
    const firstRootIdentity = removeRoot.indexOf('Assert-OwnedRunRoot `');
    const treeScan = removeRoot.indexOf(
      'Assert-NoReparsePoints -Root $RunRoot',
    );
    const finalRootIdentity = removeRoot.indexOf(
      'Assert-OwnedRunRoot `',
      firstRootIdentity + 1,
    );
    const recursiveDelete = removeRoot.indexOf(
      'Remove-Item -LiteralPath $RunRoot -Recurse',
    );
    expect(treeScan).toBeGreaterThan(firstRootIdentity);
    expect(finalRootIdentity).toBeGreaterThan(treeScan);
    expect(recursiveDelete).toBeGreaterThan(finalRootIdentity);

    expect(rollback.indexOf('Assert-OwnedPublishedSidecarLeaf `')).toBeLessThan(
      rollback.indexOf('Remove-OwnedPublishedSidecarLeaf `'),
    );
    expect(rollback.indexOf('Assert-OwnedPublishedArchiveLeaf `')).toBeLessThan(
      rollback.indexOf('Remove-OwnedPublishedArchiveLeaf `'),
    );
    expect(
      removeArchive.indexOf('Assert-OwnedPublishedArchiveLeaf `'),
    ).toBeLessThan(removeArchive.indexOf('[IO.File]::Delete($ArchivePath)'));
    expect(
      removeSidecar.indexOf('Assert-OwnedPublishedSidecarLeaf `'),
    ).toBeLessThan(removeSidecar.indexOf('[IO.File]::Delete($SidecarPath)'));
  });

  it('checks all overlay semantics and the preserved gateway/store semantics before packaging', () => {
    const script = readScript();

    expect(script).toContain('function Assert-CompiledFileContains');
    expect(script).toContain('function Assert-CompiledFileOmits');
    expect(script).toContain('function Assert-FrozenBaseFileContains');
    expect(readSingleQuotedArray(script, 'workflowServiceMarkers')).toEqual([
      'expectedResultFingerprint',
      'commandResultFingerprintFromPatch',
      'doesCommandResultMatchExpected',
      'claimCommand',
      'releaseCommandClaim',
    ]);
    expect(readSingleQuotedArray(script, 'workflowRulesMarkers')).toEqual([
      'buildOrderPatch',
    ]);
    expect(readSingleQuotedArray(script, 'workflowRulesMarkerBase64')).toEqual([
      '5LiL5Y2V5a6M5oiQ77yI5b6F562+5pS277yJ',
    ]);
    expect(
      readSingleQuotedArray(script, 'workflowRulesForbiddenMarkerBase64'),
    ).toEqual(['5LiL5Y2V5pe26Ze0']);
    expect(readSingleQuotedArray(script, 'inboundRulesMarkers')).toEqual([
      'workflowStatus',
      'receiptCompleted',
      'inboundCompleted',
    ]);
    expect(readSingleQuotedArray(script, 'inboundRulesMarkerBase64')).toEqual([
      '5Yiw6LSn5bey562+5pS277yI5b6F5YWl5bqT77yJ',
      '6YeH6LSt5a6M5oiQ77yI5bey5YWl5bqT77yJ',
    ]);
    expect(readSingleQuotedArray(script, 'inboundServiceMarkers')).toEqual([
      'hasCompletedExecutionSignal',
    ]);
    expect(readSingleQuotedArray(script, 'inboundServiceMarkerBase64')).toEqual(
      ['6YeH6LSt5rWB56iL', '56iL5bqP6YeH6LSt54q25oCB', '5piv5ZCm5bey5YWl5bqT'],
    );
    expect(readSingleQuotedArray(script, 'baseGatewayMarkers')).toEqual([
      '1254607',
    ]);
    expect(readSingleQuotedArray(script, 'baseGatewayMarkerBase64')).toEqual([
      '6YeN6K+V',
    ]);
    expect(readSingleQuotedArray(script, 'baseStoreMarkers')).toEqual([
      'expectedResultFingerprint',
      'claimCommand',
      'releaseCommandClaim',
    ]);
  });

  it('rejects unsafe payloads, reparse points, duplicate paths, and partial path traversal', () => {
    const script = readScript();

    for (const contract of [
      'function Assert-ChildPath',
      'function Assert-SafePayloadPaths',
      'function Assert-NoReparsePoints',
      'function Assert-NoReparsePointsInPathChain',
      'function Assert-ExactPathSet',
      'function Assert-UniquePaths',
      '[IO.FileAttributes]::ReparsePoint',
      'ZIP contains an unsafe entry path.',
      'ZIP contains duplicate entry paths.',
    ]) {
      expect(script).toContain(contract);
    }
    for (const forbidden of [
      '.env',
      'node_modules',
      '/data/',
      '/logs/',
      '/certs/',
      '/secrets/',
      '/.runtime/',
      '/sourcemaps/',
      '/src/',
      '/test/',
      '/tests/',
      '.map',
      '.ts',
      '.tsx',
      '.spec',
      '.log',
      '.pem',
      '.key',
      'package.json',
      'package-lock.json',
    ]) {
      expect(script).toContain(forbidden);
    }
    expect(script).toContain(
      'Assert-NoReparsePointsInPathChain -Path $outputRoot',
    );
    expect(script).not.toContain('Assert-NoReparsePoints -Root $outputRoot');
  });

  it.each(forbiddenPayloadPaths)(
    'rejects the forbidden payload path %s',
    (payloadPath) => {
      const result = runPayloadPathValidation(payloadPath);

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        `Refusing to package forbidden path: ${payloadPath}`,
      );
    },
  );

  it('allows expected frozen-client and compiled-server runtime paths', () => {
    for (const payloadPath of allowedPayloadPaths) {
      const result = runPayloadPathValidation(payloadPath);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    }
  });

  it('regenerates and independently verifies the combined manifest, archive, and sidecar', () => {
    const script = readScript();

    for (const contract of [
      'function Write-HotfixManifest',
      'function Assert-HotfixManifest',
      'function Assert-ZipSidecar',
      'function Verify-FinalArchive',
      "'hotfix-manifest.json'",
      `'${readmeRelativePath}'`,
      '$zipPath.sha256.txt',
      'CreateFromDirectory',
      'Get-StreamSha256 -stream $stream',
      'Expand-OpenArchiveEntries',
      'Final ZIP entries do not exactly match the manifest and metadata files.',
      'Final archive manifest hash mismatch:',
      'ZIP SHA256 sidecar verification failed.',
    ]) {
      expect(script).toContain(contract);
    }
    expect(script).toContain(`$packageType = '${packageType}'`);
    expect(script).toContain('baseArchiveSha256 = $baseArchiveSha256');
    expect(script).toContain('[string]$manifest.package -cne $packageName');
    expect(script).toContain(
      '[string]$manifest.baseArchive -cne $baseArchiveRelativePath',
    );
  });

  it('holds the final archive lock across sidecar commit publication', () => {
    const fixture = getSuccessfulPackageFixture();
    const lockFixture = runFinalArchiveLockAcrossSidecarCommit(fixture);

    expect(lockFixture.result.error).toBeUndefined();
    expect(lockFixture.result.status).toBe(0);
    expect(readFileSync(lockFixture.sidecarPath, 'ascii').trimEnd()).toBe(
      `${sha256File(lockFixture.zipPath)}  ${basename(lockFixture.zipPath)}`,
    );
  });

  it('binds the main sidecar commit to a verified final-path archive lease', () => {
    const script = readScript();
    const main = script.slice(script.indexOf('Set-Location $repoRoot'));
    const moveArchive = main.indexOf(
      'Move-Item -LiteralPath $tempZipPath -Destination $zipPath',
    );
    const openFinal = main.indexOf(
      '$finalArchiveLease = Open-VerifiedFinalArchive',
    );
    const writeSidecar = main.indexOf(
      '$expectedSidecarContent = Write-ArchiveSidecarCandidate',
    );
    const moveSidecar = main.indexOf(
      'Move-Item -LiteralPath $tempSidecarPath -Destination $sidecarPath',
    );
    const verifyPublishedSidecar = main.indexOf(
      'Assert-OwnedPublishedSidecarLeaf',
    );
    const releaseFinal = main.indexOf('$finalArchiveLease.Stream.Dispose()');

    expect(moveArchive).toBeGreaterThan(-1);
    expect(openFinal).toBeGreaterThan(moveArchive);
    expect(writeSidecar).toBeGreaterThan(openFinal);
    expect(moveSidecar).toBeGreaterThan(writeSidecar);
    expect(verifyPublishedSidecar).toBeGreaterThan(moveSidecar);
    expect(releaseFinal).toBeGreaterThan(verifyPublishedSidecar);
  });

  it('runs the complete SkipBuild package flow and independently verifies both integrity layers', () => {
    const fixture = getSuccessfulPackageFixture();

    expect(fixture.result.error).toBeUndefined();
    expect(fixture.result.status).toBe(0);
    expect(fixture.resultOutput).toContain(
      '[OK] Purchase two-session latest combined hotfix created.',
    );
    expect(readdirSync(fixture.outputDir).sort()).toEqual(
      [basename(fixture.zipPath), basename(fixture.sidecarPath)].sort(),
    );

    const manifest = readJson<HotfixManifest>(fixture.manifestPath);
    expect(manifest.package).toBe(basename(fixture.stageDir));
    expect(manifest.packageType).toBe(packageType);
    expect(manifest.baseArchive).toBe(baseArchiveRelativePath);
    expect(manifest.baseArchiveSha256).toBe(fixture.baseArchiveSha256);
    expect(manifest.replaceDirectories).toEqual(['dist/client']);
    expect([...manifest.replaceFiles].sort()).toEqual(finalReplacePaths);
    expect(manifest.files).toHaveLength(108);
    expect(
      manifest.files.filter((entry) => entry.path.startsWith('dist/client/')),
    ).toHaveLength(89);
    expect(
      manifest.files.filter((entry) => entry.path.startsWith('dist/server/')),
    ).toHaveLength(18);
    expect(
      manifest.files.filter((entry) => entry.path.endsWith('.md')),
    ).toEqual([
      expect.objectContaining({
        path: readmeRelativePath,
      }),
    ]);

    const actualZipHash = sha256File(fixture.zipPath);
    expect(readFileSync(fixture.sidecarPath, 'ascii').trim()).toBe(
      `${actualZipHash}  ${basename(fixture.zipPath)}`,
    );

    const verificationRoot = createTemporaryRoot('purchase-hotfix-verify-');
    extractZip(fixture.zipPath, verificationRoot);
    const extractedPaths = listRelativeFiles(verificationRoot);
    expect(extractedPaths).toEqual(
      [
        ...manifest.files.map((entry) => entry.path),
        'hotfix-manifest.json',
      ].sort(),
    );
    for (const entry of manifest.files) {
      expect(sha256File(join(verificationRoot, entry.path))).toBe(entry.sha256);
    }
    expect(extractedPaths).toHaveLength(109);
    expect(extractedPaths).toContain(readmeRelativePath);
    expect(extractedPaths).not.toContain(baseReadmeRelativePath);
    const fixtureBaseRoot = createTemporaryRoot(
      'purchase-fixture-base-verify-',
    );
    extractZip(fixture.baseArchivePath, fixtureBaseRoot);
    const fixtureBaseManifest = readJson<HotfixManifest>(
      join(fixtureBaseRoot, 'hotfix-manifest.json'),
    );
    expect(fixtureBaseManifest.files).toHaveLength(104);
    expect(
      fixtureBaseManifest.files.filter((entry) =>
        entry.path.startsWith('dist/client/'),
      ),
    ).toHaveLength(89);
    expect(
      fixtureBaseManifest.files.filter((entry) =>
        entry.path.startsWith('dist/server/'),
      ),
    ).toHaveLength(14);
    expect(listRelativeFiles(fixtureBaseRoot)).toEqual(
      [
        ...fixtureBaseManifest.files.map((entry) => entry.path),
        'hotfix-manifest.json',
      ].sort(),
    );
    expect(listRelativeFiles(fixtureBaseRoot)).toHaveLength(105);
    const expectedFinalPayloadPaths = [
      ...fixtureBaseManifest.files
        .map((entry) => entry.path)
        .filter((path) => path !== baseReadmeRelativePath),
      ...overlayPaths,
      readmeRelativePath,
    ].sort();
    expect(manifest.files.map((entry) => entry.path).sort()).toEqual(
      expectedFinalPayloadPaths,
    );
    for (const entry of fixtureBaseManifest.files) {
      if (entry.path === baseReadmeRelativePath) continue;
      expect(sha256File(join(verificationRoot, entry.path))).toBe(entry.sha256);
    }
    for (const overlayPath of overlayPaths) {
      expect(readFileSync(join(verificationRoot, overlayPath))).toEqual(
        readFileSync(join(fixture.root, overlayPath)),
      );
    }
    expect(
      readJson<HotfixManifest>(join(verificationRoot, 'hotfix-manifest.json')),
    ).toEqual(manifest);
    expect(sha256File(baseArchivePath)).toBe(frozenBaseSha256);
  });

  it('runs two concurrent packages without sharing or deleting private run roots', async () => {
    const fixture = createIsolatedPackageFixture();

    const [first, second] = await Promise.all([
      runPackageScriptAsync(fixture),
      runPackageScriptAsync(fixture),
    ]);

    for (const result of [first, second]) {
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    }
    const outputNames = readdirSync(fixture.outputDir).sort();
    const zipNames = outputNames.filter((name) => name.endsWith('.zip'));
    const sidecarNames = outputNames.filter((name) =>
      name.endsWith('.zip.sha256.txt'),
    );
    expect(zipNames).toHaveLength(2);
    expect(new Set(zipNames).size).toBe(2);
    expect(sidecarNames).toEqual(
      zipNames.map((name) => `${name}.sha256.txt`).sort(),
    );
    expect(outputNames).toHaveLength(4);
  });

  it('finishes from observed private base and overlay snapshots after sources change', async () => {
    const fixture = createIsolatedPackageFixture();
    const overlayPath = overlayPaths[0];
    const originalOverlay = readFileSync(join(fixture.root, overlayPath));
    const execution = runPackageScriptAsync(fixture);
    let completed = false;
    void execution.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      },
    );

    let runRoot: string;
    try {
      runRoot = await waitForPrivateSnapshotRunRoot(fixture);
    } catch (error) {
      await execution;
      throw error;
    }
    expect(completed).toBe(false);
    const observedOwnerToken = readFileSync(
      join(runRoot, '.owner-token'),
      'ascii',
    ).trim();
    if (!/^[A-F0-9]{64}$/.test(observedOwnerToken)) {
      await execution;
    }
    expect(observedOwnerToken).toMatch(/^[A-F0-9]{64}$/);
    expect(statSync(join(runRoot, 'base-archive.snapshot.zip')).size).toBe(
      statSync(fixture.baseArchivePath).size,
    );
    for (const relativePath of overlayPaths) {
      expect(existsSync(join(runRoot, 'overlay-snapshot', relativePath))).toBe(
        true,
      );
    }

    await overwriteFileWhenUnlocked(
      fixture.baseArchivePath,
      Buffer.from('mutated base source after snapshot\n'),
    );
    writeFileSync(
      join(fixture.root, overlayPath),
      'mutated overlay source after snapshot\n',
    );

    const result = await execution;
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const zipNames = readdirSync(fixture.outputDir).filter((name) =>
      name.endsWith('.zip'),
    );
    expect(zipNames).toHaveLength(1);
    const extractedRoot = createTemporaryRoot('purchase-snapshot-result-');
    extractZip(join(fixture.outputDir, zipNames[0]), extractedRoot);
    expect(readFileSync(join(extractedRoot, overlayPath))).toEqual(
      originalOverlay,
    );
    expect(
      listRelativeFiles(extractedRoot).filter((path) =>
        path.startsWith('dist/client/'),
      ),
    ).toHaveLength(89);
    expect(readdirSync(fixture.outputDir)).toHaveLength(2);
  });

  it('rejects an overlay source changed before the snapshot ready commit', () => {
    const { result, readyPath } = runOverlaySnapshotConsistencyMutation();

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Overlay source changed while snapshotting:',
    );
    expect(existsSync(readyPath)).toBe(false);
  });

  it.each(['../outside.js', '/absolute.js', 'C:/absolute.js'])(
    'rejects an actual ZIP containing unsafe entry %s without extracting it',
    (maliciousBaseEntry) => {
      const fixture = createIsolatedPackageFixture({
        maliciousBaseEntry,
      });
      const result = runPackageScript(fixture);
      const resultOutput = `${result.stdout}\n${result.stderr}`;

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(resultOutput).toContain('ZIP contains an unsafe entry path.');
      expect(readdirSync(fixture.outputDir)).toEqual([]);
      expect(existsSync(join(fixture.root, 'outside.js'))).toBe(false);
      expect(sha256File(baseArchivePath)).toBe(frozenBaseSha256);
    },
  );

  it('rejects case-insensitive duplicate ZIP entry paths before extraction', () => {
    const fixture = createIsolatedPackageFixture({
      duplicateBaseEntry: 'DIST/CLIENT/INDEX.HTML',
    });
    const result = runPackageScript(fixture);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'ZIP contains duplicate entry paths.',
    );
    expect(readdirSync(fixture.outputDir)).toEqual([]);
  });

  it.each([
    ['identity', 'Frozen base manifest identity is invalid.'],
    ['provenance', 'Frozen base manifest provenance is invalid.'],
    ['hash', 'Base manifest hash mismatch:'],
    [
      'pathSet',
      'Base manifest entries do not exactly match the frozen archive.',
    ],
    ['replaceFiles', 'Frozen base replaceFiles is invalid.'],
  ] as const)(
    'rejects a frozen base manifest with tampered %s',
    (baseManifestTamper, expectedMessage) => {
      const fixture = createIsolatedPackageFixture({ baseManifestTamper });
      const result = runPackageScript(fixture);

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(expectedMessage);
      expect(readdirSync(fixture.outputDir)).toEqual([]);
    },
  );

  it.each([
    ['package', 'purchase-two-session-latest-hotfix-forged'],
    ['baseArchive', 'output/hotfix/forged-base.zip'],
  ] as const)(
    'rejects a manifest with tampered %s provenance',
    (field, forgedValue) => {
      const fixture = getSuccessfulPackageFixture();
      const tamperedStage = copyStageForTampering(fixture.stageDir);
      const manifestPath = join(tamperedStage, 'hotfix-manifest.json');
      const manifest = readJson<HotfixManifest>(manifestPath);
      manifest[field] = forgedValue;
      writeJson(manifestPath, manifest);

      const result = runHotfixManifestAssertion(
        tamperedStage,
        fixture.baseArchiveSha256,
      );

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'Combined hotfix manifest identity is invalid.',
      );
    },
  );

  it('rejects a manifest whose payload hash was tampered', () => {
    const fixture = getSuccessfulPackageFixture();
    const tamperedStage = copyStageForTampering(fixture.stageDir);
    const manifestPath = join(tamperedStage, 'hotfix-manifest.json');
    const manifest = readJson<HotfixManifest>(manifestPath);
    manifest.files[0].sha256 = '0'.repeat(64);
    writeJson(manifestPath, manifest);

    const result = runHotfixManifestAssertion(
      tamperedStage,
      fixture.baseArchiveSha256,
    );

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Hotfix manifest hash mismatch:',
    );
  });

  it('rejects a staged final payload changed after manifest generation', () => {
    const fixture = getSuccessfulPackageFixture();
    const tamperedStage = copyStageForTampering(fixture.stageDir);
    const manifest = readJson<HotfixManifest>(
      join(tamperedStage, 'hotfix-manifest.json'),
    );
    writeFileSync(join(tamperedStage, manifest.files[0].path), 'tampered\n');

    const result = runHotfixManifestAssertion(
      tamperedStage,
      fixture.baseArchiveSha256,
    );

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Hotfix manifest hash mismatch:',
    );
  });

  it('rejects a final ZIP whose payload changed after manifest generation', () => {
    const fixture = getSuccessfulPackageFixture();
    const tamperedRoot = createTemporaryRoot('purchase-final-zip-tamper-');
    const extractedRoot = join(tamperedRoot, 'expanded');
    mkdirSync(extractedRoot);
    extractZip(fixture.zipPath, extractedRoot);
    const manifest = readJson<HotfixManifest>(
      join(extractedRoot, 'hotfix-manifest.json'),
    );
    const payloadPath = manifest.files.find(
      (entry) => entry.path !== readmeRelativePath,
    )!.path;
    writeFileSync(join(extractedRoot, payloadPath), 'tampered final ZIP\n');
    const tamperedZipPath = join(tamperedRoot, basename(fixture.zipPath));
    createZipFromDirectory(extractedRoot, tamperedZipPath);

    const result = runFinalArchiveVerification(
      tamperedZipPath,
      manifest,
      fixture.baseArchiveSha256,
    );

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Final archive manifest hash mismatch:',
    );
  });

  it('accepts the generated sidecar and rejects a tampered ZIP hash', () => {
    const fixture = getSuccessfulPackageFixture();
    const validResult = runZipSidecarAssertion(
      fixture.zipPath,
      fixture.sidecarPath,
    );
    expect(validResult.error).toBeUndefined();
    expect(validResult.status).toBe(0);

    const tamperedRoot = createTemporaryRoot('purchase-sidecar-tamper-');
    const zipPath = join(tamperedRoot, basename(fixture.zipPath));
    const sidecarPath = `${zipPath}.sha256.txt`;
    copyFileSync(fixture.zipPath, zipPath);
    writeFileSync(
      sidecarPath,
      `${'0'.repeat(64)}  ${basename(zipPath)}\n`,
      'ascii',
    );

    const tamperedResult = runZipSidecarAssertion(zipPath, sidecarPath);
    expect(tamperedResult.error).toBeUndefined();
    expect(tamperedResult.status).not.toBe(0);
    expect(`${tamperedResult.stdout}\n${tamperedResult.stderr}`).toContain(
      'ZIP SHA256 sidecar verification failed.',
    );

    writeFileSync(
      sidecarPath,
      `${sha256File(zipPath)} ${basename(zipPath)}\n`,
      'ascii',
    );
    const malformedSpacing = runZipSidecarAssertion(zipPath, sidecarPath);
    expect(malformedSpacing.status).not.toBe(0);
    expect(`${malformedSpacing.stdout}\n${malformedSpacing.stderr}`).toContain(
      'ZIP SHA256 sidecar verification failed.',
    );

    writeFileSync(
      sidecarPath,
      `${sha256File(zipPath)}  ${basename(zipPath)}\r\n\r\n`,
      'ascii',
    );
    const extraBlankLine = runZipSidecarAssertion(zipPath, sidecarPath);
    expect(extraBlankLine.error).toBeUndefined();
    expect(extraBlankLine.status).not.toBe(0);
    expect(`${extraBlankLine.stdout}\n${extraBlankLine.stderr}`).toContain(
      'ZIP SHA256 sidecar verification failed.',
    );
  });

  it('leaves no package output when a required overlay is missing', () => {
    const fixture = createIsolatedPackageFixture({
      missingOverlayPath: overlayPaths[1],
    });
    const result = runPackageScript(fixture);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Compiled server runtime file was not found:',
    );
    expect(readdirSync(fixture.outputDir)).toEqual([]);
    expect(sha256File(baseArchivePath)).toBe(frozenBaseSha256);
  });

  it('cleans every owned artifact when README creation fails after stage creation', () => {
    const fixture = createIsolatedPackageFixture({
      readmeBlocker: true,
    });

    const result = runPackageScript(fixture);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(readdirSync(fixture.outputDir)).toEqual([]);
  });

  it('rejects an OutputDir parent chain that traverses a real junction', () => {
    const root = createTemporaryRoot('purchase-output-junction-');
    const realOutputParent = join(root, 'real-output-parent');
    const junctionParent = join(root, 'junction-parent');
    mkdirSync(realOutputParent);
    symlinkSync(realOutputParent, junctionParent, 'junction');
    const outputDir = join(junctionParent, 'package-output');

    const result = runOutputPathChainAssertion(outputDir);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Refusing to use a reparse point in an output path:',
    );
    expect(existsSync(outputDir)).toBe(false);
    expect(readdirSync(realOutputParent)).toEqual([]);
  });

  it('refuses owned run-root cleanup when a nested junction targets external data', () => {
    const fixture = runOwnedRunRootJunctionCleanup();

    expect(fixture.result.error).toBeUndefined();
    expect(fixture.result.status).not.toBe(0);
    expect(`${fixture.result.stdout}\n${fixture.result.stderr}`).toContain(
      'Refusing to package a reparse point:',
    );
    expect(existsSync(fixture.runRoot)).toBe(true);
    expect(readFileSync(fixture.sentinelPath, 'utf8')).toBe(
      'external sentinel\n',
    );
  });

  it('removes the newly created empty run root when owner-token creation fails', () => {
    const fixture = runOwnedRunRootTokenCreationFailure();

    expect(fixture.result.error).toBeUndefined();
    expect(fixture.result.status).not.toBe(0);
    expect(existsSync(fixture.runRoot)).toBe(false);
    expect(readdirSync(fixture.root)).toEqual([]);
  });

  it('initializes and verifies a protected owned run-root ACL', () => {
    const fixture = runProtectedOwnedRunRootAcl();

    expect(fixture.result.error).toBeUndefined();
    expect(fixture.result.status).toBe(0);
    expect(existsSync(fixture.runRoot)).toBe(false);
  });

  it('refuses rollback when a published sidecar no longer has the owned content', () => {
    const fixture = runChangedPublishedSidecarRollback();

    expect(fixture.result.error).toBeUndefined();
    expect(fixture.result.status).not.toBe(0);
    expect(`${fixture.result.stdout}\n${fixture.result.stderr}`).toContain(
      'Refusing to delete a published sidecar with changed content:',
    );
    expect(readFileSync(fixture.archivePath, 'utf8')).toBe('owned archive\n');
    expect(readFileSync(fixture.sidecarPath, 'ascii')).toBe(
      'replacement sidecar\n',
    );
  });

  it('refuses a deeply nested archive entry before creating through a junction', () => {
    const fixture = runArchiveEntryNestedJunctionWrite();

    expect(fixture.result.error).toBeUndefined();
    expect(fixture.result.status).not.toBe(0);
    expect(`${fixture.result.stdout}\n${fixture.result.stderr}`).toContain(
      'Refusing to use a reparse point in an output path:',
    );
    expect(readFileSync(fixture.sentinelPath, 'utf8')).toBe(
      'external sentinel\n',
    );
    expect(existsSync(fixture.externalSubPath)).toBe(false);
    expect(existsSync(fixture.externalPayloadPath)).toBe(false);
  });

  it('refuses a deeply nested snapshot destination before creating through a junction', () => {
    const fixture = runSnapshotNestedJunctionWrite();

    expect(fixture.result.error).toBeUndefined();
    expect(fixture.result.status).not.toBe(0);
    expect(`${fixture.result.stdout}\n${fixture.result.stderr}`).toContain(
      'Refusing to use a reparse point in an output path:',
    );
    expect(readFileSync(fixture.sentinelPath, 'utf8')).toBe(
      'external sentinel\n',
    );
    expect(existsSync(fixture.externalSubPath)).toBe(false);
    expect(existsSync(fixture.externalPayloadPath)).toBe(false);
  });

  it('writes one authoritative two-task README with rollout, acceptance, rollback, and exclusions', () => {
    const fixture = getSuccessfulPackageFixture();
    const readme = readFileSync(
      join(fixture.stageDir, readmeRelativePath),
      'utf8',
    );

    for (const contract of [
      '两任务合包',
      'PURCHASE_MANAGER_APPROVAL_CARD_ENABLED=false',
      'PURCHASE_WORKFLOW_PROGRAM_ENABLED=false',
      '暂停采购提交',
      '切换 Base 重复审批所有权',
      '过渡窗口逐单核对',
      '申请三方',
      '单一原因',
      '经理 3 选 1',
      '驳回原因',
      '待下单不转圈',
      '下单刷新不回退',
      '多维表写入',
      'CG260723-601',
      '仅已签收执行项可入库',
      '回滚期间保持暂停提交',
      '不得覆盖已发生审批 ledger',
      '不含源码、测试、secret',
    ]) {
      expect(readme).toContain(contract);
    }
  });
});

function readPowerShellFunctionSource(script: string, name: string): string {
  const marker = `function ${name} {`;
  const start = script.indexOf(marker);
  if (start < 0) {
    throw new Error(`PowerShell function was not found: ${name}`);
  }
  const nextFunction = script.indexOf('\n\nfunction ', start + marker.length);
  const end = nextFunction >= 0 ? nextFunction : script.length;
  return script.slice(start, end);
}

function readSingleQuotedArray(script: string, variable: string): string[] {
  const match = script.match(
    new RegExp(`\\$${variable}\\s*=\\s*@\\(([\\s\\S]*?)\\r?\\n\\)`),
  );
  expect(match).not.toBeNull();
  return Array.from(match?.[1].matchAll(/'([^']+)'/g) ?? []).map(
    (entry) => entry[1],
  );
}

function runPayloadPathValidation(payloadPath: string) {
  return getPayloadPathValidationResults().get(payloadPath)!;
}

let payloadPathValidationResults:
  | Map<
      string,
      {
        error: Error | undefined;
        status: number;
        stdout: string;
        stderr: string;
      }
    >
  | undefined;

function getPayloadPathValidationResults() {
  if (payloadPathValidationResults) return payloadPathValidationResults;
  const script = readFileSync(scriptPath, 'utf8');
  const functionSource = script.match(
    /function Assert-SafePayloadPaths \{[\s\S]*?\r?\n\}(?=\r?\n\r?\nfunction Assert-NoReparsePoints)/,
  )?.[0];
  if (!functionSource) {
    throw new Error('Assert-SafePayloadPaths could not be extracted safely');
  }
  const paths = [...forbiddenPayloadPaths, ...allowedPayloadPaths];
  const powershellPaths = paths
    .map((path) => `'${path.replace(/'/g, "''")}'`)
    .join(', ');
  const command = `${functionSource}
$results = @()
foreach ($candidate in @(${powershellPaths})) {
  try {
    Assert-SafePayloadPaths -Paths @($candidate)
    $results += [ordered]@{ path = $candidate; allowed = $true; message = '' }
  } catch {
    $results += [ordered]@{
      path = $candidate
      allowed = $false
      message = $_.Exception.Message
    }
  }
}
$results | ConvertTo-Json -Compress`;
  const executable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive'];
  if (process.platform === 'win32') {
    args.push('-ExecutionPolicy', 'Bypass');
  }
  args.push('-Command', command);
  const batchResult = spawnSync(executable, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: powerShellTimeoutMs,
    windowsHide: true,
  });
  if (batchResult.error || batchResult.status !== 0) {
    throw (
      batchResult.error ||
      new Error(
        `PowerShell path validation failed: ${batchResult.stderr || batchResult.stdout}`,
      )
    );
  }
  const parsed = JSON.parse(batchResult.stdout) as Array<{
    path: string;
    allowed: boolean;
    message: string;
  }>;
  payloadPathValidationResults = new Map(
    parsed.map((entry) => [
      entry.path,
      {
        error: undefined,
        status: entry.allowed ? 0 : 1,
        stdout: entry.message,
        stderr: '',
      },
    ]),
  );
  return payloadPathValidationResults;
}

interface HotfixManifest {
  schemaVersion: number;
  package: string;
  packageType: string;
  baseArchive: string;
  baseArchiveSha256: string;
  replaceDirectories: string[];
  replaceFiles: string[];
  files: Array<{ path: string; sha256: string }>;
}

interface PowerShellResult {
  error: Error | undefined;
  status: number;
  stdout: string;
  stderr: string;
}

interface IsolatedPackageFixture {
  root: string;
  scriptPath: string;
  outputDir: string;
  baseArchivePath: string;
  baseArchiveSha256: string;
}

interface SuccessfulPackageFixture extends IsolatedPackageFixture {
  result: PowerShellResult;
  resultOutput: string;
  stageDir: string;
  zipPath: string;
  sidecarPath: string;
  manifestPath: string;
}

let successfulPackageFixture: SuccessfulPackageFixture | undefined;

function getSuccessfulPackageFixture(): SuccessfulPackageFixture {
  if (successfulPackageFixture) return successfulPackageFixture;

  const fixture = createIsolatedPackageFixture();
  const result = runPackageScript(fixture);
  const resultOutput = `${result.stdout}\n${result.stderr}`;
  if (result.error || result.status !== 0) {
    throw (
      result.error ||
      new Error(`Fixture package flow failed unexpectedly:\n${resultOutput}`)
    );
  }

  const zipNames = readdirSync(fixture.outputDir).filter(
    (name) =>
      name.startsWith('purchase-two-session-latest-hotfix-') &&
      name.endsWith('.zip'),
  );
  if (zipNames.length !== 1) {
    throw new Error(
      `Expected one fixture ZIP, found ${zipNames.length}: ${zipNames.join(', ')}`,
    );
  }
  const zipPath = join(fixture.outputDir, zipNames[0]);
  const extractionRoot = createTemporaryRoot(
    'purchase-successful-package-stage-',
  );
  const stageDir = join(extractionRoot, zipNames[0].slice(0, -4));
  mkdirSync(stageDir);
  extractZip(zipPath, stageDir);
  const sidecarPath = `${zipPath}.sha256.txt`;
  const manifestPath = join(stageDir, 'hotfix-manifest.json');
  for (const requiredPath of [stageDir, zipPath, sidecarPath, manifestPath]) {
    if (!existsSync(requiredPath)) {
      throw new Error(`Fixture package output is missing: ${requiredPath}`);
    }
  }

  successfulPackageFixture = {
    ...fixture,
    result,
    resultOutput,
    stageDir,
    zipPath,
    sidecarPath,
    manifestPath,
  };
  return successfulPackageFixture;
}

function createIsolatedPackageFixture(
  options: {
    maliciousBaseEntry?: string;
    duplicateBaseEntry?: string;
    missingOverlayPath?: string;
    readmeBlocker?: boolean;
    baseManifestTamper?:
      | 'identity'
      | 'provenance'
      | 'hash'
      | 'pathSet'
      | 'replaceFiles';
  } = {},
): IsolatedPackageFixture {
  const root = createTemporaryRoot('purchase-two-session-package-');
  const copiedScriptPath = join(
    root,
    'scripts/create-purchase-two-session-latest-hotfix-package.ps1',
  );
  const outputDir = join(root, 'package-output');
  const baseStage = join(root, '.base-stage');
  const fixtureBaseArchivePath = join(root, baseArchiveRelativePath);

  mkdirSync(outputDir, { recursive: true });
  mkdirSync(baseStage, { recursive: true });

  const basePayload = new Map<string, string>([
    [baseReadmeRelativePath, '# Frozen manager base fixture\n'],
    ...fixtureClientPaths.map(
      (relativePath) =>
        [
          relativePath,
          relativePath.endsWith('/index.html')
            ? '<main>frozen client fixture</main>\n'
            : `window.__fixtureChunk = ${JSON.stringify(relativePath)};\n`,
        ] as [string, string],
    ),
    ...baseServerPaths.map(
      (relativePath) =>
        [relativePath, baseFixtureContent(relativePath)] as [string, string],
    ),
  ]);
  if (options.readmeBlocker) {
    basePayload.set(
      `${readmeRelativePath}/blocker.txt`,
      'force README path collision after stage creation\n',
    );
  }
  for (const [relativePath, content] of basePayload) {
    writeFixtureFile(baseStage, relativePath, content);
  }
  const baseManifest = {
    schemaVersion: 1,
    package: 'purchase-manager-approval-card-hotfix-20260731-151710',
    packageType: 'purchase-manager-approval-card-combined-hotfix',
    baseArchive: upstreamArchiveRelativePath,
    baseArchiveSha256: upstreamArchiveSha256,
    replaceDirectories: ['dist/client'],
    replaceFiles: baseServerPaths,
    files: [...basePayload.keys()].sort().map((relativePath) => ({
      path: relativePath,
      sha256: sha256File(join(baseStage, relativePath)),
    })),
  };
  if (options.baseManifestTamper === 'identity') {
    baseManifest.package = 'purchase-manager-approval-card-hotfix-forged';
  } else if (options.baseManifestTamper === 'provenance') {
    baseManifest.baseArchive = 'output/hotfix/forged-upstream.zip';
  } else if (options.baseManifestTamper === 'hash') {
    baseManifest.files[0].sha256 = '0'.repeat(64);
  } else if (options.baseManifestTamper === 'pathSet') {
    baseManifest.files.pop();
  } else if (options.baseManifestTamper === 'replaceFiles') {
    baseManifest.replaceFiles = baseServerPaths.slice(1);
  }
  writeJson(join(baseStage, 'hotfix-manifest.json'), baseManifest);
  mkdirSync(dirname(fixtureBaseArchivePath), { recursive: true });
  createZipFromDirectory(baseStage, fixtureBaseArchivePath);
  if (options.maliciousBaseEntry) {
    addZipEntry(
      fixtureBaseArchivePath,
      options.maliciousBaseEntry,
      'malicious fixture content',
    );
  }
  if (options.duplicateBaseEntry) {
    addZipEntry(
      fixtureBaseArchivePath,
      options.duplicateBaseEntry,
      'duplicate fixture content',
    );
  }
  const fixtureBaseArchiveSha256 = sha256File(fixtureBaseArchivePath);

  for (const relativePath of overlayPaths) {
    if (relativePath === options.missingOverlayPath) continue;
    writeFixtureFile(root, relativePath, overlayFixtureContent(relativePath));
  }

  const productionScript = readFileSync(scriptPath, 'utf8');
  const frozenHashOccurrences =
    productionScript.split(frozenBaseSha256).length - 1;
  if (frozenHashOccurrences !== 1) {
    throw new Error(
      `Expected one frozen SHA256 constant, found ${frozenHashOccurrences}`,
    );
  }
  mkdirSync(dirname(copiedScriptPath), { recursive: true });
  writeFileSync(
    copiedScriptPath,
    productionScript.replace(frozenBaseSha256, fixtureBaseArchiveSha256),
    'utf8',
  );
  rmSync(baseStage, { recursive: true, force: true });

  return {
    root,
    scriptPath: copiedScriptPath,
    outputDir,
    baseArchivePath: fixtureBaseArchivePath,
    baseArchiveSha256: fixtureBaseArchiveSha256,
  };
}

function baseFixtureContent(relativePath: string): string {
  if (relativePath.endsWith('purchase-workflow.gateway.js')) {
    return 'const transientCode = 1254607; const retryLabel = "重试";\n';
  }
  if (relativePath.endsWith('purchase-workflow.store.js')) {
    return [
      'expectedResultFingerprint',
      'claimCommand',
      'releaseCommandClaim',
    ].join('\n');
  }
  return `module.exports = ${JSON.stringify(`frozen:${relativePath}`)};\n`;
}

function overlayFixtureContent(relativePath: string): string {
  if (relativePath.endsWith('purchase-workflow.service.js')) {
    return [
      'expectedResultFingerprint',
      'commandResultFingerprintFromPatch',
      'doesCommandResultMatchExpected',
      'claimCommand',
      'releaseCommandClaim',
    ].join('\n');
  }
  if (relativePath.endsWith('purchase-workflow.rules.js')) {
    return ['buildOrderPatch', '下单完成（待签收）'].join('\n');
  }
  if (relativePath.endsWith('purchase-inbound-confirmation.rules.js')) {
    return [
      'workflowStatus',
      'receiptCompleted',
      'inboundCompleted',
      '到货已签收（待入库）',
      '采购完成（已入库）',
    ].join('\n');
  }
  if (relativePath.endsWith('purchase-inbound-confirmation.service.js')) {
    return [
      'hasCompletedExecutionSignal',
      '采购流程',
      '程序采购状态',
      '是否已入库',
    ].join('\n');
  }
  if (relativePath.endsWith('purchase-manager-approval-card.js')) {
    return 'const labels = ["缁煎悎閲囪喘", "妤兼爧鑷噰", "椹冲洖"];\n';
  }
  if (relativePath.endsWith('purchase-manager-approval.rules.js')) {
    return 'const rejectionField = "椹冲洖鍘熷洜";\n';
  }
  if (relativePath.endsWith('purchase-workflow-callback.js')) {
    return 'const callbackMarkers = ["form_value", "manager_action"];\n';
  }
  if (relativePath.endsWith('purchase-workflow.store.js')) {
    return [
      'manager_approval_requested',
      'manager_approval_resolved',
      'manager_approval_reopened',
      'manager_approval_attention_required',
      'manual_reconciliation',
    ].join('\n');
  }
  if (
    relativePath.endsWith('reconcile-purchase-manager-approval-delivery.js')
  ) {
    return [
      'verified-delivered',
      'verified-absent',
      'resolveUnknownManagerApprovalDelivery',
    ].join('\n');
  }
  return `module.exports = ${JSON.stringify(relativePath)};\n`;
}

function runPackageScript(fixture: IsolatedPackageFixture): PowerShellResult {
  return runPowerShellFile(
    fixture.scriptPath,
    ['-OutputDir', fixture.outputDir, '-SkipBuild'],
    fixture.root,
  );
}

function runPackageScriptAsync(
  fixture: IsolatedPackageFixture,
): Promise<PowerShellResult> {
  return runPowerShellFileAsync(
    fixture.scriptPath,
    ['-OutputDir', fixture.outputDir, '-SkipBuild'],
    fixture.root,
  );
}

async function waitForPrivateSnapshotRunRoot(
  fixture: IsolatedPackageFixture,
): Promise<string> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const candidates = readdirSync(fixture.outputDir, {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory() && entry.name.startsWith('.'));
    for (const candidate of candidates) {
      const runRoot = join(fixture.outputDir, candidate.name);
      const requiredPaths = [
        join(runRoot, '.owner-token'),
        join(runRoot, 'base-archive.snapshot.zip'),
        join(runRoot, 'overlay-snapshot.ready.json'),
        ...overlayPaths.map((path) => join(runRoot, 'overlay-snapshot', path)),
      ];
      if (
        requiredPaths.every((path) => existsSync(path)) &&
        statSync(join(runRoot, 'base-archive.snapshot.zip')).size ===
          statSync(fixture.baseArchivePath).size
      ) {
        return runRoot;
      }
    }
    await delay(25);
  }
  throw new Error('Private package snapshots were not observed before timeout');
}

async function overwriteFileWhenUnlocked(
  path: string,
  content: Buffer,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      writeFileSync(path, content);
      return;
    } catch (error) {
      lastError = error;
      await delay(25);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not overwrite snapshot source: ${path}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function runOverlaySnapshotConsistencyMutation(): {
  result: PowerShellResult;
  readyPath: string;
} {
  const root = createTemporaryRoot('purchase-overlay-consistency-');
  const sourceRoot = join(root, 'source');
  const snapshotRoot = join(root, 'snapshot');
  const readyPath = join(root, 'overlay-snapshot.ready.json');
  for (const relativePath of overlayPaths) {
    const fullPath = join(sourceRoot, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, `stable ${relativePath}\n`, 'utf8');
  }
  const functionSource = extractPackagingFunctionSource();
  const runner = `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
${functionSource}
$paths = ${powerShellArray(overlayPaths)}
$firstHashes = Get-RelativeFileHashMap -Root ${powerShellQuote(sourceRoot)} -RelativePaths $paths
New-Item -ItemType Directory -Path ${powerShellQuote(snapshotRoot)} | Out-Null
foreach ($relativePath in $paths) {
  Copy-FileSnapshot -Source (Join-Path ${powerShellQuote(sourceRoot)} $relativePath) -Destination (Join-Path ${powerShellQuote(snapshotRoot)} $relativePath) -DestinationRoot ${powerShellQuote(snapshotRoot)}
}
[IO.File]::WriteAllText(
  (Join-Path ${powerShellQuote(sourceRoot)} $paths[0]),
  'changed before ready',
  [Text.Encoding]::UTF8
)
Complete-OverlaySnapshotReady -SourceRoot ${powerShellQuote(sourceRoot)} -SnapshotRoot ${powerShellQuote(snapshotRoot)} -RelativePaths $paths -FirstHashes $firstHashes -ReadyPath ${powerShellQuote(readyPath)}
`;
  return {
    result: runPowerShellSource(runner, root),
    readyPath,
  };
}

function runHotfixManifestAssertion(
  stageDir: string,
  expectedBaseArchiveSha256: string,
): PowerShellResult {
  const manifest = readJson<HotfixManifest>(
    join(stageDir, 'hotfix-manifest.json'),
  );
  const functionSource = extractPackagingFunctionSource();
  const runner = `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$manifestRelativePath = 'hotfix-manifest.json'
$packageName = ${powerShellQuote(basename(stageDir))}
$packageType = ${powerShellQuote(packageType)}
$baseArchiveRelativePath = ${powerShellQuote(baseArchiveRelativePath)}
$baseArchiveSha256 = ${powerShellQuote(expectedBaseArchiveSha256)}
${functionSource}
Assert-HotfixManifest \`
  -Stage ${powerShellQuote(stageDir)} \`
  -PayloadPaths ${powerShellArray(manifest.files.map((entry) => entry.path))} \`
  -ReplaceFiles ${powerShellArray(manifest.replaceFiles)}
`;
  return runPowerShellSource(runner, stageDir);
}

function runFinalArchiveVerification(
  zipPath: string,
  manifest: HotfixManifest,
  expectedBaseArchiveSha256: string,
): PowerShellResult {
  const verificationRoot = join(
    createTemporaryRoot('purchase-final-archive-verifier-'),
    'verify',
  );
  const functionSource = extractPackagingFunctionSource();
  const runner = `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$manifestRelativePath = 'hotfix-manifest.json'
$packageName = ${powerShellQuote(manifest.package)}
$packageType = ${powerShellQuote(packageType)}
$baseArchiveRelativePath = ${powerShellQuote(baseArchiveRelativePath)}
$baseArchiveSha256 = ${powerShellQuote(expectedBaseArchiveSha256)}
${functionSource}
Verify-FinalArchive \`
  -zipPath ${powerShellQuote(zipPath)} \`
  -VerificationRoot ${powerShellQuote(verificationRoot)} \`
  -PayloadPaths ${powerShellArray(manifest.files.map((entry) => entry.path))} \`
  -ReplaceFiles ${powerShellArray(manifest.replaceFiles)}
`;
  return runPowerShellSource(runner, dirname(zipPath));
}

function runFinalArchiveLockAcrossSidecarCommit(
  fixture: SuccessfulPackageFixture,
): {
  result: PowerShellResult;
  zipPath: string;
  sidecarPath: string;
} {
  const root = createTemporaryRoot('purchase-final-lock-commit-');
  const zipPath = join(root, basename(fixture.zipPath));
  const candidateSidecarPath = join(root, 'candidate.sha256.txt');
  const sidecarPath = `${zipPath}.sha256.txt`;
  copyFileSync(fixture.zipPath, zipPath);
  const manifest = readJson<HotfixManifest>(fixture.manifestPath);
  const verificationRoot = join(root, 'verify-final');
  const functionSource = extractPackagingFunctionSource();
  const runner = `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$manifestRelativePath = 'hotfix-manifest.json'
$packageName = ${powerShellQuote(manifest.package)}
$packageType = ${powerShellQuote(packageType)}
$baseArchiveRelativePath = ${powerShellQuote(baseArchiveRelativePath)}
$baseArchiveSha256 = ${powerShellQuote(fixture.baseArchiveSha256)}
${functionSource}
$archivePath = ${powerShellQuote(zipPath)}
$lease = Open-VerifiedFinalArchive -zipPath $archivePath -VerificationRoot ${powerShellQuote(verificationRoot)} -PayloadPaths ${powerShellArray(manifest.files.map((entry) => entry.path))} -ReplaceFiles ${powerShellArray(manifest.replaceFiles)} -ExpectedHash ${powerShellQuote(sha256File(fixture.zipPath))}
try {
  foreach ($phase in @('before-sidecar', 'after-sidecar')) {
    if ($phase -eq 'after-sidecar') {
      Write-ArchiveSidecarCandidate -ArchivePath $archivePath -CandidatePath ${powerShellQuote(candidateSidecarPath)} -ArchiveHash $lease.Hash
      Move-Item -LiteralPath ${powerShellQuote(candidateSidecarPath)} -Destination ${powerShellQuote(sidecarPath)}
      Assert-ZipSidecar -ArchivePath $archivePath -SidecarPath ${powerShellQuote(sidecarPath)} -ExpectedHash $lease.Hash
    }
    $writeStream = $null
    try {
      $writeStream = [IO.FileStream]::new($archivePath, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
    } catch [IO.IOException] {
    }
    if ($writeStream) {
      $writeStream.Dispose()
      throw "Final archive write lock was not held: $phase"
    }
  }
} finally {
  $lease.Stream.Dispose()
}
`;
  return {
    result: runPowerShellSource(runner, root),
    zipPath,
    sidecarPath,
  };
}

function runOutputPathChainAssertion(path: string): PowerShellResult {
  const script = readFileSync(scriptPath, 'utf8');
  const functionSource = script.match(
    /function Assert-NoReparsePointsInPathChain \{[\s\S]*?(?=\r?\n\r?\nfunction Assert-UniquePaths)/,
  )?.[0];
  if (!functionSource) {
    throw new Error(
      'Assert-NoReparsePointsInPathChain could not be extracted safely',
    );
  }
  const runner = `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
${functionSource}
Assert-NoReparsePointsInPathChain -Path ${powerShellQuote(path)}
`;
  return runPowerShellSource(runner, dirname(path));
}

function runOwnedRunRootJunctionCleanup(): {
  result: PowerShellResult;
  runRoot: string;
  sentinelPath: string;
} {
  const root = createTemporaryRoot('purchase-owned-cleanup-junction-');
  const runRoot = join(root, 'owned-run');
  const externalRoot = join(root, 'external-target');
  const sentinelPath = join(externalRoot, 'sentinel.txt');
  mkdirSync(externalRoot);
  writeFileSync(sentinelPath, 'external sentinel\n', 'utf8');
  const functionSource = extractPackagingFunctionSource();
  const ownerToken = 'A'.repeat(64);
  const runner = `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
${functionSource}
$runRoot = ${powerShellQuote(runRoot)}
$ownerTokenPath = Join-Path $runRoot '.owner-token'
Initialize-OwnedRunRoot -RunRoot $runRoot -OwnerTokenPath $ownerTokenPath -OwnerToken ${powerShellQuote(ownerToken)}
New-Item -ItemType Junction -Path (Join-Path $runRoot 'nested-link') -Target ${powerShellQuote(externalRoot)} | Out-Null
Remove-OwnedRunRoot -RunRoot $runRoot -OwnerTokenPath $ownerTokenPath -ExpectedToken ${powerShellQuote(ownerToken)}
`;
  return {
    result: runPowerShellSource(runner, root),
    runRoot,
    sentinelPath,
  };
}

function runOwnedRunRootTokenCreationFailure(): {
  result: PowerShellResult;
  root: string;
  runRoot: string;
} {
  const root = createTemporaryRoot('purchase-owner-token-failure-');
  const runRoot = join(root, 'owned-run');
  const impossibleTokenPath = join(runRoot, 'missing-parent', '.owner-token');
  const functionSource = extractPackagingFunctionSource();
  const runner = `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
${functionSource}
Initialize-OwnedRunRoot -RunRoot ${powerShellQuote(runRoot)} -OwnerTokenPath ${powerShellQuote(impossibleTokenPath)} -OwnerToken ${powerShellQuote('A'.repeat(64))}
`;
  return {
    result: runPowerShellSource(runner, root),
    root,
    runRoot,
  };
}

function runProtectedOwnedRunRootAcl(): {
  result: PowerShellResult;
  runRoot: string;
} {
  const root = createTemporaryRoot('purchase-owned-acl-');
  const runRoot = join(root, 'owned-run');
  const ownerToken = 'B'.repeat(64);
  const functionSource = extractPackagingFunctionSource();
  const runner = `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
${functionSource}
$runRoot = ${powerShellQuote(runRoot)}
$ownerTokenPath = Join-Path $runRoot '.owner-token'
Initialize-OwnedRunRoot -RunRoot $runRoot -OwnerTokenPath $ownerTokenPath -OwnerToken ${powerShellQuote(ownerToken)}
Assert-OwnedRunRootAcl -RunRoot $runRoot
Remove-OwnedRunRoot -RunRoot $runRoot -OwnerTokenPath $ownerTokenPath -ExpectedToken ${powerShellQuote(ownerToken)}
`;
  return {
    result: runPowerShellSource(runner, root),
    runRoot,
  };
}

function runArchiveEntryNestedJunctionWrite(): {
  result: PowerShellResult;
  sentinelPath: string;
  externalSubPath: string;
  externalPayloadPath: string;
} {
  const root = createTemporaryRoot('purchase-entry-junction-');
  const sourceRoot = join(root, 'source');
  const sourcePayloadPath = join(sourceRoot, 'nested', 'sub', 'payload.bin');
  mkdirSync(dirname(sourcePayloadPath), { recursive: true });
  writeFileSync(sourcePayloadPath, 'archive payload\n', 'utf8');
  const archivePath = join(root, 'payload.zip');
  createZipFromDirectory(sourceRoot, archivePath);

  const destinationRoot = join(root, 'destination');
  const externalRoot = join(root, 'external-target');
  const sentinelPath = join(externalRoot, 'sentinel.txt');
  const externalSubPath = join(externalRoot, 'sub');
  const externalPayloadPath = join(externalSubPath, 'payload.bin');
  mkdirSync(destinationRoot);
  mkdirSync(externalRoot);
  writeFileSync(sentinelPath, 'external sentinel\n', 'utf8');
  symlinkSync(externalRoot, join(destinationRoot, 'nested'), 'junction');

  const functionSource = extractPackagingFunctionSource();
  const runner = `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
${functionSource}
$stream = [IO.FileStream]::new(${powerShellQuote(archivePath)}, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $true)
  try {
    $entry = @($archive.Entries | Where-Object { $_.Name -eq 'payload.bin' })[0]
    Write-OpenArchiveEntry -Entry $entry -DestinationRoot ${powerShellQuote(destinationRoot)}
  } finally {
    $archive.Dispose()
  }
} finally {
  $stream.Dispose()
}
`;
  return {
    result: runPowerShellSource(runner, root),
    sentinelPath,
    externalSubPath,
    externalPayloadPath,
  };
}

function runSnapshotNestedJunctionWrite(): {
  result: PowerShellResult;
  sentinelPath: string;
  externalSubPath: string;
  externalPayloadPath: string;
} {
  const root = createTemporaryRoot('purchase-snapshot-junction-');
  const sourcePath = join(root, 'source.bin');
  writeFileSync(sourcePath, 'snapshot payload\n', 'utf8');
  const destinationRoot = join(root, 'destination');
  const externalRoot = join(root, 'external-target');
  const sentinelPath = join(externalRoot, 'sentinel.txt');
  const externalSubPath = join(externalRoot, 'sub');
  const externalPayloadPath = join(externalSubPath, 'payload.bin');
  mkdirSync(destinationRoot);
  mkdirSync(externalRoot);
  writeFileSync(sentinelPath, 'external sentinel\n', 'utf8');
  symlinkSync(externalRoot, join(destinationRoot, 'nested'), 'junction');
  const destinationPath = join(destinationRoot, 'nested', 'sub', 'payload.bin');
  const functionSource = extractPackagingFunctionSource();
  const runner = `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
${functionSource}
Copy-FileSnapshot -Source ${powerShellQuote(sourcePath)} -Destination ${powerShellQuote(destinationPath)} -DestinationRoot ${powerShellQuote(destinationRoot)}
`;
  return {
    result: runPowerShellSource(runner, root),
    sentinelPath,
    externalSubPath,
    externalPayloadPath,
  };
}

function runChangedPublishedSidecarRollback(): {
  result: PowerShellResult;
  archivePath: string;
  sidecarPath: string;
} {
  const root = createTemporaryRoot('purchase-owned-rollback-');
  const archivePath = join(root, 'published.zip');
  const sidecarPath = `${archivePath}.sha256.txt`;
  writeFileSync(archivePath, 'owned archive\n', 'utf8');
  const archiveHash = sha256File(archivePath);
  const expectedSidecarContent = `${archiveHash}  ${basename(archivePath)}\r\n`;
  writeFileSync(sidecarPath, 'replacement sidecar\n', 'ascii');
  const functionSource = extractPackagingFunctionSource();
  const runner = `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
${functionSource}
Rollback-OwnedPublishedLeaves -ArchivePublished $true -SidecarPublished $true -ArchivePath ${powerShellQuote(archivePath)} -SidecarPath ${powerShellQuote(sidecarPath)} -ExpectedArchiveHash ${powerShellQuote(archiveHash)} -ExpectedSidecarContent ${powerShellQuote(expectedSidecarContent)}
`;
  return {
    result: runPowerShellSource(runner, root),
    archivePath,
    sidecarPath,
  };
}

function runZipSidecarAssertion(
  zipPath: string,
  sidecarPath: string,
): PowerShellResult {
  const script = readFileSync(scriptPath, 'utf8');
  const functionSource =
    script.match(
      /function Assert-ZipSidecar \{[\s\S]*?(?=\r?\n\r?\nfunction Verify-FinalArchive)/,
    )?.[0] ?? '';
  const runner = `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
${functionSource}
Assert-ZipSidecar -ArchivePath ${powerShellQuote(
    zipPath,
  )} -SidecarPath ${powerShellQuote(sidecarPath)}
`;
  return runPowerShellSource(runner, dirname(zipPath));
}

function extractPackagingFunctionSource(): string {
  const script = readFileSync(scriptPath, 'utf8');
  const source = script.match(
    /function ConvertFrom-Utf8Base64Array \{[\s\S]*?(?=\r?\nSet-Location \$repoRoot)/,
  )?.[0];
  if (!source) {
    throw new Error('Packaging function source could not be extracted safely');
  }
  return source;
}

function copyStageForTampering(sourceStage: string): string {
  const root = createTemporaryRoot('purchase-manifest-tamper-');
  const destination = join(root, basename(sourceStage));
  cpSync(sourceStage, destination, { recursive: true });
  return destination;
}

function createZipFromDirectory(source: string, archive: string): void {
  const result = runPowerShellSource(
    `
param([string]$Source, [string]$Archive)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $Source,
  $Archive,
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false
)
`,
    dirname(source),
    [source, archive],
  );
  assertPowerShellFixtureSuccess(result, 'create ZIP');
}

function addZipEntry(
  archive: string,
  entryPath: string,
  content: string,
): void {
  const result = runPowerShellSource(
    `
param([string]$Archive, [string]$EntryPath, [string]$Content)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open(
  $Archive,
  [System.IO.Compression.ZipArchiveMode]::Update
)
try {
  $entry = $zip.CreateEntry($EntryPath)
  $writer = New-Object System.IO.StreamWriter($entry.Open())
  try {
    $writer.Write($Content)
  } finally {
    $writer.Dispose()
  }
} finally {
  $zip.Dispose()
}
`,
    dirname(archive),
    [archive, entryPath, content],
  );
  assertPowerShellFixtureSuccess(result, 'add ZIP entry');
}

function extractZip(archive: string, destination: string): void {
  const result = runPowerShellSource(
    `
param([string]$Archive, [string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Destination)
`,
    dirname(archive),
    [archive, destination],
  );
  assertPowerShellFixtureSuccess(result, 'extract ZIP');
}

function assertPowerShellFixtureSuccess(
  result: PowerShellResult,
  operation: string,
): void {
  if (result.error || result.status !== 0) {
    throw (
      result.error ||
      new Error(
        `PowerShell fixture failed to ${operation}:\n${result.stdout}\n${result.stderr}`,
      )
    );
  }
}

function runPowerShellSource(
  source: string,
  cwd: string,
  positionalArgs: string[] = [],
): PowerShellResult {
  const runnerRoot = createTemporaryRoot('purchase-powershell-runner-');
  const runnerPath = join(runnerRoot, 'runner.ps1');
  writeFileSync(runnerPath, source, 'utf8');
  return runPowerShellFile(runnerPath, positionalArgs, cwd);
}

function runPowerShellFile(
  filePath: string,
  fileArgs: string[],
  cwd: string,
): PowerShellResult {
  const executable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive'];
  if (process.platform === 'win32') {
    args.push('-ExecutionPolicy', 'Bypass');
  }
  args.push('-File', filePath, ...fileArgs);
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    timeout: powerShellTimeoutMs,
    windowsHide: true,
  });
  return {
    error: result.error,
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function runPowerShellFileAsync(
  filePath: string,
  fileArgs: string[],
  cwd: string,
): Promise<PowerShellResult> {
  const executable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive'];
  if (process.platform === 'win32') {
    args.push('-ExecutionPolicy', 'Bypass');
  }
  args.push('-File', filePath, ...fileArgs);
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let spawnError: Error | undefined;
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      spawnError = error;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, powerShellTimeoutMs);
    child.on('close', (status) => {
      clearTimeout(timeout);
      resolve({
        error:
          spawnError ??
          (timedOut
            ? new Error(`PowerShell timed out after ${powerShellTimeoutMs}ms`)
            : undefined),
        status: status ?? -1,
        stdout,
        stderr,
      });
    });
  });
}

function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function powerShellArray(values: string[]): string {
  return `@(${values.map(powerShellQuote).join(', ')})`;
}

function createTemporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function writeFixtureFile(
  root: string,
  relativePath: string,
  content: string,
): void {
  const fullPath = join(root, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as T;
}

function sha256File(path: string): string {
  return createHash('sha256')
    .update(readFileSync(path))
    .digest('hex')
    .toUpperCase();
}

function listRelativeFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        files.push(relative(root, fullPath).replace(/\\/g, '/'));
      }
    }
  };
  visit(root);
  return files.sort();
}
