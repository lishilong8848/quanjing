import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packageScript = resolve(
  'scripts/create-inventory-inbound-hotfix-package.ps1',
);

describe('inventory inbound legacy partial hotfix package', () => {
  let temporaryDirectory = '';

  afterEach(() => {
    if (!temporaryDirectory) return;
    rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = '';
  });

  it('fails closed because it cannot prove a complete Nest runtime', () => {
    expect(existsSync(packageScript)).toBe(true);
    const script = readFileSync(packageScript, 'utf8');
    expect(script).toContain('UNSAFE_PARTIAL_HOTFIX_DISABLED');
    expect(script).toContain('create-safe-full-runtime-hotfix-package.ps1');
    expect(script).toContain('-BaselineRoot');
  });

  it('refuses to create an archive from the partial-overlay entrypoint', () => {
    temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'inventory-inbound-hotfix-disabled-'),
    );

    expect(() =>
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
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          windowsHide: true,
          stdio: 'pipe',
        },
      ),
    ).toThrow('UNSAFE_PARTIAL_HOTFIX_DISABLED');
    expect(
      readdirSync(temporaryDirectory).some((name) => name.endsWith('.zip')),
    ).toBe(false);
  });
});
