import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

const ROOT = resolve(__dirname, '../..');
const describeWindows = process.platform === 'win32' ? describe : describe.skip;

jest.setTimeout(60_000);

type WatchdogResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runWatchdog(scriptPath: string): Promise<WatchdogResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-TimeoutSeconds',
        '2',
        '-CallbackFailureThreshold',
        '1',
        '-CallbackRetryDelaySeconds',
        '0',
      ],
      {
        cwd: ROOT,
        windowsHide: true,
        env: {
          ...process.env,
          HTTPS_CERT_PATH: '',
          HTTPS_KEY_PATH: '',
          CLIENT_BASE_PATH: '',
          FEISHU_APP_ID: '',
          FEISHU_APP_SECRET: '',
          FEISHU_WAREHOUSE_APP_TOKEN: '',
          FEISHU_WAREHOUSE_SOURCE_URL: '',
          FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID: '',
          FEISHU_CARD_ACTION_CONSUMER_ENABLED: '',
          OVERTIME_WORKFLOW_PROGRAM_ENABLED: 'false',
          PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'false',
          PURCHASE_MANAGER_APPROVAL_CARD_ENABLED: 'false',
        },
      },
    );
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('watchdog test process timed out'));
    }, 15_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timeout);
      resolveResult({ status, stdout, stderr });
    });
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('HTTP fixture did not expose a TCP port');
  }
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

describeWindows('watchdog maintenance lock race', () => {
  let fixtureRoot = '';
  let server: Server | undefined;
  const lockHolders: ChildProcess[] = [];

  afterEach(async () => {
    if (server) {
      await close(server);
      server = undefined;
    }
    for (const holder of lockHolders.splice(0)) {
      if (holder.exitCode === null) {
        const closed = new Promise<void>((resolveClosed) => {
          holder.once('close', () => resolveClosed());
        });
        spawnSync(
          'taskkill.exe',
          ['/PID', String(holder.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' },
        );
        await Promise.race([
          closed,
          new Promise<void>((resolveWait) => setTimeout(resolveWait, 2_000)),
        ]);
      }
    }
    if (fixtureRoot) {
      rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = '';
    }
  });

  function prepareFixture(port: number): {
    lockPath: string;
    lifecycleLockPath: string;
    markerPath: string;
    watchdogPath: string;
  } {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'watchdog-lock-race-'));
    const watchdogPath = join(fixtureRoot, 'watchdog.ps1');
    const markerPath = join(fixtureRoot, 'restart-called.marker');
    const lockPath = join(fixtureRoot, '.maintenance.lock');
    const lifecycleLockPath = join(fixtureRoot, '.app-lifecycle.lock');

    copyFileSync(join(ROOT, 'deploy', 'watchdog.ps1'), watchdogPath);
    mkdirSync(join(fixtureRoot, 'dist', 'server'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'dist', 'server', 'main.js'), '', 'utf8');
    writeFileSync(join(fixtureRoot, '.env'), `SERVER_PORT=${port}\r\n`, 'utf8');
    writeFileSync(
      join(fixtureRoot, 'start.ps1'),
      [
        'param([switch]$NoBrowser)',
        "$markerPath = Join-Path $PSScriptRoot 'restart-called.marker'",
        "Set-Content -LiteralPath $markerPath -Value 'called' -Encoding UTF8",
        'exit 0',
      ].join('\r\n'),
      'utf8',
    );

    return { lockPath, lifecycleLockPath, markerPath, watchdogPath };
  }

  async function holdLifecycleLock(lockPath: string): Promise<void> {
    const markerPath = `${lockPath}.held`;
    const escapedLock = lockPath.replace(/'/g, "''");
    const escapedMarker = markerPath.replace(/'/g, "''");
    const holder = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        [
          `$stream=[System.IO.File]::Open('${escapedLock}',[System.IO.FileMode]::OpenOrCreate,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)`,
          `Set-Content -LiteralPath '${escapedMarker}' -Value held -Encoding UTF8`,
          'try { Start-Sleep -Seconds 20 } finally { $stream.Dispose() }',
        ].join('; '),
      ],
      { cwd: ROOT, windowsHide: true, stdio: 'ignore' },
    );
    lockHolders.push(holder);
    const deadline = Date.now() + 15_000;
    while (!existsSync(markerPath)) {
      if (Date.now() >= deadline) {
        throw new Error('lifecycle lock holder did not become ready');
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }

  it('skips an app-health restart when maintenance starts after the initial lock check', async () => {
    let lockPath = '';
    server = createServer((_request, response) => {
      writeFileSync(lockPath, 'deployment-in-progress', 'utf8');
      response.statusCode = 503;
      response.end('unhealthy');
    });
    const port = await listen(server);
    const fixture = prepareFixture(port);
    lockPath = fixture.lockPath;

    const result = await runWatchdog(fixture.watchdogPath);

    expect(result.status).toBe(0);
    expect(existsSync(fixture.lockPath)).toBe(true);
    expect(existsSync(fixture.markerPath)).toBe(false);
    expect(result.stdout).toContain(
      'Deployment maintenance is active; watchdog restart skipped.',
    );
  });

  it('skips a callback-health restart when maintenance starts after the initial lock check', async () => {
    let lockPath = '';
    server = createServer((request, response) => {
      if (request.url === '/api/feishu-card-callback/health') {
        writeFileSync(lockPath, 'deployment-in-progress', 'utf8');
        response.statusCode = 503;
        response.end('callback unhealthy');
        return;
      }
      response.statusCode = 200;
      response.end('healthy');
    });
    const port = await listen(server);
    const fixture = prepareFixture(port);
    lockPath = fixture.lockPath;
    writeFileSync(
      join(fixtureRoot, '.feishu-card-action-consumer-release'),
      'enabled',
      'utf8',
    );
    writeFileSync(
      join(fixtureRoot, '.env'),
      [
        `SERVER_PORT=${port}`,
        'OVERTIME_WORKFLOW_PROGRAM_ENABLED=true',
      ].join('\r\n'),
      'utf8',
    );

    const result = await runWatchdog(fixture.watchdogPath);

    expect(result.status).toBe(0);
    expect(existsSync(fixture.lockPath)).toBe(true);
    expect(existsSync(fixture.markerPath)).toBe(false);
    expect(result.stdout).toContain(
      'Deployment maintenance is active; watchdog restart skipped.',
    );
  });

  it('skips an app-health restart when another lifecycle owner wins after the initial check', async () => {
    server = createServer((_request, response) => {
      response.statusCode = 503;
      response.end('unhealthy');
    });
    const port = await listen(server);
    const fixture = prepareFixture(port);
    await holdLifecycleLock(fixture.lifecycleLockPath);

    const result = await runWatchdog(fixture.watchdogPath);

    expect(result.status).toBe(0);
    expect(existsSync(fixture.markerPath)).toBe(false);
    expect(result.stdout).toContain(
      'Application lifecycle is busy; watchdog restart skipped.',
    );
  });

  it('skips a callback-health restart when another lifecycle owner wins before restart', async () => {
    server = createServer((request, response) => {
      if (request.url === '/api/feishu-card-callback/health') {
        response.statusCode = 503;
        response.end('callback unhealthy');
        return;
      }
      response.statusCode = 200;
      response.end('healthy');
    });
    const port = await listen(server);
    const fixture = prepareFixture(port);
    await holdLifecycleLock(fixture.lifecycleLockPath);
    writeFileSync(
      join(fixtureRoot, '.feishu-card-action-consumer-release'),
      'enabled',
      'utf8',
    );
    writeFileSync(
      join(fixtureRoot, '.env'),
      [
        `SERVER_PORT=${port}`,
        'OVERTIME_WORKFLOW_PROGRAM_ENABLED=true',
      ].join('\r\n'),
      'utf8',
    );

    const result = await runWatchdog(fixture.watchdogPath);

    expect(result.status).toBe(0);
    expect(existsSync(fixture.markerPath)).toBe(false);
    expect(result.stdout).toContain(
      'Application lifecycle is busy; watchdog restart skipped.',
    );
  });

  it('restarts an unhealthy app when no maintenance or lifecycle owner exists', async () => {
    server = createServer((_request, response) => {
      response.statusCode = 503;
      response.end('unhealthy');
    });
    const port = await listen(server);
    const fixture = prepareFixture(port);

    const result = await runWatchdog(fixture.watchdogPath);

    expect(result.status).toBe(0);
    expect(existsSync(fixture.markerPath)).toBe(true);
    expect(existsSync(fixture.lockPath)).toBe(false);
  });

  it('preserves a dead transaction-bound maintenance owner and requires installer recovery', async () => {
    server = createServer((_request, response) => {
      response.statusCode = 503;
      response.end('unhealthy');
    });
    const port = await listen(server);
    const fixture = prepareFixture(port);
    const transactionId = '9fc471db-297a-4b6f-bb01-132c4076ed45';
    const deploymentId = 'watchdog-stale-owner-fixture';
    writeFileSync(
      join(fixtureRoot, '.hotfix-transaction.json'),
      JSON.stringify({
        schemaVersion: 1,
        transactionId,
        deploymentId,
        appRoot: fixtureRoot,
        intent: 'deploy',
        phase: 'runtime-stopped',
        releaseFiles: [],
        transactionChecksum: 'a'.repeat(64),
      }),
      'utf8',
    );
    writeFileSync(
      fixture.lockPath,
      JSON.stringify({
        schemaVersion: 1,
        pid: 2_147_483_000,
        processStartTime: '2000-01-01T00:00:00.000Z',
        transactionId,
        deploymentId,
        appRoot: fixtureRoot,
      }),
      'utf8',
    );

    const result = await runWatchdog(fixture.watchdogPath);

    expect(result.status).toBe(0);
    expect(existsSync(fixture.lockPath)).toBe(true);
    expect(existsSync(fixture.markerPath)).toBe(false);
    expect(result.stdout).toContain('installer transaction recovery is required');
  });

  it('never deletes or restarts through a corrupt read-only maintenance marker', async () => {
    server = createServer((_request, response) => {
      response.statusCode = 503;
      response.end('unhealthy');
    });
    const port = await listen(server);
    const fixture = prepareFixture(port);
    writeFileSync(fixture.lockPath, 'corrupt-maintenance-owner', 'utf8');
    spawnSync('attrib.exe', ['+R', fixture.lockPath], {
      windowsHide: true,
      stdio: 'ignore',
    });

    try {
      const result = await runWatchdog(fixture.watchdogPath);

      expect(result.status).toBe(0);
      expect(existsSync(fixture.lockPath)).toBe(true);
      expect(existsSync(fixture.markerPath)).toBe(false);
      expect(result.stdout).toContain('installer transaction recovery is required');
    } finally {
      spawnSync('attrib.exe', ['-R', fixture.lockPath], {
        windowsHide: true,
        stdio: 'ignore',
      });
    }
  });
});
