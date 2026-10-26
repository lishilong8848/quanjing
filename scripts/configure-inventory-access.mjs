import { randomBytes, scryptSync } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INVENTORY_ACCESS_FIELDS = ['A', 'B', 'C', 'D', 'E', 'H'].map(
  (building) => ({
    setupName: `LOCAL_INVENTORY_ADMIN_${building}_SETUP_PASSWORD`,
    hashName: `LOCAL_INVENTORY_ADMIN_${building}_PASSWORD_HASH`,
  }),
);

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main();
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const passwords = INVENTORY_ACCESS_FIELDS.map(({ setupName }) =>
    readSetupPassword(setupName),
  );
  if (new Set(passwords).size !== passwords.length) {
    throw new Error('Inventory administrator passwords must differ.');
  }

  const values = Object.fromEntries(
    INVENTORY_ACCESS_FIELDS.map(({ hashName }, index) => [
      hashName,
      hashPassword(passwords[index]),
    ]),
  );
  const envPath = resolve(options.envFile);
  const source = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  writeEnvironmentFile(envPath, source, values);

  for (const { setupName } of INVENTORY_ACCESS_FIELDS) {
    delete process.env[setupName];
  }
  process.stdout.write(
    JSON.stringify({
      target: 'env',
      configuredPasswordHashCount: Object.keys(values).length,
    }),
  );
}

function parseArguments(args) {
  let target = 'env';
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
  if (target !== 'env') {
    throw new Error('Inventory access configuration supports only env target.');
  }
  if (!envFile) throw new Error('An env file path is required.');
  return { envFile };
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

function writeEnvironmentFile(path, source, nextValues) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = /\r?\n$/.test(source);
  const lines = source ? source.split(/\r?\n/) : [];
  if (hadTrailingNewline) lines.pop();

  for (const { hashName } of INVENTORY_ACCESS_FIELDS) {
    const prefix = `${hashName}=`;
    const indexes = [];
    lines.forEach((line, index) => {
      if (line.startsWith(prefix)) indexes.push(index);
    });
    if (indexes.length) {
      lines[indexes[0]] = `${prefix}${nextValues[hashName]}`;
      for (let index = indexes.length - 1; index >= 1; index -= 1) {
        lines.splice(indexes[index], 1);
      }
    } else {
      lines.push(`${prefix}${nextValues[hashName]}`);
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
