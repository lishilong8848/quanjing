import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const nodeScript = resolve('scripts/configure-purchase-access.mjs');
const powerShellScript = resolve('scripts/configure-purchase-access.ps1');
const setupNames = [
  'LOCAL_PURCHASE_ADMIN_SETUP_PASSWORD',
  'LOCAL_PURCHASE_APPLICANT_A_SETUP_PASSWORD',
  'LOCAL_PURCHASE_APPLICANT_B_SETUP_PASSWORD',
  'LOCAL_PURCHASE_APPLICANT_C_SETUP_PASSWORD',
  'LOCAL_PURCHASE_APPLICANT_D_SETUP_PASSWORD',
  'LOCAL_PURCHASE_APPLICANT_E_SETUP_PASSWORD',
  'LOCAL_PURCHASE_APPLICANT_H_SETUP_PASSWORD',
] as const;
const hashNames = [
  'LOCAL_PURCHASE_ADMIN_PASSWORD_HASH',
  'LOCAL_PURCHASE_APPLICANT_A_PASSWORD_HASH',
  'LOCAL_PURCHASE_APPLICANT_B_PASSWORD_HASH',
  'LOCAL_PURCHASE_APPLICANT_C_PASSWORD_HASH',
  'LOCAL_PURCHASE_APPLICANT_D_PASSWORD_HASH',
  'LOCAL_PURCHASE_APPLICANT_E_PASSWORD_HASH',
  'LOCAL_PURCHASE_APPLICANT_H_PASSWORD_HASH',
] as const;

describe('purchase access deployment configuration', () => {
  let directory = '';

  afterEach(() => {
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
      directory = '';
    }
  });

  it('writes seven random scrypt hashes while preserving existing access configuration', () => {
    directory = mkdtempSync(join(tmpdir(), 'purchase-access-config-'));
    const envPath = join(directory, '.env');
    const sessionSecret = Buffer.alloc(32, 7).toString('base64');
    writeFileSync(
      envPath,
      [
        '# existing values',
        'UNRELATED_VALUE=keep-me',
        'LOCAL_ADMIN_PASSWORD_HASH=keep-admin',
        'LOCAL_EDITOR_PASSWORD_HASH=keep-editor',
        `LOCAL_ACCESS_SESSION_SECRET=${sessionSecret}`,
        'LOCAL_PURCHASE_ADMIN_PASSWORD_HASH=replace-me',
        '',
      ].join('\r\n'),
      'utf8',
    );
    const setupValues = buildSetupValues();

    const result = runNode(envPath, setupValues);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    for (const password of Object.values(setupValues)) {
      expect(result.stdout).not.toContain(password);
    }
    expect(JSON.parse(result.stdout)).toEqual({
      target: 'env',
      configuredPasswordHashCount: 7,
    });

    const updated = readFileSync(envPath, 'utf8');
    const values = readEnv(updated);
    expect(updated).toContain('UNRELATED_VALUE=keep-me\r\n');
    expect(values.LOCAL_ADMIN_PASSWORD_HASH).toBe('keep-admin');
    expect(values.LOCAL_EDITOR_PASSWORD_HASH).toBe('keep-editor');
    expect(values.LOCAL_ACCESS_SESSION_SECRET).toBe(sessionSecret);
    const hashes = hashNames.map((name) => values[name]);
    expect(hashes).toHaveLength(7);
    expect(new Set(hashes).size).toBe(7);
    hashes.forEach((hash) => expect(hash).toMatch(scryptHashPattern()));
    Object.values(setupValues).forEach((password) =>
      expect(updated).not.toContain(password),
    );
  });

  it('fails closed when any one-time password is missing', () => {
    directory = mkdtempSync(join(tmpdir(), 'purchase-access-config-'));
    const envPath = join(directory, '.env');
    writeFileSync(envPath, 'KEEP=1\n', 'utf8');
    const setupValues = buildSetupValues();
    setupValues.LOCAL_PURCHASE_APPLICANT_H_SETUP_PASSWORD = '';

    const result = runNode(envPath, setupValues);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'LOCAL_PURCHASE_APPLICANT_H_SETUP_PASSWORD',
    );
    expect(readFileSync(envPath, 'utf8')).toBe('KEEP=1\n');
  });

  it('rejects duplicate role passwords before changing the environment file', () => {
    directory = mkdtempSync(join(tmpdir(), 'purchase-access-config-'));
    const envPath = join(directory, '.env');
    writeFileSync(envPath, 'KEEP=1\n', 'utf8');
    const setupValues = buildSetupValues();
    setupValues.LOCAL_PURCHASE_APPLICANT_B_SETUP_PASSWORD =
      setupValues.LOCAL_PURCHASE_APPLICANT_A_SETUP_PASSWORD;

    const result = runNode(envPath, setupValues);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must differ');
    expect(result.stderr).not.toContain(
      setupValues.LOCAL_PURCHASE_APPLICANT_A_SETUP_PASSWORD,
    );
    expect(readFileSync(envPath, 'utf8')).toBe('KEEP=1\n');
  });

  const itOnWindows = process.platform === 'win32' ? it : it.skip;

  itOnWindows(
    'restores all previous user values when a write fails partway through',
    () => {
      const script = loadUserEnvironmentScript();
      if (!script) return;

      const previousValues = Object.fromEntries(
        hashNames.map((name, index) => [
          name,
          index === 2 ? undefined : `previous-hash-${index}`,
        ]),
      );
      const nextValues = Object.fromEntries(
        hashNames.map((name, index) => [name, `next-hash-${index}`]),
      );
      const result = runUserEnvironmentRollbackProbe(
        script,
        previousValues,
        nextValues,
      );

      expect(result.status).toBe(91);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual(
        Object.fromEntries(
          hashNames.map((name, index) => [
            name,
            index === 2 ? null : `previous-hash-${index}`,
          ]),
        ),
      );
      Object.values(nextValues).forEach((value) => {
        expect(result.stdout).not.toContain(value);
        expect(result.stderr).not.toContain(value);
      });
    },
  );

  it('uses hidden prompts, clears setup values, documents hashes, and packages both scripts', () => {
    const wrapperSource = readFileSync(powerShellScript, 'utf8');
    const nodeSource = readFileSync(nodeScript, 'utf8');
    const packageSource = readFileSync(
      resolve('scripts/create-migration-package.ps1'),
      'utf8',
    );
    const envExample = readFileSync(resolve('.env.example'), 'utf8');

    expect(
      wrapperSource.match(/Read-Host[^\r\n]*-AsSecureString/g),
    ).toHaveLength(7);
    setupNames.forEach((name) => {
      expect(wrapperSource).toContain(name);
      expect(wrapperSource).toContain(`Remove-Item Env:${name}`);
    });
    expect(wrapperSource).toContain(
      "$arguments = @('--', $nodeScript, \"--target=$Target\")",
    );
    expect(nodeSource).toContain('randomBytes(16)');
    expect(nodeSource).toContain('scryptSync');
    expect(nodeSource).toContain('[Environment]::SetEnvironmentVariable');
    expect(nodeSource).not.toContain('DEFAULT_PASSWORD');
    expect(packageSource).toContain('configure-purchase-access.mjs');
    expect(packageSource).toContain('configure-purchase-access.ps1');
    hashNames.forEach((name) => expect(envExample).toContain(`${name}=`));
  });
});

function buildSetupValues(): Record<(typeof setupNames)[number], string> {
  return Object.fromEntries(
    setupNames.map((name, index) => [name, `dummy-purchase-password-${index}`]),
  ) as Record<(typeof setupNames)[number], string>;
}

function runNode(
  envPath: string,
  setupValues: Record<(typeof setupNames)[number], string>,
) {
  return spawnSync(
    process.execPath,
    [nodeScript, '--target=env', `--env-file=${envPath}`],
    {
      encoding: 'utf8',
      env: { ...process.env, ...setupValues },
    },
  );
}

function loadUserEnvironmentScript(): string | null {
  const moduleUrl = pathToFileURL(nodeScript).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { createUserEnvironmentScript } from ${JSON.stringify(moduleUrl)}; process.stdout.write(createUserEnvironmentScript());`,
    ],
    { encoding: 'utf8' },
  );

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return result.status === 0 ? result.stdout : null;
}

function runUserEnvironmentRollbackProbe(
  script: string,
  previousValues: Record<string, string | undefined>,
  nextValues: Record<string, string>,
) {
  const names = hashNames.map((name) => `'${name}'`).join(', ');
  const wrapper = [
    '$failure = $null',
    'try {',
    '  & {',
    script,
    '  }',
    '} catch {',
    '  $failure = $_',
    '}',
    '$state = [ordered]@{}',
    `foreach ($name in @(${names})) {`,
    '  $state[$name] = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process)',
    '}',
    '[Console]::Out.Write(($state | ConvertTo-Json -Compress))',
    'if ($null -eq $failure) { exit 90 }',
    'exit 91',
  ].join('\n');
  const env = { ...process.env } as Record<string, string | undefined>;
  for (const name of hashNames) {
    const value = previousValues[name];
    if (value === undefined) delete env[name];
    else env[name] = value;
  }

  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', wrapper],
    {
      encoding: 'utf8',
      env: env as NodeJS.ProcessEnv,
      input: JSON.stringify({
        target: 'Process',
        failAtWriteIndex: 4,
        values: nextValues,
      }),
    },
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

function scryptHashPattern(): RegExp {
  return /^scrypt\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/;
}
