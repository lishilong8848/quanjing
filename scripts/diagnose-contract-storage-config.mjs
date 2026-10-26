import { readFileSync, lstatSync, statSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';

const credentialNames = [
  'CONTRACT_ATTACHMENT_ENCRYPTION_KEY',
  'COS_SECRET_ID',
  'COS_SECRET_KEY',
  'COS_SESSION_TOKEN',
  'TENCENTCLOUD_SECRET_ID',
  'TENCENTCLOUD_SECRET_KEY',
  'TENCENTCLOUD_SESSION_TOKEN',
];
const flagName = 'CONTRACT_ATTACHMENT_STORAGE_ENABLED';
const settingNames = [...credentialNames, flagName];
const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const validKey = (value) => {
  const key = clean(value);
  const bytes = Buffer.from(key, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === key;
};

function safeLocalPath(input) {
  if (
    typeof input !== 'string' ||
    !input ||
    /^(?:\\\\|\/\/)|[\x00-\x1f]/.test(input)
  )
    throw Error('unsafe-path');
  const absolute = resolve(input);
  if (absolute.slice(parse(absolute).root.length).includes(':'))
    throw Error('unsafe-path');
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw Error('unsafe-path');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (dirname(cursor) === cursor) break;
  }
  return absolute;
}

function readLocalFile(input, maximumBytes = 1024 * 1024) {
  const file = safeLocalPath(input);
  const before = statSync(file);
  if (!before.isFile() || before.size > maximumBytes) throw Error('unreadable');
  const content = readFileSync(file, 'utf8');
  const after = statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw Error('unstable-source');
  return content.replace(/^\uFEFF/, '');
}

function observe(source, values, status = 'read') {
  return {
    source,
    status,
    settings: Object.fromEntries(
      settingNames.map((name) => [
        name,
        {
          present: Boolean(clean(values[name])),
          ...(name === 'CONTRACT_ATTACHMENT_ENCRYPTION_KEY'
            ? { valid: validKey(values[name]) }
            : {}),
        },
      ]),
    ),
  };
}

function readWindowsEnvironment() {
  if (process.platform !== 'win32') return { User: {}, Machine: {} };
  const script = `$ErrorActionPreference='Stop'; $result=@{}; foreach($target in @('User','Machine')){$values=@{}; foreach($name in @(${credentialNames.map((name) => `'${name}'`).join(',')})){$values[$name]=[Environment]::GetEnvironmentVariable($name,$target)};$result[$target]=$values};[Console]::Write(($result|ConvertTo-Json -Depth 3 -Compress))`;
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.status !== 0) throw Error('windows-source-unreadable');
  try {
    return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  } catch {
    throw Error('windows-source-unreadable');
  }
}

export function diagnoseContractStorageConfig({
  root,
  environment = process.env,
  readWindowsEnvironment: windowsReader = readWindowsEnvironment,
}) {
  root = safeLocalPath(root);
  if (!statSync(root).isDirectory()) throw Error('invalid-root');
  const values = Object.fromEntries(
    settingNames.map((name) => [name, environment[name]]),
  );
  const selectedSources = Object.fromEntries(
    settingNames.map((name) => [name, clean(values[name]) ? 'process' : null]),
  );
  const sources = [observe('process', values)];
  const sourceErrors = [];

  try {
    const windows = windowsReader();
    for (const [scope, source] of [
      ['User', 'windows-user'],
      ['Machine', 'windows-machine'],
    ]) {
      const scopedValues = windows[scope] || {};
      sources.push(observe(source, scopedValues));
      for (const name of credentialNames) {
        if (!clean(values[name]) && clean(scopedValues[name])) {
          values[name] = scopedValues[name];
          selectedSources[name] = source;
        }
      }
    }
  } catch {
    sourceErrors.push('windows-environment');
  }

  for (const [source, file] of [
    ['private-env', join(dirname(root), 'nantong-schedule.private.env')],
    ['.env', join(root, '.env')],
    ['.env.local', join(root, '.env.local')],
  ]) {
    try {
      const fileValues = parseEnv(readLocalFile(file));
      sources.push(observe(source, fileValues));
      for (const name of settingNames) {
        if (!Object.hasOwn(fileValues, name)) continue;
        if (credentialNames.includes(name)) {
          if (!clean(fileValues[name])) continue;
        } else if (source === 'private-env') continue;
        values[name] = fileValues[name];
        selectedSources[name] = source;
      }
    } catch (error) {
      if (error.code === 'ENOENT') sources.push(observe(source, {}, 'missing'));
      else {
        sourceErrors.push(source);
        sources.push(observe(source, {}, 'unreadable'));
      }
    }
  }

  const effective = {
    storageEnabled: !['false', '0', 'off', 'no'].includes(
      clean(values[flagName]).toLowerCase(),
    ),
    encryptionKeyPresent: Boolean(
      clean(values.CONTRACT_ATTACHMENT_ENCRYPTION_KEY),
    ),
    encryptionKeyValid: validKey(values.CONTRACT_ATTACHMENT_ENCRYPTION_KEY),
    cosSecretIdPresent: Boolean(
      clean(values.COS_SECRET_ID) || clean(values.TENCENTCLOUD_SECRET_ID),
    ),
    cosSecretKeyPresent: Boolean(
      clean(values.COS_SECRET_KEY) || clean(values.TENCENTCLOUD_SECRET_KEY),
    ),
  };
  const issues = [];
  if (sourceErrors.length) issues.push('configuration_source_unreadable');
  else if (!effective.storageEnabled) issues.push('storage_disabled');
  else {
    if (!effective.encryptionKeyPresent) issues.push('encryption_key_missing');
    else if (!effective.encryptionKeyValid)
      issues.push('encryption_key_invalid');
    if (!effective.cosSecretIdPresent) issues.push('cos_secret_id_missing');
    if (!effective.cosSecretKeyPresent) issues.push('cos_secret_key_missing');
  }
  let installedDeploymentId = null;
  try {
    const receipt = JSON.parse(
      readLocalFile(
        join(root, '.hotfix-installed-release.json'),
        8 * 1024 * 1024,
      ),
    );
    if (/^nantong-[A-Za-z0-9_-]{1,120}$/.test(receipt.deploymentId))
      installedDeploymentId = receipt.deploymentId;
  } catch {
    /* Receipt identity is optional and never a configuration or health proof. */
  }
  const status = sourceErrors.length
    ? 'unknown'
    : !effective.storageEnabled
      ? 'disabled'
      : issues.length
        ? 'not-configured'
        : 'configuration-ready';
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    readOnly: true,
    networkCalls: 0,
    applicationWrites: 0,
    serviceStoppedOrRestarted: false,
    liveProcessStateVerified: false,
    cosConnectivityVerified: false,
    receiptVerified: false,
    installedDeploymentId,
    status,
    issues,
    effective,
    sourceErrors,
    sources,
    settings: Object.fromEntries(
      settingNames.map((name) => [
        name,
        {
          present: Boolean(clean(values[name])),
          source: selectedSources[name],
          ...(name === 'CONTRACT_ATTACHMENT_ENCRYPTION_KEY'
            ? { valid: validKey(values[name]) }
            : {}),
        },
      ]),
    ),
    limitations: [
      'Configuration is synthesized for the account invoking this tool; it is not the running server PID environment.',
      'A valid key format does not prove the key can decrypt existing objects.',
      'COS credentials are checked for presence only, without authentication or object reads.',
      'Source precedence matches the 20261003-191028 readonly startup loader; no application module is imported.',
    ],
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--root')
      throw Error('invalid-arguments');
    console.log(
      JSON.stringify(
        diagnoseContractStorageConfig({ root: process.argv[3] }),
        null,
        2,
      ),
    );
  } catch {
    console.error(
      'CONTRACT_CONFIG_DIAGNOSTIC_FAILED; no configuration or service was changed.',
    );
    process.exitCode = 1;
  }
}
