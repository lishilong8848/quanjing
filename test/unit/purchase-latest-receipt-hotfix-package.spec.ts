import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, relative, resolve } from 'path';

const listFiles = (root: string, directory = root): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return listFiles(root, absolutePath);
    }
    return [relative(root, absolutePath).replace(/\\/g, '/')];
  });

describe('purchase latest receipt hotfix package', () => {
  const scriptPath = resolve(
    __dirname,
    '../../scripts/create-purchase-latest-receipt-hotfix-package.ps1',
  );
  const script = readFileSync(scriptPath, 'utf8');

  it('packages the complete audited client snapshot instead of a lone main bundle', () => {
    expect(script).toContain(
      "purchase-receipt-coherent-client-overlay",
    );
    expect(script).toContain('$clientSnapshotFiles');
    expect(script).toContain(
      '$targetPreconditions = @($serverTargetPreconditions)',
    );
    expect(script).toContain('Assert-ClientAssetGraph');
    expect(script).toContain('verify-client-asset-graph.mjs');
    expect(script).toContain('Get-RelativeFilePaths -Root $clientSourceRoot');
    expect(script).toContain(
      'Get-ChildItem -LiteralPath $Root -Force -File -Recurse',
    );
    expect(script).toContain('Packaging inputs changed while the hotfix was being packaged.');
    expect(script).toContain('Staged server payload does not match the initial snapshot.');
    expect(script).toContain('PowerShell parser rejected the staged installer.');
    expect(script).toContain(
      "Get-ChildItem -LiteralPath $ClientRoot -Force -File -Filter '*.js' -Recurse",
    );
    expect(script).toContain('Get-Item -LiteralPath $Root -Force');
    expect(script).toContain('$manifestClientFiles');
    expect(script).not.toContain('Apply-ExactClientPatches');
    expect(script).not.toContain('clientMainBaselineSha256');
    expect(script).not.toContain('clientMainPatchedSha256');
    expect(script).not.toContain('4576.abe3a8e8.js');
    expect(script).not.toContain('replaceDirectories');
    expect(script).not.toContain('npm run build:client');
    expect(script).not.toContain('npm run build:prod');
  });

  it('overlays only the receipt authorization runtime files', () => {
    for (const runtimeFile of [
      'dist/server/common/access/unified-access.guard.js',
      'dist/server/modules/purchase-inventory/purchase-inventory.controller.js',
      'dist/server/modules/purchase-inventory/purchase-workflow-receipt-task.service.js',
      'dist/server/modules/purchase-inventory/purchase-workflow.rules.js',
    ]) {
      expect(script).toContain(`'${runtimeFile}'`);
    }

    for (const marker of [
      'receipt-tasks/',
      'getReceiptTaskStatus',
      'canReadReceiptTask',
      'isSameBuildingPurchaseApplicant',
    ]) {
      expect(script).toContain(`'${marker}'`);
    }
  });

  it('pins the server dependency closure and requires a verified restart', () => {
    for (const dependency of [
      'dist/server/main.js',
      'dist/server/common/access/unified-access.service.js',
      'dist/server/common/access/unified-access.decorators.js',
      'dist/server/modules/purchase-inventory/purchase-workflow.service.js',
      'dist/server/modules/purchase-inventory/purchase-workflow.gateway.js',
    ]) {
      expect(script).toContain(`'${dependency}'`);
    }

    expect(script).toContain('serviceRestartRequired = $true');
    expect(script).toContain("deploymentMode = 'coherent-client-overlay'");
    expect(script).toContain('targetPreconditions');
    expect(script).toContain('preservedFiles');
    expect(script).toContain("'apply-hotfix.ps1'");
  });

  it('verifies provenance, manifest hashes, archive entries, and exclusions', () => {
    for (const marker of [
      'Assert-ManifestHashes',
      'Assert-SafePayloadPaths',
      'Assert-ZipEntries',
      'hotfix-manifest.json',
      'Get-FileHash',
      'node --check',
      'clientSnapshotFiles',
      '.env',
      'node_modules',
      '.map',
      '.ts',
      '.runtime',
    ]) {
      expect(script).toContain(marker);
    }
  });

  it('builds an archive whose client snapshot exactly matches dist/client', () => {
    const outputDirectory = mkdtempSync(
      join(tmpdir(), 'purchase-receipt-package-'),
    );
    const extractDirectory = join(outputDirectory, 'extracted');
    try {
      const result = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          '-OutputDir',
          outputDirectory,
        ],
        {
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
          timeout: 120_000,
          windowsHide: true,
        },
      );
      const output = `${result.stdout || ''}\n${result.stderr || ''}`;
      expect(result.status).toBe(0);
      expect(output).not.toContain('Missing client assets');

      const names = readdirSync(outputDirectory);
      const zipNames = names.filter((name) => name.endsWith('.zip'));
      expect(zipNames).toHaveLength(1);
      expect(
        names.filter((name) => name.endsWith('.zip.sha256.txt')),
      ).toHaveLength(1);
      expect(names.some((name) => name.endsWith('.run'))).toBe(false);

      const expandResult = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${join(outputDirectory, zipNames[0]).replace(/'/g, "''")}' -DestinationPath '${extractDirectory.replace(/'/g, "''")}'`,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      expect(expandResult.status).toBe(0);

      const sourceClientRoot = resolve(__dirname, '../../dist/client');
      const packagedClientRoot = join(extractDirectory, 'dist', 'client');
      const sourceClientPaths = listFiles(sourceClientRoot).sort();
      const packagedClientPaths = listFiles(packagedClientRoot).sort();
      expect(packagedClientPaths).toEqual(sourceClientPaths);
      expect(packagedClientPaths).toContain('main.js');
      expect(
        packagedClientPaths.filter((path) => path.startsWith('chunks/')).length,
      ).toBeGreaterThan(1);

      const manifest = JSON.parse(
        readFileSync(join(extractDirectory, 'hotfix-manifest.json'), 'utf8').replace(
          /^\uFEFF/,
          '',
        ),
      );
      expect(manifest.packageType).toBe(
        'purchase-receipt-coherent-client-overlay',
      );
      expect(manifest.deploymentMode).toBe('coherent-client-overlay');
      const snapshotPaths = manifest.clientSnapshotFiles
        .map((entry: { path: string }) => entry.path)
        .sort();
      expect(snapshotPaths).toEqual(
        sourceClientPaths.map((path) => `dist/client/${path}`).sort(),
      );
      const replacedClientPaths = manifest.replaceFiles
        .filter((path: string) => path.startsWith('dist/client/'))
        .sort();
      expect(replacedClientPaths).toEqual(snapshotPaths);

      for (const entry of manifest.clientSnapshotFiles as Array<{
        path: string;
        sha256: string;
      }>) {
        const packagedPath = join(
          extractDirectory,
          entry.path.replace(/\//g, '\\'),
        );
        const actualHash = createHash('sha256')
          .update(readFileSync(packagedPath))
          .digest('hex')
          .toUpperCase();
        expect(actualHash).toBe(entry.sha256);
      }
    } finally {
      rmSync(outputDirectory, { force: true, recursive: true });
    }
  });
});
