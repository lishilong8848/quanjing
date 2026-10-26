import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

const nodeScript = resolve('scripts/configure-construction-access.mjs');
const powerShellScript = resolve('scripts/configure-construction-access.ps1');

describe('construction administrator access deployment configuration', () => {
  let directory = '';

  afterEach(() => {
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
      directory = '';
    }
  });

  it('creates a missing env file through the real PowerShell wrapper on Node 24', () => {
    directory = mkdtempSync(join(tmpdir(), 'construction-access-config-'));
    const envPath = join(directory, '.env.local');
    const harnessPath = join(directory, 'invoke-wrapper.ps1');
    expect(existsSync(envPath)).toBe(false);
    writeFileSync(
      harnessPath,
      [
        "$global:answer = 'dummy-construction-setup-20260717'",
        'function global:Read-Host {',
        '  param([string]$Prompt, [switch]$AsSecureString)',
        '  if ($AsSecureString) {',
        '    return ConvertTo-SecureString $global:answer -AsPlainText -Force',
        '  }',
        '  return $global:answer',
        '}',
        'try {',
        "  & $env:CONFIG_WRAPPER -Target env -EnvFile $env:CONFIG_OUTPUT",
        '  exit $LASTEXITCODE',
        '} catch {',
        '  [Console]::Error.WriteLine($_.Exception.Message)',
        '  exit 1',
        '}',
      ].join('\r\n'),
      'utf8',
    );

    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        harnessPath,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          CONFIG_WRAPPER: powerShellScript,
          CONFIG_OUTPUT: envPath,
          PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    );

    expect(result).toMatchObject({ status: 0, stderr: '' });
    expect(existsSync(envPath)).toBe(true);
    expect(readEnv(readFileSync(envPath, 'utf8'))).toMatchObject({
      LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH: expect.stringMatching(
        scryptHashPattern(),
      ),
    });
  });

  it('writes a random salted scrypt hash while preserving unrelated values', () => {
    directory = mkdtempSync(join(tmpdir(), 'construction-access-config-'));
    const envPath = join(directory, '.env');
    const password = 'dummy-construction-setup-only';
    writeFileSync(
      envPath,
      [
        '# existing values',
        'UNRELATED_VALUE=keep-me',
        'LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH=old-hash',
        'LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH=duplicate-old-hash',
        '',
      ].join('\r\n'),
      'utf8',
    );

    const first = runNodeConfiguration(envPath, password);
    expect(first).toMatchObject({ status: 0, stderr: '' });
    expect(first.stdout).not.toContain(password);
    expect(JSON.parse(first.stdout)).toEqual({
      target: 'env',
      constructionAdminPasswordHashConfigured: true,
    });
    const firstSource = readFileSync(envPath, 'utf8');
    const firstValues = readEnv(firstSource);
    expect(firstSource).toContain('UNRELATED_VALUE=keep-me\r\n');
    expect(firstSource.match(/LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH=/g)).toHaveLength(
      1,
    );
    expect(firstValues.LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH).toMatch(
      scryptHashPattern(),
    );
    expect(first.stdout).not.toContain(
      firstValues.LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH,
    );
    expect(firstSource).not.toContain(password);

    const second = runNodeConfiguration(envPath, password);
    expect(second).toMatchObject({ status: 0, stderr: '' });
    const secondValues = readEnv(readFileSync(envPath, 'utf8'));
    expect(secondValues.LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH).toMatch(
      scryptHashPattern(),
    );
    expect(secondValues.LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH).not.toBe(
      firstValues.LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH,
    );
  });

  it('fails closed without the one-time password and leaves the env file unchanged', () => {
    directory = mkdtempSync(join(tmpdir(), 'construction-access-config-'));
    const envPath = join(directory, '.env');
    writeFileSync(envPath, 'KEEP=1\n', 'utf8');

    const result = runNodeConfiguration(envPath, '');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('LOCAL_CONSTRUCTION_ADMIN_SETUP_PASSWORD');
    expect(readFileSync(envPath, 'utf8')).toBe('KEEP=1\n');
  });

  it('uses hidden PowerShell input, clears setup state and packages both scripts', () => {
    const wrapperSource = readFileSync(powerShellScript, 'utf8');
    const nodeSource = readFileSync(nodeScript, 'utf8');
    const packageSource = readFileSync(
      resolve('scripts/create-migration-package.ps1'),
      'utf8',
    );
    const envExample = readFileSync(resolve('.env.example'), 'utf8');

    expect(wrapperSource).toMatch(/Read-Host[^\r\n]*-AsSecureString/);
    expect(wrapperSource).toContain('LOCAL_CONSTRUCTION_ADMIN_SETUP_PASSWORD');
    expect(wrapperSource).toContain(
      'Remove-Item Env:LOCAL_CONSTRUCTION_ADMIN_SETUP_PASSWORD',
    );
    expect(wrapperSource).toContain("& $nodeCommand.Source '--' $nodeScript");
    expect(wrapperSource).toContain('"--output-env-file=$EnvFile"');
    expect(nodeSource).toContain('randomBytes(16)');
    expect(nodeSource).toContain("delete process.env[SETUP_PASSWORD_NAME]");
    expect(nodeSource).toContain("argument.startsWith('--output-env-file=')");
    expect(nodeSource).not.toContain("argument.startsWith('--env-file=')");
    expect(packageSource).toContain('configure-construction-access.mjs');
    expect(packageSource).toContain('configure-construction-access.ps1');
    expect(envExample).toContain('LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH=');
    expect(envExample).not.toContain('LOCAL_CONSTRUCTION_ADMIN_SETUP_PASSWORD=');
  });
});

function runNodeConfiguration(envPath: string, password: string) {
  return spawnSync(
    process.execPath,
    [nodeScript, '--target=env', `--output-env-file=${envPath}`],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LOCAL_CONSTRUCTION_ADMIN_SETUP_PASSWORD: password,
      },
    },
  );
}

function readEnv(source: string): Record<string, string> {
  return Object.fromEntries(
    source
      .split(/\r?\n/)
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function scryptHashPattern(): RegExp {
  return /^scrypt\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/;
}
