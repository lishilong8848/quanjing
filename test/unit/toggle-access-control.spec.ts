import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const toggleScript = resolve('deploy/toggle-access-control.ps1');
const commandScript = resolve('deploy/toggle-access-control.cmd');

describe('access control master toggle', () => {
  let fixtureRoot = '';

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'access-toggle-'));
    mkdirSync(join(fixtureRoot, 'dist', 'server'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'dist', 'server', 'main.js'), '', 'utf8');
    writeFileSync(
      join(fixtureRoot, '.env'),
      ['SERVER_PORT=3001', 'SERVER_HOST=0.0.0.0', ''].join('\r\n'),
      'utf8',
    );
  });

  afterEach(() => {
    if (fixtureRoot) {
      rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = '';
    }
  });

  it('atomically disables and enables access control while preserving unrelated values', () => {
    expect(existsSync(toggleScript)).toBe(true);
    if (!existsSync(toggleScript)) return;

    const secret = 'scrypt$never-print-this-value';
    const envLocalPath = join(fixtureRoot, '.env.local');
    writeFileSync(
      envLocalPath,
      [
        '# existing settings',
        `LOCAL_ADMIN_PASSWORD_HASH=${secret}`,
        'LOCAL_ACCESS_CONTROL_ENABLED=true',
        'UNRELATED_VALUE=keep-me',
        'LOCAL_ACCESS_CONTROL_ENABLED=invalid-duplicate',
        '',
      ].join('\r\n'),
      'utf8',
    );

    const disabledOutput = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        toggleScript,
        '-Mode',
        'Disable',
        '-SkipRestart',
        '-AppRoot',
        fixtureRoot,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    const disabled = readFileSync(envLocalPath, 'utf8');
    expect(disabled.match(/^LOCAL_ACCESS_CONTROL_ENABLED=/gm)).toHaveLength(1);
    expect(disabled).toContain('LOCAL_ACCESS_CONTROL_ENABLED=false');
    expect(disabled).toContain(`LOCAL_ADMIN_PASSWORD_HASH=${secret}`);
    expect(disabled).toContain('UNRELATED_VALUE=keep-me');
    expect(disabledOutput).toContain('HIGH RISK');
    expect(disabledOutput).not.toContain(secret);

    const enabledOutput = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        toggleScript,
        '-Mode',
        'Enable',
        '-SkipRestart',
        '-AppRoot',
        fixtureRoot,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    const enabled = readFileSync(envLocalPath, 'utf8');
    expect(enabled.match(/^LOCAL_ACCESS_CONTROL_ENABLED=/gm)).toHaveLength(1);
    expect(enabled).toContain('LOCAL_ACCESS_CONTROL_ENABLED=true');
    expect(enabledOutput).not.toContain(secret);
  });

  it('reports the fail-safe default without exposing environment credentials', () => {
    expect(existsSync(toggleScript)).toBe(true);
    if (!existsSync(toggleScript)) return;

    const secret = 'do-not-echo-this-session-secret';
    writeFileSync(
      join(fixtureRoot, '.env.local'),
      `LOCAL_ACCESS_SESSION_SECRET=${secret}\r\n`,
      'utf8',
    );

    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        toggleScript,
        '-Mode',
        'Status',
        '-AppRoot',
        fixtureRoot,
      ],
      { encoding: 'utf8', windowsHide: true },
    );

    expect(output).toContain('ENABLED');
    expect(output).not.toContain(secret);
  });

  it('restores the original environment file when restart fails', () => {
    expect(existsSync(toggleScript)).toBe(true);
    if (!existsSync(toggleScript)) return;

    const original = [
      'LOCAL_ACCESS_CONTROL_ENABLED=true',
      'UNRELATED_VALUE=original',
      '',
    ].join('\r\n');
    writeFileSync(join(fixtureRoot, '.env.local'), original, 'utf8');
    writeFileSync(join(fixtureRoot, 'stop.ps1'), 'param()\n', 'utf8');
    writeFileSync(
      join(fixtureRoot, 'start.ps1'),
      [
        'param([switch]$NoBrowser)',
        "$marker = Join-Path $PSScriptRoot 'start-attempted.marker'",
        'if (!(Test-Path -LiteralPath $marker)) {',
        "  Set-Content -LiteralPath $marker -Value '1'",
        "  throw 'simulated startup failure'",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        toggleScript,
        '-Mode',
        'Disable',
        '-AppRoot',
        fixtureRoot,
      ],
      { encoding: 'utf8', windowsHide: true },
    );

    expect(result.status).not.toBe(0);
    expect(readFileSync(join(fixtureRoot, '.env.local'), 'utf8')).toBe(
      original,
    );
  });

  it('provides one CMD menu entry and a local Node runtime probe', () => {
    expect(existsSync(toggleScript)).toBe(true);
    expect(existsSync(commandScript)).toBe(true);
    if (!existsSync(toggleScript) || !existsSync(commandScript)) return;

    const source = readFileSync(toggleScript, 'utf8');
    const command = readFileSync(commandScript, 'utf8');
    expect(source).toContain(
      "[ValidateSet('Menu', 'Enable', 'Disable', 'Status')]",
    );
    expect(source).toContain("[string]$Mode = 'Menu'");
    expect(source).toContain('LOCAL_ACCESS_CONTROL_ENABLED');
    expect(source).toContain('accessControlEnabled');
    expect(source).toContain('rejectUnauthorized: false');
    expect(source).toContain('-NoBrowser');
    expect(source).toContain('Write-Atomic');
    expect(source).toContain(
      '$originalEnabled = Get-ConfiguredAccessControlEnabled',
    );
    expect(source).toContain('-ExpectedEnabled $originalEnabled');
    expect(source).toMatch(
      /if \(Test-Path -LiteralPath \$EnvLocalFile -PathType Leaf\) \{\s+Remove-Item -LiteralPath \$EnvLocalFile/s,
    );
    const rollbackRestartStart = source.indexOf('if ($restartAttempted)');
    const rollbackRestartEnd = source.indexOf(
      'Remove-Item -LiteralPath $backupPath',
      rollbackRestartStart,
    );
    expect(rollbackRestartStart).toBeGreaterThanOrEqual(0);
    expect(rollbackRestartEnd).toBeGreaterThan(rollbackRestartStart);
    expect(
      source.slice(rollbackRestartStart, rollbackRestartEnd),
    ).not.toContain('-SkipRuntimeVerification');
    expect(command).toContain('toggle-access-control.ps1');
    expect(command).toContain('%*');
    expect(command).toContain('pause');
  });
});
