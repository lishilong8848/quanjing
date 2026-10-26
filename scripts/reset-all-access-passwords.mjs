import { execFileSync } from 'node:child_process';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PASSWORD_HASH_NAMES = [
  'LOCAL_ADMIN_PASSWORD_HASH',
  'LOCAL_EDITOR_PASSWORD_HASH',
  'LOCAL_PURCHASE_ADMIN_PASSWORD_HASH',
  'LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH',
  ...['A', 'B', 'C', 'D', 'E', 'H'].map((building) => `LOCAL_INVENTORY_ADMIN_${building}_PASSWORD_HASH`),
  ...['A', 'B', 'C', 'D', 'E', 'H'].map((building) => `LOCAL_PURCHASE_APPLICANT_${building}_PASSWORD_HASH`),
  ...['A', 'B', 'C', 'D', 'E', '110'].map((building) => `LOCAL_BUILDING_ADMIN_${building}_PASSWORD_HASH`),
];

export const PASSWORD_INPUT_NAMES = PASSWORD_HASH_NAMES.map((name) => name.slice(0, -5));

export function parsePasswordFile(source) {
  const values = {};
  const allowed = new Set(PASSWORD_INPUT_NAMES);
  for (const [index, line] of source.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const separator = line.indexOf('=');
    const name = line.slice(0, separator).trim();
    if (separator < 1 || !allowed.has(name)) {
      throw new Error(`p.txt 第 ${index + 1} 行字段无效；请保留模板中等号左侧的名称。`);
    }
    if (Object.hasOwn(values, name)) throw new Error(`p.txt 中 ${name}= 重复出现。`);
    values[name] = line.slice(separator + 1);
  }
  const environment = {};
  for (const hashName of PASSWORD_HASH_NAMES) {
    const inputName = hashName.slice(0, -5);
    if (!Object.hasOwn(values, inputName)) throw new Error(`p.txt 缺少 ${inputName}=。`);
    environment[`RESET_${hashName}`] = values[inputName];
  }
  const invalid = PASSWORD_INPUT_NAMES.filter((name) => values[name].length < 6 || values[name].length > 256);
  if (invalid.length) {
    throw new Error(`p.txt 中以下项目的密码未填写或长度不在 6–256 位：${invalid.map((name) => `${name}=（当前 ${values[name].length} 位）`).join('、')}。原配置未改变。`);
  }
  const firstRoleByPassword = new Map();
  for (const name of PASSWORD_INPUT_NAMES) {
    const firstRole = firstRoleByPassword.get(values[name]);
    if (firstRole) {
      throw new Error(`p.txt 中 ${firstRole}= 与 ${name}= 的密码相同；每个角色必须不同。原配置未改变。`);
    }
    firstRoleByPassword.set(values[name], name);
  }
  return environment;
}

export function preparePasswordHashes(
  environment = process.env,
  selectedNames = PASSWORD_HASH_NAMES,
  existingHashes = {},
) {
  if (!Array.isArray(selectedNames) || selectedNames.length === 0 ||
      new Set(selectedNames).size !== selectedNames.length ||
      selectedNames.some((name) => !PASSWORD_HASH_NAMES.includes(name))) {
    throw new Error('Invalid password reset role selection.');
  }
  const passwords = selectedNames.map((name) => {
    const password = environment[`RESET_${name}`];
    if (typeof password !== 'string' || password.length < 6 || password.length > 256) {
      throw new Error(`Missing or invalid reset password for ${name}.`);
    }
    return password;
  });
  if (new Set(passwords).size !== passwords.length) {
    throw new Error('Every access role must use a different password.');
  }
  for (const name of PASSWORD_HASH_NAMES) {
    if (selectedNames.includes(name) || !existingHashes[name]) continue;
    const match = /^scrypt\$([^$]+)\$([^$]+)$/.exec(existingHashes[name]);
    if (!match) throw new Error(`Invalid existing password hash for ${name}.`);
    const salt = Buffer.from(match[1], 'base64');
    const derived = Buffer.from(match[2], 'base64');
    if (salt.length < 16 || derived.length !== 32 ||
        salt.toString('base64') !== match[1] || derived.toString('base64') !== match[2]) {
      throw new Error(`Invalid existing password hash for ${name}.`);
    }
    if (passwords.some((password) => timingSafeEqual(scryptSync(password, salt, 32), derived))) {
      throw new Error('The new password matches another role. Every access role must use a different password.');
    }
  }
  return Object.fromEntries(selectedNames.map((name, index) => {
    const salt = randomBytes(16);
    const derived = scryptSync(passwords[index], salt, 32);
    return [name, `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`];
  }));
}

export function readEnvironmentHashes(path, names = PASSWORD_HASH_NAMES) {
  if (!existsSync(path)) throw new Error('Environment file does not exist.');
  const hashes = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match || !names.includes(match[1])) continue;
    if (Object.hasOwn(hashes, match[1])) throw new Error(`Duplicate password hash setting for ${match[1]}.`);
    const value = match[2].trim();
    hashes[match[1]] = /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return hashes;
}

function readUserHashes() {
  if (process.platform !== 'win32') throw new Error('User environment target requires Windows.');
  const names = PASSWORD_HASH_NAMES.map((name) => `'${name}'`).join(',');
  const script = `$values = @{}; foreach ($name in @(${names})) { $values[$name] = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::User) }; $values | ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }));
}

export function replaceEnvironmentValues(source, values) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/).filter((line, index, all) =>
    index < all.length - 1 || line !== '',
  );
  const names = new Set(Object.keys(values));
  const seen = new Set();
  const replaced = lines.flatMap((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !names.has(match[1])) return [line];
    if (seen.has(match[1])) return [];
    seen.add(match[1]);
    return [`${match[1]}=${values[match[1]]}`];
  });
  for (const name of names) {
    if (!seen.has(name)) replaced.push(`${name}=${values[name]}`);
  }
  return `${replaced.join(newline)}${newline}`;
}

export function removeEnvironmentValues(source, names) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const selected = new Set(names);
  const lines = source.split(/\r?\n/).filter((line, index, all) =>
    index < all.length - 1 || line !== '',
  );
  return `${lines.filter((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    return !match || !selected.has(match[1]);
  }).join(newline)}${newline}`;
}

export function writeEnvironmentFile(path, values) {
  const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const content = replaceEnvironmentValues(source, values);
  const suffix = `${process.pid}.${randomBytes(6).toString('hex')}`;
  const temporary = `${path}.${suffix}.tmp`;
  const backup = `${path}.${suffix}.bak`;
  let moved = false;
  let installed = false;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
    if (existsSync(path)) { renameSync(path, backup); moved = true; }
    renameSync(temporary, path);
    installed = true;
    if (moved) rmSync(backup, { force: true });
  } catch (error) {
    if (moved && !installed && !existsSync(path)) renameSync(backup, path);
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writeEnvironmentFileWithLocalOverrides(envPath, values, renameFile = renameSync, hashNames = PASSWORD_HASH_NAMES) {
  const localPath = resolve(dirname(envPath), '.env.local');
  if (!existsSync(localPath)) {
    writeEnvironmentFile(envPath, values);
    return 0;
  }
  const localHashes = readEnvironmentHashes(localPath, hashNames);
  const shadowedNames = Object.keys(values).filter((name) => Object.hasOwn(localHashes, name));
  if (shadowedNames.length === 0) {
    writeEnvironmentFile(envPath, values);
    return 0;
  }

  const localSource = readFileSync(localPath, 'utf8');
  const envSource = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const suffix = `${process.pid}.${randomBytes(6).toString('hex')}`;
  const stages = [
    { path: envPath, content: replaceEnvironmentValues(envSource, values) },
    { path: localPath, content: removeEnvironmentValues(localSource, shadowedNames) },
  ].map((entry) => ({
    ...entry,
    temporary: `${entry.path}.${suffix}.tmp`,
    backup: `${entry.path}.${suffix}.bak`,
    existed: existsSync(entry.path),
    moved: false,
    installed: false,
  }));
  try {
    for (const stage of stages) {
      writeFileSync(stage.temporary, stage.content, { encoding: 'utf8', mode: 0o600 });
    }
    for (const stage of stages) {
      if (stage.existed) {
        renameFile(stage.path, stage.backup);
        stage.moved = true;
      }
      renameFile(stage.temporary, stage.path);
      stage.installed = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const stage of stages.toReversed()) {
      try {
        if (stage.installed) rmSync(stage.path, { force: true });
        if (stage.moved) renameFile(stage.backup, stage.path);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error('Password reset failed and configuration rollback was incomplete. Keep the .bak files and do not restart the application.', { cause: error });
    }
    throw error;
  } finally {
    for (const stage of stages) rmSync(stage.temporary, { force: true });
  }
  for (const stage of stages) {
    if (!stage.moved) continue;
    try {
      rmSync(stage.backup, { force: true });
    } catch {
      process.stderr.write(`密码已更新，但旧配置备份 ${stage.backup} 清理失败，请确认后手动处理。\n`);
    }
  }
  return shadowedNames.length;
}

function writeUserEnvironment(values) {
  if (process.platform !== 'win32') throw new Error('User environment target requires Windows.');
  const script = [
    '$values = [Console]::In.ReadToEnd() | ConvertFrom-Json',
    '$previous = @{}',
    'foreach ($entry in $values.PSObject.Properties) { $previous[$entry.Name] = [Environment]::GetEnvironmentVariable($entry.Name, [EnvironmentVariableTarget]::User) }',
    'try { foreach ($entry in $values.PSObject.Properties) { [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, [EnvironmentVariableTarget]::User) } }',
    'catch { foreach ($entry in $values.PSObject.Properties) { [Environment]::SetEnvironmentVariable($entry.Name, $previous[$entry.Name], [EnvironmentVariableTarget]::User) }; throw }',
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: JSON.stringify(values), encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true,
  });
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find((arg) => arg.startsWith('--target='))?.slice(9) || 'env';
  const envFile = args.find((arg) => arg.startsWith('--env-file='))?.slice(11) || '.env';
  const role = args.find((arg) => arg.startsWith('--role='))?.slice(7) || 'all';
  const passwordFile = args.find((arg) => arg.startsWith('--password-file='))?.slice(16);
  if (args.some((arg) => !arg.startsWith('--target=') && !arg.startsWith('--env-file=') && !arg.startsWith('--role=') && !arg.startsWith('--password-file='))) {
    throw new Error('Unsupported reset argument.');
  }
  if (target !== 'env' && target !== 'user') throw new Error('Unsupported reset target.');
  if (passwordFile !== undefined && (passwordFile === '' || role !== 'all')) {
    throw new Error('Password file import resets all roles only.');
  }
  const selectedNames = role === 'all' ? PASSWORD_HASH_NAMES : [role];
  const resolvedEnvFile = resolve(envFile);
  const localPath = resolve(dirname(resolvedEnvFile), '.env.local');
  const localHashes = target === 'env' && existsSync(localPath)
    ? readEnvironmentHashes(localPath)
    : {};
  const existingHashes = selectedNames.length === 1
    ? target === 'env' ? { ...readEnvironmentHashes(resolvedEnvFile), ...localHashes } : readUserHashes()
    : {};
  const passwordEnvironment = passwordFile === undefined
    ? process.env
    : parsePasswordFile(readFileSync(resolve(passwordFile), 'utf8'));
  const values = preparePasswordHashes(passwordEnvironment, selectedNames, existingHashes);
  let clearedLocalOverrides = 0;
  if (target === 'env') {
    clearedLocalOverrides = writeEnvironmentFileWithLocalOverrides(resolvedEnvFile, values);
  } else {
    writeUserEnvironment(values);
  }
  for (const name of PASSWORD_HASH_NAMES) delete process.env[`RESET_${name}`];
  process.stdout.write(JSON.stringify({ target, configuredRoleCount: selectedNames.length, clearedLocalOverrides }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : '密码重置失败。'}\n`);
    process.exitCode = 1;
  }
}
