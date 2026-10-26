import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

jest.setTimeout(180_000);

const scriptPath = join(
  process.cwd(),
  'scripts/create-purchase-manager-approval-card-hotfix-package.ps1',
);
const runbookPath = join(
  process.cwd(),
  'docs/runbooks/purchase-manager-approval-card-operations.md',
);
const baseArchivePath = join(
  process.cwd(),
  'output/hotfix/purchase-single-procurement-order-hotfix-20260731-082059.zip',
);
const frozenBaseSha256 =
  '5F346ECDDF34BFD6E58824A17A40A221277F02F574B483715ABD94E51D6A8351';
const baseArchiveRelativePath =
  'output/hotfix/purchase-single-procurement-order-hotfix-20260731-082059.zip';
const baseReadmeRelativePath =
  'README_PURCHASE_SINGLE_PROCUREMENT_ORDER_HOTFIX.md';
const packageType = 'purchase-manager-approval-card-combined-hotfix';
const baseServerPaths = [
  'dist/server/modules/purchase-inventory/purchase-application.validation.js',
  'dist/server/modules/purchase-inventory/purchase-application.service.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js',
];

const managerOverlayPaths = [
  'dist/server/modules/purchase-inventory/purchase-manager-approval-card.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.config.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.rules.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.service.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.scheduler.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.gateway.js',
  'dist/server/modules/purchase-inventory/purchase-workflow-callback.js',
  'dist/server/modules/purchase-inventory/purchase-workflow-callback.controller.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.store.js',
  'dist/server/modules/purchase-inventory/purchase-application.service.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.module.js',
  'dist/server/scripts/reconcile-purchase-manager-approval-delivery.js',
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
  'dist/server/scripts/reconcile-purchase-manager-approval-delivery.js',
];
const temporaryRoots: string[] = [];

describe('purchase manager approval combined hotfix package', () => {
  const readScript = () => readFileSync(scriptPath, 'utf8');
  const readRunbook = () => readFileSync(runbookPath, 'utf8');

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

    expect(actualBaseSha256).toBe(frozenBaseSha256);
    expect(script).toContain(
      "$baseArchiveRelativePath = 'output/hotfix/purchase-single-procurement-order-hotfix-20260731-082059.zip'",
    );
    expect(script).toContain(`$baseArchiveSha256 = '${frozenBaseSha256}'`);
    for (const contract of [
      'function Assert-BaseArchiveHash',
      'function Assert-SafeArchiveEntries',
      'function Assert-BaseManifest',
      'function Assert-ManifestFileHashes',
      'Base archive SHA256 mismatch.',
      'Base manifest entries do not exactly match the frozen archive.',
      'Base manifest hash mismatch:',
      '[System.IO.Compression.ZipFile]::ExtractToDirectory',
    ]) {
      expect(script).toContain(contract);
    }

    const hashCheck = script.indexOf(
      'Assert-BaseArchiveHash -ArchivePath $baseArchivePath',
    );
    const extraction = script.indexOf(
      'Expand-VerifiedBaseArchive -ArchivePath $baseArchivePath',
    );
    const baseManifestCheck = script.indexOf(
      'Assert-BaseManifest -ExtractedRoot $baseExtractDir',
    );
    const overlay = script.indexOf(
      'foreach ($relativePath in $managerOverlayRelativePaths)',
    );
    expect(hashCheck).toBeGreaterThan(-1);
    expect(extraction).toBeGreaterThan(hashCheck);
    expect(baseManifestCheck).toBeGreaterThan(extraction);
    expect(overlay).toBeGreaterThan(baseManifestCheck);
  });

  it('overlays exactly the manager-card server runtime whitelist', () => {
    const script = readScript();

    expect(
      readSingleQuotedArray(script, 'managerOverlayRelativePaths'),
    ).toEqual(managerOverlayPaths);
    expect(
      readSingleQuotedArray(script, 'preservedBaseServerRelativePaths'),
    ).toEqual([
      'dist/server/modules/purchase-inventory/purchase-application.validation.js',
      'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js',
    ]);
    expect(script).toContain('Assert-PreservedBaseManifestEntries');
    expect(script).toContain("$preservedBaseClientPrefix = 'dist/client/'");
    expect(script).not.toContain(
      'dist/server/modules/purchase-inventory/purchase-workflow.scheduler.js',
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

  it('checks compiled manager-card semantics before packaging', () => {
    const script = readScript();

    expect(script).toContain('function ConvertFrom-Utf8Base64Array');
    expect(script).toContain('function Assert-CompiledFileContains');
    expect(readSingleQuotedArray(script, 'cardMarkerBase64')).toEqual([
      '57u85ZCI6YeH6LSt',
      '5qW85qCL6Ieq6YeH',
      '6amz5Zue',
    ]);
    expect(readSingleQuotedArray(script, 'rejectionMarkerBase64')).toEqual([
      '6amz5Zue5Y6f5Zug',
    ]);
    expect(readSingleQuotedArray(script, 'callbackMarkers')).toEqual([
      'form_value',
      'manager_action',
    ]);
    expect(readSingleQuotedArray(script, 'managerNotificationMarkers')).toEqual(
      [
        'manager_approval_requested',
        'manager_approval_resolved',
        'manager_approval_reopened',
        'manager_approval_attention_required',
        'manual_reconciliation',
      ],
    );
    expect(readSingleQuotedArray(script, 'reconciliationMarkers')).toEqual([
      'verified-delivered',
      'verified-absent',
      'resolveUnknownManagerApprovalDelivery',
    ]);
  });

  it('rejects unsafe payloads, reparse points, duplicate paths, and partial path traversal', () => {
    const script = readScript();

    for (const contract of [
      'function Assert-ChildPath',
      'function Assert-SafePayloadPaths',
      'function Assert-NoReparsePoints',
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
      "'README_PURCHASE_MANAGER_APPROVAL_CARD_HOTFIX.md'",
      '$zipPath.sha256.txt',
      'CreateFromDirectory',
      'OpenRead($zipPath)',
      'Final ZIP entries do not exactly match the manifest and metadata files.',
      'Final archive manifest hash mismatch:',
      'ZIP SHA256 sidecar verification failed.',
    ]) {
      expect(script).toContain(contract);
    }
    expect(script).toContain(
      "$packageType = 'purchase-manager-approval-card-combined-hotfix'",
    );
    expect(script).toContain('baseArchiveSha256 = $baseArchiveSha256');
    expect(script).toContain('[string]$manifest.package -cne $packageName');
    expect(script).toContain(
      '[string]$manifest.baseArchive -cne $baseArchiveRelativePath',
    );
  });

  it('runs the complete SkipBuild package flow and independently verifies both integrity layers', () => {
    const fixture = getSuccessfulPackageFixture();

    expect(fixture.result.error).toBeUndefined();
    expect(fixture.result.status).toBe(0);
    expect(fixture.resultOutput).toContain(
      '[OK] Purchase manager approval combined hotfix created.',
    );

    const manifest = readJson<HotfixManifest>(fixture.manifestPath);
    expect(manifest.package).toBe(basename(fixture.stageDir));
    expect(manifest.packageType).toBe(packageType);
    expect(manifest.baseArchive).toBe(baseArchiveRelativePath);
    expect(manifest.baseArchiveSha256).toBe(fixture.baseArchiveSha256);

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
    expect(
      readJson<HotfixManifest>(join(verificationRoot, 'hotfix-manifest.json')),
    ).toEqual(manifest);
    expect(sha256File(baseArchivePath)).toBe(frozenBaseSha256);
  });

  it('rejects an actual ZIP containing a traversal entry without extracting it', () => {
    const fixture = createIsolatedPackageFixture({
      maliciousBaseEntry: '../outside.js',
    });
    const result = runPackageScript(fixture);
    const resultOutput = `${result.stdout}\n${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(resultOutput).toContain('ZIP contains an unsafe entry path.');
    expect(readdirSync(fixture.outputDir)).toEqual([]);
    expect(existsSync(join(fixture.root, 'outside.js'))).toBe(false);
    expect(sha256File(baseArchivePath)).toBe(frozenBaseSha256);
  });

  it.each([
    ['package', 'purchase-manager-approval-card-hotfix-forged'],
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
  });

  it('cleans every partial output when the real package flow fails after staging starts', () => {
    const fixture = createIsolatedPackageFixture({
      directoryOverlayPath: managerOverlayPaths[1],
    });
    const result = runPackageScript(fixture);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Required hotfix payload is missing:',
    );
    expect(readdirSync(fixture.outputDir)).toEqual([]);
    expect(sha256File(baseArchivePath)).toBe(frozenBaseSha256);
  });

  it('keeps rollback from overwriting approval facts in the current ledger', () => {
    const script = readScript();

    expect(script).toContain(
      'Pause purchase submissions and stop the application before switching approval ownership.',
    );
    expect(script).toContain(
      'Keep purchase submissions paused throughout rollback.',
    );
    expect(script).toContain(
      'Audit the recorded transition window and reconcile every waiting approval before resuming submissions.',
    );
    expect(script).toContain(
      'Do not restore an older ledger over approvals that already occurred.',
    );
    expect(script).toContain(
      'Remove listed manager-card or reconciliation CLI files that did not exist before deployment.',
    );
    expect(script).not.toContain(
      'restore the backed-up client/server/ledger state',
    );
  });

  it('documents the safe rollout, reverse rollback, and controlled delivery reconciliation', () => {
    const runbook = readRunbook();

    for (const contract of [
      '推荐合并热包',
      '第一层：ZIP ↔ sidecar',
      '第二层：解压 payload ↔ manifest',
      '重新计算 ZIP 的 SHA-256',
      'manifest.files',
      '不得有额外文件或缺失文件',
      'PURCHASE_MANAGER_APPROVAL_CARD_ENABLED=false',
      'PURCHASE_MANAGER_APPROVER_OPEN_ID',
      'PURCHASE_MANAGER_APPROVER_NAME',
      'FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN',
      'PURCHASE_WORKFLOW_PROGRAM_ENABLED=false',
      '唯一',
      '停用',
      '多维表',
      '经理审批',
      '反向顺序',
      '停止应用',
      '备份',
      'verified-delivered',
      'verified-absent',
      '--message-id',
      'controlled new generation',
      '禁止直接编辑账本',
      'replacement',
      'manager_approval_attention_required',
      '暂停采购申请提交',
      '记录切换时间窗',
      '核对并补登记',
      '恢复采购申请提交',
    ]) {
      expect(runbook).toContain(contract);
    }

    const deployDisabled = runbook.indexOf(
      'PURCHASE_MANAGER_APPROVAL_CARD_ENABLED=false',
    );
    const validateCallback = runbook.indexOf('验证回调与唯一经理配置');
    const disableDuplicate = runbook.indexOf('停用多维表中重复的经理审批动作');
    const enableFeature = runbook.indexOf(
      'PURCHASE_MANAGER_APPROVAL_CARD_ENABLED=true',
    );
    expect(deployDisabled).toBeGreaterThan(-1);
    expect(validateCallback).toBeGreaterThan(deployDisabled);
    expect(disableDuplicate).toBeGreaterThan(validateCallback);
    expect(enableFeature).toBeGreaterThan(disableDuplicate);
    expect(runbook.indexOf('暂停采购申请提交')).toBeLessThan(disableDuplicate);
    expect(runbook.indexOf('记录切换时间窗')).toBeLessThan(disableDuplicate);
    expect(runbook.indexOf('核对并补登记')).toBeGreaterThan(enableFeature);
    expect(runbook.indexOf('恢复采购申请提交')).toBeGreaterThan(enableFeature);
  });
});

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
      name.startsWith('purchase-manager-approval-card-hotfix-') &&
      name.endsWith('.zip'),
  );
  if (zipNames.length !== 1) {
    throw new Error(
      `Expected one fixture ZIP, found ${zipNames.length}: ${zipNames.join(', ')}`,
    );
  }
  const zipPath = join(fixture.outputDir, zipNames[0]);
  const stageDir = join(fixture.outputDir, zipNames[0].slice(0, -4));
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
    directoryOverlayPath?: string;
  } = {},
): IsolatedPackageFixture {
  const root = createTemporaryRoot('purchase-manager-package-');
  const copiedScriptPath = join(
    root,
    'scripts/create-purchase-manager-approval-card-hotfix-package.ps1',
  );
  const outputDir = join(root, 'package-output');
  const baseStage = join(root, '.base-stage');
  const fixtureBaseArchivePath = join(root, baseArchiveRelativePath);

  mkdirSync(outputDir, { recursive: true });
  mkdirSync(baseStage, { recursive: true });

  const basePayload = new Map<string, string>([
    [baseReadmeRelativePath, '# Frozen base fixture\n'],
    ['dist/client/index.html', '<main>frozen client fixture</main>\n'],
    [baseServerPaths[0], 'module.exports = { validation: true };\n'],
    [baseServerPaths[1], 'module.exports = { application: "base" };\n'],
    [baseServerPaths[2], 'module.exports = { mapper: true };\n'],
  ]);
  for (const [relativePath, content] of basePayload) {
    writeFixtureFile(baseStage, relativePath, content);
  }
  const baseManifest = {
    schemaVersion: 1,
    package: 'purchase-single-procurement-order-hotfix-20260731-082059',
    packageType: 'purchase-single-procurement-order-hotfix',
    replaceDirectories: ['dist/client'],
    replaceFiles: baseServerPaths,
    files: [...basePayload.keys()].sort().map((relativePath) => ({
      path: relativePath,
      sha256: sha256File(join(baseStage, relativePath)),
    })),
  };
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
  const fixtureBaseArchiveSha256 = sha256File(fixtureBaseArchivePath);

  for (const relativePath of managerOverlayPaths) {
    const fullPath = join(root, relativePath);
    if (relativePath === options.directoryOverlayPath) {
      mkdirSync(fullPath, { recursive: true });
      continue;
    }
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

function overlayFixtureContent(relativePath: string): string {
  if (relativePath.endsWith('purchase-manager-approval-card.js')) {
    return 'const labels = ["综合采购", "楼栋自采", "驳回"];\n';
  }
  if (relativePath.endsWith('purchase-manager-approval.rules.js')) {
    return 'const rejectionField = "驳回原因";\n';
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
    windowsHide: true,
  });
  return {
    error: result.error,
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
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
