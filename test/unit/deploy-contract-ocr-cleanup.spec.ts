import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const cleanupScript = resolve(
  root,
  'scripts/remove-legacy-contract-ocr.ps1',
);
const migrationPackageScript = resolve(
  root,
  'scripts/create-migration-package.ps1',
);

function writeFixture(base: string, relativePath: string, value = 'legacy') {
  const destination = join(base, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, value, 'utf8');
}

function runNpmConfigurationGuard(npmrc: string) {
  const scriptSource = readFileSync(migrationPackageScript, 'utf8');
  const functionStart = scriptSource.indexOf(
    'function Assert-NpmConfigurationSafeForPackaging',
  );
  const functionEnd = scriptSource.indexOf(
    'function Remove-PreviousBuildOutput',
    functionStart,
  );
  if (functionStart < 0 || functionEnd < 0) {
    throw new Error('Unable to extract npm configuration guard.');
  }

  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'npmrc-guard-'));
  const npmrcPath = join(fixtureDirectory, '.npmrc');
  const guardScript = join(fixtureDirectory, 'run-guard.ps1');
  writeFileSync(npmrcPath, npmrc, 'utf8');
  writeFileSync(
    guardScript,
    `${scriptSource.slice(functionStart, functionEnd)}\nAssert-NpmConfigurationSafeForPackaging -Path $args[0]\n`,
    'utf8',
  );

  try {
    return spawnSync(
      process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        guardScript,
        npmrcPath,
      ],
      { encoding: 'utf8' },
    );
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
}

describe('legacy contract OCR deployment cleanup', () => {
  let directory = '';
  let outsideDirectory = '';

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    if (outsideDirectory) {
      rmSync(outsideDirectory, { recursive: true, force: true });
    }
    directory = '';
    outsideDirectory = '';
  });

  it('is shipped by the migration package and runs before the new app starts', () => {
    const startScript = readFileSync(
      resolve(root, 'deploy/start.ps1'),
      'utf8',
    );
    const packager = readFileSync(
      resolve(root, 'scripts/create-migration-package.ps1'),
      'utf8',
    );
    const deployReadme = readFileSync(
      resolve(root, 'deploy/README.md'),
      'utf8',
    );

    expect(existsSync(cleanupScript)).toBe(true);
    expect(packager).toContain('remove-legacy-contract-ocr.ps1');
    expect(packager).toContain('-Root $stageDir');
    expect(packager).toContain('function Remove-PreviousBuildOutput');
    expect(packager.indexOf('Remove-PreviousBuildOutput -Root $repoRoot')).toBeLessThan(
      packager.indexOf('npm run build:prod'),
    );
    expect(startScript).toContain('Invoke-LegacyContractOcrCleanup');
    expect(startScript).toContain(
      "throw 'Required legacy contract OCR cleanup script was not found.'",
    );
    expect(startScript.indexOf('Invoke-LegacyContractOcrCleanup -Root $appRoot')).toBeGreaterThan(
      startScript.indexOf('Stop-ListeningProcessesOnPort -Port'),
    );
    expect(startScript.indexOf('Invoke-LegacyContractOcrCleanup -Root $appRoot')).toBeLessThan(
      startScript.indexOf('[void](Ensure-ContractPreviewDependencies'),
    );
    expect(deployReadme).not.toContain('合同 OCR 的 Python 依赖');
    expect(deployReadme).not.toContain('contract-ocr-install');
    expect(packager).toContain('function Assert-NpmConfigurationSafeForPackaging');
    expect(
      packager.indexOf('Assert-NpmConfigurationSafeForPackaging -Path'),
    ).toBeLessThan(packager.indexOf("Copy-Item -LiteralPath (Join-Path $repoRoot '.npmrc')"));
  });

  it('rejects registry URLs with credentials but allows a normal registry URL', () => {
    const credentialResult = runNpmConfigurationGuard(
      'registry=https://user:user-8a4cc9ae@example.com/\n',
    );
    const normalResult = runNpmConfigurationGuard(
      'registry=https://registry.npmjs.org/\n',
    );

    expect(credentialResult.status).not.toBe(0);
    expect(normalResult.status).toBe(0);
  });

  it('removes only legacy OCR artifacts and is idempotent', () => {
    expect(existsSync(cleanupScript)).toBe(true);
    if (!existsSync(cleanupScript)) return;

    directory = mkdtempSync(join(tmpdir(), 'contract-ocr-cleanup-'));
    const removed = [
      'scripts/extract-contract-terms.py',
      'scripts/ocr-contract-pages.ps1',
      'scripts/install-contract-ocr-python-deps.ps1',
      'scripts/requirements-contract-ocr.txt',
      'scripts/__pycache__/extract-contract-terms.cpython-311.pyc',
      'server/modules/contract-management/contract-payment-terms.rules.ts',
      'server/modules/contract-management/contract-payment-difference-review.ts',
      'server/modules/contract-management/contract-payment-confirmation.service.ts',
      'server/modules/contract-management/contract-payment-review.gateway.ts',
      'client/src/pages/ContractManagement/ContractPaymentDetailDialog.tsx',
      'client/src/pages/ContractManagement/ValidContractPaymentEvidenceDialog.tsx',
      'dist/server/modules/contract-management/contract-payment-terms.rules.js',
      'dist/server/modules/contract-management/contract-payment-terms.rules.d.ts',
      'dist/server/modules/contract-management/contract-payment-difference-review.js',
      'dist/server/modules/contract-management/contract-payment-confirmation.service.js',
      'dist/server/modules/contract-management/contract-payment-review.gateway.js',
      'dist/server/modules/contract-management/contract-payment-review.gateway.js.map',
      'dist/server/modules/contract-management/valid-contract-payment-review.service.js',
      'dist/server/modules/contract-management/valid-contract-payment-review.service.d.ts',
      'dist/server/modules/contract-management/valid-contract-payment-review.service.js.map',
      '.runtime/contract-ocr.ready',
      '.runtime/contract-ocr-install.pid',
      '.runtime/contract-ocr-install.running',
      '.runtime/contract-ocr-install.guard',
      'logs/contract-ocr-install.out.log',
      'logs/contract-ocr-install.err.log',
    ];
    const preserved = [
      'scripts/render-contract-pdf.py',
      'scripts/requirements-contract-preview.txt',
      'server/modules/contract-management/contract-attachment-storage.service.ts',
      'dist/server/modules/contract-management/contract-attachment-storage.service.js',
      '.runtime/contract-attachment-cos-index.json',
      '.runtime/contract-preview.ready',
      'logs/contract-preview-install.out.log',
      '.env',
      'data/contracts/keep.txt',
    ];

    for (const relativePath of removed) writeFixture(directory, relativePath);
    for (const relativePath of preserved) writeFixture(directory, relativePath, 'keep');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = spawnSync(
        process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          cleanupScript,
          '-Root',
          directory,
        ],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(0);
    }

    for (const relativePath of removed) {
      expect(existsSync(join(directory, relativePath))).toBe(false);
    }
    for (const relativePath of preserved) {
      expect(existsSync(join(directory, relativePath))).toBe(true);
      expect(readFileSync(join(directory, relativePath), 'utf8')).toBe('keep');
    }
  });

  (process.platform === 'win32' ? it : it.skip)(
    'refuses to follow a junction outside the application root',
    () => {
      directory = mkdtempSync(join(tmpdir(), 'contract-ocr-root-'));
      outsideDirectory = mkdtempSync(join(tmpdir(), 'contract-ocr-outside-'));
      const outsideLegacyFile = join(
        outsideDirectory,
        'extract-contract-terms.py',
      );
      writeFileSync(outsideLegacyFile, 'outside', 'utf8');
      symlinkSync(outsideDirectory, join(directory, 'scripts'), 'junction');

      const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        cleanupScript,
        '-Root',
        directory,
      ], { encoding: 'utf8' });

      expect(result.status).not.toBe(0);
      expect(existsSync(outsideLegacyFile)).toBe(true);
      expect(readFileSync(outsideLegacyFile, 'utf8')).toBe('outside');
    },
  );
});
