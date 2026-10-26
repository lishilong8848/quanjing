import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const activationScript = resolve('deploy/apply-unified-access-recovery.ps1');
const packageScript = resolve(
  'scripts/create-unified-access-recovery-package.ps1',
);

describe('unified access recovery hotfix package', () => {
  let temporaryDirectory = '';

  afterEach(() => {
    if (temporaryDirectory) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = '';
    }
  });

  it('configures safely, stops legacy listeners, and verifies the exact running backend before success', () => {
    expect(existsSync(activationScript)).toBe(true);
    if (!existsSync(activationScript)) return;

    const source = readFileSync(activationScript, 'utf8');
    const unifiedIndex = source.indexOf('& $UnifiedConfigScript -Target env');
    const inventoryIndex = source.indexOf(
      '& $InventoryConfigScript -Target env',
    );
    const purchaseIndex = source.indexOf('& $PurchaseConfigScript -Target env');
    const constructionIndex = source.indexOf(
      '& $ConstructionConfigScript -Target env',
    );
    const configurationCallIndex = source.indexOf(
      '\nSet-UnifiedAccessConfiguration `',
    );
    const rootGuardIndex = source.indexOf(
      'This is not the existing application root',
    );
    const stopIndex = source.indexOf('& $stopScript');
    const startIndex = source.indexOf(
      '& $startScript -Port $effectivePort -NoBrowser',
    );
    const runtimeIndex = source.indexOf(
      'Assert-RunningAccessRuntimeWithNode `',
    );

    expect(unifiedIndex).toBeGreaterThanOrEqual(0);
    expect(inventoryIndex).toBeGreaterThan(unifiedIndex);
    expect(purchaseIndex).toBeGreaterThan(inventoryIndex);
    expect(constructionIndex).toBeGreaterThan(purchaseIndex);
    expect(rootGuardIndex).toBeGreaterThan(constructionIndex);
    expect(configurationCallIndex).toBeGreaterThan(rootGuardIndex);
    expect(stopIndex).toBeGreaterThan(configurationCallIndex);
    expect(startIndex).toBeGreaterThan(stopIndex);
    expect(runtimeIndex).toBeGreaterThan(startIndex);
    expect(source).toContain("Join-Path $appRoot '.env.local'");
    expect(source).toContain('Get-NetTCPConnection');
    expect(source).toContain('3001');
    expect(source).toContain('schemaVersion');
    expect(source).toContain('supportsInventoryAdministrator');
    expect(source).toContain('deploymentId');
    expect(source).toContain('configuration.core');
    expect(source).toContain('configuration.inventory');
    expect(source).toContain('configuration.purchase');
    expect(source).toContain('configuration.construction');
    expect(source).toContain('Set-DotEnvValueAtomically `');
    expect(source).toContain(
      "-Name 'LOCAL_ACCESS_DEPLOYMENT_ID' `",
    );
    expect(source).toContain(
      '[OK] Deployment identity persisted for watchdog restarts.',
    );
    expect(source).toContain('--report-only');
    expect(source).toContain('[switch]$ResetExtendedRoles');
    expect(source).toContain('-ResetExtendedRoles:$ResetExtendedRoles');
    expect(source).toContain(
      'Resetting purchase administrator and applicant passwords',
    );
    expect(source).toContain(
      'Resetting construction administrator password',
    );
    expect(source).toContain('rejectUnauthorized: false');
    expect(source).toContain('This is not the existing application root');
    expect(source).toContain('PUBLIC_BASE_URL is missing');
    expect(source).toContain('Recovery backup was retained at');
    expect(source).not.toContain('ServerCertificateValidationCallback');
    expect(source).not.toContain('DEFAULT_PASSWORD');
  });

  it('keeps the result window open and forwards optional recovery arguments', () => {
    const commandScript = resolve('deploy/apply-unified-access-recovery.cmd');
    const source = readFileSync(commandScript, 'utf8');

    expect(source).toContain('-ResetExtendedRoles %*');
    expect(source).toContain('%*');
    expect(source).toContain('pause');
  });

  it('packages complete compiled output while excluding secrets and runtime data', () => {
    expect(existsSync(packageScript)).toBe(true);
    if (!existsSync(packageScript)) return;

    const packageSource = readFileSync(packageScript, 'utf8');
    expect(packageSource).toContain("'inventory_admin'");
    expect(packageSource).toContain("'purchase_admin'");
    expect(packageSource).toContain("'purchase_applicant'");
    expect(packageSource).toContain("'construction_admin'");

    temporaryDirectory = mkdtempSync(join(tmpdir(), 'access-recovery-'));
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        packageScript,
        '-SkipBuild',
        '-OutputDir',
        temporaryDirectory,
      ],
      { cwd: process.cwd(), encoding: 'utf8', windowsHide: true },
    );

    const zipName = readdirSync(temporaryDirectory).find((name) =>
      name.endsWith('.zip'),
    );
    expect(zipName).toBeDefined();
    if (!zipName) return;

    const entries = execFileSync(
      'tar.exe',
      ['-tf', join(temporaryDirectory, zipName)],
      { encoding: 'utf8', windowsHide: true },
    )
      .split(/\r?\n/)
      .filter(Boolean)
      .map((entry) => entry.replace(/\\/g, '/'));

    expect(entries).toContain('apply-unified-access-recovery.ps1');
    expect(entries).toContain('apply-unified-access-recovery.cmd');
    expect(entries).toContain('toggle-access-control.ps1');
    expect(entries).toContain('toggle-access-control.cmd');
    expect(entries).toContain('scripts/configure-unified-access.mjs');
    expect(entries).toContain('scripts/configure-inventory-access.mjs');
    expect(entries).toContain('scripts/configure-purchase-access.mjs');
    expect(entries).toContain('scripts/configure-purchase-access.ps1');
    expect(entries).toContain('scripts/configure-construction-access.mjs');
    expect(entries).toContain('scripts/configure-construction-access.ps1');
    expect(entries).toContain('scripts/verify-unified-access-config.mjs');
    expect(entries).toContain('watchdog.ps1');
    expect(entries).toContain('hotfix-manifest.json');
    expect(entries).toContain('dist/server/main.js');
    expect(entries).toContain('dist/server/runtime-env.js');
    expect(entries).toContain(
      'dist/server/common/access/unified-access.controller.js',
    );
    expect(entries).toContain('dist/shared/access-control.interface.js');
    expect(entries).toContain('dist/client/index.html');
    expect(
      entries.some((entry) => /(^|\/)\.env(?:\.local)?$/.test(entry)),
    ).toBe(false);
    expect(entries.some((entry) => entry.startsWith('node_modules/'))).toBe(
      false,
    );
    expect(
      entries.some((entry) => /^(data|logs|certs|\.runtime)\//.test(entry)),
    ).toBe(false);

    const manifest = JSON.parse(
      execFileSync(
        'tar.exe',
        ['-xOf', join(temporaryDirectory, zipName), 'hotfix-manifest.json'],
        { encoding: 'utf8', windowsHide: true },
      ).replace(/^\uFEFF/, ''),
    ) as {
      schemaVersion: number;
      files: Array<{ path: string; sha256: string }>;
    };
    const mainEntry = manifest.files.find(
      (entry) => entry.path === 'dist/server/main.js',
    );
    const recoveryEntry = manifest.files.find(
      (entry) => entry.path === 'apply-unified-access-recovery.ps1',
    );
    expect(manifest.schemaVersion).toBe(1);
    expect(mainEntry?.sha256).toMatch(/^[A-F0-9]{64}$/);
    expect(recoveryEntry?.sha256).toMatch(/^[A-F0-9]{64}$/);
    const archivedMain = execFileSync(
      'tar.exe',
      ['-xOf', join(temporaryDirectory, zipName), 'dist/server/main.js'],
      { windowsHide: true },
    );
    expect(
      createHash('sha256').update(archivedMain).digest('hex').toUpperCase(),
    ).toBe(mainEntry?.sha256);

    const archivedRecovery = execFileSync(
      'tar.exe',
      [
        '-xOf',
        join(temporaryDirectory, zipName),
        'apply-unified-access-recovery.ps1',
      ],
      { windowsHide: true },
    );
    expect(archivedRecovery).toEqual(readFileSync(activationScript));
    expect(
      createHash('sha256')
        .update(archivedRecovery)
        .digest('hex')
        .toUpperCase(),
    ).toBe(recoveryEntry?.sha256);
    expect(archivedRecovery.toString('utf8')).toContain(
      '[switch]$ResetExtendedRoles',
    );
    expect(archivedRecovery.toString('utf8')).toContain(
      "-Name 'LOCAL_ACCESS_DEPLOYMENT_ID' `",
    );
  });
});
