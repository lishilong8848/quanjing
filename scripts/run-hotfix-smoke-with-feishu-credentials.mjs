import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseDotEnv } from 'dotenv';

const CREDENTIAL_KEYS = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'DINGTALK_ATTENDANCE_CLIENT_ID',
  'DINGTALK_ATTENDANCE_CLIENT_SECRET',
];
const FIXTURE_CREDENTIAL_KEYS = [
  ...CREDENTIAL_KEYS,
  'DINGTALK_ATTENDANCE_APP_KEY',
  'DINGTALK_ATTENDANCE_APP_SECRET',
];
const PREFLIGHT_TIMEOUT_MS = 120_000;

function parseArguments(argv) {
  const separator = argv.indexOf('--');
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error('A child command must follow --.');
  }
  const options = {};
  for (let index = 0; index < separator; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !['--credential-root', '--app-root', '--candidate-root'].includes(name) ||
      !value ||
      value.startsWith('--') ||
      Object.hasOwn(options, name)
    ) {
      throw new Error('Invalid smoke credential gate arguments.');
    }
    options[name] = value;
  }
  if (
    separator !== 6 ||
    !['--credential-root', '--app-root', '--candidate-root'].every(
      (name) => Object.hasOwn(options, name),
    )
  ) {
    throw new Error('Invalid smoke credential gate arguments.');
  }
  return {
    credentialRoot: options['--credential-root'],
    appRoot: options['--app-root'],
    candidateRoot: options['--candidate-root'],
    command: argv.slice(separator + 1),
  };
}

function physicalDirectory(path) {
  if (!isAbsolute(path) || !lstatSync(path).isDirectory()) {
    throw new Error('Smoke roots must be existing absolute directories.');
  }
  const canonical = realpathSync.native(path);
  if (resolve(path).toLowerCase() !== resolve(canonical).toLowerCase()) {
    throw new Error('Smoke roots must not traverse a reparse point.');
  }
  return canonical;
}

function environmentFiles(root) {
  const effective = {};
  for (const name of ['.env', '.env.local']) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('Smoke environment file is not a regular file.');
    }
    Object.assign(effective, parseDotEnv(readFileSync(file)));
  }
  return effective;
}

function fileDigest(path) {
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Smoke environment file is not a regular file.');
  }
  return `${metadata.size}:${metadata.mtimeMs}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function environmentSnapshot(root) {
  return ['.env', '.env.local'].map((name) => fileDigest(join(root, name)));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const credentialRoot = physicalDirectory(options.credentialRoot);
  const appRoot = physicalDirectory(options.appRoot);
  const candidateRoot = physicalDirectory(options.candidateRoot);
  if (credentialRoot === appRoot || appRoot === candidateRoot) {
    throw new Error('Smoke roots must be separate.');
  }
  if (!/^[\x20-\x7E]+$/u.test(appRoot)) {
    throw new Error('Smoke app root must use a pure ASCII path.');
  }
  const source = environmentFiles(credentialRoot);
  const fixture = environmentFiles(appRoot);
  for (const key of CREDENTIAL_KEYS) {
    if (!source[key]?.trim()) {
      throw new Error(`Credential source is missing ${key}.`);
    }
  }
  for (const key of FIXTURE_CREDENTIAL_KEYS) {
    if (Object.hasOwn(fixture, key)) {
      throw new Error(`Smoke app contains ${key}; credentials must not be stored in the fixture.`);
    }
  }
  const candidateScript = join(
    candidateRoot,
    'release-root',
    'scripts',
    'ensure-purchase-inventory-config.mjs',
  );
  const dingTalkScript = join(
    candidateRoot,
    'release-root',
    'scripts',
    'dingtalk-attendance-cli.mjs',
  );
  for (const script of [candidateScript, dingTalkScript]) {
    const metadata = lstatSync(script);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      resolve(script).toLowerCase() !== realpathSync.native(script).toLowerCase()
    ) {
      throw new Error('A candidate credential preflight is unavailable.');
    }
  }
  const childEnvironment = {
    ...process.env,
    FEISHU_APP_ID: source.FEISHU_APP_ID,
    FEISHU_APP_SECRET: source.FEISHU_APP_SECRET,
    DINGTALK_ATTENDANCE_CLIENT_ID: source.DINGTALK_ATTENDANCE_CLIENT_ID,
    DINGTALK_ATTENDANCE_CLIENT_SECRET: source.DINGTALK_ATTENDANCE_CLIENT_SECRET,
  };
  const before = environmentSnapshot(appRoot);
  const preflight = spawnSync(
    process.execPath,
    [candidateScript, '--root', appRoot, '--activate-workflow', '--check-only'],
    {
      cwd: appRoot,
      env: childEnvironment,
      encoding: 'utf8',
      timeout: PREFLIGHT_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (JSON.stringify(environmentSnapshot(appRoot)) !== JSON.stringify(before)) {
    throw new Error('Candidate preflight changed smoke environment files.');
  }
  if (
    preflight.error ||
    preflight.status !== 0 ||
    !preflight.stdout.includes('read-only preflight passed')
  ) {
    throw new Error(
      'Candidate read-only Feishu/Base preflight failed; installation was not started.',
    );
  }
  process.stdout.write('[OK] Candidate Feishu/Base read-only preflight passed.\n');
  const dingTalkPreflight = spawnSync(process.execPath, [dingTalkScript, '--self-test'], {
    cwd: appRoot,
    env: childEnvironment,
    encoding: 'utf8',
    timeout: PREFLIGHT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (JSON.stringify(environmentSnapshot(appRoot)) !== JSON.stringify(before)) {
    throw new Error('Candidate preflight changed smoke environment files.');
  }
  let dingTalkResult;
  try {
    dingTalkResult = JSON.parse(dingTalkPreflight.stdout.trim());
  } catch {
    dingTalkResult = null;
  }
  if (
    dingTalkPreflight.error ||
    dingTalkPreflight.status !== 0 ||
    dingTalkResult?.authenticated !== true ||
    dingTalkResult.attendanceApiCalls !== 0 ||
    dingTalkResult.mode !== 'credential-only'
  ) {
    throw new Error(
      'Candidate DingTalk credential-only preflight failed; installation was not started.',
    );
  }
  process.stdout.write('[OK] Candidate DingTalk credential-only preflight passed.\n');
  const child = spawn(options.command[0], options.command.slice(1), {
    cwd: appRoot,
    env: childEnvironment,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
  await new Promise((resolveReady, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Smoke installation child exited on ${signal}.`));
      } else {
        process.exitCode = code ?? 1;
        resolveReady();
      }
    });
  });
}

try {
  await main();
} catch (error) {
  process.stderr.write(`[FAILED] ${error?.message || 'Smoke credential gate failed.'}\n`);
  process.exitCode = 1;
}
