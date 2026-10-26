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

const nodeScript = resolve('scripts/configure-unified-access.mjs');
const powerShellScript = resolve('scripts/configure-unified-access.ps1');

describe('unified access deployment configuration', () => {
  let directory = '';

  afterEach(() => {
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
      directory = '';
    }
  });

  it('creates a missing env file through the real PowerShell wrapper on Node 24', () => {
    directory = mkdtempSync(join(tmpdir(), '统一 权限 参数-'));
    const envPath = join(directory, '.env.local');
    const harnessPath = join(directory, 'invoke-wrapper.ps1');
    expect(existsSync(envPath)).toBe(false);
    writeFileSync(
      harnessPath,
      [
        "$global:answers = @('dummy-admin-setup-20260717', 'dummy-editor-setup-20260717')",
        '$global:answerIndex = 0',
        'function global:Read-Host {',
        '  param([string]$Prompt, [switch]$AsSecureString)',
        '  $value = $global:answers[$global:answerIndex]',
        '  $global:answerIndex += 1',
        '  if ($AsSecureString) {',
        '    return ConvertTo-SecureString $value -AsPlainText -Force',
        '  }',
        '  return $value',
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
      LOCAL_ADMIN_PASSWORD_HASH: expect.stringMatching(scryptHashPattern()),
      LOCAL_EDITOR_PASSWORD_HASH: expect.stringMatching(scryptHashPattern()),
      LOCAL_ACCESS_SESSION_SECRET: expect.any(String),
    });
  });

  it('writes two random scrypt hashes and a session key without exposing them', () => {
    directory = mkdtempSync(join(tmpdir(), 'unified-access-config-'));
    const envPath = join(directory, '.env');
    const encryptionKey = Buffer.alloc(32, 9).toString('base64');
    writeFileSync(
      envPath,
      [
        '# existing values',
        'UNRELATED_VALUE=keep-me',
        `CONTRACT_ATTACHMENT_ENCRYPTION_KEY=${encryptionKey}`,
        'LOCAL_ADMIN_PASSWORD_HASH=old-admin-hash',
        '',
      ].join('\r\n'),
      'utf8',
    );

    const adminPassword = 'dummy-admin-setup-only';
    const editorPassword = 'dummy-editor-setup-only';
    const result = spawnSync(
      process.execPath,
      [nodeScript, '--target=env', `--env-file=${envPath}`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          LOCAL_ADMIN_SETUP_PASSWORD: adminPassword,
          LOCAL_EDITOR_SETUP_PASSWORD: editorPassword,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(adminPassword);
    expect(result.stdout).not.toContain(editorPassword);
    expect(result.stdout).not.toContain(encryptionKey);
    const status = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(status).toMatchObject({
      target: 'env',
      adminPasswordHashConfigured: true,
      editorPasswordHashConfigured: true,
      sessionKeyBytes: 32,
      preservedExistingEncryptionKey: true,
    });

    const updated = readFileSync(envPath, 'utf8');
    expect(updated).toContain('UNRELATED_VALUE=keep-me\r\n');
    expect(updated).toContain(
      `CONTRACT_ATTACHMENT_ENCRYPTION_KEY=${encryptionKey}\r\n`,
    );
    const values = readEnv(updated);
    expect(values.LOCAL_ADMIN_PASSWORD_HASH).toMatch(scryptHashPattern());
    expect(values.LOCAL_EDITOR_PASSWORD_HASH).toMatch(scryptHashPattern());
    expect(values.LOCAL_ADMIN_PASSWORD_HASH).not.toBe(
      values.LOCAL_EDITOR_PASSWORD_HASH,
    );
    expect(
      Buffer.from(values.LOCAL_ACCESS_SESSION_SECRET, 'base64'),
    ).toHaveLength(32);
    expect(updated).not.toContain(adminPassword);
    expect(updated).not.toContain(editorPassword);
  });

  it('fails closed when either one-time setup password is absent', () => {
    directory = mkdtempSync(join(tmpdir(), 'unified-access-config-'));
    const envPath = join(directory, '.env');
    writeFileSync(envPath, 'KEEP=1\n', 'utf8');
    const result = spawnSync(
      process.execPath,
      [nodeScript, '--target=env', `--env-file=${envPath}`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          LOCAL_ADMIN_SETUP_PASSWORD: 'dummy-admin-setup-only',
          LOCAL_EDITOR_SETUP_PASSWORD: '',
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('LOCAL_EDITOR_SETUP_PASSWORD');
    expect(readFileSync(envPath, 'utf8')).toBe('KEEP=1\n');
  });

  it('rejects identical role passwords before changing the environment file', () => {
    directory = mkdtempSync(join(tmpdir(), 'unified-access-config-'));
    const envPath = join(directory, '.env');
    writeFileSync(envPath, 'KEEP=1\n', 'utf8');
    const result = spawnSync(
      process.execPath,
      [nodeScript, '--target=env', `--env-file=${envPath}`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          LOCAL_ADMIN_SETUP_PASSWORD: 'same-dummy-setup-password',
          LOCAL_EDITOR_SETUP_PASSWORD: 'same-dummy-setup-password',
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must differ');
    expect(result.stderr).not.toContain('same-dummy-setup-password');
    expect(readFileSync(envPath, 'utf8')).toBe('KEEP=1\n');
  });

  it('uses hidden PowerShell input and packages both setup scripts', () => {
    const wrapperSource = readFileSync(powerShellScript, 'utf8');
    const nodeSource = readFileSync(nodeScript, 'utf8');
    const packageSource = readFileSync(
      resolve('scripts/create-migration-package.ps1'),
      'utf8',
    );
    const envExample = readFileSync(resolve('.env.example'), 'utf8');

    expect(wrapperSource).toMatch(/Read-Host[^\r\n]*-AsSecureString/);
    expect(wrapperSource).toContain('LOCAL_ADMIN_SETUP_PASSWORD');
    expect(wrapperSource).toContain('LOCAL_EDITOR_SETUP_PASSWORD');
    expect(wrapperSource).toContain(
      'Remove-Item Env:LOCAL_ADMIN_SETUP_PASSWORD',
    );
    expect(wrapperSource).toContain(
      'Remove-Item Env:LOCAL_EDITOR_SETUP_PASSWORD',
    );
    expect(wrapperSource).toContain(
      "$arguments = @('--', $nodeScript, \"--target=$Target\")",
    );
    expect(nodeSource).toContain('randomBytes(16)');
    expect(nodeSource).toContain('randomBytes(32)');
    expect(nodeSource).toContain("'reg.exe'");
    expect(nodeSource).toContain('[Environment]::SetEnvironmentVariable');
    expect(nodeSource).toContain('input: JSON.stringify(nextValues)');
    expect(nodeSource).not.toContain("['add', 'HKCU\\\\Environment'");
    expect(packageSource).toContain('configure-unified-access.mjs');
    expect(packageSource).toContain('configure-unified-access.ps1');
    expect(envExample).toContain('LOCAL_EDITOR_PASSWORD_HASH=');
    expect(envExample).toContain('LOCAL_ACCESS_SESSION_SECRET=');
    expect(envExample).toContain('LOCAL_ACCESS_COOKIE_SECURE=');
    expect(envExample).toContain('LOCAL_ACCESS_TRUST_PROXY=');
    expect(envExample).not.toContain('PURCHASE_RECORD_DELETE_PASSWORD_SHA256=');
  });
});

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
