import { createHash } from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';

const repoFile = (relativePath: string) =>
  join(process.cwd(), ...relativePath.split('/'));

const sha256 = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();

const snapshotTree = (root: string) => {
  const snapshot: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else {
        snapshot[relative(root, fullPath).replace(/\\/g, '/')] =
          sha256(fullPath);
      }
    }
  };
  visit(root);
  return snapshot;
};

describe('construction optimistic CRUD compiled hotfix package', () => {
  const readPackageScript = () =>
    readFileSync(
      repoFile(
        'scripts/create-construction-optimistic-crud-hotfix-package.ps1',
      ),
      'utf8',
    );

  const readInstaller = () =>
    readFileSync(
      repoFile('deploy/apply-construction-optimistic-crud-hotfix.ps1'),
      'utf8',
    );

  it('locks the approved client and server baseline archives', () => {
    const source = readPackageScript();

    for (const marker of [
      'construction-daily-verification-hotfix-20260723-175514.zip',
      '6B4EB59BF9DC0C5B255981A93368D3F0156164B1D4E7455120C8EC026A314C95',
      '935F9EA63A57E203764E532B88C807AF311A1E41A07D460B41879A30C695DC98',
      'dist/client/chunks/3668.c99500bd.js',
      'CF455AF2DEDBC3582BED68CF2DD658D44C4E4E2AC5824178FE5729E76B1DED23',
      'construction-work-type-submit-hotfix-20260724-074957.zip',
      'E67DA91185444F9F536E6AD174010AFD4011FBBFBE295D0FDF25404E8F02CD82',
      'C09B2FF48C14565A27BC8BE8F563A8A59952DEB03C37A175265A29BB55555F85',
    ]) {
      expect(source).toContain(marker);
    }
    expect(source).toContain('$expectedClientFileCount = 88');
  });

  it('assembles main.js from the baseline by replacing only module 79636 and the 3668 mapping', () => {
    const source = readPackageScript();

    expect(source).toContain('replace-rspack-main-module.mjs');
    expect(source).toContain("'79636'");
    expect(source).toContain("'3668'");
    expect(source).toContain('Unexpected client change outside approved files');
    expect(source).toContain('baselineModuleSha256');
    expect(source).toContain('currentModuleSha256');
    expect(source).toContain('PENDING_FINAL_BUILD_');
    expect(source).toContain('must be finalized before packaging');
    for (const finalizedMarker of [
      'CB35C1C2C68EB8285D93233B013C5FE1CF6DCFF263B23B9248AB29513E69D0DE',
      '17589DF87086669D9A32086FCB65BC47929462274A6A33FE95D4C9FDF061D040',
      '60F7D52756445C38D30B510CD6640C4A460581B80B9FAF920A01D8B0718F80F4',
    ]) {
      expect(source).toContain(finalizedMarker);
    }
    expect(source).not.toContain(
      "'PENDING_FINAL_BUILD_CONSTRUCTION_CHUNK_PATH'",
    );
    expect(source).not.toContain(
      "'PENDING_FINAL_BUILD_CONSTRUCTION_CHUNK_SHA256'",
    );
    expect(source).not.toContain("'PENDING_FINAL_BUILD_MAIN_SHA256'");
    expect(source).not.toContain(
      "'PENDING_FINAL_BUILD_MODULE_79636_SHA256'",
    );
    expect(source).not.toContain(
      "'PENDING_FINAL_BUILD_CONSTRUCTION_CHUNK_HASH'",
    );
    expect(source).not.toContain(
      "'PENDING_FINAL_BUILD_DUTY_SCHEDULE_SERVICE_SHA256'",
    );
    expect(source).not.toContain(
      'Copy-Item -LiteralPath $currentMainPath -Destination $stagedMainPath',
    );
  });

  it('discovers the fresh construction chunk and validates a build-noise-normalized fingerprint', () => {
    const source = readPackageScript();

    expect(source).toContain('normalize-client-build-asset.mjs');
    expect(source).toContain('$currentClientChunkNormalizedSha256');
    expect(source).toContain('currentClientChunkCandidates');
    expect(source).toContain('normalizedSha256');
    expect(source).toContain('buildTimeCount');
    expect(source).not.toContain('dist/client/chunks/3668.76f9a540.js');
    expect(source).not.toContain(
      '993616656A6C5FA134BA144D322966273453A91A4A5706AD1981AB0D2D162138',
    );
    expect(source).not.toContain(
      '28B9ED5CA08B9EF3B4B670A3348C61180915DD4E7B763922F7B46B99CA731D40',
    );
  });

  it('normalizes only injected build timestamps while retaining the exact artifact hash', () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), 'construction-client-asset-normalizer-'),
    );
    try {
      const firstPath = join(temporaryRoot, '3668.first.js');
      const secondPath = join(temporaryRoot, '3668.second.js');
      writeFileSync(
        firstPath,
        'const builtAt="2026-07-24T16:30:24.123Z";const value=42;',
        'utf8',
      );
      writeFileSync(
        secondPath,
        'const builtAt="2026-07-24T16:34:58.967Z";const value=42;',
        'utf8',
      );

      const normalizerPath = repoFile(
        'scripts/normalize-client-build-asset.mjs',
      );
      const first = JSON.parse(
        execFileSync(process.execPath, [normalizerPath, '--asset', firstPath], {
          encoding: 'utf8',
        }),
      );
      const second = JSON.parse(
        execFileSync(
          process.execPath,
          [normalizerPath, '--asset', secondPath],
          { encoding: 'utf8' },
        ),
      );

      expect(first.fullSha256).not.toBe(second.fullSha256);
      expect(first.normalizedSha256).toBe(second.normalizedSha256);
      expect(first.buildTimeCount).toBe(1);
      expect(second.buildTimeCount).toBe(1);
      expect(first).not.toHaveProperty('assetPath');
      expect(second).not.toHaveProperty('assetPath');
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('packages a complete compiled client and only one server runtime file', () => {
    const source = readPackageScript();

    expect(source).toContain("replaceDirectories = @('dist/client')");
    expect(source).toContain(
      "'dist/server/modules/duty-schedule/duty-schedule.service.js'",
    );
    expect(source).toContain('replaceFiles = @($serverRelativePath)');
    expect(source).not.toContain(
      'dist/server/modules/duty-schedule/construction-management.js',
    );
    expect(source).not.toContain('dist/shared');
    expect(source).not.toContain('dist/server/main.js');
  });

  it('declares the construction-only manual review mode in the package scope', () => {
    const source = readPackageScript();

    for (const marker of [
      'construction-management-ai-audit-master-switch-default-off',
      'construction-management-manual-review-only-mode',
      'construction-management-personnel-certificate-check-preserved',
    ]) {
      expect(source).toContain(marker);
    }
  });

  it('rejects source, dependencies, credentials, runtime data, and source maps', () => {
    const source = readPackageScript();

    for (const marker of [
      '.env',
      'node_modules',
      'data',
      'logs',
      'certs',
      'sourcemaps',
      'package-lock.json',
      '\\.(map|ts|tsx|d\\.ts|spec|log|pem|key)$',
    ]) {
      expect(source).toContain(marker);
    }
    expect(source).toContain('secretsIncluded = $false');
    expect(source).toContain('dependencyInstallRequired = $false');
    expect(source).toContain('$zipPath.sha256.txt');
  });

  it('installs only the compiled client and service with baseline checks, backup, and rollback', () => {
    const source = readInstaller();

    for (const marker of [
      'replaceDirectories must contain only $clientRelativePath',
      'replaceFiles must contain exactly one server JavaScript path',
      'Assert-BaselineClientMatchesPackage',
      'Assert-PathChainHasNoReparsePoint',
      'Assert-TreeHasNoReparsePoint',
      'Creating verified runtime backup',
      'Previous runtime was restored',
      'already fully installed',
      'does not stop or start any service',
    ]) {
      expect(source).toContain(marker);
    }
    expect(source).toContain(
      "$allowedServerRelativePath = 'dist/server/modules/duty-schedule/duty-schedule.service.js'",
    );
    expect(source).not.toContain('npm ci');
    expect(source).not.toContain('npm run build');
    expect(source).not.toContain('.env');
  });

  it('validates an already-hotfixed client before completing a partial server install', () => {
    const source = readInstaller();
    const partialInstallGuard =
      source.indexOf("Label 'hotfix client before partial install'");
    const backupStart = source.indexOf(
      "Write-Host '[1/4] Creating verified runtime backup...'",
    );

    expect(partialInstallGuard).toBeGreaterThan(0);
    expect(partialInstallGuard).toBeLessThan(backupStart);
    expect(source.slice(partialInstallGuard - 500, partialInstallGuard)).toContain(
      'Assert-RuntimeMatchesManifest',
    );
    expect(source.slice(partialInstallGuard - 500, partialInstallGuard)).toContain(
      '-ManifestFiles $manifestClientEntries',
    );
  });

  it('documents baseline, installation, verification, rollback, and exclusions', () => {
    const source = readFileSync(
      repoFile('deploy/README_CONSTRUCTION_OPTIMISTIC_CRUD.md'),
      'utf8',
    );

    for (const marker of [
      'construction-daily-verification-hotfix-20260723-175514.zip',
      'construction-work-type-submit-hotfix-20260724-074957.zip',
      'dist/client',
      'duty-schedule.service.js',
      '79636',
      '3668',
      'CONSTRUCTION_AI_AUDIT_ENABLED=false',
      '人员持证核查不受此开关影响',
      '先删除当前完整 `dist/client`',
      '备份',
      '回滚',
      'Ctrl+F5',
      '不包含',
    ]) {
      expect(source).toContain(marker);
    }
  });
});

describe('construction optimistic CRUD installer integration', () => {
  jest.setTimeout(180_000);

  const installerName = 'apply-construction-optimistic-crud-hotfix.ps1';
  const serverRelativePath = join(
    'dist',
    'server',
    'modules',
    'duty-schedule',
    'duty-schedule.service.js',
  );
  let fixtureRoot: string;
  let packageRoot: string;
  let baselineClientRoot: string;
  let baselineServerRoot: string;

  const extractZip = (zipPath: string, destination: string) => {
    mkdirSync(destination, { recursive: true });
    execFileSync('tar', ['-xf', zipPath, '-C', destination], {
      stdio: 'pipe',
    });
  };

  const createBaselineRuntime = (name: string) => {
    const runtimeRoot = join(fixtureRoot, name);
    mkdirSync(join(runtimeRoot, 'dist', 'server', 'modules', 'duty-schedule'), {
      recursive: true,
    });
    cpSync(
      join(baselineClientRoot, 'dist', 'client'),
      join(runtimeRoot, 'dist', 'client'),
      { recursive: true },
    );
    copyFileSync(
      join(baselineServerRoot, serverRelativePath),
      join(runtimeRoot, serverRelativePath),
    );
    return runtimeRoot;
  };

  const runInstaller = (root: string, targetRoot: string) => {
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(root, installerName),
        '-TargetRoot',
        targetRoot,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    return {
      ...result,
      output: `${result.stdout || ''}\n${result.stderr || ''}`,
    };
  };

  const backupNames = (runtimeRoot: string) => {
    const backupRoot = join(runtimeRoot, 'hotfix-backups');
    return existsSync(backupRoot) ? readdirSync(backupRoot).sort() : [];
  };

  const updateManifestAuxiliaryHash = (
    root: string,
    relativePath: string,
  ) => {
    const manifestPath = join(root, 'hotfix-manifest.json');
    const manifest = JSON.parse(
      readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''),
    );
    const entry = manifest.auxiliaryFiles.find(
      (item: { path: string }) => item.path === relativePath,
    );
    if (!entry) {
      throw new Error(`Missing auxiliary manifest entry: ${relativePath}`);
    }
    const fullPath = join(root, relativePath);
    entry.size = statSync(fullPath).size;
    entry.sha256 = sha256(fullPath);
    writeFileSync(
      manifestPath,
      `\uFEFF${JSON.stringify(manifest, null, 2)}`,
      'utf8',
    );
  };

  beforeAll(() => {
    fixtureRoot = mkdtempSync(
      join(tmpdir(), 'construction-optimistic-installer-'),
    );
    const packageOutput = join(fixtureRoot, 'package-output');
    mkdirSync(packageOutput, { recursive: true });
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        repoFile(
          'scripts/create-construction-optimistic-crud-hotfix-package.ps1',
        ),
        '-OutputDir',
        packageOutput,
        '-SkipBuild',
      ],
      { encoding: 'utf8', stdio: 'pipe', windowsHide: true },
    );
    const packageZips = readdirSync(packageOutput)
      .filter((name) => name.endsWith('.zip'))
      .map((name) => join(packageOutput, name));
    expect(packageZips).toHaveLength(1);

    packageRoot = join(fixtureRoot, 'package');
    baselineClientRoot = join(fixtureRoot, 'baseline-client');
    baselineServerRoot = join(fixtureRoot, 'baseline-server');
    extractZip(packageZips[0], packageRoot);
    extractZip(
      repoFile(
        'output/hotfix/construction-daily-verification-hotfix-20260723-175514.zip',
      ),
      baselineClientRoot,
    );
    extractZip(
      repoFile(
        'output/hotfix/construction-work-type-submit-hotfix-20260724-074957.zip',
      ),
      baselineServerRoot,
    );
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('installs the baseline once, is idempotent, and rejects unrelated client drift before mutation', () => {
    const runtimeRoot = createBaselineRuntime('runtime-idempotent');
    const first = runInstaller(packageRoot, runtimeRoot);
    expect(first.status).toBe(0);
    expect(first.output).toContain('Hotfix installed and validated');
    expect(backupNames(runtimeRoot)).toHaveLength(1);

    const second = runInstaller(packageRoot, runtimeRoot);
    expect(second.status).toBe(0);
    expect(second.output).toContain('already fully installed');
    expect(backupNames(runtimeRoot)).toHaveLength(1);

    copyFileSync(
      join(baselineServerRoot, serverRelativePath),
      join(runtimeRoot, serverRelativePath),
    );
    const unrelatedAsset = join(runtimeRoot, 'dist', 'client', 'favicon.svg');
    appendFileSync(unrelatedAsset, '\n<!-- synthetic unrelated drift -->\n');
    const beforeRejectedInstall = snapshotTree(join(runtimeRoot, 'dist'));

    const rejected = runInstaller(packageRoot, runtimeRoot);
    expect(rejected.status).not.toBe(0);
    expect(rejected.output).toContain('hotfix client before partial install');
    expect(backupNames(runtimeRoot)).toHaveLength(1);
    expect(snapshotTree(join(runtimeRoot, 'dist'))).toEqual(
      beforeRejectedInstall,
    );
  });

  it('rejects an out-of-scope manifest before backup or mutation', () => {
    const runtimeRoot = createBaselineRuntime('runtime-manifest-rejection');
    const tamperedPackage = join(fixtureRoot, 'package-invalid-manifest');
    cpSync(packageRoot, tamperedPackage, { recursive: true });
    const manifestPath = join(tamperedPackage, 'hotfix-manifest.json');
    const manifest = JSON.parse(
      readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''),
    );
    manifest.replaceFiles = ['dist/server/main.js'];
    writeFileSync(
      manifestPath,
      `\uFEFF${JSON.stringify(manifest, null, 2)}`,
      'utf8',
    );
    const beforeRejectedInstall = snapshotTree(join(runtimeRoot, 'dist'));

    const rejected = runInstaller(tamperedPackage, runtimeRoot);
    expect(rejected.status).not.toBe(0);
    expect(rejected.output).toContain('replaceFiles');
    expect(backupNames(runtimeRoot)).toHaveLength(0);
    expect(snapshotTree(join(runtimeRoot, 'dist'))).toEqual(
      beforeRejectedInstall,
    );
  });

  it('restores the complete baseline after a synthetic post-client-copy failure', () => {
    const runtimeRoot = createBaselineRuntime('runtime-rollback');
    const failingPackage = join(fixtureRoot, 'package-failing-install');
    cpSync(packageRoot, failingPackage, { recursive: true });
    const installerPath = join(failingPackage, installerName);
    const installer = readFileSync(installerPath, 'utf8');
    const failurePoint =
      "  Write-Host '[3/4] Replacing server runtime files...'";
    expect(installer).toContain(failurePoint);
    writeFileSync(
      installerPath,
      installer.replace(
        failurePoint,
        "  throw 'SYNTHETIC_POST_CLIENT_FAILURE'\r\n\r\n" + failurePoint,
      ),
      'utf8',
    );
    updateManifestAuxiliaryHash(failingPackage, installerName);
    const baselineSnapshot = snapshotTree(join(runtimeRoot, 'dist'));

    const failed = runInstaller(failingPackage, runtimeRoot);
    expect(failed.status).not.toBe(0);
    expect(failed.output).toContain('Previous runtime was restored');
    expect(failed.output).toContain('SYNTHETIC_POST_CLIENT_FAILURE');
    expect(backupNames(runtimeRoot)).toHaveLength(1);
    expect(snapshotTree(join(runtimeRoot, 'dist'))).toEqual(baselineSnapshot);
  });
});

describe('Rspack main module replacement helper', () => {
  let fixtureRoot: string;
  const helperPath = repoFile('scripts/replace-rspack-main-module.mjs');

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'rspack-module-replace-'));
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('replaces one requested module and one requested chunk mapping', () => {
    const baselinePath = join(fixtureRoot, 'baseline.js');
    const currentPath = join(fixtureRoot, 'current.js');
    const outputPath = join(fixtureRoot, 'output.js');
    const baseline =
      '(()=>{var m={1(e){return"base"},79636(e,t,r){return"old"},' +
      '90000(e){return"stable"}};var h={3668:"aaaaaaaa",7777:"cccccccc"}})();';
    const current =
      '(()=>{var m={1(e){return"changed elsewhere"},' +
      '79636(e,t,r){const s="brace }";/* } */return /\\}/.test(s)},' +
      '90000(e){return"also changed"}};var h={3668:"bbbbbbbb",7777:"dddddddd"}})();';
    mkdirSync(fixtureRoot, { recursive: true });
    writeFileSync(baselinePath, baseline, 'utf8');
    writeFileSync(currentPath, current, 'utf8');

    const output = execFileSync(
      process.execPath,
      [
        helperPath,
        '--baseline',
        baselinePath,
        '--current',
        currentPath,
        '--output',
        outputPath,
        '--module-id',
        '79636',
        '--chunk-id',
        '3668',
        '--baseline-chunk-hash',
        'aaaaaaaa',
        '--current-chunk-hash',
        'bbbbbbbb',
      ],
      { encoding: 'utf8' },
    );
    const report = JSON.parse(output);
    const assembled = readFileSync(outputPath, 'utf8');

    expect(report.moduleId).toBe('79636');
    expect(report.chunkId).toBe('3668');
    expect(report.moduleReplacementCount).toBe(1);
    expect(report.mappingReplacementCount).toBe(1);
    expect(report.baselineModuleSha256).toMatch(/^[A-F0-9]{64}$/);
    expect(report.currentModuleSha256).toMatch(/^[A-F0-9]{64}$/);
    expect(assembled).toContain('1(e){return"base"}');
    expect(assembled).toContain('90000(e){return"stable"}');
    expect(assembled).toContain(
      '79636(e,t,r){const s="brace }";/* } */return /\\}/.test(s)}',
    );
    expect(assembled).toContain('3668:"bbbbbbbb"');
    expect(assembled).toContain('7777:"cccccccc"');
    expect(assembled).not.toContain('changed elsewhere');
    expect(assembled).not.toContain('also changed');
  });

  it('rejects an ambiguous requested module boundary', () => {
    const baselinePath = join(fixtureRoot, 'baseline.js');
    const currentPath = join(fixtureRoot, 'current.js');
    const outputPath = join(fixtureRoot, 'output.js');
    writeFileSync(
      baselinePath,
      'var a={79636(e){return 1},79636(e){return 2}};var h={3668:"aaaaaaaa"};',
      'utf8',
    );
    writeFileSync(
      currentPath,
      'var a={79636(e){return 3}};var h={3668:"bbbbbbbb"};',
      'utf8',
    );

    expect(() =>
      execFileSync(
        process.execPath,
        [
          helperPath,
          '--baseline',
          baselinePath,
          '--current',
          currentPath,
          '--output',
          outputPath,
          '--module-id',
          '79636',
          '--chunk-id',
          '3668',
          '--baseline-chunk-hash',
          'aaaaaaaa',
          '--current-chunk-hash',
          'bbbbbbbb',
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      ),
    ).toThrow('Expected exactly one module 79636 in baseline, got 2');
  });
});
