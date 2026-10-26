import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  lstat as lstatAsync,
  open as openAsync,
  opendir as opendirAsync,
  realpath as realpathAsync,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
  sep as pathSeparator,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_STABLE_HASH_BYTES = 512 * 1024 * 1024;
const STABLE_HASH_BUFFER_BYTES = 1024 * 1024;
const TRANSITION_PACKAGES = Object.freeze({
  fflate: Object.freeze({
    declaration: '^0.8.2',
    lockedVersion: '0.8.2',
    lockPath: 'node_modules/fflate',
    legacyLocation: 'missing',
    installedFingerprint:
      'f2a0f5bc803efabe69eb3bdead6b481fff1eddb6cef71c0a4bf2346470ab02d9',
    installedEntryCount: 20,
    installedFileCount: 17,
    installedBytes: 773398,
  }),
  multer: Object.freeze({
    declaration: '2.0.2',
    lockedVersion: '2.0.2',
    lockPath: 'node_modules/multer',
    legacyLocation: 'missing',
    installedFingerprint:
      'f4aa8de65cc5f5aa80c5ff20e71926d6988bdc630042daef5c5a4b0dc700d472',
    installedEntryCount: 13,
    installedFileCount: 11,
    installedBytes: 29490,
  }),
  rxjs: Object.freeze({
    declaration: '^7.8.2',
    lockedVersion: '7.8.2',
    lockPath: 'node_modules/rxjs',
    legacyLocation: 'devDependencies',
    installedFingerprint:
      '1dcb30e4926321c90174138ca7a2267c0457c891f28035560a340b10a473fa91',
    installedEntryCount: 2364,
    installedFileCount: 2277,
    installedBytes: 4497673,
  }),
});
const ALLOWED_SCRIPT_TRANSITIONS = Object.freeze({
  'backfill:dingtalk-attendance-archive': Object.freeze({
    baseline: undefined,
    candidate:
      'node scripts/run-with-env.mjs node scripts/backfill-dingtalk-attendance-archive.mjs',
  }),
  'audit:dingtalk-attendance-archive': Object.freeze({
    baseline: undefined,
    candidate:
      'node scripts/run-with-env.mjs node scripts/backfill-dingtalk-attendance-archive.mjs --audit-only',
  }),
  'migrate:attendance-archive-fields': Object.freeze({
    baseline: undefined,
    candidate:
      'node scripts/run-with-env.mjs node scripts/ensure-attendance-archive-summary-fields.mjs --apply',
  }),
  'migrate:attendance-archive-fields:check': Object.freeze({
    baseline: undefined,
    candidate:
      'node scripts/run-with-env.mjs node scripts/ensure-attendance-archive-summary-fields.mjs --dry-run --require-ready',
  }),
  'migrate:attendance-archive-fields:dry-run': Object.freeze({
    baseline: undefined,
    candidate:
      'node scripts/run-with-env.mjs node scripts/ensure-attendance-archive-summary-fields.mjs --dry-run',
  }),
  'migrate:legacy-exception-follow-ups': Object.freeze({
    baseline: undefined,
    candidate:
      'node scripts/run-with-env.mjs node scripts/migrate-legacy-exception-follow-ups.mjs --apply',
  }),
  'migrate:legacy-exception-follow-ups:dry-run': Object.freeze({
    baseline: undefined,
    candidate:
      'node scripts/run-with-env.mjs node scripts/migrate-legacy-exception-follow-ups.mjs --dry-run',
  }),
  'migrate:operations-follow-up-fields': Object.freeze({
    baseline: undefined,
    candidate:
      'node scripts/run-with-env.mjs node scripts/ensure-today-operations-follow-up-fields.mjs --apply',
  }),
  'migrate:operations-follow-up-fields:check': Object.freeze({
    baseline: undefined,
    candidate:
      'node scripts/run-with-env.mjs node scripts/ensure-today-operations-follow-up-fields.mjs --dry-run --require-ready',
  }),
  'migrate:operations-follow-up-fields:dry-run': Object.freeze({
    baseline: undefined,
    candidate:
      'node scripts/run-with-env.mjs node scripts/ensure-today-operations-follow-up-fields.mjs --dry-run',
  }),
  'migrate:inventory-outbound-approval-fields': Object.freeze({
    baseline: undefined,
    candidate:
      'node scripts/run-with-env.mjs node scripts/ensure-inventory-outbound-approval-fields.mjs --apply',
  }),
  'migrate:inventory-outbound-approval-fields:check': Object.freeze({
    baseline: undefined,
    candidate:
      'node scripts/run-with-env.mjs node scripts/ensure-inventory-outbound-approval-fields.mjs --dry-run --require-ready',
  }),
  'migrate:inventory-outbound-approval-fields:dry-run': Object.freeze({
    baseline: undefined,
    candidate:
      'node scripts/run-with-env.mjs node scripts/ensure-inventory-outbound-approval-fields.mjs --dry-run',
  }),
  'migrate:leave-shift-details': Object.freeze({
    baseline: undefined,
    candidate:
      'node scripts/run-with-env.mjs node scripts/ensure-leave-workflow-fields.mjs --with-shift-details --apply',
  }),
  'migrate:leave-shift-details:check': Object.freeze({
    baseline: undefined,
    candidate:
      'node scripts/run-with-env.mjs node scripts/ensure-leave-workflow-fields.mjs --with-shift-details --require-ready',
  }),
  'migrate:leave-shift-details:data': Object.freeze({
    baseline: undefined,
    candidate:
      'node scripts/run-with-env.mjs node scripts/migrate-leave-shift-substitute-details.mjs --apply',
  }),
  'migrate:leave-shift-details:data:dry-run': Object.freeze({
    baseline: undefined,
    candidate:
      'node scripts/run-with-env.mjs node scripts/migrate-leave-shift-substitute-details.mjs --dry-run',
  }),
  'migrate:leave-shift-details:dry-run': Object.freeze({
    baseline: undefined,
    candidate:
      'node scripts/run-with-env.mjs node scripts/ensure-leave-workflow-fields.mjs --with-shift-details',
  }),
  'self-test:overtime-workflow:apply-real': Object.freeze({
    baseline:
      'node scripts/run-with-env.mjs node scripts/self-test-overtime-workflow.mjs --apply-real',
    candidate:
      'npm run build:server && node scripts/run-with-env.mjs node scripts/self-test-overtime-workflow.mjs --apply-real',
  }),
  'self-test:overtime-workflow:audit': Object.freeze({
    baseline:
      'node scripts/run-with-env.mjs node scripts/self-test-overtime-workflow.mjs --audit-only',
    candidate:
      'npm run build:server && node scripts/run-with-env.mjs node scripts/self-test-overtime-workflow.mjs --audit-only',
  }),
  'self-test:overtime-workflow:cleanup': Object.freeze({
    baseline:
      'node scripts/run-with-env.mjs node scripts/self-test-overtime-workflow.mjs --cleanup-only',
    candidate:
      'npm run build:server && node scripts/run-with-env.mjs node scripts/self-test-overtime-workflow.mjs --cleanup-only',
  }),
});
const PHYSICAL_METADATA_CONCURRENCY = 24;
const PHYSICAL_HASH_CONCURRENCY = 32;
const PHYSICAL_HASH_BUFFER_BYTES = 256 * 1024;
const INSTALLED_PROOF_ALGORITHM = 'sha256-package-lock-production-closure-v1';
const MAX_PHYSICAL_TREE_DEPTH = 64;
const MAX_PHYSICAL_TREE_ENTRIES = 250_000;
const MAX_PHYSICAL_TREE_BYTES = 1024 * 1024 * 1024;
const MAX_PHYSICAL_FILE_BYTES = 32 * 1024 * 1024;
const WINDOWS_TREE_AUDIT_TIMEOUT_MS = 120_000;
const DEPENDENCY_PROOF_CACHE_SCHEMA = 1;
const DEPENDENCY_PROOF_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DEPENDENCY_PROOF_CACHE_BYTES = 8 * 1024 * 1024;
const TRUSTED_WINDOWS_ROOT = String.raw`C:\Windows`;
const LIFECYCLE_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
];

class DependencyTransitionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DependencyTransitionError';
  }
}

export const mapWithConcurrency = async (values, concurrency, mapper) => {
  if (
    !Array.isArray(values) ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    typeof mapper !== 'function'
  ) {
    throw new TypeError('Invalid bounded concurrency arguments');
  }
  const results = new Array(values.length);
  let nextIndex = 0;
  let stopped = false;
  let failure;
  const worker = async () => {
    while (!stopped) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) {
        return;
      }
      try {
        results[index] = await mapper(values[index], index);
      } catch (error) {
        stopped = true;
        failure ??= error;
        return;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length || 1) }, () =>
      worker(),
    ),
  );
  if (failure !== undefined) {
    throw failure;
  }
  return results;
};

const isPlainObject = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const sameFileIdentity = (left, right) =>
  left.dev === right.dev && left.ino === right.ino;

const sameFileSnapshot = (left, right) =>
  sameFileIdentity(left, right) &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs &&
  left.mode === right.mode &&
  left.nlink === right.nlink;

const hasSingleLink = (stat) => stat.nlink === 1n;

const readStableRegularFile = (filePath) => {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new DependencyTransitionError('Input must be a regular file');
  }
  if (process.platform === 'win32') {
    const root = parsePath(filePath).root;
    if (filePath.slice(root.length).includes(':')) {
      throw new DependencyTransitionError(
        'Input path must not use an alternate data stream',
      );
    }
  }

  let descriptor;
  let content;
  try {
    const pathBefore = lstatSync(filePath, { bigint: true });
    if (
      !pathBefore.isFile() ||
      pathBefore.isSymbolicLink() ||
      !hasSingleLink(pathBefore)
    ) {
      throw new DependencyTransitionError('Input must be a regular file');
    }
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    descriptor = openSync(filePath, fsConstants.O_RDONLY | noFollow);
    const descriptorBefore = fstatSync(descriptor, { bigint: true });
    if (
      !descriptorBefore.isFile() ||
      !sameFileIdentity(pathBefore, descriptorBefore) ||
      !hasSingleLink(descriptorBefore) ||
      descriptorBefore.size <= 0n ||
      descriptorBefore.size > BigInt(MAX_JSON_BYTES)
    ) {
      throw new DependencyTransitionError('Input must be a regular file');
    }
    content = readFileSync(descriptor);
    const descriptorAfter = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(filePath, { bigint: true });
    if (
      content.length <= 0 ||
      content.length > MAX_JSON_BYTES ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      !hasSingleLink(descriptorAfter) ||
      !hasSingleLink(pathAfter) ||
      !sameFileSnapshot(descriptorBefore, descriptorAfter) ||
      !sameFileSnapshot(pathBefore, pathAfter) ||
      !sameFileIdentity(pathAfter, descriptorAfter) ||
      descriptorAfter.size !== BigInt(content.length)
    ) {
      throw new DependencyTransitionError('Input changed while being read');
    }
  } catch (error) {
    if (error instanceof DependencyTransitionError) {
      throw error;
    }
    throw new DependencyTransitionError('Input must be a regular file');
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
  return content;
};

const readJsonObject = (filePath) => {
  const content = readStableRegularFile(filePath);
  let parsed;
  try {
    parsed = JSON.parse(content.toString('utf8'));
  } catch {
    throw new DependencyTransitionError('Input JSON is invalid');
  }
  if (!isPlainObject(parsed)) {
    throw new DependencyTransitionError('Input JSON must contain an object');
  }
  return parsed;
};

const canonicalJson = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const deepClone = (value) => JSON.parse(JSON.stringify(value));
const isDeepEqual = (left, right) =>
  canonicalJson(left) === canonicalJson(right);

const getScripts = (packageJson) =>
  isPlainObject(packageJson.scripts) ? packageJson.scripts : {};

const assertLifecycleScriptsEqual = (baselinePackage, candidatePackage) => {
  const baselineScripts = getScripts(baselinePackage);
  const candidateScripts = getScripts(candidatePackage);
  for (const scriptName of LIFECYCLE_SCRIPTS) {
    if (baselineScripts[scriptName] !== candidateScripts[scriptName]) {
      throw new DependencyTransitionError(
        `Lifecycle script differs: ${scriptName}`,
      );
    }
  }
};

const assertPackageScriptTransition = (baselinePackage, candidatePackage) => {
  assertLifecycleScriptsEqual(baselinePackage, candidatePackage);
  const baselineScripts = getScripts(baselinePackage);
  const candidateScripts = getScripts(candidatePackage);
  const scriptNames = [
    ...new Set([
      ...Object.keys(baselineScripts),
      ...Object.keys(candidateScripts),
    ]),
  ].sort();
  for (const scriptName of scriptNames) {
    if (baselineScripts[scriptName] === candidateScripts[scriptName]) {
      continue;
    }
    const allowed = ALLOWED_SCRIPT_TRANSITIONS[scriptName];
    if (
      allowed &&
      baselineScripts[scriptName] === allowed.baseline &&
      candidateScripts[scriptName] === allowed.candidate
    ) {
      continue;
    }
    throw new DependencyTransitionError(
      'Package scripts differ outside the allowlist',
    );
  }
};

const getDependencyDeclaration = (container, section, packageName) =>
  isPlainObject(container?.[section])
    ? container[section][packageName]
    : undefined;

const getDeclarationState = (container, packageName) => ({
  production: getDependencyDeclaration(container, 'dependencies', packageName),
  development: getDependencyDeclaration(
    container,
    'devDependencies',
    packageName,
  ),
});

const classifyBaselineDeclaration = (container, packageName, specification) => {
  const state = getDeclarationState(container, packageName);
  if (
    state.production === specification.declaration &&
    state.development === undefined
  ) {
    return 'production';
  }
  if (
    specification.legacyLocation === 'missing' &&
    state.production === undefined &&
    state.development === undefined
  ) {
    return 'legacy';
  }
  if (
    specification.legacyLocation === 'devDependencies' &&
    state.production === undefined &&
    state.development === specification.declaration
  ) {
    return 'legacy';
  }
  throw new DependencyTransitionError(
    `${packageName} baseline declaration is not an allowed state`,
  );
};

const assertCandidateDeclaration = (container, packageName, specification) => {
  const state = getDeclarationState(container, packageName);
  if (state.production === undefined) {
    throw new DependencyTransitionError(
      `${packageName} must be a production dependency`,
    );
  }
  if (state.production !== specification.declaration) {
    throw new DependencyTransitionError(
      `${packageName} declaration must be ${specification.declaration}`,
    );
  }
  if (state.development !== undefined) {
    throw new DependencyTransitionError(
      `${packageName} must not remain in devDependencies after the transition`,
    );
  }
};

const determineDeclarationTransition = (baselineRoot, candidateRoot) => {
  const changedPackages = [];
  for (const [packageName, specification] of Object.entries(
    TRANSITION_PACKAGES,
  )) {
    const baselineState = classifyBaselineDeclaration(
      baselineRoot,
      packageName,
      specification,
    );
    if (
      baselineState === 'production' &&
      getDependencyDeclaration(candidateRoot, 'dependencies', packageName) ===
        undefined
    ) {
      throw new DependencyTransitionError(
        `Removing the ${packageName} root declaration is forbidden`,
      );
    }
    assertCandidateDeclaration(candidateRoot, packageName, specification);
    if (baselineState === 'legacy') {
      changedPackages.push(packageName);
    }
  }
  return changedPackages;
};

const withoutPackageTransitionFields = (packageJson) => {
  const normalized = deepClone(packageJson);
  delete normalized.scripts;
  for (const packageName of Object.keys(TRANSITION_PACKAGES)) {
    if (isPlainObject(normalized.dependencies)) {
      delete normalized.dependencies[packageName];
    }
    if (isPlainObject(normalized.devDependencies)) {
      delete normalized.devDependencies[packageName];
    }
  }
  return normalized;
};

const getLockPackages = (lockJson) => {
  if (!isPlainObject(lockJson.packages)) {
    throw new DependencyTransitionError(
      'Package lock must contain a packages object',
    );
  }
  return lockJson.packages;
};

const getRootLockPackage = (lockPackages) => {
  if (!isPlainObject(lockPackages[''])) {
    throw new DependencyTransitionError(
      'Package lock must contain a root package entry',
    );
  }
  return lockPackages[''];
};

const withoutLockTransitionFields = (lockJson) => {
  const normalized = deepClone(lockJson);
  const rootPackage = normalized.packages[''];
  for (const packageName of Object.keys(TRANSITION_PACKAGES)) {
    if (isPlainObject(rootPackage.dependencies)) {
      delete rootPackage.dependencies[packageName];
    }
    if (isPlainObject(rootPackage.devDependencies)) {
      delete rootPackage.devDependencies[packageName];
    }
  }
  return normalized;
};

const validateIntegrity = (integrity) => {
  if (typeof integrity !== 'string') {
    return false;
  }
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(
    integrity,
  );
  if (!match) {
    return false;
  }
  const expectedBytes = { sha256: 32, sha384: 48, sha512: 64 }[match[1]];
  const decoded = Buffer.from(match[2], 'base64');
  const canonicalBase64 = decoded.toString('base64');
  return decoded.length === expectedBytes && canonicalBase64 === match[2];
};

const validatePhysicalEntry = (
  packageName,
  specification,
  baselinePackages,
  candidatePackages,
) => {
  const baselineEntry = baselinePackages[specification.lockPath];
  const candidateEntry = candidatePackages[specification.lockPath];
  if (
    !isPlainObject(baselineEntry) ||
    !isPlainObject(candidateEntry) ||
    !isDeepEqual(baselineEntry, candidateEntry)
  ) {
    throw new DependencyTransitionError(
      `${packageName} physical lock entry differs`,
    );
  }
  if (candidateEntry.version !== specification.lockedVersion) {
    throw new DependencyTransitionError(
      `${packageName} locked version must be ${specification.lockedVersion}`,
    );
  }
  if (
    typeof candidateEntry.resolved !== 'string' ||
    candidateEntry.resolved.length === 0
  ) {
    throw new DependencyTransitionError(
      `${packageName} resolved source is invalid`,
    );
  }
  if (!validateIntegrity(candidateEntry.integrity)) {
    throw new DependencyTransitionError(`${packageName} integrity is invalid`);
  }
  if (candidateEntry.dev === true || candidateEntry.optional === true) {
    throw new DependencyTransitionError(
      `${packageName} physical package must be production-required`,
    );
  }
  return candidateEntry;
};

const getPhysicalTreeFingerprint = (lockPackages) => {
  const physicalPackages = Object.fromEntries(
    Object.entries(lockPackages).filter(([packagePath]) => packagePath !== ''),
  );
  return createHash('sha256')
    .update(canonicalJson(physicalPackages), 'utf8')
    .digest('hex');
};

const ordinalCompare = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalPathKey = (value) => {
  const canonical = resolve(value);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
};

const assertExpectedPackages = (expectedPackages) => {
  if (
    !isPlainObject(expectedPackages) ||
    !isDeepEqual(
      Object.keys(expectedPackages).sort(),
      Object.keys(TRANSITION_PACKAGES).sort(),
    )
  ) {
    throw new DependencyTransitionError(
      'Installed dependency expectations are invalid',
    );
  }
};

const parseInstalledLockPath = (lockPath) => {
  if (
    typeof lockPath !== 'string' ||
    !lockPath.startsWith('node_modules/') ||
    lockPath.includes('\\') ||
    lockPath.includes(':') ||
    lockPath.includes('\0')
  ) {
    throw new DependencyTransitionError(
      'Installed dependency expectations are invalid',
    );
  }
  const segments = lockPath.split('/');
  if (
    segments.length < 2 ||
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    throw new DependencyTransitionError(
      'Installed dependency expectations are invalid',
    );
  }
  return segments.slice(1).join('/');
};

const createInstalledPackageDefinitions = ({
  expectedPackages,
  lockfileVersion,
  lockPackages,
}) => {
  assertExpectedPackages(expectedPackages);
  const expectedByLockPath = new Map(
    Object.entries(expectedPackages).map(([packageName, expectation]) => {
      const lockPath =
        typeof expectation.lockPath === 'string'
          ? expectation.lockPath
          : `node_modules/${packageName}`;
      parseInstalledLockPath(lockPath);
      return [lockPath, { packageName, expectation }];
    }),
  );

  if (lockfileVersion === undefined && lockPackages === undefined) {
    return [...expectedByLockPath.entries()].map(
      ([lockPath, { packageName, expectation }]) => ({
        lockPath,
        installedRelativePath: parseInstalledLockPath(lockPath),
        lockedVersion: expectation.lockedVersion,
        optional: false,
        expectation,
        expectedPackageName: packageName,
        reportKey: packageName,
      }),
    );
  }
  if (![2, 3].includes(lockfileVersion) || !isPlainObject(lockPackages)) {
    throw new DependencyTransitionError(
      'Installed dependency expectations are invalid',
    );
  }
  getRootLockPackage(lockPackages);

  const definitions = [];
  const includedExpectedPaths = new Set();
  const canonicalLockPaths = new Set();
  for (const [lockPath, lockEntry] of Object.entries(lockPackages).sort(
    ([left], [right]) => ordinalCompare(left, right),
  )) {
    if (lockPath === '') {
      continue;
    }
    if (!isPlainObject(lockEntry)) {
      throw new DependencyTransitionError(
        'Installed dependency expectations are invalid',
      );
    }
    if (lockEntry.dev === true) {
      continue;
    }
    const installedRelativePath = parseInstalledLockPath(lockPath);
    const canonicalLockPath =
      process.platform === 'win32' ? lockPath.toLowerCase() : lockPath;
    if (canonicalLockPaths.has(canonicalLockPath)) {
      throw new DependencyTransitionError(
        'Installed dependency expectations are invalid',
      );
    }
    canonicalLockPaths.add(canonicalLockPath);
    if (
      lockEntry.link === true ||
      typeof lockEntry.version !== 'string' ||
      lockEntry.version.length === 0
    ) {
      throw new DependencyTransitionError(
        'Installed dependency expectations are invalid',
      );
    }
    const expected = expectedByLockPath.get(lockPath);
    if (expected) {
      includedExpectedPaths.add(lockPath);
    }
    definitions.push({
      lockPath,
      installedRelativePath,
      lockedVersion: lockEntry.version,
      optional: lockEntry.optional === true,
      expectation: expected?.expectation,
      expectedPackageName: expected?.packageName,
      reportKey: lockPath,
    });
  }
  if (
    [...expectedByLockPath.keys()].some(
      (lockPath) => !includedExpectedPaths.has(lockPath),
    )
  ) {
    throw new DependencyTransitionError(
      'Installed dependency expectations are invalid',
    );
  }
  return definitions;
};

const assertInstalledNodeModulesRoot = (installedNodeModulesPath) => {
  if (
    typeof installedNodeModulesPath !== 'string' ||
    installedNodeModulesPath.length === 0
  ) {
    throw new DependencyTransitionError(
      'Installed node_modules root is required',
    );
  }
  try {
    const stat = lstatSync(installedNodeModulesPath, { bigint: true });
    const nativePath = realpathSync.native(installedNodeModulesPath);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      canonicalPathKey(nativePath) !==
        canonicalPathKey(installedNodeModulesPath)
    ) {
      throw new DependencyTransitionError(
        'Installed node_modules root is unsafe',
      );
    }
    return nativePath;
  } catch (error) {
    if (error instanceof DependencyTransitionError) {
      throw error;
    }
    throw new DependencyTransitionError(
      'Installed node_modules root is unsafe',
    );
  }
};

const resolveInstalledPackageRoots = async (installedRoot, definitions) => {
  const resolvedDefinitions = await mapWithConcurrency(
    definitions,
    PHYSICAL_METADATA_CONCURRENCY,
    async (definition) => {
      const packagePath = join(
        installedRoot,
        ...definition.installedRelativePath.split('/'),
      );
      let stat;
      try {
        stat = await lstatAsync(packagePath, { bigint: true });
      } catch (error) {
        if (definition.optional && error?.code === 'ENOENT') {
          return undefined;
        }
        throw new DependencyTransitionError(
          'Installed runtime dependency is missing',
        );
      }
      if (stat.isSymbolicLink()) {
        throw new DependencyTransitionError(
          'Installed dependency tree contains a reparse point',
        );
      }
      if (!stat.isDirectory()) {
        throw new DependencyTransitionError(
          'Installed runtime dependency is missing',
        );
      }
      const packageRealPath = await realpathAsync(packagePath);
      const packageRelativePath = relative(installedRoot, packageRealPath);
      const normalizedRelativePath = packageRelativePath
        .split(pathSeparator)
        .join('/');
      const actualPathKey =
        process.platform === 'win32'
          ? normalizedRelativePath.toLowerCase()
          : normalizedRelativePath;
      const expectedPathKey =
        process.platform === 'win32'
          ? definition.installedRelativePath.toLowerCase()
          : definition.installedRelativePath;
      if (
        isAbsolute(packageRelativePath) ||
        packageRelativePath === '..' ||
        packageRelativePath.startsWith(`..${pathSeparator}`) ||
        actualPathKey !== expectedPathKey
      ) {
        throw new DependencyTransitionError(
          'Installed dependency path escapes node_modules',
        );
      }
      if (normalizedRelativePath !== definition.installedRelativePath) {
        throw new DependencyTransitionError(
          'Installed dependency path casing differs',
        );
      }
      return {
        ...definition,
        packageRoot: packageRealPath,
      };
    },
  );
  return resolvedDefinitions.filter(Boolean);
};

const resolveTrustedWindowsPowerShell = () => {
  try {
    const root = resolve(TRUSTED_WINDOWS_ROOT);
    const system32 = join(root, 'System32');
    const windowsPowerShell = join(system32, 'WindowsPowerShell');
    const versionRoot = join(windowsPowerShell, 'v1.0');
    const executable = join(versionRoot, 'powershell.exe');
    const directories = [root, system32, windowsPowerShell, versionRoot];
    for (const directory of directories) {
      const stat = lstatSync(directory, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new DependencyTransitionError(
          'Trusted Windows PowerShell is unavailable',
        );
      }
    }
    const executableStat = lstatSync(executable, { bigint: true });
    const executableRealPath = realpathSync.native(executable);
    if (
      !executableStat.isFile() ||
      executableStat.isSymbolicLink() ||
      canonicalPathKey(executableRealPath) !== canonicalPathKey(executable)
    ) {
      throw new DependencyTransitionError(
        'Trusted Windows PowerShell is unavailable',
      );
    }
    return executableRealPath;
  } catch (error) {
    if (error instanceof DependencyTransitionError) {
      throw error;
    }
    throw new DependencyTransitionError(
      'Trusted Windows PowerShell is unavailable',
    );
  }
};

const getTrustedWindowsPowerShellEnvironment = () => {
  const excluded = new Set([
    'systemroot',
    'windir',
    'comspec',
    'path',
    'psmodulepath',
  ]);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !excluded.has(name.toLowerCase()),
    ),
  );
  const system32 = join(TRUSTED_WINDOWS_ROOT, 'System32');
  const powerShellRoot = join(system32, 'WindowsPowerShell', 'v1.0');
  return {
    ...environment,
    SystemRoot: TRUSTED_WINDOWS_ROOT,
    windir: TRUSTED_WINDOWS_ROOT,
    ComSpec: join(system32, 'cmd.exe'),
    Path: [system32, join(system32, 'Wbem'), powerShellRoot].join(';'),
    PSModulePath: join(powerShellRoot, 'Modules'),
  };
};

const assertWindowsTreeSafety = (installedRoot, packageDefinitions) => {
  if (process.platform !== 'win32') {
    return;
  }
  const script = [
    '& {',
    "$ErrorActionPreference = 'Stop'",
    '$encodedPayload = [Console]::In.ReadToEnd().Trim()',
    'if ([string]::IsNullOrWhiteSpace($encodedPayload)) { exit 43 }',
    '$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPayload))',
    '$payload = $payloadJson | ConvertFrom-Json -ErrorAction Stop',
    '$rootPath = [string]$payload.rootPath',
    '$packagePaths = @($payload.packagePaths | ForEach-Object { [string]$_ })',
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Collections.Generic;',
    'using System.IO;',
    'using System.Runtime.InteropServices;',
    'public static class CodexDependencyStreamAudit {',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '  private struct FindStreamData {',
    '    public long StreamSize;',
    '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 296)]',
    '    public string StreamName;',
    '  }',
    '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  private static extern IntPtr FindFirstStreamW(string path, int level, out FindStreamData data, uint flags);',
    '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  private static extern bool FindNextStreamW(IntPtr handle, out FindStreamData data);',
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  private static extern bool FindClose(IntPtr handle);',
    '  public static int Audit(string path) {',
    '    FindStreamData data;',
    '    IntPtr handle = FindFirstStreamW(path, 0, out data, 0);',
    '    if (handle == new IntPtr(-1)) {',
    '      return Marshal.GetLastWin32Error() == 38 ? 0 : -1;',
    '    }',
    '    try {',
    '      while (true) {',
    '        if (!String.Equals(data.StreamName, "::$DATA", StringComparison.Ordinal)) { return 1; }',
    '        if (FindNextStreamW(handle, out data)) { continue; }',
    '        return Marshal.GetLastWin32Error() == 38 ? 0 : -1;',
    '      }',
    '    } finally { FindClose(handle); }',
    '  }',
    '  private static int AuditEntry(string path, out bool isDirectory) {',
    '    isDirectory = false;',
    '    FileAttributes attributes;',
    '    try { attributes = File.GetAttributes(path); } catch { return 43; }',
    '    if ((attributes & FileAttributes.ReparsePoint) != 0) { return 41; }',
    '    int streamResult = Audit(path);',
    '    if (streamResult == 1) { return 42; }',
    '    if (streamResult != 0) { return 43; }',
    '    isDirectory = (attributes & FileAttributes.Directory) != 0;',
    '    return 0;',
    '  }',
    '  public static int AuditTrees(string rootPath, string[] packagePaths, int maxEntries) {',
    '    bool rootIsDirectory;',
    '    int rootResult = AuditEntry(rootPath, out rootIsDirectory);',
    '    if (rootResult != 0) { return rootResult; }',
    '    if (!rootIsDirectory) { return 43; }',
    '    var pending = new Stack<string>();',
    '    for (int index = packagePaths.Length - 1; index >= 0; index--) { pending.Push(packagePaths[index]); }',
    '    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);',
    '    int auditedEntries = 0;',
    '    while (pending.Count > 0) {',
    '      string path = pending.Pop();',
    '      if (!seen.Add(path)) { continue; }',
    '      auditedEntries += 1;',
    '      if (auditedEntries > maxEntries) { return 44; }',
    '      bool isDirectory;',
    '      int result = AuditEntry(path, out isDirectory);',
    '      if (result != 0) { return result; }',
    '      if (!isDirectory) { continue; }',
    '      try {',
    '        foreach (string childPath in Directory.EnumerateFileSystemEntries(path)) { pending.Push(childPath); }',
    '      } catch { return 43; }',
    '    }',
    '    return 0;',
    '  }',
    '}',
    "'@",
    'try {',
    '  exit [CodexDependencyStreamAudit]::AuditTrees($rootPath, [string[]]$packagePaths, 250000)',
    '} catch { exit 43 }',
    '}',
  ].join('\n');
  const encodedPathPayload = Buffer.from(
    JSON.stringify({
      rootPath: installedRoot,
      packagePaths: packageDefinitions.map(
        (definition) => definition.packageRoot,
      ),
    }),
    'utf8',
  ).toString('base64');
  const result = spawnSync(
    resolveTrustedWindowsPowerShell(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: WINDOWS_TREE_AUDIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      env: getTrustedWindowsPowerShellEnvironment(),
      input: encodedPathPayload,
    },
  );
  if (result.status === 41) {
    throw new DependencyTransitionError(
      'Installed dependency tree contains a reparse point',
    );
  }
  if (result.status === 42) {
    throw new DependencyTransitionError(
      'Installed dependency tree contains an alternate data stream',
    );
  }
  if (result.status === 44) {
    throw new DependencyTransitionError(
      'Installed dependency tree exceeds safety limits',
    );
  }
  if (result.status !== 0) {
    throw new DependencyTransitionError(
      'Installed dependency tree safety verification failed',
    );
  }
};

const readStableInstalledFileDigest = async (
  filePath,
  pathStat,
  captureContent = false,
) => {
  let handle;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    handle = await openAsync(filePath, fsConstants.O_RDONLY | noFollow);
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      !sameFileIdentity(pathStat, before) ||
      !hasSingleLink(pathStat) ||
      !hasSingleLink(before)
    ) {
      if (!hasSingleLink(pathStat) || !hasSingleLink(before)) {
        throw new DependencyTransitionError(
          'Installed dependency tree contains a hard link',
        );
      }
      throw new DependencyTransitionError(
        'Installed dependency tree changed while being verified',
      );
    }
    if (before.size > BigInt(MAX_PHYSICAL_FILE_BYTES)) {
      throw new DependencyTransitionError(
        'Installed dependency tree exceeds safety limits',
      );
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(PHYSICAL_HASH_BUFFER_BYTES);
    const capturedChunks = captureContent ? [] : undefined;
    let bytesReadTotal = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        bytesReadTotal,
      );
      if (bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      if (capturedChunks) {
        capturedChunks.push(Buffer.from(chunk));
      }
      bytesReadTotal += bytesRead;
      if (bytesReadTotal > MAX_PHYSICAL_FILE_BYTES) {
        throw new DependencyTransitionError(
          'Installed dependency tree exceeds safety limits',
        );
      }
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstatAsync(filePath, { bigint: true });
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !hasSingleLink(after) ||
      !hasSingleLink(pathAfter) ||
      !sameFileSnapshot(before, after) ||
      !sameFileSnapshot(pathStat, pathAfter) ||
      !sameFileIdentity(pathAfter, after) ||
      after.size !== BigInt(bytesReadTotal)
    ) {
      if (!hasSingleLink(after) || !hasSingleLink(pathAfter)) {
        throw new DependencyTransitionError(
          'Installed dependency tree contains a hard link',
        );
      }
      throw new DependencyTransitionError(
        'Installed dependency tree changed while being verified',
      );
    }
    return {
      bytes: bytesReadTotal,
      hash: digest.digest('hex'),
      content: capturedChunks
        ? Buffer.concat(capturedChunks, bytesReadTotal)
        : undefined,
    };
  } catch (error) {
    if (error instanceof DependencyTransitionError) {
      throw error;
    }
    throw new DependencyTransitionError(
      'Installed dependency tree changed while being verified',
    );
  } finally {
    if (handle) {
      await handle.close();
    }
  }
};

const createPhysicalTreeBudget = () => ({ entries: 0, bytes: 0n });

const assertPhysicalExpectation = (expectation) => {
  if (
    expectation === undefined ||
    (typeof expectation.installedFingerprint === 'string' &&
      /^[0-9a-f]{64}$/.test(expectation.installedFingerprint) &&
      Number.isSafeInteger(expectation.installedEntryCount) &&
      expectation.installedEntryCount >= 0 &&
      Number.isSafeInteger(expectation.installedFileCount) &&
      expectation.installedFileCount >= 0 &&
      Number.isSafeInteger(expectation.installedBytes) &&
      expectation.installedBytes >= 0)
  ) {
    return;
  }
  throw new DependencyTransitionError(
    'Installed dependency expectations are invalid',
  );
};

const readDirectoryMetadata = async (directoryPath) => {
  try {
    const stat = await lstatAsync(directoryPath, { bigint: true });
    if (stat.isSymbolicLink()) {
      throw new DependencyTransitionError(
        'Installed dependency tree contains a reparse point',
      );
    }
    if (!stat.isDirectory()) {
      throw new DependencyTransitionError(
        'Installed dependency tree changed while being verified',
      );
    }
    return stat;
  } catch (error) {
    if (error instanceof DependencyTransitionError) {
      throw error;
    }
    throw new DependencyTransitionError(
      'Installed dependency tree changed while being verified',
    );
  }
};

const captureInstalledPackageMetadata = async (
  packageRoot,
  physicalTreeBudget,
) => {
  const entries = [
    {
      type: 'D',
      relativePath: '',
      stat: await readDirectoryMetadata(packageRoot),
    },
  ];
  const files = [];
  const visit = async (directoryPath, relativeDirectory = '', depth = 0) => {
    if (depth > MAX_PHYSICAL_TREE_DEPTH) {
      throw new DependencyTransitionError(
        'Installed dependency tree exceeds safety limits',
      );
    }
    let directory;
    try {
      directory = await opendirAsync(directoryPath);
    } catch {
      throw new DependencyTransitionError(
        'Installed dependency tree changed while being verified',
      );
    }
    const childDirectories = [];
    try {
      for await (const entry of directory) {
        physicalTreeBudget.entries += 1;
        if (physicalTreeBudget.entries > MAX_PHYSICAL_TREE_ENTRIES) {
          throw new DependencyTransitionError(
            'Installed dependency tree exceeds safety limits',
          );
        }
        const entryPath = join(directoryPath, entry.name);
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        const stat = await lstatAsync(entryPath, { bigint: true });
        if (stat.isSymbolicLink()) {
          throw new DependencyTransitionError(
            'Installed dependency tree contains a reparse point',
          );
        }
        if (stat.isDirectory()) {
          entries.push({ type: 'D', relativePath, stat });
          if (!(depth === 0 && entry.name === 'node_modules')) {
            childDirectories.push({ entryPath, relativePath });
          }
          continue;
        }
        if (!stat.isFile()) {
          throw new DependencyTransitionError(
            'Installed dependency tree contains an unsupported entry',
          );
        }
        if (!hasSingleLink(stat)) {
          throw new DependencyTransitionError(
            'Installed dependency tree contains a hard link',
          );
        }
        physicalTreeBudget.bytes += stat.size;
        if (
          stat.size > BigInt(MAX_PHYSICAL_FILE_BYTES) ||
          physicalTreeBudget.bytes > BigInt(MAX_PHYSICAL_TREE_BYTES)
        ) {
          throw new DependencyTransitionError(
            'Installed dependency tree exceeds safety limits',
          );
        }
        const file = { type: 'F', entryPath, relativePath, stat };
        entries.push(file);
        files.push(file);
      }
    } catch (error) {
      if (error instanceof DependencyTransitionError) {
        throw error;
      }
      throw new DependencyTransitionError(
        'Installed dependency tree changed while being verified',
      );
    }
    for (const child of childDirectories) {
      await visit(child.entryPath, child.relativePath, depth + 1);
    }
  };
  await visit(packageRoot);
  entries.sort((left, right) =>
    ordinalCompare(
      `${left.relativePath}\0${left.type}`,
      `${right.relativePath}\0${right.type}`,
    ),
  );
  files.sort((left, right) =>
    ordinalCompare(left.relativePath, right.relativePath),
  );
  return { entries, files };
};

const assertMetadataSnapshotsEqual = (before, after) => {
  if (before.entries.length !== after.entries.length) {
    throw new DependencyTransitionError(
      'Installed dependency tree changed while being verified',
    );
  }
  for (let index = 0; index < before.entries.length; index += 1) {
    const left = before.entries[index];
    const right = after.entries[index];
    if (
      left.type !== right.type ||
      left.relativePath !== right.relativePath ||
      !sameFileSnapshot(left.stat, right.stat)
    ) {
      if (!hasSingleLink(left.stat) || !hasSingleLink(right.stat)) {
        throw new DependencyTransitionError(
          'Installed dependency tree contains a hard link',
        );
      }
      throw new DependencyTransitionError(
        'Installed dependency tree changed while being verified',
      );
    }
  }
};

const parseInstalledPackageJson = (content) => {
  try {
    const parsed = JSON.parse(content.toString('utf8'));
    if (isPlainObject(parsed)) {
      return parsed;
    }
  } catch {
    // Normalize untrusted package metadata failures below.
  }
  throw new DependencyTransitionError(
    'Installed runtime dependency package metadata is invalid',
  );
};

const getMinimalWindowsAuditDefinitions = (definitions) => {
  const selected = [];
  for (const definition of [...definitions].sort(
    (left, right) => left.packageRoot.length - right.packageRoot.length,
  )) {
    const pathKey = canonicalPathKey(definition.packageRoot);
    if (
      selected.some((parent) =>
        pathKey.startsWith(
          `${canonicalPathKey(parent.packageRoot)}${pathSeparator}`,
        ),
      )
    ) {
      continue;
    }
    selected.push(definition);
  }
  return selected;
};

export const verifyInstalledRuntimeDependencyTree = async ({
  installedNodeModulesPath,
  expectedPackages,
  lockfileVersion,
  lockPackages,
}) => {
  const definitions = createInstalledPackageDefinitions({
    expectedPackages,
    lockfileVersion,
    lockPackages,
  });
  for (const definition of definitions) {
    assertPhysicalExpectation(definition.expectation);
  }
  const installedRoot = assertInstalledNodeModulesRoot(
    installedNodeModulesPath,
  );
  const resolvedDefinitions = await resolveInstalledPackageRoots(
    installedRoot,
    definitions,
  );
  const rootBefore = await readDirectoryMetadata(installedRoot);
  const beforeBudget = createPhysicalTreeBudget();
  const packageStates = await mapWithConcurrency(
    resolvedDefinitions,
    PHYSICAL_METADATA_CONCURRENCY,
    async (definition) => ({
      definition,
      before: await captureInstalledPackageMetadata(
        definition.packageRoot,
        beforeBudget,
      ),
      fileEntries: [],
      packageJsonContent: undefined,
    }),
  );

  const fileJobs = packageStates.flatMap((packageState) =>
    packageState.before.files.map((file, fileIndex) => ({
      packageState,
      file,
      fileIndex,
    })),
  );
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= fileJobs.length) {
        return;
      }
      const { packageState, file, fileIndex } = fileJobs[index];
      const captureContent = file.relativePath === 'package.json';
      const digest = await readStableInstalledFileDigest(
        file.entryPath,
        file.stat,
        captureContent,
      );
      packageState.fileEntries[fileIndex] =
        `F\0${file.relativePath}\0${digest.bytes}\0${digest.hash}\n`;
      if (captureContent) {
        packageState.packageJsonContent = digest.content;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(PHYSICAL_HASH_CONCURRENCY, fileJobs.length || 1) },
      () => worker(),
    ),
  );

  assertWindowsTreeSafety(
    installedRoot,
    getMinimalWindowsAuditDefinitions(resolvedDefinitions),
  );
  const afterBudget = createPhysicalTreeBudget();
  const afterSnapshots = await mapWithConcurrency(
    packageStates,
    PHYSICAL_METADATA_CONCURRENCY,
    (packageState) =>
      captureInstalledPackageMetadata(
        packageState.definition.packageRoot,
        afterBudget,
      ),
  );
  for (let index = 0; index < packageStates.length; index += 1) {
    assertMetadataSnapshotsEqual(
      packageStates[index].before,
      afterSnapshots[index],
    );
  }
  const rootAfter = await readDirectoryMetadata(installedRoot);
  if (
    !sameFileSnapshot(rootBefore, rootAfter) ||
    beforeBudget.entries !== afterBudget.entries ||
    beforeBudget.bytes !== afterBudget.bytes
  ) {
    throw new DependencyTransitionError(
      'Installed dependency tree changed while being verified',
    );
  }

  const packageProofs = {};
  const packageReport = {};
  let fileCount = 0;
  let totalBytes = 0;
  for (const packageState of packageStates) {
    const { definition, before, fileEntries, packageJsonContent } =
      packageState;
    if (!packageJsonContent) {
      throw new DependencyTransitionError(
        'Installed runtime dependency package metadata is invalid',
      );
    }
    const installedPackage = parseInstalledPackageJson(packageJsonContent);
    if (installedPackage.version !== definition.lockedVersion) {
      throw new DependencyTransitionError(
        'Installed runtime dependency version differs',
      );
    }
    const directoryEntries = before.entries
      .filter((entry) => entry.type === 'D' && entry.relativePath.length > 0)
      .map((entry) => `D\0${entry.relativePath}\n`);
    const entries = [...directoryEntries, ...fileEntries].sort(ordinalCompare);
    const bytes = before.files.reduce(
      (sum, file) => sum + Number(file.stat.size),
      0,
    );
    const actual = {
      fingerprint: createHash('sha256')
        .update(entries.join(''), 'utf8')
        .digest('hex'),
      entryCount: entries.length,
      fileCount: before.files.length,
      bytes,
    };
    if (
      definition.expectation &&
      (actual.fingerprint !== definition.expectation.installedFingerprint ||
        actual.entryCount !== definition.expectation.installedEntryCount ||
        actual.fileCount !== definition.expectation.installedFileCount ||
        actual.bytes !== definition.expectation.installedBytes)
    ) {
      throw new DependencyTransitionError(
        `Installed runtime dependency content differs: ${definition.expectedPackageName}`,
      );
    }
    packageReport[definition.reportKey] = actual;
    packageProofs[definition.lockPath] = {
      lockedVersion: definition.lockedVersion,
      ...actual,
    };
    fileCount += actual.fileCount;
    totalBytes += actual.bytes;
  }
  const fingerprint = createHash('sha256')
    .update(
      canonicalJson({
        proofAlgorithm: INSTALLED_PROOF_ALGORITHM,
        packages: packageProofs,
      }),
      'utf8',
    )
    .digest('hex');
  return {
    proofAlgorithm: INSTALLED_PROOF_ALGORITHM,
    fingerprint,
    packageCount: packageStates.length,
    fileCount,
    bytes: totalBytes,
    packages: packageReport,
  };
};

const snapshotQuickProofStat = (stat) => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
  mode: String(stat.mode),
  size: String(stat.size),
  mtimeNs: String(stat.mtimeNs),
  ctimeNs: String(stat.ctimeNs),
  birthtimeNs: String(stat.birthtimeNs),
  nlink: String(stat.nlink),
});

const hashStableFile = (filePath) => {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new DependencyTransitionError('Input must be a regular file');
  }
  if (process.platform === 'win32') {
    const root = parsePath(filePath).root;
    if (filePath.slice(root.length).includes(':')) {
      throw new DependencyTransitionError(
        'Input path must not use an alternate data stream',
      );
    }
  }

  let descriptor;
  try {
    const pathBefore = lstatSync(filePath, { bigint: true });
    if (
      !pathBefore.isFile() ||
      pathBefore.isSymbolicLink() ||
      !hasSingleLink(pathBefore)
    ) {
      throw new DependencyTransitionError('Input must be a regular file');
    }
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    descriptor = openSync(filePath, fsConstants.O_RDONLY | noFollow);
    const descriptorBefore = fstatSync(descriptor, { bigint: true });
    if (
      !descriptorBefore.isFile() ||
      !sameFileIdentity(pathBefore, descriptorBefore) ||
      !hasSingleLink(descriptorBefore) ||
      descriptorBefore.size <= 0n ||
      descriptorBefore.size > BigInt(MAX_STABLE_HASH_BYTES)
    ) {
      throw new DependencyTransitionError('Input must be a regular file');
    }

    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(STABLE_HASH_BUFFER_BYTES);
    let bytesRead = 0n;
    while (true) {
      const chunkLength = readSync(descriptor, buffer, 0, buffer.length, null);
      if (chunkLength === 0) break;
      bytesRead += BigInt(chunkLength);
      if (
        bytesRead > descriptorBefore.size ||
        bytesRead > BigInt(MAX_STABLE_HASH_BYTES)
      ) {
        throw new DependencyTransitionError('Input changed while being read');
      }
      digest.update(buffer.subarray(0, chunkLength));
    }

    const descriptorAfter = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(filePath, { bigint: true });
    if (
      bytesRead !== descriptorBefore.size ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      !hasSingleLink(descriptorAfter) ||
      !hasSingleLink(pathAfter) ||
      !sameFileSnapshot(descriptorBefore, descriptorAfter) ||
      !sameFileSnapshot(pathBefore, pathAfter) ||
      !sameFileIdentity(pathAfter, descriptorAfter)
    ) {
      throw new DependencyTransitionError('Input changed while being read');
    }
    return digest.digest('hex');
  } catch (error) {
    if (error instanceof DependencyTransitionError) {
      throw error;
    }
    throw new DependencyTransitionError('Input must be a regular file');
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
};

const optionalStableFileHash = (filePath) => {
  try {
    const stat = lstatSync(filePath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || !hasSingleLink(stat)) {
      throw new DependencyTransitionError(
        'Dependency proof anchor is not a safe regular file',
      );
    }
    return hashStableFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const assertSafeDependencyProofCachePath = (proofCachePath, installedRoot) => {
  if (typeof proofCachePath !== 'string' || !isAbsolute(proofCachePath)) {
    throw new DependencyTransitionError(
      'Dependency proof cache path must be absolute',
    );
  }
  const cachePath = resolve(proofCachePath);
  const cacheParent = dirname(cachePath);
  let parentStat;
  let parentRealPath;
  try {
    parentStat = lstatSync(cacheParent, { bigint: true });
    parentRealPath = realpathSync.native(cacheParent);
  } catch {
    throw new DependencyTransitionError(
      'Dependency proof cache directory is unavailable',
    );
  }
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    canonicalPathKey(parentRealPath) !== canonicalPathKey(cacheParent)
  ) {
    throw new DependencyTransitionError(
      'Dependency proof cache directory is unsafe',
    );
  }
  const relativeCachePath = relative(installedRoot, cachePath);
  if (
    relativeCachePath === '' ||
    (!relativeCachePath.startsWith(`..${pathSeparator}`) &&
      relativeCachePath !== '..' &&
      !isAbsolute(relativeCachePath))
  ) {
    throw new DependencyTransitionError(
      'Dependency proof cache must be outside node_modules',
    );
  }
  try {
    const cacheStat = lstatSync(cachePath, { bigint: true });
    if (
      !cacheStat.isFile() ||
      cacheStat.isSymbolicLink() ||
      !hasSingleLink(cacheStat) ||
      cacheStat.size > BigInt(MAX_DEPENDENCY_PROOF_CACHE_BYTES)
    ) {
      throw new DependencyTransitionError(
        'Dependency proof cache file is unsafe',
      );
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  return cachePath;
};

const buildDependencyProofQuickAnchors = async ({
  options,
  metadataDetails,
  definitions,
  installedRoot,
}) => {
  const resolvedDefinitions = await resolveInstalledPackageRoots(
    installedRoot,
    definitions,
  );
  const rootStat = lstatSync(installedRoot, { bigint: true });
  const nodePath = realpathSync.native(process.execPath);
  const nodeStat = lstatSync(nodePath, { bigint: true });
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    !nodeStat.isFile() ||
    nodeStat.isSymbolicLink() ||
    !hasSingleLink(nodeStat)
  ) {
    throw new DependencyTransitionError(
      'Dependency quick proof found an unsafe root or Node executable',
    );
  }

  const packageAnchors = await mapWithConcurrency(
    resolvedDefinitions,
    PHYSICAL_METADATA_CONCURRENCY,
    async (definition) => {
      const packageStat = await lstatAsync(definition.packageRoot, {
        bigint: true,
      });
      if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) {
        throw new DependencyTransitionError(
          'Dependency quick proof found an unsafe package root',
        );
      }
      const packageJsonPath = join(definition.packageRoot, 'package.json');
      const packageJsonContent = readStableRegularFile(packageJsonPath);
      const packageJson = parseInstalledPackageJson(packageJsonContent);
      if (
        packageJson.version !== definition.lockedVersion ||
        (definition.expectedPackageName !== undefined &&
          typeof packageJson.name === 'string' &&
          packageJson.name !== definition.expectedPackageName)
      ) {
        throw new DependencyTransitionError(
          'Installed runtime dependency version differs',
        );
      }
      return {
        lockPath: definition.lockPath,
        relativePath: definition.installedRelativePath,
        directory: snapshotQuickProofStat(packageStat),
        packageJsonSha256: createHash('sha256')
          .update(packageJsonContent)
          .digest('hex'),
      };
    },
  );

  const nativeRelativePaths = [
    '@rspack/binding-win32-x64-msvc/rspack.win32-x64-msvc.node',
    '@tailwindcss/oxide-win32-x64-msvc/tailwindcss-oxide.win32-x64-msvc.node',
    'lightningcss-win32-x64-msvc/lightningcss.win32-x64-msvc.node',
  ];
  const nativeAnchors = nativeRelativePaths.map((relativePath) => ({
    relativePath,
    sha256: optionalStableFileHash(
      join(installedRoot, ...relativePath.split('/')),
    ),
  }));
  const verifierPath = fileURLToPath(import.meta.url);
  const lockPath = join(dirname(installedRoot), 'package-lock.json');
  const packagePath = join(dirname(installedRoot), 'package.json');
  const baselinePackagePath = options?.baselinePackagePath;
  const baselineLockPath = options?.baselineLockPath;
  const candidatePackagePath = options?.candidatePackagePath;
  const candidateLockPath = options?.candidateLockPath;
  const fileHashes = {
    baselinePackageSha256: hashStableFile(baselinePackagePath),
    baselineLockSha256: hashStableFile(baselineLockPath),
    candidatePackageSha256: hashStableFile(candidatePackagePath),
    candidateLockSha256: hashStableFile(candidateLockPath),
    verifierSha256: hashStableFile(verifierPath),
    installedPackageLockSha256: optionalStableFileHash(
      join(installedRoot, '.package-lock.json'),
    ),
    packageLockSha256: hashStableFile(lockPath),
    packageSha256: hashStableFile(packagePath),
  };
  const anchors = {
    schemaVersion: DEPENDENCY_PROOF_CACHE_SCHEMA,
    proofAlgorithm: INSTALLED_PROOF_ALGORITHM,
    installedRoot: canonicalPathKey(installedRoot),
    installedRootStat: snapshotQuickProofStat(rootStat),
    nodeExecutable: canonicalPathKey(nodePath),
    nodeStat: snapshotQuickProofStat(nodeStat),
    nodeVersion: process.version,
    lockPhysicalTreeFingerprint:
      metadataDetails.report.lockPhysicalTreeFingerprint,
    fileHashes,
    packageAnchors: packageAnchors.sort((left, right) =>
      ordinalCompare(left.lockPath, right.lockPath),
    ),
    nativeAnchors,
  };
  return {
    anchors,
    presentDefinitions: resolvedDefinitions,
    fingerprint: createHash('sha256')
      .update(canonicalJson(anchors), 'utf8')
      .digest('hex'),
  };
};

const assertCachedPhysicalProof = (
  physicalProof,
  definitions,
  lockPhysicalTreeFingerprint,
) => {
  if (
    !isPlainObject(physicalProof) ||
    physicalProof.proofAlgorithm !== INSTALLED_PROOF_ALGORITHM ||
    !/^[a-f0-9]{64}$/u.test(physicalProof.fingerprint) ||
    physicalProof.packageCount !== definitions.length ||
    !Number.isSafeInteger(physicalProof.fileCount) ||
    physicalProof.fileCount < 0 ||
    !Number.isSafeInteger(physicalProof.bytes) ||
    physicalProof.bytes < 0 ||
    !isPlainObject(physicalProof.packages) ||
    !isPlainObject(physicalProof.proofPackages)
  ) {
    throw new DependencyTransitionError(
      'Dependency proof cache report is invalid',
    );
  }
  const expectedKeys = definitions.map((definition) => definition.reportKey);
  if (
    !isDeepEqual(
      Object.keys(physicalProof.packages).sort(),
      [...expectedKeys].sort(),
    ) ||
    !isDeepEqual(
      Object.keys(physicalProof.proofPackages).sort(),
      definitions.map((definition) => definition.lockPath).sort(),
    )
  ) {
    throw new DependencyTransitionError(
      'Dependency proof cache package set differs',
    );
  }
  let fileCount = 0;
  let bytes = 0;
  for (const definition of definitions) {
    const reportEntry = physicalProof.packages[definition.reportKey];
    const proofEntry = physicalProof.proofPackages[definition.lockPath];
    if (
      !isPlainObject(reportEntry) ||
      !isPlainObject(proofEntry) ||
      proofEntry.lockedVersion !== definition.lockedVersion ||
      proofEntry.fingerprint !== reportEntry.fingerprint ||
      proofEntry.entryCount !== reportEntry.entryCount ||
      proofEntry.fileCount !== reportEntry.fileCount ||
      proofEntry.bytes !== reportEntry.bytes ||
      !/^[a-f0-9]{64}$/u.test(reportEntry.fingerprint) ||
      !Number.isSafeInteger(reportEntry.entryCount) ||
      !Number.isSafeInteger(reportEntry.fileCount) ||
      !Number.isSafeInteger(reportEntry.bytes)
    ) {
      throw new DependencyTransitionError(
        'Dependency proof cache package detail is invalid',
      );
    }
    fileCount += reportEntry.fileCount;
    bytes += reportEntry.bytes;
  }
  const fingerprint = createHash('sha256')
    .update(
      canonicalJson({
        proofAlgorithm: INSTALLED_PROOF_ALGORITHM,
        packages: physicalProof.proofPackages,
      }),
      'utf8',
    )
    .digest('hex');
  if (
    fileCount !== physicalProof.fileCount ||
    bytes !== physicalProof.bytes ||
    fingerprint !== physicalProof.fingerprint ||
    physicalProof.lockPhysicalTreeFingerprint !== lockPhysicalTreeFingerprint
  ) {
    throw new DependencyTransitionError(
      'Dependency proof cache checksum or lock fingerprint differs',
    );
  }
  return {
    proofAlgorithm: physicalProof.proofAlgorithm,
    fingerprint: physicalProof.fingerprint,
    packageCount: physicalProof.packageCount,
    fileCount: physicalProof.fileCount,
    bytes: physicalProof.bytes,
    packages: physicalProof.packages,
  };
};

const readDependencyProofCache = (
  cachePath,
  quickFingerprint,
  definitions,
  lockPhysicalTreeFingerprint,
) => {
  let content;
  try {
    content = readStableRegularFile(cachePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return undefined;
    }
    return undefined;
  }
  if (content.length > MAX_DEPENDENCY_PROOF_CACHE_BYTES) {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(content.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.payload)) {
    return undefined;
  }
  const { checksum, ...envelopeRest } = parsed;
  const payload = envelopeRest.payload;
  if (
    typeof checksum !== 'string' ||
    createHash('sha256')
      .update(canonicalJson(payload), 'utf8')
      .digest('hex') !== checksum ||
    payload.schemaVersion !== DEPENDENCY_PROOF_CACHE_SCHEMA ||
    payload.quickFingerprint !== quickFingerprint ||
    typeof payload.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(payload.createdAt)) ||
    Date.now() - Date.parse(payload.createdAt) > DEPENDENCY_PROOF_CACHE_TTL_MS
  ) {
    return undefined;
  }
  try {
    return assertCachedPhysicalProof(
      payload.physicalProof,
      definitions,
      lockPhysicalTreeFingerprint,
    );
  } catch {
    return undefined;
  }
};

const writeDependencyProofCache = (
  cachePath,
  quickFingerprint,
  physicalProof,
  definitions,
  lockPhysicalTreeFingerprint,
) => {
  const proofPackages = Object.fromEntries(
    definitions.map((definition) => {
      const reportEntry = physicalProof.packages[definition.reportKey];
      return [
        definition.lockPath,
        {
          lockedVersion: definition.lockedVersion,
          fingerprint: reportEntry.fingerprint,
          entryCount: reportEntry.entryCount,
          fileCount: reportEntry.fileCount,
          bytes: reportEntry.bytes,
        },
      ];
    }),
  );
  const body = {
    schemaVersion: DEPENDENCY_PROOF_CACHE_SCHEMA,
    createdAt: new Date().toISOString(),
    quickFingerprint,
    physicalProof: {
      ...physicalProof,
      lockPhysicalTreeFingerprint,
      proofPackages,
    },
  };
  const envelope = {
    payload: body,
    checksum: createHash('sha256')
      .update(canonicalJson(body), 'utf8')
      .digest('hex'),
  };
  const temporaryPath = join(
    dirname(cachePath),
    `.dependency-proof-${randomUUID()}.tmp`,
  );
  const descriptor = openSync(temporaryPath, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${canonicalJson(envelope)}\n`, 'utf8');
    closeSync(descriptor);
    try {
      renameSync(temporaryPath, cachePath);
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') {
        throw error;
      }
      unlinkSync(cachePath);
      renameSync(temporaryPath, cachePath);
    }
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // Best-effort close after an earlier write/close failure.
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // A missing temporary file is already clean.
    }
    throw new DependencyTransitionError(
      'Dependency proof cache could not be written safely',
    );
  }
};

const verifyHotfixDependencyMetadataTransitionDetails = ({
  baselinePackagePath,
  baselineLockPath,
  candidatePackagePath,
  candidateLockPath,
}) => {
  const baselinePackage = readJsonObject(baselinePackagePath);
  const baselineLock = readJsonObject(baselineLockPath);
  const candidatePackage = readJsonObject(candidatePackagePath);
  const candidateLock = readJsonObject(candidateLockPath);

  assertPackageScriptTransition(baselinePackage, candidatePackage);
  const packageTransition = determineDeclarationTransition(
    baselinePackage,
    candidatePackage,
  );
  if (
    !isDeepEqual(
      withoutPackageTransitionFields(baselinePackage),
      withoutPackageTransitionFields(candidatePackage),
    )
  ) {
    throw new DependencyTransitionError(
      'Package metadata differs outside the allowed transition',
    );
  }

  const baselinePackages = getLockPackages(baselineLock);
  const candidatePackages = getLockPackages(candidateLock);
  const physicalEntries = {};
  for (const [packageName, specification] of Object.entries(
    TRANSITION_PACKAGES,
  )) {
    physicalEntries[packageName] = validatePhysicalEntry(
      packageName,
      specification,
      baselinePackages,
      candidatePackages,
    );
  }
  let lockTransition;
  try {
    lockTransition = determineDeclarationTransition(
      getRootLockPackage(baselinePackages),
      getRootLockPackage(candidatePackages),
    );
  } catch {
    throw new DependencyTransitionError(
      'Root lock dependency transition does not match package.json',
    );
  }
  if (!isDeepEqual(lockTransition, packageTransition)) {
    throw new DependencyTransitionError(
      'Root lock dependency transition does not match package.json',
    );
  }
  if (
    !isDeepEqual(
      withoutLockTransitionFields(baselineLock),
      withoutLockTransitionFields(candidateLock),
    )
  ) {
    throw new DependencyTransitionError(
      'Package lock differs outside the allowed transition',
    );
  }

  const packageReport = Object.fromEntries(
    Object.entries(TRANSITION_PACKAGES).map(([packageName, specification]) => [
      packageName,
      {
        declaration: specification.declaration,
        lockedVersion: physicalEntries[packageName].version,
        lockedIntegrity: physicalEntries[packageName].integrity,
      },
    ]),
  );
  return {
    report: {
      metadataVerified: true,
      transition:
        packageTransition.length === 0
          ? 'none'
          : 'runtime-root-declarations-only',
      packages: packageReport,
      lockPhysicalTreeFingerprint:
        getPhysicalTreeFingerprint(candidatePackages),
    },
    candidateLock,
    candidatePackages,
  };
};

export const verifyHotfixDependencyMetadataTransition = (options) =>
  verifyHotfixDependencyMetadataTransitionDetails(options).report;

export const verifyHotfixDependencyTransition = async (options) => {
  const metadataDetails =
    verifyHotfixDependencyMetadataTransitionDetails(options);
  const expectedPackages = options?.expectedPackages ?? TRANSITION_PACKAGES;
  const definitions = createInstalledPackageDefinitions({
    expectedPackages,
    lockfileVersion: metadataDetails.candidateLock.lockfileVersion,
    lockPackages: metadataDetails.candidatePackages,
  });
  let installedPhysicalTree;
  let proofCache;
  if (options?.proofCachePath !== undefined) {
    const installedRoot = assertInstalledNodeModulesRoot(
      options?.installedNodeModulesPath,
    );
    const cachePath = assertSafeDependencyProofCachePath(
      options.proofCachePath,
      installedRoot,
    );
    const quickState = await buildDependencyProofQuickAnchors({
      options,
      metadataDetails,
      definitions,
      installedRoot,
    });
    installedPhysicalTree = readDependencyProofCache(
      cachePath,
      quickState.fingerprint,
      quickState.presentDefinitions,
      metadataDetails.report.lockPhysicalTreeFingerprint,
    );
    if (installedPhysicalTree) {
      proofCache = {
        status: 'hit',
        verification: 'quick-anchors',
      };
    } else {
      installedPhysicalTree = await verifyInstalledRuntimeDependencyTree({
        installedNodeModulesPath: installedRoot,
        expectedPackages,
        lockfileVersion: metadataDetails.candidateLock.lockfileVersion,
        lockPackages: metadataDetails.candidatePackages,
      });
      const quickStateAfter = await buildDependencyProofQuickAnchors({
        options,
        metadataDetails,
        definitions,
        installedRoot,
      });
      if (quickStateAfter.fingerprint !== quickState.fingerprint) {
        throw new DependencyTransitionError(
          'Installed dependency quick proof changed during full verification',
        );
      }
      writeDependencyProofCache(
        cachePath,
        quickStateAfter.fingerprint,
        installedPhysicalTree,
        quickStateAfter.presentDefinitions,
        metadataDetails.report.lockPhysicalTreeFingerprint,
      );
      proofCache = {
        status: 'miss',
        verification: 'full-scan',
      };
    }
  } else {
    installedPhysicalTree = await verifyInstalledRuntimeDependencyTree({
      installedNodeModulesPath: options?.installedNodeModulesPath,
      expectedPackages,
      lockfileVersion: metadataDetails.candidateLock.lockfileVersion,
      lockPackages: metadataDetails.candidatePackages,
    });
  }

  return {
    success: true,
    ...metadataDetails.report,
    physicalVerified: true,
    requiresNodeModulesMutation: false,
    proofAlgorithm: installedPhysicalTree.proofAlgorithm,
    installedPhysicalTreeFingerprint: installedPhysicalTree.fingerprint,
    packageCount: installedPhysicalTree.packageCount,
    fileCount: installedPhysicalTree.fileCount,
    bytes: installedPhysicalTree.bytes,
    ...(proofCache ? { proofCache } : {}),
  };
};

const parseCliArguments = (argv) => {
  const accepted = new Map([
    ['--baseline-package', 'baselinePackagePath'],
    ['--baseline-lock', 'baselineLockPath'],
    ['--candidate-package', 'candidatePackagePath'],
    ['--candidate-lock', 'candidateLockPath'],
    ['--installed-node-modules', 'installedNodeModulesPath'],
    ['--proof-cache', 'proofCachePath'],
  ]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const key = accepted.get(option);
    const value = argv[index + 1];
    if (!key || typeof value !== 'string' || value.startsWith('--')) {
      throw new DependencyTransitionError('Invalid command arguments');
    }
    if (Object.hasOwn(result, key)) {
      throw new DependencyTransitionError('Invalid command arguments');
    }
    result[key] = value;
  }
  if (
    argv.length % 2 !== 0 ||
    [...accepted.keys()]
      .filter((option) => option !== '--proof-cache')
      .some((option) => !Object.hasOwn(result, accepted.get(option))) ||
    Object.keys(result).length < accepted.size - 1 ||
    Object.keys(result).length > accepted.size
  ) {
    throw new DependencyTransitionError('Invalid command arguments');
  }
  return result;
};

const isCliInvocation = (() => {
  if (typeof process.argv[1] !== 'string') {
    return false;
  }
  try {
    return (
      canonicalPathKey(realpathSync.native(process.argv[1])) ===
      canonicalPathKey(realpathSync.native(fileURLToPath(import.meta.url)))
    );
  } catch {
    return false;
  }
})();

if (isCliInvocation) {
  try {
    const report = await verifyHotfixDependencyTransition(
      parseCliArguments(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    const message =
      error instanceof DependencyTransitionError
        ? error.message
        : 'Dependency transition verification failed';
    process.stderr.write(
      `${JSON.stringify({ success: false, error: message })}\n`,
    );
    process.exitCode = 1;
  }
}
