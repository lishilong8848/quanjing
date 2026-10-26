import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { config } from 'dotenv';

const NON_EMPTY_DOTENV_FALLBACK_KEYS = [
  'CONTRACT_ATTACHMENT_ENCRYPTION_KEY',
  'COS_SECRET_ID',
  'COS_SECRET_KEY',
  'COS_SESSION_TOKEN',
  'TENCENTCLOUD_SECRET_ID',
  'TENCENTCLOUD_SECRET_KEY',
  'TENCENTCLOUD_SESSION_TOKEN',
];

function loadDotenvPreservingNonEmptyCredentials(path) {
  const nonEmptyValues = new Map();
  for (const key of NON_EMPTY_DOTENV_FALLBACK_KEYS) {
    const value = process.env[key];
    if (value?.trim()) {
      nonEmptyValues.set(key, value);
    }
  }

  config({ path, override: true, quiet: true });

  for (const [key, value] of nonEmptyValues) {
    if (!process.env[key]?.trim()) {
      process.env[key] = value;
    }
  }
}

// Prefer project-local configuration over inherited machine-level variables.
// This app is often migrated between PCs, where stale FEISHU_* values can remain
// in the user environment and silently point the server at the wrong app.
loadDotenvPreservingNonEmptyCredentials('.env');
loadDotenvPreservingNonEmptyCredentials('.env.local');

const [command, ...args] = process.argv.slice(2);

if (!process.env.FORCE_FRAMEWORK_DOMAIN_MAIN) {
  const clientHost = process.env.CLIENT_DEV_HOST || 'localhost';
  const clientPort = process.env.CLIENT_DEV_PORT || '8080';
  process.env.FORCE_FRAMEWORK_DOMAIN_MAIN = `http://${clientHost}:${clientPort}`;
}

if (!command) {
  console.error('Usage: node scripts/run-with-env.mjs <command> [...args]');
  process.exit(1);
}

const childCommand = resolveChildCommand(command, args);
const child = spawn(childCommand.executable, childCommand.args, {
  env: process.env,
  shell: false,
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`Unable to start ${command}: ${error.code || error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

function resolveChildCommand(executable, executableArgs) {
  if (process.platform !== 'win32') {
    return { executable, args: executableArgs };
  }

  const commandName = basename(executable).replace(/\.(?:cmd|exe)$/iu, '');
  if (commandName.toLowerCase() === 'node') {
    return { executable: process.execPath, args: executableArgs };
  }

  const shimPath = findWindowsCommandShim(executable);
  const nodeEntry = shimPath ? readNodeEntryFromNpmShim(shimPath) : '';
  if (nodeEntry) {
    return {
      executable: process.execPath,
      args: [nodeEntry, ...executableArgs],
    };
  }

  return { executable, args: executableArgs };
}

function findWindowsCommandShim(executable) {
  const candidates = [];
  if (/[\\/]/u.test(executable)) {
    candidates.push(executable);
    if (!executable.toLowerCase().endsWith('.cmd')) {
      candidates.push(`${executable}.cmd`);
    }
  } else {
    for (const directory of String(process.env.PATH || '').split(delimiter)) {
      if (!directory) continue;
      candidates.push(join(directory, `${executable}.cmd`));
    }
  }
  return candidates.find((candidate) => existsSync(candidate)) || '';
}

function readNodeEntryFromNpmShim(shimPath) {
  let source = '';
  try {
    source = readFileSync(shimPath, 'utf8');
  } catch {
    return '';
  }
  const match = source.match(
    /"%dp0%\\([^"]+\.(?:cjs|mjs|js))"\s+%\*/iu,
  );
  if (!match?.[1]) return '';
  const entryPath = resolve(dirname(shimPath), match[1].replaceAll('\\', '/'));
  return existsSync(entryPath) ? entryPath : '';
}
