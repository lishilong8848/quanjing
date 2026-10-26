import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

const ROOT = resolve(__dirname, '../..');
const PACKAGER_PATH = join(
  ROOT,
  'scripts',
  'create-safe-full-runtime-hotfix-package.ps1',
);
const CLIENT_VERIFIER_PATH = join(
  ROOT,
  'scripts',
  'verify-client-asset-graph.mjs',
);
const describeWindows = process.platform === 'win32' ? describe : describe.skip;
let installerRunSequence = 0;
const KNOWN_OBSOLETE_CERTIFICATE_SCHEDULER_DECLARATION_BASE64 =
  'aW1wb3J0IHsgdHlwZSBPbk1vZHVsZURlc3Ryb3ksIHR5cGUgT25Nb2R1bGVJbml0IH0gZnJvbSAnQG5lc3Rqcy9jb21tb24nOwppbXBvcnQgeyBDZXJ0aWZpY2F0ZURhc2hib2FyZFNlcnZpY2UgfSBmcm9tICcuL2NlcnRpZmljYXRlLWRhc2hib2FyZC5zZXJ2aWNlJzsKZXhwb3J0IGRlY2xhcmUgY2xhc3MgQ2VydGlmaWNhdGVEYXNoYm9hcmRTY2hlZHVsZXIgaW1wbGVtZW50cyBPbk1vZHVsZUluaXQsIE9uTW9kdWxlRGVzdHJveSB7CiAgICBwcml2YXRlIHJlYWRvbmx5IHNlcnZpY2U7CiAgICBwcml2YXRlIHJlYWRvbmx5IGxvZ2dlcjsKICAgIHByaXZhdGUgdGltZXI7CiAgICBwcml2YXRlIHN0YXJ0ZWQ7CiAgICBjb25zdHJ1Y3RvcihzZXJ2aWNlOiBDZXJ0aWZpY2F0ZURhc2hib2FyZFNlcnZpY2UpOwogICAgb25Nb2R1bGVJbml0KCk6IHZvaWQ7CiAgICBvbk1vZHVsZURlc3Ryb3koKTogdm9pZDsKICAgIHByaXZhdGUgc2NoZWR1bGVOZXh0Owp9CmV4cG9ydCBkZWNsYXJlIGZ1bmN0aW9uIG5leHRDZXJ0aWZpY2F0ZURhc2hib2FyZFJ1bkF0KG5vdzogRGF0ZSwgaG91cjogbnVtYmVyLCBtaW51dGU6IG51bWJlcik6IERhdGU7Cg==';

jest.setTimeout(180_000);

type FileEntry = {
  path: string;
  size: number;
  sha256: string;
  reason?: string;
};

type RuntimeFixture = {
  root: string;
  appRoot: string;
  packageRoot: string;
  packageId: string;
  port: number;
  endpoint: string;
  oldMain: string;
  oldStart: string;
  legacyStartMarker?: string;
  stageTargetPath: string;
  faultMarkerPath: string;
  dependencySentinelPath: string;
  recoveryPidMarker?: string;
  recoveryNodeCapturePath?: string;
  sentinels: Array<{ path: string; content: string }>;
};

type InstallerResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

type FixtureDependencyProof = {
  proofAlgorithm: string;
  lockPhysicalTreeFingerprint: string;
  installedPhysicalTreeFingerprint: string;
  packageCount: number;
  fileCount: number;
  bytes: number;
};

const fixtureRoots: string[] = [];
const trackedPids = new Set<number>();

function sha256Buffer(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path: string): string {
  return sha256Buffer(readFileSync(path));
}

function toUnixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function writeText(path: string, value: string, withBom = false): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${withBom ? '\ufeff' : ''}${value}`, 'utf8');
}

function writeKnownObsoleteCertificateSchedulerDeclaration(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    Buffer.from(
      KNOWN_OBSOLETE_CERTIFICATE_SCHEDULER_DECLARATION_BASE64,
      'base64',
    ),
  );
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const name of readdirSync(current)) {
      const fullPath = join(current, name);
      if (statSync(fullPath).isDirectory()) {
        visit(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  };
  visit(root);
  return files.sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
  );
}

function entryFor(root: string, fullPath: string): FileEntry {
  return {
    path: toUnixPath(relative(root, fullPath)),
    size: statSync(fullPath).size,
    sha256: sha256File(fullPath),
  };
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.path, 'utf8'),
      Buffer.from(right.path, 'utf8'),
    ),
  );
}

function fingerprint(entries: FileEntry[]): string {
  return sha256Buffer(
    sortEntries(entries)
      .map((entry) => `${entry.path}:${entry.size}:${entry.sha256}`)
      .join('\n'),
  );
}

function exportPlanFingerprint(entries: FileEntry[]): string {
  return sha256Buffer(
    sortEntries(entries)
      .map((entry) =>
        entry.reason
          ? `metadata\0${entry.reason}\0${entry.path}\0${entry.size}\0${entry.sha256}`
          : `payload\0${entry.path}\0${entry.size}\0${entry.sha256}`,
      )
      .join('\n'),
  );
}

function activeClientFingerprint(entries: FileEntry[]): string {
  const clientPrefix = 'dist/client/';
  return sha256Buffer(
    sortEntries(entries)
      .map((entry) => {
        if (!entry.path.startsWith(clientPrefix)) {
          throw new Error(
            `active client fixture path is outside dist/client: ${entry.path}`,
          );
        }
        return `asset\0${entry.path.slice(clientPrefix.length)}\0${entry.size}\0${entry.sha256}`;
      })
      .join('\n'),
  );
}

function createClientMainScript(version: 'old' | 'candidate'): string {
  return [
    `globalThis.RUNTIME = '${version}';`,
    '(()=>{var h={};',
    'h.u=e=>"chunks/"+e+"."+({1:"aaaaaaaa"})[e]+".js";',
    'h.k=e=>"2"===e?"main.css":"chunks/"+e+"."+({2:"bbbbbbbb"})[e]+".css";',
    '})();',
  ].join('');
}

function createDependencyVerifierStub(
  proof: FixtureDependencyProof,
  expectedSentinelSha256: string,
  expectedCandidatePackageSha256: string,
  expectedCandidateLockSha256: string,
): string {
  const report = {
    success: true,
    metadataVerified: true,
    transition: 'none',
    packages: {},
    lockPhysicalTreeFingerprint: proof.lockPhysicalTreeFingerprint,
    physicalVerified: true,
    requiresNodeModulesMutation: false,
    proofAlgorithm: proof.proofAlgorithm,
    installedPhysicalTreeFingerprint: proof.installedPhysicalTreeFingerprint,
    packageCount: proof.packageCount,
    fileCount: proof.fileCount,
    bytes: proof.bytes,
  };
  return [
    "import { createHash } from 'node:crypto';",
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "import { dirname, join, resolve } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    `const expectedReport = ${JSON.stringify(report)};`,
    `const expectedSentinelSha256 = ${JSON.stringify(expectedSentinelSha256)};`,
    `const expectedCandidatePackageSha256 = ${JSON.stringify(expectedCandidatePackageSha256)};`,
    `const expectedCandidateLockSha256 = ${JSON.stringify(expectedCandidateLockSha256)};`,
    "const optionNames = ['--baseline-package', '--baseline-lock', '--candidate-package', '--candidate-lock', '--installed-node-modules', '--proof-cache'];",
    'const fail = (message) => { process.stderr.write(`${message}\\n`); process.exit(1); };',
    'const cliArguments = process.argv.slice(2);',
    "if (cliArguments[cliArguments.length - 1] === '--json') cliArguments.pop();",
    "if (cliArguments.length % 2 !== 0) fail('fixture dependency verifier arguments are invalid');",
    'const optionValues = new Map();',
    'for (let offset = 0; offset < cliArguments.length; offset += 2) {',
    "  if (!optionNames.includes(cliArguments[offset]) || !cliArguments[offset + 1] || optionValues.has(cliArguments[offset])) fail('fixture dependency verifier arguments are invalid');",
    '  optionValues.set(cliArguments[offset], resolve(cliArguments[offset + 1]));',
    '}',
    "if (optionNames.slice(0, 5).some((name) => !optionValues.has(name))) fail('fixture dependency verifier arguments are incomplete');",
    "const canonicalPath = (value) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);",
    "const baselinePackagePath = optionValues.get('--baseline-package');",
    "const baselineLockPath = optionValues.get('--baseline-lock');",
    "const candidatePackagePath = optionValues.get('--candidate-package');",
    "const candidateLockPath = optionValues.get('--candidate-lock');",
    "const installedNodeModulesPath = optionValues.get('--installed-node-modules');",
    'const appRoot = dirname(baselinePackagePath);',
    "appendFileSync(join(appRoot, '.fixture-dependency-verifier-invocations'), '1\\n', 'utf8');",
    "const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');",
    'const candidateRoot = dirname(candidatePackagePath);',
    "const packagedCandidateRoot = join(packageRoot, 'release-root');",
    'const candidateRootIsValid = canonicalPath(candidateRoot) === canonicalPath(packagedCandidateRoot) || canonicalPath(candidateRoot) === canonicalPath(appRoot);',
    "if (canonicalPath(baselineLockPath) !== canonicalPath(join(appRoot, 'package-lock.json')) ||",
    '    !candidateRootIsValid ||',
    "    canonicalPath(candidatePackagePath) !== canonicalPath(join(candidateRoot, 'package.json')) ||",
    "    canonicalPath(candidateLockPath) !== canonicalPath(join(candidateRoot, 'package-lock.json')) ||",
    "    canonicalPath(installedNodeModulesPath) !== canonicalPath(join(appRoot, 'node_modules'))) fail('fixture dependency verifier paths are invalid');",
    "const sha256 = (value) => createHash('sha256').update(value).digest('hex');",
    'let candidatePackageBytes;',
    'let candidateLockBytes;',
    'let sentinelBytes;',
    'try {',
    '  readFileSync(baselinePackagePath);',
    '  readFileSync(baselineLockPath);',
    '  candidatePackageBytes = readFileSync(candidatePackagePath);',
    '  candidateLockBytes = readFileSync(candidateLockPath);',
    "  sentinelBytes = readFileSync(join(installedNodeModulesPath, 'runtime-fixture-dependency', '.nantong-fixture-dependency-proof'));",
    '} catch {',
    "  fail('fixture dependency verifier input is unreadable');",
    '}',
    "if (sha256(candidatePackageBytes) !== expectedCandidatePackageSha256 || sha256(candidateLockBytes) !== expectedCandidateLockSha256) fail('fixture candidate dependency metadata hash mismatch');",
    "if (sha256(sentinelBytes) !== expectedSentinelSha256) fail('fixture dependency sentinel hash mismatch');",
    'process.stdout.write(`${JSON.stringify(expectedReport)}\n`);',
  ].join('\n');
}

function extractInstaller(): string {
  const source = readFileSync(PACKAGER_PATH, 'utf8');
  const match = source.match(
    /\$installer = @'\r?\n([\s\S]*?)\r?\n'@\r?\nSet-Content -LiteralPath \(Join-Path \$stageRoot 'INSTALL-HOTFIX\.ps1'\)/,
  );
  if (!match) {
    throw new Error('embedded installer could not be extracted');
  }
  return match[1];
}

function quotePowerShell(value: string): string {
  return value.replace(/'/g, "''");
}

function createMainScript(
  version: 'old' | 'candidate',
  responseLimit?: number,
  rejectSmokeMode = false,
  mutateDependencyAfterListen = false,
): string {
  const marker =
    version === 'candidate'
      ? "fs.writeFileSync(path.join(__dirname, '..', '..', '.candidate-listening'), 'ready');"
      : '';
  return [
    "const http = require('http');",
    "const fs = require('fs');",
    "const path = require('path');",
    'const port = Number(process.argv[2] || process.env.SERVER_PORT);',
    `const version = '${version}';`,
    ...(rejectSmokeMode
      ? [
          "if ((process.env.NANTONG_HOTFIX_SMOKE_MODE || '').toLowerCase() === 'true') { process.exit(41); }",
        ]
      : []),
    'let responseCount = 0;',
    'const server = http.createServer((request, response) => {',
    "  response.setHeader('content-type', 'application/json');",
    "  if ((request.url || '').includes('/api/feishu-card-callback/health')) {",
    "    const enabled = (process.env.NANTONG_HOTFIX_SMOKE_MODE || '').toLowerCase() !== 'true';",
    '    response.end(JSON.stringify({ enabled, ready: enabled }));',
    '    return;',
    '  }',
    "  response.end(JSON.stringify({ role: 'admin', capabilities: { inventory: true }, version }));",
    ...(responseLimit
      ? [
          '  responseCount += 1;',
          `  if (responseCount >= ${responseLimit}) {`,
          '    setTimeout(() => server.close(() => process.exit(0)), 50);',
          '  }',
        ]
      : []),
    '});',
    "server.listen(port, '127.0.0.1', () => {",
    `  ${marker}`,
    ...(mutateDependencyAfterListen
      ? [
          "  const dependencyRoot = path.join(__dirname, '..', '..', 'node_modules', 'runtime-fixture-dependency');",
          "  fs.writeFileSync(path.join(dependencyRoot, 'package.json'), JSON.stringify({ name: 'runtime-fixture-dependency', version: '9.9.9' }));",
          "  fs.writeFileSync(path.join(dependencyRoot, '.nantong-fixture-dependency-proof'), 'tampered after candidate start\\r\\n');",
        ]
      : []),
    '});',
    "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
  ].join('\r\n');
}

function createStartScript(
  port: number,
  exitCode: number,
  pidMarkerPath?: string,
  diagnostics?: { stdout: string; stderr: string },
  recoveryNodeCapturePath?: string,
): string {
  const nodePath = quotePowerShell(process.execPath);
  return [
    'param([switch]$NoBrowser)',
    "$ErrorActionPreference = 'Stop'",
    `$nodePath = '${nodePath}'`,
    "$appRootPath = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\\')",
    "$mainFile = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'dist\\server\\main.js'))",
    "$logRoot = Join-Path $PSScriptRoot 'logs'",
    'New-Item -ItemType Directory -Path $logRoot -Force | Out-Null',
    "$runtimeStdout = Join-Path $logRoot 'fixture-runtime.out.log'",
    "$runtimeStderr = Join-Path $logRoot 'fixture-runtime.err.log'",
    `$mainArgument = '"' + $mainFile + '"'`,
    `$runtimeProcess = Start-Process -FilePath $nodePath -ArgumentList @($mainArgument, '${port}') -WorkingDirectory $PSScriptRoot -RedirectStandardOutput $runtimeStdout -RedirectStandardError $runtimeStderr -WindowStyle Hidden -PassThru`,
    '$runtimeProcess.Refresh()',
    '$pidRecord = [ordered]@{',
    '  schemaVersion = 1',
    '  pid = $runtimeProcess.Id',
    "  startTime = $runtimeProcess.StartTime.ToUniversalTime().ToString('o')",
    '  appRoot = $appRootPath',
    '  mainFile = $mainFile',
    '} | ConvertTo-Json -Compress',
    "$pidPath = Join-Path $PSScriptRoot 'app.pid'",
    '[System.IO.File]::WriteAllText($pidPath, $pidRecord, [System.Text.UTF8Encoding]::new($false))',
    ...(pidMarkerPath
      ? [
          `[System.IO.File]::WriteAllText('${quotePowerShell(pidMarkerPath)}', [string]$runtimeProcess.Id, [System.Text.UTF8Encoding]::new($false))`,
        ]
      : []),
    ...(recoveryNodeCapturePath
      ? [
          `[System.IO.File]::WriteAllText('${quotePowerShell(recoveryNodeCapturePath)}', [string]$env:NANTONG_HOTFIX_RECOVERY_NODE_PATH, [System.Text.UTF8Encoding]::new($false))`,
        ]
      : []),
    ...(diagnostics
      ? [
          `[Console]::Out.WriteLine('${quotePowerShell(diagnostics.stdout)}')`,
          `[Console]::Error.WriteLine('${quotePowerShell(diagnostics.stderr)}')`,
        ]
      : []),
    ...(exitCode === 0
      ? ['exit 0']
      : ['Start-Sleep -Milliseconds 1000', `exit ${exitCode}`]),
  ].join('\r\n');
}

function createLegacyBaselineStartScript(markerPath: string): string {
  return [
    "param([int]$Port = 0, [string]$HostName = '')",
    "$ErrorActionPreference = 'Stop'",
    `Set-Content -LiteralPath '${quotePowerShell(markerPath)}' -Value invoked -Encoding UTF8`,
    "throw 'legacy baseline start script must not be used for hotfix rollback'",
  ].join('\r\n');
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to reserve test port');
  }
  const port = address.port;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

function readPidRecord(appRoot: string): Record<string, unknown> | undefined {
  const pidPath = join(appRoot, 'app.pid');
  if (!existsSync(pidPath)) {
    return undefined;
  }
  const value = readFileSync(pidPath, 'utf8').trim();
  if (/^\d+$/.test(value)) {
    return { pid: Number(value) };
  }
  return JSON.parse(value) as Record<string, unknown>;
}

function trackAppPid(appRoot: string): number | undefined {
  try {
    const record = readPidRecord(appRoot);
    const pid = Number(record?.pid);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      trackedPids.add(pid);
      return pid;
    }
  } catch {
    // Cleanup remains best-effort; assertions validate production errors.
  }
  return undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForProcessExitSync(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    Atomics.wait(sleeper, 0, 0, 25);
  }
  return !isProcessAlive(pid);
}

function terminatePid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The process may already have exited.
  }
  if (!waitForProcessExitSync(pid, 2_000)) {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5_000,
    });
    waitForProcessExitSync(pid, 5_000);
  }
}

async function requestVersion(endpoint: string): Promise<string | undefined> {
  return new Promise((resolveRequest) => {
    const request = get(endpoint, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolveRequest(JSON.parse(body).version as string | undefined);
        } catch {
          resolveRequest(undefined);
        }
      });
    });
    request.setTimeout(2_000, () => request.destroy());
    request.on('error', () => resolveRequest(undefined));
  });
}

async function waitForVersion(
  endpoint: string,
  expected: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await requestVersion(endpoint)) === expected) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`runtime did not become healthy as ${expected}`);
}

async function waitForFile(path: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for file: ${path}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

async function waitForJsonFile(
  path: string,
  timeoutMs = 45_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as Record<
          string,
          unknown
        >;
      } catch {
        // The installer creates this file under FileShare.None, then writes and closes it.
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error(`timed out waiting for readable JSON file: ${path}`);
}

async function createFixture(options?: {
  candidateLauncherExitCode?: number;
  fillerCount?: number;
  candidateResponseLimit?: number;
  legacyBaselineStart?: boolean;
  recoveryNeverHealthy?: boolean;
  unicodeAppRoot?: boolean;
  rejectSmokeMode?: boolean;
  installerSource?: string;
  candidateLauncherDiagnostics?: { stdout: string; stderr: string };
  consumerReleaseMarker?: boolean;
  releasePackageJson?: boolean;
  alreadyDeployedReleaseScript?: boolean;
  captureRecoveryNodePath?: boolean;
  candidateConfigurationPreflightExitCode?: number;
  mutateDependencyAfterCandidateStart?: boolean;
  actualRecoveryLauncher?: boolean;
}): Promise<RuntimeFixture> {
  const port = await reservePort();
  const root = mkdtempSync(join(tmpdir(), 'nantong-installer-runtime-'));
  fixtureRoots.push(root);
  const appRoot = join(root, options?.unicodeAppRoot ? '南通排班-app' : 'app');
  const packageRoot = join(root, 'package');
  const packageId = `runtime-test-${basename(root)}`;
  const endpoint = `http://127.0.0.1:${port}/api/access/session`;
  const faultMarkerPath = join(root, 'nantong-hotfix-fault-fixture.marker');
  const recoveryPidMarker = options?.recoveryNeverHealthy
    ? join(root, 'recovery-runtime.pid')
    : undefined;
  const recoveryNodeCapturePath = options?.captureRecoveryNodePath
    ? join(root, 'recovery-node-path.txt')
    : undefined;
  let recoveryPort = port;
  if (options?.recoveryNeverHealthy) {
    do {
      recoveryPort = await reservePort();
    } while (recoveryPort === port);
  }

  for (const directory of [
    join(appRoot, 'dist', 'server'),
    join(appRoot, 'dist', 'shared'),
    join(appRoot, 'dist', 'client'),
    join(appRoot, 'node_modules'),
    join(packageRoot, 'dist', 'server'),
    join(packageRoot, 'dist', 'shared'),
    join(packageRoot, 'dist', 'client'),
    join(packageRoot, 'release-root'),
    join(packageRoot, 'operations'),
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  const oldMain = createMainScript('old', undefined, options?.rejectSmokeMode);
  const candidateMain = createMainScript(
    'candidate',
    options?.candidateResponseLimit,
    options?.rejectSmokeMode,
    options?.mutateDependencyAfterCandidateStart,
  );
  const legacyStartMarker = options?.legacyBaselineStart
    ? join(appRoot, '.legacy-start-invoked')
    : undefined;
  const oldStart = `\ufeff${
    legacyStartMarker
      ? createLegacyBaselineStartScript(legacyStartMarker)
      : createStartScript(port, 0)
  }`;
  const candidateStart = `\ufeff${createStartScript(
    port,
    options?.candidateLauncherExitCode ?? 0,
    undefined,
    options?.candidateLauncherDiagnostics,
  )}`;
  const recoveryStart = options?.actualRecoveryLauncher
    ? readFileSync(join(ROOT, 'deploy', 'hotfix-recovery-start.ps1'), 'utf8')
    : `\ufeff${createStartScript(
    recoveryPort,
    0,
    recoveryPidMarker,
    undefined,
    recoveryNodeCapturePath,
  )}`;
  const fixtureDependencyName = 'runtime-fixture-dependency';
  const fixtureDependencies = { [fixtureDependencyName]: '1.0.0' };
  const packageJson = JSON.stringify({
    name: 'runtime-fixture',
    version: '1.0.0',
    dependencies: fixtureDependencies,
  });
  const candidatePackageJson = JSON.stringify({
    name: 'runtime-fixture',
    version: '2.0.0',
    dependencies: fixtureDependencies,
  });
  const packageLock = JSON.stringify({
    name: 'runtime-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'runtime-fixture',
        version: '1.0.0',
        dependencies: fixtureDependencies,
      },
      [`node_modules/${fixtureDependencyName}`]: {
        version: '1.0.0',
      },
    },
  });
  const candidatePackageLock = JSON.stringify({
    name: 'runtime-fixture',
    version: '2.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'runtime-fixture',
        version: '2.0.0',
        dependencies: fixtureDependencies,
      },
      [`node_modules/${fixtureDependencyName}`]: {
        version: '1.0.0',
      },
    },
  });
  const dependencySentinelContent =
    'runtime fixture dependency proof sentinel v1\r\n';
  const dependencySentinelPath = join(
    appRoot,
    'node_modules',
    fixtureDependencyName,
    '.nantong-fixture-dependency-proof',
  );
  const clientIndex =
    '<link rel="stylesheet" href="/main.css"><script src="/main.js"></script>';
  const clientCss = 'body{color:inherit}';
  const clientJavaScriptChunk = 'globalThis.__chunkLoaded=true;';
  const clientCssChunk = '.fixture{}';

  writeText(join(appRoot, 'package.json'), packageJson);
  writeText(join(appRoot, 'package-lock.json'), packageLock);
  writeText(
    join(appRoot, 'node_modules', fixtureDependencyName, 'package.json'),
    JSON.stringify({ name: fixtureDependencyName, version: '1.0.0' }),
  );
  writeText(
    join(appRoot, 'node_modules', fixtureDependencyName, 'index.js'),
    "module.exports = 'fixture';\r\n",
  );
  writeText(dependencySentinelPath, dependencySentinelContent);
  const dependencyFiles = walkFiles(join(appRoot, 'node_modules')).map((path) =>
    entryFor(appRoot, path),
  );
  const dependencyProof: FixtureDependencyProof = {
    proofAlgorithm: 'sha256-package-lock-production-closure-v1',
    lockPhysicalTreeFingerprint: sha256Buffer(candidatePackageLock),
    installedPhysicalTreeFingerprint: fingerprint(dependencyFiles),
    packageCount: 1,
    fileCount: dependencyFiles.length,
    bytes: dependencyFiles.reduce((sum, entry) => sum + entry.size, 0),
  };
  writeText(join(appRoot, 'start.ps1'), oldStart);
  writeText(join(appRoot, 'start.cmd'), '@echo off\r\nexit /b 0\r\n');
  writeText(
    join(appRoot, '.env'),
    'OVERTIME_WORKFLOW_PROGRAM_ENABLED=false\r\n',
  );
  writeText(join(appRoot, '.runtime', 'sentinel.txt'), 'runtime-sentinel\r\n');
  writeText(join(appRoot, 'logs', 'sentinel.txt'), 'logs-sentinel\r\n');
  writeText(faultMarkerPath, 'nantong-safe-hotfix-fixture-v1\r\n');
  writeText(join(appRoot, 'dist', 'server', 'main.js'), oldMain);
  writeText(
    join(appRoot, 'dist', 'shared', 'shared.js'),
    "module.exports = 'old';\r\n",
  );
  writeText(join(appRoot, 'dist', 'client', 'index.html'), clientIndex);
  writeText(
    join(appRoot, 'dist', 'client', 'main.js'),
    createClientMainScript('old'),
  );
  writeText(join(appRoot, 'dist', 'client', 'main.css'), clientCss);
  writeText(
    join(appRoot, 'dist', 'client', 'chunks', '1.aaaaaaaa.js'),
    clientJavaScriptChunk,
  );
  writeText(
    join(appRoot, 'dist', 'client', 'chunks', '2.bbbbbbbb.css'),
    clientCssChunk,
  );

  writeText(join(packageRoot, 'dist', 'server', 'main.js'), candidateMain);
  writeText(
    join(packageRoot, 'dist', 'shared', 'shared.js'),
    "module.exports = 'candidate';\r\n",
  );
  writeText(join(packageRoot, 'dist', 'client', 'index.html'), clientIndex);
  writeText(
    join(packageRoot, 'dist', 'client', 'main.js'),
    createClientMainScript('candidate'),
  );
  writeText(join(packageRoot, 'dist', 'client', 'main.css'), clientCss);
  writeText(
    join(packageRoot, 'dist', 'client', 'chunks', '1.aaaaaaaa.js'),
    clientJavaScriptChunk,
  );
  writeText(
    join(packageRoot, 'dist', 'client', 'chunks', '2.bbbbbbbb.css'),
    clientCssChunk,
  );
  for (let index = 0; index < (options?.fillerCount ?? 0); index += 1) {
    writeText(
      join(
        packageRoot,
        'dist',
        'client',
        'chunks',
        `filler-${String(index).padStart(4, '0')}.js`,
      ),
      `// filler ${index}\r\n`,
    );
  }
  const stageTargetPath = join(
    appRoot,
    '.hotfix-stage',
    packageId,
    'dist',
    'client',
    'zzzz-stage-target.js',
  );
  writeText(
    join(packageRoot, 'dist', 'client', 'zzzz-stage-target.js'),
    '// stage integrity target\r\n',
  );
  writeText(join(packageRoot, 'release-root', 'start.ps1'), candidateStart);
  if (options?.candidateConfigurationPreflightExitCode !== undefined) {
    writeText(
      join(
        packageRoot,
        'release-root',
        'scripts',
        'ensure-purchase-inventory-config.mjs',
      ),
      [
        "if (!process.argv.includes('--activate-workflow')) process.exit(97);",
        ...(options.candidateConfigurationPreflightExitCode === 0
          ? [
              "process.stdout.write('fixture purchase configuration is valid\\n');",
            ]
          : [
              "process.stderr.write('fixture purchase configuration is invalid\\n');",
            ]),
        `process.exit(${options.candidateConfigurationPreflightExitCode});`,
      ].join('\r\n'),
    );
  }
  writeText(
    join(packageRoot, 'release-root', 'package.json'),
    candidatePackageJson,
  );
  writeText(
    join(packageRoot, 'release-root', 'package-lock.json'),
    candidatePackageLock,
  );
  if (options?.alreadyDeployedReleaseScript) {
    const relativePath = 'scripts/backfill-dingtalk-attendance-archive.mjs';
    const content = "export const archiveVersion = 'candidate';\r\n";
    writeText(join(appRoot, ...relativePath.split('/')), content);
    writeText(
      join(packageRoot, 'release-root', ...relativePath.split('/')),
      content,
    );
  }
  if (options?.consumerReleaseMarker) {
    const releaseMarker = 'FEISHU_CARD_ACTION_CONSUMER_RELEASE_V1\r\n';
    writeText(
      join(appRoot, '.feishu-card-action-consumer-release'),
      releaseMarker,
    );
    writeText(
      join(packageRoot, 'release-root', '.feishu-card-action-consumer-release'),
      releaseMarker,
    );
  }
  writeText(
    join(packageRoot, 'operations', 'deploy', 'hotfix-recovery-start.ps1'),
    recoveryStart,
  );
  writeText(
    join(
      packageRoot,
      'operations',
      'scripts',
      'verify-hotfix-dependency-transition.mjs',
    ),
    createDependencyVerifierStub(
      dependencyProof,
      sha256Buffer(dependencySentinelContent),
      sha256Buffer(candidatePackageJson),
      sha256Buffer(candidatePackageLock),
    ),
  );
  writeText(
    join(packageRoot, 'operations', 'scripts', 'verify-client-asset-graph.mjs'),
    readFileSync(CLIENT_VERIFIER_PATH, 'utf8'),
  );
  writeText(
    join(packageRoot, 'INSTALL-HOTFIX.ps1'),
    options?.installerSource ?? `\ufeff${extractInstaller()}`,
  );
  writeText(join(packageRoot, 'README.md'), 'runtime fixture hotfix\r\n');

  const baselinePaths = [
    'package.json',
    'package-lock.json',
    'start.ps1',
    'start.cmd',
    'dist/server/main.js',
    'dist/shared/shared.js',
    'dist/client/index.html',
    'dist/client/main.js',
    'dist/client/main.css',
    'dist/client/chunks/1.aaaaaaaa.js',
    'dist/client/chunks/2.bbbbbbbb.css',
  ];
  if (options?.consumerReleaseMarker) {
    baselinePaths.push('.feishu-card-action-consumer-release');
  }
  const serverBaselineFiles = baselinePaths.map((relativePath) =>
    entryFor(appRoot, join(appRoot, ...relativePath.split('/'))),
  );
  const payloadFiles = walkFiles(join(packageRoot, 'dist')).map((path) =>
    entryFor(packageRoot, path),
  );
  const activeClientPaths = [
    'dist/client/index.html',
    'dist/client/main.js',
    'dist/client/main.css',
    'dist/client/chunks/1.aaaaaaaa.js',
    'dist/client/chunks/2.bbbbbbbb.css',
    'dist/client/zzzz-stage-target.js',
  ];
  const activeClientFiles = activeClientPaths.map((relativePath) =>
    entryFor(packageRoot, join(packageRoot, ...relativePath.split('/'))),
  );
  const releaseStartPath = join(packageRoot, 'release-root', 'start.ps1');
  const releaseFiles = [
    {
      ...entryFor(packageRoot, releaseStartPath),
      targetPath: 'start.ps1',
      baselineExisted: true,
      baselineSha256: sha256File(join(appRoot, 'start.ps1')),
    },
  ];
  for (const relativePath of ['package.json', 'package-lock.json']) {
    releaseFiles.push({
      ...entryFor(packageRoot, join(packageRoot, 'release-root', relativePath)),
      targetPath: relativePath,
      baselineExisted: true,
      baselineSha256: sha256File(join(appRoot, relativePath)),
    });
  }
  if (options?.consumerReleaseMarker) {
    const relativePath = '.feishu-card-action-consumer-release';
    releaseFiles.push({
      ...entryFor(packageRoot, join(packageRoot, 'release-root', relativePath)),
      targetPath: relativePath,
      baselineExisted: true,
      baselineSha256: sha256File(join(appRoot, relativePath)),
    });
  }
  if (options?.alreadyDeployedReleaseScript) {
    const relativePath = 'scripts/backfill-dingtalk-attendance-archive.mjs';
    releaseFiles.push({
      ...entryFor(
        packageRoot,
        join(packageRoot, 'release-root', ...relativePath.split('/')),
      ),
      targetPath: relativePath,
      baselineExisted: false,
      baselineSha256: '',
    });
  }
  if (options?.candidateConfigurationPreflightExitCode !== undefined) {
    const relativePath = 'scripts/ensure-purchase-inventory-config.mjs';
    releaseFiles.push({
      ...entryFor(
        packageRoot,
        join(packageRoot, 'release-root', ...relativePath.split('/')),
      ),
      targetPath: relativePath,
      baselineExisted: false,
      baselineSha256: '',
    });
  }
  const supportFiles = [
    'operations/deploy/hotfix-recovery-start.ps1',
    'operations/scripts/verify-hotfix-dependency-transition.mjs',
    'operations/scripts/verify-client-asset-graph.mjs',
  ].map((relativePath) =>
    entryFor(packageRoot, join(packageRoot, ...relativePath.split('/'))),
  );
  const controlFiles = ['INSTALL-HOTFIX.ps1', 'README.md'].map((relativePath) =>
    entryFor(packageRoot, join(packageRoot, relativePath)),
  );
  const baseFiles = ['package.json', 'package-lock.json'].map(
    (relativePath) => ({
      path: relativePath,
      sha256: sha256File(join(appRoot, relativePath)),
    }),
  );
  const baseFingerprint = sha256Buffer(
    baseFiles.map((entry) => `${entry.path}:${entry.sha256}`).join('\n'),
  );
  const distFingerprints = Object.fromEntries(
    ['dist/server', 'dist/shared', 'dist/client'].map((runtimeRoot) => [
      runtimeRoot,
      fingerprint(
        serverBaselineFiles.filter((entry) =>
          entry.path.startsWith(`${runtimeRoot}/`),
        ),
      ),
    ]),
  );
  const manifest = {
    schemaVersion: 6,
    packageId,
    createdAt: new Date().toISOString(),
    releaseMode: 'complete-runtime-atomic-switch',
    releaseToolFingerprint: sha256Buffer('runtime-fixture-release-tool-v1'),
    installedReleaseReceiptSchemaVersion: 2,
    installerSha256: sha256File(join(packageRoot, 'INSTALL-HOTFIX.ps1')),
    recoveryLauncherSha256: sha256File(
      join(packageRoot, 'operations', 'deploy', 'hotfix-recovery-start.ps1'),
    ),
    dependencyVerifierSha256: sha256File(
      join(
        packageRoot,
        'operations',
        'scripts',
        'verify-hotfix-dependency-transition.mjs',
      ),
    ),
    clientVerifierSha256: sha256File(
      join(
        packageRoot,
        'operations',
        'scripts',
        'verify-client-asset-graph.mjs',
      ),
    ),
    buildNodeVersion: process.version,
    buildNpmVersion: 'runtime-fixture-npm',
    buildNodeSha256: sha256Buffer('runtime-fixture-node-binary-v1'),
    buildNpmSha256: sha256Buffer('runtime-fixture-npm-cli-v1'),
    candidatePackageSha256: sha256Buffer(candidatePackageJson),
    candidatePackageLockSha256: sha256Buffer(candidatePackageLock),
    sourceSnapshotFingerprint: sha256Buffer(
      'runtime-fixture-source-snapshot-v1',
    ),
    buildFingerprint: sha256Buffer('runtime-fixture-build-v1'),
    runtimeClosureFingerprint: sha256Buffer('runtime-fixture-closure-v1'),
    runtimeClosureMode: 'verified-existing-production-tree',
    dependencyRuntimeAuditMode: 'fixture-production-runtime-audit',
    dependencyTreeMode: 'verified-existing-production-tree',
    activeClientAssetFingerprint: activeClientFingerprint(activeClientFiles),
    activeClientProofAlgorithm: 'sha256-active-client-closure-v2',
    activeClientChunkCount: 2,
    activeClientAssetCount: activeClientFiles.length,
    activeClientFiles,
    dependencyLockPhysicalTreeFingerprint:
      dependencyProof.lockPhysicalTreeFingerprint,
    dependencyInstalledPhysicalTreeFingerprint:
      dependencyProof.installedPhysicalTreeFingerprint,
    dependencyProofAlgorithm: dependencyProof.proofAlgorithm,
    dependencyPackageCount: dependencyProof.packageCount,
    dependencyFileCount: dependencyProof.fileCount,
    dependencyBytes: dependencyProof.bytes,
    dependencyTransition: 'none',
    baseFingerprint,
    baselineFingerprint: fingerprint(serverBaselineFiles),
    baselineExportSchemaVersion: 3,
    baselineExportType: 'server-hotfix-baseline-read-only',
    baselineExportPlanAlgorithm: 'webpack-main-runtime-map-v1',
    baselineExportPlanFingerprint: exportPlanFingerprint(serverBaselineFiles),
    baselineFileCount: serverBaselineFiles.length,
    baselinePayloadFileCount: serverBaselineFiles.length,
    baselineMetadataOnlyFileCount: 0,
    baselineUncompressedBytes: serverBaselineFiles.reduce(
      (sum, entry) => sum + entry.size,
      0,
    ),
    baseFiles,
    distFingerprints,
    serverBaselineFiles,
    runtimeRoots: ['dist/server', 'dist/shared', 'dist/client'],
    payloadFiles,
    releaseFiles,
    supportFiles,
    controlFiles,
    forbiddenPaths: [
      '.env',
      '.runtime',
      'nantong-schedule-state',
      'logs',
      'node_modules',
      'certs',
    ],
    healthEndpoint: endpoint,
  };
  writeText(
    join(packageRoot, 'hotfix-manifest.json'),
    JSON.stringify(manifest, null, 2),
  );

  return {
    root,
    appRoot,
    packageRoot,
    packageId,
    port,
    endpoint,
    oldMain,
    oldStart,
    legacyStartMarker,
    stageTargetPath,
    faultMarkerPath,
    dependencySentinelPath,
    recoveryPidMarker,
    recoveryNodeCapturePath,
    sentinels: [
      {
        path: join(appRoot, '.env'),
        content: 'OVERTIME_WORKFLOW_PROGRAM_ENABLED=false\r\n',
      },
      {
        path: join(appRoot, '.runtime', 'sentinel.txt'),
        content: 'runtime-sentinel\r\n',
      },
      {
        path: join(appRoot, 'logs', 'sentinel.txt'),
        content: 'logs-sentinel\r\n',
      },
      {
        path: dependencySentinelPath,
        content: dependencySentinelContent,
      },
    ],
  };
}

function installerEnvironment(
  overrides?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FEISHU_CARD_ACTION_CONSUMER_ENABLED: '',
    FEISHU_APP_ID: '',
    FEISHU_APP_SECRET: '',
    FEISHU_WAREHOUSE_APP_TOKEN: '',
    FEISHU_WAREHOUSE_SOURCE_URL: '',
    FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID: '',
    OVERTIME_WORKFLOW_PROGRAM_ENABLED: 'false',
    PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'false',
    PURCHASE_MANAGER_APPROVAL_CARD_ENABLED: 'false',
    ...overrides,
  };
}

function installerArguments(
  fixture: RuntimeFixture,
  healthTimeoutSeconds = 30,
): string[] {
  return [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(fixture.packageRoot, 'INSTALL-HOTFIX.ps1'),
    '-AppRoot',
    fixture.appRoot,
    '-HealthTimeoutSeconds',
    String(healthTimeoutSeconds),
    '-HealthEndpoint',
    fixture.endpoint,
  ];
}

function runInstaller(
  fixture: RuntimeFixture,
  environmentOverrides?: NodeJS.ProcessEnv,
  healthTimeoutSeconds = 30,
): InstallerResult {
  installerRunSequence += 1;
  const stdoutPath = join(
    fixture.root,
    `installer-${installerRunSequence}.out.log`,
  );
  const stderrPath = join(
    fixture.root,
    `installer-${installerRunSequence}.err.log`,
  );
  const stdoutHandle = openSync(stdoutPath, 'w');
  const stderrHandle = openSync(stderrPath, 'w');
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(
      'powershell.exe',
      installerArguments(fixture, healthTimeoutSeconds),
      {
        cwd: fixture.packageRoot,
        env: installerEnvironment({
          LOCALAPPDATA: join(fixture.root, 'localappdata'),
          ...environmentOverrides,
        }),
        stdio: ['ignore', stdoutHandle, stderrHandle],
        windowsHide: true,
        timeout: 120_000,
      },
    );
  } finally {
    closeSync(stdoutHandle);
    closeSync(stderrHandle);
  }
  trackAppPid(fixture.appRoot);
  return {
    status: result.status,
    stdout: readFileSync(stdoutPath, 'utf8'),
    stderr: readFileSync(stderrPath, 'utf8'),
  };
}

function runInstallerAsync(
  fixture: RuntimeFixture,
  environmentOverrides?: NodeJS.ProcessEnv,
): { child: ChildProcess; result: Promise<InstallerResult> } {
  installerRunSequence += 1;
  const stdoutPath = join(
    fixture.root,
    `installer-${installerRunSequence}.out.log`,
  );
  const stderrPath = join(
    fixture.root,
    `installer-${installerRunSequence}.err.log`,
  );
  const stdoutHandle = openSync(stdoutPath, 'w');
  const stderrHandle = openSync(stderrPath, 'w');
  let child: ChildProcess;
  try {
    child = spawn('powershell.exe', installerArguments(fixture), {
      cwd: fixture.packageRoot,
      env: installerEnvironment({
        LOCALAPPDATA: join(fixture.root, 'localappdata'),
        ...environmentOverrides,
      }),
      stdio: ['ignore', stdoutHandle, stderrHandle],
      windowsHide: true,
    });
  } finally {
    closeSync(stdoutHandle);
    closeSync(stderrHandle);
  }
  if (child.pid) {
    trackedPids.add(child.pid);
  }
  const result = new Promise<InstallerResult>((resolveResult, reject) => {
    const timeout = setTimeout(() => {
      if (child.pid) {
        terminatePid(child.pid);
      }
      reject(new Error('installer runtime test timed out'));
    }, 90_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timeout);
      trackAppPid(fixture.appRoot);
      resolveResult({
        status,
        stdout: readFileSync(stdoutPath, 'utf8'),
        stderr: readFileSync(stderrPath, 'utf8'),
      });
    });
  });
  return { child, result };
}

function replaceFixtureInstaller(
  fixture: RuntimeFixture,
  installerSource: string,
): void {
  const installerPath = join(fixture.packageRoot, 'INSTALL-HOTFIX.ps1');
  writeText(installerPath, installerSource);
  const manifestPath = join(fixture.packageRoot, 'hotfix-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    installerSha256: string;
    controlFiles: FileEntry[];
  };
  const installerEntries = manifest.controlFiles.filter(
    (entry) => entry.path === 'INSTALL-HOTFIX.ps1',
  );
  if (installerEntries.length !== 1) {
    throw new Error(
      'fixture manifest must contain one installer control entry',
    );
  }
  installerEntries[0].size = statSync(installerPath).size;
  installerEntries[0].sha256 = sha256File(installerPath);
  manifest.installerSha256 = installerEntries[0].sha256;
  writeText(manifestPath, JSON.stringify(manifest, null, 2));
}

function retargetFixturePackage(
  fixture: RuntimeFixture,
  packageId: string,
): void {
  const manifestPath = join(fixture.packageRoot, 'hotfix-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    packageId: string;
  };
  manifest.packageId = packageId;
  writeText(manifestPath, JSON.stringify(manifest, null, 2));
  fixture.packageId = packageId;
}

function replaceFixtureReleaseFile(
  fixture: RuntimeFixture,
  targetPath: string,
  content: string,
): void {
  const packagePath = join(
    fixture.packageRoot,
    'release-root',
    ...targetPath.split('/'),
  );
  writeText(packagePath, content);
  const manifestPath = join(fixture.packageRoot, 'hotfix-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    releaseFiles: Array<FileEntry & { targetPath: string }>;
  };
  const matchingEntries = manifest.releaseFiles.filter(
    (entry) => entry.targetPath === targetPath,
  );
  if (matchingEntries.length !== 1) {
    throw new Error(
      `fixture release file is not uniquely managed: ${targetPath}`,
    );
  }
  matchingEntries[0].size = statSync(packagePath).size;
  matchingEntries[0].sha256 = sha256File(packagePath);
  writeText(manifestPath, JSON.stringify(manifest, null, 2));
}

function replaceFixturePayloadFile(
  fixture: RuntimeFixture,
  relativePath: string,
  content: string,
): void {
  const packagePath = join(fixture.packageRoot, ...relativePath.split('/'));
  writeText(packagePath, content);
  const manifestPath = join(fixture.packageRoot, 'hotfix-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    payloadFiles: FileEntry[];
  };
  const matchingEntries = manifest.payloadFiles.filter(
    (entry) => entry.path === relativePath,
  );
  if (matchingEntries.length !== 1) {
    throw new Error(
      `fixture payload file is not uniquely managed: ${relativePath}`,
    );
  }
  matchingEntries[0].size = statSync(packagePath).size;
  matchingEntries[0].sha256 = sha256File(packagePath);
  writeText(manifestPath, JSON.stringify(manifest, null, 2));
}

function snapshotDirectory(root: string): Map<string, Buffer> {
  return new Map(
    walkFiles(root).map((filePath) => [
      relative(root, filePath).replaceAll('\\', '/'),
      readFileSync(filePath),
    ]),
  );
}

function refreshFixtureBaselineFile(
  fixture: RuntimeFixture,
  relativePath: string,
  content: string,
): void {
  const targetPath = join(fixture.appRoot, ...relativePath.split('/'));
  writeText(targetPath, content);
  const manifestPath = join(fixture.packageRoot, 'hotfix-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    baseFingerprint: string;
    baselineFingerprint: string;
    baselineExportPlanFingerprint: string;
    baselineUncompressedBytes: number;
    baseFiles: FileEntry[];
    serverBaselineFiles: FileEntry[];
    releaseFiles: Array<
      FileEntry & {
        targetPath: string;
        baselineExisted: boolean;
        baselineSha256: string;
      }
    >;
  };
  const nextEntry = entryFor(fixture.appRoot, targetPath);
  const baselineEntry = manifest.serverBaselineFiles.find(
    (entry) => entry.path === relativePath,
  );
  const baseEntry = manifest.baseFiles.find(
    (entry) => entry.path === relativePath,
  );
  const releaseEntry = manifest.releaseFiles.find(
    (entry) => entry.targetPath === relativePath,
  );
  if (!baselineEntry || !releaseEntry) {
    throw new Error(`fixture baseline does not manage ${relativePath}`);
  }
  baselineEntry.size = nextEntry.size;
  baselineEntry.sha256 = nextEntry.sha256;
  if (baseEntry) {
    baseEntry.size = nextEntry.size;
    baseEntry.sha256 = nextEntry.sha256;
  }
  releaseEntry.baselineExisted = true;
  releaseEntry.baselineSha256 = nextEntry.sha256;
  manifest.baseFingerprint = sha256Buffer(
    manifest.baseFiles
      .map((entry) => `${entry.path}:${entry.sha256}`)
      .join('\n'),
  );
  manifest.baselineFingerprint = fingerprint(manifest.serverBaselineFiles);
  manifest.baselineExportPlanFingerprint = exportPlanFingerprint(
    manifest.serverBaselineFiles,
  );
  manifest.baselineUncompressedBytes = manifest.serverBaselineFiles.reduce(
    (sum, entry) => sum + entry.size,
    0,
  );
  writeText(manifestPath, JSON.stringify(manifest, null, 2));
}

function forceKillPidOnly(pid: number): void {
  spawnSync('taskkill.exe', ['/PID', String(pid), '/F'], {
    windowsHide: true,
    stdio: 'ignore',
  });
}

async function killInstallerAtDurableBoundary(
  fixture: RuntimeFixture,
  phase:
    | 'after-stage-intent-written'
    | 'after-commit-written'
    | 'after-installed-release-receipt-written',
): Promise<InstallerResult> {
  const reachedPath = `${fixture.faultMarkerPath}.${phase}.reached`;
  const running = runInstallerAsync(fixture, {
    NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
    NANTONG_HOTFIX_TEST_PAUSE_PHASE: phase,
  });

  try {
    await waitForFile(reachedPath, 45_000);
    await waitForVersion(
      fixture.endpoint,
      phase === 'after-stage-intent-written' ? 'old' : 'candidate',
    );
  } catch (error) {
    if (running.child.pid) {
      forceKillPidOnly(running.child.pid);
    }
    await running.result.catch(() => undefined);
    throw error;
  }
  if (!running.child.pid) {
    throw new Error('installer process did not expose a pid');
  }
  forceKillPidOnly(running.child.pid);
  const killed = await running.result;
  expect(killed.status).not.toBe(0);
  return killed;
}

function expectSentinelsUnchanged(fixture: RuntimeFixture): void {
  for (const sentinel of fixture.sentinels) {
    expect(readFileSync(sentinel.path, 'utf8')).toBe(sentinel.content);
  }
}

function expectMaintenanceReleased(
  fixture: RuntimeFixture,
  result: InstallerResult,
): void {
  const maintenancePath = join(fixture.appRoot, '.maintenance.lock');
  if (!existsSync(maintenancePath)) {
    return;
  }
  const journalPath = join(fixture.appRoot, '.hotfix-transaction.json');
  throw new Error(
    [
      'maintenance owner remained after installer exit',
      `owner=${readFileSync(maintenancePath, 'utf8')}`,
      `journal=${existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '<missing>'}`,
      `stdout=${result.stdout}`,
      `stderr=${result.stderr}`,
    ].join('\n'),
  );
}

function terminalTransactionPayload(
  fixture: RuntimeFixture,
  deploymentId: string,
  phase: 'finalized' | 'rolled-back' | 'committed' = 'finalized',
): Record<string, unknown> {
  const payload = {
    schemaVersion: 1,
    transactionId: '11111111-1111-4111-8111-111111111111',
    deploymentId,
    appRoot: fixture.appRoot,
    intent: 'deploy',
    phase,
    releaseFiles: [],
  };
  return {
    ...payload,
    transactionChecksum: sha256Buffer(JSON.stringify(payload)),
  };
}

function terminalDeploymentArtifactPaths(
  appRoot: string,
  deploymentId: string,
): string[] {
  return [
    join(appRoot, '.hotfix-stage', deploymentId),
    join(appRoot, `dist.rollback.${deploymentId}`),
    join(appRoot, `dist.failed.${deploymentId}`),
    join(appRoot, `.hotfix-root-rollback.${deploymentId}`),
    join(appRoot, `.hotfix-root-failed.${deploymentId}`),
  ];
}

function expectTerminalDeploymentArtifactsRemoved(
  appRoot: string,
  deploymentId: string,
): void {
  for (const artifactPath of terminalDeploymentArtifactPaths(
    appRoot,
    deploymentId,
  )) {
    expect(existsSync(artifactPath)).toBe(false);
  }
}

function getProcessStartTimeIso(pid: number): string {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`failed to query process start time: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function startCurrentRuntime(
  fixture: RuntimeFixture,
  pidMode: 'json' | 'legacy-valid' | 'legacy-stale' = 'json',
): Promise<number> {
  const bootstrapPath = fixture.legacyStartMarker
    ? join(fixture.appRoot, '.fixture-bootstrap-start.ps1')
    : undefined;
  const startPath = bootstrapPath ?? join(fixture.appRoot, 'start.ps1');
  if (bootstrapPath) {
    writeText(bootstrapPath, createStartScript(fixture.port, 0), true);
  }
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      startPath,
      '-NoBrowser',
    ],
    {
      cwd: fixture.appRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    },
  );
  if (bootstrapPath) {
    rmSync(bootstrapPath, { force: true });
  }
  if (result.status !== 0) {
    throw new Error(`fixture runtime failed to start: ${result.stderr}`);
  }
  const record = readPidRecord(fixture.appRoot)!;
  const pid = Number(record.pid);
  trackedPids.add(pid);
  if (pidMode !== 'json') {
    const pidPath = join(fixture.appRoot, 'app.pid');
    writeText(pidPath, String(pid));
    const startTime = new Date(String(record.startTime));
    const timestamp =
      pidMode === 'legacy-valid'
        ? startTime
        : new Date(startTime.getTime() + 60_000);
    utimesSync(pidPath, timestamp, timestamp);
  }
  await waitForVersion(fixture.endpoint, 'old');
  return pid;
}

async function startLegacyRelativeCurrentRuntime(
  fixture: RuntimeFixture,
): Promise<number> {
  const current = spawn(
    process.execPath,
    ['dist/server/main.js', String(fixture.port)],
    {
      cwd: fixture.appRoot,
      windowsHide: true,
      stdio: 'ignore',
    },
  );
  if (!current.pid) {
    throw new Error('legacy relative runtime fixture did not start');
  }
  trackedPids.add(current.pid);
  const startTime = new Date(getProcessStartTimeIso(current.pid));
  const pidPath = join(fixture.appRoot, 'app.pid');
  writeText(pidPath, String(current.pid));
  utimesSync(pidPath, startTime, startTime);
  await waitForVersion(fixture.endpoint, 'old');
  return current.pid;
}

async function holdLifecycleLock(
  fixture: RuntimeFixture,
): Promise<ChildProcess> {
  const lockPath = join(fixture.appRoot, '.app-lifecycle.lock');
  const markerPath = `${lockPath}.held`;
  const holder = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      [
        `$stream=[System.IO.File]::Open('${quotePowerShell(lockPath)}',[System.IO.FileMode]::OpenOrCreate,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)`,
        `Set-Content -LiteralPath '${quotePowerShell(markerPath)}' -Value held -Encoding UTF8`,
        'try { Start-Sleep -Seconds 60 } finally { $stream.Dispose() }',
      ].join('; '),
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  if (holder.pid) {
    trackedPids.add(holder.pid);
  }
  await waitForFile(markerPath);
  return holder;
}

async function holdRuntimeDirectory(fixture: RuntimeFixture): Promise<ChildProcess> {
  const markerPath = join(fixture.root, 'dist-handle-held');
  const source = [
    'using System;', 'using System.Runtime.InteropServices;',
    'using Microsoft.Win32.SafeHandles;',
    'public static class FixtureDirectoryHandle {',
    '[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
    'public static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);',
    '}',
  ].join('\n');
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command', [
    "$ErrorActionPreference='Stop'",
    `Add-Type -TypeDefinition '${quotePowerShell(source)}'`,
    `$handle=[FixtureDirectoryHandle]::CreateFile('${quotePowerShell(join(fixture.appRoot, 'dist'))}',2147483648,3,[IntPtr]::Zero,3,0x02000000,[IntPtr]::Zero)`,
    "if($handle.IsInvalid){throw 'Cannot acquire fixture directory handle'}",
    `Set-Content -LiteralPath '${quotePowerShell(markerPath)}' -Value held`,
    'try { Start-Sleep -Seconds 120 } finally { $handle.Dispose() }',
  ].join('; ')], { windowsHide: true, stdio: 'ignore' });
  if (holder.pid) trackedPids.add(holder.pid);
  await waitForFile(markerPath);
  return holder;
}

afterEach(() => {
  for (const root of fixtureRoots) {
    trackAppPid(join(root, 'app'));
  }
  for (const pid of [...trackedPids].reverse()) {
    terminatePid(pid);
  }
  trackedPids.clear();
  for (const root of fixtureRoots.splice(0).reverse()) {
    try {
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 50,
      });
    } catch {
      const escapedRoot = quotePowerShell(resolve(root));
      spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `$rootPath='${escapedRoot}'; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $PID -and ([string]$_.CommandLine).IndexOf($rootPath,[System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
        ],
        { windowsHide: true, stdio: 'ignore', timeout: 15_000 },
      );
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  }
});

describeWindows('safe full runtime hotfix installer runtime safety', () => {
  it('finishes commit after a transient native journal read handle denies atomic replacement', async () => {
    const fixture = await createFixture();
    await startCurrentRuntime(fixture);
    const phase = 'after-candidate-healthy';
    const running = runInstallerAsync(fixture, {
      NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
      NANTONG_HOTFIX_TEST_PAUSE_PHASE: phase,
    });
    await waitForFile(`${fixture.faultMarkerPath}.${phase}.reached`, 45_000);
    const held = join(fixture.root, 'journal-read-held');
    const holder = spawn('powershell.exe', ['-NoProfile', '-Command', [
      "$ErrorActionPreference='Stop'",
      `$stream=[IO.File]::Open('${quotePowerShell(join(fixture.appRoot, '.hotfix-transaction.json'))}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)`,
      `try { [IO.File]::WriteAllText('${quotePowerShell(held)}','held'); Start-Sleep -Milliseconds 1000 } finally { $stream.Dispose() }`,
    ].join('; ')], { windowsHide: true, stdio: 'ignore' });
    if (holder.pid) trackedPids.add(holder.pid);
    await waitForFile(held);
    writeText(`${fixture.faultMarkerPath}.${phase}.continue`, 'continue');
    const result = await running.result;
    if (result.status !== 0) throw new Error(`journal contention install failed:\n${result.stdout}\n${result.stderr}`);
    expect(result.stdout).toMatch(/transaction journal replacement recovered after/);
    expect(result.stdout).toContain('Hotfix installed and healthy');
    expect(JSON.parse(readFileSync(join(fixture.appRoot, '.hotfix-transaction.json'), 'utf8')).phase).toBe('finalized');
    await waitForVersion(fixture.endpoint, 'candidate');
    expectSentinelsUnchanged(fixture);
    expectMaintenanceReleased(fixture, result);
  });

  it('rejects a non-delete-sharing dist handle before stopping the healthy old runtime', async () => {
    const redInstaller = process.env.NANTONG_DIRECTORY_PROBE_RED_INSTALLER;
    const fixture = await createFixture({
      installerSource: redInstaller ? readFileSync(redInstaller, 'utf8') : undefined,
    });
    const originalStart = readFileSync(join(fixture.appRoot, 'start.ps1'));
    const oldPid = await startCurrentRuntime(fixture);
    await holdRuntimeDirectory(fixture);
    const result = runInstaller(fixture);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain('Runtime directory rename preflight failed before downtime');
    expect(output).not.toContain('Current runtime stopped in');
    expect(isProcessAlive(oldPid)).toBe(true);
    expect(readFileSync(join(fixture.appRoot, 'start.ps1'))).toEqual(originalStart);
    await waitForVersion(fixture.endpoint, 'old');
    expectMaintenanceReleased(fixture, result);
  });

  it('recovers the exact old runtime using the real recovery launcher when dist becomes locked after stopping', async () => {
    const fixture = await createFixture({ actualRecoveryLauncher: true });
    const originalStart = readFileSync(join(fixture.appRoot, 'start.ps1'));
    const oldPid = await startCurrentRuntime(fixture);
    const running = runInstallerAsync(fixture, {
      SERVER_PORT: String(fixture.port),
      NANTONG_HOTFIX_TEST_PAUSE_PHASE: 'after-runtime-stopped',
      NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
    });
    await waitForFile(`${fixture.faultMarkerPath}.after-runtime-stopped.reached`, 60_000);
    await holdRuntimeDirectory(fixture);
    writeText(`${fixture.faultMarkerPath}.after-runtime-stopped.continue`, 'continue');
    const result = await running.result;
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/previous runtime was restored and\s+passed its health check/);
    expect(isProcessAlive(oldPid)).toBe(false);
    expect(readFileSync(join(fixture.appRoot, 'dist', 'server', 'main.js'), 'utf8')).toBe(fixture.oldMain);
    expect(readFileSync(join(fixture.appRoot, 'start.ps1'))).toEqual(originalStart);
    await waitForVersion(fixture.endpoint, 'old');
    expectMaintenanceReleased(fixture, result);
  });

  const formalInstallerPath = process.env.NANTONG_FORMAL_HOTFIX_INSTALLER_PATH;
  (formalInstallerPath ? it : it.skip)(
    'cold-starts the exact formal package installer with production callback health enabled',
    async () => {
      const installerSource = readFileSync(formalInstallerPath!, 'utf8');
      const fixture = await createFixture({
        installerSource,
        rejectSmokeMode: true,
      });
      await startCurrentRuntime(fixture);

      const result = runInstaller(fixture, {
        FEISHU_CARD_ACTION_CONSUMER_ENABLED: 'true',
        PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'true',
      });

      if (result.status !== 0) {
        throw new Error(
          `formal installer cold start failed:\n${result.stdout}\n${result.stderr}`,
        );
      }
      await waitForVersion(fixture.endpoint, 'candidate');
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'Hotfix installed and healthy',
      );
      expectMaintenanceReleased(fixture, result);
    },
  );

  it('starts both candidate and recovery-capable launchers in production mode when callback health is required', async () => {
    const fixture = await createFixture({ rejectSmokeMode: true });
    await startCurrentRuntime(fixture);

    const result = runInstaller(fixture, {
      FEISHU_CARD_ACTION_CONSUMER_ENABLED: 'true',
      PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'true',
    });

    if (result.status !== 0) {
      throw new Error(
        `production-mode callback deployment failed:\n${result.stdout}\n${result.stderr}`,
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
      /callback health contract did not pass|launcher exited with code 41/i,
    );
    expectMaintenanceReleased(fixture, result);
  });

  it('recovers a non-terminal transaction left by the forced-smoke installer and completes the same deployment id', async () => {
    const fixture = await createFixture({ rejectSmokeMode: true });
    const installerPath = join(fixture.packageRoot, 'INSTALL-HOTFIX.ps1');
    const fixedInstaller = readFileSync(installerPath, 'utf8');
    const brokenInstaller = fixedInstaller.replace(
      "[void]$startInfo.EnvironmentVariables.Remove('NANTONG_HOTFIX_SMOKE_MODE')",
      "$startInfo.EnvironmentVariables['NANTONG_HOTFIX_SMOKE_MODE'] = 'true'",
    );
    expect(brokenInstaller).not.toBe(fixedInstaller);
    replaceFixtureInstaller(fixture, brokenInstaller);
    await startCurrentRuntime(fixture);

    const failed = runInstaller(fixture, undefined, 3);

    expect(failed.status).not.toBe(0);
    expect(
      JSON.parse(
        readFileSync(join(fixture.appRoot, '.hotfix-transaction.json'), 'utf8'),
      ),
    ).toMatchObject({
      deploymentId: fixture.packageId,
      phase: 'candidate-started',
    });
    expect(
      readFileSync(join(fixture.appRoot, 'dist', 'server', 'main.js'), 'utf8'),
    ).toBe(fixture.oldMain);

    replaceFixtureInstaller(fixture, fixedInstaller);
    const recovered = runInstaller(fixture);

    if (recovered.status !== 0) {
      throw new Error(
        `same-id failed transaction recovery did not complete:\n${recovered.stdout}\n${recovered.stderr}`,
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');
    expect(
      JSON.parse(
        readFileSync(join(fixture.appRoot, '.hotfix-transaction.json'), 'utf8'),
      ),
    ).toMatchObject({
      deploymentId: fixture.packageId,
      phase: 'finalized',
    });
    expectMaintenanceReleased(fixture, recovered);
  });

  it('atomically removes every unreferenced historical client chunk during a full runtime install', async () => {
    const fixture = await createFixture();
    const staleChunks = [
      join(fixture.appRoot, 'dist', 'client', 'chunks', '1081.0a1c9365.js'),
      join(fixture.appRoot, 'dist', 'client', 'chunks', '115.1234abcd.js'),
      join(
        fixture.appRoot,
        'dist',
        'client',
        'chunks',
        'async-vendors.006dbfb8.js',
      ),
      join(
        fixture.appRoot,
        'dist',
        'client',
        'chunks',
        'async-vendors.006dbfb8.js.map',
      ),
      join(fixture.appRoot, 'dist', 'client', 'src', 'app.tsx'),
    ];
    for (const [index, staleChunk] of staleChunks.entries()) {
      writeText(staleChunk, `unreferenced historical chunk ${index}\r\n`);
    }
    await startCurrentRuntime(fixture);

    const result = runInstaller(fixture);

    if (result.status !== 0) {
      throw new Error(
        `installer rejected historical client cleanup candidates:\n${result.stdout}\n${result.stderr}`,
      );
    }
    expect(result.stdout).toContain(
      'Previous client generations will be replaced as one directory',
    );
    expect(result.stdout).toContain('Finalized runtime cleanup removed');
    await waitForVersion(fixture.endpoint, 'candidate');
    for (const staleChunk of staleChunks) {
      expect(existsSync(staleChunk)).toBe(false);
    }
    expectSentinelsUnchanged(fixture);
    expectMaintenanceReleased(fixture, result);
  });

  it('removes the known obsolete certificate scheduler declaration during a full runtime install', async () => {
    const fixture = await createFixture();
    const obsoleteSchedulerPath = join(
      fixture.appRoot,
      'dist',
      'server',
      'modules',
      'bitable-sync',
      'certificate-dashboard.scheduler.d.ts',
    );
    writeKnownObsoleteCertificateSchedulerDeclaration(obsoleteSchedulerPath);
    await startCurrentRuntime(fixture);

    const result = runInstaller(fixture);

    if (result.status !== 0) {
      throw new Error(
        `installer rejected the known obsolete declaration:\n${result.stdout}\n${result.stderr}`,
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');
    expect(existsSync(obsoleteSchedulerPath)).toBe(false);
    expectSentinelsUnchanged(fixture);
    expectMaintenanceReleased(fixture, result);
  });

  it('installs from a proven JSON pid and only succeeds after the candidate launcher exits zero', async () => {
    const fixture = await createFixture();
    const oldPid = await startCurrentRuntime(fixture);

    const result = runInstaller(fixture);

    if (process.env.NANTONG_HOTFIX_TEST_TRACE === '1') {
      // Opt-in diagnostics keep ordinary test output quiet while exposing installer phase timings.
      console.error(`${result.stdout}\n${result.stderr}`);
    }

    if (result.status !== 0) {
      const pidRecord = readPidRecord(fixture.appRoot);
      const startOut = join(
        fixture.appRoot,
        'logs',
        'hotfix-installer-start.out.log',
      );
      const startErr = join(
        fixture.appRoot,
        'logs',
        'hotfix-installer-start.err.log',
      );
      throw new Error(
        `installer failed:\n${result.stdout}\n${result.stderr}\npid=${JSON.stringify(pidRecord)}\nout=${existsSync(startOut) ? readFileSync(startOut, 'utf8') : '<missing>'}\nerr=${existsSync(startErr) ? readFileSync(startErr, 'utf8') : '<missing>'}`,
      );
    }
    expect(result).toMatchObject({ status: 0 });
    expect(result.stdout).toContain('Hotfix installed and healthy');
    expect(
      readFileSync(join(fixture.appRoot, 'dist', 'server', 'main.js'), 'utf8'),
    ).toContain("version = 'candidate'");
    const newRecord = readPidRecord(fixture.appRoot)!;
    await waitForVersion(fixture.endpoint, 'candidate');
    const candidateVersion = await requestVersion(fixture.endpoint);
    expect(candidateVersion).toBe('candidate');
    expect(newRecord).toMatchObject({
      schemaVersion: 1,
      appRoot: fixture.appRoot,
      mainFile: join(fixture.appRoot, 'dist', 'server', 'main.js'),
    });
    expect(Number(newRecord.pid)).not.toBe(oldPid);
    expect(isProcessAlive(oldPid)).toBe(false);
    expectTerminalDeploymentArtifactsRemoved(
      fixture.appRoot,
      fixture.packageId,
    );
    expect(
      JSON.parse(
        readFileSync(join(fixture.appRoot, '.hotfix-transaction.json'), 'utf8'),
      ),
    ).toMatchObject({
      deploymentId: fixture.packageId,
      phase: 'finalized',
    });
    expectMaintenanceReleased(fixture, result);
  });

  it('installs and starts the candidate when the proven baseline runtime is already stopped', async () => {
    const fixture = await createFixture();
    const startedAt = Date.now();

    const result = runInstaller(fixture);

    if (result.status !== 0) {
      throw new Error(
        `installer rejected a stopped proven baseline:\n${result.stdout}\n${result.stderr}`,
      );
    }
    expect(Date.now() - startedAt).toBeLessThan(45_000);
    expect(result.stdout).toContain(
      'Current runtime was already stopped; proceeding with the verified baseline',
    );
    await waitForVersion(fixture.endpoint, 'candidate');
    expect(readPidRecord(fixture.appRoot)).toMatchObject({ schemaVersion: 1 });
    expectTerminalDeploymentArtifactsRemoved(
      fixture.appRoot,
      fixture.packageId,
    );
    expectMaintenanceReleased(fixture, result);
  });

  it('refuses a stopped baseline when the configured health port belongs to another process', async () => {
    const fixture = await createFixture();
    const blockerPath = join(fixture.root, 'unrelated-port-owner.js');
    writeText(blockerPath, createMainScript('old'));
    const blocker = spawn(
      process.execPath,
      [blockerPath, String(fixture.port)],
      {
        cwd: fixture.root,
        windowsHide: true,
        stdio: 'ignore',
      },
    );
    if (!blocker.pid) {
      throw new Error('unrelated port owner did not start');
    }
    trackedPids.add(blocker.pid);
    await waitForVersion(fixture.endpoint, 'old');

    const result = runInstaller(fixture, undefined, 3);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'application health port is still listening after stop',
    );
    expect(isProcessAlive(blocker.pid)).toBe(true);
    expect(
      readFileSync(join(fixture.appRoot, 'dist', 'server', 'main.js'), 'utf8'),
    ).toBe(fixture.oldMain);
    expectMaintenanceReleased(fixture, result);
  });

  it('cleans a different finalized deployment after proving the current baseline, then installs the next package', async () => {
    const fixture = await createFixture();
    const previousDeploymentId = 'runtime-test-previous-finalized';
    for (const artifactPath of terminalDeploymentArtifactPaths(
      fixture.appRoot,
      previousDeploymentId,
    )) {
      writeText(
        join(artifactPath, 'sentinel.txt'),
        'previous finalized artifact\r\n',
      );
    }
    writeText(
      join(fixture.appRoot, '.hotfix-transaction.json'),
      JSON.stringify(terminalTransactionPayload(fixture, previousDeploymentId)),
    );
    await startCurrentRuntime(fixture);

    const result = runInstaller(fixture);

    if (result.status !== 0) {
      throw new Error(
        `installer rejected a proven prior finalized deployment:\n${result.stdout}\n${result.stderr}`,
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');
    expectTerminalDeploymentArtifactsRemoved(
      fixture.appRoot,
      previousDeploymentId,
    );
    expectTerminalDeploymentArtifactsRemoved(
      fixture.appRoot,
      fixture.packageId,
    );
    expect(
      JSON.parse(
        readFileSync(join(fixture.appRoot, '.hotfix-transaction.json'), 'utf8'),
      ),
    ).toMatchObject({
      deploymentId: fixture.packageId,
      phase: 'finalized',
    });
    expectSentinelsUnchanged(fixture);
    expectMaintenanceReleased(fixture, result);
  });

  it('rejects dependency tree drift before stopping the healthy runtime', async () => {
    const fixture = await createFixture();
    const runningPid = await startCurrentRuntime(fixture);
    const runtimeBefore = snapshotDirectory(join(fixture.appRoot, 'dist'));
    const startBefore = readFileSync(join(fixture.appRoot, 'start.ps1'));
    const receiptPath = join(fixture.appRoot, '.hotfix-installed-release.json');
    writeText(fixture.dependencySentinelPath, 'tampered dependency proof\r\n');

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'fixture dependency sentinel hash mismatch',
    );
    expect(isProcessAlive(runningPid)).toBe(true);
    await waitForVersion(fixture.endpoint, 'old');
    expect(snapshotDirectory(join(fixture.appRoot, 'dist'))).toEqual(
      runtimeBefore,
    );
    expect(readFileSync(join(fixture.appRoot, 'start.ps1'))).toEqual(
      startBefore,
    );
    expect(existsSync(join(fixture.appRoot, '.candidate-listening'))).toBe(
      false,
    );
    expect(existsSync(receiptPath)).toBe(false);
    expect(existsSync(fixture.stageTargetPath)).toBe(false);
    expectMaintenanceReleased(fixture, result);
  });

  it('rejects invalid candidate startup configuration before stopping the healthy runtime', async () => {
    const fixture = await createFixture({
      candidateConfigurationPreflightExitCode: 23,
    });
    await startCurrentRuntime(fixture);
    const oldPid = Number(readPidRecord(fixture.appRoot)?.pid);

    const result = runInstaller(fixture);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain(
      'Candidate startup configuration preflight failed before downtime',
    );
    expect(output).toContain('fixture purchase configuration is invalid');
    expect(isProcessAlive(oldPid)).toBe(true);
    await waitForVersion(fixture.endpoint, 'old');
    expect(
      readFileSync(join(fixture.appRoot, 'dist', 'server', 'main.js'), 'utf8'),
    ).toBe(fixture.oldMain);
    expectMaintenanceReleased(fixture, result);
  });

  it('installs the candidate after its startup configuration preflight succeeds', async () => {
    const fixture = await createFixture({
      candidateConfigurationPreflightExitCode: 0,
    });
    await startCurrentRuntime(fixture);

    const result = runInstaller(fixture);
    const output = `${result.stdout}\n${result.stderr}`;

    if (result.status !== 0) {
      throw new Error(
        `installer failed during dependency proof reuse:\n${output}`,
      );
    }
    expect(result.status).toBe(0);
    expect(output).toContain('fixture purchase configuration is valid');
    expect(output).toContain(
      'Candidate startup configuration preflight passed before downtime',
    );
    expect(output).toContain('Reused the held production dependency proof');
    expect(
      readFileSync(
        join(fixture.appRoot, '.fixture-dependency-verifier-invocations'),
        'utf8',
      )
        .trim()
        .split(/\r?\n/),
    ).toHaveLength(1);
    await waitForVersion(fixture.endpoint, 'candidate');
    expectMaintenanceReleased(fixture, result);
  });

  it('falls back to a complete dependency scan when a held package anchor changes', async () => {
    const fixture = await createFixture({
      candidateConfigurationPreflightExitCode: 0,
      mutateDependencyAfterCandidateStart: true,
    });
    await startCurrentRuntime(fixture);

    const result = runInstaller(fixture);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain(
      'Dependency quick proof changed; falling back to one complete physical-tree verification.',
    );
    expect(output).toContain('fixture dependency sentinel hash mismatch');
    expect(
      readFileSync(
        join(fixture.appRoot, '.fixture-dependency-verifier-invocations'),
        'utf8',
      )
        .trim()
        .split(/\r?\n/),
    ).toHaveLength(2);
    await waitForVersion(fixture.endpoint, 'old');
    expectMaintenanceReleased(fixture, result);
  });

  it('writes the complete active client closure and counts into the installed-release receipt', async () => {
    const fixture = await createFixture({ fillerCount: 3 });
    await startCurrentRuntime(fixture);
    const manifest = JSON.parse(
      readFileSync(join(fixture.packageRoot, 'hotfix-manifest.json'), 'utf8'),
    ) as {
      activeClientAssetCount: number;
      activeClientChunkCount: number;
      activeClientAssetFingerprint: string;
      activeClientProofAlgorithm: string;
      activeClientFiles: FileEntry[];
    };

    const result = runInstaller(fixture);

    if (result.status !== 0) {
      throw new Error(
        `installer failed before writing its complete receipt:\n${result.stdout}\n${result.stderr}`,
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');
    const receipt = JSON.parse(
      readFileSync(
        join(fixture.appRoot, '.hotfix-installed-release.json'),
        'utf8',
      ),
    ) as {
      schemaVersion: number;
      activeClientAssetFingerprint: string;
      activeClientProofAlgorithm: string;
      activeClientAssetCount: number;
      activeClientChunkCount: number;
      activeClientFiles: FileEntry[];
    };

    expect(receipt.schemaVersion).toBe(2);
    expect(receipt.activeClientProofAlgorithm).toBe(
      manifest.activeClientProofAlgorithm,
    );
    expect(receipt.activeClientAssetCount).toBe(
      manifest.activeClientAssetCount,
    );
    expect(receipt.activeClientChunkCount).toBe(
      manifest.activeClientChunkCount,
    );
    expect(receipt.activeClientFiles).toHaveLength(
      receipt.activeClientAssetCount,
    );
    expect(
      receipt.activeClientFiles.filter((entry) =>
        entry.path.startsWith('dist/client/chunks/'),
      ),
    ).toHaveLength(receipt.activeClientChunkCount);
    expect(sortEntries(receipt.activeClientFiles)).toEqual(
      sortEntries(manifest.activeClientFiles),
    );
    expect(activeClientFingerprint(receipt.activeClientFiles)).toBe(
      receipt.activeClientAssetFingerprint,
    );
    expect(receipt.activeClientAssetFingerprint).toBe(
      manifest.activeClientAssetFingerprint,
    );
    expect(
      receipt.activeClientFiles.some((entry) =>
        entry.path.includes('/filler-'),
      ),
    ).toBe(false);
    for (const entry of receipt.activeClientFiles) {
      const installedPath = join(fixture.appRoot, ...entry.path.split('/'));
      expect(statSync(installedPath).size).toBe(entry.size);
      expect(sha256File(installedPath)).toBe(entry.sha256);
    }
    expectMaintenanceReleased(fixture, result);
  });

  it('installs the next successful generation from its durable installed-release receipt without exporting a new baseline', async () => {
    const fixture = await createFixture();

    const firstResult = runInstaller(fixture);
    if (firstResult.status !== 0) {
      throw new Error(
        `first-generation installer failed:\n${firstResult.stdout}\n${firstResult.stderr}`,
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');

    const firstPackageId = fixture.packageId;
    const nextPackageId = `${firstPackageId}-next`;
    retargetFixturePackage(fixture, nextPackageId);

    const secondResult = runInstaller(fixture);
    if (secondResult.status !== 0) {
      throw new Error(
        `second-generation installer required a new baseline:\n${secondResult.stdout}\n${secondResult.stderr}`,
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');

    const receipt = JSON.parse(
      readFileSync(
        join(fixture.appRoot, '.hotfix-installed-release.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      deploymentId: nextPackageId,
      schemaVersion: 2,
    });
    expect(`${secondResult.stdout}\n${secondResult.stderr}`).toMatch(
      /installed-release receipt/i,
    );
    expectTerminalDeploymentArtifactsRemoved(fixture.appRoot, firstPackageId);
    expectMaintenanceReleased(fixture, secondResult);
  });

  it('installs the next generation from the durable receipt even when the finalized journal is absent', async () => {
    const fixture = await createFixture();

    const firstResult = runInstaller(fixture);
    expect(firstResult.status).toBe(0);
    await waitForVersion(fixture.endpoint, 'candidate');

    const journalPath = join(fixture.appRoot, '.hotfix-transaction.json');
    rmSync(journalPath, { force: true });
    const nextPackageId = `${fixture.packageId}-receipt-only`;
    retargetFixturePackage(fixture, nextPackageId);

    const secondResult = runInstaller(fixture);

    if (secondResult.status !== 0) {
      throw new Error(
        `receipt-only generation install failed:\n${secondResult.stdout}\n${secondResult.stderr}`,
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');
    expect(
      JSON.parse(
        readFileSync(
          join(fixture.appRoot, '.hotfix-installed-release.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ deploymentId: nextPackageId, schemaVersion: 2 });
    expect(`${secondResult.stdout}\n${secondResult.stderr}`).toMatch(
      /adopted installed-release receipt/i,
    );
    expectMaintenanceReleased(fixture, secondResult);
  });

  it('rejects strict runtime drift against the installed-release receipt before stopping the healthy runtime', async () => {
    const fixture = await createFixture();
    const firstResult = runInstaller(fixture);
    expect(firstResult.status).toBe(0);
    await waitForVersion(fixture.endpoint, 'candidate');

    const receiptPath = join(fixture.appRoot, '.hotfix-installed-release.json');
    const journalPath = join(fixture.appRoot, '.hotfix-transaction.json');
    const receiptBefore = readFileSync(receiptPath);
    const journalBefore = readFileSync(journalPath);
    const runningPid = Number(readPidRecord(fixture.appRoot)?.pid);
    writeText(
      join(fixture.appRoot, 'dist', 'shared', 'shared.js'),
      "module.exports = 'unmanaged-drift';\r\n",
    );
    retargetFixturePackage(fixture, `${fixture.packageId}-drift-rejected`);

    const secondResult = runInstaller(fixture);

    expect(secondResult.status).not.toBe(0);
    expect(`${secondResult.stdout}\n${secondResult.stderr}`).toContain(
      'installed-release runtime file does not match its receipt: dist/shared/shared.js',
    );
    expect(readFileSync(receiptPath)).toEqual(receiptBefore);
    expect(readFileSync(journalPath)).toEqual(journalBefore);
    expect(isProcessAlive(runningPid)).toBe(true);
    await waitForVersion(fixture.endpoint, 'candidate');
    expectMaintenanceReleased(fixture, secondResult);
  });

  it('fails closed on a tampered installed-release receipt without changing runtime or the prior journal', async () => {
    const fixture = await createFixture();
    const firstResult = runInstaller(fixture);
    expect(firstResult.status).toBe(0);
    await waitForVersion(fixture.endpoint, 'candidate');

    const receiptPath = join(fixture.appRoot, '.hotfix-installed-release.json');
    const journalPath = join(fixture.appRoot, '.hotfix-transaction.json');
    const priorJournal = readFileSync(journalPath);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
      receiptChecksum: string;
    };
    receipt.receiptChecksum = `${
      receipt.receiptChecksum.startsWith('0') ? '1' : '0'
    }${receipt.receiptChecksum.slice(1)}`;
    writeText(receiptPath, JSON.stringify(receipt));
    const tamperedReceipt = readFileSync(receiptPath);
    const runningPid = Number(readPidRecord(fixture.appRoot)?.pid);
    retargetFixturePackage(fixture, `${fixture.packageId}-receipt-rejected`);

    const secondResult = runInstaller(fixture);

    expect(secondResult.status).not.toBe(0);
    expect(`${secondResult.stdout}\n${secondResult.stderr}`).toContain(
      'receipt checksum mismatch',
    );
    expect(readFileSync(receiptPath)).toEqual(tamperedReceipt);
    expect(readFileSync(journalPath)).toEqual(priorJournal);
    expect(isProcessAlive(runningPid)).toBe(true);
    await waitForVersion(fixture.endpoint, 'candidate');
    expectMaintenanceReleased(fixture, secondResult);
  });

  it('keeps the prior installed-release receipt byte-for-byte when the next generation rolls back', async () => {
    const fixture = await createFixture();
    const firstResult = runInstaller(fixture);
    expect(firstResult.status).toBe(0);
    await waitForVersion(fixture.endpoint, 'candidate');

    const receiptPath = join(fixture.appRoot, '.hotfix-installed-release.json');
    const receiptBefore = readFileSync(receiptPath);
    const runtimeBefore = snapshotDirectory(join(fixture.appRoot, 'dist'));
    const startBefore = readFileSync(join(fixture.appRoot, 'start.ps1'));
    const firstRuntimePid = Number(readPidRecord(fixture.appRoot)?.pid);
    const nextPackageId = `${fixture.packageId}-rollback`;
    retargetFixturePackage(fixture, nextPackageId);
    replaceFixturePayloadFile(
      fixture,
      'dist/shared/shared.js',
      "module.exports = 'generation-b';\r\n",
    );
    replaceFixtureReleaseFile(
      fixture,
      'start.ps1',
      `\ufeff${createStartScript(fixture.port, 23)}`,
    );

    const secondResult = runInstaller(fixture);

    expect(secondResult.status).not.toBe(0);
    expect(`${secondResult.stdout}\n${secondResult.stderr}`).toMatch(
      /previous runtime was restored and\s+passed its health check/,
    );
    expect(`${secondResult.stdout}\n${secondResult.stderr}`).toContain(
      'The replacement runtime did not pass its health check.',
    );
    expect(readFileSync(receiptPath)).toEqual(receiptBefore);
    expect(snapshotDirectory(join(fixture.appRoot, 'dist'))).toEqual(
      runtimeBefore,
    );
    expect(readFileSync(join(fixture.appRoot, 'start.ps1'))).toEqual(
      startBefore,
    );
    expect(
      JSON.parse(
        readFileSync(join(fixture.appRoot, '.hotfix-transaction.json'), 'utf8'),
      ),
    ).toMatchObject({
      deploymentId: nextPackageId,
      phase: 'rolled-back',
    });
    expect(isProcessAlive(firstRuntimePid)).toBe(false);
    await waitForVersion(fixture.endpoint, 'candidate');
    expectMaintenanceReleased(fixture, secondResult);
  });

  it('captures an already-deployed release target after cleaning a different finalized transaction', async () => {
    const fixture = await createFixture({
      alreadyDeployedReleaseScript: true,
      installerSource: formalInstallerPath
        ? readFileSync(formalInstallerPath, 'utf8')
        : undefined,
    });
    const previousDeploymentId =
      'runtime-test-previous-finalized-with-release-target';
    writeText(
      join(fixture.appRoot, '.hotfix-transaction.json'),
      JSON.stringify(terminalTransactionPayload(fixture, previousDeploymentId)),
    );
    await startCurrentRuntime(fixture);

    const result = runInstaller(fixture);

    if (result.status !== 0) {
      throw new Error(
        `installer rejected an already-deployed release target after terminal cleanup:\n${result.stdout}\n${result.stderr}`,
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'captured the current managed release-root state',
    );
    expect(
      readFileSync(
        join(
          fixture.appRoot,
          'scripts',
          'backfill-dingtalk-attendance-archive.mjs',
        ),
        'utf8',
      ),
    ).toBe("export const archiveVersion = 'candidate';\r\n");
    expectTerminalDeploymentArtifactsRemoved(
      fixture.appRoot,
      previousDeploymentId,
    );
    expectMaintenanceReleased(fixture, result);
  });

  it('preserves a different finalized transaction when the next package baseline cannot be proven', async () => {
    const fixture = await createFixture();
    const previousDeploymentId = 'runtime-test-previous-baseline-guard';
    const priorJournal = JSON.stringify(
      terminalTransactionPayload(fixture, previousDeploymentId),
    );
    for (const artifactPath of terminalDeploymentArtifactPaths(
      fixture.appRoot,
      previousDeploymentId,
    )) {
      writeText(
        join(artifactPath, 'sentinel.txt'),
        'must remain on baseline failure\r\n',
      );
    }
    writeText(join(fixture.appRoot, '.hotfix-transaction.json'), priorJournal);
    writeText(
      join(fixture.appRoot, 'dist', 'shared', 'shared.js'),
      "module.exports = 'unexpected-baseline';\r\n",
    );
    const oldPid = await startCurrentRuntime(fixture);

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toMatch(
      /previous dist runtime file does not match its baseline/i,
    );
    expect(output).not.toMatch(
      /durable rollback transaction belongs to a different/i,
    );
    expect(isProcessAlive(oldPid)).toBe(true);
    expect(
      readFileSync(join(fixture.appRoot, '.hotfix-transaction.json'), 'utf8'),
    ).toBe(priorJournal);
    for (const artifactPath of terminalDeploymentArtifactPaths(
      fixture.appRoot,
      previousDeploymentId,
    )) {
      expect(existsSync(artifactPath)).toBe(true);
    }
  });

  it('still rejects a different committed transaction without changing its journal or runtime', async () => {
    const fixture = await createFixture();
    const previousDeploymentId = 'runtime-test-previous-committed';
    const priorJournal = JSON.stringify(
      terminalTransactionPayload(fixture, previousDeploymentId, 'committed'),
    );
    writeText(join(fixture.appRoot, '.hotfix-transaction.json'), priorJournal);
    const oldPid = await startCurrentRuntime(fixture);

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /foreign committed hotfix transaction has no matching durable installed-release receipt/i,
    );
    expect(isProcessAlive(oldPid)).toBe(true);
    expect(
      readFileSync(join(fixture.appRoot, '.hotfix-transaction.json'), 'utf8'),
    ).toBe(priorJournal);
    expect(
      readFileSync(join(fixture.appRoot, 'dist', 'server', 'main.js'), 'utf8'),
    ).toBe(fixture.oldMain);
  });

  it('accepts a narrowly proven legacy numeric pid but still requires a new JSON pid after launch', async () => {
    const fixture = await createFixture();
    await startCurrentRuntime(fixture, 'legacy-valid');

    const result = runInstaller(fixture);

    expect(result.status).toBe(0);
    expect(readPidRecord(fixture.appRoot)).toMatchObject({ schemaVersion: 1 });
    await waitForVersion(fixture.endpoint, 'candidate');
    expect(await requestVersion(fixture.endpoint)).toBe('candidate');
  });

  it('upgrades a legacy relative-entry runtime without confusing another app using the same relative entry', async () => {
    const fixture = await createFixture();
    const oldPid = await startLegacyRelativeCurrentRuntime(fixture);
    const otherRoot = join(fixture.root, 'other-app');
    const otherMain = join(otherRoot, 'dist', 'server', 'main.js');
    writeText(otherMain, 'setInterval(() => {}, 1000);\r\n');
    const unrelated = spawn(process.execPath, ['dist/server/main.js'], {
      cwd: otherRoot,
      windowsHide: true,
      stdio: 'ignore',
    });
    if (!unrelated.pid) {
      throw new Error('cross-root relative runtime fixture did not start');
    }
    trackedPids.add(unrelated.pid);

    const result = runInstaller(fixture);

    expect(result.status).toBe(0);
    expect(isProcessAlive(oldPid)).toBe(false);
    expect(isProcessAlive(unrelated.pid)).toBe(true);
    expect(readPidRecord(fixture.appRoot)).toMatchObject({ schemaVersion: 1 });
    await waitForVersion(fixture.endpoint, 'candidate');
    expect(await requestVersion(fixture.endpoint)).toBe('candidate');
  });

  it('rejects a stale legacy numeric pid before stop and leaves the live runtime untouched', async () => {
    const fixture = await createFixture();
    const oldPid = await startCurrentRuntime(fixture, 'legacy-stale');

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain(
      'legacy app.pid timestamp cannot prove process ownership',
    );
    expect(output).toContain('failed before the runtime switch');
    expect(output).not.toContain(
      'previous runtime was restored and passed its health check',
    );
    expect(isProcessAlive(oldPid)).toBe(true);
    expect(
      readFileSync(join(fixture.appRoot, 'dist', 'server', 'main.js'), 'utf8'),
    ).toBe(fixture.oldMain);
    expectMaintenanceReleased(fixture, result);
  });

  it('does not kill an unrelated same-root Node process referenced by a forged JSON pid', async () => {
    const fixture = await createFixture();
    const unrelatedPath = join(fixture.appRoot, 'unrelated-worker.js');
    writeText(unrelatedPath, 'setInterval(() => {}, 1000);\r\n');
    const unrelated = spawn(process.execPath, [unrelatedPath], {
      cwd: fixture.appRoot,
      windowsHide: true,
      stdio: 'ignore',
    });
    if (!unrelated.pid) {
      throw new Error('unrelated Node fixture did not start');
    }
    trackedPids.add(unrelated.pid);
    writeText(
      join(fixture.appRoot, 'app.pid'),
      JSON.stringify({
        schemaVersion: 1,
        pid: unrelated.pid,
        startTime: new Date().toISOString(),
        appRoot: fixture.appRoot,
        mainFile: join(fixture.appRoot, 'dist', 'server', 'main.js'),
      }),
    );

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'app.pid owner cannot be proven',
    );
    expect(isProcessAlive(unrelated.pid)).toBe(true);
    expect(
      readFileSync(join(fixture.appRoot, 'dist', 'server', 'main.js'), 'utf8'),
    ).toBe(fixture.oldMain);
  });

  it('refuses a concurrent installer lifecycle owner without stopping or changing the app', async () => {
    const fixture = await createFixture();
    const originalStart = readFileSync(join(fixture.appRoot, 'start.ps1'));
    const oldPid = await startCurrentRuntime(fixture);
    await holdLifecycleLock(fixture);

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Another application lifecycle operation is already running',
    );
    expect(isProcessAlive(oldPid)).toBe(true);
    await waitForVersion(fixture.endpoint, 'old');
    expect(readFileSync(join(fixture.appRoot, 'start.ps1'))).toEqual(
      originalStart,
    );
    expect(existsSync(join(fixture.appRoot, '.maintenance.lock'))).toBe(false);
  });

  it('holds the verified staged candidate read-only through the switch so drift cannot be written', async () => {
    const fixture = await createFixture({ fillerCount: 200 });
    const oldPid = await startCurrentRuntime(fixture);
    const lockedPhase = 'after-maintenance-created';
    const lockedReachedPath = `${fixture.faultMarkerPath}.${lockedPhase}.reached`;
    const lockedContinuePath = `${fixture.faultMarkerPath}.${lockedPhase}.continue`;
    const running = runInstallerAsync(fixture, {
      NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
      NANTONG_HOTFIX_TEST_PAUSE_PHASE: lockedPhase,
    });
    const maintenancePath = join(fixture.appRoot, '.maintenance.lock');
    let owner: Record<string, unknown>;
    try {
      await waitForFile(lockedReachedPath, 90_000);
      owner = await waitForJsonFile(maintenancePath, 90_000);
    } catch (error) {
      if (running.child.pid) {
        terminatePid(running.child.pid);
      }
      await running.result.catch(() => undefined);
      throw error;
    }
    expect(owner).toMatchObject({
      deploymentId: fixture.packageId,
      appRoot: fixture.appRoot,
    });
    let tamperError: unknown;
    try {
      writeText(
        fixture.stageTargetPath,
        '// tampered after initial validation\r\n',
      );
    } catch (error) {
      tamperError = error;
    } finally {
      writeText(lockedContinuePath, 'continue\r\n');
    }

    const result = await running.result;

    expect(tamperError).toBeDefined();
    expect(String(tamperError)).toMatch(
      /EPERM|EBUSY|access|used by another process/i,
    );
    if (result.status !== 0) {
      throw new Error(
        `held staged candidate deployment failed:\n${result.stdout}\n${result.stderr}`,
      );
    }
    expect(isProcessAlive(oldPid)).toBe(false);
    await waitForVersion(fixture.endpoint, 'candidate');
    expect(
      readFileSync(
        join(fixture.appRoot, 'dist', 'client', 'zzzz-stage-target.js'),
        'utf8',
      ),
    ).toBe('// stage integrity target\r\n');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      'Integrity-checked file hash or size mismatch',
    );
    expectMaintenanceReleased(fixture, result);
  });

  it('revalidates server targets under both locks and refuses target drift before stop', async () => {
    const fixture = await createFixture({ fillerCount: 200 });
    const oldPid = await startCurrentRuntime(fixture);
    const running = runInstallerAsync(fixture);
    const maintenancePath = join(fixture.appRoot, '.maintenance.lock');
    try {
      await waitForFile(maintenancePath, 90_000);
    } catch (error) {
      if (running.child.pid) {
        terminatePid(running.child.pid);
      }
      await running.result.catch(() => undefined);
      throw error;
    }
    writeText(join(fixture.appRoot, 'start.ps1'), '# target drift\r\n');

    const result = await running.result;

    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain(
      'Server baseline runtime file mismatch: start.ps1',
    );
    expect(output).toContain('failed before the runtime switch');
    expect(output).not.toContain(
      'previous runtime was restored and passed its health check',
    );
    expect(isProcessAlive(oldPid)).toBe(true);
    await waitForVersion(fixture.endpoint, 'old');
    expectMaintenanceReleased(fixture, result);
  });

  it('rolls back when the candidate serves 200 but its launcher later exits 23', async () => {
    const fixture = await createFixture({ candidateLauncherExitCode: 23 });
    const originalStart = readFileSync(join(fixture.appRoot, 'start.ps1'));
    const staleChunkPath = join(
      fixture.appRoot,
      'dist',
      'client',
      'chunks',
      'async-vendors.1db28cfa.js',
    );
    const staleChunkMapPath = `${staleChunkPath}.map`;
    const staleChunkContents = 'rollback historical chunk proof\r\n';
    const staleChunkMapContents = 'rollback historical chunk map proof\r\n';
    writeText(staleChunkPath, staleChunkContents);
    writeText(staleChunkMapPath, staleChunkMapContents);
    await startCurrentRuntime(fixture);

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /previous runtime was restored and\s+passed its health check/,
    );
    expect(existsSync(join(fixture.appRoot, '.candidate-listening'))).toBe(
      true,
    );
    expect(
      readFileSync(join(fixture.appRoot, 'dist', 'server', 'main.js'), 'utf8'),
    ).toBe(fixture.oldMain);
    expect(readFileSync(join(fixture.appRoot, 'start.ps1'))).toEqual(
      originalStart,
    );
    expect(readFileSync(staleChunkPath, 'utf8')).toBe(staleChunkContents);
    expect(readFileSync(staleChunkMapPath, 'utf8')).toBe(staleChunkMapContents);
    await waitForVersion(fixture.endpoint, 'old');
    expect(existsSync(join(fixture.appRoot, '.maintenance.lock'))).toBe(false);
  });

  it('passes the pre-stop trusted Node executable to the recovery launcher', async () => {
    const fixture = await createFixture({
      candidateLauncherExitCode: 23,
      captureRecoveryNodePath: true,
    });
    await startCurrentRuntime(fixture);

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /previous runtime was restored and\s+passed its health check/,
    );
    expect(fixture.recoveryNodeCapturePath).toBeDefined();
    expect(readFileSync(fixture.recoveryNodeCapturePath!, 'utf8').trim()).toBe(
      process.execPath,
    );
    await waitForVersion(fixture.endpoint, 'old');
  });

  it('preserves separate candidate launcher diagnostics when rollback also launches recovery', async () => {
    const fixture = await createFixture({
      candidateLauncherExitCode: 23,
      candidateLauncherDiagnostics: {
        stdout: 'candidate-stdout-sentinel',
        stderr: 'candidate-stderr-sentinel',
      },
    });
    await startCurrentRuntime(fixture);

    const result = runInstaller(fixture);
    const output = `${result.stdout}\n${result.stderr}`;
    const logNames = readdirSync(join(fixture.appRoot, 'logs'));
    const candidateStdoutLogs = logNames.filter((name) =>
      /^hotfix-launcher-candidate-.+\.out\.log$/u.test(name),
    );
    const candidateStderrLogs = logNames.filter((name) =>
      /^hotfix-launcher-candidate-.+\.err\.log$/u.test(name),
    );

    expect(result.status).not.toBe(0);
    expect(output).toContain('Runtime launcher stderr tail:');
    expect(output).toContain('candidate-stderr-sentinel');
    expect(output).toContain('Runtime launcher stdout tail:');
    expect(output).toContain('candidate-stdout-sentinel');
    expect(candidateStdoutLogs).toHaveLength(1);
    expect(candidateStderrLogs).toHaveLength(1);
    expect(
      readFileSync(
        join(fixture.appRoot, 'logs', candidateStdoutLogs[0]),
        'utf8',
      ),
    ).toContain('candidate-stdout-sentinel');
    expect(
      readFileSync(
        join(fixture.appRoot, 'logs', candidateStderrLogs[0]),
        'utf8',
      ),
    ).toContain('candidate-stderr-sentinel');
    expect(output).toMatch(
      /previous runtime was restored and\s+passed its health check/i,
    );
    await waitForVersion(fixture.endpoint, 'old');
  });

  it('stops only the verified post-launch recovery Node when health fails after its launcher exits zero', async () => {
    const fixture = await createFixture({
      candidateLauncherExitCode: 23,
      recoveryNeverHealthy: true,
    });
    await startCurrentRuntime(fixture);
    const unrelatedPath = join(fixture.appRoot, 'recovery-unrelated-worker.js');
    writeText(unrelatedPath, 'setInterval(() => {}, 1000);\r\n');
    const unrelated = spawn(process.execPath, [unrelatedPath], {
      cwd: fixture.appRoot,
      windowsHide: true,
      stdio: 'ignore',
    });
    if (!unrelated.pid) {
      throw new Error('failed to start unrelated recovery cleanup fixture');
    }
    trackedPids.add(unrelated.pid);

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'recovered runtime did not pass its stable health verification',
    );
    expect(fixture.recoveryPidMarker).toBeDefined();
    if (!existsSync(fixture.recoveryPidMarker!)) {
      throw new Error(
        [
          'recovery PID marker was not created',
          `stdout=${result.stdout}`,
          `stderr=${result.stderr}`,
        ].join('\n'),
      );
    }
    const recoveryPid = Number(
      readFileSync(fixture.recoveryPidMarker!, 'utf8').trim(),
    );
    expect(Number.isInteger(recoveryPid)).toBe(true);
    expect(isProcessAlive(recoveryPid)).toBe(false);
    expect(readPidRecord(fixture.appRoot)).toBeUndefined();
    expect(isProcessAlive(unrelated.pid)).toBe(true);
  });

  it('uses a verified packaged safe launcher instead of a restored legacy baseline start script', async () => {
    const fixture = await createFixture({
      candidateResponseLimit: 2,
      legacyBaselineStart: true,
    });
    const originalStart = readFileSync(join(fixture.appRoot, 'start.ps1'));
    await startCurrentRuntime(fixture);

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /previous runtime was restored and\s+passed its health check/,
    );
    expect(fixture.legacyStartMarker).toBeDefined();
    expect(existsSync(fixture.legacyStartMarker!)).toBe(false);
    expect(
      readFileSync(join(fixture.appRoot, 'dist', 'server', 'main.js'), 'utf8'),
    ).toBe(fixture.oldMain);
    expect(readFileSync(join(fixture.appRoot, 'start.ps1'))).toEqual(
      originalStart,
    );
    const recoveredPidRecord = JSON.parse(
      readFileSync(join(fixture.appRoot, 'app.pid'), 'utf8'),
    ) as Record<string, unknown>;
    expect(recoveredPidRecord).toMatchObject({
      schemaVersion: 1,
      appRoot: fixture.appRoot,
      mainFile: join(fixture.appRoot, 'dist', 'server', 'main.js'),
    });
    expect(typeof recoveredPidRecord.pid).toBe('number');
    expect(
      readdirSync(fixture.appRoot).filter((name) =>
        name.startsWith('.hotfix-recovery-start.'),
      ),
    ).toEqual([]);
    await waitForVersion(fixture.endpoint, 'old');
    expect(existsSync(join(fixture.appRoot, '.maintenance.lock'))).toBe(false);
  });

  it('rejects a candidate that returns two healthy responses and then immediately exits', async () => {
    const fixture = await createFixture({ candidateResponseLimit: 2 });
    await startCurrentRuntime(fixture);

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /replacement did not pass|previous runtime was restored/i,
    );
    expect(
      readFileSync(join(fixture.appRoot, 'dist', 'server', 'main.js'), 'utf8'),
    ).toBe(fixture.oldMain);
    await waitForVersion(fixture.endpoint, 'old');
    expectSentinelsUnchanged(fixture);
  });

  it('rejects a pid JSON object with any unexpected property before touching the runtime', async () => {
    const fixture = await createFixture();
    const oldPid = await startCurrentRuntime(fixture);
    const pidPath = join(fixture.appRoot, 'app.pid');
    const record = readPidRecord(fixture.appRoot)!;
    writeText(pidPath, JSON.stringify({ ...record, unexpected: 'forged' }));

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /unexpected|exact properties|invalid app\.pid/i,
    );
    expect(isProcessAlive(oldPid)).toBe(true);
    await waitForVersion(fixture.endpoint, 'old');
    expectSentinelsUnchanged(fixture);
  });

  it('does not accept the expected main file when it is only a later argv value', async () => {
    const fixture = await createFixture();
    const unrelatedPath = join(fixture.appRoot, 'unrelated-health-server.js');
    const expectedMain = join(fixture.appRoot, 'dist', 'server', 'main.js');
    writeText(
      unrelatedPath,
      [
        "const http = require('http');",
        'const port = Number(process.argv[process.argv.length - 1]);',
        "const server = http.createServer((_request, response) => response.end(JSON.stringify({ role: 'admin', version: 'old' })));",
        "server.listen(port, '127.0.0.1');",
        "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
      ].join('\r\n'),
    );
    const unrelated = spawn(
      process.execPath,
      [unrelatedPath, expectedMain, String(fixture.port)],
      { cwd: fixture.appRoot, windowsHide: true, stdio: 'ignore' },
    );
    if (!unrelated.pid) {
      throw new Error('unrelated health server did not start');
    }
    trackedPids.add(unrelated.pid);
    writeText(
      join(fixture.appRoot, 'app.pid'),
      JSON.stringify({
        schemaVersion: 1,
        pid: unrelated.pid,
        startTime: getProcessStartTimeIso(unrelated.pid),
        appRoot: fixture.appRoot,
        mainFile: expectedMain,
      }),
    );
    await waitForVersion(fixture.endpoint, 'old');

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'app.pid owner cannot be proven',
    );
    expect(isProcessAlive(unrelated.pid)).toBe(true);
    expect(readFileSync(expectedMain, 'utf8')).toBe(fixture.oldMain);
    expectSentinelsUnchanged(fixture);
  });

  it('fails closed on a corrupt durable transaction journal', async () => {
    const fixture = await createFixture();
    const oldPid = await startCurrentRuntime(fixture);
    writeText(
      join(fixture.appRoot, '.hotfix-transaction.json'),
      JSON.stringify({
        schemaVersion: 1,
        phase: 'prepared',
        transactionChecksum: 'bad',
      }),
    );

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /transaction journal|checksum|strict schema/i,
    );
    expect(isProcessAlive(oldPid)).toBe(true);
    await waitForVersion(fixture.endpoint, 'old');
    expectSentinelsUnchanged(fixture);
  });

  it('recovers idempotently after a gated injected exception at a switch boundary', async () => {
    const fixture = await createFixture();
    await startCurrentRuntime(fixture);
    const faultEnvironment = {
      NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
      NANTONG_HOTFIX_TEST_THROW_PHASE: 'after-candidate-dist-installed',
    };

    const failed = runInstaller(fixture, faultEnvironment);
    expect(failed.status).not.toBe(0);

    const recovered = runInstaller(fixture);
    expect(recovered.status).toBe(0);
    await waitForVersion(fixture.endpoint, 'candidate');
    const repeated = runInstaller(fixture);
    expect(repeated.status).toBe(0);
    expect(`${repeated.stdout}\n${repeated.stderr}`).toMatch(
      /already|finalized|healthy/i,
    );
    expectSentinelsUnchanged(fixture);
    expect(existsSync(join(fixture.appRoot, '.maintenance.lock'))).toBe(false);
  });

  it('recovers after maintenance creation when the baseline contains the known obsolete certificate scheduler declaration', async () => {
    const fixture = await createFixture();
    const obsoleteSchedulerPath = join(
      fixture.appRoot,
      'dist',
      'server',
      'modules',
      'bitable-sync',
      'certificate-dashboard.scheduler.d.ts',
    );
    writeKnownObsoleteCertificateSchedulerDeclaration(obsoleteSchedulerPath);
    await startCurrentRuntime(fixture);
    const faultEnvironment = {
      NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
      NANTONG_HOTFIX_TEST_THROW_PHASE: 'after-maintenance-created',
    };

    const failed = runInstaller(fixture, faultEnvironment);
    expect(failed.status).not.toBe(0);
    await waitForVersion(fixture.endpoint, 'old');
    expect(existsSync(obsoleteSchedulerPath)).toBe(true);

    const recovered = runInstaller(fixture);
    if (recovered.status !== 0) {
      throw new Error(
        `installer failed after maintenance recovery:\n${recovered.stdout}\n${recovered.stderr}`,
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');
    expect(existsSync(obsoleteSchedulerPath)).toBe(false);
    expectSentinelsUnchanged(fixture);
    expectMaintenanceReleased(fixture, recovered);
  });

  it('closes a killed stage-intent transaction without disrupting the old runtime, then installs the same package', async () => {
    const fixture = await createFixture();
    const oldPid = await startCurrentRuntime(fixture);
    const journalPath = join(fixture.appRoot, '.hotfix-transaction.json');
    const maintenancePath = join(fixture.appRoot, '.maintenance.lock');
    const stageRoot = join(fixture.appRoot, '.hotfix-stage');
    const runtimeBefore = snapshotDirectory(join(fixture.appRoot, 'dist'));

    await killInstallerAtDurableBoundary(fixture, 'after-stage-intent-written');

    const interruptedJournal = JSON.parse(
      readFileSync(journalPath, 'utf8'),
    ) as {
      transactionId: string;
      deploymentId: string;
      phase: string;
    };
    expect(interruptedJournal).toMatchObject({
      deploymentId: fixture.packageId,
      phase: 'stage-intent',
    });
    expect(existsSync(maintenancePath)).toBe(true);
    expectTerminalDeploymentArtifactsRemoved(
      fixture.appRoot,
      fixture.packageId,
    );
    expect(isProcessAlive(oldPid)).toBe(true);
    await waitForVersion(fixture.endpoint, 'old');
    expect(snapshotDirectory(join(fixture.appRoot, 'dist'))).toEqual(
      runtimeBefore,
    );

    const recovered = runInstaller(fixture);

    if (recovered.status !== 0) {
      throw new Error(
        `stage-intent recovery failed:\n${recovered.stdout}\n${recovered.stderr}`,
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');
    const completedJournal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      transactionId: string;
      deploymentId: string;
      phase: string;
    };
    expect(completedJournal).toMatchObject({
      deploymentId: fixture.packageId,
      phase: 'finalized',
    });
    expect(completedJournal.transactionId).not.toBe(
      interruptedJournal.transactionId,
    );
    expectTerminalDeploymentArtifactsRemoved(
      fixture.appRoot,
      fixture.packageId,
    );
    expect(existsSync(stageRoot) ? readdirSync(stageRoot) : []).toEqual([]);
    expectSentinelsUnchanged(fixture);
    expectMaintenanceReleased(fixture, recovered);
  });

  it('recovers idempotently after the installer is externally killed mid-switch', async () => {
    const fixture = await createFixture({
      legacyBaselineStart: true,
      unicodeAppRoot: true,
    });
    await startCurrentRuntime(fixture);
    const phase = 'after-dist-backup-moved';
    const reachedPath = `${fixture.faultMarkerPath}.${phase}.reached`;
    const running = runInstallerAsync(fixture, {
      NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
      NANTONG_HOTFIX_TEST_PAUSE_PHASE: phase,
    });

    try {
      await waitForFile(reachedPath, 45_000);
    } catch (error) {
      if (running.child.pid) {
        forceKillPidOnly(running.child.pid);
      }
      await running.result.catch(() => undefined);
      throw error;
    }
    if (!running.child.pid) {
      throw new Error('installer process did not expose a pid');
    }
    forceKillPidOnly(running.child.pid);
    const killed = await running.result;
    expect(killed.status).not.toBe(0);

    const recovered = runInstaller(fixture);
    expect(recovered.status).toBe(0);
    await waitForVersion(fixture.endpoint, 'candidate');
    expect(fixture.legacyStartMarker).toBeDefined();
    expect(existsSync(fixture.legacyStartMarker!)).toBe(false);
    expect(
      readdirSync(fixture.appRoot).filter((name) =>
        name.startsWith('.hotfix-recovery-start.'),
      ),
    ).toEqual([]);
    expect(
      JSON.parse(readFileSync(join(fixture.appRoot, 'app.pid'), 'utf8')),
    ).toMatchObject({ schemaVersion: 1 });
    const repeated = runInstaller(fixture);
    expect(repeated.status).toBe(0);
    expectSentinelsUnchanged(fixture);
    expect(existsSync(join(fixture.appRoot, '.maintenance.lock'))).toBe(false);
  });

  it('recovers after the finalized journal is durable but before recovery artifacts are cleaned', async () => {
    const fixture = await createFixture();
    await startCurrentRuntime(fixture);
    const phase = 'after-finalized-written-before-cleanup';
    const reachedPath = `${fixture.faultMarkerPath}.${phase}.reached`;
    const running = runInstallerAsync(fixture, {
      NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
      NANTONG_HOTFIX_TEST_PAUSE_PHASE: phase,
    });

    try {
      await waitForFile(reachedPath, 45_000);
      await waitForVersion(fixture.endpoint, 'candidate');
    } catch (error) {
      if (running.child.pid) {
        forceKillPidOnly(running.child.pid);
      }
      await running.result.catch(() => undefined);
      throw error;
    }
    expect(
      JSON.parse(
        readFileSync(join(fixture.appRoot, '.hotfix-transaction.json'), 'utf8'),
      ),
    ).toMatchObject({
      deploymentId: fixture.packageId,
      phase: 'finalized',
    });
    expect(
      existsSync(join(fixture.appRoot, `dist.rollback.${fixture.packageId}`)),
    ).toBe(true);
    expect(
      existsSync(
        join(fixture.appRoot, `.hotfix-root-rollback.${fixture.packageId}`),
      ),
    ).toBe(true);
    if (!running.child.pid) {
      throw new Error('installer process did not expose a pid');
    }
    forceKillPidOnly(running.child.pid);
    const killed = await running.result;
    expect(killed.status).not.toBe(0);

    const recovered = runInstaller(fixture);

    if (recovered.status !== 0) {
      throw new Error(
        `finalized cleanup recovery failed:\n${recovered.stdout}\n${recovered.stderr}`,
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');
    expect(`${recovered.stdout}\n${recovered.stderr}`).toMatch(
      /already committed, finalized, and healthy/i,
    );
    expectTerminalDeploymentArtifactsRemoved(
      fixture.appRoot,
      fixture.packageId,
    );
    expect(
      JSON.parse(
        readFileSync(join(fixture.appRoot, '.hotfix-transaction.json'), 'utf8'),
      ),
    ).toMatchObject({
      deploymentId: fixture.packageId,
      phase: 'finalized',
    });
    expectSentinelsUnchanged(fixture);
    expectMaintenanceReleased(fixture, recovered);
  });

  it.each(['after-commit-written', 'after-installed-release-receipt-written'])(
    'recovers forward after an external kill at committed receipt boundary %s',
    async (phase) => {
      const fixture = await createFixture();
      await startCurrentRuntime(fixture);
      const reachedPath = `${fixture.faultMarkerPath}.${phase}.reached`;
      const running = runInstallerAsync(fixture, {
        NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
        NANTONG_HOTFIX_TEST_PAUSE_PHASE: phase,
      });

      try {
        await waitForFile(reachedPath, 45_000);
        await waitForVersion(fixture.endpoint, 'candidate');
      } catch (error) {
        if (running.child.pid) {
          forceKillPidOnly(running.child.pid);
        }
        await running.result.catch(() => undefined);
        throw error;
      }
      expect(
        JSON.parse(
          readFileSync(
            join(fixture.appRoot, '.hotfix-transaction.json'),
            'utf8',
          ),
        ),
      ).toMatchObject({
        deploymentId: fixture.packageId,
        phase: 'committed',
      });
      expect(
        existsSync(join(fixture.appRoot, '.hotfix-installed-release.json')),
      ).toBe(phase === 'after-installed-release-receipt-written');
      if (!running.child.pid) {
        throw new Error('installer process did not expose a pid');
      }
      forceKillPidOnly(running.child.pid);
      const killed = await running.result;
      expect(killed.status).not.toBe(0);

      const recovered = runInstaller(fixture);

      if (recovered.status !== 0) {
        throw new Error(
          `committed receipt boundary recovery failed at ${phase}:\n${recovered.stdout}\n${recovered.stderr}`,
        );
      }
      await waitForVersion(fixture.endpoint, 'candidate');
      expect(
        JSON.parse(
          readFileSync(
            join(fixture.appRoot, '.hotfix-installed-release.json'),
            'utf8',
          ),
        ),
      ).toMatchObject({
        deploymentId: fixture.packageId,
        schemaVersion: 2,
      });
      expect(
        JSON.parse(
          readFileSync(
            join(fixture.appRoot, '.hotfix-transaction.json'),
            'utf8',
          ),
        ),
      ).toMatchObject({
        deploymentId: fixture.packageId,
        phase: 'finalized',
      });
      expectTerminalDeploymentArtifactsRemoved(
        fixture.appRoot,
        fixture.packageId,
      );
      expectMaintenanceReleased(fixture, recovered);
    },
  );

  it('hands off a foreign committed transaction with a durable receipt and installs the next package', async () => {
    const fixture = await createFixture();
    await startCurrentRuntime(fixture);
    const firstPackageId = fixture.packageId;
    const journalPath = join(fixture.appRoot, '.hotfix-transaction.json');
    const receiptPath = join(fixture.appRoot, '.hotfix-installed-release.json');

    await killInstallerAtDurableBoundary(
      fixture,
      'after-installed-release-receipt-written',
    );

    expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toMatchObject({
      deploymentId: firstPackageId,
      phase: 'committed',
    });
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toMatchObject({
      deploymentId: firstPackageId,
      schemaVersion: 2,
    });
    const nextPackageId = `${firstPackageId}-receipt-handoff-next`;
    retargetFixturePackage(fixture, nextPackageId);

    const completed = runInstaller(fixture);

    if (completed.status !== 0) {
      throw new Error(
        `foreign committed receipt handoff failed:\n${completed.stdout}\n${completed.stderr}`,
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toMatchObject({
      deploymentId: nextPackageId,
      schemaVersion: 2,
    });
    expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toMatchObject({
      deploymentId: nextPackageId,
      phase: 'finalized',
    });
    expectTerminalDeploymentArtifactsRemoved(fixture.appRoot, firstPackageId);
    expectMaintenanceReleased(fixture, completed);
  });

  it('rejects a foreign committed transaction when its installed-release receipt was not durably written', async () => {
    const fixture = await createFixture();
    await startCurrentRuntime(fixture);
    const firstPackageId = fixture.packageId;
    const journalPath = join(fixture.appRoot, '.hotfix-transaction.json');
    const receiptPath = join(fixture.appRoot, '.hotfix-installed-release.json');

    await killInstallerAtDurableBoundary(fixture, 'after-commit-written');

    expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toMatchObject({
      deploymentId: firstPackageId,
      phase: 'committed',
    });
    expect(existsSync(receiptPath)).toBe(false);
    const journalBefore = readFileSync(journalPath);
    const runtimeBefore = snapshotDirectory(join(fixture.appRoot, 'dist'));
    const startBefore = readFileSync(join(fixture.appRoot, 'start.ps1'));
    const packageJsonBefore = readFileSync(
      join(fixture.appRoot, 'package.json'),
    );
    const packageLockBefore = readFileSync(
      join(fixture.appRoot, 'package-lock.json'),
    );
    const runningPid = Number(readPidRecord(fixture.appRoot)?.pid);
    const nextPackageId = `${firstPackageId}-missing-receipt-next`;
    retargetFixturePackage(fixture, nextPackageId);

    const refused = runInstaller(fixture);

    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}\n${refused.stderr}`).toMatch(
      /unresolved committed hotfix transaction|committed.*installed-release receipt|installed-release receipt.*committed/i,
    );
    expect(readFileSync(journalPath)).toEqual(journalBefore);
    expect(existsSync(receiptPath)).toBe(false);
    expect(snapshotDirectory(join(fixture.appRoot, 'dist'))).toEqual(
      runtimeBefore,
    );
    expect(readFileSync(join(fixture.appRoot, 'start.ps1'))).toEqual(
      startBefore,
    );
    expect(readFileSync(join(fixture.appRoot, 'package.json'))).toEqual(
      packageJsonBefore,
    );
    expect(readFileSync(join(fixture.appRoot, 'package-lock.json'))).toEqual(
      packageLockBefore,
    );
    expect(isProcessAlive(runningPid)).toBe(true);
    await waitForVersion(fixture.endpoint, 'candidate');
  });

  it('recovers after an external kill immediately after the previous dist is restored', async () => {
    const fixture = await createFixture({ legacyBaselineStart: true });
    await startCurrentRuntime(fixture);
    const phase = 'after-rollback-dist-restored';
    const reachedPath = `${fixture.faultMarkerPath}.${phase}.reached`;
    const running = runInstallerAsync(fixture, {
      NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
      NANTONG_HOTFIX_TEST_THROW_PHASE: 'after-candidate-dist-installed',
      NANTONG_HOTFIX_TEST_PAUSE_PHASE: phase,
    });

    try {
      await waitForFile(reachedPath, 45_000);
    } catch (error) {
      if (running.child.pid) {
        forceKillPidOnly(running.child.pid);
      }
      await running.result.catch(() => undefined);
      throw error;
    }
    if (!running.child.pid) {
      throw new Error('installer process did not expose a pid');
    }
    forceKillPidOnly(running.child.pid);
    const killed = await running.result;
    expect(killed.status).not.toBe(0);
    expect(
      readdirSync(fixture.appRoot).filter((name) =>
        name.startsWith('.hotfix-recovery-start.'),
      ),
    ).toHaveLength(1);

    const recovered = runInstaller(fixture);
    if (recovered.status !== 0) {
      throw new Error(
        [
          `post-rollback-dist-restored recovery exited ${String(recovered.status)}`,
          `stdout=${recovered.stdout}`,
          `stderr=${recovered.stderr}`,
        ].join('\n'),
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');
    expect(fixture.legacyStartMarker).toBeDefined();
    expect(existsSync(fixture.legacyStartMarker!)).toBe(false);
    expect(
      readdirSync(fixture.appRoot).filter((name) =>
        name.startsWith('.hotfix-recovery-start.'),
      ),
    ).toEqual([]);
    const repeated = runInstaller(fixture);
    expect(repeated.status).toBe(0);
    expectSentinelsUnchanged(fixture);
    expect(existsSync(join(fixture.appRoot, '.maintenance.lock'))).toBe(false);
  });

  it('recovers a different interrupted deployment with a historical frontend after its previous runtime was manually restarted, then installs the current package', async () => {
    const fixture = await createFixture({
      legacyBaselineStart: true,
      installerSource: formalInstallerPath
        ? readFileSync(formalInstallerPath, 'utf8')
        : undefined,
    });
    const previousDeploymentId = fixture.packageId;
    await startCurrentRuntime(fixture);
    const rollbackPhase = 'after-rollback-dist-restored';
    const rollbackReachedPath = `${fixture.faultMarkerPath}.${rollbackPhase}.reached`;
    const interrupted = runInstallerAsync(fixture, {
      NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
      NANTONG_HOTFIX_TEST_THROW_PHASE: 'after-candidate-started',
      NANTONG_HOTFIX_TEST_PAUSE_PHASE: rollbackPhase,
    });

    await waitForFile(rollbackReachedPath, 45_000);
    if (!interrupted.child.pid) {
      throw new Error('installer process did not expose a pid');
    }
    forceKillPidOnly(interrupted.child.pid);
    const killed = await interrupted.result;
    expect(killed.status).not.toBe(0);

    const interruptedJournal = JSON.parse(
      readFileSync(join(fixture.appRoot, '.hotfix-transaction.json'), 'utf8'),
    ) as { transactionId: string; deploymentId: string; phase: string };
    expect(interruptedJournal).toMatchObject({
      deploymentId: previousDeploymentId,
      phase: 'candidate-started',
    });
    const manuallyRestartedPid = await startCurrentRuntime(fixture);
    await waitForVersion(fixture.endpoint, 'old');
    writeText(
      join(fixture.appRoot, 'dist', 'client', 'main.js'),
      "window.RUNTIME = 'historical-client';\r\n",
    );

    const currentDeploymentId = `${previousDeploymentId}-next`;
    retargetFixturePackage(fixture, currentDeploymentId);
    const completed = runInstaller(fixture);

    if (completed.status !== 0) {
      throw new Error(
        `cross-package interrupted deployment recovery failed:\n${completed.stdout}\n${completed.stderr}`,
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');
    expect(`${completed.stdout}\n${completed.stderr}`).toContain(
      'Recovered and closed the interrupted previous deployment',
    );
    expect(isProcessAlive(manuallyRestartedPid)).toBe(false);
    expectTerminalDeploymentArtifactsRemoved(
      fixture.appRoot,
      previousDeploymentId,
    );
    expectTerminalDeploymentArtifactsRemoved(
      fixture.appRoot,
      currentDeploymentId,
    );
    expect(
      existsSync(
        join(
          fixture.appRoot,
          '.hotfix-recovery-artifacts',
          interruptedJournal.transactionId,
        ),
      ),
    ).toBe(false);
    expect(
      JSON.parse(
        readFileSync(join(fixture.appRoot, '.hotfix-transaction.json'), 'utf8'),
      ),
    ).toMatchObject({
      deploymentId: currentDeploymentId,
      phase: 'finalized',
    });
    expectSentinelsUnchanged(fixture);
    expectMaintenanceReleased(fixture, completed);
  });

  it('uses a strict prior installed receipt to prove an interrupted rollback runtime after the release tool changes', async () => {
    const fixture = await createFixture();
    const firstResult = runInstaller(fixture);
    if (firstResult.status !== 0) {
      throw new Error(
        `first-generation installer failed:\n${firstResult.stdout}\n${firstResult.stderr}`,
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');

    const firstPackageId = fixture.packageId;
    const interruptedPackageId = `${firstPackageId}-interrupted`;
    retargetFixturePackage(fixture, interruptedPackageId);
    const phase = 'after-candidate-dist-installed';
    const reachedPath = `${fixture.faultMarkerPath}.${phase}.reached`;
    const interrupted = runInstallerAsync(fixture, {
      NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
      NANTONG_HOTFIX_TEST_PAUSE_PHASE: phase,
    });

    await waitForFile(reachedPath, 45_000);
    if (!interrupted.child.pid) {
      throw new Error('installer process did not expose a pid');
    }
    forceKillPidOnly(interrupted.child.pid);
    expect((await interrupted.result).status).not.toBe(0);

    replaceFixtureInstaller(
      fixture,
      `\ufeff${extractInstaller()}\r\n# fixture release tool generation changed\r\n`,
    );
    const currentPackageId = `${firstPackageId}-current`;
    retargetFixturePackage(fixture, currentPackageId);

    const completed = runInstaller(fixture);
    if (completed.status !== 0) {
      throw new Error(
        `strict prior receipt recovery failed:\n${completed.stdout}\n${completed.stderr}`,
      );
    }

    await waitForVersion(fixture.endpoint, 'candidate');
    const output = `${completed.stdout}\n${completed.stderr}`;
    expect(output).toContain(
      'Used the strict prior installed-release receipt to prove the interrupted rollback runtime',
    );
    expect(output).toContain(
      'Recovered and closed the interrupted previous deployment',
    );
    expect(
      JSON.parse(
        readFileSync(
          join(fixture.appRoot, '.hotfix-installed-release.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ deploymentId: currentPackageId, schemaVersion: 2 });
    expectTerminalDeploymentArtifactsRemoved(
      fixture.appRoot,
      interruptedPackageId,
    );
    expectMaintenanceReleased(fixture, completed);
  });

  it('rejects a tampered interrupted rollback runtime even when a strict prior installed receipt exists', async () => {
    const fixture = await createFixture();
    const firstResult = runInstaller(fixture);
    expect(firstResult.status).toBe(0);
    await waitForVersion(fixture.endpoint, 'candidate');

    const firstPackageId = fixture.packageId;
    const interruptedPackageId = `${firstPackageId}-interrupted-tampered`;
    retargetFixturePackage(fixture, interruptedPackageId);
    const phase = 'after-candidate-dist-installed';
    const reachedPath = `${fixture.faultMarkerPath}.${phase}.reached`;
    const interrupted = runInstallerAsync(fixture, {
      NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
      NANTONG_HOTFIX_TEST_PAUSE_PHASE: phase,
    });

    await waitForFile(reachedPath, 45_000);
    if (!interrupted.child.pid) {
      throw new Error('installer process did not expose a pid');
    }
    forceKillPidOnly(interrupted.child.pid);
    expect((await interrupted.result).status).not.toBe(0);

    const rollbackSharedPath = join(
      fixture.appRoot,
      `dist.rollback.${interruptedPackageId}`,
      'shared',
      'shared.js',
    );
    writeText(rollbackSharedPath, "module.exports = 'tampered-rollback';\r\n");
    replaceFixtureInstaller(
      fixture,
      `\ufeff${extractInstaller()}\r\n# fixture release tool generation changed\r\n`,
    );
    retargetFixturePackage(fixture, `${firstPackageId}-tampered-refused`);
    const journalPath = join(fixture.appRoot, '.hotfix-transaction.json');
    const priorJournal = readFileSync(journalPath, 'utf8');

    const refused = runInstaller(fixture);

    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}\n${refused.stderr}`).toMatch(
      /Neither the strict prior installed-release receipt nor the explicit server baseline proves the\s+previous runtime/i,
    );
    expect(readFileSync(journalPath, 'utf8')).toBe(priorJournal);
    expect(
      readFileSync(join(fixture.appRoot, 'dist', 'server', 'main.js'), 'utf8'),
    ).toContain("version = 'candidate'");
    expect(existsSync(join(fixture.appRoot, '.maintenance.lock'))).toBe(true);
  });

  it('recovers a different interrupted deployment when the consumer release marker is semantically valid but byte-different', async () => {
    const fixture = await createFixture({
      legacyBaselineStart: true,
      consumerReleaseMarker: true,
      installerSource: formalInstallerPath
        ? readFileSync(formalInstallerPath, 'utf8')
        : undefined,
    });
    const previousDeploymentId = fixture.packageId;
    await startCurrentRuntime(fixture);
    const rollbackPhase = 'after-rollback-dist-restored';
    const rollbackReachedPath = `${fixture.faultMarkerPath}.${rollbackPhase}.reached`;
    const interrupted = runInstallerAsync(fixture, {
      NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
      NANTONG_HOTFIX_TEST_THROW_PHASE: 'after-candidate-started',
      NANTONG_HOTFIX_TEST_PAUSE_PHASE: rollbackPhase,
    });

    await waitForFile(rollbackReachedPath, 45_000);
    if (!interrupted.child.pid) {
      throw new Error('installer process did not expose a pid');
    }
    forceKillPidOnly(interrupted.child.pid);
    const killed = await interrupted.result;
    expect(killed.status).not.toBe(0);

    const manuallyRestartedPid = await startCurrentRuntime(fixture);
    await waitForVersion(fixture.endpoint, 'old');
    writeText(
      join(fixture.appRoot, '.feishu-card-action-consumer-release'),
      'today-operations-anomaly\n',
    );

    const currentDeploymentId = `${previousDeploymentId}-next`;
    retargetFixturePackage(fixture, currentDeploymentId);
    const completed = runInstaller(fixture);

    if (completed.status !== 0) {
      throw new Error(
        `semantic release marker recovery failed:\n${completed.stdout}\n${completed.stderr}`,
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');
    expect(`${completed.stdout}\n${completed.stderr}`).toContain(
      'captured the current managed release-root state',
    );
    expect(isProcessAlive(manuallyRestartedPid)).toBe(false);
    expectTerminalDeploymentArtifactsRemoved(
      fixture.appRoot,
      previousDeploymentId,
    );
    expectTerminalDeploymentArtifactsRemoved(
      fixture.appRoot,
      currentDeploymentId,
    );
    expectMaintenanceReleased(fixture, completed);
  });

  it('closes a different interrupted deployment in one step when the current root files are proven by the current package baseline', async () => {
    const fixture = await createFixture({
      legacyBaselineStart: true,
      consumerReleaseMarker: true,
      releasePackageJson: true,
      installerSource: formalInstallerPath
        ? readFileSync(formalInstallerPath, 'utf8')
        : undefined,
    });
    const previousDeploymentId = fixture.packageId;
    await startCurrentRuntime(fixture);
    const phase = 'after-candidate-dist-installed';
    const reachedPath = `${fixture.faultMarkerPath}.${phase}.reached`;
    const interrupted = runInstallerAsync(fixture, {
      NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
      NANTONG_HOTFIX_TEST_PAUSE_PHASE: phase,
    });

    await waitForFile(reachedPath, 45_000);
    if (!interrupted.child.pid) {
      throw new Error('installer process did not expose a pid');
    }
    forceKillPidOnly(interrupted.child.pid);
    const killed = await interrupted.result;
    expect(killed.status).not.toBe(0);

    const currentBaselinePackageJson = JSON.stringify({
      name: 'runtime-fixture',
      version: '1.1.0',
    });
    refreshFixtureBaselineFile(
      fixture,
      'package.json',
      currentBaselinePackageJson,
    );
    refreshFixtureBaselineFile(
      fixture,
      '.feishu-card-action-consumer-release',
      'today-operations-anomaly\n',
    );
    const currentDeploymentId = `${previousDeploymentId}-next`;
    retargetFixturePackage(fixture, currentDeploymentId);

    const completed = runInstaller(fixture);

    if (completed.status !== 0) {
      throw new Error(
        `current-baseline transaction recovery failed:\n${completed.stdout}\n${completed.stderr}`,
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');
    expect(`${completed.stdout}\n${completed.stderr}`).toContain(
      'captured the current managed release-root state',
    );
    expectTerminalDeploymentArtifactsRemoved(
      fixture.appRoot,
      previousDeploymentId,
    );
    expectTerminalDeploymentArtifactsRemoved(
      fixture.appRoot,
      currentDeploymentId,
    );
    expectMaintenanceReleased(fixture, completed);
  });

  it('rebases a third-generation managed root file while closing a different interrupted deployment', async () => {
    const fixture = await createFixture({
      consumerReleaseMarker: true,
      releasePackageJson: true,
      installerSource: formalInstallerPath
        ? readFileSync(formalInstallerPath, 'utf8')
        : undefined,
    });
    await startCurrentRuntime(fixture);
    const phase = 'after-candidate-dist-installed';
    const reachedPath = `${fixture.faultMarkerPath}.${phase}.reached`;
    const interrupted = runInstallerAsync(fixture, {
      NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
      NANTONG_HOTFIX_TEST_PAUSE_PHASE: phase,
    });

    await waitForFile(reachedPath, 45_000);
    if (!interrupted.child.pid) {
      throw new Error('installer process did not expose a pid');
    }
    forceKillPidOnly(interrupted.child.pid);
    const killed = await interrupted.result;
    expect(killed.status).not.toBe(0);

    refreshFixtureBaselineFile(
      fixture,
      'package.json',
      JSON.stringify({ name: 'runtime-fixture', version: '1.1.0' }),
    );
    refreshFixtureBaselineFile(
      fixture,
      '.feishu-card-action-consumer-release',
      'today-operations-anomaly\n',
    );
    writeText(
      join(fixture.appRoot, 'package.json'),
      JSON.stringify({ name: 'runtime-fixture', version: 'tampered' }),
    );
    const journalPath = join(fixture.appRoot, '.hotfix-transaction.json');
    retargetFixturePackage(fixture, `${fixture.packageId}-next`);

    const completed = runInstaller(fixture);

    if (completed.status !== 0) {
      throw new Error(
        `managed root rebase failed:\n${completed.stdout}\n${completed.stderr}`,
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');
    expect(`${completed.stdout}\n${completed.stderr}`).toContain(
      'captured the current managed release-root state',
    );
    expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toMatchObject({
      phase: 'finalized',
    });
    expectMaintenanceReleased(fixture, completed);
  });

  it('restores the exact third-generation managed root bytes when the replacement candidate fails', async () => {
    const fixture = await createFixture({
      candidateLauncherExitCode: 23,
      legacyBaselineStart: true,
      consumerReleaseMarker: true,
      releasePackageJson: true,
      installerSource: formalInstallerPath
        ? readFileSync(formalInstallerPath, 'utf8')
        : undefined,
    });
    const previousDeploymentId = fixture.packageId;
    await startCurrentRuntime(fixture);
    const phase = 'after-candidate-dist-installed';
    const reachedPath = `${fixture.faultMarkerPath}.${phase}.reached`;
    const interrupted = runInstallerAsync(fixture, {
      NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
      NANTONG_HOTFIX_TEST_PAUSE_PHASE: phase,
    });

    await waitForFile(reachedPath, 45_000);
    if (!interrupted.child.pid) {
      throw new Error('installer process did not expose a pid');
    }
    forceKillPidOnly(interrupted.child.pid);
    expect((await interrupted.result).status).not.toBe(0);

    const thirdGenerationPackageJson = JSON.stringify({
      name: 'runtime-fixture',
      version: 'third-generation',
    });
    writeText(
      join(fixture.appRoot, 'package.json'),
      thirdGenerationPackageJson,
    );
    retargetFixturePackage(fixture, `${previousDeploymentId}-next`);

    const failed = runInstaller(fixture);

    expect(failed.status).not.toBe(0);
    expect(`${failed.stdout}\n${failed.stderr}`).toMatch(
      /previous runtime was restored and\s+passed its health check/i,
    );
    await waitForVersion(fixture.endpoint, 'old');
    expect(readFileSync(join(fixture.appRoot, 'package.json'), 'utf8')).toBe(
      thirdGenerationPackageJson,
    );
    expectMaintenanceReleased(fixture, failed);
  });

  it('refuses cross-package takeover when a managed release-root target is not a regular file', async () => {
    const fixture = await createFixture({
      releasePackageJson: true,
      installerSource: formalInstallerPath
        ? readFileSync(formalInstallerPath, 'utf8')
        : undefined,
    });
    await startCurrentRuntime(fixture);
    const phase = 'after-candidate-dist-installed';
    const reachedPath = `${fixture.faultMarkerPath}.${phase}.reached`;
    const interrupted = runInstallerAsync(fixture, {
      NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
      NANTONG_HOTFIX_TEST_PAUSE_PHASE: phase,
    });

    await waitForFile(reachedPath, 45_000);
    if (!interrupted.child.pid) {
      throw new Error('installer process did not expose a pid');
    }
    forceKillPidOnly(interrupted.child.pid);
    expect((await interrupted.result).status).not.toBe(0);

    const packageJsonPath = join(fixture.appRoot, 'package.json');
    rmSync(packageJsonPath, { force: true });
    mkdirSync(packageJsonPath);
    const journalPath = join(fixture.appRoot, '.hotfix-transaction.json');
    const priorJournal = readFileSync(journalPath, 'utf8');
    retargetFixturePackage(fixture, `${fixture.packageId}-next`);

    const refused = runInstaller(fixture);

    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}\n${refused.stderr}`).toMatch(
      /managed release-root target is not a regular file/i,
    );
    expect(readFileSync(journalPath, 'utf8')).toBe(priorJournal);
  });

  it('restores the historical frontend when a cross-package replacement candidate fails', async () => {
    const fixture = await createFixture({
      candidateLauncherExitCode: 23,
      legacyBaselineStart: true,
      installerSource: formalInstallerPath
        ? readFileSync(formalInstallerPath, 'utf8')
        : undefined,
    });
    const previousDeploymentId = 'runtime-test-previous-historical-frontend';
    writeText(
      join(fixture.appRoot, '.hotfix-transaction.json'),
      JSON.stringify(terminalTransactionPayload(fixture, previousDeploymentId)),
    );
    const historicalClient =
      "window.RUNTIME = 'historical-client-before-failed-replacement';\r\n";
    const historicalClientPath = join(
      fixture.appRoot,
      'dist',
      'client',
      'main.js',
    );
    writeText(historicalClientPath, historicalClient);
    const oldPid = await startCurrentRuntime(fixture);
    await waitForVersion(fixture.endpoint, 'old');
    const failed = runInstaller(fixture);

    expect(failed.status).not.toBe(0);
    expect(`${failed.stdout}\n${failed.stderr}`).toMatch(
      /previous runtime was restored and\s+passed its health check/i,
    );
    expect(isProcessAlive(oldPid)).toBe(false);
    await waitForVersion(fixture.endpoint, 'old');
    expect(readFileSync(historicalClientPath, 'utf8')).toBe(historicalClient);
    expect(
      readFileSync(join(fixture.appRoot, 'dist', 'server', 'main.js'), 'utf8'),
    ).toBe(fixture.oldMain);
    expectTerminalDeploymentArtifactsRemoved(
      fixture.appRoot,
      previousDeploymentId,
    );
    expectMaintenanceReleased(fixture, failed);
  });

  it('refuses cross-package recovery when the previous rollback runtime cannot be proven against the current baseline', async () => {
    const fixture = await createFixture();
    const previousDeploymentId = fixture.packageId;
    await startCurrentRuntime(fixture);
    const phase = 'after-candidate-dist-installed';
    const reachedPath = `${fixture.faultMarkerPath}.${phase}.reached`;
    const interrupted = runInstallerAsync(fixture, {
      NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
      NANTONG_HOTFIX_TEST_PAUSE_PHASE: phase,
    });

    await waitForFile(reachedPath, 45_000);
    if (!interrupted.child.pid) {
      throw new Error('installer process did not expose a pid');
    }
    forceKillPidOnly(interrupted.child.pid);
    const killed = await interrupted.result;
    expect(killed.status).not.toBe(0);

    const journalPath = join(fixture.appRoot, '.hotfix-transaction.json');
    const priorJournal = readFileSync(journalPath, 'utf8');
    writeText(
      join(
        fixture.appRoot,
        `dist.rollback.${previousDeploymentId}`,
        'shared',
        'shared.js',
      ),
      "module.exports = 'tampered-rollback';\r\n",
    );
    retargetFixturePackage(fixture, `${previousDeploymentId}-next`);

    const refused = runInstaller(fixture);

    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}\n${refused.stderr}`).toMatch(
      /previous interrupted deployment cannot be safely recovered[\s\S]*baseline/i,
    );
    expect(readFileSync(journalPath, 'utf8')).toBe(priorJournal);
    expect(
      readFileSync(join(fixture.appRoot, 'dist', 'server', 'main.js'), 'utf8'),
    ).toContain("version = 'candidate'");
    expect(existsSync(join(fixture.appRoot, '.maintenance.lock'))).toBe(true);
  });

  it('adopts a manually restarted healthy previous runtime without stopping it before the next switch', async () => {
    const fixture = await createFixture({ legacyBaselineStart: true });
    await startCurrentRuntime(fixture);
    const rollbackPhase = 'after-rollback-dist-restored';
    const rollbackReachedPath = `${fixture.faultMarkerPath}.${rollbackPhase}.reached`;
    const firstRun = runInstallerAsync(fixture, {
      NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
      NANTONG_HOTFIX_TEST_THROW_PHASE: 'after-candidate-started',
      NANTONG_HOTFIX_TEST_PAUSE_PHASE: rollbackPhase,
    });

    await waitForFile(rollbackReachedPath, 45_000);
    if (!firstRun.child.pid) {
      throw new Error('installer process did not expose a pid');
    }
    forceKillPidOnly(firstRun.child.pid);
    const interrupted = await firstRun.result;
    expect(interrupted.status).not.toBe(0);

    const manuallyRestartedPid = await startCurrentRuntime(fixture);
    await waitForVersion(fixture.endpoint, 'old');

    const nextPhase = 'after-maintenance-created';
    const nextReachedPath = `${fixture.faultMarkerPath}.${nextPhase}.reached`;
    const nextContinuePath = `${fixture.faultMarkerPath}.${nextPhase}.continue`;
    const secondRun = runInstallerAsync(fixture, {
      NANTONG_HOTFIX_TEST_FIXTURE_MARKER: fixture.faultMarkerPath,
      NANTONG_HOTFIX_TEST_PAUSE_PHASE: nextPhase,
    });

    try {
      await waitForFile(nextReachedPath, 45_000);
      expect(isProcessAlive(manuallyRestartedPid)).toBe(true);
      await waitForVersion(fixture.endpoint, 'old');
      expectSentinelsUnchanged(fixture);
    } finally {
      writeText(nextContinuePath, 'continue\r\n');
    }

    const completed = await secondRun.result;
    if (completed.status !== 0) {
      throw new Error(
        `manual-runtime adoption failed:\n${completed.stdout}\n${completed.stderr}`,
      );
    }
    await waitForVersion(fixture.endpoint, 'candidate');
    expect(`${completed.stdout}\n${completed.stderr}`).toContain(
      'Adopted the already-restored healthy previous runtime',
    );
    expect(fixture.legacyStartMarker).toBeDefined();
    expect(existsSync(fixture.legacyStartMarker!)).toBe(false);
    expectSentinelsUnchanged(fixture);
    expectMaintenanceReleased(fixture, completed);
  });
});
