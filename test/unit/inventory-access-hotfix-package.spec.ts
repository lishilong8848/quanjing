import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const activationScript = resolve(
  'deploy/apply-inventory-access-hotfix.ps1',
);
const packageScript = resolve(
  'scripts/create-inventory-access-hotfix-package.ps1',
);

describe('inventory access minimal hotfix package', () => {
  let temporaryDirectory = '';

  afterEach(() => {
    if (temporaryDirectory) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = '';
    }
  });

  it('stops the old process before configuring passwords and starting the new backend', () => {
    expect(existsSync(activationScript)).toBe(true);
    if (!existsSync(activationScript)) return;

    const source = readFileSync(activationScript, 'utf8');
    const stopIndex = source.indexOf("Join-Path $appRoot 'stop.ps1'");
    const configureIndex = source.indexOf(
      "Join-Path $appRoot 'scripts/configure-inventory-access.ps1'",
    );
    const startIndex = source.indexOf("Join-Path $appRoot 'start.ps1'");

    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(configureIndex).toBeGreaterThan(stopIndex);
    expect(startIndex).toBeGreaterThan(configureIndex);
    expect(source).toContain("-SimpleMatch 'inventory_admin'");
    expect(source).toContain('Get-NetTCPConnection');
    expect(source).toContain("throw \"Port $port is still in use");
    expect(source).toContain("Join-Path $appRoot '.runtime/node/node.exe'");
    expect(source).toContain("& $startScript -NoBrowser");
    expect(source).not.toContain('DEFAULT_PASSWORD');
  });

  it('creates a self-contained patch without environment files or runtime data', () => {
    expect(existsSync(packageScript)).toBe(true);
    if (!existsSync(packageScript)) return;

    temporaryDirectory = mkdtempSync(join(tmpdir(), 'inventory-hotfix-'));
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

    expect(entries).toContain('apply-inventory-access-hotfix.ps1');
    expect(entries).toContain('apply-inventory-access-hotfix.cmd');
    expect(entries).toContain('scripts/configure-inventory-access.ps1');
    expect(entries).toContain(
      'dist/server/common/access/unified-access.controller.js',
    );
    expect(entries).toContain(
      'dist/server/modules/inventory-management/inventory-access-policy.js',
    );
    expect(entries).toContain('dist/client/index.html');
    expect(entries.some((entry) => /(^|\/)\.env$/.test(entry))).toBe(false);
    expect(entries.some((entry) => entry.startsWith('node_modules/'))).toBe(
      false,
    );
    expect(entries.some((entry) => entry.startsWith('data/'))).toBe(false);
    expect(entries.some((entry) => entry.startsWith('logs/'))).toBe(false);
  });
});
