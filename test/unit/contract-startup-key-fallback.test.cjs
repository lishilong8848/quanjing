const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = resolve(__dirname, '../..');
const name = 'CONTRACT_ATTACHMENT_ENCRYPTION_KEY';
const inherited = Buffer.alloc(32, 7).toString('base64');
const configured = Buffer.alloc(32, 8).toString('base64');

for (const [label, envText, localText, expected] of [
  ['blank placeholders preserve inherited key', `${name}=`, `${name}=   `, inherited],
  ['nonempty local configuration retains precedence', `${name}=${inherited}`, `${name}=${configured}`, configured],
  ['missing key stays absent rather than being generated', `${name}=`, '', ''],
]) {
  test(`run-with-env: ${label}`, () => {
    const fixture = mkdtempSync(join(tmpdir(), 'nt-contract-key-'));
    try {
      writeFileSync(join(fixture, '.env'), envText);
      writeFileSync(join(fixture, '.env.local'), localText);
      const env = { ...process.env, [name]: expected ? inherited : '' };
      const probe = `process.stdout.write(String((process.env.${name} || '') === ${JSON.stringify(expected)}))`;
      const result = spawnSync(process.execPath, [join(root, 'scripts/run-with-env.mjs'), process.execPath, '-e', probe], {
        cwd: fixture, env, encoding: 'utf8', timeout: 10000,
      });
      assert.equal(result.status, 0, 'child must exit successfully');
      assert.equal(result.stdout, 'true', 'effective key must match expected precedence; values are never reported');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

for (const path of ['deploy/start.ps1', 'start.ps1']) {
  test(`${path}: old key participates in existing fallback before stopping service`, () => {
    const source = readFileSync(join(root, path), 'utf8');
    const startup = source.slice(source.indexOf('$appRoot = Resolve-AppRoot'));
    const stop = startup.indexOf('Stop-PidFileProcess -PidFile');
    assert.ok(stop > 0);
    const beforeStop = startup.slice(0, stop);
    const credentialNames = beforeStop.match(/\$changeStorageCredentialNames = @\(([\s\S]*?)\)/);
    const userNames = beforeStop.match(/Import-UserEnvironmentFallback -Names @\(([\s\S]*?)\)/);
    assert.ok(credentialNames?.[1].includes(`'${name}'`), 'existing dotenv fallback must include old key');
    assert.ok(userNames?.[1].includes(`'${name}'`), 'existing Windows fallback must include old key');
    assert.ok(beforeStop.includes('verify-contract-storage-startup.mjs'), 'readonly candidate gate must run before stopping service');
    assert.ok(beforeStop.includes('Contract storage read-only preflight failed'), 'gate failure must exit before stopping service');
  });
}

test('PowerShell 5 fallback preserves inherited key across blank files and applies nonempty local override', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'nt-contract-ps-key-'));
  try {
    const blank = join(fixture, 'blank.env');
    const local = join(fixture, 'local.env');
    writeFileSync(blank, `${name}=   `);
    writeFileSync(local, `${name}=${configured}`);
    const literal = (value) => `'${value.replaceAll("'", "''")}'`;
    const probe = [
      "$ErrorActionPreference = 'Stop'",
      `$tokens = $null; $errors = $null; $ast = [System.Management.Automation.Language.Parser]::ParseFile(${literal(join(root, 'deploy/start.ps1'))}, [ref]$tokens, [ref]$errors)`,
      "if ($errors.Count -ne 0) { throw 'launcher syntax invalid' }",
      "foreach ($functionName in @('Import-UserEnvironmentFallback','Get-DotEnvValue','Import-DotEnvCredentialFallback')) {",
      '  $f = $ast.FindAll({param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $true) | Where-Object Name -eq $functionName',
      '  Invoke-Expression $f.Extent.Text',
      '}',
      `$before = $env:${name}`,
      `Import-UserEnvironmentFallback -Names @('${name}')`,
      `Import-DotEnvCredentialFallback -FilePath ${literal(blank)} -Names @('${name}')`,
      `$preserved = $env:${name} -ceq $before`,
      `Import-DotEnvCredentialFallback -FilePath ${literal(local)} -Names @('${name}')`,
      `$overridden = $env:${name} -ceq $env:NT_TEST_EXPECTED_KEY`,
      "[Console]::Write(($preserved -and $overridden).ToString().ToLowerInvariant())",
    ].join('\n');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(probe, 'utf16le').toString('base64')], {
      cwd: fixture, env: { ...process.env, [name]: inherited, NT_TEST_EXPECTED_KEY: configured }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, 'actual PowerShell helper must succeed');
    assert.equal(result.stdout, 'true', 'real helper preserves blanks and existing override priority');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
