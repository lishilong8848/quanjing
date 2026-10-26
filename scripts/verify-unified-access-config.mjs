import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_HASH_NAMES = [
  'LOCAL_ADMIN_PASSWORD_HASH',
  'LOCAL_EDITOR_PASSWORD_HASH',
];
const INVENTORY_HASH_NAMES = ['A', 'B', 'C', 'D', 'E', 'H'].map(
  (building) => `LOCAL_INVENTORY_ADMIN_${building}_PASSWORD_HASH`,
);
const PURCHASE_HASH_NAMES = [
  'LOCAL_PURCHASE_ADMIN_PASSWORD_HASH',
  ...['A', 'B', 'C', 'D', 'E', 'H'].map(
    (building) => `LOCAL_PURCHASE_APPLICANT_${building}_PASSWORD_HASH`,
  ),
];
const CONSTRUCTION_HASH_NAMES = ['LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH'];

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main();
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const values = new Map();
  loadEnvironmentFile(joinRoot(options.root, '.env'), values);
  loadEnvironmentFile(joinRoot(options.root, '.env.local'), values);

  const sessionSecret =
    values.get('LOCAL_ACCESS_SESSION_SECRET') ||
    values.get('LOCAL_ADMIN_SESSION_SECRET') ||
    '';
  const sessionConfigured = isStrictBase64Length(sessionSecret, 32);
  const result = {
    coreConfigured:
      sessionConfigured &&
      CORE_HASH_NAMES.every((name) => isScryptHash(values.get(name) || '')),
    inventoryConfigured:
      sessionConfigured &&
      INVENTORY_HASH_NAMES.every((name) =>
        isScryptHash(values.get(name) || ''),
      ),
    purchaseConfigured:
      sessionConfigured &&
      PURCHASE_HASH_NAMES.every((name) =>
        isScryptHash(values.get(name) || ''),
      ),
    constructionConfigured:
      sessionConfigured &&
      CONSTRUCTION_HASH_NAMES.every((name) =>
        isScryptHash(values.get(name) || ''),
      ),
  };

  process.stdout.write(JSON.stringify(result));
  const incomplete = Object.values(result).some((configured) => !configured);
  if (!options.reportOnly && incomplete) {
    process.exitCode = 1;
  }
}

function parseArguments(args) {
  let root = process.cwd();
  let reportOnly = false;
  for (const argument of args) {
    if (argument.startsWith('--root=')) {
      root = argument.slice('--root='.length).trim();
      continue;
    }
    if (argument === '--report-only') {
      reportOnly = true;
      continue;
    }
    throw new Error('Unsupported verifier argument.');
  }
  if (!root) throw new Error('Application root is required.');
  return { root: resolve(root), reportOnly };
}

function joinRoot(root, name) {
  return resolve(root, name);
}

function loadEnvironmentFile(path, target) {
  if (!existsSync(path)) return;
  const source = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match) continue;
    target.set(match[1], parseValue(match[2]));
  }
}

function parseValue(raw) {
  const value = raw.trim();
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.at(-1) === quote) {
      return value.slice(1, -1);
    }
  }
  return value.replace(/\s+#.*$/, '').trim();
}

function isScryptHash(value) {
  const parts = String(value || '').split('$');
  return (
    parts.length === 3 &&
    parts[0] === 'scrypt' &&
    isStrictBase64AtLeast(parts[1], 16) &&
    isStrictBase64Length(parts[2], 32)
  );
}

function isStrictBase64AtLeast(value, minimumLength) {
  const decoded = decodeStrictBase64(value);
  return Boolean(decoded && decoded.length >= minimumLength);
}

function isStrictBase64Length(value, length) {
  const decoded = decodeStrictBase64(value);
  return Boolean(decoded && decoded.length === length);
}

function decodeStrictBase64(value) {
  const candidate = String(value || '');
  if (
    !candidate ||
    candidate.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      candidate,
    )
  ) {
    return null;
  }
  try {
    const decoded = Buffer.from(candidate, 'base64');
    return decoded.toString('base64') === candidate ? decoded : null;
  } catch {
    return null;
  }
}
