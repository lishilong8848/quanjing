import { execFileSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';

if (process.platform !== 'win32') {
  throw new Error('This local security setup script requires Windows.');
}

const password = process.env.LOCAL_ADMIN_SETUP_PASSWORD || '';
if (!password) {
  throw new Error('LOCAL_ADMIN_SETUP_PASSWORD is required for one-time setup.');
}

const salt = randomBytes(16);
const existing = Object.fromEntries(
  [
    'LOCAL_ADMIN_PASSWORD_HASH',
    'LOCAL_ADMIN_SESSION_SECRET',
    'CONTRACT_ATTACHMENT_ENCRYPTION_KEY',
  ].map((name) => [name, readUserEnvironmentValue(name)]),
);
const values = {
  LOCAL_ADMIN_PASSWORD_HASH:
    existing.LOCAL_ADMIN_PASSWORD_HASH ||
    `scrypt$${salt.toString('base64')}$${scryptSync(password, salt, 32).toString('base64')}`,
  LOCAL_ADMIN_SESSION_SECRET:
    existing.LOCAL_ADMIN_SESSION_SECRET || randomBytes(32).toString('base64'),
  CONTRACT_ATTACHMENT_ENCRYPTION_KEY:
    existing.CONTRACT_ATTACHMENT_ENCRYPTION_KEY ||
    randomBytes(32).toString('base64'),
};

for (const [name, value] of Object.entries(values)) {
  if (existing[name]) continue;
  execFileSync(
    'reg.exe',
    ['add', 'HKCU\\Environment', '/v', name, '/t', 'REG_SZ', '/d', value, '/f'],
    { stdio: 'ignore', windowsHide: true },
  );
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

process.stdout.write(
  JSON.stringify({
    passwordHashConfigured:
      values.LOCAL_ADMIN_PASSWORD_HASH.startsWith('scrypt$'),
    sessionKeyBytes: Buffer.from(values.LOCAL_ADMIN_SESSION_SECRET, 'base64')
      .length,
    encryptionKeyBytes: Buffer.from(
      values.CONTRACT_ATTACHMENT_ENCRYPTION_KEY,
      'base64',
    ).length,
    preservedExistingEncryptionKey: Boolean(
      existing.CONTRACT_ATTACHMENT_ENCRYPTION_KEY,
    ),
  }),
);
