import { randomBytes, scryptSync } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

const SETUP_PASSWORD_NAME = 'LOCAL_CONSTRUCTION_ADMIN_SETUP_PASSWORD';
const PASSWORD_HASH_NAME = 'LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH';

try {
  const options = parseArguments(process.argv.slice(2));
  const password = readSetupPassword();
  const passwordHash = hashPassword(password);
  const envPath = resolve(options.envFile);
  const source = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';

  writeEnvironmentFile(envPath, source, passwordHash);
  process.stdout.write(
    JSON.stringify({
      target: 'env',
      constructionAdminPasswordHashConfigured: isScryptHash(passwordHash),
    }),
  );
} finally {
  delete process.env[SETUP_PASSWORD_NAME];
}

function parseArguments(args) {
  let target = 'env';
  let envFile = '.env';
  for (const argument of args) {
    if (argument.startsWith('--target=')) {
      target = argument.slice('--target='.length).trim().toLowerCase();
      continue;
    }
    if (argument.startsWith('--output-env-file=')) {
      envFile = argument.slice('--output-env-file='.length).trim();
      continue;
    }
    throw new Error(`Unsupported argument: ${argument}`);
  }
  if (target !== 'env') {
    throw new Error('Construction access configuration supports only env target.');
  }
  if (!envFile) throw new Error('An env file path is required.');
  return { envFile };
}

function readSetupPassword() {
  const value = String(process.env[SETUP_PASSWORD_NAME] || '');
  if (!value) {
    throw new Error(`${SETUP_PASSWORD_NAME} is required for one-time setup.`);
  }
  if (value.length > 256) throw new Error(`${SETUP_PASSWORD_NAME} is too long.`);
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

function writeEnvironmentFile(path, source, passwordHash) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = /\r?\n$/.test(source);
  const lines = source ? source.split(/\r?\n/) : [];
  if (hadTrailingNewline) lines.pop();

  const prefix = `${PASSWORD_HASH_NAME}=`;
  const indexes = [];
  lines.forEach((line, index) => {
    if (line.startsWith(prefix)) indexes.push(index);
  });
  if (indexes.length) {
    lines[indexes[0]] = `${prefix}${passwordHash}`;
    for (let index = indexes.length - 1; index >= 1; index -= 1) {
      lines.splice(indexes[index], 1);
    }
  } else {
    lines.push(`${prefix}${passwordHash}`);
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
