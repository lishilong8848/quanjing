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
import { fileURLToPath } from 'node:url';

const PURCHASE_ACCESS_FIELDS = [
  {
    setupName: 'LOCAL_PURCHASE_ADMIN_SETUP_PASSWORD',
    hashName: 'LOCAL_PURCHASE_ADMIN_PASSWORD_HASH',
  },
  ...['A', 'B', 'C', 'D', 'E', 'H'].map((building) => ({
    setupName: `LOCAL_PURCHASE_APPLICANT_${building}_SETUP_PASSWORD`,
    hashName: `LOCAL_PURCHASE_APPLICANT_${building}_PASSWORD_HASH`,
  })),
];

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main();
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const passwords = PURCHASE_ACCESS_FIELDS.map(({ setupName }) =>
    readSetupPassword(setupName),
  );
  if (new Set(passwords).size !== passwords.length) {
    throw new Error('Purchase access role passwords must differ.');
  }

  const values = Object.fromEntries(
    PURCHASE_ACCESS_FIELDS.map(({ hashName }, index) => [
      hashName,
      hashPassword(passwords[index]),
    ]),
  );

  if (options.target === 'env') {
    const envPath = resolve(options.envFile);
    const source = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    writeEnvironmentFile(envPath, source, values);
  } else {
    if (process.platform !== 'win32') {
      throw new Error('The user environment target requires Windows.');
    }
    writeUserEnvironmentValues(values);
  }

  for (const { setupName } of PURCHASE_ACCESS_FIELDS) {
    delete process.env[setupName];
  }

  process.stdout.write(
    JSON.stringify({
      target: options.target,
      configuredPasswordHashCount:
        Object.values(values).filter(isScryptHash).length,
    }),
  );
}

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

  for (const { hashName } of PURCHASE_ACCESS_FIELDS) {
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

function writeUserEnvironmentValues(nextValues) {
  const script = createUserEnvironmentScript();
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        input: JSON.stringify({ target: 'User', values: nextValues }),
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
      },
    );
  } catch {
    throw new Error('Failed to store purchase access configuration.');
  }
}

export function createUserEnvironmentScript() {
  return [
    '$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json',
    '$values = $payload.values',
    "if ($null -eq $values) { throw [ArgumentException]::new('Values are required.') }",
    '$targetName = [string]$payload.target',
    "if ($targetName -ne 'User' -and $targetName -ne 'Process') { throw [ArgumentException]::new('Unsupported environment target.') }",
    '$target = [EnvironmentVariableTarget]::User',
    "if ($targetName -eq 'Process') { $target = [EnvironmentVariableTarget]::Process }",
    '$failAtWriteIndex = -1',
    'if ($null -ne $payload.failAtWriteIndex) { $failAtWriteIndex = [int]$payload.failAtWriteIndex }',
    '$previousValues = [ordered]@{}',
    'foreach ($entry in $values.PSObject.Properties) {',
    '  $previousValues[$entry.Name] = [Environment]::GetEnvironmentVariable($entry.Name, $target)',
    '}',
    '$writeIndex = 0',
    'try {',
    '  foreach ($entry in $values.PSObject.Properties) {',
    "    if ($writeIndex -eq $failAtWriteIndex) { throw [InvalidOperationException]::new('Injected environment write failure.') }",
    '    [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, $target)',
    '    $writeIndex += 1',
    '  }',
    '} catch {',
    '  $writeError = $_.Exception',
    '  $rollbackErrors = [Collections.Generic.List[Exception]]::new()',
    '  foreach ($entry in $values.PSObject.Properties) {',
    '    try {',
    '      [Environment]::SetEnvironmentVariable($entry.Name, $previousValues[$entry.Name], $target)',
    '    } catch {',
    '      $rollbackErrors.Add($_.Exception)',
    '    }',
    '  }',
    '  if ($rollbackErrors.Count -gt 0) {',
    "    throw [AggregateException]::new('Environment write failed and rollback was incomplete.', $rollbackErrors.ToArray())",
    '  }',
    '  throw $writeError',
    '}',
  ].join('\n');
}
