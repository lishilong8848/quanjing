import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  PASSWORD_HASH_NAMES,
  PASSWORD_INPUT_NAMES,
  parsePasswordFile,
  preparePasswordHashes,
  readEnvironmentHashes,
  writeEnvironmentFile,
  writeEnvironmentFileWithLocalOverrides,
} from '../../scripts/reset-all-access-passwords.mjs';

test('resets every role with unique hashes while preserving unrelated config', () => {
  const passwords = Object.fromEntries(PASSWORD_HASH_NAMES.map((name, index) => [
    `RESET_${name}`,
    `test-only-access-${index}-unique`,
  ]));
  const values = preparePasswordHashes(passwords);
  assert.equal(Object.keys(values).length, PASSWORD_HASH_NAMES.length);
  assert.equal(new Set(Object.values(values)).size, PASSWORD_HASH_NAMES.length);
  const directory = mkdtempSync(join(tmpdir(), 'access-password-reset-'));
  const path = join(directory, '.env');
  try {
    writeFileSync(path, 'OTHER_SETTING=retained\nLOCAL_ADMIN_PASSWORD_HASH=old\n');
    writeEnvironmentFile(path, values);
    const result = readFileSync(path, 'utf8');
    assert.match(result, /^OTHER_SETTING=retained$/m);
    assert.doesNotMatch(result, /LOCAL_ADMIN_PASSWORD_HASH=old/);
    for (const name of PASSWORD_HASH_NAMES) {
      assert.match(result, new RegExp(`^${name}=scrypt\\$`, 'm'));
    }
    assert.doesNotMatch(result, /test-only-access-/);
    assert.equal(new Set(PASSWORD_HASH_NAMES).size, 22);
    assert.throws(() => preparePasswordHashes({
      ...passwords,
      [`RESET_${PASSWORD_HASH_NAMES[1]}`]: passwords[`RESET_${PASSWORD_HASH_NAMES[0]}`],
    }), /different password/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('p.txt template covers every role and rejects incomplete or duplicate input', () => {
  const template = readFileSync(join(import.meta.dirname, '../../scripts/p.example.txt'), 'utf8');
  assert.equal(PASSWORD_INPUT_NAMES.length, 22);
  for (const name of PASSWORD_INPUT_NAMES) {
    assert.equal(template.split(/\r?\n/).filter((line) => line === `${name}=`).length, 1);
  }
  assert.throws(() => parsePasswordFile(template), /LOCAL_ADMIN_PASSWORD=（当前 0 位）/);
  assert.throws(() => parsePasswordFile(template.replace(`${PASSWORD_INPUT_NAMES[0]}=`, '')), /p\.txt 缺少 LOCAL_ADMIN_PASSWORD=/);
  assert.throws(() => parsePasswordFile(`${template}\n${PASSWORD_INPUT_NAMES[0]}=123456\n`), /p\.txt 中 LOCAL_ADMIN_PASSWORD= 重复出现/);
  assert.throws(() => parsePasswordFile(`${template}\nUNKNOWN_ROLE=123456\n`), /p\.txt 第 .* 行字段无效/);
});

test('imports all passwords from p.txt only after full validation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'access-password-import-'));
  const envFile = join(directory, '.env');
  const localFile = join(directory, '.env.local');
  const passwordFile = join(directory, 'p.txt');
  const script = join(import.meta.dirname, '../../scripts/reset-all-access-passwords.mjs');
  const template = readFileSync(join(import.meta.dirname, '../../scripts/p.example.txt'), 'utf8');
  const completed = template.split(/\r?\n/).map((line) => {
    const index = PASSWORD_INPUT_NAMES.findIndex((name) => line === `${name}=`);
    return index < 0 ? line : `${PASSWORD_INPUT_NAMES[index]}=test-only-${String(index).padStart(2, '0')}`;
  }).join('\n');
  try {
    writeFileSync(envFile, 'OTHER_SETTING=retained\nLOCAL_ADMIN_PASSWORD_HASH=old\n');
    const originalLocal = 'LOCAL_ACCESS_SESSION_SECRET=retained\nLOCAL_ADMIN_PASSWORD_HASH=old-local\n';
    writeFileSync(localFile, originalLocal);
    const args = [script, '--target=env', `--env-file=${envFile}`, `--password-file=${passwordFile}`];
    const missing = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(missing.status, 0);
    assert.equal(readFileSync(envFile, 'utf8'), 'OTHER_SETTING=retained\nLOCAL_ADMIN_PASSWORD_HASH=old\n');
    assert.equal(readFileSync(localFile, 'utf8'), originalLocal);
    writeFileSync(passwordFile, template);
    const invalid = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /LOCAL_ADMIN_PASSWORD=（当前 0 位）/);
    assert.doesNotMatch(invalid.stderr, /\bat file:|ModuleJob\.run/);
    assert.equal(readFileSync(envFile, 'utf8'), 'OTHER_SETTING=retained\nLOCAL_ADMIN_PASSWORD_HASH=old\n');
    assert.equal(readFileSync(localFile, 'utf8'), originalLocal);
    writeFileSync(passwordFile, completed.replace('LOCAL_EDITOR_PASSWORD=test-only-01', 'LOCAL_EDITOR_PASSWORD=test-only-00'));
    const duplicate = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /LOCAL_ADMIN_PASSWORD= 与 LOCAL_EDITOR_PASSWORD= 的密码相同/);
    assert.doesNotMatch(duplicate.stderr, /test-only-/);
    assert.equal(readFileSync(envFile, 'utf8'), 'OTHER_SETTING=retained\nLOCAL_ADMIN_PASSWORD_HASH=old\n');
    assert.equal(readFileSync(localFile, 'utf8'), originalLocal);
    writeFileSync(passwordFile, completed);
    const imported = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
    assert.equal(imported.status, 0, `${imported.stdout}${imported.stderr}`);
    assert.deepEqual(JSON.parse(imported.stdout), { target: 'env', configuredRoleCount: 22, clearedLocalOverrides: 1 });
    assert.doesNotMatch(`${imported.stdout}${imported.stderr}`, /test-only-/);
    const updated = readFileSync(envFile, 'utf8');
    assert.match(updated, /^OTHER_SETTING=retained$/m);
    assert.doesNotMatch(updated, /LOCAL_ADMIN_PASSWORD_HASH=old/);
    for (const name of PASSWORD_HASH_NAMES) assert.match(updated, new RegExp(`^${name}=scrypt\\$`, 'm'));
    assert.equal(readFileSync(localFile, 'utf8'), 'LOCAL_ACCESS_SESSION_SECRET=retained\n');
    assert.equal(readFileSync(passwordFile, 'utf8'), completed);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reset removes only shadowing hashes from .env.local', () => {
  const directory = mkdtempSync(join(tmpdir(), 'access-password-local-'));
  const envFile = join(directory, '.env');
  const localFile = join(directory, '.env.local');
  const selected = PASSWORD_HASH_NAMES[0];
  const other = PASSWORD_HASH_NAMES[1];
  const values = preparePasswordHashes({ [`RESET_${selected}`]: '123456' }, [selected]);
  const originalLocal = `LOCAL_ACCESS_SESSION_SECRET=retained\r\n${selected}=old\r\n${other}=unchanged\r\nOTHER_SETTING=retained\r\n`;
  try {
    writeFileSync(envFile, `${selected}=old-base\n`);
    writeFileSync(localFile, originalLocal);
    assert.equal(writeEnvironmentFileWithLocalOverrides(envFile, values), 1);
    assert.match(readFileSync(envFile, 'utf8'), new RegExp(`^${selected}=scrypt\\$`, 'm'));
    assert.equal(readFileSync(localFile, 'utf8'), `LOCAL_ACCESS_SESSION_SECRET=retained\r\n${other}=unchanged\r\nOTHER_SETTING=retained\r\n`);
    assert.deepEqual(readdirSync(directory).sort(), ['.env', '.env.local']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('single-role reset checks passwords against effective .env.local hashes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'access-password-effective-'));
  const envFile = join(directory, '.env');
  const localFile = join(directory, '.env.local');
  const script = join(import.meta.dirname, '../../scripts/reset-all-access-passwords.mjs');
  const selected = PASSWORD_HASH_NAMES[0];
  const other = PASSWORD_HASH_NAMES[1];
  const otherHash = preparePasswordHashes({ [`RESET_${other}`]: '654321' }, [other])[other];
  const base = `${selected}=old\n`;
  const local = `${other}=${otherHash}\n`;
  try {
    writeFileSync(envFile, base);
    writeFileSync(localFile, local);
    const result = spawnSync(process.execPath, [script, '--target=env', `--env-file=${envFile}`, `--role=${selected}`], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, [`RESET_${selected}`]: '654321' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /matches another role/);
    assert.equal(readFileSync(envFile, 'utf8'), base);
    assert.equal(readFileSync(localFile, 'utf8'), local);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reset restores both files when replacing .env.local fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'access-password-rollback-'));
  const envFile = join(directory, '.env');
  const localFile = join(directory, '.env.local');
  const selected = PASSWORD_HASH_NAMES[0];
  const base = `${selected}=old-base\n`;
  const local = `${selected}=old-local\nOTHER_SETTING=retained\n`;
  const values = preparePasswordHashes({ [`RESET_${selected}`]: '123456' }, [selected]);
  try {
    writeFileSync(envFile, base);
    writeFileSync(localFile, local);
    assert.throws(() => writeEnvironmentFileWithLocalOverrides(envFile, values, (from, to) => {
      if (from.includes('.env.local.') && from.endsWith('.tmp')) throw new Error('simulated rename failure');
      renameSync(from, to);
    }), /simulated rename failure/);
    assert.equal(readFileSync(envFile, 'utf8'), base);
    assert.equal(readFileSync(localFile, 'utf8'), local);
    assert.deepEqual(readdirSync(directory).sort(), ['.env', '.env.local']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('server repair preserves unrelated .env.local settings and keeps a byte-for-byte backup', () => {
  if (process.platform !== 'win32') return;
  const directory = mkdtempSync(join(tmpdir(), 'access-password-repair-'));
  const envFile = join(directory, '.env');
  const localFile = join(directory, '.env.local');
  const script = join(import.meta.dirname, '../../scripts/repair-local-password-overrides.ps1');
  const powerShell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const values = preparePasswordHashes(Object.fromEntries(PASSWORD_HASH_NAMES.map((name, index) => [
    `RESET_${name}`, `test-only-${index}`,
  ])));
  const originalLocal = Buffer.from(`LOCAL_ACCESS_SESSION_SECRET=retained\r\n${PASSWORD_HASH_NAMES[0]}=old\r\nOTHER_SETTING=retained\r\n`, 'utf8');
  try {
    writeFileSync(envFile, Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n'));
    writeFileSync(localFile, originalLocal);
    const run = spawnSync(powerShell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-AppRoot', directory,
    ], { encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.equal(readFileSync(localFile, 'utf8'), 'LOCAL_ACCESS_SESSION_SECRET=retained\r\nOTHER_SETTING=retained\r\n');
    const backup = readdirSync(directory).find((name) => name.startsWith('.env.local.password-backup-'));
    assert.ok(backup);
    assert.deepEqual(readFileSync(join(directory, backup)), originalLocal);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('resets one role with a six-digit password without changing other roles', () => {
  const directory = mkdtempSync(join(tmpdir(), 'access-password-single-'));
  const path = join(directory, '.env');
  const selected = PASSWORD_HASH_NAMES[0];
  const other = PASSWORD_HASH_NAMES[1];
  const otherHash = preparePasswordHashes({ [`RESET_${other}`]: '654321' }, [other])[other];
  try {
    writeFileSync(path, `OTHER_SETTING=retained\n${selected}=old\n${other}=${otherHash}\n`);
    const hashes = readEnvironmentHashes(path);
    const values = preparePasswordHashes({ [`RESET_${selected}`]: '123456' }, [selected], hashes);
    writeEnvironmentFile(path, values);
    const result = readFileSync(path, 'utf8');
    assert.match(result, /^OTHER_SETTING=retained$/m);
    assert.ok(result.split(/\r?\n/).includes(`${other}=${otherHash}`));
    assert.match(result, new RegExp(`^${selected}=scrypt\\$`, 'm'));
    assert.doesNotMatch(result, /^LOCAL_PURCHASE_ADMIN_PASSWORD_HASH=/m);
    assert.throws(() => preparePasswordHashes({ [`RESET_${selected}`]: '654321' }, [selected], hashes), /matches another role/);
    assert.throws(() => preparePasswordHashes({ [`RESET_${selected}`]: '12345' }, [selected], hashes), /invalid reset password/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('formal hotfix includes all three interactive password reset files', () => {
  const releaseTool = readFileSync(join(import.meta.dirname, '../../scripts/create-safe-full-runtime-hotfix-package.ps1'), 'utf8');
  const baselineExporter = readFileSync(join(import.meta.dirname, '../../scripts/export-server-hotfix-baseline.ps1'), 'utf8');
  for (const extension of ['cmd', 'ps1', 'mjs']) {
    const path = `scripts/reset-all-access-passwords.${extension}`;
    assert.ok(releaseTool.includes(`'${path}' = '${path}'`), `${path} is missing from the release files`);
    assert.ok(baselineExporter.includes(`'${path}'`), `${path} is missing from future server baseline exports`);
  }
  assert.ok(!releaseTool.includes("'scripts/p.txt'"), 'plaintext p.txt must never enter a release package');
});

test('interactive menu selects the independent 110 station role with a six-digit numeric password', () => {
  if (process.platform !== 'win32') return;
  const directory = mkdtempSync(join(tmpdir(), 'access-password-menu-'));
  const envFile = join(directory, '.env');
  const powerShell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    writeFileSync(envFile, 'OTHER_SETTING=retained\n');
    const script = join(import.meta.dirname, '../../scripts/reset-all-access-passwords.ps1');
    const command = `function Read-Host { param([string]$Prompt, [switch]$AsSecureString) if ($AsSecureString) { ConvertTo-SecureString '123456' -AsPlainText -Force } else { '22' } }; & '${script}' -EnvFile '${envFile}'`;
    const result = spawnSync(powerShell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const updated = readFileSync(envFile, 'utf8');
    assert.match(updated, /^OTHER_SETTING=retained$/m);
    assert.match(updated, /^LOCAL_BUILDING_ADMIN_110_PASSWORD_HASH=scrypt\$/m);
    assert.doesNotMatch(updated, /^LOCAL_ADMIN_PASSWORD_HASH=/m);
    assert.doesNotMatch(updated, /^LOCAL_EDITOR_PASSWORD_HASH=/m);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the existing menu imports p.txt from the same directory', () => {
  if (process.platform !== 'win32') return;
  const directory = mkdtempSync(join(tmpdir(), 'access-password-menu-import-'));
  const scriptDirectory = join(directory, 'scripts');
  const envFile = join(directory, '.env');
  const passwordFile = join(scriptDirectory, 'p.txt');
  const powerShell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    mkdirSync(scriptDirectory);
    for (const extension of ['ps1', 'mjs']) {
      copyFileSync(
        join(import.meta.dirname, `../../scripts/reset-all-access-passwords.${extension}`),
        join(scriptDirectory, `reset-all-access-passwords.${extension}`),
      );
    }
    writeFileSync(envFile, 'OTHER_SETTING=retained\n');
    const script = join(scriptDirectory, 'reset-all-access-passwords.ps1');
    const command = `function Read-Host { '23' }; & '${script}' -EnvFile '${envFile}'`;
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command];
    const template = readFileSync(join(import.meta.dirname, '../../scripts/p.example.txt'), 'utf8');
    const completed = template.split(/\r?\n/).map((line) => {
      const index = PASSWORD_INPUT_NAMES.findIndex((name) => line === `${name}=`);
      return index < 0 ? line : `${PASSWORD_INPUT_NAMES[index]}=test-only-${String(index).padStart(2, '0')}`;
    }).join('\n');
    writeFileSync(passwordFile, completed);
    const imported = spawnSync(powerShell, args, { encoding: 'utf8', timeout: 30000 });
    assert.equal(imported.status, 0, `${imported.stdout}${imported.stderr}`);
    assert.doesNotMatch(`${imported.stdout}${imported.stderr}`, /test-only-/);
    const updated = readFileSync(envFile, 'utf8');
    assert.match(updated, /^LOCAL_BUILDING_ADMIN_110_PASSWORD_HASH=scrypt\$/m);
    assert.match(updated, /^OTHER_SETTING=retained$/m);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('password reset rejects missing Node before prompting or changing the environment file', () => {
  if (process.platform !== 'win32') return;
  const directory = mkdtempSync(join(tmpdir(), 'access-password-reset-node-'));
  const envFile = join(directory, '.env');
  const powerShell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    writeFileSync(envFile, 'LOCAL_ADMIN_PASSWORD_HASH=original\n');
    const result = spawnSync(powerShell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      join(import.meta.dirname, '../../scripts/reset-all-access-passwords.ps1'),
      '-EnvFile', envFile,
    ], {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        PATH: '',
        ProgramFiles: directory,
        'ProgramFiles(x86)': directory,
        LOCALAPPDATA: directory,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /Node\.js 24 or newer is required/);
    assert.equal(readFileSync(envFile, 'utf8'), 'LOCAL_ADMIN_PASSWORD_HASH=original\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
