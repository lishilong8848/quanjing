import { execFileSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

const ADMIN_SETUP_NAME = 'LOCAL_ADMIN_SETUP_PASSWORD';
const EDITOR_SETUP_NAME = 'LOCAL_EDITOR_SETUP_PASSWORD';
const ACCESS_VALUE_NAMES = [
  'LOCAL_ADMIN_PASSWORD_HASH',
  'LOCAL_EDITOR_PASSWORD_HASH',
  'LOCAL_ACCESS_SESSION_SECRET',
];

const options = parseArguments(process.argv.slice(2));
const adminPassword = readSetupPassword(ADMIN_SETUP_NAME);
const editorPassword = readSetupPassword(EDITOR_SETUP_NAME);
if (adminPassword === editorPassword) {
  throw new Error('Administrator and editor setup passwords must differ.');
}

const values = {
  LOCAL_ADMIN_PASSWORD_HASH: hashPassword(adminPassword),
  LOCAL_EDITOR_PASSWORD_HASH: hashPassword(editorPassword),
  LOCAL_ACCESS_SESSION_SECRET: randomBytes(32).toString('base64'),
};

let preservedExistingEncryptionKey = false;
if (options.target === 'env') {
  const envPath = resolve(options.envFile);
  const source = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  preservedExistingEncryptionKey = Boolean(
    readEnvironmentValue(source, 'CONTRACT_ATTACHMENT_ENCRYPTION_KEY'),
  );
  writeEnvironmentFile(envPath, source, values);
} else {
  if (process.platform !== 'win32') {
    throw new Error('The user environment target requires Windows.');
  }
  preservedExistingEncryptionKey = Boolean(
    readUserEnvironmentValue('CONTRACT_ATTACHMENT_ENCRYPTION_KEY'),
  );
  writeUserEnvironmentValues(values);
}

delete process.env[ADMIN_SETUP_NAME];
delete process.env[EDITOR_SETUP_NAME];

process.stdout.write(
  JSON.stringify({
    target: options.target,
    adminPasswordHashConfigured: isScryptHash(values.LOCAL_ADMIN_PASSWORD_HASH),
    editorPasswordHashConfigured: isScryptHash(
      values.LOCAL_EDITOR_PASSWORD_HASH,
    ),
    sessionKeyBytes: Buffer.from(values.LOCAL_ACCESS_SESSION_SECRET, 'base64')
      .length,
    preservedExistingEncryptionKey,
  }),
);

function parseArguments(args) {
  let target = 'user';
  let envFile = '.env';
  for (const argument of args) {
    if (argument.startsWith('--target=')) {
      target = argument.slice('--target='.length).trim().toLowerCase();
      continue;
    }
    if (argument.startsWith('--env-file=')) {
      envFile = argument.slice('--env-file='.length).trim();
      continue;
    }
    throw new Error(`Unsupported argument: ${argument}`);
  }
  if (target !== 'user' && target !== 'env') {
    throw new Error('Target must be user or env.');
  }
  if (target === 'env' && !envFile) {
    throw new Error('An env file path is required for the env target.');
  }
  return { target, envFile };
}

function readSetupPassword(name) {
  const value = String(process.env[name] || '');
  if (!value) throw new Error(`${name} is required for one-time setup.`);
  if (value.length > 256) throw new Error(`${name} is too long.`);
  return value;
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function isScryptHash(value) {
  return /^scrypt\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function writeEnvironmentFile(path, source, nextValues) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = /\r?\n$/.test(source);
  const lines = source ? source.split(/\r?\n/) : [];
  if (hadTrailingNewline) lines.pop();

  for (const name of ACCESS_VALUE_NAMES) {
    const prefix = `${name}=`;
    const indexes = [];
    lines.forEach((line, index) => {
      if (line.startsWith(prefix)) indexes.push(index);
    });
    if (indexes.length) {
      lines[indexes[0]] = `${prefix}${nextValues[name]}`;
      for (let index = indexes.length - 1; index >= 1; index -= 1) {
        lines.splice(indexes[index], 1);
      }
    } else {
      lines.push(`${prefix}${nextValues[name]}`);
    }
  }

  const updated = `${lines.join(newline)}${newline}`;
  const suffix = `${process.pid}.${randomBytes(6).toString('hex')}`;
  const temporaryPath = `${path}.${suffix}.tmp`;
  const backupPath = `${path}.${suffix}.bak`;
  let originalMoved = false;
  let replacementInstalled = false;
  try {
    writeFileSync(temporaryPath, updated, { encoding: 'utf8', mode: 0o600 });
    if (existsSync(path)) {
      renameSync(path, backupPath);
      originalMoved = true;
    }
    renameSync(temporaryPath, path);
    replacementInstalled = true;
    rmSync(backupPath, { force: true });
  } catch (error) {
    try {
      if (originalMoved && !replacementInstalled && !existsSync(path)) {
        renameSync(backupPath, path);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Failed to replace the environment file and restore its backup.',
      );
    }
    throw error;
  } finally {
    rmSync(temporaryPath, { force: true });
    if (replacementInstalled) rmSync(backupPath, { force: true });
  }
}

function readEnvironmentValue(source, name) {
  const prefix = `${name}=`;
  const matching = source
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix));
  return matching.at(-1)?.slice(prefix.length).trim() || '';
}

function readUserEnvironmentValue(name) {
  try {
    const output = execFileSync(
      'reg.exe',
      ['query', 'HKCU\\Environment', '/v', name],
      { encoding: 'utf8', windowsHide: true },
    );
    const line = output
      .split(/\r?\n/)
      .find(
        (candidate) => candidate.includes(name) && candidate.includes('REG_SZ'),
      );
    return line?.split(/REG_SZ\s+/)[1]?.trim() || '';
  } catch {
    return '';
  }
}

function writeUserEnvironmentValues(nextValues) {
  const script = [
    '$values = [Console]::In.ReadToEnd() | ConvertFrom-Json',
    'foreach ($entry in $values.PSObject.Properties) {',
    '  [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, [EnvironmentVariableTarget]::User)',
    '}',
  ].join('; ');
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        input: JSON.stringify(nextValues),
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
      },
    );
  } catch {
    throw new Error('Failed to store unified access configuration.');
  }
}
