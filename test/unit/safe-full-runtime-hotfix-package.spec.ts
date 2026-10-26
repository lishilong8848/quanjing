import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

jest.setTimeout(120_000);

type BaselineEntry = {
  path: string;
  size: number;
  sha256: string;
  reason?: string;
};

const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

const extractInstallerSource = (source: string) => {
  const match = source.match(
    /\$installer = @'\r?\n([\s\S]*?)\r?\n'@\r?\nSet-Content -LiteralPath \(Join-Path \$stageRoot 'INSTALL-HOTFIX\.ps1'\)/,
  );
  if (!match) {
    throw new Error('embedded installer could not be extracted');
  }
  return match[1];
};

const sortEntriesByUtf8Path = (entries: BaselineEntry[]) =>
  [...entries].sort((left, right) =>
    Buffer.from(left.path, 'utf8').compare(Buffer.from(right.path, 'utf8')),
  );

const fingerprintEntries = (entries: BaselineEntry[]) =>
  sha256(
    sortEntriesByUtf8Path(entries)
      .map((entry) => `${entry.path}:${entry.size}:${entry.sha256}`)
      .join('\n'),
  );

const exportPlanFingerprint = (
  payloadEntries: BaselineEntry[],
  metadataEntries: BaselineEntry[],
) =>
  sha256(
    sortEntriesByUtf8Path([...payloadEntries, ...metadataEntries])
      .map((entry) =>
        entry.reason
          ? `metadata\0${entry.reason}\0${entry.path}\0${entry.size}\0${entry.sha256}`
          : `payload\0${entry.path}\0${entry.size}\0${entry.sha256}`,
      )
      .join('\n'),
  );

const recomputeBaselineExportPlanFingerprint = (
  manifest: Record<string, any>,
) => {
  manifest.exportPlanFingerprint = exportPlanFingerprint(
    manifest.files,
    manifest.nonExportedRuntimeFiles,
  );
};

const recomputeHotfixExportPlanFingerprint = (
  manifest: Record<string, any>,
) => {
  const payload = manifest.serverBaselineFiles.filter(
    (entry: BaselineEntry) =>
      !Object.prototype.hasOwnProperty.call(entry, 'reason'),
  );
  const metadata = manifest.serverBaselineFiles.filter((entry: BaselineEntry) =>
    Object.prototype.hasOwnProperty.call(entry, 'reason'),
  );
  manifest.baselineExportPlanFingerprint = exportPlanFingerprint(
    payload,
    metadata,
  );
};

const writeBaselineFile = (
  baselineRoot: string,
  relativePath: string,
  content: string,
): BaselineEntry => {
  const fullPath = path.join(baselineRoot, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  const bytes = Buffer.from(content);
  return {
    path: relativePath,
    size: bytes.length,
    sha256: sha256(bytes),
  };
};

const createSchema3Baseline = (
  root: string,
  mutate?: (manifest: Record<string, any>) => void,
) => {
  const baselineRoot = path.join(root, 'baseline');
  fs.mkdirSync(baselineRoot, { recursive: true });
  const files = [
    writeBaselineFile(baselineRoot, 'package.json', '{"name":"baseline"}'),
    writeBaselineFile(baselineRoot, 'dist/server/main.js', 'server-runtime'),
    writeBaselineFile(baselineRoot, 'dist/shared/value.js', 'shared-runtime'),
    writeBaselineFile(baselineRoot, 'dist/client/main.js', 'client-runtime'),
  ];
  const metadata: BaselineEntry[] = [
    {
      path: 'dist/server/main.js.map',
      size: Buffer.byteLength('server-source-map'),
      sha256: sha256('server-source-map'),
      reason: 'source-map-content-not-exported',
    },
    {
      path: 'dist/client/chunks/4576.1234abcd.js',
      size: Buffer.byteLength('historical-client-chunk'),
      sha256: sha256('historical-client-chunk'),
      reason: 'unreferenced-client-chunk-content-not-exported',
    },
  ];
  const allEntries = [...files, ...metadata];
  const manifest: Record<string, any> = {
    schemaVersion: 3,
    exportType: 'server-hotfix-baseline-read-only',
    exportPlanAlgorithm: 'webpack-main-runtime-map-v1',
    baseFingerprint: sha256('base'),
    baselineFingerprint: fingerprintEntries(allEntries),
    exportPlanFingerprint: exportPlanFingerprint(files, metadata),
    distFingerprints: Object.fromEntries(
      ['dist/server', 'dist/shared', 'dist/client'].map((runtimeRoot) => [
        runtimeRoot,
        fingerprintEntries(
          allEntries.filter((entry) =>
            entry.path.toLowerCase().startsWith(`${runtimeRoot}/`),
          ),
        ),
      ]),
    ),
    uncompressedBytes: files.reduce((sum, entry) => sum + entry.size, 0),
    fileCount: files.length,
    baselineFileCount: allEntries.length,
    nonExportedRuntimeFileCount: metadata.length,
    files,
    nonExportedRuntimeFiles: metadata,
  };
  mutate?.(manifest);
  fs.writeFileSync(
    path.join(root, 'server-baseline-manifest.json'),
    JSON.stringify(manifest),
  );
  return { baselineRoot, manifest };
};

const readJson = (filePath: string) =>
  JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, any>;

const writeJson = (filePath: string, value: Record<string, any>) =>
  fs.writeFileSync(filePath, JSON.stringify(value));

describe('safe full runtime hotfix package', () => {
  const scriptPath = path.resolve(
    process.cwd(),
    'scripts/create-safe-full-runtime-hotfix-package.ps1',
  );

  const validationRoots: string[] = [];

  it('ships the verified deployment stop launcher as a managed root file', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    expect(
      source.match(/'stop\.ps1'\s*=\s*'deploy\/stop\.ps1'/gu) || [],
    ).toHaveLength(1);
  });

  afterEach(() => {
    for (const root of validationRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const createValidationFixture = (
    mutate?: (manifest: Record<string, any>) => void,
    addMetadataContent = false,
  ) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nantong-schema3-'));
    validationRoots.push(root);
    const fixture = createSchema3Baseline(root, mutate);
    if (addMetadataContent) {
      const metadataPath = fixture.manifest.nonExportedRuntimeFiles[0].path;
      const fullPath = path.join(
        fixture.baselineRoot,
        ...metadataPath.split('/'),
      );
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, 'server-source-map');
    }
    return root;
  };

  const updateValidationFixture = (
    root: string,
    mutate: (manifest: Record<string, any>) => void,
  ) => {
    const manifestPath = path.join(root, 'server-baseline-manifest.json');
    const manifest = readJson(manifestPath);
    mutate(manifest);
    writeJson(manifestPath, manifest);
  };

  it('executes schema 3 validation and rejects reason, path, count, plan, and metadata-content tampering', () => {
    const missingPayloadRoot = createValidationFixture();
    fs.rmSync(path.join(missingPayloadRoot, 'baseline/dist/server/main.js'));
    const extraPayloadRoot = createValidationFixture();
    fs.writeFileSync(
      path.join(extraPayloadRoot, 'baseline/dist/server/extra.js'),
      'extra',
    );
    const caseDuplicateRoot = createValidationFixture();
    updateValidationFixture(caseDuplicateRoot, (manifest) => {
      const duplicate = {
        ...manifest.nonExportedRuntimeFiles[1],
        path: manifest.nonExportedRuntimeFiles[1].path.toUpperCase(),
      };
      manifest.files.push(duplicate);
      const duplicatePath = path.join(
        caseDuplicateRoot,
        'baseline',
        ...duplicate.path.split('/'),
      );
      fs.mkdirSync(path.dirname(duplicatePath), { recursive: true });
      fs.writeFileSync(duplicatePath, 'historical-client-chunk');
    });
    const cases: Array<{
      name: string;
      root: string;
      expected: boolean;
      errorContains?: string;
    }> = [
      { name: 'valid', root: createValidationFixture(), expected: true },
      {
        name: 'schema',
        root: createValidationFixture((manifest) => {
          manifest.schemaVersion = 2;
        }),
        expected: false,
      },
      {
        name: 'schemaString',
        root: createValidationFixture((manifest) => {
          manifest.schemaVersion = '3';
        }),
        expected: false,
        errorContains: 'Manifest integer property is invalid',
      },
      {
        name: 'type',
        root: createValidationFixture((manifest) => {
          manifest.exportType = 'wrong-type';
        }),
        expected: false,
      },
      {
        name: 'algorithm',
        root: createValidationFixture((manifest) => {
          manifest.exportPlanAlgorithm = 'wrong-algorithm';
        }),
        expected: false,
      },
      {
        name: 'reason',
        root: createValidationFixture((manifest) => {
          manifest.nonExportedRuntimeFiles[0].reason = 'unsupported-reason';
          recomputeBaselineExportPlanFingerprint(manifest);
        }),
        expected: false,
        errorContains: 'Unsupported metadata-only server baseline reason:',
      },
      {
        name: 'path',
        root: createValidationFixture((manifest) => {
          manifest.nonExportedRuntimeFiles[1].path =
            'dist/client/chunks/not-a-content-hash.js';
        }),
        expected: false,
      },
      {
        name: 'fileCount',
        root: createValidationFixture((manifest) => {
          manifest.fileCount += 1;
        }),
        expected: false,
      },
      {
        name: 'fileCountString',
        root: createValidationFixture((manifest) => {
          manifest.fileCount = String(manifest.fileCount);
        }),
        expected: false,
        errorContains: 'Manifest integer property is invalid',
      },
      {
        name: 'baselineCount',
        root: createValidationFixture((manifest) => {
          manifest.baselineFileCount += 1;
        }),
        expected: false,
      },
      {
        name: 'baselineCountDecimal',
        root: createValidationFixture((manifest) => {
          manifest.baselineFileCount = 6.5;
        }),
        expected: false,
        errorContains: 'Manifest integer property is invalid',
      },
      {
        name: 'metadataCount',
        root: createValidationFixture((manifest) => {
          manifest.nonExportedRuntimeFileCount += 1;
        }),
        expected: false,
      },
      {
        name: 'metadataCountNegative',
        root: createValidationFixture((manifest) => {
          manifest.nonExportedRuntimeFileCount = -1;
        }),
        expected: false,
        errorContains: 'Manifest integer property is invalid',
      },
      {
        name: 'bytes',
        root: createValidationFixture((manifest) => {
          manifest.uncompressedBytes += 1;
        }),
        expected: false,
      },
      {
        name: 'bytesOutOfRange',
        root: createValidationFixture((manifest) => {
          manifest.uncompressedBytes = 1e30;
        }),
        expected: false,
        errorContains: 'Manifest integer property is invalid',
      },
      {
        name: 'plan',
        root: createValidationFixture((manifest) => {
          manifest.exportPlanFingerprint = '0'.repeat(64);
        }),
        expected: false,
      },
      {
        name: 'baselineFingerprint',
        root: createValidationFixture((manifest) => {
          manifest.baselineFingerprint = '0'.repeat(64);
        }),
        expected: false,
      },
      ...['dist/server', 'dist/shared', 'dist/client'].map((runtimeRoot) => ({
        name: `fingerprint-${runtimeRoot}`,
        root: createValidationFixture((manifest) => {
          manifest.distFingerprints[runtimeRoot] = '0'.repeat(64);
        }),
        expected: false,
      })),
      {
        name: 'payloadMissing',
        root: missingPayloadRoot,
        expected: false,
      },
      {
        name: 'payloadExtra',
        root: extraPayloadRoot,
        expected: false,
      },
      {
        name: 'payloadHash',
        root: createValidationFixture((manifest) => {
          manifest.files[1].sha256 = '0'.repeat(64);
        }),
        expected: false,
      },
      {
        name: 'payloadHashUppercase',
        root: createValidationFixture((manifest) => {
          manifest.files[1].sha256 = manifest.files[1].sha256.toUpperCase();
        }),
        expected: false,
      },
      {
        name: 'metadataHashUppercase',
        root: createValidationFixture((manifest) => {
          manifest.nonExportedRuntimeFiles[0].sha256 =
            manifest.nonExportedRuntimeFiles[0].sha256.toUpperCase();
        }),
        expected: false,
      },
      {
        name: 'payloadSize',
        root: createValidationFixture((manifest) => {
          manifest.files[1].size += 1;
        }),
        expected: false,
      },
      {
        name: 'payloadSizeString',
        root: createValidationFixture((manifest) => {
          manifest.files[1].size = String(manifest.files[1].size);
        }),
        expected: false,
        errorContains: 'Manifest integer property is invalid',
      },
      {
        name: 'metadataSizeDecimal',
        root: createValidationFixture((manifest) => {
          manifest.nonExportedRuntimeFiles[0].size = 17.5;
        }),
        expected: false,
        errorContains: 'Manifest integer property is invalid',
      },
      {
        name: 'payloadSizeNegative',
        root: createValidationFixture((manifest) => {
          manifest.files[1].size = -1;
        }),
        expected: false,
        errorContains: 'Manifest integer property is invalid',
      },
      {
        name: 'payloadSizeOutOfRange',
        root: createValidationFixture((manifest) => {
          manifest.files[1].size = 1e30;
        }),
        expected: false,
        errorContains: 'Manifest integer property is invalid',
      },
      {
        name: 'backslashPath',
        root: createValidationFixture((manifest) => {
          manifest.files[1].path = 'dist\\server\\main.js';
        }),
        expected: false,
        errorContains: 'Non-canonical relative path',
      },
      {
        name: 'trailingDotPath',
        root: createValidationFixture((manifest) => {
          manifest.files[1].path = 'dist/server./main.js';
        }),
        expected: false,
        errorContains: 'Non-canonical relative path',
      },
      {
        name: 'caseDuplicate',
        root: caseDuplicateRoot,
        expected: false,
        errorContains: 'Duplicate server baseline manifest path',
      },
      {
        name: 'metadataContent',
        root: createValidationFixture(undefined, true),
        expected: false,
      },
    ];
    const harnessRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nantong-schema3-harness-'),
    );
    validationRoots.push(harnessRoot);
    const quote = (value: string) => value.replace(/'/g, "''");
    const harnessPath = path.join(harnessRoot, 'validate.ps1');
    fs.writeFileSync(
      harnessPath,
      `\ufeff${[
        "$ErrorActionPreference = 'Stop'",
        '$results = [ordered]@{}',
        ...cases.flatMap((testCase) => [
          'try {',
          `  $output = @(& '${quote(scriptPath)}' -BaselineRoot '${quote(testCase.root)}' -ValidateBaselineOnly 2>&1)`,
          `  $results['${testCase.name}'] = [ordered]@{ success = $true; output = @($output | ForEach-Object { [string]$_ }) }`,
          '} catch {',
          `  $results['${testCase.name}'] = [ordered]@{ success = $false; error = [string]$_.Exception.Message }`,
          '}',
        ]),
        '$results | ConvertTo-Json -Compress -Depth 8',
      ].join('\r\n')}`,
    );
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harnessPath],
      { encoding: 'utf8', timeout: 60_000 },
    );

    expect(result.status).toBe(0);
    const results = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
    expect(results.valid.error).toBeUndefined();
    for (const testCase of cases) {
      expect(results[testCase.name]).toMatchObject({
        success: testCase.expected,
      });
      if (testCase.errorContains) {
        expect(results[testCase.name].error).toContain(testCase.errorContains);
      }
    }
    const validSummary = JSON.parse(results.valid.output.at(-1));
    expect(validSummary).toEqual({
      success: true,
      schemaVersion: 3,
      fileCount: 4,
      metadataOnlyFileCount: 2,
    });
    expect(results.valid.output.join('\n')).not.toContain(os.tmpdir());
    expect(results.valid.output.join('\n')).not.toContain(
      'Building the complete production runtime',
    );
    expect(results.metadataContent.error).toContain(
      'Metadata-only server baseline content must not be exported',
    );
  });

  it('validates a large metadata-only baseline within the fast preflight budget', () => {
    const root = createValidationFixture();
    updateValidationFixture(root, (manifest) => {
      const metadata = Array.from({ length: 1_500 }, (_, index) => ({
        path: `dist/client/chunks/history-${index}.${index
          .toString(16)
          .padStart(8, '0')}.js`,
        size: index + 1,
        sha256: sha256(`historical-client-chunk-${index}`),
        reason: 'unreferenced-client-chunk-content-not-exported',
      }));
      const allEntries = [...manifest.files, ...metadata];
      manifest.nonExportedRuntimeFiles = metadata;
      manifest.baselineFileCount = allEntries.length;
      manifest.nonExportedRuntimeFileCount = metadata.length;
      manifest.baselineFingerprint = fingerprintEntries(allEntries);
      manifest.distFingerprints = Object.fromEntries(
        ['dist/server', 'dist/shared', 'dist/client'].map((runtimeRoot) => [
          runtimeRoot,
          fingerprintEntries(
            allEntries.filter((entry) =>
              entry.path.toLowerCase().startsWith(`${runtimeRoot}/`),
            ),
          ),
        ]),
      );
      recomputeBaselineExportPlanFingerprint(manifest);
    });

    const startedAt = Date.now();
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-BaselineRoot',
        root,
        '-ValidateBaselineOnly',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );

    expect({
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stderr: result.stderr,
    }).toEqual({ status: 0, signal: null, error: undefined, stderr: '' });
    expect(Date.now() - startedAt).toBeLessThan(30_000);
  });

  it('parses one JSON gate document without depending on physical line wrapping', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const gateFunction = source.match(
      /function Invoke-NodeJsonGate \{[\s\S]*?\r?\n\}\r?\n\r?\nfunction Assert-NoSourceMapsInRuntimeRoots/,
    )?.[0];

    expect(gateFunction).toBeDefined();
    expect(gateFunction).toContain(
      'Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue',
    );
    expect(gateFunction).not.toContain('$stdoutLines.Count -ne 1');
    expect(gateFunction).toContain('$JsonReportPath');
    expect(source).toContain("'--json-output', $runtimeGateReportPath");
    expect(source).toContain('-JsonReportPath $runtimeGateReportPath');
  });

  const createInstallerValidationFixture = (
    mutate?: (
      manifest: Record<string, any>,
      context: { appRoot: string; packageRoot: string },
    ) => void,
  ) => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nantong-installer-schema3-'),
    );
    validationRoots.push(fixtureRoot);
    const exportRoot = path.join(fixtureRoot, 'export');
    const { baselineRoot, manifest: baselineManifest } =
      createSchema3Baseline(exportRoot);
    const appRoot = path.join(fixtureRoot, 'app');
    const packageRoot = path.join(fixtureRoot, 'package');
    fs.mkdirSync(appRoot, { recursive: true });
    fs.mkdirSync(packageRoot, { recursive: true });
    for (const entry of baselineManifest.files as BaselineEntry[]) {
      const source = path.join(baselineRoot, ...entry.path.split('/'));
      const destination = path.join(appRoot, ...entry.path.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
    const metadataContents: Record<string, string> = {
      'dist/server/main.js.map': 'server-source-map',
      'dist/client/chunks/4576.1234abcd.js': 'historical-client-chunk',
    };
    for (const entry of baselineManifest.nonExportedRuntimeFiles as BaselineEntry[]) {
      const destination = path.join(appRoot, ...entry.path.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, metadataContents[entry.path]);
    }
    const activeClientFiles = [
      ['dist/client/index.html', '<!doctype html>'],
      ['dist/client/main.js', 'client-main'],
      ['dist/client/main.css', 'client-style'],
    ].map(([entryPath, content]) => ({
      path: entryPath,
      size: Buffer.byteLength(content),
      sha256: sha256(content),
    }));
    const activeClientAssetFingerprint = sha256(
      activeClientFiles
        .map(
          (entry) =>
            `asset\0${entry.path.slice('dist/client/'.length)}\0${entry.size}\0${entry.sha256}`,
        )
        .sort((left, right) =>
          Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')),
        )
        .join('\n'),
    );
    const proofHash = sha256('installer-validation-proof');
    const hotfixManifest: Record<string, any> = {
      schemaVersion: 6,
      installedReleaseReceiptSchemaVersion: 2,
      releaseMode: 'complete-runtime-atomic-switch',
      releaseToolFingerprint: proofHash,
      dependencyTreeMode: 'verified-existing-production-tree',
      dependencyProofAlgorithm: 'sha256-package-lock-production-closure-v1',
      dependencyLockPhysicalTreeFingerprint: proofHash,
      dependencyInstalledPhysicalTreeFingerprint: proofHash,
      dependencyPackageCount: 1,
      dependencyFileCount: 1,
      dependencyBytes: 1,
      activeClientProofAlgorithm: 'sha256-active-client-closure-v2',
      activeClientAssetFingerprint,
      activeClientAssetCount: activeClientFiles.length,
      activeClientChunkCount: 1,
      activeClientFiles,
      payloadFiles: activeClientFiles,
      releaseFiles: [],
      recoveryLauncherSha256: proofHash,
      dependencyVerifierSha256: proofHash,
      clientVerifierSha256: proofHash,
      supportFiles: [
        'operations/deploy/hotfix-recovery-start.ps1',
        'operations/scripts/verify-hotfix-dependency-transition.mjs',
        'operations/scripts/verify-client-asset-graph.mjs',
      ].map((entryPath) => ({
        path: entryPath,
        size: 1,
        sha256: proofHash,
      })),
      controlFiles: [],
      baselineFingerprint: baselineManifest.baselineFingerprint,
      baselineExportSchemaVersion: baselineManifest.schemaVersion,
      baselineExportType: baselineManifest.exportType,
      baselineExportPlanAlgorithm: baselineManifest.exportPlanAlgorithm,
      baselineExportPlanFingerprint: baselineManifest.exportPlanFingerprint,
      baselineFileCount: baselineManifest.baselineFileCount,
      baselinePayloadFileCount: baselineManifest.fileCount,
      baselineMetadataOnlyFileCount:
        baselineManifest.nonExportedRuntimeFileCount,
      baselineUncompressedBytes: baselineManifest.uncompressedBytes,
      distFingerprints: baselineManifest.distFingerprints,
      serverBaselineFiles: [
        ...baselineManifest.files,
        ...baselineManifest.nonExportedRuntimeFiles,
      ],
    };
    const source = fs.readFileSync(scriptPath, 'utf8');
    const installerMatch = source.match(
      /\$installer\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@\r?\nSet-Content/,
    );
    if (!installerMatch) {
      throw new Error('Embedded installer script not found');
    }
    const installerPath = path.join(packageRoot, 'INSTALL-HOTFIX.ps1');
    fs.writeFileSync(installerPath, `\ufeff${installerMatch[1]}`);
    const installerBytes = fs.readFileSync(installerPath);
    hotfixManifest.installerSha256 = sha256(installerBytes);
    hotfixManifest.controlFiles = [
      {
        path: 'INSTALL-HOTFIX.ps1',
        size: installerBytes.length,
        sha256: hotfixManifest.installerSha256,
      },
    ];
    mutate?.(hotfixManifest, { appRoot, packageRoot });
    writeJson(path.join(packageRoot, 'hotfix-manifest.json'), hotfixManifest);
    return { appRoot, installerPath };
  };

  it('executes embedded installer schema 3 baseline validation and rejects manifest/runtime tampering', () => {
    const missingRoot = createInstallerValidationFixture(
      (_manifest, { appRoot }) => {
        fs.rmSync(path.join(appRoot, 'dist/server/main.js'));
      },
    );
    const extraRoot = createInstallerValidationFixture(
      (_manifest, { appRoot }) => {
        const extraPath = path.join(appRoot, 'dist/server/extra.js');
        fs.mkdirSync(path.dirname(extraPath), { recursive: true });
        fs.writeFileSync(extraPath, 'extra');
      },
    );
    const unlistedHistoricalClientChunkRoot = createInstallerValidationFixture(
      (_manifest, { appRoot }) => {
        const staleChunkPath = path.join(
          appRoot,
          'dist/client/chunks/1081.0a1c9365.js',
        );
        fs.mkdirSync(path.dirname(staleChunkPath), { recursive: true });
        fs.writeFileSync(staleChunkPath, 'unreferenced-historical-chunk');
      },
    );
    const unlistedHistoricalClientChunkMapRoot =
      createInstallerValidationFixture((_manifest, { appRoot }) => {
        const sourceMapPath = path.join(
          appRoot,
          'dist/client/chunks/1081.0a1c9365.js.map',
        );
        fs.mkdirSync(path.dirname(sourceMapPath), { recursive: true });
        fs.writeFileSync(sourceMapPath, 'unverified-source-map');
      });
    const unlistedNamedHistoricalClientChunkRoot =
      createInstallerValidationFixture((_manifest, { appRoot }) => {
        const staleChunkPath = path.join(
          appRoot,
          'dist/client/chunks/async-vendors.006dbfb8.js',
        );
        fs.mkdirSync(path.dirname(staleChunkPath), { recursive: true });
        fs.writeFileSync(staleChunkPath, 'unreferenced-named-historical-chunk');
      });
    const pairedNamedHistoricalClientChunkMapRoot =
      createInstallerValidationFixture((_manifest, { appRoot }) => {
        const staleChunkPath = path.join(
          appRoot,
          'dist/client/chunks/async-vendors.1db28cfa.js',
        );
        fs.mkdirSync(path.dirname(staleChunkPath), { recursive: true });
        fs.writeFileSync(staleChunkPath, 'unreferenced-named-historical-chunk');
        fs.writeFileSync(`${staleChunkPath}.map`, 'paired-source-map');
      });
    const orphanNamedHistoricalClientChunkMapRoot =
      createInstallerValidationFixture((_manifest, { appRoot }) => {
        const sourceMapPath = path.join(
          appRoot,
          'dist/client/chunks/async-vendors.5bdb6e1b.js.map',
        );
        fs.mkdirSync(path.dirname(sourceMapPath), { recursive: true });
        fs.writeFileSync(sourceMapPath, 'orphan-source-map');
      });
    const namedHistoricalClientChunkCaseVariantRoot =
      createInstallerValidationFixture((_manifest, { appRoot }) => {
        const staleChunkPath = path.join(
          appRoot,
          'dist/client/chunks/Async-Vendors.006dbfb8.js',
        );
        fs.mkdirSync(path.dirname(staleChunkPath), { recursive: true });
        fs.writeFileSync(staleChunkPath, 'case-variant');
      });
    const multipleUnexpectedRuntimeFilesRoot = createInstallerValidationFixture(
      (_manifest, { appRoot }) => {
        const serverExtra = path.join(appRoot, 'dist/server/extra-a.js');
        const sharedExtra = path.join(appRoot, 'dist/shared/extra-b.js');
        fs.mkdirSync(path.dirname(serverExtra), { recursive: true });
        fs.mkdirSync(path.dirname(sharedExtra), { recursive: true });
        fs.writeFileSync(serverExtra, 'server-extra');
        fs.writeFileSync(sharedExtra, 'shared-extra');
      },
    );
    const obsoleteCertificateSchedulerDeclarationRoot =
      createInstallerValidationFixture((_manifest, { appRoot }) => {
        const obsoletePath = path.join(
          appRoot,
          'dist/server/modules/bitable-sync/certificate-dashboard.scheduler.d.ts',
        );
        fs.mkdirSync(path.dirname(obsoletePath), { recursive: true });
        fs.writeFileSync(
          obsoletePath,
          Buffer.from(
            'aW1wb3J0IHsgdHlwZSBPbk1vZHVsZURlc3Ryb3ksIHR5cGUgT25Nb2R1bGVJbml0IH0gZnJvbSAnQG5lc3Rqcy9jb21tb24nOwppbXBvcnQgeyBDZXJ0aWZpY2F0ZURhc2hib2FyZFNlcnZpY2UgfSBmcm9tICcuL2NlcnRpZmljYXRlLWRhc2hib2FyZC5zZXJ2aWNlJzsKZXhwb3J0IGRlY2xhcmUgY2xhc3MgQ2VydGlmaWNhdGVEYXNoYm9hcmRTY2hlZHVsZXIgaW1wbGVtZW50cyBPbk1vZHVsZUluaXQsIE9uTW9kdWxlRGVzdHJveSB7CiAgICBwcml2YXRlIHJlYWRvbmx5IHNlcnZpY2U7CiAgICBwcml2YXRlIHJlYWRvbmx5IGxvZ2dlcjsKICAgIHByaXZhdGUgdGltZXI7CiAgICBwcml2YXRlIHN0YXJ0ZWQ7CiAgICBjb25zdHJ1Y3RvcihzZXJ2aWNlOiBDZXJ0aWZpY2F0ZURhc2hib2FyZFNlcnZpY2UpOwogICAgb25Nb2R1bGVJbml0KCk6IHZvaWQ7CiAgICBvbk1vZHVsZURlc3Ryb3koKTogdm9pZDsKICAgIHByaXZhdGUgc2NoZWR1bGVOZXh0Owp9CmV4cG9ydCBkZWNsYXJlIGZ1bmN0aW9uIG5leHRDZXJ0aWZpY2F0ZURhc2hib2FyZFJ1bkF0KG5vdzogRGF0ZSwgaG91cjogbnVtYmVyLCBtaW51dGU6IG51bWJlcik6IERhdGU7Cg==',
            'base64',
          ),
        );
      });
    const obsoleteCertificateSchedulerDeclarationMismatchRoot =
      createInstallerValidationFixture((_manifest, { appRoot }) => {
        const obsoletePath = path.join(
          appRoot,
          'dist/server/modules/bitable-sync/certificate-dashboard.scheduler.d.ts',
        );
        fs.mkdirSync(path.dirname(obsoletePath), { recursive: true });
        fs.writeFileSync(obsoletePath, 'tampered-type-declaration');
      });
    const historicalClientOverlayChunkRoot = createInstallerValidationFixture(
      (_manifest, { appRoot }) => {
        const obsoletePath = path.join(
          appRoot,
          'dist/client/chunks/6968.c7c6fa78.js',
        );
        fs.mkdirSync(path.dirname(obsoletePath), { recursive: true });
        fs.writeFileSync(
          obsoletePath,
          Buffer.from(
            'd2luZG93Ll9fUkVMRUFTRV9DT01NSVRfSURfXz0iMjAyNi0wOC0zMVQwNDowODowNi42NjRaIjsidXNlIHN0cmljdCI7KHRoaXMud2VicGFja0NodW5rZnVsbHN0YWNrX25lc3Rqc190ZW1wbGF0ZT10aGlzLndlYnBhY2tDaHVua2Z1bGxzdGFja19uZXN0anNfdGVtcGxhdGV8fFtdKS5wdXNoKFtbIjY5NjgiXSx7MzA4OTEoKXt9fV0pOw==',
            'base64',
          ),
        );
      },
    );
    const historicalClientOverlayChunkMismatchRoot =
      createInstallerValidationFixture((_manifest, { appRoot }) => {
        const obsoletePath = path.join(
          appRoot,
          'dist/client/chunks/6968.c7c6fa78.js',
        );
        fs.mkdirSync(path.dirname(obsoletePath), { recursive: true });
        fs.writeFileSync(obsoletePath, 'tampered-historical-client-chunk');
      });
    const weatherHistoricalClientChunkRoot = createInstallerValidationFixture(
      (_manifest, { appRoot }) => {
        const obsoletePath = path.join(
          appRoot,
          'dist/client/chunks/9932.4e9b405e.js',
        );
        fs.mkdirSync(path.dirname(obsoletePath), { recursive: true });
        fs.writeFileSync(
          obsoletePath,
          Buffer.from(
            'd2luZG93Ll9fUkVMRUFTRV9DT01NSVRfSURfXz0iMjAyNi0wOC0wNlQxMTo1MzoyMC44NzZaIjsidXNlIHN0cmljdCI7KHRoaXMud2VicGFja0NodW5rZnVsbHN0YWNrX25lc3Rqc190ZW1wbGF0ZT10aGlzLndlYnBhY2tDaHVua2Z1bGxzdGFja19uZXN0anNfdGVtcGxhdGV8fFtdKS5wdXNoKFtbIjk5MzIiXSx7NTE1OTEodCl7dC5leHBvcnRzPWZ1bmN0aW9uKCl7dGhyb3cgRXJyb3IoIndzIGRvZXMgbm90IHdvcmsgaW4gdGhlIGJyb3dzZXIuIEJyb3dzZXIgY2xpZW50cyBtdXN0IHVzZSB0aGUgbmF0aXZlIFdlYlNvY2tldCBvYmplY3QiKX19fV0pOw==',
            'base64',
          ),
        );
      },
    );
    const weatherHistoricalClientChunkMismatchRoot =
      createInstallerValidationFixture((_manifest, { appRoot }) => {
        const obsoletePath = path.join(
          appRoot,
          'dist/client/chunks/9932.4e9b405e.js',
        );
        fs.mkdirSync(path.dirname(obsoletePath), { recursive: true });
        const bytes = Buffer.from(
          'd2luZG93Ll9fUkVMRUFTRV9DT01NSVRfSURfXz0iMjAyNi0wOC0wNlQxMTo1MzoyMC44NzZaIjsidXNlIHN0cmljdCI7KHRoaXMud2VicGFja0NodW5rZnVsbHN0YWNrX25lc3Rqc190ZW1wbGF0ZT10aGlzLndlYnBhY2tDaHVua2Z1bGxzdGFja19uZXN0anNfdGVtcGxhdGV8fFtdKS5wdXNoKFtbIjk5MzIiXSx7NTE1OTEodCl7dC5leHBvcnRzPWZ1bmN0aW9uKCl7dGhyb3cgRXJyb3IoIndzIGRvZXMgbm90IHdvcmsgaW4gdGhlIGJyb3dzZXIuIEJyb3dzZXIgY2xpZW50cyBtdXN0IHVzZSB0aGUgbmF0aXZlIFdlYlNvY2tldCBvYmplY3QiKX19fV0pOw==',
          'base64',
        );
        bytes[0] ^= 1;
        fs.writeFileSync(obsoletePath, bytes);
      });
    const julyHistoricalClientChunkRoot = createInstallerValidationFixture(
      (_manifest, { appRoot }) => {
        const obsoletePath = path.join(
          appRoot,
          'dist/client/chunks/9932.f0ad718e.js',
        );
        fs.mkdirSync(path.dirname(obsoletePath), { recursive: true });
        fs.writeFileSync(
          obsoletePath,
          Buffer.from(
            'd2luZG93Ll9fUkVMRUFTRV9DT01NSVRfSURfXz0iMjAyNi0wNy0yOFQyMzoyOToyMC4yNjBaIjsidXNlIHN0cmljdCI7KHRoaXMud2VicGFja0NodW5rZnVsbHN0YWNrX25lc3Rqc190ZW1wbGF0ZT10aGlzLndlYnBhY2tDaHVua2Z1bGxzdGFja19uZXN0anNfdGVtcGxhdGV8fFtdKS5wdXNoKFtbIjk5MzIiXSx7NTE1OTEodCl7dC5leHBvcnRzPWZ1bmN0aW9uKCl7dGhyb3cgRXJyb3IoIndzIGRvZXMgbm90IHdvcmsgaW4gdGhlIGJyb3dzZXIuIEJyb3dzZXIgY2xpZW50cyBtdXN0IHVzZSB0aGUgbmF0aXZlIFdlYlNvY2tldCBvYmplY3QiKX19fV0pOw==',
            'base64',
          ),
        );
      },
    );
    const julyHistoricalClientChunkMismatchRoot =
      createInstallerValidationFixture((_manifest, { appRoot }) => {
        const obsoletePath = path.join(
          appRoot,
          'dist/client/chunks/9932.f0ad718e.js',
        );
        fs.mkdirSync(path.dirname(obsoletePath), { recursive: true });
        const bytes = Buffer.from(
          'd2luZG93Ll9fUkVMRUFTRV9DT01NSVRfSURfXz0iMjAyNi0wNy0yOFQyMzoyOToyMC4yNjBaIjsidXNlIHN0cmljdCI7KHRoaXMud2VicGFja0NodW5rZnVsbHN0YWNrX25lc3Rqc190ZW1wbGF0ZT10aGlzLndlYnBhY2tDaHVua2Z1bGxzdGFja19uZXN0anNfdGVtcGxhdGV8fFtdKS5wdXNoKFtbIjk5MzIiXSx7NTE1OTEodCl7dC5leHBvcnRzPWZ1bmN0aW9uKCl7dGhyb3cgRXJyb3IoIndzIGRvZXMgbm90IHdvcmsgaW4gdGhlIGJyb3dzZXIuIEJyb3dzZXIgY2xpZW50cyBtdXN0IHVzZSB0aGUgbmF0aXZlIFdlYlNvY2tldCBvYmplY3QiKX19fV0pOw==',
          'base64',
        );
        bytes[0] ^= 1;
        fs.writeFileSync(obsoletePath, bytes);
      });
    const obsoleteCertificateSchedulerJsMismatchRoot =
      createInstallerValidationFixture((_manifest, { appRoot }) => {
        const obsoletePath = path.join(
          appRoot,
          'dist/server/modules/bitable-sync/certificate-dashboard.scheduler.js',
        );
        fs.mkdirSync(path.dirname(obsoletePath), { recursive: true });
        fs.writeFileSync(obsoletePath, 'unverified-executable');
      });
    const knownObsoleteLedgerHashMismatchRoot =
      createInstallerValidationFixture((_manifest, { appRoot }) => {
        const obsoletePath = path.join(
          appRoot,
          'dist/server/modules/contract-management/contract-admin-auth.service.js',
        );
        fs.mkdirSync(path.dirname(obsoletePath), { recursive: true });
        fs.writeFileSync(obsoletePath, 'tampered-historical-artifact');
      });
    const obsoleteCertificateSchedulerMapRoot =
      createInstallerValidationFixture((_manifest, { appRoot }) => {
        const obsoletePath = path.join(
          appRoot,
          'dist/server/modules/bitable-sync/certificate-dashboard.scheduler.js.map',
        );
        fs.mkdirSync(path.dirname(obsoletePath), { recursive: true });
        fs.writeFileSync(obsoletePath, 'unverified-source-map');
      });
    const obsoleteCertificateSchedulerCaseVariantRoot =
      createInstallerValidationFixture((_manifest, { appRoot }) => {
        const obsoletePath = path.join(
          appRoot,
          'dist/server/modules/bitable-sync/Certificate-Dashboard.scheduler.d.ts',
        );
        fs.mkdirSync(path.dirname(obsoletePath), { recursive: true });
        fs.writeFileSync(obsoletePath, 'case-variant');
      });
    const obsoleteCertificateSchedulerSiblingRoot =
      createInstallerValidationFixture((_manifest, { appRoot }) => {
        const obsoletePath = path.join(
          appRoot,
          'dist/server/modules/dashboard-data-sync/certificate-dashboard.scheduler.d.ts',
        );
        fs.mkdirSync(path.dirname(obsoletePath), { recursive: true });
        fs.writeFileSync(obsoletePath, 'sibling-path');
      });
    const hashRoot = createInstallerValidationFixture(
      (_manifest, { appRoot }) => {
        fs.writeFileSync(path.join(appRoot, 'dist/server/main.js'), 'changed');
      },
    );
    const activeClientHashRoot = createInstallerValidationFixture(
      (_manifest, { appRoot }) => {
        fs.writeFileSync(path.join(appRoot, 'dist/client/main.js'), 'changed');
      },
    );
    const cases: Array<{
      name: string;
      fixture: { appRoot: string; installerPath: string };
      expected: boolean;
      errorContains?: string | string[];
    }> = [
      {
        name: 'valid',
        fixture: createInstallerValidationFixture(),
        expected: true,
      },
      ...[
        ['schema', 'baselineExportSchemaVersion', 2],
        ['type', 'baselineExportType', 'wrong-type'],
        ['algorithm', 'baselineExportPlanAlgorithm', 'wrong-algorithm'],
        ['baselineCount', 'baselineFileCount', 7],
        ['payloadCount', 'baselinePayloadFileCount', 5],
        ['metadataCount', 'baselineMetadataOnlyFileCount', 3],
        ['bytes', 'baselineUncompressedBytes', 1],
      ].map(([name, field, value]) => ({
        name: String(name),
        fixture: createInstallerValidationFixture((manifest) => {
          manifest[String(field)] = value;
        }),
        expected: false,
      })),
      ...[
        ['schemaString', 'baselineExportSchemaVersion', '3'],
        ['baselineCountString', 'baselineFileCount', '6'],
        ['payloadCountDecimal', 'baselinePayloadFileCount', 4.5],
        ['metadataCountNegative', 'baselineMetadataOnlyFileCount', -1],
        ['bytesOutOfRange', 'baselineUncompressedBytes', 1e30],
      ].map(([name, field, value]) => ({
        name: String(name),
        fixture: createInstallerValidationFixture((manifest) => {
          manifest[String(field)] = value;
        }),
        expected: false,
        errorContains: 'Manifest integer property is invalid',
      })),
      {
        name: 'reason',
        fixture: createInstallerValidationFixture((manifest) => {
          manifest.serverBaselineFiles.at(-1).reason = 'wrong-reason';
          recomputeHotfixExportPlanFingerprint(manifest);
        }),
        expected: false,
        errorContains:
          'Unsupported server baseline metadata-only reason or path:',
      },
      {
        name: 'canonicalPath',
        fixture: createInstallerValidationFixture((manifest) => {
          manifest.serverBaselineFiles[1].path = 'dist\\server\\main.js';
        }),
        expected: false,
        errorContains: 'Non-canonical relative path',
      },
      {
        name: 'caseDuplicate',
        fixture: createInstallerValidationFixture((manifest) => {
          manifest.serverBaselineFiles.push({
            ...manifest.serverBaselineFiles[1],
            path: manifest.serverBaselineFiles[1].path.toUpperCase(),
          });
        }),
        expected: false,
        errorContains: 'Duplicate server baseline manifest path',
      },
      {
        name: 'baselineFingerprint',
        fixture: createInstallerValidationFixture((manifest) => {
          manifest.baselineFingerprint = '0'.repeat(64);
        }),
        expected: false,
      },
      ...['dist/server', 'dist/shared', 'dist/client'].map((runtimeRoot) => ({
        name: `fingerprint-${runtimeRoot}`,
        fixture: createInstallerValidationFixture((manifest) => {
          manifest.distFingerprints[runtimeRoot] = '0'.repeat(64);
        }),
        expected: false,
      })),
      {
        name: 'planFingerprint',
        fixture: createInstallerValidationFixture((manifest) => {
          manifest.baselineExportPlanFingerprint = '0'.repeat(64);
        }),
        expected: false,
      },
      { name: 'runtimeMissing', fixture: missingRoot, expected: false },
      {
        name: 'knownObsoleteCertificateSchedulerDeclaration',
        fixture: obsoleteCertificateSchedulerDeclarationRoot,
        expected: true,
      },
      {
        name: 'knownObsoleteCertificateSchedulerDeclarationMismatch',
        fixture: obsoleteCertificateSchedulerDeclarationMismatchRoot,
        expected: false,
        errorContains: 'Unexpected server baseline runtime file:',
      },
      {
        name: 'knownHistoricalClientOverlayChunk',
        fixture: historicalClientOverlayChunkRoot,
        expected: true,
      },
      {
        name: 'knownHistoricalClientOverlayChunkMismatch',
        fixture: historicalClientOverlayChunkMismatchRoot,
        expected: true,
      },
      {
        name: 'knownWeatherHistoricalClientChunk',
        fixture: weatherHistoricalClientChunkRoot,
        expected: true,
      },
      {
        name: 'knownWeatherHistoricalClientChunkMismatch',
        fixture: weatherHistoricalClientChunkMismatchRoot,
        expected: true,
      },
      {
        name: 'knownJulyHistoricalClientChunk',
        fixture: julyHistoricalClientChunkRoot,
        expected: true,
      },
      {
        name: 'knownJulyHistoricalClientChunkMismatch',
        fixture: julyHistoricalClientChunkMismatchRoot,
        expected: true,
      },
      {
        name: 'unverifiedObsoleteCertificateSchedulerJs',
        fixture: obsoleteCertificateSchedulerJsMismatchRoot,
        expected: false,
        errorContains: 'Unexpected server baseline runtime file:',
      },
      {
        name: 'knownObsoleteLedgerHashMismatch',
        fixture: knownObsoleteLedgerHashMismatchRoot,
        expected: false,
        errorContains: 'Unexpected server baseline runtime file:',
      },
      {
        name: 'unverifiedObsoleteCertificateSchedulerMap',
        fixture: obsoleteCertificateSchedulerMapRoot,
        expected: false,
        errorContains: 'Unexpected server baseline runtime file:',
      },
      {
        name: 'obsoleteCertificateSchedulerCaseVariant',
        fixture: obsoleteCertificateSchedulerCaseVariantRoot,
        expected: false,
        errorContains: 'Unexpected server baseline runtime file:',
      },
      {
        name: 'obsoleteCertificateSchedulerSibling',
        fixture: obsoleteCertificateSchedulerSiblingRoot,
        expected: false,
        errorContains: 'Unexpected server baseline runtime file:',
      },
      {
        name: 'runtimeExtra',
        fixture: extraRoot,
        expected: false,
        errorContains:
          'Unexpected server baseline runtime file: dist/server/extra.js',
      },
      {
        name: 'unlistedHistoricalClientChunk',
        fixture: unlistedHistoricalClientChunkRoot,
        expected: true,
      },
      {
        name: 'unlistedHistoricalClientChunkMap',
        fixture: unlistedHistoricalClientChunkMapRoot,
        expected: true,
      },
      {
        name: 'unlistedNamedHistoricalClientChunk',
        fixture: unlistedNamedHistoricalClientChunkRoot,
        expected: true,
      },
      {
        name: 'pairedNamedHistoricalClientChunkMap',
        fixture: pairedNamedHistoricalClientChunkMapRoot,
        expected: true,
      },
      {
        name: 'orphanNamedHistoricalClientChunkMap',
        fixture: orphanNamedHistoricalClientChunkMapRoot,
        expected: true,
      },
      {
        name: 'namedHistoricalClientChunkCaseVariant',
        fixture: namedHistoricalClientChunkCaseVariantRoot,
        expected: true,
      },
      {
        name: 'multipleUnexpectedRuntimeFiles',
        fixture: multipleUnexpectedRuntimeFilesRoot,
        expected: false,
        errorContains: ['dist/server/extra-a.js', 'dist/shared/extra-b.js'],
      },
      { name: 'runtimeHash', fixture: hashRoot, expected: false },
      {
        name: 'activeClientRuntimeHash',
        fixture: activeClientHashRoot,
        expected: false,
      },
      {
        name: 'runtimeSize',
        fixture: createInstallerValidationFixture((manifest) => {
          manifest.serverBaselineFiles[1].size += 1;
        }),
        expected: false,
      },
      ...[
        ['payloadSizeString', 1, 'string'],
        ['metadataSizeDecimal', -1, 'decimal'],
        ['payloadSizeNegative', 1, 'negative'],
        ['payloadSizeOutOfRange', 1, 'outOfRange'],
      ].map(([name, entryIndex, mutation]) => ({
        name: String(name),
        fixture: createInstallerValidationFixture((manifest) => {
          const entry = manifest.serverBaselineFiles.at(Number(entryIndex));
          if (mutation === 'string') {
            entry.size = String(entry.size);
          } else if (mutation === 'decimal') {
            entry.size += 0.5;
          } else if (mutation === 'negative') {
            entry.size = -1;
          } else {
            entry.size = 1e30;
          }
        }),
        expected: false,
        errorContains: 'Manifest integer property is invalid',
      })),
      {
        name: 'payloadHashUppercase',
        fixture: createInstallerValidationFixture((manifest) => {
          manifest.serverBaselineFiles[1].sha256 =
            manifest.serverBaselineFiles[1].sha256.toUpperCase();
        }),
        expected: false,
      },
      {
        name: 'metadataHashUppercase',
        fixture: createInstallerValidationFixture((manifest) => {
          const entry = manifest.serverBaselineFiles.at(-1);
          entry.sha256 = entry.sha256.toUpperCase();
        }),
        expected: false,
      },
    ];
    const harnessRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nantong-installer-harness-'),
    );
    validationRoots.push(harnessRoot);
    const quote = (value: string) => value.replace(/'/g, "''");
    const harnessPath = path.join(harnessRoot, 'validate.ps1');
    fs.writeFileSync(
      harnessPath,
      `\ufeff${[
        "$ErrorActionPreference = 'Stop'",
        '$results = [ordered]@{}',
        ...cases.flatMap((testCase) => [
          'try {',
          `  $output = @(& '${quote(testCase.fixture.installerPath)}' -AppRoot '${quote(testCase.fixture.appRoot)}' -ValidateServerBaselineOnly 2>&1)`,
          `  $results['${testCase.name}'] = [ordered]@{ success = $true; output = @($output | ForEach-Object { [string]$_ }) }`,
          '} catch {',
          `  $results['${testCase.name}'] = [ordered]@{ success = $false; error = [string]$_.Exception.Message }`,
          '}',
        ]),
        '$results | ConvertTo-Json -Compress -Depth 8',
      ].join('\r\n')}`,
    );
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harnessPath],
      { encoding: 'utf8', timeout: 90_000 },
    );

    expect(result.status).toBe(0);
    const results = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
    expect(results.valid.error).toBeUndefined();
    for (const testCase of cases) {
      expect(results[testCase.name]).toMatchObject({
        success: testCase.expected,
      });
      if (testCase.errorContains) {
        for (const expectedError of [testCase.errorContains].flat()) {
          expect(results[testCase.name].error).toContain(expectedError);
        }
      }
    }
    expect(JSON.parse(results.valid.output.at(-1))).toEqual({
      success: true,
      baselineFileCount: 6,
      payloadFileCount: 4,
      metadataOnlyFileCount: 2,
    });
  });

  it('packages the complete runtime and enforces guarded atomic deployment', () => {
    expect(fs.existsSync(scriptPath)).toBe(true);
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain("'dist\\server'");
    expect(source).toContain("'dist\\shared'");
    expect(source).toContain("'dist\\client'");
    expect(source).toContain("Join-Path $stageRoot 'dist'");
    expect(source).toContain(
      "Copy-Item -LiteralPath (Join-Path $packageRoot 'dist')",
    );
    expect(source).not.toContain("'payload\\dist'");
    expect(source).toContain('baseFingerprint');
    expect(source).toContain('package-lock.json');
    expect(source).toContain('Get-FileHash');
    expect(source).toContain('Move-ItemWithRetry -LiteralPath $currentDist');
    expect(source).toContain('Rollback-UncommittedHotfixTransaction');
    expect(source).toContain('Complete-CommittedHotfixTransaction');
    expect(source).not.toContain('[switch]$SkipBuild');
    expect(source).not.toContain(
      'Move-Item -LiteralPath $distPath -Destination $previousDistBackup',
    );
    expect(source).not.toContain('& npm.cmd run build:prod');
    expect(source).toContain('$cleanBuildSnapshotRoot');
    expect(source).toContain('$reusedProductionNodeModulesRoot');
    expect(source).toContain(
      'Do not merge-copy the packaged dist over an existing dist directory.',
    );
    expect(source).not.toContain(
      'dist can also be copied directly into the server app root',
    );
    expect(source).toContain('/api/access/session');
    expect(source).toContain('[int]$response.StatusCode -ne 200');
    expect(source).toContain('$null -ne $body.role');
    expect(source).toContain('$null -ne $body.capabilities');
    expect(source).not.toContain("$status -match '^[234]\\d\\d$'");
    expect(source.match(/function Get-RelativeUnixPath/g)).toHaveLength(2);
    expect(source).toContain('node_modules');
    expect(source).toContain('.runtime');
    expect(source).toContain('.env');
  });

  it('rolls back and rechecks the previous runtime after every switched-runtime failure', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('$runtimeSwitchStarted = $true');
    expect(source).toContain('$deploymentSucceeded = $true');
    expect(source).toContain('function Rollback-UncommittedHotfixTransaction');
    expect(source).toContain('function Recover-HotfixTransaction');
    expect(source).toContain('$transaction = Recover-HotfixTransaction `');
    expect(source).toContain('Start-RecoveredRuntime -Root $Root');
    expect(source).toContain(
      'The previous runtime was restored and passed its health check.',
    );
  });

  it('accepts only a proven production pid record or an exact absolute-main fallback', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain("Join-Path $Root 'app.pid'");
    expect(source).toContain("$runtimeProcess.ProcessName -cne 'node'");
    expect(source).toContain("[string]$processInfo.Name -cne 'node.exe'");
    expect(source).toContain('function Get-VerifiedPidFileProcess');
    expect(source).toContain('[string]$record.appRoot');
    expect(source).toContain('[string]$record.mainFile');
    expect(source).toContain('[string]$record.startTime');
    expect(source).toContain("Join-Path $Root 'dist\\server\\main.js'");
    expect(source).toContain('Test-CommandLineHasExpectedEntryPoint');
    expect(source).not.toContain('$process.CommandLine -match $escapedRoot');
    expect(source).toContain(
      'Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"',
    );
    expect(source).toContain('Assert-AppProcessesStopped');
    expect(source).toContain('Get-NetTCPConnection');
  });

  it('requires the extracted dist file set to exactly match the manifest', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('function Assert-ExactPayloadFileSet');
    expect(source).toContain(
      'Unexpected payload file not declared by manifest:',
    );
    expect(source).toContain('Manifest payload file is missing:');
    expect(source).toContain(
      'Assert-ExactPayloadFileSet -PackageRoot $packageRoot -Manifest $manifest',
    );
  });

  it('rejects source maps, every env variant, certificates, and private keys', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain("StartsWith('.env'");
    for (const extension of [
      '.map',
      '.pem',
      '.key',
      '.pfx',
      '.p12',
      '.crt',
      '.cer',
      '.der',
      '.jks',
      '.keystore',
    ]) {
      expect(source).toContain(`'${extension}'`);
    }
  });

  it('never moves the original local dist and always cleans isolated build roots', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('$packageCompleted = $false');
    expect(source).toContain('$packageCompleted = $true');
    expect(source).not.toContain('function Restore-LocalBuildOutput');
    expect(source).toContain('$workspaceDistFingerprintBefore');
    expect(source).toContain('function Remove-CleanBuildWorkspace');
    expect(source).toContain('$lastFailure = $_');
    expect(source).toContain(
      'Invoke-CleanBuildWorkspaceRobocopyFallback -Path $fullPath',
    );
    expect(source).toContain('$packagingFailure = $_');
    expect(source).toContain('throw $packagingFailure');
    expect(source).toContain('Publish-VerifiedReadyMarker');
    expect(source).toContain('Packaging cleanup also failed:');
  });

  it('uses a trusted no-junction robocopy fallback for long-path workspace cleanup', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const fallbackStart = source.indexOf(
      'function Invoke-CleanBuildWorkspaceRobocopyFallback',
    );
    const cleanupStart = source.indexOf(
      'function Remove-CleanBuildWorkspace',
      fallbackStart,
    );
    const cleanupEnd = source.indexOf(
      'function Remove-OwnedOutputFileWithRetry',
      cleanupStart,
    );
    const fallbackBody = source.slice(fallbackStart, cleanupStart);
    const cleanupBody = source.slice(cleanupStart, cleanupEnd);

    expect(fallbackStart).toBeGreaterThanOrEqual(0);
    expect(cleanupStart).toBeGreaterThan(fallbackStart);
    expect(cleanupEnd).toBeGreaterThan(cleanupStart);
    expect(fallbackBody).toContain('[Environment]::SystemDirectory');
    expect(fallbackBody).toContain("'robocopy.exe'");
    expect(fallbackBody).not.toContain('Get-Command robocopy');
    expect(fallbackBody).not.toMatch(/\bcmd(?:\.exe)?\s+\/c\b/i);
    for (const argument of ['/MIR', '/XJ', '/R:0', '/W:0']) {
      expect(fallbackBody).toContain(`'${argument}'`);
    }
    expect(fallbackBody).toMatch(/\$robocopyExitCode\s+-gt\s+7\b/);
    expect(cleanupBody).toContain(
      'Invoke-CleanBuildWorkspaceRobocopyFallback -Path $fullPath',
    );
  });

  it('publishes the SHA256 ready marker only after all fallible cleanup has succeeded', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const mainStart = source.indexOf('$cleanBuildWorkspaceRoot =');
    const workspaceCleanup = source.indexOf(
      'Remove-CleanBuildWorkspace -Path $cleanBuildWorkspaceRoot',
      mainStart,
    );
    const reservationCleanup = source.indexOf(
      'Close-PackageOutputReservation -Reservation $outputReservation',
      mainStart,
    );
    const readyCommit = source.indexOf(
      'Publish-VerifiedReadyMarker `',
      mainStart,
    );
    const completion = source.indexOf('$packageCompleted = $true', mainStart);

    expect(mainStart).toBeGreaterThanOrEqual(0);
    expect(workspaceCleanup).toBeGreaterThan(mainStart);
    expect(reservationCleanup).toBeGreaterThan(workspaceCleanup);
    expect(readyCommit).toBeGreaterThan(reservationCleanup);
    expect(completion).toBeGreaterThan(readyCommit);

    const afterReadyCommit = source.slice(readyCommit, completion);
    expect(afterReadyCommit).not.toMatch(/\b(?:Remove|Close|Assert)-/);
    expect(afterReadyCommit).not.toContain('throw ');
  });

  it('preserves reservation primary failures when best-effort cleanup also fails', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const createStart = source.indexOf('function New-PackageOutputReservation');
    const closeStart = source.indexOf(
      'function Close-PackageOutputReservation',
    );
    const cleanupStart = source.indexOf('function Remove-CleanBuildWorkspace');
    const createBody = source.slice(createStart, closeStart);
    const closeBody = source.slice(closeStart, cleanupStart);

    expect(createBody).toContain('$primaryFailure = $_');
    expect(createBody).toContain('throw $primaryFailure');
    expect(closeBody).toContain('$disposeFailure = $_');
    expect(closeBody).toContain('throw $disposeFailure');
  });

  it('closes every prepared archive stream before returning ownership to the main flow', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const prepareStart = source.indexOf(
      'function Prepare-VerifiedHotfixArchive',
    );
    const readyStart = source.indexOf('function Publish-VerifiedReadyMarker');
    const prepareBody = source.slice(prepareStart, readyStart);
    const returnIndex = prepareBody.indexOf('return [pscustomobject]@{');
    const catchIndex = prepareBody.indexOf('} catch {', returnIndex);

    expect(returnIndex).toBeGreaterThan(0);
    expect(
      prepareBody.lastIndexOf('$publishedZip.Stream.Dispose()', returnIndex),
    ).toBeGreaterThan(0);
    expect(
      prepareBody.lastIndexOf('$publishedZip = $null', returnIndex),
    ).toBeGreaterThan(0);
    expect(
      prepareBody.lastIndexOf('$partialSha.Stream.Dispose()', returnIndex),
    ).toBeGreaterThan(0);
    expect(
      prepareBody.lastIndexOf('$partialSha = $null', returnIndex),
    ).toBeGreaterThan(0);
    expect(prepareBody.slice(catchIndex)).not.toContain('} finally {');
  });

  it('preserves owned-output removal failures when stream disposal also fails', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const removeStart = source.indexOf('function Remove-OwnedOutputFile');
    const reservationStart = source.indexOf(
      'function New-PackageOutputReservation',
    );
    const removeBody = source.slice(removeStart, reservationStart);

    expect(removeBody).toContain('$primaryFailure = $_');
    expect(removeBody).toContain('$disposeFailure = $_');
    expect(removeBody).toContain('throw $primaryFailure');
  });

  it('uses a PowerShell 5 compatible health request without requiring curl.exe', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).not.toContain('curl.exe');
    expect(source).toContain('[System.Net.HttpWebRequest]::Create($Endpoint)');
    expect(source).toContain('$response.GetResponseStream()');
    expect(source).toContain('ServerCertificateValidationCallback');
  });

  it('ships the leave shift-detail migration tools as integrity-checked support files', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    for (const relativePath of [
      'scripts/run-with-env.mjs',
      'scripts/ensure-leave-workflow-fields.mjs',
      'scripts/migrate-leave-shift-substitute-details.mjs',
      'scripts/self-test-leave-workflow.mjs',
      'docs/runbooks/leave-workflow-multi-shift-substitute.md',
    ]) {
      expect(source).toContain(`'${relativePath}'`);
    }
    expect(source).toContain('supportFiles = $supportFiles');
    expect(source).toContain('Assert-ExactSupportFileSet');
    expect(source).toContain('controlFiles = @()');
    expect(source).toContain('function Assert-ExactControlFileSet');
    expect(source).toContain(
      "foreach ($relativePath in @('INSTALL-HOTFIX.ps1', 'README.md'))",
    );
    expect(source).toContain(
      'Assert-ManifestEntryIntegrity -Root $PackageRoot -Entries @($Manifest.controlFiles)',
    );
    expect(source).toContain(
      'Assert-ManifestEntryIntegrity -Root $packageRoot -Entries @($manifest.releaseFiles)',
    );
  });

  it('fingerprints an explicit server baseline instead of the modified source tree', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('[string]$BaselineRoot');
    expect(source).toContain('$baselineRootPath');
    expect(source).toContain(
      'Get-FileHash -LiteralPath (Join-Path $baselineRootPath $relativePath)',
    );
    expect(source).toContain('baselineExisted');
    expect(source).toContain('baselineSha256');
    expect(source).toContain(
      '$actualExistingReleaseSize -eq [int64]$entry.size',
    );
    expect(source).toContain(
      '$actualExistingReleaseHash -ceq [string]$entry.sha256',
    );
    expect(source).toContain(
      'Reusing already-deployed hash-proven release target:',
    );
    expect(source).toContain(
      "'scripts/migrate-dingtalk-attendance-credentials.ps1' = '4296:01181545b5e4ec33f0b8d7152dd12933d3ba241a7517e64464ed0cd633e36d9d'",
    );
    expect(source).toContain(
      'Upgrading hash-proven historical release target:',
    );
  });

  it('requires the complete baseline manifest while validating active client and complete server/shared files', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('server-baseline-manifest.json');
    expect(source).toContain('function Assert-BaselineExportManifest');
    expect(source).toContain('baselineFingerprint');
    expect(source).toContain('distFingerprints');
    expect(source).toContain('serverBaselineFiles');
    expect(source).toContain('Assert-ServerRuntimeBaseline');
    expect(source).toContain('Unexpected server baseline runtime file:');
    expect(source).toContain('Server baseline runtime file is missing:');
    expect(source).toContain(
      'b66b29d4d560585a8ead21d6fe3303432f1e54d9f08f546872d298faa2d01f08',
    );
    expect(source).toContain(
      "'dist/server/modules/bitable-sync/certificate-dashboard.scheduler.js' = '3262:b66b29d4d560585a8ead21d6fe3303432f1e54d9f08f546872d298faa2d01f08'",
    );
    const ledger = source.match(
      /\$knownObsoleteRuntimeArtifactProofs = @\{([\s\S]*?)\r?\n\}/,
    );
    expect(ledger).not.toBeNull();
    const obsoleteArtifactProofs = Array.from(
      ledger![1].matchAll(
        /^\s+'(?<path>dist\/[^']+)'\s*=\s*'(?<size>\d+):(?<sha256>[0-9a-f]{64})'\s*$/gm,
      ),
      (match) => ({
        path: match.groups!.path,
        size: Number(match.groups!.size),
        sha256: match.groups!.sha256,
      }),
    );
    expect(obsoleteArtifactProofs).toHaveLength(337);
    expect(fingerprintEntries(obsoleteArtifactProofs)).toBe(
      '377a6adf7be9b79d7d3f78fd964fed1f6a6b5cbd31f0dbf4588acfd2aa7ccf77',
    );
    expect(obsoleteArtifactProofs).toContainEqual({
      path: 'dist/client/chunks/1044.dd1408be.js',
      size: 29428,
      sha256:
        '46f1325dcc712b5414a708b258cc3b0f1b3b7714a8d611d0b7c14db293d2888e',
    });
    expect(obsoleteArtifactProofs).toContainEqual({
      path: 'dist/client/chunks/1081.00b41d86.js',
      size: 36206,
      sha256:
        '52a386d68bdce7bc3b1fb944c997fc5aa677558449f668c57b8694e2995892a0',
    });
    expect(obsoleteArtifactProofs).toContainEqual({
      path: 'dist/client/chunks/1081.0a07ac9c.js',
      size: 36429,
      sha256:
        '812563ec3acbc8310870dd28ae7f92a97bc43714cc9416d9a9044c07972642c0',
    });
    expect(obsoleteArtifactProofs).toContainEqual({
      path: 'dist/client/chunks/9932.4e9b405e.js',
      size: 313,
      sha256:
        '81007bcf029cc9c342933fe4f8f14e9f0e3aee26be5747d5bc6bf15d97c91f21',
    });
    expect(
      source.match(/Test-KnownObsoleteRuntimeArtifact -RelativePath/g),
    ).toHaveLength(2);
    expect(source).not.toContain(
      'Test-KnownObsoleteRuntimeArtifactPath -RelativePath',
    );
  });

  it('accepts schema 3 metadata plans while keeping metadata-only contents out of the baseline payload', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('$schemaVersion -ne 3');
    expect(
      source.match(/function Get-RequiredObjectPropertyValue/g),
    ).toHaveLength(2);
    expect(
      source.match(/function Get-NonNegativeInt64ManifestValue/g),
    ).toHaveLength(2);
    expect(source).toContain('webpack-main-runtime-map-v1');
    expect(source).toContain('exportPlanFingerprint');
    for (const manifestField of [
      'baselineExportSchemaVersion',
      'baselineExportType',
      'baselineExportPlanAlgorithm',
      'baselineExportPlanFingerprint',
      'baselineFileCount',
      'baselinePayloadFileCount',
      'baselineMetadataOnlyFileCount',
      'baselineUncompressedBytes',
    ]) {
      expect(source).toContain(`${manifestField} =`);
    }
    expect(source).toContain('[switch]$ValidateServerBaselineOnly');
    expect(source).toContain('nonExportedRuntimeFiles');
    expect(source).toContain('Invalid metadata-only server baseline path:');
    expect(source).toContain('source-map-content-not-exported');
    expect(source).toContain('unreferenced-client-chunk-content-not-exported');
    expect(source).toContain('$baselineExpectedPaths');
  });

  it('proves dependency transitions against an explicitly verified reusable production tree', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('verify-hotfix-dependency-transition.mjs');
    expect(source).toContain('scripts/postinstall.mjs');
    expect(source).toContain('scripts/ensure-feishu-card-ws-sdk-patch.mjs');
    expect(source).toContain('metadataVerified');
    expect(source).toContain('physicalVerified');
    expect(source).toContain('requiresNodeModulesMutation');
    expect(source).toContain('[string]$VerifiedProductionNodeModulesRoot');
    expect(source).toContain('$reusedProductionNodeModulesRoot');
    expect(source).not.toContain('$productionInstallArguments');
  });

  it('reuses one held dependency proof only after quick identity and anchor validation', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('function Get-InstalledDependencyQuickState');
    expect(source).toContain('$script:installedDependencyProofCache');
    expect(source).toContain('GetFileIdentity($nodeModulesRoot)');
    expect(source).toContain("Join-Path $nodeModulesRoot '.package-lock.json'");
    expect(source).toContain('packageRootCount');
    expect(source).toContain('native-addon validation');
    expect(source).toContain(
      'Dependency quick proof changed; falling back to one complete physical-tree verification.',
    );
    expect(source).toContain(
      'The production dependency quick proof changed while the complete verification was running.',
    );
  });

  it('reuses a locked build toolchain without reinstalling unchanged dependencies', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('verify-reused-build-toolchain.mjs');
    expect(source).toContain('Assert-ReusedBuildToolchain');
    expect(source).toContain('$buildToolchainGateReport');
    expect(source).not.toContain('$developmentInstallArguments');
    expect(source).not.toContain("'--include=dev'");
  });

  it('uses the transition verifier as the package and lock mutation authority', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).not.toContain('$dependencyAffectingFiles');
    expect(source).not.toContain('function Assert-PackageJsonInstallContract');
    expect(source).toContain("'--baseline-package'");
    expect(source).toContain("'--baseline-lock'");
    expect(source).toContain("'--candidate-package'");
    expect(source).toContain("'--candidate-lock'");
    expect(source).toContain("'--installed-node-modules'");
  });

  it('uses the watchdog maintenance lock across the atomic switch and safe rollback', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain("Join-Path $appRootPath '.maintenance.lock'");
    expect(source).toContain('[System.IO.FileMode]::CreateNew');
    expect(source).toContain('function Write-DurableMaintenanceOwner');
    expect(source).toContain('function Resolve-HotfixMaintenanceOwner');
    expect(source).toContain("@('rolled-back', 'finalized')");
    expect(source).toContain('Remove-Item -LiteralPath $maintenanceLockPath');
    expect(source).toContain('The current runtime changed or became unhealthy');
  });

  it('writes the stage intent before staging, locks the candidate once and revalidates the server before stopping the app', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain("Join-Path $Root '.app-lifecycle.lock'");
    expect(source).toContain('function Open-LifecycleLock');
    expect(source).toContain('[System.IO.FileShare]::None');
    expect(source).toContain('function Assert-StageIntegrity');
    expect(source).toContain(
      'function Assert-NoReparsePointsOrAlternateDataStreams',
    );
    expect(source).toContain('Get-Item -LiteralPath $item.FullName -Stream *');

    const installerMain = source.slice(
      source.indexOf('$packageRoot = $PSScriptRoot'),
    );
    const maintenanceCreate = installerMain.indexOf(
      'Write-DurableMaintenanceOwner `',
    );
    const stageHandleOpen = installerMain.indexOf(
      '$integrityHandles = Open-VerifiedStageIntegrityHandles `',
    );
    const lockedBaselineRecheck = installerMain.indexOf(
      'Assert-ServerMutableBaseline `',
      maintenanceCreate,
    );
    const stop = installerMain.indexOf(
      'Stop-AppProcesses -Root $appRootPath',
      lockedBaselineRecheck,
    );
    expect(maintenanceCreate).toBeGreaterThan(0);
    expect(stageHandleOpen).toBeGreaterThan(0);
    expect(stageHandleOpen).toBeGreaterThan(maintenanceCreate);
    expect(lockedBaselineRecheck).toBeGreaterThan(maintenanceCreate);
    expect(stop).toBeGreaterThan(lockedBaselineRecheck);
  });

  it('limits the fresh deployment path to two complete server baseline scans and one staged hash proof', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const installerMain = source.slice(
      source.indexOf('$packageRoot = $PSScriptRoot'),
    );
    const freshPathStart = installerMain.indexOf(
      'foreach ($path in @($stageContainer, $backupDist, $failedDist, $backupRoot, $failedRoot))',
    );
    const freshPathEnd = installerMain.indexOf(
      'Move-ItemWithRetry -LiteralPath $currentDist -Destination $backupDist',
      freshPathStart,
    );
    const freshPath = installerMain.slice(freshPathStart, freshPathEnd);

    expect(freshPathStart).toBeGreaterThan(0);
    expect(freshPathEnd).toBeGreaterThan(freshPathStart);
    expect(
      freshPath.match(
        /Assert-ServerMutableBaseline\s+`\r?\n\s+-Root \$appRootPath\s+`\r?\n\s+-Manifest \$manifest/g,
      ) ?? [],
    ).toHaveLength(2);
    expect(
      freshPath.match(
        /\$integrityHandles = Open-VerifiedStageIntegrityHandles `/g,
      ) ?? [],
    ).toHaveLength(1);
    expect(freshPath).not.toContain('Assert-PackageAndStageIntegrity');
    expect(freshPath).not.toContain(
      'Ignoring hash-proven obsolete runtime artifact: $relativePath',
    );
  });

  it('removes only Zone.Identifier streams and rechecks the complete stage before archiving', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain(
      'function Remove-ZoneIdentifierStreamsFromArchiveStage',
    );
    expect(source).toContain(
      "Remove-Item -LiteralPath $item.FullName -Stream 'Zone.Identifier' -Force -ErrorAction Stop",
    );
    expect(source).toContain(
      'function Assert-ArchiveStageHasNoReparsePointsOrAlternateDataStreams',
    );
    expect(source).toContain(
      'Alternate data streams are forbidden in archive stage content',
    );

    const readmeWrite = source.indexOf(
      "Set-Content -LiteralPath (Join-Path $stageRoot 'README.md')",
    );
    const zoneCleanup = source.indexOf(
      'Remove-ZoneIdentifierStreamsFromArchiveStage -Root $stageRoot',
      readmeWrite,
    );
    const manifestWrite = source.indexOf(
      "$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $stageRoot 'hotfix-manifest.json')",
      readmeWrite,
    );
    const stageRecheck = source.indexOf(
      'Assert-ArchiveStageHasNoReparsePointsOrAlternateDataStreams -Root $stageRoot',
      zoneCleanup,
    );
    const archiveCreate = source.indexOf(
      'New-HotfixArchiveFromDirectory',
      stageRecheck,
    );
    expect(readmeWrite).toBeGreaterThan(0);
    expect(manifestWrite).toBeGreaterThan(readmeWrite);
    expect(zoneCleanup).toBeGreaterThan(manifestWrite);
    expect(stageRecheck).toBeGreaterThan(zoneCleanup);
    expect(archiveCreate).toBeGreaterThan(stageRecheck);
  });

  it('does not accept health until the launcher exits zero and the new pid and callback contract are proven', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('$LauncherProcess.WaitForExit()');
    expect(source).toContain('$LauncherProcess.ExitCode -ne 0');
    expect(source).toContain('Get-VerifiedPidFileProcess');
    expect(source).toContain('Test-CardCallbackWorkflowEnabled');
    expect(source).toContain('/api/feishu-card-callback/health');
    expect(source).toContain('$requiredConsecutiveSuccesses = 2');
  });

  it('atomically deploys and rolls back launchers and runtime support files with dist', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    for (const relativePath of [
      'package.json',
      'start.ps1',
      'start.cmd',
      'scripts/run-with-env.mjs',
      'scripts/ensure-leave-workflow-fields.mjs',
      'scripts/migrate-leave-shift-substitute-details.mjs',
      'scripts/ensure-inventory-outbound-approval-fields.mjs',
    ]) {
      expect(source).toContain(`'${relativePath}'`);
    }
    expect(source).toContain('releaseFiles = $releaseFiles');
    expect(source).toContain('function Assert-ExactReleaseFileSet');
    expect(source).toContain('function Switch-ReleaseFiles');
    expect(source).toContain('function Restore-ReleaseFilesFromTransaction');
    expect(source).not.toContain('function Restore-PreviousRuntime');
    expect(source).not.toContain('function Restore-ReleaseFiles {');
    expect(source).not.toContain('rootPayloadFiles');
  });

  it('ships every runtime file required by the production launcher', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const releaseMappings = [
      [
        "'.feishu-card-action-consumer-release'",
        "'.feishu-card-action-consumer-release'",
      ],
      ["'watchdog.ps1'", "'deploy/watchdog.ps1'"],
      [
        "'scripts/remove-legacy-contract-ocr.ps1'",
        "'scripts/remove-legacy-contract-ocr.ps1'",
      ],
      [
        "'scripts/ensure-feishu-card-ws-sdk-patch.mjs'",
        "'scripts/ensure-feishu-card-ws-sdk-patch.mjs'",
      ],
      ["'scripts/postinstall.mjs'", "'scripts/postinstall.mjs'"],
      [
        "'scripts/ensure-overtime-workflow-fields.mjs'",
        "'scripts/ensure-overtime-workflow-fields.mjs'",
      ],
      [
        "'scripts/ensure-purchase-inventory-config.mjs'",
        "'scripts/ensure-purchase-inventory-config.mjs'",
      ],
      [
        "'scripts/ensure-attendance-archive-summary-fields.mjs'",
        "'scripts/ensure-attendance-archive-summary-fields.mjs'",
      ],
      [
        "'scripts/migrate-legacy-exception-follow-ups.mjs'",
        "'scripts/migrate-legacy-exception-follow-ups.mjs'",
      ],
      [
        "'scripts/ensure-today-operations-follow-up-fields.mjs'",
        "'scripts/ensure-today-operations-follow-up-fields.mjs'",
      ],
      [
        "'scripts/install-contract-preview-python-deps.ps1'",
        "'scripts/install-contract-preview-python-deps.ps1'",
      ],
      [
        "'scripts/requirements-contract-preview.txt'",
        "'scripts/requirements-contract-preview.txt'",
      ],
    ] as const;

    for (const [target, origin] of releaseMappings) {
      expect(source).toContain(`${target} = ${origin}`);
    }
    expect(source).toContain('$baselinePreservedReleaseTargets');
    expect(source).toContain(
      '$source = Join-Path $baselineRootPath $entry.Key',
    );
    expect(source).toContain(
      '$baselinePreservedReleaseTargets -notcontains $_',
    );
  });

  it('allows production-equivalent cold starts and dependency verification to take up to ten minutes', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('[int]$HealthTimeoutSeconds = 600');
  });

  it('enumerates generic lists safely on Windows PowerShell 5', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).not.toContain('return @($processes)');
    expect(source).not.toContain('$entries = @($State)');
    expect(source).toContain('return @($processes | ForEach-Object { $_ })');
    expect(source).not.toContain('function Restore-PreviousRuntime');
    expect(source).toContain(
      'foreach ($entry in @($Transaction.releaseFiles))',
    );
  });

  it('starts PowerShell through a non-interactive hidden cmd wrapper and tracks launcher failure', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    const startFunction = source.slice(
      source.indexOf('function Start-App'),
      source.indexOf('function Wait-AppHealth'),
    );
    expect(startFunction).toContain("Join-Path $Root 'start.ps1'");
    expect(startFunction).toContain('[string]$StartScriptPath');
    expect(startFunction).toContain('Split-Path -Parent $startScript');
    expect(startFunction).toContain('System.Diagnostics.ProcessStartInfo');
    expect(startFunction).toContain('-NoBrowser');
    expect(startFunction).toContain('$process.Start()');
    expect(startFunction).not.toContain('-PassThru');
    expect(startFunction).toContain("'System32\\cmd.exe'");
    expect(startFunction).toContain('/d /v:off /s /c');
    expect(startFunction).toContain('$startInfo.CreateNoWindow = $true');
    expect(startFunction).not.toMatch(/\bpause\b/i);
    expect(startFunction).toContain(
      "$startInfo.EnvironmentVariables.Remove('NANTONG_HOTFIX_SMOKE_MODE')",
    );
    expect(startFunction).not.toContain(
      "$startInfo.EnvironmentVariables['NANTONG_HOTFIX_SMOKE_MODE'] = 'true'",
    );
    expect(startFunction).toContain(
      "Join-Path $Root 'logs\\hotfix-launcher.log'",
    );
    expect(startFunction).toContain(
      'hotfix-launcher-$launcherKind-$launcherAttemptId.out.log',
    );
    expect(startFunction).toContain(
      'hotfix-launcher-$launcherKind-$launcherAttemptId.err.log',
    );
    expect(startFunction).toContain('LauncherLogPath');
    expect(source).toContain('[System.Diagnostics.Process]$LauncherProcess');
    expect(source).toContain('$LauncherProcess.HasExited');
    expect(source).toContain('[string]$Root');
    expect(source).toContain('$LauncherProcess.WaitForExit()');
    expect(source).toContain('$LauncherProcess.ExitCode -ne 0');
    expect(source).toContain('-RequireJsonRecord');
    expect(source).toContain('-NotBeforeUtc $ExpectedProcessStartedAfterUtc');
    expect(source).toMatch(
      /\$replacementLauncher = Start-App\s+`\r?\n\s+-Root \$appRootPath/,
    );
    expect(source).toContain('-LauncherProcess $replacementLauncher');
    expect(source).toContain('-LauncherProcess $launcher');
    expect(source).toContain(
      'Stop-LauncherProcessTree -LauncherProcess $replacementLauncher',
    );
  });

  it('waits for the complete launcher process tree and retries Windows runtime moves during rollback', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('function Stop-ProcessTree');
    expect(source).toContain('ParentProcessId');
    expect(source).toContain(
      'Stop-LauncherProcessTree -LauncherProcess $replacementLauncher',
    );
    expect(source).toContain('function Wait-ProcessIdsExit');
    expect(source).toContain('function Move-ItemWithRetry');
    expect(source).toContain('Start-Sleep -Milliseconds $DelayMilliseconds');
    expect(source).toContain('-Source $currentDist');
    expect(source).toContain("-Name 'dist-candidate'");
    expect(source).toContain(
      'Move-ItemWithRetry -LiteralPath $backupDist -Destination $currentDist',
    );
    expect(source).toContain(
      'Move-ItemWithRetry -LiteralPath $currentDist -Destination $backupDist',
    );
  });

  it('persists a checksummed hotfix transaction journal with write-through atomic replacement', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain("'.hotfix-transaction.json'");
    expect(source).toContain('function Write-DurableHotfixTransaction');
    expect(source).toContain('function Read-StrictHotfixTransaction');
    expect(source).toContain('transactionChecksum');
    expect(source).toContain('$journalStream.Flush($true)');
    expect(source).toContain('MoveFileEx');
    expect(source).toContain('MOVEFILE_WRITE_THROUGH');
    expect(source).toContain('MOVEFILE_REPLACE_EXISTING');
  });

  it('recovers every non-committed transaction backward and committed transactions only forward', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('function Recover-HotfixTransaction');
    expect(source).toContain("'prepared'");
    expect(source).toContain("'runtime-stopped'");
    expect(source).toContain("'dist-backup-intent'");
    expect(source).toContain("'dist-backed-up'");
    expect(source).toContain("'candidate-dist-intent'");
    expect(source).toContain("'candidate-dist-installed'");
    expect(source).toContain("'release-files-installed'");
    expect(source).toContain("'candidate-started'");
    expect(source).toContain("'candidate-healthy'");
    expect(source).toContain("'committed'");
    expect(source).toContain("'finalized'");
    expect(source).toContain('Complete-CommittedHotfixTransaction');
    expect(source).toContain('Rollback-UncommittedHotfixTransaction');
  });

  it('closes a pre-switch transaction without stopping the untouched runtime', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const rollbackStart = source.indexOf(
      'function Rollback-UncommittedHotfixTransaction',
    );
    const recoveryStart = source.indexOf(
      'function Assert-CommittedRuntimeFiles',
      rollbackStart,
    );
    const rollback = source.slice(rollbackStart, recoveryStart);

    const preparedBranch = rollback.indexOf(
      "if (@('stage-intent', 'prepared') -contains [string]$Transaction.phase)",
    );
    const preparedEnd = rollback.indexOf(
      '$recoveryStart = New-VerifiedRecoveryStartScript',
      preparedBranch,
    );
    const preparedBlock = rollback.slice(preparedBranch, preparedEnd);

    expect(preparedBranch).toBeGreaterThan(0);
    expect(preparedEnd).toBeGreaterThan(preparedBranch);
    expect(preparedBlock).not.toContain('Wait-AppHealth');
    expect(preparedBlock).not.toContain('Stop-AppProcesses');
    expect(preparedBlock).not.toContain('Start-RecoveredRuntime');
    expect(preparedBlock).not.toContain('New-VerifiedRecoveryStartScript');
    expect(rollback).toContain(
      'A pre-switch hotfix transaction has an unexpected switch artifact',
    );
    expect(rollback).toContain("-Phase 'rolled-back'");
    expect(source).toContain('$currentInvocationTransactionId');
    expect(source).toContain(
      '[string]$transaction.transactionId -ceq $currentInvocationTransactionId',
    );
    expect(source).toContain(
      'Remove-Item -LiteralPath $transactionJournalPath -Force',
    );
  });

  it('strictly validates pid identity and revalidates it immediately before termination', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('function Convert-CommandLineToArgv');
    expect(source).toContain('CommandLineToArgvW');
    expect(source).toContain('$arguments[1]');
    expect(source).toContain('ExecutablePath');
    expect(source).toContain('Assert-ExactObjectProperties');
    expect(source).toContain('Confirm-ValidatedNodeProcessIdentity');
    expect(source).toContain('Stop-LauncherProcessTree');
    expect(source).toContain('-RequireJsonRecord:$RequireJsonRecord');
    expect(source).toContain('-NotBeforeUtc $NotBeforeUtc');
    expect(source).toContain('-NotBeforeUtc $startedAfterUtc');
    expect(source).toContain('[System.IO.File]::ReadAllText(');
    expect(source).toContain('[System.Text.UTF8Encoding]::new($false)');
    expect(source).not.toContain(
      'Stop-ProcessTree -ProcessId $replacementLauncher.Id',
    );
  });

  it('requires a stable health window and rechecks pid plus listener ownership after responses', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('$minimumHealthyWindowMilliseconds');
    expect(source).toContain('$healthyWindowStartedUtc');
    expect(source).toContain('Confirm-HealthListenerOwnership');
    expect(source).toContain('Get-NetTCPConnection');
    expect(source).toContain('OwningProcess');
    expect(source).toContain('Confirm-ValidatedNodeProcessIdentity');
    expect(source).toContain('Waiting for runtime health: $lastFailure');
    expect(source).toContain('file is empty (0 bytes)');
    expect(source).toContain('file is missing: $Path');
  });

  it('closes the stop-to-switch race with final validation and an atomic staged-directory switch', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const installerMain = source.slice(
      source.indexOf('$packageRoot = $PSScriptRoot'),
    );
    const stopIndex = installerMain.indexOf(
      'Stop-AppProcesses -Root $appRootPath -Endpoint $HealthEndpoint',
    );
    const heldIntegrityIndex = installerMain.indexOf(
      '$integrityHandles = Open-VerifiedStageIntegrityHandles `',
    );
    const finalServerValidationIndex = installerMain.indexOf(
      'Assert-ServerMutableBaseline `',
      stopIndex,
    );
    const switchIndex = installerMain.indexOf(
      'Move-ItemWithRetry -LiteralPath $currentDist -Destination $backupDist',
      stopIndex,
    );

    expect(source).toContain('function Open-VerifiedIntegrityHandles');
    expect(source).toContain(
      '[System.IO.FileShare]::Read -bor [System.IO.FileShare]::Delete',
    );
    expect(source).not.toContain(
      'function Install-DistFromHeldIntegrityHandles',
    );
    expect(source).toContain(
      'Move-ItemWithRetry -LiteralPath $stageDist -Destination $currentDist',
    );
    expect(heldIntegrityIndex).toBeGreaterThan(0);
    expect(heldIntegrityIndex).toBeLessThan(stopIndex);
    expect(finalServerValidationIndex).toBeGreaterThan(stopIndex);
    expect(switchIndex).toBeGreaterThan(finalServerValidationIndex);
  });

  it('rejects reparse-point ancestors, escaped final paths and alternate streams on deployment paths', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('function Get-FinalPathByHandle');
    expect(source).toContain('GetFinalPathNameByHandle');
    expect(source).toContain('function Assert-PathHasNoReparsePointAncestors');
    expect(source).toContain('function Assert-FinalPathContainedByRoot');
    expect(source).toContain('function Assert-DeploymentPathTopology');
    expect(source).toContain(
      'Alternate data streams are forbidden in deployment paths',
    );
  });

  it('validates only the active client closure and discards historical generations as one directory', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const installer = extractInstallerSource(source);
    const topology = installer.slice(
      installer.indexOf('function Assert-DeploymentPathTopology'),
      installer.indexOf('function Open-VerifiedIntegrityHandles'),
    );
    const runtimeBaseline = installer.slice(
      installer.indexOf('function Assert-ServerRuntimeBaseline'),
      installer.indexOf('function Assert-ServerDistBaseline'),
    );
    expect(installer).toContain('function Assert-NoReparsePoints');
    expect(topology).not.toContain(
      'Assert-NoReparsePoints -Root $currentDistPath',
    );
    expect(runtimeBaseline).toContain(
      'Assert-NoAlternateDataStreamsAtPath -Path $fullPath',
    );
    expect(runtimeBaseline).toContain("if ($runtimeRoot -ceq 'dist/client') {");
    expect(installer).not.toContain('Get-HistoricalClientChunkCleanupProof');
    expect(installer).not.toContain(
      'validatedHistoricalClientChunkCleanupProofs',
    );
  });

  it('removes terminal runtime directories without per-file alternate-stream probes', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const installer = extractInstallerSource(source);
    const cleanup = installer.slice(
      installer.indexOf('function Remove-TerminalHotfixDeploymentArtifacts'),
      installer.indexOf('function Complete-CommittedHotfixTransaction'),
    );

    expect(cleanup).toContain('Assert-NoReparsePoints -Root $artifactPath');
    expect(cleanup).toContain(
      '[System.IO.Directory]::Delete($artifactPath, $true)',
    );
    expect(cleanup).toContain('[System.IO.File]::Delete($artifactPath)');
    expect(cleanup).toContain('Finalized runtime cleanup removed');
    expect(cleanup).not.toContain(
      'Assert-NoReparsePointsOrAlternateDataStreams -Root $artifactPath',
    );
    expect(cleanup).not.toContain(
      'Remove-Item -LiteralPath $artifactPath -Recurse -Force',
    );
  });

  it('binds maintenance ownership to a transaction and only recovers a dead owner through that journal', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('transactionId = $transactionId');
    expect(source).toContain('processStartTime');
    expect(source).toContain('function Resolve-HotfixMaintenanceOwner');
    expect(source).toContain(
      'maintenance owner is dead but its durable transaction journal',
    );
  });

  it('recovers a legacy runtime with a manifest-verified temporary safe launcher', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const installer = extractInstallerSource(source);
    const recoveryFactory = installer.slice(
      installer.indexOf('function Get-VerifiedRecoveryStartManifestEntry'),
      installer.indexOf('function Remove-VerifiedRecoveryStartScript'),
    );
    const rollback = installer.slice(
      installer.indexOf('function Rollback-UncommittedHotfixTransaction'),
      installer.indexOf('function Assert-CommittedRuntimeFiles'),
    );
    const createIndex = rollback.indexOf('New-VerifiedRecoveryStartScript');
    const legacyStartIndex = rollback.indexOf(
      '-StartScriptPath $recoveryStart.path',
    );
    const legacyRestoreReleaseIndex = rollback.indexOf(
      'Restore-ReleaseFilesFromTransaction',
      legacyStartIndex,
    );
    const cleanupIndex = rollback.indexOf(
      'Remove-VerifiedRecoveryStartScript',
      legacyRestoreReleaseIndex,
    );
    const rolledBackIndex = rollback.lastIndexOf("-Phase 'rolled-back'");

    expect(installer).toContain('function New-VerifiedRecoveryStartScript');
    expect(installer).toContain("'.hotfix-recovery-start.'");
    expect(installer).toContain('Open-VerifiedIntegrityHandles');
    expect(installer).toContain('Write-HeldIntegrityFile');
    expect(installer).toContain('[string]$StartScriptPath');
    expect(installer).not.toContain(
      'function Test-VerifiedBaselineStartCanRecover',
    );
    expect(installer).toContain('function Assert-ServerDistBaseline');
    expect(recoveryFactory).toContain('$Manifest.supportFiles');
    expect(recoveryFactory).toContain(
      "'operations/deploy/hotfix-recovery-start.ps1'",
    );
    expect(recoveryFactory).not.toContain('$Manifest.releaseFiles');
    expect(rollback).toContain('-PackageRoot $PackageRoot');
    expect(rollback).toContain('-StartScriptPath $recoveryStart.path');
    expect(rollback).toContain(
      "Invoke-HotfixFaultInjection -Phase 'after-rollback-dist-restored'",
    );
    expect(rollback).toContain('Assert-PreviousDistRuntime');
    expect(rollback).toContain('-Root $Root');
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(legacyStartIndex).toBeGreaterThan(createIndex);
    expect(legacyRestoreReleaseIndex).toBeGreaterThan(legacyStartIndex);
    expect(cleanupIndex).toBeGreaterThan(legacyRestoreReleaseIndex);
    expect(rolledBackIndex).toBeGreaterThan(cleanupIndex);
  });

  it('ships a self-contained recovery launcher that starts only the fixed server entry', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const recoveryPath = path.resolve(
      process.cwd(),
      'deploy/hotfix-recovery-start.ps1',
    );
    const recoverySource = fs.readFileSync(recoveryPath, 'utf8');
    const packageJson = readJson(path.resolve(process.cwd(), 'package.json'));
    const requiredMajor = Number(
      String(packageJson.engines.node).match(/\d+/)?.[0],
    );

    expect(source).toContain("'deploy/hotfix-recovery-start.ps1'");
    expect(recoverySource).toContain("'dist\\server\\main.js'");
    expect(recoverySource).toContain(`$requiredNodeMajor = ${requiredMajor}`);
    expect(recoverySource).toContain('schemaVersion = 1');
    expect(recoverySource).toContain('$stream.Flush($true)');
    expect(recoverySource).toContain('Start-Process');
    expect(recoverySource).toContain('Stop-Process -Id $runtimeProcess.Id');
    expect(recoverySource).not.toContain('package.json');
    expect(recoverySource).not.toContain('scripts\\');
    expect(recoverySource).not.toContain('npm');
  });
});
