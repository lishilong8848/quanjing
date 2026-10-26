import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const windowsTest = process.platform === 'win32' ? it : it.skip;

describe('unified access recovery activation', () => {
  let root = '';

  afterEach(() => {
    stopFixtureServer(root);
    if (root) {
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    }
    root = '';
  });

  windowsTest(
    'configures before stopping and verifies the exact newly started backend',
    async () => {
      root = mkdtempSync(join(tmpdir(), 'access-recovery-activation-'));
      const port = await reservePort();
      createFixture(root, port, {
        preconfiguredExtended: true,
        resetExtendedRoles: true,
      });

      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(root, 'run-recovery.ps1'),
        ],
        {
          cwd: root,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 90_000,
          env: {
            ...process.env,
            PUBLIC_BASE_URL: '',
            SERVER_HOST: 'localhost',
            HTTPS_CERT_PATH: '',
            HTTPS_KEY_PATH: '',
            LOCAL_ACCESS_DEPLOYMENT_ID: '',
          },
        },
      );
      if (result.status !== 0) {
        throw new Error(
          [
            result.error?.message || `Recovery exited with ${result.status}.`,
            `STDOUT:\n${result.stdout || ''}`,
            `STDERR:\n${result.stderr || ''}`,
          ].join('\n'),
        );
      }
      const output = result.stdout;

      expect(output).toContain(
        '[OK] New unified access backend is active locally.',
      );
      expect(output).toContain(
        '[WARN] Public URL verification was explicitly skipped.',
      );
      expect(output).toContain(
        '[OK] Deployment identity persisted for watchdog restarts.',
      );
      expect(output).toContain('[OK] Unified access recovery completed.');
      expect(output).toContain(
        '[OK] Existing core access configuration is ready; skipping password reset.',
      );
      expect(output).toContain(
        '[OK] Existing inventory access configuration is ready; skipping password reset.',
      );
      expect(output).toContain(
        '[INFO] Resetting purchase administrator and applicant passwords in .env.local...',
      );
      expect(output).toContain(
        '[INFO] Resetting construction administrator password in .env.local...',
      );
      expect(existsSync(join(root, '.maintenance.lock'))).toBe(false);
      expect(existsSync(join(root, '.env.local'))).toBe(true);
      const persistedEnvironment = readFileSync(
        join(root, '.env.local'),
        'utf8',
      );
      expect(persistedEnvironment).toMatch(
        /^LOCAL_ACCESS_DEPLOYMENT_ID=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/im,
      );
      expect(
        persistedEnvironment.match(/^LOCAL_ACCESS_DEPLOYMENT_ID=/gim),
      ).toHaveLength(1);
      expect(existsSync(join(root, 'purchase-config-called'))).toBe(true);
      expect(existsSync(join(root, 'construction-config-called'))).toBe(true);
    },
    100_000,
  );

  windowsTest(
    'restores the original environment without stopping the app when configuration verification fails',
    async () => {
      root = mkdtempSync(join(tmpdir(), 'access-recovery-rollback-'));
      const port = await reservePort();
      const originalEnvironment = createFixture(root, port, {
        incompletePurchase: true,
      });

      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(root, 'run-recovery.ps1'),
        ],
        {
          cwd: root,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 60_000,
          env: {
            ...process.env,
            PUBLIC_BASE_URL: '',
            SERVER_HOST: 'localhost',
            HTTPS_CERT_PATH: '',
            HTTPS_KEY_PATH: '',
            LOCAL_ACCESS_DEPLOYMENT_ID: '',
          },
        },
      );

      expect(result.status).not.toBe(0);
      expect(readFileSync(join(root, '.env.local'), 'utf8')).toBe(
        originalEnvironment,
      );
      expect(existsSync(join(root, 'stop-called'))).toBe(false);
      expect(existsSync(join(root, 'start-called'))).toBe(false);
      expect(
        readdirSync(root).filter((name) => name.endsWith('.recovery.bak')),
      ).toEqual([]);
    },
    70_000,
  );
});

function createFixture(
  root: string,
  port: number,
  options: {
    incompletePurchase?: boolean;
    preconfiguredExtended?: boolean;
    resetExtendedRoles?: boolean;
  } = {},
): string {
  mkdirSync(join(root, 'dist/server/common/access'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(
    resolve('deploy/apply-unified-access-recovery.ps1'),
    join(root, 'apply-unified-access-recovery.ps1'),
  );
  copyFileSync(
    resolve('scripts/verify-unified-access-config.mjs'),
    join(root, 'scripts/verify-unified-access-config.mjs'),
  );
  writeFileSync(join(root, 'package.json'), '{}\n', 'utf8');
  writeFileSync(join(root, '.env'), `SERVER_PORT=${port}\n`, 'utf8');
  writeFileSync(join(root, 'dist/server/main.js'), '// fixture\n', 'utf8');
  writeFileSync(
    join(root, 'dist/server/runtime-env.js'),
    '// fixture\n',
    'utf8',
  );
  writeFileSync(
    join(root, 'dist/server/common/access/unified-access.controller.js'),
    '// fixture\n',
    'utf8',
  );

  const coreHash = makeHash(1, 2);
  const inventoryHash = makeHash(3, 4);
  const purchaseHash = makeHash(6, 7);
  const constructionHash = makeHash(8, 9);
  const sessionSecret = Buffer.alloc(32, 5).toString('base64');
  const originalEnvironment = [
    'UNRELATED_SETTING=preserved',
    `LOCAL_ADMIN_PASSWORD_HASH=${coreHash}`,
    `LOCAL_EDITOR_PASSWORD_HASH=${coreHash}`,
    `LOCAL_ACCESS_SESSION_SECRET=${sessionSecret}`,
    ...['A', 'B', 'C', 'D', 'E', 'H'].map(
      (building) =>
        `LOCAL_INVENTORY_ADMIN_${building}_PASSWORD_HASH=${inventoryHash}`,
    ),
    ...(options.preconfiguredExtended
      ? [
          `LOCAL_PURCHASE_ADMIN_PASSWORD_HASH=${purchaseHash}`,
          ...['A', 'B', 'C', 'D', 'E', 'H'].map(
            (building) =>
              `LOCAL_PURCHASE_APPLICANT_${building}_PASSWORD_HASH=${purchaseHash}`,
          ),
          `LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH=${constructionHash}`,
        ]
      : []),
    '',
  ].join('\n');
  writeFileSync(join(root, '.env.local'), originalEnvironment, 'utf8');
  writeFileSync(
    join(root, 'scripts/configure-unified-access.ps1'),
    [
      "param([string]$Target = 'env', [string]$EnvFile = '.env.local')",
      "throw 'Core configuration should have been skipped.'",
    ].join('\r\n'),
    'utf8',
  );
  writeFileSync(
    join(root, 'scripts/configure-inventory-access.ps1'),
    [
      "param([string]$Target = 'env', [string]$EnvFile = '.env.local')",
      "throw 'Inventory configuration should have been skipped.'",
    ].join('\r\n'),
    'utf8',
  );
  const purchaseBuildings = options.incompletePurchase
    ? ['A', 'B', 'C', 'D', 'E']
    : ['A', 'B', 'C', 'D', 'E', 'H'];
  writeFileSync(
    join(root, 'scripts/configure-purchase-access.ps1'),
    [
      "param([string]$Target = 'env', [string]$EnvFile = '.env.local')",
      `$lines = @('LOCAL_PURCHASE_ADMIN_PASSWORD_HASH=${purchaseHash}', ${purchaseBuildings
        .map(
          (building) =>
            `'LOCAL_PURCHASE_APPLICANT_${building}_PASSWORD_HASH=${purchaseHash}'`,
        )
        .join(', ')})`,
      'Add-Content -LiteralPath $EnvFile -Value $lines -Encoding UTF8',
      "Set-Content -LiteralPath (Join-Path $PSScriptRoot '../purchase-config-called') -Value 'called' -Encoding ASCII",
      "& (Get-Command node -ErrorAction Stop).Source -e 'process.exit(0)'",
    ].join('\r\n'),
    'utf8',
  );
  writeFileSync(
    join(root, 'scripts/configure-construction-access.ps1'),
    [
      "param([string]$Target = 'env', [string]$EnvFile = '.env.local')",
      `$lines = @('LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH=${constructionHash}')`,
      'Add-Content -LiteralPath $EnvFile -Value $lines -Encoding UTF8',
      "Set-Content -LiteralPath (Join-Path $PSScriptRoot '../construction-config-called') -Value 'called' -Encoding ASCII",
      "& (Get-Command node -ErrorAction Stop).Source -e 'process.exit(0)'",
    ].join('\r\n'),
    'utf8',
  );
  writeFileSync(
    join(root, 'stop.ps1'),
    [
      "Set-Content -LiteralPath (Join-Path $PSScriptRoot 'stop-called') -Value 'called' -Encoding ASCII",
      "$pidPath = Join-Path $PSScriptRoot 'fixture-server.pid'",
      'if (Test-Path -LiteralPath $pidPath) {',
      '  $fixturePid = [int](Get-Content -Raw -LiteralPath $pidPath)',
      '  Stop-Process -Id $fixturePid -Force -ErrorAction SilentlyContinue',
      '  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue',
      '}',
    ].join('\r\n'),
    'utf8',
  );
  writeFileSync(
    join(root, 'start.ps1'),
    [
      "param([int]$Port = 0, [string]$HostName = '', [switch]$NoBrowser)",
      "Set-Content -LiteralPath (Join-Path $PSScriptRoot 'start-called') -Value 'called' -Encoding ASCII",
      '$node = (Get-Command node -ErrorAction Stop).Source',
      "$server = Join-Path $PSScriptRoot 'runtime-server.cjs'",
      "$stdout = Join-Path $PSScriptRoot 'runtime.out.log'",
      "$stderr = Join-Path $PSScriptRoot 'runtime.err.log'",
      '$process = Start-Process -FilePath $node -ArgumentList @("`"$server`"", [string]$Port) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru',
      "Set-Content -LiteralPath (Join-Path $PSScriptRoot 'fixture-server.pid') -Value $process.Id -Encoding ASCII",
      'Start-Sleep -Milliseconds 300',
    ].join('\r\n'),
    'utf8',
  );
  writeFileSync(
    join(root, 'runtime-server.cjs'),
    [
      "const http = require('node:http');",
      'const port = Number(process.argv[2]);',
      'const server = http.createServer((request, response) => {',
      "  response.setHeader('content-type', 'application/json');",
      '  response.end(JSON.stringify({ schemaVersion: 3, supportsInventoryAdministrator: true, deploymentId: process.env.LOCAL_ACCESS_DEPLOYMENT_ID || null, configuration: { core: true, inventory: true, purchase: true, construction: true } }), () => server.close());',
      '});',
      "server.listen(port, 'localhost');",
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(root, 'run-recovery.ps1'),
    [
      'function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName) return $null }',
      "function Get-NetTCPConnection { [CmdletBinding()] param([int]$LocalPort, [string]$State) return @() }",
      `& '${join(root, 'apply-unified-access-recovery.ps1').replace(/'/g, "''")}' -Port ${port} -SkipPublicCheck${options.resetExtendedRoles ? ' -ResetExtendedRoles' : ''}`,
      'exit $LASTEXITCODE',
    ].join('\r\n'),
    'utf8',
  );

  const files = listManifestFiles(root).map((path) => ({
    path: path.replace(/\\/g, '/'),
    sha256: createHash('sha256')
      .update(readFileSync(join(root, path)))
      .digest('hex')
      .toUpperCase(),
  }));
  writeFileSync(
    join(root, 'hotfix-manifest.json'),
    JSON.stringify({ schemaVersion: 1, files }),
    'utf8',
  );
  return originalEnvironment;
}

function listManifestFiles(root: string): string[] {
  return [
    'apply-unified-access-recovery.ps1',
    'dist/server/main.js',
    'dist/server/runtime-env.js',
    'dist/server/common/access/unified-access.controller.js',
    'scripts/configure-unified-access.ps1',
    'scripts/configure-inventory-access.ps1',
    'scripts/configure-purchase-access.ps1',
    'scripts/configure-construction-access.ps1',
    'scripts/verify-unified-access-config.mjs',
    'start.ps1',
    'stop.ps1',
    'runtime-server.cjs',
    'run-recovery.ps1',
  ].map((path) => relative(root, join(root, path)));
}

function makeHash(saltByte: number, derivedByte: number): string {
  return `scrypt$${Buffer.alloc(16, saltByte).toString('base64')}$${Buffer.alloc(32, derivedByte).toString('base64')}`;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  if (!port) throw new Error('Failed to reserve a fixture port.');
  return port;
}

function stopFixtureServer(root: string): void {
  if (!root) return;
  const pidPath = join(root, 'fixture-server.pid');
  if (!existsSync(pidPath)) return;
  const processId = Number(readFileSync(pidPath, 'utf8').trim());
  if (!Number.isInteger(processId) || processId <= 0) return;
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Stop-Process -Id ${processId} -Force -ErrorAction SilentlyContinue; Wait-Process -Id ${processId} -Timeout 5 -ErrorAction SilentlyContinue`,
      ],
      { windowsHide: true, timeout: 10_000 },
    );
  } catch {
    // The fixture process may already have exited.
  }
}
