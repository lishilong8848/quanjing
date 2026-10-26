import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unzipSync } from 'fflate';

describe('server hotfix baseline exporter', () => {
  const projectRoot = process.cwd();
  const scriptPath = path.join(
    projectRoot,
    'scripts',
    'export-server-hotfix-baseline.ps1',
  );
  const launcherPath = path.join(
    projectRoot,
    'scripts',
    'export-server-hotfix-baseline.cmd',
  );
  const cleanupLauncherPath = path.join(
    projectRoot,
    'scripts',
    'cleanup-and-export-server-hotfix-baseline.cmd',
  );
  const powerShellPath = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  let tempRoot: string;
  let appRoot: string;
  let outputRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nantong-baseline-'));
    appRoot = path.join(tempRoot, 'nantong-schedule-test');
    outputRoot = path.join(tempRoot, 'output');

    for (const directory of [
      'dist/server',
      'dist/shared',
      'dist/client/assets',
      'dist/client/chunks',
      'node_modules/private-package',
      '.runtime',
      'logs',
      'certs',
    ]) {
      fs.mkdirSync(path.join(appRoot, directory), { recursive: true });
    }

    fs.writeFileSync(path.join(appRoot, 'package.json'), '{"name":"baseline"}');
    fs.writeFileSync(path.join(appRoot, 'package-lock.json'), '{"lockfileVersion":3}');
    fs.writeFileSync(path.join(appRoot, 'start.ps1'), "Write-Host 'start'");
    fs.writeFileSync(path.join(appRoot, 'start.cmd'), '@echo off');
    fs.writeFileSync(path.join(appRoot, 'dist/server/main.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(appRoot, 'dist/shared/index.js'), 'module.exports = {};');
    fs.writeFileSync(
      path.join(appRoot, 'dist/client/index.html'),
      '<link rel="stylesheet" href="/main.css"><script src="/main.js"></script>',
    );
    fs.writeFileSync(
      path.join(appRoot, 'dist/client/main.js'),
      'var h={};h.u=e=>"chunks/"+e+"."+({1:"aaaaaaaa"})[e]+".js";h.k=e=>1===e?"main.css":"chunks/"+e+"."+({2:"bbbbbbbb"})[e]+".css";',
    );
    fs.writeFileSync(path.join(appRoot, 'dist/client/main.css'), 'body{margin:0}');
    fs.writeFileSync(
      path.join(appRoot, 'dist/client/main.legacy.css'),
      'body{margin:0}',
    );
    fs.writeFileSync(
      path.join(appRoot, 'dist/client/chunks/1.aaaaaaaa.js'),
      'export default 1;',
    );
    fs.writeFileSync(
      path.join(appRoot, 'dist/client/chunks/2.bbbbbbbb.css'),
      '.active{display:block}',
    );
    fs.writeFileSync(
      path.join(appRoot, 'dist/client/chunks/2.bbbbbbbb.legacy.css'),
      '.active{display:block}',
    );
    fs.writeFileSync(path.join(appRoot, 'dist/client/assets/app.js'), 'console.log("ok")');

    fs.writeFileSync(path.join(appRoot, '.env'), 'FEISHU_APP_SECRET=must-not-leak');
    fs.writeFileSync(path.join(appRoot, '.runtime/ledger.json'), '{"secret":true}');
    fs.writeFileSync(path.join(appRoot, 'logs/app.err.log'), 'private log');
    fs.writeFileSync(path.join(appRoot, 'certs/server.key'), 'private key');
    fs.writeFileSync(
      path.join(appRoot, 'node_modules/private-package/index.js'),
      'module.exports = "private";',
    );
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const runExporter = (...extraArguments: string[]) =>
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-AppRoot',
        appRoot,
        '-OutputDirectory',
        outputRoot,
        ...extraArguments,
      ],
      { encoding: 'utf8' },
    );

  const runAutoDetectedExporter = () =>
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-SearchRoot',
        tempRoot,
        '-OutputDirectory',
        outputRoot,
      ],
      { encoding: 'utf8' },
    );

  it('covers every managed release target in the exporter allowlist', () => {
    const builder = fs.readFileSync(
      path.join(projectRoot, 'scripts/create-safe-full-runtime-hotfix-package.ps1'),
      'utf8',
    );
    const exporter = fs.readFileSync(scriptPath, 'utf8');
    const sourceMap = builder.match(/\$releaseFileSources = \[ordered\]@\{([\s\S]*?)\r?\n\}/);
    expect(sourceMap).not.toBeNull();
    const targets = [...sourceMap![1].matchAll(/^\s*'([^']+)'\s*=/gm)].map((match) => match[1]);
    expect(targets.length).toBeGreaterThan(20);
    const lists = ['requiredFiles', 'optionalFiles'].map((name) => {
      const list = exporter.match(new RegExp(`\\$${name} = @\\(([\\s\\S]*?)\\r?\\n\\)`));
      expect(list).not.toBeNull();
      return [...list![1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
    }).flat();
    expect(targets.filter((target) => !lists.includes(target))).toEqual([]);
  });

  it('captures both startup helpers with their real bytes and presence flags', () => {
    fs.mkdirSync(path.join(appRoot, 'scripts'), { recursive: true });
    const helpers = ['verify-contract-storage-startup.mjs', 'verify-feishu-access-startup.mjs'];
    for (const name of helpers) {
      fs.writeFileSync(path.join(appRoot, 'scripts', name), `export const fixture = '${name}';`);
    }
    const result = runExporter();
    expect({ status: result.status, stderr: result.stderr }).toEqual(expect.objectContaining({ status: 0 }));
    const zip = fs.readdirSync(outputRoot).find((name) => name.endsWith('.zip'))!;
    const archive = unzipSync(fs.readFileSync(path.join(outputRoot, zip)));
    const manifest = JSON.parse(Buffer.from(archive['server-baseline-manifest.json']).toString('utf8').replace(/^\uFEFF/, ''));
    for (const name of helpers) {
      const relative = `scripts/${name}`;
      const bytes = fs.readFileSync(path.join(appRoot, relative));
      expect(Buffer.from(archive[`baseline/${relative}`] ?? [])).toEqual(bytes);
      expect(manifest.optionalFilePresence[relative]).toBe(true);
      expect(manifest.files.find((file: { path: string }) => file.path === relative).sha256)
        .toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('exports all four weekly Python runtime files with their original bytes', () => {
    const weeklyFiles = [
      'scripts/weekly-report/bridge.py',
      'scripts/weekly-report/nantong_weekly_report.py',
      'scripts/weekly-report/env_loader.py',
      'scripts/weekly-report/native_feishu.py',
    ];
    fs.mkdirSync(path.join(appRoot, 'scripts/weekly-report'), { recursive: true });
    for (const relative of weeklyFiles) {
      fs.copyFileSync(path.join(projectRoot, relative), path.join(appRoot, relative));
    }
    const result = runExporter();
    expect({ status: result.status, stderr: result.stderr }).toEqual(
      expect.objectContaining({ status: 0 }),
    );
    const zip = fs.readdirSync(outputRoot).find((name) => name.endsWith('.zip'))!;
    const archive = unzipSync(fs.readFileSync(path.join(outputRoot, zip)));
    const manifest = JSON.parse(
      Buffer.from(archive['server-baseline-manifest.json']).toString('utf8').replace(/^\uFEFF/, ''),
    );
    for (const relative of weeklyFiles) {
      const bytes = fs.readFileSync(path.join(projectRoot, relative));
      expect(Buffer.from(archive[`baseline/${relative}`] ?? [])).toEqual(bytes);
      expect(manifest.optionalFilePresence[relative]).toBe(true);
      expect(manifest.files.find((file: { path: string }) => file.path === relative).sha256)
        .toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  const createNodeIsolatedEnvironment = () => {
    const emptyEnvironmentRoot = path.join(tempRoot, 'empty-node-environment');
    const emptyBinRoot = path.join(emptyEnvironmentRoot, 'bin');
    fs.mkdirSync(emptyBinRoot, { recursive: true });
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
    );
    environment.Path = emptyBinRoot;
    environment.ProgramFiles = emptyEnvironmentRoot;
    environment['ProgramFiles(x86)'] = emptyEnvironmentRoot;
    environment.ProgramW6432 = emptyEnvironmentRoot;
    environment.LOCALAPPDATA = emptyEnvironmentRoot;
    return environment;
  };

  it('exports only the runtime baseline whitelist and writes a SHA256 sidecar', () => {
    const result = runExporter();

    expect({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual(expect.objectContaining({ status: 0 }));
    const zipNames = fs.readdirSync(outputRoot).filter((name) => name.endsWith('.zip'));
    expect(zipNames).toHaveLength(1);
    expect(fs.existsSync(path.join(outputRoot, `${zipNames[0]}.sha256`))).toBe(true);

    const archive = unzipSync(fs.readFileSync(path.join(outputRoot, zipNames[0])));
    const entries = Object.keys(archive).sort();
    expect(entries).toEqual(
      expect.arrayContaining([
        'baseline/package.json',
        'baseline/package-lock.json',
        'baseline/start.ps1',
        'baseline/start.cmd',
        'baseline/dist/server/main.js',
        'baseline/dist/shared/index.js',
        'baseline/dist/client/index.html',
        'server-baseline-manifest.json',
      ]),
    );
    expect(entries.some((entry) => entry.includes('node_modules'))).toBe(false);
    expect(entries.some((entry) => entry.includes('.runtime'))).toBe(false);
    expect(entries.some((entry) => entry.includes('/logs/'))).toBe(false);
    expect(entries.some((entry) => entry.includes('/certs/'))).toBe(false);
    expect(entries.some((entry) => entry.includes('.env'))).toBe(false);

    const manifest = JSON.parse(
      Buffer.from(archive['server-baseline-manifest.json'])
        .toString('utf8')
        .replace(/^\uFEFF/, ''),
    ) as {
      schemaVersion: number;
      files: Array<{ path: string; sha256: string; size: number }>;
      nonExportedRuntimeFiles: Array<{
        path: string;
        sha256: string;
        size: number;
        reason: string;
      }>;
      distFingerprints: Record<string, string>;
      optionalFilePresence: Record<string, boolean>;
    };
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.nonExportedRuntimeFiles).toEqual([]);
    expect(Object.keys(manifest.distFingerprints).sort()).toEqual([
      'dist/client',
      'dist/server',
      'dist/shared',
    ]);
    expect(manifest.optionalFilePresence).toMatchObject({
      '.feishu-card-action-consumer-release': false,
      'watchdog.ps1': false,
    });
    for (const file of manifest.files) {
      const payload = archive[`baseline/${file.path}`];
      expect(payload).toBeDefined();
      expect(payload.byteLength).toBe(file.size);
      expect(createHash('sha256').update(payload).digest('hex')).toBe(file.sha256);
    }

    const zipBytes = fs.readFileSync(path.join(outputRoot, zipNames[0]));
    const expectedArchiveHash = createHash('sha256').update(zipBytes).digest('hex');
    expect(
      fs.readFileSync(path.join(outputRoot, `${zipNames[0]}.sha256`), 'utf8'),
    ).toContain(expectedArchiveHash.toUpperCase());
  });

  it('exports every managed operational release script needed by the next hotfix', () => {
    const managedScripts = [
      'scripts/backfill-dingtalk-attendance-archive.mjs',
      'scripts/dingtalk-attendance-cli.mjs',
      'scripts/ensure-attendance-archive-summary-fields.mjs',
      'scripts/ensure-today-operations-follow-up-fields.mjs',
      'scripts/migrate-dingtalk-attendance-credentials.ps1',
      'scripts/migrate-legacy-exception-follow-ups.mjs',
    ];
    for (const relativePath of managedScripts) {
      const absolutePath = path.join(appRoot, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, `managed:${relativePath}\n`, 'utf8');
    }

    const result = runExporter();

    expect({ status: result.status, stderr: result.stderr }).toEqual(
      expect.objectContaining({ status: 0 }),
    );
    const zipName = fs.readdirSync(outputRoot).find((name) => name.endsWith('.zip'));
    expect(zipName).toBeDefined();
    const archive = unzipSync(fs.readFileSync(path.join(outputRoot, zipName!)));
    for (const relativePath of managedScripts) {
      expect(archive[`baseline/${relativePath}`]).toBeDefined();
    }
  });

  it('auto-detects one server application directory when AppRoot is omitted', () => {
    const result = runAutoDetectedExporter();

    expect({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual(expect.objectContaining({ status: 0 }));
    expect(result.stdout).toContain('Auto-detected application root');
  });

  it('uses the application portable Node runtime when Node is absent from PATH', () => {
    const portableNodeRoot = path.join(appRoot, '.runtime', 'node');
    fs.mkdirSync(portableNodeRoot, { recursive: true });
    fs.linkSync(process.execPath, path.join(portableNodeRoot, 'node.exe'));
    const environment = createNodeIsolatedEnvironment();

    const result = spawnSync(
      powerShellPath,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-AppRoot',
        appRoot,
        '-OutputDirectory',
        outputRoot,
      ],
      { encoding: 'utf8', env: environment },
    );

    expect({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual(expect.objectContaining({ status: 0 }));
    expect(result.stdout).toContain('application portable Node');
  });

  it('fails closed without raw PowerShell errors when no Node runtime is discoverable', () => {
    const result = spawnSync(
      powerShellPath,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-AppRoot',
        appRoot,
        '-OutputDirectory',
        outputRoot,
      ],
      { encoding: 'utf8', env: createNodeIsolatedEnvironment() },
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain(
      'No trusted Node.js runtime was found for client asset graph verification',
    );
    expect(output).not.toContain('CommandNotFoundException');
    expect(
      fs.existsSync(outputRoot) &&
        fs.readdirSync(outputRoot).some((name) => /\.zip(?:\.partial)?$/u.test(name)),
    ).toBe(false);
  });

  it('refuses to guess between multiple application directories even when one pid looks active', () => {
    const secondAppRoot = path.join(tempRoot, 'nantong-schedule-second');
    fs.cpSync(appRoot, secondAppRoot, { recursive: true });
    fs.writeFileSync(path.join(appRoot, 'app.pid'), String(process.pid), 'utf8');

    const result = runAutoDetectedExporter();

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'More than one Nantong application root was detected',
    );
  });

  it('rejects a likely embedded secret inside an allowed runtime file', () => {
    fs.writeFileSync(
      path.join(appRoot, 'dist/server/main.js'),
      'FEISHU_APP_SECRET="0123456789abcdef0123456789abcdef";',
    );

    const result = runExporter();

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Potential embedded credential detected',
    );
  });

  it('rejects snake-case credential literals in compiled runtime files', () => {
    fs.writeFileSync(
      path.join(appRoot, 'dist/server/main.js'),
      'const client_secret = "0123456789abcdef0123456789abcdef";',
    );

    const result = runExporter();

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Potential embedded credential detected',
    );
  });

  it('allows normal runtime references to secret-bearing configuration fields', () => {
    fs.writeFileSync(
      path.join(appRoot, 'dist/server/main.js'),
      'const payload = {\n  client_secret: config.appSecret,\n};',
    );

    const result = runExporter();

    expect({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual(expect.objectContaining({ status: 0 }));
  });

  it('rejects an unexpectedly large baseline instead of silently creating a huge archive', () => {
    const oversizedRelativePath = 'dist/client/assets/oversized-runtime.js';
    fs.writeFileSync(
      path.join(appRoot, oversizedRelativePath),
      '/* runtime asset */'.repeat(1024),
      'utf8',
    );

    const result = runExporter('-MaxUncompressedMiB', '0.0001');
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('Export candidate totals by runtime root');
    expect(output).toContain('"dist/client"');
    expect(output).toContain('dist/client totals by first path segment');
    expect(output).toContain('"dist/client/assets"');
    expect(output).toContain('Largest export candidates (relative paths only)');
    expect(output).toContain(oversizedRelativePath);
    expect(output).not.toContain(appRoot);
    expect(output).toContain('Baseline whitelist exceeds the size limit');
  });

  it('exports only active hashed client chunks while fingerprinting stale generations', () => {
    const staleRelativePath = 'dist/client/chunks/1.cccccccc.js';
    const staleContents = Buffer.from('export const stale = true;\n'.repeat(4096));
    fs.writeFileSync(path.join(appRoot, staleRelativePath), staleContents);

    const result = runExporter('-MaxUncompressedMiB', '0.05');

    expect({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual(expect.objectContaining({ status: 0 }));
    expect(result.stdout).toContain('1 historical client chunks');
    const zipName = fs.readdirSync(outputRoot).find((name) => name.endsWith('.zip'));
    expect(zipName).toBeDefined();
    const archive = unzipSync(fs.readFileSync(path.join(outputRoot, zipName!)));
    expect(archive[`baseline/${staleRelativePath}`]).toBeUndefined();
    expect(archive['baseline/dist/client/chunks/1.aaaaaaaa.js']).toBeDefined();
    expect(archive['baseline/dist/client/chunks/2.bbbbbbbb.css']).toBeDefined();
    expect(
      archive['baseline/dist/client/chunks/2.bbbbbbbb.legacy.css'],
    ).toBeDefined();

    const manifest = JSON.parse(
      Buffer.from(archive['server-baseline-manifest.json'])
        .toString('utf8')
        .replace(/^\uFEFF/, ''),
    ) as {
      schemaVersion: number;
      exportPlanAlgorithm: string;
      exportPlanFingerprint: string;
      uncompressedBytes: number;
      files: Array<{ path: string; sha256: string; size: number }>;
      nonExportedRuntimeFiles: Array<{
        path: string;
        sha256: string;
        size: number;
        reason: string;
      }>;
    };
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.exportPlanAlgorithm).toBe('webpack-main-runtime-map-v1');
    expect(manifest.uncompressedBytes).toBeLessThan(0.05 * 1024 * 1024);
    expect(manifest.nonExportedRuntimeFiles).toContainEqual({
      path: staleRelativePath,
      size: staleContents.byteLength,
      sha256: createHash('sha256').update(staleContents).digest('hex'),
      reason: 'unreferenced-client-chunk-content-not-exported',
    });

    const exportPlanLines = [
      ...manifest.files.map(
        (file) => `payload\0${file.path}\0${file.size}\0${file.sha256}`,
      ),
      ...manifest.nonExportedRuntimeFiles.map(
        (file) =>
          `metadata\0${file.reason}\0${file.path}\0${file.size}\0${file.sha256}`,
      ),
    ].sort((left, right) => {
      const leftPath = left.split('\0')[1 + Number(left.startsWith('metadata'))];
      const rightPath = right.split('\0')[1 + Number(right.startsWith('metadata'))];
      return Buffer.from(leftPath, 'utf8').compare(Buffer.from(rightPath, 'utf8'));
    });
    expect(manifest.exportPlanFingerprint).toBe(
      createHash('sha256').update(exportPlanLines.join('\n')).digest('hex'),
    );
  });

  it('quarantines unreferenced hashed client chunks before exporting a fresh baseline', () => {
    const staleRelativePath = 'dist/client/chunks/1.cccccccc.js';
    const staleContents = 'export const stale = true;';
    fs.writeFileSync(path.join(appRoot, staleRelativePath), staleContents);

    const result = runExporter('-PruneHistoricalClientChunks');
    const output = `${result.stdout}\n${result.stderr}`;

    expect({ status: result.status, output }).toEqual(
      expect.objectContaining({ status: 0 }),
    );
    expect(output).toContain('Quarantined 1 historical client chunks');
    expect(fs.existsSync(path.join(appRoot, staleRelativePath))).toBe(false);
    expect(
      fs.existsSync(path.join(appRoot, 'dist/client/chunks/1.aaaaaaaa.js')),
    ).toBe(true);

    const quarantineRoot = path.join(tempRoot, '.nantong-client-chunk-quarantine');
    const quarantinedCopies = fs
      .readdirSync(quarantineRoot, { recursive: true })
      .map((entry) => String(entry).replace(/\\/g, '/'))
      .filter((entry) => entry.endsWith('chunks/1.cccccccc.js'));
    expect(quarantinedCopies).toHaveLength(1);

    const zipName = fs.readdirSync(outputRoot).find((name) => name.endsWith('.zip'));
    expect(zipName).toBeDefined();
    const archive = unzipSync(fs.readFileSync(path.join(outputRoot, zipName!)));
    const manifest = JSON.parse(
      Buffer.from(archive['server-baseline-manifest.json'])
        .toString('utf8')
        .replace(/^\uFEFF/, ''),
    ) as {
      nonExportedRuntimeFiles: Array<{ path: string; reason: string }>;
    };
    expect(manifest.nonExportedRuntimeFiles).not.toContainEqual(
      expect.objectContaining({ path: staleRelativePath }),
    );
  });

  it('fingerprints source maps without exporting their contents', () => {
    const chunksRoot = path.join(appRoot, 'dist/client/chunks');
    fs.mkdirSync(chunksRoot, { recursive: true });
    const sourceMapContents =
      '{"sourcesContent":["SERVER_SOURCE_MAP_SENTINEL"]}';
    const sourceMapPath = path.join(chunksRoot, 'async-vendors.js.map');
    fs.writeFileSync(sourceMapPath, sourceMapContents, 'utf8');

    const result = runExporter();

    expect({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual(expect.objectContaining({ status: 0 }));
    const zipName = fs.readdirSync(outputRoot).find((name) => name.endsWith('.zip'));
    expect(zipName).toBeDefined();
    const archive = unzipSync(fs.readFileSync(path.join(outputRoot, zipName!)));
    expect(Object.keys(archive).some((entry) => entry.endsWith('.map'))).toBe(
      false,
    );
    expect(
      Object.values(archive).some((contents) =>
        Buffer.from(contents).includes(Buffer.from('SERVER_SOURCE_MAP_SENTINEL')),
      ),
    ).toBe(false);
    const manifest = JSON.parse(
      Buffer.from(archive['server-baseline-manifest.json'])
        .toString('utf8')
        .replace(/^\uFEFF/, ''),
    ) as {
      schemaVersion: number;
      baselineFingerprint: string;
      baselineFileCount: number;
      distFingerprints: Record<string, string>;
      files: Array<{ path: string; sha256: string; size: number }>;
      nonExportedRuntimeFiles: Array<{
        path: string;
        sha256: string;
        size: number;
        reason: string;
      }>;
    };
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.files).not.toContainEqual(
      expect.objectContaining({ path: 'dist/client/chunks/async-vendors.js.map' }),
    );
    expect(manifest.nonExportedRuntimeFiles).toContainEqual({
      path: 'dist/client/chunks/async-vendors.js.map',
      size: Buffer.byteLength(sourceMapContents),
      sha256: createHash('sha256').update(sourceMapContents).digest('hex'),
      reason: 'source-map-content-not-exported',
    });
    const allBaselineFiles = [
      ...manifest.files,
      ...manifest.nonExportedRuntimeFiles,
    ].sort((left, right) =>
      Buffer.from(left.path, 'utf8').compare(Buffer.from(right.path, 'utf8')),
    );
    const fingerprint = (files: typeof allBaselineFiles) =>
      createHash('sha256')
        .update(
          files
            .map((file) => `${file.path}:${file.size}:${file.sha256}`)
            .join('\n'),
        )
        .digest('hex');
    expect(manifest.baselineFileCount).toBe(allBaselineFiles.length);
    expect(manifest.baselineFingerprint).toBe(fingerprint(allBaselineFiles));
    expect(manifest.distFingerprints['dist/client']).toBe(
      fingerprint(
        allBaselineFiles.filter((file) => file.path.startsWith('dist/client/')),
      ),
    );
  });

  it('does not let metadata-only source maps bypass forbidden path segments', () => {
    const forbiddenMapRoot = path.join(appRoot, 'dist/client/logs');
    fs.mkdirSync(forbiddenMapRoot, { recursive: true });
    fs.writeFileSync(
      path.join(forbiddenMapRoot, 'private.js.map'),
      '{"sourcesContent":["private"]}',
      'utf8',
    );

    const result = runExporter();

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Runtime or sensitive path is forbidden',
    );
  });

  it('ignores the Windows download-zone stream without copying it into the ZIP', () => {
    if (process.platform !== 'win32') {
      return;
    }
    fs.writeFileSync(
      `${path.join(appRoot, 'dist/server/main.js')}:Zone.Identifier`,
      '[ZoneTransfer]\r\nZoneId=3',
    );

    const result = runExporter();

    expect({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual(expect.objectContaining({ status: 0 }));
    const zipName = fs.readdirSync(outputRoot).find((name) => name.endsWith('.zip'));
    expect(zipName).toBeDefined();
    const entries = Object.keys(
      unzipSync(fs.readFileSync(path.join(outputRoot, zipName!))),
    );
    expect(entries.some((entry) => entry.includes('Zone.Identifier'))).toBe(false);
  });

  it('rejects non-zone NTFS alternate data streams', () => {
    if (process.platform !== 'win32') {
      return;
    }
    fs.writeFileSync(
      `${path.join(appRoot, 'dist/server/main.js')}:hidden-secret`,
      'must-not-leak',
    );

    const result = runExporter();

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Alternate data streams are not allowed',
    );
  });

  it('fails closed when the runtime file set changes during capture', async () => {
    fs.writeFileSync(
      path.join(appRoot, 'dist/client/assets/large.js'),
      Buffer.alloc(16 * 1024 * 1024, 97),
    );
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-AppRoot',
        appRoot,
        '-OutputDirectory',
        outputRoot,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const exitPromise = new Promise<number | null>((resolvePromise) => {
      child.once('close', resolvePromise);
    });

    const deadline = Date.now() + 15_000;
    let stageObserved = false;
    while (Date.now() < deadline) {
      if (
        fs.existsSync(outputRoot) &&
        fs.readdirSync(outputRoot).some((name) => name.endsWith('-stage'))
      ) {
        stageObserved = true;
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    expect(stageObserved).toBe(true);
    fs.writeFileSync(
      path.join(appRoot, 'dist/server/appeared-during-capture.js'),
      'module.exports = "late";',
    );

    const exitCode = await exitPromise;
    expect(exitCode).not.toBe(0);
    expect(`${stdout}\n${stderr}`).toContain(
      'Server file set changed during baseline capture',
    );
    expect(
      fs.existsSync(outputRoot) &&
        fs.readdirSync(outputRoot).some((name) => name.endsWith('.zip')),
    ).toBe(false);
  }, 60_000);

  it('ships a double-click launcher that never starts or stops the application', () => {
    expect(fs.existsSync(launcherPath)).toBe(true);
    const source = fs.readFileSync(launcherPath, 'utf8');

    expect(source).toContain('export-server-hotfix-baseline.ps1');
    expect(source).toContain('Auto-detect');
    expect(source).not.toMatch(/start\.ps1|stop-process|taskkill/i);
  });

  it.each([
    'export-server-hotfix-baseline.cmd',
    'cleanup-and-export-server-hotfix-baseline.cmd',
  ])(
    'passes the application root without a trailing quote from %s',
    (launcherName) => {
      const launcherRoot = path.join(tempRoot, '南通 baseline root');
      fs.mkdirSync(launcherRoot, { recursive: true });
      fs.writeFileSync(
        path.join(launcherRoot, 'package.json'),
        '{"name":"launcher-fixture"}',
      );
      fs.copyFileSync(
        path.join(projectRoot, 'scripts', launcherName),
        path.join(launcherRoot, launcherName),
      );
      fs.writeFileSync(
        path.join(launcherRoot, 'export-server-hotfix-baseline.ps1'),
        [
          'param([string]$AppRoot, [switch]$PruneHistoricalClientChunks)',
          "$resolved = (Resolve-Path -LiteralPath $AppRoot).Path",
          "$resolved | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'captured-app-root.txt') -Encoding utf8",
        ].join('\r\n'),
      );

      const result = spawnSync(
        'cmd.exe',
        ['/d', '/c', path.join(launcherRoot, launcherName)],
        {
          cwd: launcherRoot,
          encoding: 'utf8',
          input: '\r\n',
          timeout: 15_000,
        },
      );

      expect(result.status).toBe(0);
      expect(
        fs.readFileSync(path.join(launcherRoot, 'captured-app-root.txt'), 'utf8').trim(),
      ).toBe(launcherRoot);
    },
  );

  it('ships a separate explicit launcher for cleanup and fresh baseline export', () => {
    expect(fs.existsSync(cleanupLauncherPath)).toBe(true);
    const source = fs.readFileSync(cleanupLauncherPath, 'utf8');

    expect(source).toContain('export-server-hotfix-baseline.ps1');
    expect(source).toContain('-PruneHistoricalClientChunks');
    expect(source).not.toMatch(/start\.ps1|stop-process|taskkill/i);
  });
});
