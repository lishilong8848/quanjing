import * as fs from 'node:fs';
import * as path from 'node:path';

describe('safe full-runtime hotfix clean build contract', () => {
  const scriptPath = path.resolve(
    __dirname,
    '../../scripts/create-safe-full-runtime-hotfix-package.ps1',
  );

  const readSource = () => fs.readFileSync(scriptPath, 'utf8');

  it('requires an explicit production-equivalent Node and npm distribution', () => {
    const source = readSource();

    expect(source).toContain('[string]$BuildNodePath');
    expect(source).toContain('[string]$BuildNpmPath');
    expect(source).toContain('[string]$VerifiedProductionNodeModulesRoot');
    expect(source).toContain("'24.15.0'");
    expect(source).toContain('Build Node and npm must belong to the same');
    expect(source).not.toContain('& npm.cmd run build:prod');
    expect(source).toContain("GetFileName($resolvedNode) -cne 'node.exe'");
    expect(source).toContain("'node_modules\\npm\\bin\\npm-cli.js'");
    expect(source).toContain('NumberOfLinks');
    expect(source).toContain('Get-AuthenticodeSignature');
    expect(source).toContain('Assert-BuildToolsUnchanged');
    expect(source).toContain("'NODE_OPTIONS'");
    expect(source).toContain("'NODE_PATH'");
    expect(source).toContain("$safeEnvironment['CLIENT_BASE_PATH'] = '/'");
  });

  it('builds only from an immutable allowlisted temporary snapshot', () => {
    const source = readSource();

    expect(source).toContain('function New-CleanBuildSnapshot');
    expect(source).toContain('function Get-SourceSnapshotFingerprint');
    expect(source).toContain('$sourceSnapshotFingerprintBefore');
    expect(source).toContain('$sourceSnapshotFingerprintAfter');
    expect(source).toContain('[System.IO.Path]::GetTempPath()');
    expect(source).toContain("'client'");
    expect(source).toContain("'server'");
    expect(source).toContain("'shared'");
    expect(source).toContain('$buildDirectoryAllowlist');
    expect(source).toContain('$buildFileAllowlist');
    expect(source).toContain("'scripts/verify-hotfix-smoke-preflight.mjs'");
    expect(source).toContain("'scripts/prepare-hotfix-smoke-standby.ps1'");
    expect(source).toContain("'scripts/run-hotfix-smoke-with-feishu-credentials.mjs'");
    expect(source).toContain('$releaseFileSources');
    expect(source).toContain('$supportSourceFiles');
    expect(source).toContain('$cleanBuildSnapshotRoot');
    expect(source).toContain('function Remove-ProjectBuildSnapshot');
    expect(source).toContain("Join-Path $projectRoot 'output'");
    expect(source).toContain(
      "'^\\.nantong-hotfix-build-source-\\d{8}-\\d{6}-[0-9a-f]{32}$'",
    );
    expect(source).not.toContain(
      'Move-Item -LiteralPath $distPath -Destination $previousDistBackup',
    );
    expect(source).not.toContain(
      "Join-Path $projectRoot '.tmp\\safe-hotfix-build-backups'",
    );
  });

  it('takes one project-wide packaging lease before creating a clean build workspace', () => {
    const source = readSource();

    expect(source).toContain('function New-WorkspacePackagingLease');
    expect(source).toContain('function Close-WorkspacePackagingLease');
    expect(source).toContain("'.nantong-full-runtime-hotfix-build.lock'");
    expect(source).toContain('[System.IO.FileShare]::None');
    expect(source).toContain(
      'Another full-runtime hotfix packaging process is already active for this project.',
    );

    const acquireLease = source.indexOf(
      '$workspacePackagingLease = New-WorkspacePackagingLease',
    );
    const createWorkspace = source.indexOf(
      'New-Item -ItemType Directory -Path $cleanBuildWorkspaceRoot',
    );
    const inspectBaseline = source.indexOf(
      '$baselineExportInitial = Assert-BaselineExportManifest',
    );
    const releaseLease = source.indexOf(
      'Close-WorkspacePackagingLease -Lease $workspacePackagingLease',
      createWorkspace,
    );
    expect(acquireLease).toBeGreaterThan(0);
    expect(inspectBaseline).toBeGreaterThan(acquireLease);
    expect(createWorkspace).toBeGreaterThan(acquireLease);
    expect(releaseLease).toBeGreaterThan(createWorkspace);
  });

  it('reuses a verified dependency tree and builds once without reinstalling dependencies', () => {
    const source = readSource();

    expect(source).not.toContain("'ci', '--include=dev'");
    expect(source).toContain("'--ignore-scripts'");
    expect(source).toContain('ensure-feishu-card-ws-sdk-patch.mjs');
    expect(source).toContain("'run'");
    expect(source).toContain("'build:prod'");
    expect(source).toContain(
      'function Resolve-VerifiedProductionNodeModulesRoot',
    );
    expect(source).toContain('function Assert-ReusedProductionFeishuSdkPatch');
    expect(source).toContain('function Assert-ReusedBuildToolchain');
    expect(source).toContain('$reusedProductionNodeModulesRoot');
    expect(source).not.toContain("'ci', '--omit=dev', '--ignore-scripts'");
    expect(source).not.toContain('$productionInstallArguments');
    expect(source).not.toContain('$productionNpmCache');
    expect(source).toContain('dist\\server\\main.js');

    const dependencyGate = source.indexOf(
      '$dependencyGateReport = Invoke-NodeJsonGate',
    );
    const toolchainGate = source.indexOf(
      'Assert-ReusedBuildToolchain',
      dependencyGate,
    );
    const build = source.indexOf('$productionBuildArguments', toolchainGate);
    const runtimeGate = source.indexOf(
      'verify-production-runtime-closure.mjs',
      build,
    );
    expect(dependencyGate).toBeGreaterThan(0);
    expect(toolchainGate).toBeGreaterThan(dependencyGate);
    expect(build).toBeGreaterThan(toolchainGate);
    expect(runtimeGate).toBeGreaterThan(build);
  });

  it('connects dependency, runtime-closure, and active-client-asset gates', () => {
    const source = readSource();

    expect(source).toContain('verify-hotfix-dependency-transition.mjs');
    expect(source).toContain('verify-production-runtime-closure.mjs');
    expect(source).toContain('verify-client-asset-graph.mjs');
    expect(source).toContain('metadataVerified');
    expect(source).toContain('physicalVerified');
    expect(source).toContain('requiresNodeModulesMutation');
    expect(source).toContain('expectedBuildFingerprint');
    expect(source).toContain('buildFingerprint');
    expect(source).toContain('runtimeClosureFingerprint');
    expect(source).toContain('--verified-lock-physical-tree-fingerprint');
    expect(source).toContain('--verified-installed-physical-tree-fingerprint');
    expect(source).toContain("dependencyMode -cne 'verified-transition'");
    expect(source).toContain("thirdPartyAstMode -cne 'locked-physical-tree'");
    expect(source).toContain('activeClientAssetFingerprint');
    expect(source).toContain('Expected exactly one JSON result');
    expect(source).toContain(
      'Source maps are forbidden in hotfix runtime roots',
    );
    expect(source).toContain('stageDependencyGateReport');
    expect(source).not.toContain('stageRuntimeGateReport');
    expect(source).not.toContain('Staged production runtime closure gate');
    expect(source).toContain(
      '$stageExpectedBuildFingerprint -cne $expectedBuildFingerprint',
    );
    expect(source).toContain('stageClientGateReport');
    expect(source).toContain('Assert-ArchiveEvidenceBinding');
    expect(source).toContain('candidatePackageLockSha256');
  });

  it('binds the no-mutation dependency proof to one runtime closure gate', () => {
    const source = readSource();

    expect(source.match(/'--verified-dependency-transition'/g)).toHaveLength(1);
    expect(
      source.match(/'--verified-lock-physical-tree-fingerprint'/g),
    ).toHaveLength(1);
    expect(
      source.match(/'--verified-installed-physical-tree-fingerprint'/g),
    ).toHaveLength(1);
    expect(source).toContain("'locked-physical-tree'");
    expect(source).toContain('verifiedDependencyTransition');
    expect(source).toContain('verifiedLockPhysicalTreeFingerprint');
    expect(source).toContain('verifiedInstalledPhysicalTreeFingerprint');
    expect(source).toContain('dependencyRuntimeAuditMode');
    expect(source).toContain(
      '$stageDependencyGateReport = $dependencyGateReport',
    );
    expect(source).toContain('$frozenCandidatePackageSha256');
    expect(source).toContain('$frozenCandidatePackageLockSha256');
    expect(source).not.toContain("-Label 'Staged dependency transition gate'");
    expect(source).toContain(
      "@('none', 'runtime-root-declarations-only') -cnotcontains [string]$dependencyGateReport.transition",
    );
  });

  it('writes a bounded partial archive and promotes it only after exact reopen audit', () => {
    const source = readSource();

    expect(source).toContain('$ownerToken + ".zip.partial"');
    expect(source).toContain('function Assert-ReopenedHotfixArchive');
    expect(source).toContain('ZipArchiveMode]::Read');
    expect(source).toContain('Unexpected archive entry');
    expect(source).toContain('Archive entry is missing');
    expect(source).toContain('Archive entry hash differs');
    expect(source).toContain('$maxArchiveBytes');
    expect(source).toContain('$maxRuntimeStageBytes');
    expect(source).toContain('$maxActiveClientChunkCount');
    expect(source).toContain('$maxRuntimeStageFileCount');
    expect(source).toContain('MoveFileEx');
    expect(source).toContain('New-PackageOutputReservation');
    expect(source).toContain('FileMode]::CreateNew');
    expect(source).toContain('Prepare-VerifiedHotfixArchive');
    expect(source).toContain('Publish-VerifiedReadyMarker');

    const publishZip = source.indexOf(
      'Publish-AtomicFile -Source $PartialZipPath -Destination $ZipPath',
    );
    const postPublishAudit = source.indexOf(
      'Assert-ReopenedHotfixArchive',
      publishZip + 1,
    );
    const publishReadyMarker = source.indexOf(
      'Publish-AtomicFile -Source $PartialShaPath -Destination $ShaPath',
      postPublishAudit,
    );
    expect(publishZip).toBeGreaterThan(0);
    expect(postPublishAudit).toBeGreaterThan(publishZip);
    expect(publishReadyMarker).toBeGreaterThan(postPublishAudit);
  });

  it('freezes the release tool and server baseline snapshot through promotion', () => {
    const source = readSource();

    expect(source).toContain('releaseToolFingerprint');
    expect(source).toContain('Assert-ReleaseToolUnchanged');
    expect(source).toContain(
      "'scripts/create-safe-full-runtime-hotfix-package.ps1'",
    );
    expect(source).toContain('New-VerifiedBaselineSnapshot');
    expect(source).toContain('Assert-BaselineExportSourceUnchanged');
    expect(source).toContain('$baselineSnapshotExportRoot');
  });

  it('does not source runtime or release payloads from the mutable workspace after the build starts', () => {
    const source = readSource();

    expect(source).toContain(
      '$sourceSnapshotFingerprintBefore -cne $sourceSnapshotFingerprintAfter',
    );
    expect(source).toContain('$workspaceDistFingerprintBefore');
    expect(source).toContain('$workspaceDistFingerprintAfter');
    expect(source).toContain(
      'Workspace dist changed during isolated hotfix packaging',
    );
    expect(source).not.toContain(
      '$source = Join-Path $projectRoot $runtimeRoot',
    );
    expect(source).not.toContain(
      '$source = Join-Path $projectRoot $entry.Value',
    );
  });
});
