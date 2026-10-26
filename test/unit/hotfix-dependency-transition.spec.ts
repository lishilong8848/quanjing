import { spawnSync } from 'node:child_process';
import {
  cpSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const verifierPath = resolve(
  __dirname,
  '../../scripts/verify-hotfix-dependency-transition.mjs',
);
const verifierModuleUrl = `file:///${verifierPath.replace(/\\/g, '/')}`;
const fflateIntegrity =
  'sha512-cPJU47OaAoCbg0pBvzsgpTPhmhqI5eJjh/JIu8tPj5q+T7iLvW/JAYUqmE7KOB4R1ZyEhzBaIQpQpardBF5z8A==';
const multerIntegrity =
  'sha512-u7f2xaZ/UG8oLXHvtF/oWTRvT44p9ecwBBqTwgJVq0+4BW1g8OW01TyMEGWBHbyMOYVHXslaut7qEQ1meATXgw==';
const rxjsIntegrity =
  'sha512-dhKf903U/PQZY6boNNtAGdWbG85WAbjT/1xYoZIC7FAY0yWapOBQVsVrDl58W86//e1VpMNBtRV4MaXfdMySFA==';
const projectNodeModulesPath = resolve(__dirname, '../../node_modules');
const runtimePackageNames = ['fflate', 'multer', 'rxjs'] as const;
const miniaturePhysicalSpecifications = {
  fflate: {
    lockedVersion: '0.8.2',
    installedFingerprint:
      'a5f335fb6d3447219f5d898f30eddcfaeb54fd7ab20d65b4f92ef8f2bb24c9c8',
    installedEntryCount: 4,
    installedFileCount: 3,
    installedBytes: 101,
  },
  multer: {
    lockedVersion: '2.0.2',
    installedFingerprint:
      'cc8c92101434b0ca1a4e2b50165b0b48c0368957ce9c0a2f70450c7880fa4573',
    installedEntryCount: 4,
    installedFileCount: 3,
    installedBytes: 101,
  },
  rxjs: {
    lockedVersion: '7.8.2',
    installedFingerprint:
      '3f362364fe0087cbf92b65474dae2fa3385b1fe5643e533604660695353f383f',
    installedEntryCount: 4,
    installedFileCount: 3,
    installedBytes: 95,
  },
};

jest.setTimeout(120_000);

type JsonObject = Record<string, any>;

interface Fixture {
  root: string;
  baselinePackagePath: string;
  baselineLockPath: string;
  candidatePackagePath: string;
  candidateLockPath: string;
  installedNodeModulesPath: string;
  baselinePackage: JsonObject;
  baselineLock: JsonObject;
  candidatePackage: JsonObject;
  candidateLock: JsonObject;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const writeJson = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

const createMiniatureInstalledPackages = (root: string) => {
  const installedNodeModulesPath = join(root, 'node_modules');
  mkdirSync(installedNodeModulesPath);
  const versions = { fflate: '0.8.2', multer: '2.0.2', rxjs: '7.8.2' };
  for (const packageName of runtimePackageNames) {
    const packagePath = join(installedNodeModulesPath, packageName);
    mkdirSync(join(packagePath, 'lib'), { recursive: true });
    writeJson(join(packagePath, 'package.json'), {
      name: packageName,
      version: versions[packageName],
      main: 'index.js',
    });
    writeFileSync(
      join(packagePath, 'index.js'),
      `module.exports = '${packageName}';\n`,
      'utf8',
    );
    writeFileSync(
      join(packagePath, 'lib', 'helper.txt'),
      `${packageName}\n`,
      'utf8',
    );
  }
  return installedNodeModulesPath;
};

const createMiniatureInstalledPackage = (
  installedNodeModulesPath: string,
  relativePackagePath: string,
  packageName: string,
  version: string,
) => {
  const packagePath = join(
    installedNodeModulesPath,
    ...relativePackagePath.split('/'),
  );
  mkdirSync(packagePath, { recursive: true });
  writeJson(join(packagePath, 'package.json'), {
    name: packageName,
    version,
    main: 'index.js',
  });
  writeFileSync(
    join(packagePath, 'index.js'),
    `module.exports = '${packageName}';\n`,
    'utf8',
  );
};

const createProductionClosureFixture = (
  fixture: Fixture,
  lockfileVersion: 2 | 3,
) => {
  createMiniatureInstalledPackage(
    fixture.installedNodeModulesPath,
    'ordinary-production',
    'ordinary-production',
    '1.0.0',
  );
  createMiniatureInstalledPackage(
    fixture.installedNodeModulesPath,
    'ordinary-production/node_modules/nested-production',
    'nested-production',
    '2.0.0',
  );
  createMiniatureInstalledPackage(
    fixture.installedNodeModulesPath,
    'development-only',
    'development-only',
    '3.0.0',
  );

  return {
    lockfileVersion,
    lockPackages: {
      '': {
        dependencies: {
          fflate: '^0.8.2',
          multer: '2.0.2',
          'ordinary-production': '1.0.0',
          rxjs: '^7.8.2',
        },
        devDependencies: {
          'development-only': '3.0.0',
        },
      },
      'node_modules/fflate': {
        version: '0.8.2',
      },
      'node_modules/multer': {
        version: '2.0.2',
      },
      'node_modules/ordinary-production': {
        version: '1.0.0',
        dependencies: {
          'nested-production': '2.0.0',
        },
      },
      'node_modules/ordinary-production/node_modules/nested-production': {
        version: '2.0.0',
      },
      'node_modules/rxjs': {
        version: '7.8.2',
      },
      'node_modules/development-only': {
        version: '3.0.0',
        dev: true,
      },
    },
  };
};

const createFixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'hotfix-dependency-transition-'));
  const baselinePackagePath = join(root, 'baseline-package.json');
  const baselineLockPath = join(root, 'baseline-package-lock.json');
  const candidatePackagePath = join(root, 'candidate-package.json');
  const candidateLockPath = join(root, 'candidate-package-lock.json');
  const installedNodeModulesPath = createMiniatureInstalledPackages(root);
  const baselinePackage = {
    name: 'fixture-app',
    version: '1.0.0',
    private: true,
    scripts: {
      preinstall: 'node scripts/preinstall.mjs',
      install: 'node scripts/install.mjs',
      postinstall: 'node scripts/postinstall.mjs',
      'migrate:overtime-workflow-fields:check':
        'node scripts/run-with-env.mjs node scripts/ensure-overtime-workflow-fields.mjs --require-ready',
      start: 'node dist/server/main.js',
      test: 'jest',
    },
    dependencies: {
      axios: '^1.7.0',
    },
    devDependencies: {
      jest: '^29.7.0',
      rxjs: '^7.8.2',
    },
  };
  const baselineLock = {
    name: 'fixture-app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'fixture-app',
        version: '1.0.0',
        dependencies: {
          axios: '^1.7.0',
        },
        devDependencies: {
          jest: '^29.7.0',
          rxjs: '^7.8.2',
        },
      },
      'node_modules/axios': {
        version: '1.19.0',
        resolved: 'https://registry.example.invalid/axios-1.19.0.tgz',
        integrity:
          'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
      },
      'node_modules/append-field': {
        version: '1.0.0',
      },
      'node_modules/busboy': {
        version: '1.6.0',
      },
      'node_modules/fflate': {
        version: '0.8.2',
        resolved: 'https://registry.example.invalid/fflate-0.8.2.tgz',
        integrity: fflateIntegrity,
        license: 'MIT',
      },
      'node_modules/multer': {
        version: '2.0.2',
        resolved: 'https://registry.example.invalid/multer-2.0.2.tgz',
        integrity: multerIntegrity,
        dependencies: {
          'append-field': '^1.0.0',
          busboy: '^1.6.0',
        },
      },
      'node_modules/rxjs': {
        version: '7.8.2',
        resolved: 'https://registry.example.invalid/rxjs-7.8.2.tgz',
        integrity: rxjsIntegrity,
        dependencies: {
          tslib: '^2.1.0',
        },
      },
      'node_modules/tslib': {
        version: '2.8.1',
      },
      'node_modules/jest': {
        version: '29.7.0',
        dev: true,
        integrity:
          'sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==',
      },
    },
  };
  const candidatePackage = clone(baselinePackage);
  candidatePackage.dependencies.fflate = '^0.8.2';
  candidatePackage.dependencies.multer = '2.0.2';
  candidatePackage.dependencies.rxjs = '^7.8.2';
  delete candidatePackage.devDependencies.rxjs;
  const candidateLock = clone(baselineLock);
  candidateLock.packages[''].dependencies.fflate = '^0.8.2';
  candidateLock.packages[''].dependencies.multer = '2.0.2';
  candidateLock.packages[''].dependencies.rxjs = '^7.8.2';
  delete candidateLock.packages[''].devDependencies.rxjs;

  const fixture: Fixture = {
    root,
    baselinePackagePath,
    baselineLockPath,
    candidatePackagePath,
    candidateLockPath,
    installedNodeModulesPath,
    baselinePackage,
    baselineLock,
    candidatePackage,
    candidateLock,
  };
  persistFixture(fixture);
  return fixture;
};

const persistFixture = (fixture: Fixture) => {
  writeJson(fixture.baselinePackagePath, fixture.baselinePackage);
  writeJson(fixture.baselineLockPath, fixture.baselineLock);
  writeJson(fixture.candidatePackagePath, fixture.candidatePackage);
  writeJson(fixture.candidateLockPath, fixture.candidateLock);
};

const runVerifier = (
  fixture: Fixture,
  executable = process.execPath,
  scriptPath = verifierPath,
  proofCachePath?: string,
) =>
  spawnSync(
    executable,
    [
      scriptPath,
      '--baseline-package',
      fixture.baselinePackagePath,
      '--baseline-lock',
      fixture.baselineLockPath,
      '--candidate-package',
      fixture.candidatePackagePath,
      '--candidate-lock',
      fixture.candidateLockPath,
      '--installed-node-modules',
      fixture.installedNodeModulesPath,
      ...(proofCachePath ? ['--proof-cache', proofCachePath] : []),
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );

const prepareProofCacheFixture = (fixture: Fixture) => {
  for (const [lockPath, entry] of Object.entries(
    fixture.candidateLock.packages,
  )) {
    if (lockPath === '' || (entry as JsonObject).dev === true) {
      continue;
    }
    const relativePackagePath = lockPath.slice('node_modules/'.length);
    const packagePath = join(
      fixture.installedNodeModulesPath,
      ...relativePackagePath.split('/'),
    );
    if (
      ['fflate', 'multer', 'rxjs'].some(
        (packageName) => relativePackagePath === packageName,
      )
    ) {
      continue;
    }
    if (!existsSync(join(packagePath, 'package.json'))) {
      mkdirSync(packagePath, { recursive: true });
      const nestedNodeModulesIndex =
        relativePackagePath.lastIndexOf('/node_modules/');
      const packageName =
        nestedNodeModulesIndex >= 0
          ? relativePackagePath.slice(
              nestedNodeModulesIndex + '/node_modules/'.length,
            )
          : relativePackagePath;
      writeJson(join(packagePath, 'package.json'), {
        name: packageName,
        version: (entry as JsonObject).version,
        main: 'index.js',
      });
      writeFileSync(join(packagePath, 'index.js'), 'module.exports = 1;\n');
    }
  }
  writeJson(join(fixture.root, 'package.json'), fixture.candidatePackage);
  writeJson(join(fixture.root, 'package-lock.json'), fixture.candidateLock);
  writeJson(join(fixture.installedNodeModulesPath, '.package-lock.json'), {
    lockfileVersion: 3,
    packages: {},
  });
};

interface ExportedVerifierSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const runExportedVerifier = (
  exportName: string,
  options: unknown,
  spawnOptions: ExportedVerifierSpawnOptions = {},
) => {
  const invocation = [
    `import(${JSON.stringify(verifierModuleUrl)})`,
    `.then(async (module) => { const result = await module[${JSON.stringify(
      exportName,
    )}](${JSON.stringify(options)}); process.stdout.write(JSON.stringify(result) + '\\n'); })`,
    ".catch((error) => { process.stderr.write(JSON.stringify({ success: false, error: error?.message || 'verification failed' }) + '\\n'); process.exit(1); });",
  ].join('');
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', invocation],
    { encoding: 'utf8', windowsHide: true, ...spawnOptions },
  );
};

const runBoundedConcurrencyProbe = () => {
  const invocation = [
    `import(${JSON.stringify(verifierModuleUrl)})`,
    ".then(async (module) => { let active = 0; let maximumActive = 0; const result = await module.mapWithConcurrency([30, 5, 20, 10], 2, async (delay, index) => { active += 1; maximumActive = Math.max(maximumActive, active); await new Promise((resolveWait) => setTimeout(resolveWait, delay)); active -= 1; return `${index}:${delay}`; }); process.stdout.write(JSON.stringify({ result, maximumActive }) + '\\n'); })",
    ".catch((error) => { process.stderr.write(JSON.stringify({ success: false, error: error?.message || 'verification failed' }) + '\\n'); process.exit(1); });",
  ].join('');
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', invocation],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
};

const runBoundedConcurrencyFailureProbe = () => {
  const invocation = [
    `import(${JSON.stringify(verifierModuleUrl)})`,
    ".then(async (module) => { let active = 0; try { await module.mapWithConcurrency([5, 60, 60], 2, async (delay, index) => { active += 1; try { await new Promise((resolveWait) => setTimeout(resolveWait, delay)); if (index === 0) throw new Error('expected failure'); return index; } finally { active -= 1; } }); } catch (error) { process.stdout.write(JSON.stringify({ active, error: error.message }) + '\\n'); } })",
    ".catch((error) => { process.stderr.write(JSON.stringify({ success: false, error: error?.message || 'verification failed' }) + '\\n'); process.exit(1); });",
  ].join('');
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', invocation],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
};

const runMetadataVerifier = (fixture: Fixture) => {
  persistFixture(fixture);
  return runExportedVerifier('verifyHotfixDependencyMetadataTransition', {
    baselinePackagePath: fixture.baselinePackagePath,
    baselineLockPath: fixture.baselineLockPath,
    candidatePackagePath: fixture.candidatePackagePath,
    candidateLockPath: fixture.candidateLockPath,
  });
};

const runPhysicalVerifier = (
  fixture: Fixture,
  spawnOptions: ExportedVerifierSpawnOptions = {},
) =>
  runExportedVerifier(
    'verifyInstalledRuntimeDependencyTree',
    {
      installedNodeModulesPath: fixture.installedNodeModulesPath,
      expectedPackages: miniaturePhysicalSpecifications,
    },
    spawnOptions,
  );

const runProductionClosureVerifier = (
  fixture: Fixture,
  lockfileVersion: 2 | 3,
  closure = createProductionClosureFixture(fixture, lockfileVersion),
) => {
  return runExportedVerifier('verifyInstalledRuntimeDependencyTree', {
    installedNodeModulesPath: fixture.installedNodeModulesPath,
    expectedPackages: miniaturePhysicalSpecifications,
    ...closure,
  });
};

const runCachedVerifier = (fixture: Fixture, proofCachePath: string) => {
  persistFixture(fixture);
  return runExportedVerifier('verifyHotfixDependencyTransition', {
    baselinePackagePath: fixture.baselinePackagePath,
    baselineLockPath: fixture.baselineLockPath,
    candidatePackagePath: fixture.candidatePackagePath,
    candidateLockPath: fixture.candidateLockPath,
    installedNodeModulesPath: fixture.installedNodeModulesPath,
    expectedPackages: miniaturePhysicalSpecifications,
    proofCachePath,
  });
};

const runPhysicalVerifierAfterSystemRootMutation = (
  fixture: Fixture,
  fakeSystemRoot: string,
) => {
  const options = {
    installedNodeModulesPath: fixture.installedNodeModulesPath,
    expectedPackages: miniaturePhysicalSpecifications,
  };
  const invocation = [
    `import(${JSON.stringify(verifierModuleUrl)})`,
    `.then(async (module) => { process.env.SystemRoot = ${JSON.stringify(
      fakeSystemRoot,
    )}; const result = await module.verifyInstalledRuntimeDependencyTree(${JSON.stringify(
      options,
    )}); process.stdout.write(JSON.stringify(result) + '\\n'); })`,
    ".catch((error) => { process.stderr.write(JSON.stringify({ success: false, error: error?.message || 'verification failed' }) + '\\n'); process.exit(1); });",
  ].join('');
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', invocation],
    { encoding: 'utf8', windowsHide: true },
  );
};

const parseSingleJsonDocument = (result: ReturnType<typeof spawnSync>) => {
  const lines = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
};

const expectRejected = (fixture: Fixture, expectedMessage: string) => {
  persistFixture(fixture);
  const result = runVerifier(fixture);
  expect(result.status).not.toBe(0);
  const output = `${result.stdout}\n${result.stderr}`;
  expect(parseSingleJsonDocument(result)).toMatchObject({ success: false });
  expect(output).toContain(expectedMessage);
  expect(output).not.toContain(fixture.root);
};

const expectPhysicalRejected = (fixture: Fixture, expectedMessage: string) => {
  const result = runPhysicalVerifier(fixture);
  expect(result.status).not.toBe(0);
  const output = `${result.stdout}\n${result.stderr}`;
  expect(parseSingleJsonDocument(result)).toMatchObject({ success: false });
  expect(output).toContain(expectedMessage);
  expect(output).not.toContain(fixture.root);
};

describe('hotfix dependency transition verifier', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    rmSync(fixture.root, { force: true, recursive: true });
  });

  it('runs filesystem work with bounded concurrency while preserving result order', () => {
    const result = runBoundedConcurrencyProbe();

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      result: ['0:30', '1:5', '2:20', '3:10'],
      maximumActive: 2,
    });
  });

  it('drains in-flight filesystem work before surfacing a bounded concurrency failure', () => {
    const result = runBoundedConcurrencyFailureProbe();

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      active: 0,
      error: 'expected failure',
    });
  });

  it('accepts only the runtime root declaration transition without a node_modules mutation', () => {
    fixture.installedNodeModulesPath = projectNodeModulesPath;
    const result = runVerifier(fixture);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toEqual({
      success: true,
      metadataVerified: true,
      transition: 'runtime-root-declarations-only',
      physicalVerified: true,
      requiresNodeModulesMutation: false,
      packages: {
        fflate: {
          declaration: '^0.8.2',
          lockedVersion: '0.8.2',
          lockedIntegrity: fflateIntegrity,
        },
        multer: {
          declaration: '2.0.2',
          lockedVersion: '2.0.2',
          lockedIntegrity: multerIntegrity,
        },
        rxjs: {
          declaration: '^7.8.2',
          lockedVersion: '7.8.2',
          lockedIntegrity: rxjsIntegrity,
        },
      },
      lockPhysicalTreeFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      installedPhysicalTreeFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      proofAlgorithm: 'sha256-package-lock-production-closure-v1',
      packageCount: expect.any(Number),
      fileCount: expect.any(Number),
      bytes: expect.any(Number),
    });
    expect(result.stdout).not.toContain(fixture.root);
    expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1);
  });

  it('accepts an identical dependency state as an idempotent retry', () => {
    fixture.baselinePackage = clone(fixture.candidatePackage);
    fixture.baselineLock = clone(fixture.candidateLock);
    persistFixture(fixture);

    const result = runMetadataVerifier(fixture);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      metadataVerified: true,
      transition: 'none',
      packages: expect.objectContaining({
        fflate: expect.objectContaining({ lockedVersion: '0.8.2' }),
        multer: expect.objectContaining({ lockedVersion: '2.0.2' }),
        rxjs: expect.objectContaining({ lockedVersion: '7.8.2' }),
      }),
    });
  });

  it('allows the exact outbound approval migration script addition', () => {
    fixture.candidatePackage.scripts[
      'migrate:inventory-outbound-approval-fields:check'
    ] =
      'node scripts/run-with-env.mjs node scripts/ensure-inventory-outbound-approval-fields.mjs --dry-run --require-ready';
    persistFixture(fixture);

    const result = runMetadataVerifier(fixture);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).transition).toBe(
      'runtime-root-declarations-only',
    );
  });

  it('allows the exact overtime self-test build transition', () => {
    fixture.baselinePackage.scripts['self-test:overtime-workflow:audit'] =
      'node scripts/run-with-env.mjs node scripts/self-test-overtime-workflow.mjs --audit-only';
    fixture.candidatePackage.scripts['self-test:overtime-workflow:audit'] =
      'npm run build:server && node scripts/run-with-env.mjs node scripts/self-test-overtime-workflow.mjs --audit-only';
    persistFixture(fixture);

    const result = runMetadataVerifier(fixture);
    expect(result.status).toBe(0);
  });

  it('allows the exact DingTalk attendance archive backfill script addition', () => {
    fixture.candidatePackage.scripts['backfill:dingtalk-attendance-archive'] =
      'node scripts/run-with-env.mjs node scripts/backfill-dingtalk-attendance-archive.mjs';
    persistFixture(fixture);

    const result = runMetadataVerifier(fixture);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).transition).toBe(
      'runtime-root-declarations-only',
    );
  });

  it.each([
    [
      'audit:dingtalk-attendance-archive',
      'node scripts/run-with-env.mjs node scripts/backfill-dingtalk-attendance-archive.mjs --audit-only',
    ],
    [
      'migrate:attendance-archive-fields',
      'node scripts/run-with-env.mjs node scripts/ensure-attendance-archive-summary-fields.mjs --apply',
    ],
    [
      'migrate:attendance-archive-fields:check',
      'node scripts/run-with-env.mjs node scripts/ensure-attendance-archive-summary-fields.mjs --dry-run --require-ready',
    ],
    [
      'migrate:attendance-archive-fields:dry-run',
      'node scripts/run-with-env.mjs node scripts/ensure-attendance-archive-summary-fields.mjs --dry-run',
    ],
    [
      'migrate:legacy-exception-follow-ups',
      'node scripts/run-with-env.mjs node scripts/migrate-legacy-exception-follow-ups.mjs --apply',
    ],
    [
      'migrate:legacy-exception-follow-ups:dry-run',
      'node scripts/run-with-env.mjs node scripts/migrate-legacy-exception-follow-ups.mjs --dry-run',
    ],
    [
      'migrate:operations-follow-up-fields',
      'node scripts/run-with-env.mjs node scripts/ensure-today-operations-follow-up-fields.mjs --apply',
    ],
    [
      'migrate:operations-follow-up-fields:check',
      'node scripts/run-with-env.mjs node scripts/ensure-today-operations-follow-up-fields.mjs --dry-run --require-ready',
    ],
    [
      'migrate:operations-follow-up-fields:dry-run',
      'node scripts/run-with-env.mjs node scripts/ensure-today-operations-follow-up-fields.mjs --dry-run',
    ],
  ])(
    'allows the exact approved operational script addition %s',
    (name, command) => {
      fixture.candidatePackage.scripts[name] = command;
      persistFixture(fixture);

      const result = runMetadataVerifier(fixture);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).transition).toBe(
        'runtime-root-declarations-only',
      );
    },
  );

  it('rejects command drift in an approved operational script addition', () => {
    fixture.candidatePackage.scripts['migrate:attendance-archive-fields'] =
      'node scripts/run-with-env.mjs node scripts/ensure-attendance-archive-summary-fields.mjs --apply --force';
    expectRejected(fixture, 'Package scripts differ outside the allowlist');
  });

  it('rejects a start script change', () => {
    fixture.candidatePackage.scripts.start = 'node dist/server/new-main.js';
    expectRejected(fixture, 'Package scripts differ outside the allowlist');
  });

  it('rejects an arbitrary script addition', () => {
    fixture.candidatePackage.scripts['migrate:inventory'] =
      'node scripts/migrate-inventory.mjs';
    expectRejected(fixture, 'Package scripts differ outside the allowlist');
  });

  it('rejects drift in an existing startup migration check', () => {
    fixture.candidatePackage.scripts['migrate:overtime-workflow-fields:check'] =
      'node changed.mjs';
    expectRejected(fixture, 'Package scripts differ outside the allowlist');
  });

  it('rejects a package change to axios', () => {
    fixture.candidatePackage.dependencies.axios = '^1.8.0';
    expectRejected(
      fixture,
      'Package metadata differs outside the allowed transition',
    );
  });

  it('rejects a second dependency addition', () => {
    fixture.candidatePackage.dependencies.zod = '^3.23.0';
    expectRejected(
      fixture,
      'Package metadata differs outside the allowed transition',
    );
  });

  it('rejects a different fflate declaration range', () => {
    fixture.candidatePackage.dependencies.fflate = '^0.9.0';
    fixture.candidateLock.packages[''].dependencies.fflate = '^0.9.0';
    expectRejected(fixture, 'fflate declaration must be ^0.8.2');
  });

  it('rejects a different multer declaration version', () => {
    fixture.candidatePackage.dependencies.multer = '^2.0.2';
    fixture.candidateLock.packages[''].dependencies.multer = '^2.0.2';
    expectRejected(fixture, 'multer declaration must be 2.0.2');
  });

  it('rejects a different rxjs declaration range', () => {
    fixture.candidatePackage.dependencies.rxjs = '^8.0.0';
    fixture.candidateLock.packages[''].dependencies.rxjs = '^8.0.0';
    expectRejected(fixture, 'rxjs declaration must be ^7.8.2');
  });

  it.each(['fflate', 'multer', 'rxjs'])(
    'rejects a missing candidate production declaration: %s',
    (packageName) => {
      delete fixture.candidatePackage.dependencies[packageName];
      delete fixture.candidateLock.packages[''].dependencies[packageName];
      if (packageName === 'rxjs') {
        fixture.candidatePackage.devDependencies.rxjs = '^7.8.2';
        fixture.candidateLock.packages[''].devDependencies.rxjs = '^7.8.2';
      }
      expectRejected(fixture, `${packageName} must be a production dependency`);
    },
  );

  it('rejects rxjs remaining in devDependencies after it moves to production', () => {
    fixture.candidatePackage.devDependencies.rxjs = '^7.8.2';
    fixture.candidateLock.packages[''].devDependencies.rxjs = '^7.8.2';
    expectRejected(
      fixture,
      'rxjs must not remain in devDependencies after the transition',
    );
  });

  it('rejects a root lock transition that does not match package.json', () => {
    delete fixture.candidateLock.packages[''].dependencies.multer;
    expectRejected(
      fixture,
      'Root lock dependency transition does not match package.json',
    );
  });

  it('rejects a different locked fflate version', () => {
    fixture.candidateLock.packages['node_modules/fflate'].version = '0.8.3';
    expectRejected(fixture, 'fflate physical lock entry differs');
  });

  it.each([
    ['multer', 'resolved'],
    ['rxjs', 'dependencies'],
  ])(
    'rejects a changed physical %s lock entry field: %s',
    (packageName, field) => {
      if (field === 'resolved') {
        fixture.candidateLock.packages[`node_modules/${packageName}`].resolved =
          'https://registry.example.invalid/tampered.tgz';
      } else {
        fixture.candidateLock.packages[
          `node_modules/${packageName}`
        ].dependencies.tslib = '^9.0.0';
      }
      expectRejected(fixture, `${packageName} physical lock entry differs`);
    },
  );

  it('rejects an invalid or non-lowercase integrity algorithm', () => {
    fixture.baselineLock.packages['node_modules/fflate'].integrity =
      'SHA512-not-valid';
    fixture.candidateLock.packages['node_modules/fflate'].integrity =
      'SHA512-not-valid';
    expectRejected(fixture, 'fflate integrity is invalid');
  });

  it.each([
    'preinstall',
    'install',
    'postinstall',
    'prepublish',
    'preprepare',
    'prepare',
    'postprepare',
  ])('rejects a lifecycle script change: %s', (scriptName) => {
    fixture.candidatePackage.scripts[scriptName] = 'node changed.mjs';
    expectRejected(fixture, `Lifecycle script differs: ${scriptName}`);
  });

  it('rejects a non-root package-lock change', () => {
    fixture.candidateLock.packages['node_modules/axios'].version = '1.8.0';
    expectRejected(
      fixture,
      'Package lock differs outside the allowed transition',
    );
  });

  it('rejects removal of an existing fflate root declaration', () => {
    fixture.baselinePackage = clone(fixture.candidatePackage);
    fixture.baselineLock = clone(fixture.candidateLock);
    delete fixture.candidatePackage.dependencies.fflate;
    delete fixture.candidateLock.packages[''].dependencies.fflate;
    expectRejected(
      fixture,
      'Removing the fflate root declaration is forbidden',
    );
  });

  it.each(['fflate', 'multer', 'rxjs'])(
    'rejects a dev-only or optional production physical package: %s',
    (packageName) => {
      fixture.baselineLock.packages[`node_modules/${packageName}`].optional =
        true;
      fixture.candidateLock.packages[`node_modules/${packageName}`].optional =
        true;
      expectRejected(
        fixture,
        `${packageName} physical package must be production-required`,
      );
    },
  );

  it('rejects an unexpected baseline dependency location', () => {
    fixture.baselinePackage.devDependencies.multer = '2.0.2';
    fixture.baselineLock.packages[''].devDependencies.multer = '2.0.2';
    expectRejected(
      fixture,
      'multer baseline declaration is not an allowed state',
    );
  });

  it('rejects a directory in place of an input JSON file without leaking its path', () => {
    mkdirSync(join(fixture.root, 'not-a-file'));
    fixture.candidatePackagePath = join(fixture.root, 'not-a-file');
    const result = runVerifier(fixture);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Input must be a regular file',
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(fixture.root);
  });

  it('exports an importable verification function', () => {
    const result = runMetadataVerifier(fixture);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      metadataVerified: true,
      transition: 'runtime-root-declarations-only',
    });
  });

  it('keeps the physical tree fingerprint stable across a declaration-only retry', () => {
    const first = runPhysicalVerifier(fixture);
    if (first.status !== 0) {
      throw new Error(first.stderr || first.stdout);
    }
    const firstReport = JSON.parse(first.stdout);

    const second = runPhysicalVerifier(fixture);
    expect(second.status).toBe(0);
    const secondReport = JSON.parse(second.stdout);

    expect(secondReport.fingerprint).toBe(firstReport.fingerprint);
  });

  it('reuses a root-bound physical proof and rescans when a quick anchor changes', () => {
    prepareProofCacheFixture(fixture);
    const proofCachePath = join(fixture.root, 'dependency-proof-cache.json');
    const installedLockPath = join(
      fixture.installedNodeModulesPath,
      '.package-lock.json',
    );
    writeJson(installedLockPath, { lockfileVersion: 3 });

    const first = runCachedVerifier(fixture, proofCachePath);
    if (first.status !== 0) {
      throw new Error(first.stderr || first.stdout);
    }
    const firstReport = JSON.parse(first.stdout);
    expect(firstReport.proofCache).toMatchObject({
      status: 'miss',
      verification: 'full-scan',
    });

    const second = runCachedVerifier(fixture, proofCachePath);
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout).proofCache).toMatchObject({
      status: 'hit',
      verification: 'quick-anchors',
    });

    writeJson(installedLockPath, {
      lockfileVersion: 3,
      marker: 'invalidate-proof-cache',
    });
    const third = runCachedVerifier(fixture, proofCachePath);
    expect(third.status).toBe(0);
    const thirdReport = JSON.parse(third.stdout);
    expect(thirdReport.proofCache).toMatchObject({
      status: 'miss',
      verification: 'full-scan',
    });
    expect(thirdReport.installedPhysicalTreeFingerprint).toBe(
      firstReport.installedPhysicalTreeFingerprint,
    );
  });


  it('hashes large binary native anchors without applying the JSON size limit', () => {
    prepareProofCacheFixture(fixture);
    const proofCachePath = join(fixture.root, 'dependency-proof-cache.json');
    const nativeAnchorDirectory = join(
      fixture.installedNodeModulesPath,
      '@rspack',
      'binding-win32-x64-msvc',
    );
    mkdirSync(nativeAnchorDirectory, { recursive: true });
    const nativeAnchorPath = join(
      nativeAnchorDirectory,
      'rspack.win32-x64-msvc.node',
    );
    writeFileSync(nativeAnchorPath, 'x');
    truncateSync(nativeAnchorPath, 32 * 1024 * 1024 + 1);

    const first = runCachedVerifier(fixture, proofCachePath);
    if (first.status !== 0) {
      throw new Error(first.stderr || first.stdout);
    }
    expect(JSON.parse(first.stdout).proofCache).toMatchObject({
      status: 'miss',
      verification: 'full-scan',
    });

    const second = runCachedVerifier(fixture, proofCachePath);
    if (second.status !== 0) {
      throw new Error(second.stderr || second.stdout);
    }
    expect(JSON.parse(second.stdout).proofCache).toMatchObject({
      status: 'hit',
      verification: 'quick-anchors',
    });
  });

  it('rejects a native quick-proof anchor backed by an external hard link', () => {
    prepareProofCacheFixture(fixture);
    const proofCachePath = join(fixture.root, 'dependency-proof-cache.json');
    const nativeAnchorDirectory = join(
      fixture.installedNodeModulesPath,
      '@rspack',
      'binding-win32-x64-msvc',
    );
    mkdirSync(nativeAnchorDirectory, { recursive: true });
    const externalPath = join(fixture.root, 'external-native-anchor.node');
    const nativeAnchorPath = join(
      nativeAnchorDirectory,
      'rspack.win32-x64-msvc.node',
    );
    writeFileSync(externalPath, 'native-anchor');
    linkSync(externalPath, nativeAnchorPath);

    const result = runCachedVerifier(fixture, proofCachePath);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Dependency proof anchor is not a safe regular file',
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(fixture.root);
  });

  it('falls back to one full physical proof when the persisted proof cache is corrupt', () => {
    prepareProofCacheFixture(fixture);
    const proofCachePath = join(fixture.root, 'dependency-proof-cache.json');
    writeFileSync(proofCachePath, '{invalid json', 'utf8');

    const result = runCachedVerifier(fixture, proofCachePath);

    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    expect(JSON.parse(result.stdout).proofCache).toMatchObject({
      status: 'miss',
      verification: 'full-scan',
    });
  });

  it.each([2, 3] as const)(
    'covers the package-lock v%s production dependency closure',
    (lockfileVersion) => {
      const result = runProductionClosureVerifier(fixture, lockfileVersion);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        proofAlgorithm: 'sha256-package-lock-production-closure-v1',
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        packageCount: 5,
        fileCount: 13,
        bytes: expect.any(Number),
      });
    },
  );

  it('changes the proof when an ordinary production dependency is tampered', () => {
    const closure = createProductionClosureFixture(fixture, 3);
    const first = runProductionClosureVerifier(fixture, 3, closure);
    expect(first.status).toBe(0);
    const firstReport = JSON.parse(first.stdout);

    writeFileSync(
      join(fixture.installedNodeModulesPath, 'ordinary-production', 'index.js'),
      "module.exports = 'tampered';\n",
      'utf8',
    );
    const second = runProductionClosureVerifier(fixture, 3, closure);
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout).fingerprint).not.toBe(
      firstReport.fingerprint,
    );
  });

  it('changes the proof when a nested production dependency is tampered', () => {
    const closure = createProductionClosureFixture(fixture, 3);
    const first = runProductionClosureVerifier(fixture, 3, closure);
    expect(first.status).toBe(0);
    const firstReport = JSON.parse(first.stdout);

    writeFileSync(
      join(
        fixture.installedNodeModulesPath,
        'ordinary-production',
        'node_modules',
        'nested-production',
        'index.js',
      ),
      "module.exports = 'tampered nested';\n",
      'utf8',
    );
    const second = runProductionClosureVerifier(fixture, 3, closure);
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout).fingerprint).not.toBe(
      firstReport.fingerprint,
    );
  });

  it('excludes development-only dependency content from the proof', () => {
    const closure = createProductionClosureFixture(fixture, 3);
    const first = runProductionClosureVerifier(fixture, 3, closure);
    expect(first.status).toBe(0);
    const firstReport = JSON.parse(first.stdout);

    writeFileSync(
      join(fixture.installedNodeModulesPath, 'development-only', 'index.js'),
      "module.exports = 'changed development dependency';\n",
      'utf8',
    );
    const second = runProductionClosureVerifier(fixture, 3, closure);
    expect(second.status).toBe(0);
    const secondReport = JSON.parse(second.stdout);
    expect(secondReport).toMatchObject({
      packageCount: 5,
      fileCount: 13,
      fingerprint: firstReport.fingerprint,
    });
  });

  it('executes through a directory junction and emits exactly one JSON document', () => {
    const aliasDirectory = join(fixture.root, 'verifier-junction');
    symlinkSync(
      resolve(__dirname, '../../scripts'),
      aliasDirectory,
      'junction',
    );
    try {
      const result = spawnSync(
        process.execPath,
        [
          join(aliasDirectory, basename(verifierPath)),
          '--baseline-package',
          fixture.baselinePackagePath,
          '--baseline-lock',
          fixture.baselineLockPath,
          '--candidate-package',
          fixture.candidatePackagePath,
          '--candidate-lock',
          fixture.candidateLockPath,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      expect(result.status).not.toBe(0);
      expect(parseSingleJsonDocument(result)).toEqual({
        success: false,
        error: 'Invalid command arguments',
      });
    } finally {
      unlinkSync(aliasDirectory);
    }
  });

  it('rejects a missing installed node_modules argument with one JSON error', () => {
    const result = spawnSync(
      process.execPath,
      [
        verifierPath,
        '--baseline-package',
        fixture.baselinePackagePath,
        '--baseline-lock',
        fixture.baselineLockPath,
        '--candidate-package',
        fixture.candidatePackagePath,
        '--candidate-lock',
        fixture.candidateLockPath,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(result.status).not.toBe(0);
    expect(parseSingleJsonDocument(result)).toEqual({
      success: false,
      error: 'Invalid command arguments',
    });
  });

  it('rejects a missing installed runtime package', () => {
    rmSync(join(fixture.installedNodeModulesPath, 'multer'), {
      force: true,
      recursive: true,
    });
    expectPhysicalRejected(fixture, 'Installed runtime dependency is missing');
  });

  it('rejects an installed runtime package version mismatch', () => {
    const packageJsonPath = join(
      fixture.installedNodeModulesPath,
      'multer',
      'package.json',
    );
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    packageJson.version = '2.0.3';
    writeJson(packageJsonPath, packageJson);
    expectPhysicalRejected(
      fixture,
      'Installed runtime dependency version differs',
    );
  });

  it('rejects static physical package content tampering', () => {
    writeFileSync(
      join(fixture.installedNodeModulesPath, 'fflate', 'tampered.js'),
      'module.exports = true;\n',
      'utf8',
    );
    expectPhysicalRejected(
      fixture,
      'Installed runtime dependency content differs',
    );
  });

  it('rejects an installed package file backed by an external hard link', () => {
    const packageFilePath = join(
      fixture.installedNodeModulesPath,
      'fflate',
      'lib',
      'helper.txt',
    );
    const externalFilePath = join(fixture.root, 'external-helper.txt');
    writeFileSync(externalFilePath, readFileSync(packageFilePath));
    unlinkSync(packageFilePath);
    linkSync(externalFilePath, packageFilePath);

    expectPhysicalRejected(
      fixture,
      'Installed dependency tree contains a hard link',
    );
  });

  it('rejects a package directory junction escaping the installed root', () => {
    const packagePath = join(fixture.installedNodeModulesPath, 'fflate');
    const externalPackagePath = join(fixture.root, 'external-fflate');
    cpSync(packagePath, externalPackagePath, { recursive: true });
    rmSync(packagePath, { force: true, recursive: true });
    symlinkSync(externalPackagePath, packagePath, 'junction');
    try {
      expectPhysicalRejected(
        fixture,
        'Installed dependency tree contains a reparse point',
      );
    } finally {
      unlinkSync(packagePath);
    }
  });

  it('rejects a junction used as the installed node_modules root', () => {
    const aliasPath = join(fixture.root, 'node-modules-junction');
    symlinkSync(fixture.installedNodeModulesPath, aliasPath, 'junction');
    fixture.installedNodeModulesPath = aliasPath;
    try {
      expectPhysicalRejected(fixture, 'Installed node_modules root is unsafe');
    } finally {
      unlinkSync(aliasPath);
    }
  });

  (process.platform === 'win32' ? it : it.skip)(
    'rejects an alternate data stream in an installed package',
    () => {
      const streamPath = `${join(
        fixture.installedNodeModulesPath,
        'fflate',
        'package.json',
      )}:codex-test`;
      writeFileSync(streamPath, 'tampered', 'utf8');
      try {
        expectPhysicalRejected(
          fixture,
          'Installed dependency tree contains an alternate data stream',
        );
      } finally {
        rmSync(streamPath, { force: true });
      }
    },
  );

  (process.platform === 'win32' ? it : it.skip)(
    'rejects an alternate data stream on an installed package directory',
    () => {
      const streamPath = `${join(
        fixture.installedNodeModulesPath,
        'fflate',
      )}:codex-test`;
      writeFileSync(streamPath, 'tampered', 'utf8');
      try {
        expectPhysicalRejected(
          fixture,
          'Installed dependency tree contains an alternate data stream',
        );
      } finally {
        rmSync(streamPath, { force: true });
      }
    },
  );

  (process.platform === 'win32' ? it : it.skip)(
    'rejects an alternate data stream on the node_modules root',
    () => {
      const streamPath = `${fixture.installedNodeModulesPath}:codex-test`;
      writeFileSync(streamPath, 'tampered', 'utf8');
      try {
        expectPhysicalRejected(
          fixture,
          'Installed dependency tree contains an alternate data stream',
        );
      } finally {
        rmSync(streamPath, { force: true });
      }
    },
  );

  (process.platform === 'win32' ? it : it.skip)(
    'rejects an alternate data stream on a nested installed directory',
    () => {
      const streamPath = `${join(
        fixture.installedNodeModulesPath,
        'fflate',
        'lib',
      )}:codex-test`;
      writeFileSync(streamPath, 'tampered', 'utf8');
      try {
        expectPhysicalRejected(
          fixture,
          'Installed dependency tree contains an alternate data stream',
        );
      } finally {
        rmSync(streamPath, { force: true });
      }
    },
  );

  (process.platform === 'win32' ? it : it.skip)(
    'does not execute a powershell.exe planted in the verifier working directory',
    () => {
      const fakeBin = join(fixture.root, 'fake-bin');
      mkdirSync(fakeBin);
      copyFileSync(process.execPath, join(fakeBin, 'powershell.exe'));
      const streamPath = `${join(
        fixture.installedNodeModulesPath,
        'fflate',
        'package.json',
      )}:codex-test`;
      writeFileSync(streamPath, 'tampered', 'utf8');
      try {
        const result = runPhysicalVerifier(fixture, {
          cwd: fakeBin,
          env: { ...process.env, PATH: fakeBin },
        });
        expect(result.status).not.toBe(0);
        expect(parseSingleJsonDocument(result)).toEqual({
          success: false,
          error: 'Installed dependency tree contains an alternate data stream',
        });
      } finally {
        rmSync(streamPath, { force: true });
      }
    },
  );

  (process.platform === 'win32' ? it : it.skip)(
    'does not trust a mutable SystemRoot when resolving powershell.exe',
    () => {
      const fakeSystemRoot = join(fixture.root, 'fake-windows');
      const fakePowerShellDirectory = join(
        fakeSystemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
      );
      mkdirSync(fakePowerShellDirectory, { recursive: true });
      copyFileSync(
        process.execPath,
        join(fakePowerShellDirectory, 'powershell.exe'),
      );
      const streamPath = `${join(
        fixture.installedNodeModulesPath,
        'fflate',
        'package.json',
      )}:codex-test`;
      writeFileSync(streamPath, 'tampered', 'utf8');
      try {
        const result = runPhysicalVerifierAfterSystemRootMutation(
          fixture,
          fakeSystemRoot,
        );
        expect(result.status).not.toBe(0);
        expect(parseSingleJsonDocument(result)).toEqual({
          success: false,
          error: 'Installed dependency tree contains an alternate data stream',
        });
      } finally {
        rmSync(streamPath, { force: true });
      }
    },
  );

  (process.platform === 'win32' ? it : it.skip)(
    'treats powershell metacharacters in a legal dependency path as data',
    () => {
      const metacharacterRoot = join(
        fixture.root,
        '$(Write-Output INJECTED);safe',
      );
      mkdirSync(metacharacterRoot);
      const relocatedNodeModules = join(metacharacterRoot, 'node_modules');
      renameSync(fixture.installedNodeModulesPath, relocatedNodeModules);
      fixture.installedNodeModulesPath = relocatedNodeModules;

      const result = runPhysicalVerifier(fixture);
      expect(result.status).toBe(0);
      const report = parseSingleJsonDocument(result);
      expect(report.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain('INJECTED');
    },
  );

  (process.platform === 'win32' ? it : it.skip)(
    'rejects a package root whose on-disk casing differs from the lock name',
    () => {
      const originalPath = join(fixture.installedNodeModulesPath, 'fflate');
      const intermediatePath = join(
        fixture.installedNodeModulesPath,
        'fflate-case-transition',
      );
      const changedCasePath = join(fixture.installedNodeModulesPath, 'FFLATE');
      renameSync(originalPath, intermediatePath);
      renameSync(intermediatePath, changedCasePath);
      expectPhysicalRejected(
        fixture,
        'Installed dependency path casing differs',
      );
    },
  );

  it('rejects an installed dependency tree deeper than the audit limit', () => {
    let directory = join(fixture.installedNodeModulesPath, 'fflate');
    for (let index = 0; index < 70; index += 1) {
      directory = join(directory, `d${index}`);
      mkdirSync(directory);
    }
    expectPhysicalRejected(
      fixture,
      'Installed dependency tree exceeds safety limits',
    );
  });

  it('rejects a sparse installed file beyond the bounded hash budget', () => {
    const oversizedPath = join(
      fixture.installedNodeModulesPath,
      'fflate',
      'oversized.bin',
    );
    writeFileSync(oversizedPath, '');
    truncateSync(oversizedPath, 64 * 1024 * 1024 + 1);
    expectPhysicalRejected(
      fixture,
      'Installed dependency tree exceeds safety limits',
    );
  });

  (process.platform === 'win32'
    ? it.each([
        'baselinePackagePath',
        'baselineLockPath',
        'candidatePackagePath',
        'candidateLockPath',
      ] as const)
    : it.skip.each([
        'baselinePackagePath',
        'baselineLockPath',
        'candidatePackagePath',
        'candidateLockPath',
      ] as const))(
    'rejects an alternate data stream used as %s',
    (propertyName) => {
      persistFixture(fixture);
      const sourcePath = fixture[propertyName];
      const carrierPath = join(fixture.root, `${propertyName}-carrier.json`);
      writeFileSync(carrierPath, '{}\n', 'utf8');
      const streamPath = `${carrierPath}:json`;
      writeFileSync(streamPath, readFileSync(sourcePath));
      fixture[propertyName] = streamPath;

      const result = runVerifier(fixture);
      expect(result.status).not.toBe(0);
      expect(parseSingleJsonDocument(result)).toEqual({
        success: false,
        error: 'Input path must not use an alternate data stream',
      });
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(fixture.root);
    },
  );

  it('does not echo an untrusted package script key in a rejection', () => {
    const secretScriptName = 'C:\\server\\private\\TOKEN_secret-marker';
    fixture.candidatePackage.scripts[secretScriptName] = 'node changed.mjs';
    persistFixture(fixture);

    const result = runVerifier(fixture);
    expect(result.status).not.toBe(0);
    expect(parseSingleJsonDocument(result)).toEqual({
      success: false,
      error: 'Package scripts differ outside the allowlist',
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain(secretScriptName);
    expect(output).not.toContain('TOKEN_secret-marker');
    expect(output).not.toContain(fixture.root);
  });

  it('does not echo JSON file contents or paths on malformed input', () => {
    writeFileSync(
      fixture.candidatePackagePath,
      '{"secret":"DO_NOT_ECHO",',
      'utf8',
    );
    const result = runVerifier(fixture);
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain('Input JSON is invalid');
    expect(output).not.toContain('DO_NOT_ECHO');
    expect(output).not.toContain(fixture.root);
    expect(readFileSync(fixture.candidatePackagePath, 'utf8')).toContain(
      'DO_NOT_ECHO',
    );
  });
});
