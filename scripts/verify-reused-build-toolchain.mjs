import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

const REQUIRED_BUILD_PACKAGES = Object.freeze([
  '@nestjs/cli',
  '@rspack/cli',
  '@rspack/core',
  'cross-env',
  'typescript',
]);

const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) {
    throw new Error(`Missing argument: ${name}`);
  }
  return args[index + 1];
};

const readJson = (path) => {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 32 * 1024 * 1024) {
    throw new Error(`Invalid JSON input: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
};

const isContained = (root, candidate) => {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const verify = () => {
  const packagePath = resolve(valueOf('--package'));
  const lockPath = resolve(valueOf('--lock'));
  const nodeModulesRoot = realpathSync(resolve(valueOf('--node-modules-root')));
  if (!lstatSync(nodeModulesRoot).isDirectory()) {
    throw new Error('Reusable node_modules root is not a directory');
  }

  const manifest = readJson(packagePath);
  const lock = readJson(lockPath);
  const lockRoot = lock?.packages?.[''];
  if (!lockRoot || typeof lockRoot !== 'object') {
    throw new Error('Candidate package-lock is missing its root package entry');
  }

  const verified = REQUIRED_BUILD_PACKAGES.map((packageName) => {
    const declaration = manifest?.devDependencies?.[packageName];
    const lockedDeclaration = lockRoot?.devDependencies?.[packageName];
    const lockEntry = lock?.packages?.[`node_modules/${packageName}`];
    if (
      typeof declaration !== 'string' ||
      declaration.length === 0 ||
      declaration !== lockedDeclaration ||
      !lockEntry ||
      (lockEntry.dev !== undefined && lockEntry.dev !== true) ||
      lockEntry.optional === true ||
      typeof lockEntry.version !== 'string' ||
      lockEntry.version.length === 0
    ) {
      throw new Error(
        `Reusable build dependency is not locked as a development dependency: ${packageName}`,
      );
    }

    const installedManifestPath = realpathSync(
      join(nodeModulesRoot, packageName, 'package.json'),
    );
    if (!isContained(nodeModulesRoot, installedManifestPath)) {
      throw new Error(
        `Reusable build dependency escapes node_modules: ${packageName}`,
      );
    }
    const installed = readJson(installedManifestPath);
    if (
      installed?.name !== packageName ||
      installed?.version !== lockEntry.version
    ) {
      throw new Error(
        `Reusable build dependency version differs from package-lock: ${packageName}`,
      );
    }
    return Object.freeze({
      name: packageName,
      declaration,
      version: lockEntry.version,
    });
  });

  const fingerprint = createHash('sha256')
    .update(JSON.stringify(verified), 'utf8')
    .digest('hex');
  return { success: true, fingerprint, packages: verified };
};

try {
  process.stdout.write(`${JSON.stringify(verify())}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    })}\n`,
  );
  process.exitCode = 1;
}
