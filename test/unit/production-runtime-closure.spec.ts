import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(
  projectRoot,
  'scripts',
  'verify-production-runtime-closure.mjs',
);

type PackageFixture = {
  dependencies?: Record<string, string>;
  dev?: boolean;
  files?: Record<string, string>;
  location?: string;
  manifest?: Record<string, unknown>;
  version?: string;
};

type FixtureOptions = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files?: Record<string, string>;
  lockMutator?: (lock: Record<string, any>) => void;
  optionalDependencies?: Record<string, string>;
  packages?: Record<string, PackageFixture>;
};

const fixtureRoots: string[] = [];
const VERIFIED_DEPENDENCY_TRANSITION = 'runtime-root-declarations-only';
const VERIFIED_LOCK_PHYSICAL_TREE_FINGERPRINT = '1'.repeat(64);
const VERIFIED_INSTALLED_PHYSICAL_TREE_FINGERPRINT = '2'.repeat(64);

const writeFixtureFile = (
  root: string,
  relativePath: string,
  contents: string | Buffer,
) => {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
};

const createFixture = (options: FixtureOptions = {}) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'production-runtime-closure-'),
  );
  fixtureRoots.push(root);
  const dependencies = options.dependencies ?? {};
  const devDependencies = options.devDependencies ?? {};
  const optionalDependencies = options.optionalDependencies ?? {};
  const packageManifest = {
    name: 'runtime-closure-fixture',
    version: '1.0.0',
    private: true,
    dependencies,
    devDependencies,
    optionalDependencies,
  };
  writeFixtureFile(
    root,
    'package.json',
    `${JSON.stringify(packageManifest, null, 2)}\n`,
  );

  const files = options.files ?? {
    'dist/server/main.js': "module.exports = require('../shared/value');\n",
    'dist/shared/value.js': 'module.exports = 1;\n',
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    writeFixtureFile(root, relativePath, contents);
  }

  const lock: Record<string, any> = {
    name: packageManifest.name,
    version: packageManifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: packageManifest.name,
        version: packageManifest.version,
        dependencies,
        devDependencies,
        optionalDependencies,
      },
    },
  };

  for (const [packageName, packageInfo] of Object.entries(
    options.packages ?? {},
  )) {
    const location = packageInfo.location ?? `node_modules/${packageName}`;
    const version = packageInfo.version ?? '1.0.0';
    const manifest = {
      name: packageName,
      version,
      main: 'index.js',
      ...(packageInfo.manifest ?? {}),
      dependencies: packageInfo.dependencies ?? {},
    };
    writeFixtureFile(
      root,
      `${location}/package.json`,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const packageFiles = packageInfo.files ?? {
      'index.js': 'module.exports = {};\n',
    };
    for (const [relativePath, contents] of Object.entries(packageFiles)) {
      writeFixtureFile(root, `${location}/${relativePath}`, contents);
    }
    lock.packages[location] = {
      version,
      ...(packageInfo.dev ? { dev: true } : {}),
      dependencies: packageInfo.dependencies ?? {},
    };
  }
  options.lockMutator?.(lock);
  writeFixtureFile(
    root,
    'package-lock.json',
    `${JSON.stringify(lock, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  return root;
};

type RuntimeInputPaths = {
  lockPath: string;
  nodeModulesRoot: string;
  packagePath: string;
  serverRoot: string;
  sharedRoot: string;
};

const fixtureInputPaths = (root: string): RuntimeInputPaths => ({
  lockPath: path.join(root, 'package-lock.json'),
  nodeModulesRoot: path.join(root, 'node_modules'),
  packagePath: path.join(root, 'package.json'),
  serverRoot: path.join(root, 'dist', 'server'),
  sharedRoot: path.join(root, 'dist', 'shared'),
});

// Independent packager-side contract: sorted root label + relative path + size + SHA256.
const expectedBuildFingerprint = (inputs: RuntimeInputPaths) => {
  const entries: string[] = [];
  for (const [label, root] of [
    ['dist/server', inputs.serverRoot],
    ['dist/shared', inputs.sharedRoot],
  ] as const) {
    const visit = (directory: string) => {
      for (const child of fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((left, right) =>
          Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
        )) {
        const absolute = path.join(directory, child.name);
        if (child.isDirectory()) {
          visit(absolute);
          continue;
        }
        if (!child.isFile()) continue;
        const contents = fs.readFileSync(absolute);
        const relativePath = path
          .relative(root, absolute)
          .split(path.sep)
          .join('/');
        entries.push(
          `${label}\0${relativePath}\0${contents.length}\0${createHash('sha256').update(contents).digest('hex')}`,
        );
      }
    };
    visit(root);
  }
  return createHash('sha256')
    .update(
      entries
        .sort((left, right) =>
          Buffer.compare(Buffer.from(left), Buffer.from(right)),
        )
        .join('\n'),
    )
    .digest('hex');
};

const cliArguments = (inputs: RuntimeInputPaths) => [
  '--server-root',
  inputs.serverRoot,
  '--shared-root',
  inputs.sharedRoot,
  '--package',
  inputs.packagePath,
  '--lock',
  inputs.lockPath,
  '--node-modules-root',
  inputs.nodeModulesRoot,
  '--expected-build-fingerprint',
  expectedBuildFingerprint(inputs),
  '--json',
];

const runCliWithInputs = (
  inputs: RuntimeInputPaths,
  extraArguments: string[] = [],
  executable = scriptPath,
) =>
  spawnSync(
    process.execPath,
    [executable, ...cliArguments(inputs), ...extraArguments],
    {
      encoding: 'utf8',
      timeout: 30_000,
    },
  );

const runCli = (
  root: string,
  extraArguments: string[] = [],
  executable = scriptPath,
) => runCliWithInputs(fixtureInputPaths(root), extraArguments, executable);

const verifiedDependencyArguments = [
  '--verified-dependency-transition',
  VERIFIED_DEPENDENCY_TRANSITION,
  '--verified-lock-physical-tree-fingerprint',
  VERIFIED_LOCK_PHYSICAL_TREE_FINGERPRINT,
  '--verified-installed-physical-tree-fingerprint',
  VERIFIED_INSTALLED_PHYSICAL_TREE_FINGERPRINT,
];

const runImportedVerifier = (
  root: string,
  extraOptionsSource: string,
  includeExpectedBuildFingerprint = true,
) => {
  const moduleUrl = pathToFileURL(scriptPath).href;
  const program = [
    `import { verifyProductionRuntimeClosure } from ${JSON.stringify(moduleUrl)};`,
    `const root = ${JSON.stringify(root)};`,
    'try {',
    ' const report = verifyProductionRuntimeClosure({',
    "  serverRoot: root + '/dist/server', sharedRoot: root + '/dist/shared',",
    "  packagePath: root + '/package.json', lockPath: root + '/package-lock.json',",
    "  nodeModulesRoot: root + '/node_modules',",
    ...(includeExpectedBuildFingerprint
      ? [
          `  expectedBuildFingerprint: ${JSON.stringify(expectedBuildFingerprint(fixtureInputPaths(root)))},`,
        ]
      : []),
    `  ${extraOptionsSource}`,
    ' });',
    ' process.stdout.write(JSON.stringify(report));',
    '} catch (error) {',
    " process.stdout.write(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'unknown' }));",
    '}',
  ].join('\n');
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    { encoding: 'utf8', timeout: 30_000 },
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
};

const outputLines = (result: ReturnType<typeof runCli>) =>
  `${result.stdout}${result.stderr}`.trim().split(/\r?\n/u).filter(Boolean);

const parseCliJson = (result: ReturnType<typeof runCli>) => {
  const lines = outputLines(result);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
};

const expectCliFailure = (root: string, errorText: string) => {
  const result = runCli(root);
  const report = parseCliJson(result);
  expect(result.status).toBe(1);
  expect(report).toMatchObject({
    success: false,
    error: expect.stringContaining(errorText),
  });
  expect(`${result.stdout}${result.stderr}`).not.toContain(root);
};

afterAll(() => {
  for (const root of fixtureRoots) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe('production runtime closure verifier', () => {
  it('writes exactly one CLI report to an exclusive JSON sidecar', () => {
    const root = createFixture();
    const reportPath = path.join(
      root,
      `.hotfix-gate-${'a'.repeat(32)}.report.json`,
    );

    const result = runCli(root, ['--json-output', reportPath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(JSON.parse(fs.readFileSync(reportPath, 'utf8'))).toMatchObject({
      success: true,
      dependencyMode: 'full-audit',
    });

    const repeated = runCli(root, ['--json-output', reportPath]);
    expect(repeated.status).toBe(1);
    expect(JSON.parse(repeated.stdout)).toMatchObject({
      success: false,
      error: expect.stringContaining('EEXIST'),
    });
  });

  it('accepts explicit independent inputs and exposes the same importable API', () => {
    const root = createFixture();
    const result = runCli(root);
    const cliReport = parseCliJson(result);
    expect(cliReport).toEqual({
      success: true,
      buildFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      dependencyMode: 'full-audit',
      fileCount: 2,
      importCount: 1,
      runtimeClosureFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      thirdPartyAstMode: 'deep',
    });
    expect(result.status).toBe(0);

    const moduleUrl = pathToFileURL(scriptPath).href;
    const program = [
      `import { verifyProductionRuntimeClosure } from ${JSON.stringify(moduleUrl)};`,
      `const root = ${JSON.stringify(root)};`,
      'const report = verifyProductionRuntimeClosure({',
      " serverRoot: root + '/dist/server', sharedRoot: root + '/dist/shared',",
      " packagePath: root + '/package.json', lockPath: root + '/package-lock.json',",
      ` nodeModulesRoot: root + '/node_modules', expectedBuildFingerprint: ${JSON.stringify(expectedBuildFingerprint(fixtureInputPaths(root)))} });`,
      'process.stdout.write(JSON.stringify(report));',
    ].join('\n');
    const imported = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', program],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(imported.status).toBe(0);
    expect(JSON.parse(imported.stdout)).toEqual(cliReport);
  });

  it('uses a verified dependency transition for the ordinary business hotfix path', () => {
    const root = createFixture({
      dependencies: { dependency: '1.0.0' },
      files: {
        'dist/server/main.js': 'module.exports = require("dependency");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        dependency: {
          files: {
            'index.js':
              'const runtimeName = process.env.RUNTIME_NAME; module.exports = require(runtimeName);\n',
          },
        },
      },
    });

    const result = runCli(root, verifiedDependencyArguments);

    expect(result.status).toBe(0);
    expect(parseCliJson(result)).toMatchObject({
      success: true,
      dependencyMode: 'verified-transition',
      thirdPartyAstMode: 'locked-physical-tree',
      verifiedDependencyTransition: VERIFIED_DEPENDENCY_TRANSITION,
      verifiedLockPhysicalTreeFingerprint:
        VERIFIED_LOCK_PHYSICAL_TREE_FINGERPRINT,
      verifiedInstalledPhysicalTreeFingerprint:
        VERIFIED_INSTALLED_PHYSICAL_TREE_FINGERPRINT,
    });
  });

  it('does not read unrelated package payloads after the dependency tree was separately verified', () => {
    const root = createFixture({
      dependencies: { dependency: '1.0.0' },
      files: {
        'dist/server/main.js': 'module.exports = require("dependency");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        dependency: {
          files: {
            'index.js': 'module.exports = {};\n',
            'unrelated.js': 'module.exports = "not imported";\n',
          },
        },
      },
    });
    const moduleUrl = `${pathToFileURL(scriptPath).href}?entry-only=${Date.now()}`;
    const blockedPath = path.join(
      root,
      'node_modules',
      'dependency',
      'unrelated.js',
    );
    const program = [
      "const fs = process.getBuiltinModule('node:fs');",
      'const originalOpenSync = fs.openSync;',
      `const blockedPath = ${JSON.stringify(blockedPath)};`,
      'fs.openSync = function (candidate, ...rest) {',
      " if (typeof candidate === 'string' && process.getBuiltinModule('node:path').resolve(candidate) === blockedPath)",
      "  throw new Error('unrelated package payload was read');",
      ' return originalOpenSync.call(this, candidate, ...rest);',
      '};',
      "process.getBuiltinModule('node:module').syncBuiltinESMExports();",
      `const { verifyProductionRuntimeClosure } = await import(${JSON.stringify(moduleUrl)});`,
      `const root = ${JSON.stringify(root)};`,
      'try {',
      ' const report = verifyProductionRuntimeClosure({',
      "  serverRoot: root + '/dist/server', sharedRoot: root + '/dist/shared',",
      "  packagePath: root + '/package.json', lockPath: root + '/package-lock.json',",
      "  nodeModulesRoot: root + '/node_modules',",
      `  expectedBuildFingerprint: ${JSON.stringify(expectedBuildFingerprint(fixtureInputPaths(root)))},`,
      `  verifiedDependencyTransition: ${JSON.stringify(VERIFIED_DEPENDENCY_TRANSITION)},`,
      `  verifiedLockPhysicalTreeFingerprint: ${JSON.stringify(VERIFIED_LOCK_PHYSICAL_TREE_FINGERPRINT)},`,
      `  verifiedInstalledPhysicalTreeFingerprint: ${JSON.stringify(VERIFIED_INSTALLED_PHYSICAL_TREE_FINGERPRINT)},`,
      ' });',
      ' process.stdout.write(JSON.stringify(report));',
      '} catch (error) {',
      " process.stdout.write(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'unknown' }));",
      '}',
    ].join('\n');
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', program],
      { encoding: 'utf8', timeout: 30_000 },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      dependencyMode: 'verified-transition',
    });
  });

  it('resolves CommonJS entries from a separately verified node_modules tree', () => {
    const options = {
      dependencies: { tslib: '2.8.1' },
      files: {
        'dist/server/main.js': 'module.exports = require("tslib");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        tslib: {
          manifest: { main: 'tslib.js' },
          files: {
            'tslib.js': 'module.exports = { __assign: Object.assign };\n',
          },
        },
      },
    };
    const snapshotRoot = createFixture(options);
    const reusableTreeRoot = createFixture(options);
    const inputs = {
      ...fixtureInputPaths(snapshotRoot),
      nodeModulesRoot: path.join(reusableTreeRoot, 'node_modules'),
    };

    const result = runCliWithInputs(inputs, verifiedDependencyArguments);

    expect(result.status).toBe(0);
    expect(parseCliJson(result)).toMatchObject({
      success: true,
      dependencyMode: 'verified-transition',
      thirdPartyAstMode: 'locked-physical-tree',
    });
  });

  it('rejects an incomplete verified dependency transition proof', () => {
    const root = createFixture();

    const result = runCli(root, [
      '--verified-lock-physical-tree-fingerprint',
      VERIFIED_LOCK_PHYSICAL_TREE_FINGERPRINT,
    ]);

    expect(result.status).toBe(1);
    expect(parseCliJson(result)).toMatchObject({
      success: false,
      error: expect.stringContaining(
        'Verified dependency transition proof is incomplete',
      ),
    });
  });

  it('rejects physical-tree fingerprints without the verified transition type', () => {
    const root = createFixture();

    const result = runCli(root, [
      '--verified-lock-physical-tree-fingerprint',
      VERIFIED_LOCK_PHYSICAL_TREE_FINGERPRINT,
      '--verified-installed-physical-tree-fingerprint',
      VERIFIED_INSTALLED_PHYSICAL_TREE_FINGERPRINT,
    ]);

    expect(result.status).toBe(1);
    expect(parseCliJson(result)).toMatchObject({
      success: false,
      error: expect.stringContaining(
        'Verified dependency transition proof is incomplete',
      ),
    });
  });

  it('still rejects dynamic loaders in business runtime files on the ordinary path', () => {
    const root = createFixture({
      files: {
        'dist/server/main.js':
          'const runtimeName = process.env.RUNTIME_NAME; module.exports = require(runtimeName);\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });

    const result = runCli(root, verifiedDependencyArguments);

    expect(result.status).toBe(1);
    expect(parseCliJson(result)).toMatchObject({
      success: false,
      error: expect.stringContaining('Dynamic require is not allowed'),
    });
  });

  it('still validates complete transitive package trees on the ordinary path', () => {
    const root = createFixture({
      dependencies: { parent: '1.0.0' },
      files: {
        'dist/server/main.js': 'module.exports = require("parent");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        parent: {
          dependencies: { child: '1.0.0' },
        },
        child: {
          files: {
            'index.js': 'module.exports = {};\n',
            'native.node': 'not-a-native-addon',
          },
        },
      },
    });

    const result = runCli(root, verifiedDependencyArguments);

    expect(result.status).toBe(1);
    expect(parseCliJson(result)).toMatchObject({
      success: false,
      error: expect.stringContaining('Native addon is not allowed'),
    });
  });

  it('executes through a junction instead of silently skipping CLI mode', () => {
    const root = createFixture();
    const linkedRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'closure-script-link-'),
    );
    fixtureRoots.push(linkedRoot);
    const linkedScripts = path.join(linkedRoot, 'scripts');
    fs.symlinkSync(
      path.dirname(scriptPath),
      linkedScripts,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const result = runCli(
      root,
      [],
      path.join(linkedScripts, path.basename(scriptPath)),
    );
    expect(result.status).toBe(0);
    expect(parseCliJson(result)).toMatchObject({ success: true });
  });

  (process.platform === 'win32' ? it : it.skip)(
    'uses a trusted ADS verifier when cwd and process lookup variables are poisoned',
    () => {
      const root = createFixture();
      const poisonRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'closure-path-poison-'),
      );
      fixtureRoots.push(poisonRoot);
      fs.writeFileSync(path.join(poisonRoot, 'cmd.exe'), 'not executable');
      fs.writeFileSync(
        path.join(poisonRoot, 'powershell.exe'),
        'not executable',
      );
      const profilerPath = path.join(poisonRoot, 'poison-profiler.dll');
      fs.writeFileSync(profilerPath, 'not a profiler');
      const preloadPath = path.join(poisonRoot, 'inspect-ads-child-env.cjs');
      fs.writeFileSync(
        preloadPath,
        [
          "const childProcess = require('node:child_process');",
          'const originalSpawnSync = childProcess.spawnSync;',
          'childProcess.spawnSync = function (command, args, options = {}) {',
          ' const forbidden = Object.keys(options.env || {}).filter((name) => /^(?:COR_|CORECLR_|DOTNET_)/i.test(name));',
          " if (forbidden.length) throw new Error('ADS child environment contains forbidden startup variables');",
          ' return originalSpawnSync.call(this, command, args, options);',
          '};',
          "require('node:module').syncBuiltinESMExports();",
        ].join('\n'),
      );
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            ![
              'path',
              'comspec',
              'systemroot',
              'windir',
              'psmodulepath',
            ].includes(name.toLowerCase()),
        ),
      );
      const result = spawnSync(
        process.execPath,
        [scriptPath, ...cliArguments(fixtureInputPaths(root))],
        {
          cwd: poisonRoot,
          encoding: 'utf8',
          env: {
            ...environment,
            ComSpec: path.join(poisonRoot, 'cmd.exe'),
            CORECLR_ENABLE_PROFILING: '1',
            CORECLR_PROFILER: '{11111111-1111-1111-1111-111111111111}',
            CORECLR_PROFILER_PATH: profilerPath,
            COR_ENABLE_PROFILING: '1',
            COR_PROFILER: '{11111111-1111-1111-1111-111111111111}',
            COR_PROFILER_PATH: profilerPath,
            DOTNET_ADDITIONAL_DEPS: profilerPath,
            DOTNET_STARTUP_HOOKS: profilerPath,
            NODE_OPTIONS: `--require=${preloadPath}`,
            Path: poisonRoot,
            PSModulePath: poisonRoot,
            SystemRoot: process.env.SystemRoot ?? String.raw`C:\Windows`,
            windir: process.env.windir ?? String.raw`C:\Windows`,
          },
          timeout: 30_000,
        },
      );
      expect(result.status).toBe(0);
      expect(parseCliJson(result)).toMatchObject({ success: true });
    },
  );

  (process.platform === 'win32' ? it : it.skip)(
    'allows the trusted ADS verifier enough time for a production-sized closure',
    () => {
      const root = createFixture();
      const probeRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'closure-ads-timeout-probe-'),
      );
      fixtureRoots.push(probeRoot);
      const timeoutPath = path.join(probeRoot, 'timeout.txt');
      const preloadPath = path.join(probeRoot, 'capture-ads-timeout.cjs');
      fs.writeFileSync(
        preloadPath,
        [
          "const childProcess = require('node:child_process');",
          "const fs = require('node:fs');",
          'const originalSpawnSync = childProcess.spawnSync;',
          'childProcess.spawnSync = function (command, args, options = {}) {',
          " if (String(command).toLowerCase().endsWith('\\\\powershell.exe'))",
          `  fs.writeFileSync(${JSON.stringify(timeoutPath)}, String(options.timeout));`,
          ' return originalSpawnSync.call(this, command, args, options);',
          '};',
          "require('node:module').syncBuiltinESMExports();",
        ].join('\n'),
      );
      const result = spawnSync(
        process.execPath,
        [scriptPath, ...cliArguments(fixtureInputPaths(root))],
        {
          encoding: 'utf8',
          env: { ...process.env, NODE_OPTIONS: `--require=${preloadPath}` },
          timeout: 30_000,
        },
      );

      expect(result.status).toBe(0);
      expect(parseCliJson(result)).toMatchObject({ success: true });
      expect(Number(fs.readFileSync(timeoutPath, 'utf8'))).toBeGreaterThanOrEqual(
        120_000,
      );
    },
  );

  (process.platform === 'win32' ? it : it.skip)(
    'uses a bounded native batch for ADS verification',
    () => {
      const root = createFixture();
      const probePath = path.join(root, 'ads-command.json');
      const preloadPath = path.join(root, 'capture-ads-command.cjs');
      fs.writeFileSync(
        preloadPath,
        [
          "const childProcess = require('node:child_process');",
          "const fs = require('node:fs');",
          'const originalSpawnSync = childProcess.spawnSync;',
          'childProcess.spawnSync = function (command, args, options = {}) {',
          " if (String(command).toLowerCase().endsWith('\\\\powershell.exe')) {",
          `  fs.writeFileSync(${JSON.stringify(probePath)}, JSON.stringify(args));`,
          "  return { status: 0, signal: null, stdout: '', stderr: '' };",
          ' }',
          ' return originalSpawnSync.call(this, command, args, options);',
          '};',
          "require('node:module').syncBuiltinESMExports();",
        ].join('\n'),
      );
      const result = spawnSync(
        process.execPath,
        [scriptPath, ...cliArguments(fixtureInputPaths(root))],
        {
          encoding: 'utf8',
          env: { ...process.env, NODE_OPTIONS: `--require=${preloadPath}` },
          timeout: 30_000,
        },
      );

      expect(result.status).toBe(0);
      const commandArguments = JSON.parse(
        fs.readFileSync(probePath, 'utf8'),
      ) as string[];
      const command = commandArguments.join('\n');
      expect(command).toContain('AuditAll');
      expect(command).toContain('Parallel.ForEach');
      expect(command).toContain('MaxDegreeOfParallelism = 16');
    },
  );

  (process.platform === 'win32' ? it : it.skip)(
    'rejects an ancestor directory replaced by a junction during enumeration',
    () => {
      const root = createFixture();
      const externalRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'closure-ancestor-swap-target-'),
      );
      fixtureRoots.push(externalRoot);
      const externalDist = path.join(externalRoot, 'dist');
      fs.cpSync(path.join(root, 'dist'), externalDist, { recursive: true });
      const preloadPath = path.join(root, 'swap-runtime-ancestor.cjs');
      fs.writeFileSync(
        preloadPath,
        [
          "const fs = require('node:fs');",
          `const dist = ${JSON.stringify(path.join(root, 'dist'))};`,
          `const externalDist = ${JSON.stringify(externalDist)};`,
          'const backup = dist + ".original";',
          'const originalOpendirSync = fs.opendirSync;',
          'let swapped = false;',
          'fs.opendirSync = function (candidate, ...rest) {',
          " if (!swapped && String(candidate).replaceAll('\\\\', '/').endsWith('/dist/server')) {",
          '  fs.renameSync(dist, backup);',
          "  fs.symlinkSync(externalDist, dist, 'junction');",
          '  swapped = true;',
          ' }',
          ' return originalOpendirSync.call(this, candidate, ...rest);',
          '};',
          "require('node:module').syncBuiltinESMExports();",
        ].join('\n'),
      );
      const result = spawnSync(
        process.execPath,
        [scriptPath, ...cliArguments(fixtureInputPaths(root))],
        {
          encoding: 'utf8',
          env: { ...process.env, NODE_OPTIONS: `--require=${preloadPath}` },
          timeout: 30_000,
        },
      );
      expect(result.status).toBe(1);
      expect(parseCliJson(result)).toMatchObject({
        success: false,
        error: expect.stringContaining(
          'Concurrent mutation detected in runtime directory identity',
        ),
      });
    },
  );

  it('enumerates closure trees incrementally instead of using bulk readdir', () => {
    const root = createFixture();
    const preloadPath = path.join(root, 'reject-bulk-readdir.cjs');
    fs.writeFileSync(
      preloadPath,
      [
        "const fs = require('node:fs');",
        "fs.readdirSync = function () { throw new Error('bulk readdir forbidden'); };",
        "require('node:module').syncBuiltinESMExports();",
      ].join('\n'),
    );
    const result = spawnSync(
      process.execPath,
      [scriptPath, ...cliArguments(fixtureInputPaths(root))],
      {
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: `--require=${preloadPath}` },
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(0);
    expect(parseCliJson(result)).toMatchObject({ success: true });
  });

  it.each([
    [
      'lstat',
      [
        "const fs = require('node:fs');",
        'const original = fs.lstatSync;',
        "fs.lstatSync = function (candidate, ...rest) { if (String(candidate).endsWith('raced-link')) throw new Error('simulated lstat race at ' + candidate); return original.call(this, candidate, ...rest); };",
        "require('node:module').syncBuiltinESMExports();",
      ],
      true,
      'Unable to inspect runtime entry',
    ],
    [
      'directory enumeration',
      [
        "const fs = require('node:fs');",
        'const originalReaddir = fs.readdirSync;',
        'const originalOpendir = fs.opendirSync;',
        "const matches = (candidate) => String(candidate).replaceAll('\\\\', '/').endsWith('/dist/shared');",
        "fs.readdirSync = function (candidate, ...rest) { if (matches(candidate)) throw new Error('simulated readdir race at ' + candidate); return originalReaddir.call(this, candidate, ...rest); };",
        "fs.opendirSync = function (candidate, ...rest) { if (matches(candidate)) throw new Error('simulated opendir race at ' + candidate); return originalOpendir.call(this, candidate, ...rest); };",
        "require('node:module').syncBuiltinESMExports();",
      ],
      false,
      'Unable to enumerate dist/shared',
    ],
  ])(
    'sanitizes a %s race without leaking absolute paths',
    (_name, preloadLines, createRacedLink, errorText) => {
      const root = createFixture();
      if (createRacedLink) {
        const external = fs.mkdtempSync(
          path.join(os.tmpdir(), 'closure-raced-link-target-'),
        );
        fixtureRoots.push(external);
        fs.symlinkSync(
          external,
          path.join(root, 'dist', 'server', 'raced-link'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
      const preloadPath = path.join(
        root,
        `simulate-${String(_name).replaceAll(' ', '-')}.cjs`,
      );
      fs.writeFileSync(preloadPath, (preloadLines as string[]).join('\n'));
      const result = spawnSync(
        process.execPath,
        [scriptPath, ...cliArguments(fixtureInputPaths(root))],
        {
          encoding: 'utf8',
          env: { ...process.env, NODE_OPTIONS: `--require=${preloadPath}` },
          timeout: 30_000,
        },
      );
      expect(result.status).toBe(1);
      const report = parseCliJson(result);
      expect(report).toMatchObject({
        success: false,
        error: expect.stringContaining(errorText),
      });
      expect(`${result.stdout}${result.stderr}`).not.toContain(root);
    },
  );

  it('sanitizes unexpected CLI failures without leaking absolute paths', () => {
    const root = createFixture();
    const preloadPath = path.join(root, 'simulate-unexpected-cli-failure.cjs');
    fs.writeFileSync(
      preloadPath,
      [
        "const fs = require('node:fs');",
        "fs.existsSync = function (candidate) { throw new Error('simulated raw failure at ' + candidate); };",
        "require('node:module').syncBuiltinESMExports();",
      ].join('\n'),
    );
    const result = spawnSync(
      process.execPath,
      [scriptPath, ...cliArguments(fixtureInputPaths(root))],
      {
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: `--require=${preloadPath}` },
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(1);
    const report = parseCliJson(result);
    expect(report).toMatchObject({
      success: false,
      error: expect.stringContaining('simulated raw failure'),
    });
    expect(String(report.error)).not.toContain(root);
    expect(`${result.stdout}${result.stderr}`).not.toContain(root);
  });

  it('does not infer runtime roots from the package or lock location', () => {
    const root = createFixture();
    const metadataRoot = path.join(root, 'release-metadata');
    fs.mkdirSync(metadataRoot);
    const inputs = fixtureInputPaths(root);
    const independentInputs = {
      ...inputs,
      lockPath: path.join(metadataRoot, 'snapshot.lock.json'),
      packagePath: path.join(metadataRoot, 'snapshot.package.json'),
    };
    fs.renameSync(inputs.packagePath, independentInputs.packagePath);
    fs.renameSync(inputs.lockPath, independentInputs.lockPath);
    const result = runCliWithInputs(independentInputs);
    expect(result.status).toBe(0);
    expect(parseCliJson(result)).toMatchObject({ success: true });
  });

  it('returns one sanitized JSON object for unknown arguments', () => {
    const root = createFixture();
    const secret = 'DO-NOT-ECHO-THIS-VALUE';
    const result = runCli(root, ['--unknown-secret-option', secret]);
    const report = parseCliJson(result);
    expect(result.status).toBe(1);
    expect(report).toEqual({
      success: false,
      error: 'Invalid command arguments',
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      'unknown-secret-option',
    );
  });

  it('produces a deterministic fingerprint for unchanged inputs', () => {
    const root = createFixture();
    const first = parseCliJson(runCli(root));
    const second = parseCliJson(runCli(root));
    expect(first.runtimeClosureFingerprint).toBe(
      second.runtimeClosureFingerprint,
    );
  });

  it('requires the packager expected build fingerprint', () => {
    const root = createFixture();
    expect(runImportedVerifier(root, '', false)).toMatchObject({
      success: false,
      error: expect.stringContaining(
        'Expected runtime build fingerprint is required',
      ),
    });
  });

  it('rejects a runtime build fingerprint mismatch', () => {
    const root = createFixture();
    expect(
      runImportedVerifier(
        root,
        `expectedBuildFingerprint: ${JSON.stringify('0'.repeat(64))},`,
      ),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining('Runtime build fingerprint mismatch'),
    });
  });

  it('accepts the expected build fingerprint through the CLI', () => {
    const root = createFixture();
    const result = runCli(root);
    expect(result.status).toBe(0);
    expect(parseCliJson(result)).toMatchObject({ success: true });
  });

  it.each([
    ['files', 'limits: { maxFiles: 1 },'],
    ['entries', 'limits: { maxEntries: 1 },'],
    ['bytes', 'limits: { maxBytes: 1 },'],
    ['depth', 'limits: { maxDepth: 0 },'],
    ['imports', 'limits: { maxImports: 0 },'],
    [
      'deadline',
      "limits: { deadlineMs: 1 }, onProgress(event) { if (event.stage === 'runtime-snapshot') { const until = Date.now() + 20; while (Date.now() < until) {} } },",
    ],
  ])('enforces the %s runtime closure limit', (limitName, optionsSource) => {
    const root = createFixture();
    expect(runImportedVerifier(root, optionsSource)).toMatchObject({
      success: false,
      error: expect.stringContaining(
        `Runtime closure resource limit exceeded: ${limitName}`,
      ),
    });
  });

  it('enforces the reachable package-count limit', () => {
    const root = createFixture({
      dependencies: { parent: '1.0.0' },
      files: {
        'dist/server/main.js': "require('parent');\n",
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: { parent: {} },
    });
    expect(
      runImportedVerifier(root, 'limits: { maxPackages: 0 },'),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining(
        'Runtime closure resource limit exceeded: packages',
      ),
    });
  });

  it.each([
    [
      'dynamic require',
      "const name='node:fs'; require(name);",
      'Dynamic require',
    ],
    [
      'unicode escaped require',
      "const name='node:fs'; requ\\u0069re(name);",
      'Dynamic require',
    ],
    [
      'module.require',
      "const name='node:fs'; module.require(name);",
      'Dynamic require',
    ],
    [
      'computed module require',
      "const name='node:fs'; module['require'](name);",
      'Dynamic require',
    ],
    [
      'indirect module require',
      "module.require.call(module, 'node:fs');",
      'Unsupported runtime module loader',
    ],
    [
      'global require property',
      "globalThis.require('node:fs');",
      'Unsupported require usage',
    ],
    ['dynamic import', "const name='node:fs'; import(name);", 'Dynamic import'],
    [
      'require alias',
      "const loader=require; loader('node:fs');",
      'Unsupported require usage',
    ],
    ['eval', 'eval("require(\'hidden\')");', 'Dynamic code execution'],
    [
      'indirect eval',
      '(0, eval)("require(\'hidden\')");',
      'Dynamic code execution',
    ],
    [
      'Function',
      'Function("return require(\'hidden\')")();',
      'Dynamic code execution',
    ],
    [
      'new Function',
      'new Function("return import(\'hidden\')")();',
      'Dynamic code execution',
    ],
    ['invalid JavaScript', 'const = ;', 'JavaScript parse failure'],
    [
      'TypeScript import assignment',
      "import openapi = require('openapi');",
      'JavaScript parse failure',
    ],
    [
      'TypeScript type annotation',
      'const value: string = "x";',
      'JavaScript parse failure',
    ],
    [
      'TypeScript interface',
      'interface RuntimeShape { value: string }',
      'JavaScript parse failure',
    ],
  ])('fails closed for %s', (_name, source, errorText) => {
    const root = createFixture({
      files: {
        'dist/server/main.js': `${source}\n`,
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });
    expectCliFailure(root, errorText);
  });

  it('allows typeof checks of runtime loader globals without exposing them', () => {
    const root = createFixture({
      files: {
        'dist/server/main.js':
          'module.exports = [typeof require, typeof eval, typeof Function];\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });

    expect(parseCliJson(runCli(root))).toMatchObject({ success: true });
  });

  it.each([
    [
      'process.getBuiltinModule createRequire',
      "process.getBuiltinModule('module').createRequire(__filename)('node:fs');",
    ],
    [
      'constant-folded module require alias',
      "const load = module['re' + 'quire']; load('node:fs');",
    ],
    [
      'function parameter new Function',
      "function construct(owner, key) { return new owner[key]('return 1'); } construct(globalThis, 'Function');",
    ],
    [
      'function parameter computed loader',
      "function invoke(owner, key) { return owner[key]('node:fs'); } invoke(require('node:module').Module, '_load');",
    ],
    [
      'tagged template parameter loader',
      "function invoke(owner, key) { return owner[key]`void 0`; } invoke(globalThis, 'eval');",
    ],
    [
      'object container computed loader',
      "const box = { owner: require('node:module').Module, key: '_load' }; box.owner[box.key]('node:fs');",
    ],
    [
      'object container property descriptor loader',
      "const box = { owner: globalThis, key: 'eval' }; Object.getOwnPropertyDescriptor(box.owner, box.key).value('void 0');",
    ],
    [
      'object container Reflect.get loader',
      "const box = { owner: globalThis, key: 'eval' }; Reflect.get(box.owner, box.key)('void 0');",
    ],
    [
      'object method property descriptor loader',
      "const helper = { read(value, key) { return Object.getOwnPropertyDescriptor(value, String(key)); } }; helper.read(globalThis, 'eval').value('void 0');",
    ],
    [
      'plural global property descriptors loader',
      "const descriptors = Object.getOwnPropertyDescriptors(globalThis); descriptors.eval.value('void 0');",
    ],
    [
      'array destructured builtin loader',
      "const pair = [process, 'getBuiltinModule']; const [owner, key] = pair; owner[key]('node:module').createRequire(__filename)('node:fs');",
    ],
    [
      'ordinary object executable eval descriptor',
      "Object.getOwnPropertyDescriptor({ eval() { return 1; } }, 'eval').value('void 0');",
    ],
    [
      'dynamic global property descriptor',
      'const key = process.argv[2]; Object.getOwnPropertyDescriptor(globalThis, key);',
    ],
    [
      'function parameter dynamic global property descriptor',
      "function readValue(value, key) { const descriptor = Object.getOwnPropertyDescriptor(value, String(key)); return descriptor?.value; } readValue(globalThis, 'require')('node:fs');",
    ],
    [
      'aliased function parameter dynamic global property descriptor',
      "function readValue(value, key) { const descriptor = Object.getOwnPropertyDescriptor(value, String(key)); return descriptor?.value; } const alias = readValue; alias(globalThis, 'require')('node:fs');",
    ],
    ['constant-folded global eval', "globalThis['ev' + 'al']('void 0');"],
    [
      'aliased process.getBuiltinModule',
      "const loadBuiltin = process.getBuiltinModule; loadBuiltin('module').createRequire(__filename)('node:fs');",
    ],
    [
      'destructured process.getBuiltinModule',
      "const { getBuiltinModule: loadBuiltin } = process; loadBuiltin('module').createRequire(__filename)('node:fs');",
    ],
    [
      'process.getBuiltinModule.call',
      "process.getBuiltinModule.call(process, 'module').createRequire(__filename)('node:fs');",
    ],
    ['private module loader', "require('node:module')._load('node:fs');"],
    [
      'destructured module.require',
      "const { require: load } = module; load('node:fs');",
    ],
    ['aliased module.require', "const load = module.require; load('node:fs');"],
    ['module.require.call', "module.require.call(module, 'node:fs');"],
    ['Reflect.get eval', "Reflect.get(globalThis, 'eval')('void 0');"],
    [
      'aliased Reflect.get eval',
      "const readProperty = Reflect.get; readProperty(globalThis, 'eval')('void 0');",
    ],
    [
      'destructured Reflect.get eval',
      "const { get: readProperty } = Reflect; readProperty(globalThis, 'eval')('void 0');",
    ],
    [
      'Reflect.get dynamic global property',
      "const key = 'eval'; Reflect.get(globalThis, key)('void 0');",
    ],
    [
      'computed destructured module.require',
      "const { ['require']: load } = module; load('node:fs');",
    ],
    [
      'computed global Function',
      "const compile = globalThis['Function']; compile('return 1')();",
    ],
    [
      'destructured global eval',
      "const { eval: execute } = globalThis; execute('void 0');",
    ],
    [
      'destructured global Function',
      "const { Function: compile } = globalThis; compile('return 1')();",
    ],
    ['ordinary function constructor', '(()=>{}).constructor("return 1")();'],
    [
      'aliased ordinary function constructor',
      'const F=(()=>{}).constructor; F("return 1")();',
    ],
    [
      'constructor.constructor chain',
      '({}).constructor.constructor("return 1")();',
    ],
  ])('rejects the %s loader bypass with a fixed error', (_name, source) => {
    const root = createFixture({
      files: {
        'dist/server/main.js': `${source}\n`,
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });
    expectCliFailure(root, 'Unsupported runtime module loader');
  });

  it('allows computed properties and aliases on ordinary objects', () => {
    const root = createFixture({
      files: {
        'dist/server/main.js': [
          'const ordinary = { constructor: { safe() { return 1; } }, eval() { return 2; } };',
          'const alias = ordinary;',
          "const key = 'safe';",
          'alias.constructor[key]();',
          'alias.eval();',
          'module.exports = process.version;',
        ].join('\n'),
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });
    expect(parseCliJson(runCli(root))).toMatchObject({ success: true });
  });

  it('allows descriptor snapshots on ordinary data objects', () => {
    const root = createFixture({
      files: {
        'dist/server/main.js': [
          'function readValue(value, index) {',
          '  const descriptors = Object.getOwnPropertyDescriptors(value);',
          '  const descriptor = descriptors[String(index)];',
          "  return descriptor && 'value' in descriptor ? descriptor.value : undefined;",
          '}',
          "module.exports = readValue({ 0: 'safe' }, 0);",
        ].join('\n'),
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });
    expect(parseCliJson(runCli(root))).toMatchObject({ success: true });
  });

  it('allows the constrained esbuild property descriptor copy helper', () => {
    const root = createFixture({
      files: {
        'dist/server/main.js': [
          'var __defProp = Object.defineProperty;',
          'var __getOwnPropDesc = Object.getOwnPropertyDescriptor;',
          'var __getOwnPropNames = Object.getOwnPropertyNames;',
          'var __hasOwnProp = Object.prototype.hasOwnProperty;',
          'var __copyProps = (to, from, except, desc) => {',
          '  if (from && typeof from === "object" || typeof from === "function") {',
          '    for (let key of __getOwnPropNames(from))',
          '      if (!__hasOwnProp.call(to, key) && key !== except)',
          '        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });',
          '  }',
          '  return to;',
          '};',
          'module.exports = __copyProps({}, { safe: true });',
        ].join('\n'),
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });

    expect(parseCliJson(runCli(root))).toMatchObject({ success: true });
  });

  it('rejects an esbuild descriptor alias used outside its copy helper', () => {
    const root = createFixture({
      files: {
        'dist/server/main.js': [
          'var __getOwnPropDesc = Object.getOwnPropertyDescriptor;',
          'var __copyProps = (to, from) => {',
          '  for (const key of Object.getOwnPropertyNames(from)) __getOwnPropDesc(from, key);',
          '  return to;',
          '};',
          '__getOwnPropDesc(globalThis, "eval");',
          'module.exports = __copyProps({}, {});',
        ].join('\n'),
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });

    expectCliFailure(root, 'Unsupported runtime module loader');
  });

  it('allows a reachable package to read a static descriptor from an ordinary literal', () => {
    const root = createFixture({
      dependencies: { descriptorHelper: '1.0.0' },
      files: {
        'dist/server/main.js':
          'module.exports = require("descriptorHelper");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        descriptorHelper: {
          version: '1.0.0',
          files: {
            'index.js': [
              'function readDescriptor() {',
              "  return Object.getOwnPropertyDescriptor({ safe: true }, 'safe');",
              '}',
              'module.exports = readDescriptor();',
            ].join('\n'),
          },
        },
      },
    });

    expect(parseCliJson(runCli(root))).toMatchObject({ success: true });
  });

  it('allows the tslib UMD exporter to write helpers through a computed export key', () => {
    const root = createFixture({
      dependencies: { tslib: '1.0.0' },
      files: {
        'dist/server/main.js': 'module.exports = require("tslib");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        tslib: {
          version: '1.0.0',
          manifest: { main: 'tslib.js' },
          files: {
            'tslib.js': [
              '(function (factory) {',
              '  var root = typeof global === "object" ? global : {};',
              '  factory(createExporter(root, createExporter(module.exports)));',
              '  function createExporter(exports, previous) {',
              '    return function (id, value) {',
              '      return exports[id] = previous ? previous(id, value) : value;',
              '    };',
              '  }',
              '})(function (exporter) {',
              '  exporter("__helper", function () {});',
              '});',
            ].join('\n'),
          },
        },
      },
    });

    expect(parseCliJson(runCli(root))).toMatchObject({ success: true });
  });

  it('accepts the installed tslib CommonJS runtime entry', () => {
    const installedTslib = fs.readFileSync(
      path.join(projectRoot, 'node_modules', 'tslib', 'tslib.js'),
      'utf8',
    );
    const root = createFixture({
      dependencies: { tslib: '2.8.1' },
      files: {
        'dist/server/main.js': 'module.exports = require("tslib");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        tslib: {
          version: '2.8.1',
          manifest: { main: 'tslib.js' },
          files: { 'tslib.js': installedTslib },
        },
      },
    });

    expect(parseCliJson(runCli(root))).toMatchObject({ success: true });
  });

  it('rejects a modified tslib runtime entry at the audited package path', () => {
    const installedTslib = fs.readFileSync(
      path.join(projectRoot, 'node_modules', 'tslib', 'tslib.js'),
      'utf8',
    );
    const root = createFixture({
      dependencies: { tslib: '2.8.1' },
      files: {
        'dist/server/main.js': 'module.exports = require("tslib");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        tslib: {
          version: '2.8.1',
          manifest: { main: 'tslib.js' },
          files: { 'tslib.js': `${installedTslib}\n// modified\n` },
        },
      },
    });

    expectCliFailure(root, 'Unsupported runtime module loader');
  });

  it('accepts the audited Nest optional require helper', () => {
    const optionalRequire = fs.readFileSync(
      path.join(
        projectRoot,
        'node_modules',
        '@nestjs',
        'core',
        'helpers',
        'optional-require.js',
      ),
      'utf8',
    );
    const root = createFixture({
      dependencies: { '@nestjs/core': '10.4.22' },
      files: {
        'dist/server/main.js':
          'module.exports = require("@nestjs/core/helpers/optional-require");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        '@nestjs/core': {
          version: '10.4.22',
          files: {
            'index.js': 'module.exports = {};\n',
            'helpers/optional-require.js': optionalRequire,
          },
        },
      },
    });

    expect(parseCliJson(runCli(root))).toMatchObject({ success: true });
  });

  it('accepts the other audited Nest dynamic require helpers', () => {
    const readInstalled = (...segments: string[]) =>
      fs.readFileSync(
        path.join(projectRoot, 'node_modules', ...segments),
        'utf8',
      );
    const root = createFixture({
      dependencies: {
        '@nestjs/common': '10.4.22',
        '@nestjs/core': '10.4.22',
      },
      files: {
        'dist/server/main.js': [
          'require("@nestjs/common/utils/load-package.util");',
          'module.exports = require("@nestjs/core/helpers/load-adapter");',
        ].join('\n'),
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        '@nestjs/common': {
          version: '10.4.22',
          files: {
            'index.js': 'exports.Logger = class Logger {};\n',
            'services/logger.service.js':
              'exports.Logger = class Logger { error() {} static flush() {} };\n',
            'utils/load-package.util.js': readInstalled(
              '@nestjs',
              'common',
              'utils',
              'load-package.util.js',
            ),
          },
        },
        '@nestjs/core': {
          version: '10.4.22',
          dependencies: { '@nestjs/common': '10.4.22' },
          files: {
            'index.js': 'module.exports = {};\n',
            'helpers/load-adapter.js': readInstalled(
              '@nestjs',
              'core',
              'helpers',
              'load-adapter.js',
            ),
          },
        },
      },
    });

    expect(parseCliJson(runCli(root))).toMatchObject({ success: true });
  });

  it('accepts the audited Nest file type validator literal ESM loader', () => {
    const fileTypeValidator = fs.readFileSync(
      path.join(
        projectRoot,
        'node_modules',
        '@nestjs',
        'common',
        'pipes',
        'file',
        'file-type.validator.js',
      ),
      'utf8',
    );
    const root = createFixture({
      dependencies: { '@nestjs/common': '10.4.22' },
      files: {
        'dist/server/main.js':
          'module.exports = require("@nestjs/common/pipes/file/file-type.validator");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        '@nestjs/common': {
          version: '10.4.22',
          dependencies: { 'file-type': '20.4.1' },
          files: {
            'index.js': 'module.exports = {};\n',
            'pipes/file/file-type.validator.js': fileTypeValidator,
            'pipes/file/file-validator.interface.js': [
              'class FileValidator {',
              '  constructor(validationOptions) { this.validationOptions = validationOptions; }',
              '}',
              'exports.FileValidator = FileValidator;',
            ].join('\n'),
          },
        },
        'file-type': {
          version: '20.4.1',
          manifest: { type: 'module' },
          files: {
            'index.js':
              'export const fileTypeFromBuffer = async () => undefined;\n',
          },
        },
      },
    });

    expect(parseCliJson(runCli(root))).toMatchObject({ success: true });
  });

  it('rejects a modified Nest file type validator literal ESM loader', () => {
    const fileTypeValidator = fs.readFileSync(
      path.join(
        projectRoot,
        'node_modules',
        '@nestjs',
        'common',
        'pipes',
        'file',
        'file-type.validator.js',
      ),
      'utf8',
    );
    const root = createFixture({
      dependencies: { '@nestjs/common': '10.4.22' },
      files: {
        'dist/server/main.js':
          'module.exports = require("@nestjs/common/pipes/file/file-type.validator");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        '@nestjs/common': {
          version: '10.4.22',
          files: {
            'index.js': 'module.exports = {};\n',
            'pipes/file/file-type.validator.js': `${fileTypeValidator}\n// modified\n`,
            'pipes/file/file-validator.interface.js':
              'exports.FileValidator = class FileValidator {};\n',
          },
        },
      },
    });

    expectCliFailure(root, 'Dynamic code execution');
  });

  it('trusts only the exact audited Lark bundled runtime bytes', () => {
    const bundledRuntimePath = path.join(
      projectRoot,
      'node_modules',
      '@lark-apaas',
      'fullstack-nestjs-core',
      'dist',
      'index.cjs',
    );
    const moduleUrl = pathToFileURL(scriptPath).href;
    const program = [
      "import { readFileSync } from 'node:fs';",
      `import { isAuditedBundledRuntimeSource } from ${JSON.stringify(moduleUrl)};`,
      `const source = readFileSync(${JSON.stringify(bundledRuntimePath)}, 'utf8');`,
      "const label = 'node_modules/@lark-apaas/fullstack-nestjs-core/dist/index.cjs';",
      'process.stdout.write(JSON.stringify({',
      '  exact: isAuditedBundledRuntimeSource(label, source),',
      "  modified: isAuditedBundledRuntimeSource(label, source + '\\n// modified\\n'),",
      "  wrongPath: isAuditedBundledRuntimeSource('node_modules/other/index.cjs', source),",
      '}));',
    ].join('\n');
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', program],
      { encoding: 'utf8', timeout: 30_000 },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      exact: true,
      modified: false,
      wrongPath: false,
    });
  });

  it('trusts only the exact audited XLSX bundled runtime bytes', () => {
    const bundledRuntimePath = path.join(
      projectRoot,
      'node_modules',
      'xlsx-js-style',
      'dist',
      'xlsx.min.js',
    );
    const moduleUrl = pathToFileURL(scriptPath).href;
    const program = [
      "import { readFileSync } from 'node:fs';",
      `import { isAuditedBundledRuntimeSource } from ${JSON.stringify(moduleUrl)};`,
      `const source = readFileSync(${JSON.stringify(bundledRuntimePath)}, 'utf8');`,
      "const label = 'node_modules/xlsx-js-style/dist/xlsx.min.js';",
      'process.stdout.write(JSON.stringify({',
      '  exact: isAuditedBundledRuntimeSource(label, source),',
      "  modified: isAuditedBundledRuntimeSource(label, source + '\\n// modified\\n'),",
      "  wrongPath: isAuditedBundledRuntimeSource('node_modules/other/xlsx.min.js', source),",
      '}));',
    ].join('\n');
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', program],
      { encoding: 'utf8', timeout: 30_000 },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      exact: true,
      modified: false,
      wrongPath: false,
    });
  });

  it('accepts the audited Nest config module parameter shadowing CommonJS module', () => {
    const conditionalModule = fs.readFileSync(
      path.join(
        projectRoot,
        'node_modules',
        '@nestjs',
        'config',
        'dist',
        'conditional.module.js',
      ),
      'utf8',
    );
    const root = createFixture({
      dependencies: { '@nestjs/config': '3.3.0' },
      files: {
        'dist/server/main.js':
          'module.exports = require("@nestjs/config/dist/conditional.module");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        '@nestjs/config': {
          version: '3.3.0',
          dependencies: { '@nestjs/common': '10.4.22' },
          files: {
            'index.js': 'module.exports = {};\n',
            'dist/conditional.module.js': conditionalModule,
            'dist/config.module.js':
              'exports.ConfigModule = class ConfigModule {};\n',
          },
        },
        '@nestjs/common': {
          version: '10.4.22',
          files: {
            'index.js': [
              'exports.Module = () => value => value;',
              'exports.Logger = class Logger {};',
            ].join('\n'),
          },
        },
      },
    });

    expect(parseCliJson(runCli(root))).toMatchObject({ success: true });
  });

  it('rejects a modified Nest config module parameter shadowing CommonJS module', () => {
    const conditionalModule = fs.readFileSync(
      path.join(
        projectRoot,
        'node_modules',
        '@nestjs',
        'config',
        'dist',
        'conditional.module.js',
      ),
      'utf8',
    );
    const root = createFixture({
      dependencies: { '@nestjs/config': '3.3.0' },
      files: {
        'dist/server/main.js':
          'module.exports = require("@nestjs/config/dist/conditional.module");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        '@nestjs/config': {
          version: '3.3.0',
          files: {
            'index.js': 'module.exports = {};\n',
            'dist/conditional.module.js': `${conditionalModule}\n// modified\n`,
            'dist/config.module.js': 'module.exports = {};\n',
          },
        },
      },
    });

    expectCliFailure(root, 'Unsupported require usage');
  });

  it('rejects a modified Swagger metadata factory computed dispatch helper', () => {
    const partialTypeHelper = fs.readFileSync(
      path.join(
        projectRoot,
        'node_modules',
        '@nestjs',
        'swagger',
        'dist',
        'type-helpers',
        'partial-type.helper.js',
      ),
      'utf8',
    );
    const root = createFixture({
      dependencies: { '@nestjs/swagger': '7.4.2' },
      files: {
        'dist/server/main.js':
          'module.exports = require("@nestjs/swagger/dist/type-helpers/partial-type.helper");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        '@nestjs/swagger': {
          version: '7.4.2',
          files: {
            'index.js': 'module.exports = {};\n',
            'dist/type-helpers/partial-type.helper.js': `${partialTypeHelper}\n// modified\n`,
          },
        },
      },
    });

    expectCliFailure(root, 'Unsupported runtime module loader');
  });

  it('rejects a modified Nest axios create-binding descriptor helper', () => {
    const axiosIndex = fs.readFileSync(
      path.join(
        projectRoot,
        'node_modules',
        '@nestjs',
        'axios',
        'dist',
        'index.js',
      ),
      'utf8',
    );
    const root = createFixture({
      dependencies: { '@nestjs/axios': '4.0.1' },
      files: {
        'dist/server/main.js': 'module.exports = require("@nestjs/axios");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        '@nestjs/axios': {
          version: '4.0.1',
          files: {
            'index.js': `${axiosIndex}\n// modified\n`,
          },
        },
      },
    });

    expectCliFailure(root, 'Unsupported runtime module loader');
  });

  it('rejects a modified Drizzle relations computed dispatch helper', () => {
    const relations = fs.readFileSync(
      path.join(projectRoot, 'node_modules', 'drizzle-orm', 'relations.cjs'),
      'utf8',
    );
    const root = createFixture({
      dependencies: { 'drizzle-orm': '0.44.6' },
      files: {
        'dist/server/main.js':
          'module.exports = require("drizzle-orm/relations");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        'drizzle-orm': {
          version: '0.44.6',
          manifest: {
            exports: {
              './relations': {
                require: './relations.cjs',
              },
            },
          },
          files: {
            'index.js': 'module.exports = {};\n',
            'relations.cjs': `${relations}\n// modified\n`,
          },
        },
      },
    });

    expectCliFailure(root, 'Unsupported runtime module loader');
  });

  it('rejects a modified HBS async helper queue dispatch', () => {
    const hbs = fs.readFileSync(
      path.join(projectRoot, 'node_modules', 'hbs', 'lib', 'hbs.js'),
      'utf8',
    );
    const root = createFixture({
      dependencies: { hbs: '4.2.0' },
      files: {
        'dist/server/main.js': 'module.exports = require("hbs/lib/hbs");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        hbs: {
          version: '4.2.0',
          files: {
            'index.js': 'module.exports = {};\n',
            'lib/hbs.js': `${hbs}\n// modified\n`,
          },
        },
      },
    });

    expectCliFailure(root, 'Unsupported runtime module loader');
  });

  it('rejects a modified Nest Express body parser dispatch', () => {
    const expressAdapter = fs.readFileSync(
      path.join(
        projectRoot,
        'node_modules',
        '@nestjs',
        'platform-express',
        'adapters',
        'express-adapter.js',
      ),
      'utf8',
    );
    const root = createFixture({
      dependencies: { '@nestjs/platform-express': '10.4.22' },
      files: {
        'dist/server/main.js':
          'module.exports = require("@nestjs/platform-express/adapters/express-adapter");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        '@nestjs/platform-express': {
          version: '10.4.22',
          files: {
            'index.js': 'module.exports = {};\n',
            'adapters/express-adapter.js': `${expressAdapter}\n// modified\n`,
          },
        },
      },
    });

    expectCliFailure(root, 'Unsupported runtime module loader');
  });

  it('rejects a modified COS SDK event listener dispatch', () => {
    const eventRuntime = fs.readFileSync(
      path.join(
        projectRoot,
        'node_modules',
        'cos-nodejs-sdk-v5',
        'sdk',
        'event.js',
      ),
      'utf8',
    );
    const root = createFixture({
      dependencies: { 'cos-nodejs-sdk-v5': '3.0.0' },
      files: {
        'dist/server/main.js':
          'module.exports = require("cos-nodejs-sdk-v5/sdk/event");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        'cos-nodejs-sdk-v5': {
          version: '3.0.0',
          files: {
            'index.js': 'module.exports = {};\n',
            'sdk/event.js': `${eventRuntime}\n// modified\n`,
          },
        },
      },
    });

    expectCliFailure(root, 'Unsupported runtime module loader');
  });

  it('rejects a modified Nest metadata scanner descriptor lookup', () => {
    const metadataScanner = fs.readFileSync(
      path.join(
        projectRoot,
        'node_modules',
        '@nestjs',
        'core',
        'metadata-scanner.js',
      ),
      'utf8',
    );
    const root = createFixture({
      dependencies: { '@nestjs/core': '10.4.22' },
      files: {
        'dist/server/main.js':
          'module.exports = require("@nestjs/core/metadata-scanner");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        '@nestjs/core': {
          version: '10.4.22',
          files: {
            'index.js': 'module.exports = {};\n',
            'metadata-scanner.js': `${metadataScanner}\n// modified\n`,
          },
        },
      },
    });

    expectCliFailure(root, 'Unsupported runtime module loader');
  });

  it('rejects a modified Nest REPL descriptor copy helper', () => {
    const assignToObject = fs.readFileSync(
      path.join(
        projectRoot,
        'node_modules',
        '@nestjs',
        'core',
        'repl',
        'assign-to-object.util.js',
      ),
      'utf8',
    );
    const root = createFixture({
      dependencies: { '@nestjs/core': '10.4.22' },
      files: {
        'dist/server/main.js':
          'module.exports = require("@nestjs/core/repl/assign-to-object.util");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        '@nestjs/core': {
          version: '10.4.22',
          files: {
            'index.js': 'module.exports = {};\n',
            'repl/assign-to-object.util.js': `${assignToObject}\n// modified\n`,
          },
        },
      },
    });

    expectCliFailure(root, 'Unsupported runtime module loader');
  });

  it('rejects a modified Nest optional require helper', () => {
    const optionalRequire = fs.readFileSync(
      path.join(
        projectRoot,
        'node_modules',
        '@nestjs',
        'core',
        'helpers',
        'optional-require.js',
      ),
      'utf8',
    );
    const root = createFixture({
      dependencies: { '@nestjs/core': '10.4.22' },
      files: {
        'dist/server/main.js':
          'module.exports = require("@nestjs/core/helpers/optional-require");\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        '@nestjs/core': {
          version: '10.4.22',
          files: {
            'index.js': 'module.exports = {};\n',
            'helpers/optional-require.js': `${optionalRequire}\n// modified\n`,
          },
        },
      },
    });

    expectCliFailure(root, 'Dynamic require');
  });

  it('allows TypeScript decorator metadata to reference the Function constructor as data', () => {
    const root = createFixture({
      dependencies: { tslib: '1.0.0' },
      files: {
        'dist/server/main.js':
          'const tslib_1 = require("tslib");\ntslib_1.__metadata("design:type", Function);\nmodule.exports = {};\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        tslib: { version: '1.0.0' },
      },
    });
    expect(parseCliJson(runCli(root))).toMatchObject({ success: true });
  });

  it('allows the standard TypeScript direct metadata helper to reference Function as data', () => {
    const root = createFixture({
      files: {
        'dist/server/main.js': [
          'var __metadata = (this && this.__metadata) || function (k, v) {',
          '  if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);',
          '};',
          '__metadata("design:paramtypes", [Function]);',
          'module.exports = {};',
        ].join('\n'),
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });

    expect(parseCliJson(runCli(root))).toMatchObject({ success: true });
  });

  it('rejects a custom direct metadata helper that receives Function', () => {
    const root = createFixture({
      files: {
        'dist/server/main.js': [
          'var __metadata = function (_kind, value) { return value; };',
          '__metadata("design:paramtypes", [Function]);',
          'module.exports = {};',
        ].join('\n'),
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });

    expectCliFailure(root, 'Dynamic code execution');
  });

  it('rejects a reassigned standard direct metadata helper', () => {
    const root = createFixture({
      files: {
        'dist/server/main.js': [
          'var __metadata = (this && this.__metadata) || function (k, v) {',
          '  if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);',
          '};',
          '__metadata = function () {};',
          '__metadata("design:paramtypes", [Function]);',
          'module.exports = {};',
        ].join('\n'),
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });

    expectCliFailure(root, 'Dynamic code execution');
  });

  it('rejects Function hidden in an extra direct metadata helper argument', () => {
    const root = createFixture({
      files: {
        'dist/server/main.js': [
          'var __metadata = (this && this.__metadata) || function (k, v) {',
          '  if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);',
          '};',
          '__metadata("design:type", String, [Function]);',
          'module.exports = {};',
        ].join('\n'),
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });

    expectCliFailure(root, 'Dynamic code execution');
  });

  it('allows the Function constructor as the right operand of instanceof', () => {
    const root = createFixture({
      files: {
        'dist/server/main.js':
          'const candidate = () => {};\nmodule.exports = candidate instanceof Function;\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });

    expect(parseCliJson(runCli(root))).toMatchObject({ success: true });
  });

  it('allows Function.prototype.toString.call as a data inspection', () => {
    const root = createFixture({
      files: {
        'dist/server/main.js':
          'function sample() {}\nmodule.exports = Function.prototype.toString.call(sample);\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });

    expect(parseCliJson(runCli(root))).toMatchObject({ success: true });
  });

  it('resolves root runtime imports from the explicit production install when dist is isolated', () => {
    const productionRoot = createFixture({
      dependencies: { tslib: '1.0.0' },
      packages: {
        tslib: { version: '1.0.0' },
      },
    });
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'production-runtime-isolated-dist-'),
    );
    fixtureRoots.push(runtimeRoot);
    writeFixtureFile(
      runtimeRoot,
      'dist/server/main.js',
      'module.exports = require("tslib");\n',
    );
    writeFixtureFile(
      runtimeRoot,
      'dist/shared/empty.js',
      'module.exports = {};\n',
    );
    const inputs: RuntimeInputPaths = {
      ...fixtureInputPaths(productionRoot),
      serverRoot: path.join(runtimeRoot, 'dist', 'server'),
      sharedRoot: path.join(runtimeRoot, 'dist', 'shared'),
    };

    const result = runCliWithInputs(inputs);

    expect(result.status).toBe(0);
    expect(parseCliJson(result)).toMatchObject({ success: true });
  });

  it('allows a for-of object binding without a variable initializer', () => {
    const root = createFixture({
      files: {
        'dist/server/main.js':
          'for (const { value } of []) { module.exports = value; }\nmodule.exports = {};\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });
    const result = runCli(root);
    expect(result.status).toBe(0);
    expect(parseCliJson(result)).toMatchObject({ success: true });
  });

  it('supports static module.require, computed module require, and createRequire', () => {
    const root = createFixture({
      files: {
        'dist/server/main.js': [
          "module.require('node:fs');",
          "module['require']('node:path');",
          'if (require.main === module) void 0;',
          "const { createRequire } = require('node:module');",
          'const localRequire = createRequire(__filename);',
          "localRequire('node:crypto');",
          "localRequire.resolve('node:fs');",
        ].join('\n'),
        'dist/server/esm.mjs': [
          "import { createRequire as makeRequire } from 'node:module';",
          'const localRequire = makeRequire(import.meta.url);',
          "localRequire('node:url');",
        ].join('\n'),
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });
    const result = runCli(root);
    expect(result.status).toBe(0);
    expect(parseCliJson(result)).toMatchObject({
      success: true,
      importCount: 7,
    });
  });

  it('supports createRequire obtained from the CommonJS module builtin', () => {
    const root = createFixture({
      files: {
        'dist/server/main.js': [
          "const makeRequire = require('module').createRequire;",
          'const localRequire = makeRequire(__filename);',
          "localRequire('node:fs');",
        ].join('\n'),
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });
    const result = runCli(root);
    expect(result.status).toBe(0);
    expect(parseCliJson(result)).toMatchObject({
      success: true,
      importCount: 2,
    });
  });

  it.each([
    [
      'dynamic created require',
      "const {createRequire}=require('node:module'); const r=createRequire(__filename); const n='node:fs'; r(n);",
      'Dynamic require',
    ],
    [
      'aliased created require',
      "const {createRequire}=require('node:module'); const r=createRequire(__filename); const x=r; x('node:fs');",
      'Unsupported require usage',
    ],
    [
      'unsafe created require base',
      "const {createRequire}=require('node:module'); const r=createRequire('/tmp/outside.js'); r('node:fs');",
      'Unsupported createRequire base',
    ],
  ])('rejects %s', (_name, source, errorText) => {
    const root = createFixture({
      files: {
        'dist/server/main.js': `${source}\n`,
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });
    expectCliFailure(root, errorText);
  });

  it('implements CommonJS exact, extension, JSON, package main, and index resolution', () => {
    const root = createFixture({
      files: {
        'dist/server/main.js': [
          "require('./exact');",
          "require('./dotted.filter');",
          "require('./data');",
          "require('./with-main');",
          "require('./with-index');",
        ].join('\n'),
        'dist/server/exact': 'module.exports = 1;\n',
        'dist/server/dotted.filter.js': 'module.exports = 2;\n',
        'dist/server/data.json': '{"ok":true}\n',
        'dist/server/with-main/package.json': '{"main":"lib/entry"}\n',
        'dist/server/with-main/lib/entry.js': 'module.exports = 3;\n',
        'dist/server/with-index/index.json': '{"ok":true}\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });
    const result = runCli(root);
    expect(result.status).toBe(0);
    expect(parseCliJson(result)).toMatchObject({
      success: true,
      importCount: 5,
    });
  });

  it('uses ESM exact resolution and package import conditions', () => {
    const root = createFixture({
      dependencies: { conditional: '1.0.0' },
      packages: {
        conditional: {
          manifest: {
            type: 'module',
            exports: { import: './esm.js', require: './cjs.cjs' },
          },
          files: {
            'esm.js': 'export default {};\n',
            'cjs.cjs': 'module.exports = {};\n',
          },
        },
      },
      files: {
        'dist/server/main.js': "require('conditional');\n",
        'dist/server/esm.mjs': "import value from 'conditional'; void value;\n",
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });
    const result = runCli(root);
    const report = parseCliJson(result);
    expect(report).not.toHaveProperty('error');
    expect(report).toMatchObject({ success: true, importCount: 2 });
    expect(result.status).toBe(0);
  });

  it.each([
    [
      'ESM directory fallback',
      "import './folder';",
      { 'dist/server/folder/index.js': 'export {};\n' },
      'Missing relative runtime dependency',
    ],
    [
      'native relative addon',
      "require('./native');",
      { 'dist/server/native.node': Buffer.from('not-native') as any },
      'Native addon',
    ],
    [
      'relative escape',
      "require('../../outside');",
      { 'outside.js': 'module.exports = {};\n' },
      'escapes runtime roots',
    ],
  ])('rejects %s', (_name, statement, extras, errorText) => {
    const root = createFixture({
      files: {
        'dist/server/main.js': `${statement}\n`,
        'dist/shared/empty.js': 'module.exports = {};\n',
        ...(extras as Record<string, string>),
      },
    });
    expectCliFailure(root, errorText);
  });

  it('validates the complete transitive production dependency closure', () => {
    const root = createFixture({
      dependencies: { parent: '1.0.0' },
      packages: {
        parent: {
          dependencies: { child: '2.0.0' },
          files: { 'index.js': "module.exports = require('child');\n" },
        },
        child: { version: '2.0.0' },
      },
      files: {
        'dist/server/main.js': "require('parent');\n",
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });
    expect(runCli(root).status).toBe(0);
  });

  it.each([
    [
      'invalid JavaScript in an entry',
      'const = ;\n',
      {},
      'JavaScript parse failure in node_modules/parent/index.js',
    ],
    [
      'a missing relative dependency',
      "module.exports = require('./missing');\n",
      {},
      'Missing relative runtime dependency in node_modules/parent/index.js',
    ],
    [
      'an undeclared bare dependency',
      "module.exports = require('hidden');\n",
      { hidden: {} },
      'Undeclared package runtime dependency in node_modules/parent/index.js',
    ],
  ])(
    'rejects %s from a reachable third-party package',
    (_name, parentSource, extraPackages, errorText) => {
      const root = createFixture({
        dependencies: { parent: '1.0.0' },
        files: {
          'dist/server/main.js': "require('parent');\n",
          'dist/shared/empty.js': 'module.exports = {};\n',
        },
        packages: {
          parent: { files: { 'index.js': parentSource as string } },
          ...(extraPackages as Record<string, PackageFixture>),
        },
      });
      expectCliFailure(root, errorText as string);
    },
  );

  it('scans the complete reachable package source import graph', () => {
    const root = createFixture({
      dependencies: { parent: '1.0.0' },
      files: {
        'dist/server/main.js': "require('parent');\n",
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        child: { version: '2.0.0' },
        parent: {
          dependencies: { child: '2.0.0' },
          files: {
            'index.js': "module.exports = require('./lib');\n",
            'lib.js': "module.exports = require('child');\n",
          },
        },
      },
    });
    expect(parseCliJson(runCli(root))).toMatchObject({
      success: true,
      importCount: 3,
    });
  });

  it('attributes an importer to the deepest nested package root', () => {
    const root = createFixture({
      dependencies: { parent: '1.0.0' },
      files: {
        'dist/server/main.js': "require('parent');\n",
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      packages: {
        parent: {
          dependencies: { child: '2.0.0', hidden: '3.0.0' },
          files: { 'index.js': "module.exports = require('child');\n" },
        },
        child: {
          location: 'node_modules/parent/node_modules/child',
          version: '2.0.0',
          files: { 'index.js': "module.exports = require('hidden');\n" },
        },
        hidden: { version: '3.0.0' },
      },
    });
    expectCliFailure(root, 'Undeclared package runtime dependency');
  });

  it('accepts an imported root optional production dependency', () => {
    const root = createFixture({
      optionalDependencies: { optional: '1.0.0' },
      packages: { optional: {} },
      files: {
        'dist/server/main.js': "require('optional');\n",
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });
    const result = runCli(root);
    expect(result.status).toBe(0);
    expect(parseCliJson(result)).toMatchObject({ success: true });
  });

  it.each([
    ['undeclared direct', {}, {}, undefined, 'Undeclared runtime dependency'],
    [
      'development-only direct',
      {},
      { parent: '1.0.0' },
      undefined,
      'Development-only runtime dependency',
    ],
    [
      'missing physical package',
      { parent: '1.0.0' },
      {},
      'remove-package',
      'Missing installed runtime dependency',
    ],
    [
      'missing lock entry',
      { parent: '1.0.0' },
      {},
      'remove-lock',
      'Missing package-lock entry',
    ],
    [
      'installed version drift',
      { parent: '1.0.0' },
      {},
      'drift',
      'Installed package version drift',
    ],
    [
      'development-only lock entry',
      { parent: '1.0.0' },
      {},
      'dev-lock',
      'Development-only package-lock entry',
    ],
  ])(
    'rejects %s',
    (_name, dependencies, devDependencies, mutation, errorText) => {
      const root = createFixture({
        dependencies,
        devDependencies,
        packages: mutation === 'remove-package' ? {} : { parent: {} },
        lockMutator: (lock) => {
          if (mutation === 'remove-lock')
            delete lock.packages['node_modules/parent'];
          if (mutation === 'dev-lock')
            lock.packages['node_modules/parent'].dev = true;
        },
        files: {
          'dist/server/main.js': "require('parent');\n",
          'dist/shared/empty.js': 'module.exports = {};\n',
        },
      });
      if (mutation === 'drift') {
        const manifestPath = path.join(
          root,
          'node_modules',
          'parent',
          'package.json',
        );
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.version = '9.9.9';
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      }
      expectCliFailure(root, errorText);
    },
  );

  it('rejects a missing transitive dependency from the lock/physical closure', () => {
    const root = createFixture({
      dependencies: { parent: '1.0.0' },
      packages: {
        parent: {
          dependencies: { child: '2.0.0' },
          files: { 'index.js': "module.exports = require('child');\n" },
        },
      },
      files: {
        'dist/server/main.js': "require('parent');\n",
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });
    expectCliFailure(root, 'Missing transitive runtime dependency');
  });

  it('keeps transitive dependency validation on the locked-tree fast path', () => {
    const root = createFixture({
      dependencies: { parent: '1.0.0' },
      packages: {
        parent: {
          dependencies: { child: '2.0.0' },
          files: { 'index.js': "module.exports = require('child');\n" },
        },
      },
      files: {
        'dist/server/main.js': "require('parent');\n",
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });

    const result = runCli(root, verifiedDependencyArguments);

    expect(result.status).toBe(1);
    expect(parseCliJson(result)).toMatchObject({
      success: false,
      error: expect.stringContaining('Missing transitive runtime dependency'),
    });
  });

  (process.platform === 'win32' ? it : it.skip)(
    'audits locked dependency paths longer than MAX_PATH',
    () => {
      const longRelativePath = `${'a'.repeat(72)}/${'b'.repeat(72)}/${'c'.repeat(72)}/value.js`;
      const root = createFixture({
        dependencies: { dependency: '1.0.0' },
        packages: {
          dependency: {
            files: {
              'index.js': 'module.exports = {};\n',
              [longRelativePath]: 'module.exports = 1;\n',
            },
          },
        },
        files: {
          'dist/server/main.js': "require('dependency');\n",
          'dist/shared/empty.js': 'module.exports = {};\n',
        },
      });
      expect(
        path.join(root, 'node_modules', 'dependency', longRelativePath).length,
      ).toBeGreaterThan(260);

      const result = runCli(root, verifiedDependencyArguments);

      expect(result.status).toBe(0);
      expect(parseCliJson(result)).toMatchObject({
        success: true,
        thirdPartyAstMode: 'locked-physical-tree',
      });
    },
  );

  it('rejects a package dependency omitted from its package-lock entry', () => {
    const root = createFixture({
      dependencies: { parent: '1.0.0' },
      packages: {
        parent: { dependencies: { child: '2.0.0' } },
        child: { version: '2.0.0' },
      },
      lockMutator: (lock) => {
        delete lock.packages['node_modules/parent'].dependencies.child;
      },
      files: {
        'dist/server/main.js': "require('parent');\n",
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });
    expectCliFailure(root, 'Package-lock dependency drift');
  });

  it('rejects package-root reparse points and native addons in package trees', () => {
    const root = createFixture({
      dependencies: { parent: '1.0.0' },
      packages: { parent: {} },
      files: {
        'dist/server/main.js': "require('parent');\n",
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });
    const packageRoot = path.join(root, 'node_modules', 'parent');
    const target = fs.mkdtempSync(
      path.join(os.tmpdir(), 'closure-package-target-'),
    );
    fixtureRoots.push(target);
    fs.cpSync(packageRoot, target, { recursive: true });
    fs.rmSync(packageRoot, { recursive: true });
    fs.symlinkSync(
      target,
      packageRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expectCliFailure(root, 'Reparse path is not allowed');

    fs.rmSync(packageRoot, { recursive: true, force: true });
    fs.cpSync(target, packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'binding.node'), 'native');
    expectCliFailure(root, 'Native addon');
  });

  (process.platform === 'win32' ? it : it.skip)(
    'rejects alternate data streams in the verified closure',
    () => {
      const root = createFixture();
      fs.writeFileSync(
        path.join(root, 'dist', 'server', 'main.js:payload'),
        'hidden',
      );
      expectCliFailure(root, 'Alternate data stream is not allowed');

      const packageRoot = createFixture({
        dependencies: { parent: '1.0.0' },
        packages: { parent: {} },
        files: {
          'dist/server/main.js': "require('parent');\n",
          'dist/shared/empty.js': 'module.exports = {};\n',
        },
      });
      fs.writeFileSync(
        path.join(packageRoot, 'node_modules', 'parent', 'index.js:payload'),
        'hidden',
      );
      expectCliFailure(packageRoot, 'Alternate data stream is not allowed');
    },
  );

  (process.platform === 'win32' ? it : it.skip).each([
    ['runtime directory', ['dist', 'server']],
    ['node_modules directory', ['node_modules']],
  ])('rejects an alternate stream on the %s', (_name, segments) => {
    const root = createFixture();
    fs.writeFileSync(`${path.join(root, ...segments)}:payload`, 'hidden');
    expectCliFailure(root, 'Alternate data stream is not allowed');
  });

  it.each(['runtime', 'package'])(
    'rejects multiply-linked %s files',
    (scope) => {
      const root = createFixture({
        dependencies: scope === 'package' ? { parent: '1.0.0' } : {},
        files: {
          'dist/server/main.js':
            scope === 'package'
              ? "require('parent');\n"
              : 'module.exports = {};\n',
          'dist/shared/empty.js': 'module.exports = {};\n',
        },
        packages: scope === 'package' ? { parent: {} } : {},
      });
      const source =
        scope === 'package'
          ? path.join(root, 'node_modules', 'parent', 'index.js')
          : path.join(root, 'dist', 'server', 'main.js');
      const linked =
        scope === 'package'
          ? path.join(root, 'node_modules', 'parent', 'linked.js')
          : path.join(root, 'dist', 'server', 'linked.js');
      fs.linkSync(source, linked);
      expectCliFailure(root, 'Hard-linked file is not allowed');
    },
  );

  it('detects a mutation triggered after alternate stream verification', () => {
    const root = createFixture();
    const target = path.join(root, 'dist', 'shared', 'value.js');
    const moduleUrl = pathToFileURL(scriptPath).href;
    const program = [
      `import fs from 'node:fs';`,
      `import { verifyProductionRuntimeClosure } from ${JSON.stringify(moduleUrl)};`,
      `const root = ${JSON.stringify(root)};`,
      `const target = ${JSON.stringify(target)};`,
      'try {',
      ' verifyProductionRuntimeClosure({',
      "  serverRoot: root + '/dist/server', sharedRoot: root + '/dist/shared',",
      "  packagePath: root + '/package.json', lockPath: root + '/package-lock.json',",
      "  nodeModulesRoot: root + '/node_modules',",
      `  expectedBuildFingerprint: ${JSON.stringify(expectedBuildFingerprint(fixtureInputPaths(root)))},`,
      "  onProgress(event) { if (event.stage === 'ads-scan') fs.writeFileSync(target, 'module.exports = 2;\\n'); },",
      ' });',
      ' process.stdout.write(JSON.stringify({ success: true }));',
      '} catch (error) {',
      " process.stdout.write(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'unknown' }));",
      '}',
    ].join('\n');
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', program],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      error: expect.stringContaining('Concurrent mutation detected'),
    });
  });

  (process.platform === 'win32' ? it : it.skip)(
    'detects an alternate stream added after the initial stream verification',
    () => {
      const root = createFixture();
      const target = path.join(root, 'dist', 'shared', 'value.js');
      const moduleUrl = pathToFileURL(scriptPath).href;
      const program = [
        `import fs from 'node:fs';`,
        `import { verifyProductionRuntimeClosure } from ${JSON.stringify(moduleUrl)};`,
        `const root = ${JSON.stringify(root)};`,
        `const target = ${JSON.stringify(target)};`,
        'try {',
        ' verifyProductionRuntimeClosure({',
        "  serverRoot: root + '/dist/server', sharedRoot: root + '/dist/shared',",
        "  packagePath: root + '/package.json', lockPath: root + '/package-lock.json',",
        "  nodeModulesRoot: root + '/node_modules',",
        `  expectedBuildFingerprint: ${JSON.stringify(expectedBuildFingerprint(fixtureInputPaths(root)))},`,
        "  onProgress(event) { if (event.stage === 'ads-scan') fs.writeFileSync(target + ':payload', 'hidden'); },",
        ' });',
        ' process.stdout.write(JSON.stringify({ success: true }));',
        '} catch (error) {',
        " process.stdout.write(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'unknown' }));",
        '}',
      ].join('\n');
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', program],
        { encoding: 'utf8', timeout: 30_000 },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        success: false,
        error: expect.stringContaining('Alternate data stream is not allowed'),
      });
    },
  );

  it('performs a final content snapshot after the final ADS verification', () => {
    const root = createFixture();
    const target = path.join(root, 'dist', 'shared', 'value.js');
    const report = runImportedVerifier(
      root,
      [
        'onProgress(event) {',
        " if (event.stage === 'final-integrity-check')",
        `  process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(target)}, 'module.exports = 2;\\n');`,
        '},',
      ].join('\n'),
    );
    expect(report).toMatchObject({
      success: false,
      error: expect.stringContaining('Concurrent mutation detected'),
    });
  });

  (process.platform === 'win32' ? it : it.skip)(
    'detects an alternate stream added while the terminal content snapshot starts',
    () => {
      const root = createFixture();
      const target = path.join(root, 'dist', 'shared', 'value.js');
      const report = runImportedVerifier(
        root,
        [
          'onProgress(event) {',
          " if (event.stage !== 'final-integrity-check') return;",
          " const fs = process.getBuiltinModule('node:fs');",
          ' const originalOpendirSync = fs.opendirSync;',
          ' let armed = true;',
          ' fs.opendirSync = function (candidate, ...rest) {',
          '  const directory = originalOpendirSync.call(this, candidate, ...rest);',
          `  if (armed && String(candidate).replaceAll('\\\\', '/').endsWith('/dist/shared')) {`,
          '   const originalCloseSync = directory.closeSync.bind(directory);',
          '   directory.closeSync = function () {',
          '    const result = originalCloseSync();',
          `    fs.writeFileSync(${JSON.stringify(target)} + ':terminal-window', 'hidden');`,
          '    armed = false;',
          '    return result;',
          '   };',
          '  }',
          '  return directory;',
          ' };',
          " process.getBuiltinModule('node:module').syncBuiltinESMExports();",
          '},',
        ].join('\n'),
      );
      expect(report).toMatchObject({
        success: false,
        error: expect.stringContaining('Alternate data stream is not allowed'),
      });
    },
  );

  it('rejects a runtime file changed during the scan window', () => {
    const root = createFixture({
      files: {
        'dist/server/main.js': 'module.exports = {};\n',
        'dist/shared/raced.dat': '0'.repeat(128),
      },
    });
    const racedPath = path.join(root, 'dist', 'shared', 'raced.dat');
    const report = runImportedVerifier(
      root,
      [
        'onProgress(event) {',
        " if (event.stage === 'runtime-snapshot')",
        `  process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(racedPath)}, '1'.repeat(128));`,
        '},',
      ].join('\n'),
    );
    expect(report).toMatchObject({
      success: false,
      error: expect.stringContaining('Concurrent mutation'),
    });
  });

  it.each([
    [
      'missing server entry',
      {
        'dist/server/other.js': 'module.exports = {};\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      'Missing dist/server/main.js',
    ],
    [
      'empty server entry',
      {
        'dist/server/main.js': '',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      'dist/server/main.js must not be empty',
    ],
    [
      'comment-only server entry',
      {
        'dist/server/main.js': '// no executable runtime\n/* still empty */\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
      'dist/server/main.js must contain executable JavaScript',
    ],
    [
      'empty shared root',
      { 'dist/server/main.js': 'module.exports = {};\n' },
      'dist/shared must contain runtime files',
    ],
  ])('rejects %s', (_name, files, errorText) => {
    const root = createFixture({ files });
    fs.mkdirSync(path.join(root, 'dist', 'shared'), { recursive: true });
    expectCliFailure(root, errorText);
  });

  it('rejects source maps and runtime reparse entries', () => {
    const root = createFixture({
      files: {
        'dist/server/main.js': 'module.exports = {};\n',
        'dist/server/main.js.map': '{}\n',
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });
    expectCliFailure(root, 'Source map is not allowed');
    fs.rmSync(path.join(root, 'dist', 'server', 'main.js.map'));
    const external = fs.mkdtempSync(
      path.join(os.tmpdir(), 'closure-runtime-target-'),
    );
    fixtureRoots.push(external);
    fs.writeFileSync(
      path.join(external, 'hidden.js'),
      'module.exports = {};\n',
    );
    fs.symlinkSync(
      external,
      path.join(root, 'dist', 'server', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expectCliFailure(root, 'Reparse path is not allowed');
  });

  it('does not treat comments, strings, or regular expressions as imports', () => {
    const root = createFixture({
      files: {
        'dist/server/main.js': [
          'const text = "require(name) and import(name)";',
          '// require(otherName);',
          '/* import(thirdName); */',
          'const matcher = /require\\(name\\)|import\\(name\\)/;',
          "require('node:fs');",
          'void text; void matcher;',
        ].join('\n'),
        'dist/shared/empty.js': 'module.exports = {};\n',
      },
    });
    const result = runCli(root);
    expect(result.status).toBe(0);
    expect(parseCliJson(result)).toMatchObject({
      success: true,
      importCount: 1,
    });
  });
});
