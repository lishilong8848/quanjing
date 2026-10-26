import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, join, relative, resolve } from 'node:path';

class SmokePreflightError extends Error {}

const canonical = (path) => {
  const value = realpathSync.native(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
};

const isWithin = (parent, child) => {
  const result = relative(parent, child);
  return result === '' || (!result.startsWith('..') && !isAbsolute(result));
};

const sha256 = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

const parseArguments = (argv) => {
  const accepted = new Map([
    ['--app-root', 'appRoot'],
    ['--workspace-root', 'workspaceRoot'],
    ['--smoke-parent', 'smokeParent'],
    ['--port', 'port'],
  ]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    const key = accepted.get(option);
    if (!key || typeof value !== 'string' || value.startsWith('--')) {
      throw new SmokePreflightError('Invalid command arguments');
    }
    result[key] = value;
  }
  if (
    argv.length !== accepted.size * 2 ||
    Object.keys(result).length !== accepted.size
  ) {
    throw new SmokePreflightError('Invalid command arguments');
  }
  const port = Number(result.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new SmokePreflightError(
      'Health port must be an integer from 1 to 65535',
    );
  }
  return { ...result, port };
};

const assertIsolatedPhysicalDependencyTree = ({ appRoot, workspaceRoot }) => {
  const nodeModulesPath = join(appRoot, 'node_modules');
  const metadata = lstatSync(nodeModulesPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new SmokePreflightError(
      'node_modules must be a physical directory inside the smoke app root',
    );
  }
  const resolvedNodeModules = canonical(nodeModulesPath);
  const resolvedAppRoot = canonical(appRoot);
  const workspaceNodeModules = canonical(join(workspaceRoot, 'node_modules'));
  if (
    !isWithin(resolvedAppRoot, resolvedNodeModules) ||
    resolvedNodeModules === workspaceNodeModules
  ) {
    throw new SmokePreflightError(
      'node_modules must be a physical directory inside the smoke app root',
    );
  }
};

const assertDependencyStamp = (appRoot) => {
  const stamp = JSON.parse(
    readFileSync(join(appRoot, '.deps-ready.json'), 'utf8').replace(
      /^\uFEFF/,
      '',
    ),
  );
  const expected = {
    packageLock: sha256(join(appRoot, 'package-lock.json')),
    postinstallScript: sha256(join(appRoot, 'scripts', 'postinstall.mjs')),
    feishuCardPatchScript: sha256(
      join(appRoot, 'scripts', 'ensure-feishu-card-ws-sdk-patch.mjs'),
    ),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (String(stamp?.[key] || '').toLowerCase() !== value) {
      throw new SmokePreflightError(
        'Dependency readiness stamp does not match; startup is forbidden before an isolated dependency install',
      );
    }
  }
};

const isProcessAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const assertExclusiveSmoke = ({ appRoot, smokeParent }) => {
  const currentRoot = canonical(appRoot);
  for (const entry of readdirSync(smokeParent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('hotfix-smoke-'))
      continue;
    const siblingRoot = join(smokeParent, entry.name);
    if (canonical(siblingRoot) === currentRoot) continue;
    const pidPath = join(siblingRoot, 'app.pid');
    try {
      const record = JSON.parse(
        readFileSync(pidPath, 'utf8').replace(/^\uFEFF/, ''),
      );
      if (isProcessAlive(Number(record?.pid))) {
        throw new SmokePreflightError(
          `Another hotfix smoke instance is active: ${entry.name}`,
        );
      }
    } catch (error) {
      if (error instanceof SmokePreflightError) throw error;
      if (error?.code !== 'ENOENT') {
        throw new SmokePreflightError(
          `Another hotfix smoke instance may be active; inspect unreadable PID file: ${pidPath}`,
        );
      }
    }
  }
};

const assertPortAvailable = (port) =>
  new Promise((resolveReady, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', (error) => {
      reject(
        new SmokePreflightError(
          error?.code === 'EADDRINUSE'
            ? `Health port is already in use: ${port}`
            : `Health port cannot be reserved: ${port}`,
        ),
      );
    });
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => {
        if (error) {
          reject(
            new SmokePreflightError(`Health port cannot be released: ${port}`),
          );
          return;
        }
        resolveReady();
      });
    });
  });

try {
  const options = parseArguments(process.argv.slice(2));
  const appRoot = resolve(options.appRoot);
  const workspaceRoot = resolve(options.workspaceRoot);
  const smokeParent = resolve(options.smokeParent);
  if (!isWithin(canonical(smokeParent), canonical(appRoot))) {
    throw new SmokePreflightError('Smoke app root must be inside smoke parent');
  }
  if (canonical(appRoot) === canonical(workspaceRoot)) {
    throw new SmokePreflightError(
      'Smoke app root must not be the workspace root',
    );
  }
  assertIsolatedPhysicalDependencyTree({ appRoot, workspaceRoot });
  assertDependencyStamp(appRoot);
  assertExclusiveSmoke({ appRoot, smokeParent });
  await assertPortAvailable(options.port);
  process.stdout.write(
    `${JSON.stringify({
      success: true,
      dependencyTree: 'isolated-physical',
      dependencyStamp: 'matched',
      exclusiveSmoke: true,
      portAvailable: true,
    })}\n`,
  );
} catch (error) {
  const message =
    error instanceof SmokePreflightError
      ? error.message
      : `Smoke preflight failed: ${error?.message || 'unknown error'}`;
  process.stderr.write(
    `${JSON.stringify({ success: false, error: message })}\n`,
  );
  process.exitCode = 1;
}
