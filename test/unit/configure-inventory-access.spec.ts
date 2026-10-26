import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const nodeScript = resolve('scripts/configure-inventory-access.mjs');
const powerShellScript = resolve('scripts/configure-inventory-access.ps1');
const setupNames = [
  'LOCAL_INVENTORY_ADMIN_A_SETUP_PASSWORD',
  'LOCAL_INVENTORY_ADMIN_B_SETUP_PASSWORD',
  'LOCAL_INVENTORY_ADMIN_C_SETUP_PASSWORD',
  'LOCAL_INVENTORY_ADMIN_D_SETUP_PASSWORD',
  'LOCAL_INVENTORY_ADMIN_E_SETUP_PASSWORD',
  'LOCAL_INVENTORY_ADMIN_H_SETUP_PASSWORD',
] as const;
const hashNames = [
  'LOCAL_INVENTORY_ADMIN_A_PASSWORD_HASH',
  'LOCAL_INVENTORY_ADMIN_B_PASSWORD_HASH',
  'LOCAL_INVENTORY_ADMIN_C_PASSWORD_HASH',
  'LOCAL_INVENTORY_ADMIN_D_PASSWORD_HASH',
  'LOCAL_INVENTORY_ADMIN_E_PASSWORD_HASH',
  'LOCAL_INVENTORY_ADMIN_H_PASSWORD_HASH',
] as const;

describe('inventory access deployment configuration', () => {
  let directory = '';

  afterEach(() => {
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
      directory = '';
    }
  });

  it('writes six random hashes without changing existing unified access values', () => {
    directory = mkdtempSync(join(tmpdir(), 'inventory-access-config-'));
    const envPath = join(directory, '.env');
    const sessionSecret = Buffer.alloc(32, 7).toString('base64');
    writeFileSync(
      envPath,
      [
        'UNRELATED_VALUE=keep-me',
        'LOCAL_ADMIN_PASSWORD_HASH=keep-admin',
        `LOCAL_ACCESS_SESSION_SECRET=${sessionSecret}`,
        '',
      ].join('\r\n'),
      'utf8',
    );
    const setupValues = buildSetupValues();

    const result = runNode(envPath, setupValues);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      target: 'env',
      configuredPasswordHashCount: 6,
    });
    const updated = readFileSync(envPath, 'utf8');
    expect(updated).toContain('LOCAL_ADMIN_PASSWORD_HASH=keep-admin');
    expect(updated).toContain(`LOCAL_ACCESS_SESSION_SECRET=${sessionSecret}`);
    for (const password of Object.values(setupValues)) {
      expect(result.stdout).not.toContain(password);
      expect(updated).not.toContain(password);
    }
    const hashes = hashNames.map((name) => readEnv(updated)[name]);
    expect(new Set(hashes).size).toBe(6);
    hashes.forEach((hash) =>
      expect(hash).toMatch(
        /^scrypt\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/,
      ),
    );
  });

  it('fails closed before changing the environment file for missing or duplicate passwords', () => {
    directory = mkdtempSync(join(tmpdir(), 'inventory-access-config-'));
    const envPath = join(directory, '.env');
    writeFileSync(envPath, 'KEEP=1\n', 'utf8');
    const missing = buildSetupValues();
    missing.LOCAL_INVENTORY_ADMIN_H_SETUP_PASSWORD = '';

    const missingResult = runNode(envPath, missing);

    expect(missingResult.status).not.toBe(0);
    expect(readFileSync(envPath, 'utf8')).toBe('KEEP=1\n');
    const duplicate = buildSetupValues();
    duplicate.LOCAL_INVENTORY_ADMIN_B_SETUP_PASSWORD =
      duplicate.LOCAL_INVENTORY_ADMIN_A_SETUP_PASSWORD;

    const duplicateResult = runNode(envPath, duplicate);

    expect(duplicateResult.status).not.toBe(0);
    expect(duplicateResult.stderr).toContain('must differ');
    expect(readFileSync(envPath, 'utf8')).toBe('KEEP=1\n');
  });

  it('uses hidden prompts, documents every hash, and packages both scripts', () => {
    const wrapper = readFileSync(powerShellScript, 'utf8');
    const packageSource = readFileSync(
      resolve('scripts/create-migration-package.ps1'),
      'utf8',
    );
    const envExample = readFileSync(resolve('.env.example'), 'utf8');

    expect(wrapper.match(/Read-Host[^\r\n]*-AsSecureString/g)).toHaveLength(6);
    setupNames.forEach((name) => {
      expect(wrapper).toContain(name);
      expect(wrapper).toContain(`Remove-Item Env:${name}`);
    });
    expect(wrapper).toContain("& $nodeCommand.Source '--' $nodeScript");
    expect(packageSource).toContain('configure-inventory-access.mjs');
    expect(packageSource).toContain('configure-inventory-access.ps1');
    hashNames.forEach((name) => expect(envExample).toContain(`${name}=`));
  });
});

function buildSetupValues(): Record<(typeof setupNames)[number], string> {
  return Object.fromEntries(
    setupNames.map((name, index) => [name, `inventory-test-input-${index}`]),
  ) as Record<(typeof setupNames)[number], string>;
}

function runNode(
  envPath: string,
  setupValues: Record<(typeof setupNames)[number], string>,
) {
  return spawnSync(
    process.execPath,
    [nodeScript, '--target=env', `--env-file=${envPath}`],
    { encoding: 'utf8', env: { ...process.env, ...setupValues } },
  );
}

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
