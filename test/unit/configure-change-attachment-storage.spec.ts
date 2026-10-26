import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scriptPath = resolve(
  'deploy/configure-change-attachment-storage.ps1',
);

describe('change attachment object storage credential setup', () => {
  let directory = '';

  afterEach(() => {
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
      directory = '';
    }
  });

  it('provides a deployment helper for one-time server configuration', () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  it('uses hidden prompts and never accepts credentials as command-line parameters', () => {
    const source = readSource();

    expect(source.match(/Read-Host[^\r\n]*-AsSecureString/g)).toHaveLength(3);
    expect(source).toContain('ZeroFreeBSTR');
    expect(source).toContain('[EnvironmentVariableTarget]::User');
    expect(source).toContain('[EnvironmentVariableTarget]::Process');
    expect(source).toContain("[ValidateSet('User', 'Process')]");
    expect(source).not.toMatch(/\[string\]\$Secret(?:Id|Key)/u);
    expect(source).not.toMatch(/Write-(?:Host|Output)[^\r\n]*\$(?:secretId|secretKey)/iu);
    expect(source).toContain("$secretIdName = 'COS_SECRET_ID'");
    expect(source).toContain("$secretKeyName = 'COS_SECRET_KEY'");
    expect(source).toContain("$sessionTokenName = 'COS_SESSION_TOKEN'");
  });

  it('configures an isolated process with redacted output', () => {
    if (!existsSync(scriptPath)) {
      expect(existsSync(scriptPath)).toBe(true);
      return;
    }

    directory = mkdtempSync(join(tmpdir(), 'change-storage-config-'));
    const harnessPath = join(directory, 'invoke-wrapper.ps1');
    const dummyId = 'dummy-tencent-id-for-process-only';
    const dummyKey = 'dummy-tencent-key-for-process-only';
    writeFileSync(
      harnessPath,
      [
        '$global:answers = [Collections.Generic.Queue[string]]::new()',
        `$global:answers.Enqueue('${dummyId}')`,
        `$global:answers.Enqueue('${dummyKey}')`,
        "$global:answers.Enqueue('')",
        'function global:Read-Host {',
        '  param([string]$Prompt, [switch]$AsSecureString)',
        '  $value = $global:answers.Dequeue()',
        '  if ($AsSecureString) {',
        '    if ($value.Length -eq 0) { return [Security.SecureString]::new() }',
        '    return ConvertTo-SecureString $value -AsPlainText -Force',
        '  }',
        '  return $value',
        '}',
        "$env:COS_SESSION_TOKEN = 'stale-token-that-must-be-cleared'",
        "& $env:CONFIG_WRAPPER -Target Process",
        `if ($env:COS_SECRET_ID -ne '${dummyId}') { throw 'COS SecretId was not configured.' }`,
        `if ($env:COS_SECRET_KEY -ne '${dummyKey}') { throw 'COS SecretKey was not configured.' }`,
        "if (![string]::IsNullOrEmpty($env:COS_SESSION_TOKEN)) { throw 'Stale COS SessionToken was not cleared.' }",
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
          CONFIG_WRAPPER: scriptPath,
        },
      },
    );

    expect(result).toMatchObject({ status: 0, stderr: '' });
    expect(result.stdout).toContain('READY (values redacted)');
    expect(result.stdout).not.toContain(dummyId);
    expect(result.stdout).not.toContain(dummyKey);
  });

  it('fails closed when either credential is empty', () => {
    if (!existsSync(scriptPath)) {
      expect(existsSync(scriptPath)).toBe(true);
      return;
    }

    directory = mkdtempSync(join(tmpdir(), 'change-storage-config-'));
    const harnessPath = join(directory, 'invoke-wrapper.ps1');
    writeFileSync(
      harnessPath,
      [
        '$global:answers = [Collections.Generic.Queue[string]]::new()',
        "$global:answers.Enqueue('dummy-id-only')",
        "$global:answers.Enqueue('')",
        "$global:answers.Enqueue('')",
        'function global:Read-Host {',
        '  param([string]$Prompt, [switch]$AsSecureString)',
        '  $value = $global:answers.Dequeue()',
        '  if ($value.Length -eq 0) { return [Security.SecureString]::new() }',
        '  return ConvertTo-SecureString $value -AsPlainText -Force',
        '}',
        'try {',
        "  & $env:CONFIG_WRAPPER -Target Process",
        '  exit 0',
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
          CONFIG_WRAPPER: scriptPath,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SecretId and SecretKey are required');
    expect(result.stdout).not.toContain('READY');
  });

  it('validates an already configured target without printing values', () => {
    if (!existsSync(scriptPath)) {
      expect(existsSync(scriptPath)).toBe(true);
      return;
    }

    const dummyId = 'dummy-validation-id';
    const dummyKey = 'dummy-validation-key';
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-Target',
        'Process',
        '-ValidateOnly',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          TENCENTCLOUD_SECRET_ID: dummyId,
          TENCENTCLOUD_SECRET_KEY: dummyKey,
        },
      },
    );

    expect(result).toMatchObject({ status: 0, stderr: '' });
    expect(result.stdout).toContain('READY (values redacted)');
    expect(result.stdout).not.toContain(dummyId);
    expect(result.stdout).not.toContain(dummyKey);
  });

  it('accepts the lower-priority Tencent aliases when no COS aliases exist', () => {
    if (!existsSync(scriptPath)) {
      expect(existsSync(scriptPath)).toBe(true);
      return;
    }

    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-Target',
        'Process',
        '-ValidateOnly',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          COS_SECRET_ID: '',
          COS_SECRET_KEY: '',
          TENCENTCLOUD_SECRET_ID: 'dummy-tencent-validation-id',
          TENCENTCLOUD_SECRET_KEY: 'dummy-tencent-validation-key',
        },
      },
    );

    expect(result).toMatchObject({ status: 0, stderr: '' });
    expect(result.stdout).toContain('READY (values redacted)');
    expect(result.stdout).not.toContain('dummy-tencent-validation');
  });
});

function readSource(): string {
  return existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : '';
}
