import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const verifierPath = resolve(
  __dirname,
  '../../scripts/verify-hotfix-smoke-preflight.mjs',
);

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

const writeJson = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

const getFreePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolveClosed) =>
    server.close(() => resolveClosed()),
  );
  return port;
};

describe('hotfix smoke preflight', () => {
  let root: string;
  let workspaceRoot: string;
  let smokeParent: string;
  let appRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hotfix-smoke-preflight-'));
    workspaceRoot = join(root, 'workspace');
    smokeParent = join(root, 'smoke');
    appRoot = join(smokeParent, 'hotfix-smoke-current');
    mkdirSync(join(workspaceRoot, 'node_modules'), { recursive: true });
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true });
    mkdirSync(join(appRoot, 'scripts'), { recursive: true });
    writeJson(join(appRoot, 'package-lock.json'), {
      lockfileVersion: 3,
      packages: {},
    });
    writeFileSync(
      join(appRoot, 'scripts', 'postinstall.mjs'),
      '// postinstall\n',
    );
    writeFileSync(
      join(appRoot, 'scripts', 'ensure-feishu-card-ws-sdk-patch.mjs'),
      '// patch\n',
    );
    writeJson(join(appRoot, '.deps-ready.json'), {
      packageLock: sha256(join(appRoot, 'package-lock.json')),
      postinstallScript: sha256(join(appRoot, 'scripts', 'postinstall.mjs')),
      feishuCardPatchScript: sha256(
        join(appRoot, 'scripts', 'ensure-feishu-card-ws-sdk-patch.mjs'),
      ),
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = (port: number) =>
    spawnSync(
      process.execPath,
      [
        verifierPath,
        '--app-root',
        appRoot,
        '--workspace-root',
        workspaceRoot,
        '--smoke-parent',
        smokeParent,
        '--port',
        String(port),
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );

  it('accepts an isolated physical dependency tree with a matching stamp', async () => {
    const completed = run(await getFreePort());

    expect(completed.status).toBe(0);
    expect(JSON.parse(completed.stdout)).toMatchObject({
      success: true,
      dependencyTree: 'isolated-physical',
      dependencyStamp: 'matched',
      exclusiveSmoke: true,
      portAvailable: true,
    });
  });

  it('rejects a node_modules junction before it can mutate the shared tree', async () => {
    const sentinel = join(workspaceRoot, 'node_modules', 'sentinel.txt');
    writeFileSync(sentinel, 'keep\n');
    rmSync(join(appRoot, 'node_modules'), { recursive: true, force: true });
    symlinkSync(
      join(workspaceRoot, 'node_modules'),
      join(appRoot, 'node_modules'),
      'junction',
    );

    const completed = run(await getFreePort());

    expect(completed.status).not.toBe(0);
    expect(completed.stderr).toContain(
      'node_modules must be a physical directory',
    );
    expect(readFileSync(sentinel, 'utf8')).toBe('keep\n');
  });

  it('rejects dependency stamp drift before startup can invoke npm ci', async () => {
    writeFileSync(join(appRoot, 'package-lock.json'), '{"changed":true}\n');

    const completed = run(await getFreePort());

    expect(completed.status).not.toBe(0);
    expect(completed.stderr).toContain(
      'Dependency readiness stamp does not match',
    );
  });

  it('rejects another live smoke instance in the same parent', async () => {
    const sibling = join(smokeParent, 'hotfix-smoke-other');
    mkdirSync(sibling);
    writeJson(join(sibling, 'app.pid'), { pid: process.pid });

    const completed = run(await getFreePort());

    expect(completed.status).not.toBe(0);
    expect(completed.stderr).toContain(
      'Another hotfix smoke instance is active',
    );
  });

  it('rejects an occupied health port', async () => {
    const server = createServer();
    await new Promise<void>((resolveReady, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveReady);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const completed = run(port);
    await new Promise<void>((resolveClosed) =>
      server.close(() => resolveClosed()),
    );

    expect(completed.status).not.toBe(0);
    expect(completed.stderr).toContain('Health port is already in use');
  });
});
