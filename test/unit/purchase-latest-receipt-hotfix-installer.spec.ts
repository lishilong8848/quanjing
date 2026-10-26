import { createHash } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

const installerPath = join(
  process.cwd(),
  'scripts',
  'apply-purchase-latest-receipt-hotfix.ps1',
);
const verifierPath = join(
  process.cwd(),
  'scripts',
  'verify-client-asset-graph.mjs',
);

const sha256 = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();

const getFreePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a test port.'));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });

const processExists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 5_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for test fixture state.');
};

type ManifestEntry = { path: string; sha256: string };

type InstallerRunResult = {
  output: string;
  status: number | null;
  timedOut: boolean;
};

type InstallerFixture = {
  appRoot: string;
  baselineClientHash: string;
  baselineHash: string;
  cleanup: () => void;
  manifestPath: string;
  newClientHash: string;
  newRuntimeHash: string;
  oldPid: number;
  packageRoot: string;
  port: number;
  preservedChunkHash: string;
  run: (healthPath?: string) => Promise<InstallerRunResult>;
};

const writeRuntime = (
  path: string,
  port: number,
  version: 'baseline' | 'hotfix',
) => {
  writeFileSync(
    path,
    [
      "const http = require('http');",
      "const fs = require('fs');",
      "const path = require('path');",
      `const version = '${version}';`,
      `http.createServer((request, response) => {`,
      "  if (request.url === '/api/access/session') {",
      '    response.statusCode = 200;',
      '    response.end(version);',
      '    return;',
      '  }',
      "  if (request.url === '/main.js') {",
      '    response.statusCode = 200;',
      "    response.setHeader('content-type', 'application/javascript');",
      "    response.end(fs.readFileSync(path.join(__dirname, '..', 'client', 'main.js')));",
      '    return;',
      '  }',
      '  response.statusCode = 503;',
      "  response.end('unavailable');",
      `}).listen(${port}, '127.0.0.1');`,
      '',
    ].join('\n'),
    'utf8',
  );
};

const createFixture = async (): Promise<InstallerFixture> => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'purchase-receipt-installer-'));
  const appRoot = join(fixtureRoot, 'app');
  const packageRoot = join(fixtureRoot, 'package');
  const targetMain = join(appRoot, 'dist', 'server', 'main.js');
  const payloadMain = join(packageRoot, 'dist', 'server', 'main.js');
  const clientMain = join(appRoot, 'dist', 'client', 'main.js');
  const payloadClientMain = join(packageRoot, 'dist', 'client', 'main.js');
  const preservedChunk = join(
    appRoot,
    'dist',
    'client',
    'chunks',
    'preserved.js',
  );
  const dependencyRuntime = join(
    appRoot,
    'dist',
    'server',
    'dependency.js',
  );
  const packagedInstaller = join(
    packageRoot,
    'apply-purchase-latest-receipt-hotfix.ps1',
  );
  const port = await getFreePort();

  mkdirSync(join(appRoot, 'dist', 'server'), { recursive: true });
  mkdirSync(join(appRoot, 'dist', 'client', 'chunks'), { recursive: true });
  mkdirSync(join(packageRoot, 'dist', 'server'), { recursive: true });
  mkdirSync(join(packageRoot, 'dist', 'client'), { recursive: true });
  writeRuntime(targetMain, port, 'baseline');
  writeRuntime(payloadMain, port, 'hotfix');
  writeFileSync(dependencyRuntime, 'verified dependency\n', 'utf8');
  writeFileSync(clientMain, 'baseline-client-main\n', 'utf8');
  writeFileSync(payloadClientMain, 'hotfix-client-main\n', 'utf8');
  writeFileSync(preservedChunk, 'preserved-client-chunk\n', 'utf8');
  copyFileSync(installerPath, packagedInstaller);

  writeFileSync(
    join(appRoot, 'stop.ps1'),
    [
      "$ErrorActionPreference = 'Stop'",
      "$pidFile = Join-Path $PSScriptRoot 'app.pid'",
      'if (Test-Path -LiteralPath $pidFile) {',
      '  $appPid = [int](Get-Content -LiteralPath $pidFile -Raw)',
      '  Stop-Process -Id $appPid -Force -ErrorAction SilentlyContinue',
      '  for ($attempt = 0; $attempt -lt 50; $attempt += 1) {',
      '    if (!(Get-Process -Id $appPid -ErrorAction SilentlyContinue)) { break }',
      '    Start-Sleep -Milliseconds 20',
      '  }',
      '  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(appRoot, 'start.ps1'),
    [
      "$ErrorActionPreference = 'Stop'",
      "$nodePath = (Get-Command node).Source",
      "$stdout = Join-Path $PSScriptRoot 'fixture.out.log'",
      "$stderr = Join-Path $PSScriptRoot 'fixture.err.log'",
      "$process = Start-Process -FilePath $nodePath -ArgumentList @('dist/server/main.js') -WorkingDirectory $PSScriptRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru",
      "$process.Id | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'app.pid') -Encoding ASCII",
      'Start-Sleep -Milliseconds 250',
      'if ($process.HasExited) { throw "Fixture service failed to start." }',
      '',
    ].join('\n'),
    'utf8',
  );

  const files: ManifestEntry[] = [
    {
      path: 'apply-purchase-latest-receipt-hotfix.ps1',
      sha256: sha256(packagedInstaller),
    },
    { path: 'dist/server/main.js', sha256: sha256(payloadMain) },
    { path: 'dist/client/main.js', sha256: sha256(payloadClientMain) },
  ];
  const manifest = {
    schemaVersion: 2,
    package: 'purchase-latest-receipt-hotfix-test',
    packageType: 'purchase-receipt-session-recovery-overlay',
    serviceRestartRequired: true,
    deploymentMode: 'overlay-files',
    replaceFiles: ['dist/client/main.js', 'dist/server/main.js'],
    files,
    targetPreconditions: [
      { path: 'dist/server/main.js', sha256: sha256(targetMain) },
      { path: 'dist/client/main.js', sha256: sha256(clientMain) },
      { path: 'dist/server/dependency.js', sha256: sha256(dependencyRuntime) },
    ],
    preservedFiles: [
      {
        path: 'dist/client/chunks/preserved.js',
        sha256: sha256(preservedChunk),
      },
    ],
  };
  const manifestPath = join(packageRoot, 'hotfix-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  const start = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(appRoot, 'start.ps1'),
    ],
    { encoding: 'utf8', stdio: 'ignore', windowsHide: true },
  );
  if (start.status !== 0) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    throw new Error(`Could not start installer fixture: ${start.stderr}`);
  }
  const oldPid = Number(readFileSync(join(appRoot, 'app.pid'), 'utf8').trim());
  await waitFor(() => processExists(oldPid));

  const cleanup = () => {
    spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(appRoot, 'stop.ps1'),
      ],
      { encoding: 'utf8', stdio: 'ignore', windowsHide: true },
    );
    rmSync(fixtureRoot, { recursive: true, force: true });
  };

  return {
    appRoot,
    baselineClientHash: sha256(clientMain),
    baselineHash: sha256(targetMain),
    cleanup,
    manifestPath,
    newClientHash: sha256(payloadClientMain),
    newRuntimeHash: sha256(payloadMain),
    oldPid,
    packageRoot,
    port,
    preservedChunkHash: sha256(preservedChunk),
    run: (healthPath = '/api/access/session') => {
      const stdoutPath = join(fixtureRoot, 'installer.out.log');
      const stderrPath = join(fixtureRoot, 'installer.err.log');
      const stdoutFd = openSync(stdoutPath, 'w');
      const stderrFd = openSync(stderrPath, 'w');
      const child = spawn(
          'powershell',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            packagedInstaller,
            '-AppRoot',
            appRoot,
            '-HealthUrl',
            `http://127.0.0.1:${port}${healthPath}`,
          ],
          {
            stdio: ['ignore', stdoutFd, stderrFd],
            windowsHide: true,
          },
        );
      closeSync(stdoutFd);
      closeSync(stderrFd);

      return new Promise<InstallerRunResult>((resolve) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const finish = (
          status: number | null,
          timedOut: boolean,
          errorMessage = '',
        ) => {
          if (settled) {
            return;
          }
          settled = true;
          if (timeout) {
            clearTimeout(timeout);
          }
          resolve({
            status,
            timedOut,
            output: `${readFileSync(stdoutPath, 'utf8')}\n${readFileSync(
              stderrPath,
              'utf8',
            )}\n${errorMessage}`,
          });
        };

        child.once('error', (error) => finish(null, false, error.message));
        child.once('exit', (status) => finish(status, false));
        timeout = setTimeout(() => {
          if (child.pid) {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true,
            });
          }
          finish(null, true, 'Installer fixture timed out.');
        }, 60_000);
      });
    },
  };
};

const configureCoherentClientFixture = (fixture: InstallerFixture) => {
  const targetClientRoot = join(fixture.appRoot, 'dist', 'client');
  const payloadClientRoot = join(fixture.packageRoot, 'dist', 'client');
  rmSync(targetClientRoot, { force: true, recursive: true });
  rmSync(payloadClientRoot, { force: true, recursive: true });
  mkdirSync(join(targetClientRoot, 'chunks'), { recursive: true });
  mkdirSync(join(payloadClientRoot, 'chunks'), { recursive: true });

  const html =
    '<link rel="stylesheet" href="/main.css"><script src="/main.js"></script>';
  const mainFor = (
    version: 'baseline' | 'hotfix',
    jsHash: string,
    cssHash: string,
  ) =>
    [
      '(()=>{var h={};',
      `h.u=e=>"chunks/"+e+"."+({1:"${jsHash}"})[e]+".js";`,
      `h.k=e=>"2"===e?"main.css":"chunks/"+e+"."+({2:"${cssHash}"})[e]+".css";`,
      `globalThis.__fixtureClient="${version}";`,
      '})();',
    ].join('');
  const targetFiles: Record<string, string> = {
    'index.html': html,
    'main.js': mainFor('baseline', '11111111', '22222222'),
    'main.css': 'body{}',
    'chunks/1.11111111.js': 'globalThis.__fixtureChunk="baseline";',
    'chunks/2.22222222.css': '.fixture-baseline{}',
  };
  const payloadFiles: Record<string, string> = {
    'index.html': html,
    'main.js': mainFor('hotfix', 'aaaaaaaa', 'bbbbbbbb'),
    'main.css': 'body{}',
    'chunks/1.aaaaaaaa.js': 'globalThis.__fixtureChunk="hotfix";',
    'chunks/2.bbbbbbbb.css': '.fixture-hotfix{}',
  };
  for (const [relativePath, content] of Object.entries(targetFiles)) {
    const fullPath = join(targetClientRoot, relativePath.replace(/\//g, '\\'));
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content, 'utf8');
  }
  for (const [relativePath, content] of Object.entries(payloadFiles)) {
    const fullPath = join(payloadClientRoot, relativePath.replace(/\//g, '\\'));
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content, 'utf8');
  }

  const packagedVerifier = join(
    fixture.packageRoot,
    'verify-client-asset-graph.mjs',
  );
  copyFileSync(verifierPath, packagedVerifier);

  const clientRelativePaths = Object.keys(payloadFiles).map(
    (path) => `dist/client/${path}`,
  );
  const payloadClientEntries = clientRelativePaths.map((relativePath) => ({
    path: relativePath,
    sha256: sha256(
      join(fixture.packageRoot, relativePath.replace(/\//g, '\\')),
    ),
  }));

  const manifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8'));
  manifest.packageType = 'purchase-receipt-coherent-client-overlay';
  manifest.deploymentMode = 'coherent-client-overlay';
  manifest.replaceFiles = ['dist/server/main.js', ...clientRelativePaths];
  manifest.files = [
    ...manifest.files.filter(
      (entry: ManifestEntry) => !entry.path.startsWith('dist/client/'),
    ),
    ...payloadClientEntries,
    {
      path: 'verify-client-asset-graph.mjs',
      sha256: sha256(packagedVerifier),
    },
  ];
  manifest.targetPreconditions = [
    ...manifest.targetPreconditions.filter(
      (entry: ManifestEntry) => !entry.path.startsWith('dist/client/'),
    ),
  ];
  manifest.preservedFiles = [
    manifest.targetPreconditions.find(
      (entry: ManifestEntry) => entry.path === 'dist/server/dependency.js',
    ),
  ];
  manifest.clientSnapshotFiles = payloadClientEntries;
  writeFileSync(
    fixture.manifestPath,
    JSON.stringify(manifest, null, 2),
    'utf8',
  );

  return {
    manifest,
    newChunkHash: sha256(
      join(
        fixture.packageRoot,
        'dist',
        'client',
        'chunks',
        '1.aaaaaaaa.js',
      ),
    ),
    oldChunkHash: sha256(
      join(
        fixture.appRoot,
        'dist',
        'client',
        'chunks',
        '1.11111111.js',
      ),
    ),
    oldChunkPath: 'dist/client/chunks/1.11111111.js',
    relativeChunkPath: 'dist/client/chunks/1.aaaaaaaa.js',
  };
};

describe('purchase latest receipt hotfix installer', () => {
  jest.setTimeout(180_000);

  it('is valid Windows PowerShell syntax', () => {
    expect(existsSync(installerPath)).toBe(true);
    const quotedPath = installerPath.replace(/'/g, "''");
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${quotedPath}', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(`${result.stdout || ''}\n${result.stderr || ''}`).toBe('\n');
    expect(result.status).toBe(0);
  });

  it('declares strict manifest, path, restart, health, and rollback safeguards', () => {
    expect(existsSync(installerPath)).toBe(true);
    if (!existsSync(installerPath)) {
      return;
    }
    const script = readFileSync(installerPath, 'utf8');

    for (const marker of [
      "[string]$HealthUrl = 'https://localhost:3001/api/access/session'",
      'targetPreconditions',
      'preservedFiles',
      'purchase-receipt-session-recovery-overlay',
      "deploymentMode -cne 'overlay-files'",
      'serviceRestartRequired',
      'Assert-SafeRelativePath',
      'Assert-PathInside',
      'Assert-PathChainHasNoReparsePoint',
      "'dist/client/main.js'",
      'replaceDirectories',
      ".Contains(':')",
      'dist/client/chunks/',
      'Manifest contains a forbidden payload path',
      "'output/hotfix-backups'",
      "Join-Path $AppRoot 'stop.ps1'",
      "Join-Path $AppRoot 'start.ps1'",
      'Get-CimInstance Win32_Process',
      '.StartTime',
      'curl.exe',
      "'-k'",
      'Rollback',
    ]) {
      expect(script).toContain(marker);
    }
    expect(script).not.toContain('Get-Content .env');
    expect(script).not.toContain('Remove-Item -LiteralPath $AppRoot -Recurse');
  });

  it('requires a complete coherent client snapshot and verifies the served main bundle', () => {
    const script = readFileSync(installerPath, 'utf8');
    for (const marker of [
      'purchase-receipt-coherent-client-overlay',
      "deploymentMode -cne 'coherent-client-overlay'",
      'clientSnapshotFiles',
      'Assert-ExactClientSnapshot',
      'Assert-ClientAssetGraph',
      'Assert-ServedClientMainHash',
      'verify-client-asset-graph.mjs',
      'dist/client/',
    ]) {
      expect(script).toContain(marker);
    }
  });

  it('treats replaceFiles as a precondition subset and limits backup and rollback to that subset', () => {
    const script = readFileSync(installerPath, 'utf8');
    expect(script).toContain('replaceFiles must not be empty');
    expect(script).toContain('replaceFiles path has no target precondition');
    expect(script).toContain('$replacementPreconditions = @(');
    expect(script).toContain('-Entries $replacementPreconditions');
    expect(script).toContain('-Preconditions $replacementPreconditions');

    const targetPreflight = script.indexOf(
      "-Entries $targetPreconditions `\n  -Label 'Target precondition'",
    );
    const processLookup = script.indexOf(
      '$oldPids = @(Get-AppNodePids -Root $AppRoot)',
    );
    expect(targetPreflight).toBeGreaterThan(0);
    expect(processLookup).toBeGreaterThan(targetPreflight);

    const backupCall = script.slice(
      script.indexOf('Copy-EntriesToBackup `', processLookup),
      script.indexOf('$backupComplete = $true', processLookup),
    );
    expect(backupCall).toContain('-Entries $replacementPreconditions');
    expect(backupCall).not.toContain('-Entries $targetPreconditions');
  });

  it('backs up only replaceFiles, installs the payload, restarts with a new PID, and preserves the client', async () => {
    expect(existsSync(installerPath)).toBe(true);
    if (!existsSync(installerPath)) {
      return;
    }
    const fixture = await createFixture();
    try {
      const result = await fixture.run();
      expect(result.status).toBe(0);
      expect(result.output).toContain('Hotfix installed and validated');
      expect(sha256(join(fixture.appRoot, 'dist', 'server', 'main.js'))).toBe(
        fixture.newRuntimeHash,
      );
      expect(sha256(join(fixture.appRoot, 'dist', 'client', 'main.js'))).toBe(
        fixture.newClientHash,
      );
      expect(
        sha256(
          join(
            fixture.appRoot,
            'dist',
            'client',
            'chunks',
            'preserved.js',
          ),
        ),
      ).toBe(fixture.preservedChunkHash);

      const newPid = Number(
        readFileSync(join(fixture.appRoot, 'app.pid'), 'utf8').trim(),
      );
      expect(newPid).not.toBe(fixture.oldPid);
      expect(processExists(fixture.oldPid)).toBe(false);
      expect(processExists(newPid)).toBe(true);

      const backupRoot = join(
        fixture.appRoot,
        'output',
        'hotfix-backups',
      );
      const backupNames = readdirSync(backupRoot);
      expect(backupNames).toHaveLength(1);
      const backupDirectory = join(backupRoot, backupNames[0]);
      expect(
        sha256(join(backupDirectory, 'dist', 'server', 'main.js')),
      ).toBe(fixture.baselineHash);
      expect(
        sha256(join(backupDirectory, 'dist', 'client', 'main.js')),
      ).toBe(fixture.baselineClientHash);
      expect(
        existsSync(join(backupDirectory, 'dist', 'client', 'chunks')),
      ).toBe(false);
      expect(
        existsSync(join(backupDirectory, 'dist', 'server', 'dependency.js')),
      ).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects payload, target, and preserved-file drift before stopping the service', async () => {
    expect(existsSync(installerPath)).toBe(true);
    if (!existsSync(installerPath)) {
      return;
    }

    for (const drift of ['payload', 'target', 'preserved'] as const) {
      const fixture = await createFixture();
      try {
        if (drift === 'payload') {
          writeFileSync(
            join(fixture.packageRoot, 'dist', 'server', 'main.js'),
            'tampered payload\n',
            'utf8',
          );
        } else if (drift === 'target') {
          writeFileSync(
            join(fixture.appRoot, 'dist', 'server', 'main.js'),
            'tampered target\n',
            'utf8',
          );
        } else {
          writeFileSync(
            join(
              fixture.appRoot,
              'dist',
              'client',
              'chunks',
              'preserved.js',
            ),
            'tampered preserved client chunk\n',
            'utf8',
          );
        }

        const result = await fixture.run();
        expect(result.status).not.toBe(0);
        expect(result.output.toLowerCase()).toContain('hash mismatch');
        expect(
          Number(readFileSync(join(fixture.appRoot, 'app.pid'), 'utf8').trim()),
        ).toBe(fixture.oldPid);
        expect(processExists(fixture.oldPid)).toBe(true);
        expect(
          existsSync(
            join(fixture.appRoot, 'output', 'hotfix-backups'),
          ),
        ).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }
  });

  it('allows only the audited client main file and refuses other client paths or directory replacement', async () => {
    expect(existsSync(installerPath)).toBe(true);
    if (!existsSync(installerPath)) {
      return;
    }
    for (const invalidCase of ['other-client-file', 'directory'] as const) {
      const fixture = await createFixture();
      try {
        const manifest = JSON.parse(
          readFileSync(fixture.manifestPath, 'utf8'),
        );
        if (invalidCase === 'other-client-file') {
          const targetOtherClient = join(
            fixture.appRoot,
            'dist',
            'client',
            'other.js',
          );
          const packagedOtherClient = join(
            fixture.packageRoot,
            'dist',
            'client',
            'other.js',
          );
          writeFileSync(targetOtherClient, 'baseline other client\n', 'utf8');
          writeFileSync(packagedOtherClient, 'hotfix other client\n', 'utf8');
          manifest.replaceFiles = ['dist/client/other.js'];
          manifest.targetPreconditions = [
            { path: 'dist/client/other.js', sha256: sha256(targetOtherClient) },
          ];
          manifest.files.push({
            path: 'dist/client/other.js',
            sha256: sha256(packagedOtherClient),
          });
        } else {
          manifest.replaceDirectories = ['dist/client'];
        }
        writeFileSync(
          fixture.manifestPath,
          JSON.stringify(manifest, null, 2),
          'utf8',
        );

        const result = await fixture.run();
        expect(result.status).not.toBe(0);
        expect(result.output).toContain(
          invalidCase === 'directory' ? 'replaceDirectories' : 'dist/client',
        );
        expect(processExists(fixture.oldPid)).toBe(true);
        expect(
          sha256(join(fixture.appRoot, 'dist', 'client', 'main.js')),
        ).toBe(fixture.baselineClientHash);
        expect(
          existsSync(join(fixture.appRoot, 'output', 'hotfix-backups')),
        ).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }
  });

  it('installs and backs up every file in a coherent client snapshot', async () => {
    const fixture = await createFixture();
    try {
      const coherent = configureCoherentClientFixture(fixture);
      const result = await fixture.run();
      expect(result.status).toBe(0);
      expect(result.output).toContain('Hotfix installed and validated');
      expect(
        sha256(
          join(
            fixture.appRoot,
            coherent.relativeChunkPath.replace(/\//g, '\\'),
          ),
        ),
      ).toBe(coherent.newChunkHash);
      expect(
        existsSync(
          join(
            fixture.appRoot,
            coherent.oldChunkPath.replace(/\//g, '\\'),
          ),
        ),
      ).toBe(false);

      const backupRoot = join(
        fixture.appRoot,
        'output',
        'hotfix-backups',
      );
      const backupDirectory = join(backupRoot, readdirSync(backupRoot)[0]);
      expect(
        sha256(
          join(
            backupDirectory,
            coherent.oldChunkPath.replace(/\//g, '\\'),
          ),
        ),
      ).toBe(coherent.oldChunkHash);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects a coherent package that replaces only main.js before stopping the service', async () => {
    const fixture = await createFixture();
    try {
      configureCoherentClientFixture(fixture);
      const manifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8'));
      manifest.replaceFiles = manifest.replaceFiles.filter(
        (path: string) => path !== 'dist/client/chunks/1.aaaaaaaa.js',
      );
      writeFileSync(
        fixture.manifestPath,
        JSON.stringify(manifest, null, 2),
        'utf8',
      );

      const result = await fixture.run();
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('clientSnapshotFiles');
      expect(processExists(fixture.oldPid)).toBe(true);
      expect(
        Number(readFileSync(join(fixture.appRoot, 'app.pid'), 'utf8').trim()),
      ).toBe(fixture.oldPid);
      expect(
        existsSync(join(fixture.appRoot, 'output', 'hotfix-backups')),
      ).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it('restores the previous client directory when coherent deployment health fails', async () => {
    const fixture = await createFixture();
    try {
      const coherent = configureCoherentClientFixture(fixture);
      const result = await fixture.run('/health-that-must-fail');
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('Rollback completed');
      expect(
        sha256(
          join(
            fixture.appRoot,
            coherent.oldChunkPath.replace(/\//g, '\\'),
          ),
        ),
      ).toBe(coherent.oldChunkHash);
      expect(
        existsSync(
          join(
            fixture.appRoot,
            coherent.relativeChunkPath.replace(/\//g, '\\'),
          ),
        ),
      ).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it('falls back to the complete backup when the retired client is incomplete', async () => {
    const fixture = await createFixture();
    try {
      const coherent = configureCoherentClientFixture(fixture);
      const payloadMain = join(
        fixture.packageRoot,
        'dist',
        'server',
        'main.js',
      );
      const runtime = readFileSync(payloadMain, 'utf8');
      const requestHandlerMarker =
        "  if (request.url === '/api/access/session') {";
      const corruptRetiredClientHandler = [
        "  if (request.url === '/health-corrupt-retired') {",
        "    const stagingBase = path.join(__dirname, '..', '..', 'output', 'hotfix-staging');",
        '    for (const stagingName of fs.readdirSync(stagingBase)) {',
        "      const retiredChunk = path.join(stagingBase, stagingName, 'retired-client', 'chunks', '1.11111111.js');",
        '      if (fs.existsSync(retiredChunk)) {',
        '        fs.rmSync(retiredChunk, { force: true });',
        '      }',
        '    }',
        '    response.statusCode = 503;',
        "    response.end('retired client corrupted');",
        '    return;',
        '  }',
      ].join('\n');
      expect(runtime).toContain(requestHandlerMarker);
      writeFileSync(
        payloadMain,
        runtime.replace(
          requestHandlerMarker,
          `${corruptRetiredClientHandler}\n${requestHandlerMarker}`,
        ),
        'utf8',
      );
      const manifest = JSON.parse(
        readFileSync(fixture.manifestPath, 'utf8'),
      );
      const serverEntry = manifest.files.find(
        (entry: ManifestEntry) => entry.path === 'dist/server/main.js',
      );
      serverEntry.sha256 = sha256(payloadMain);
      writeFileSync(
        fixture.manifestPath,
        JSON.stringify(manifest, null, 2),
        'utf8',
      );

      const result = await fixture.run('/health-corrupt-retired');
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('Rollback completed');
      expect(
        sha256(
          join(
            fixture.appRoot,
            coherent.oldChunkPath.replace(/\//g, '\\'),
          ),
        ),
      ).toBe(coherent.oldChunkHash);
      expect(
        existsSync(
          join(
            fixture.appRoot,
            coherent.relativeChunkPath.replace(/\//g, '\\'),
          ),
        ),
      ).toBe(false);
      const restoredPid = Number(
        readFileSync(join(fixture.appRoot, 'app.pid'), 'utf8').trim(),
      );
      expect(restoredPid).not.toBe(fixture.oldPid);
      expect(processExists(restoredPid)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects stop-window server or preserved drift before client exchange and restarts it unchanged', async () => {
    for (const drift of ['server', 'preserved'] as const) {
      const fixture = await createFixture();
      try {
        const coherent = configureCoherentClientFixture(fixture);
        const stopScript = join(fixture.appRoot, 'stop.ps1');
        const originalStopScript = readFileSync(stopScript, 'utf8');
        const targetPath =
          drift === 'server'
            ? join(fixture.appRoot, 'dist', 'server', 'main.js')
            : join(fixture.appRoot, 'dist', 'server', 'dependency.js');
        const driftSourceName =
          drift === 'server'
            ? 'stop-window-main.js'
            : 'stop-window-dependency.js';
        const driftSource = join(fixture.appRoot, driftSourceName);
        if (drift === 'server') {
          writeFileSync(
            driftSource,
            readFileSync(targetPath, 'utf8').replace(
              "const version = 'baseline';",
              "const version = 'stop-window-drift';",
            ),
            'utf8',
          );
        } else {
          writeFileSync(driftSource, 'stop-window dependency drift\n', 'utf8');
        }
        const targetRelativePath =
          drift === 'server'
            ? 'dist/server/main.js'
            : 'dist/server/dependency.js';
        writeFileSync(
          stopScript,
          [
            originalStopScript.trimEnd(),
            `Copy-Item -LiteralPath (Join-Path $PSScriptRoot '${driftSourceName}') -Destination (Join-Path $PSScriptRoot '${targetRelativePath}') -Force`,
            '',
          ].join('\n'),
          'utf8',
        );

        const result = await fixture.run();
        expect(result.status).not.toBe(0);
        expect(result.output).toContain(
          drift === 'server'
            ? 'Stopped target precondition hash mismatch'
            : 'Stopped preserved file hash mismatch',
        );
        expect(result.output).toContain('No runtime files were changed');
        expect(result.output).toContain('Rollback completed');
        expect(sha256(targetPath)).toBe(sha256(driftSource));
        expect(
          sha256(
            join(
              fixture.appRoot,
              coherent.oldChunkPath.replace(/\//g, '\\'),
            ),
          ),
        ).toBe(coherent.oldChunkHash);
        expect(
          existsSync(
            join(
              fixture.appRoot,
              coherent.relativeChunkPath.replace(/\//g, '\\'),
            ),
          ),
        ).toBe(false);
        const restartedPid = Number(
          readFileSync(join(fixture.appRoot, 'app.pid'), 'utf8').trim(),
        );
        expect(restartedPid).not.toBe(fixture.oldPid);
        expect(processExists(restartedPid)).toBe(true);
      } finally {
        fixture.cleanup();
      }
    }
  });

  it('stops the failed hotfix, restores the backup, and restarts the original service', async () => {
    expect(existsSync(installerPath)).toBe(true);
    if (!existsSync(installerPath)) {
      return;
    }
    const fixture = await createFixture();
    try {
      const result = await fixture.run('/health-that-must-fail');
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('Rollback completed');
      expect(sha256(join(fixture.appRoot, 'dist', 'server', 'main.js'))).toBe(
        fixture.baselineHash,
      );
      expect(sha256(join(fixture.appRoot, 'dist', 'client', 'main.js'))).toBe(
        fixture.baselineClientHash,
      );
      expect(
        sha256(
          join(
            fixture.appRoot,
            'dist',
            'client',
            'chunks',
            'preserved.js',
          ),
        ),
      ).toBe(fixture.preservedChunkHash);
      const restoredPid = Number(
        readFileSync(join(fixture.appRoot, 'app.pid'), 'utf8').trim(),
      );
      expect(restoredPid).not.toBe(fixture.oldPid);
      expect(processExists(fixture.oldPid)).toBe(false);
      expect(processExists(restoredPid)).toBe(true);

      const backupRoot = join(
        fixture.appRoot,
        'output',
        'hotfix-backups',
      );
      expect(statSync(backupRoot).isDirectory()).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});
