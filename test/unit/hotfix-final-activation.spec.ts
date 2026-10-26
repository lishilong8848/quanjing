import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { inspectHotfixReleaseProof } from '../../server/common/hotfix-release-proof';
import { createHotfixActivationMiddleware } from '../../server/common/hotfix-http-activation';
import type { HotfixActivation } from '../../server/common/hotfix-activation';
const ts = require('typescript');
const selfsigned = require('selfsigned');
const { journalChecksum, receiptChecksum } = require('../../scripts/hotfix-receipt-relay.cjs');
const { verifyHotfixActivation } = require('../../scripts/verify-hotfix-activation.cjs') as {
  verifyHotfixActivation(options: { appRoot: string; packageRoot: string; healthEndpoint: string; timeoutMs?: number }): Promise<{ deploymentId: string; phase: string; pid: number }>;
};
const deploymentId = 'nantong-safe-full-runtime-hotfix-20261016-000006';
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const sourceRoot = resolve(__dirname, '../..');
const compiledProof = ts.transpileModule(readFileSync(join(sourceRoot, 'server/common/hotfix-release-proof.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const nodeSha256 = digest(readFileSync(process.execPath));

describe('final activation proof after the unchanged inner installer', () => {
  let folder: string, parent: string, owner: string, appRoot: string, packageRoot: string, endpoint: string, server: Server;
  let manifest: Record<string, any>, phase: ReturnType<HotfixActivation['status']>['phase'], runtimeId: string, legacy: boolean, ready: boolean;
  let oldEnv: NodeJS.ProcessEnv, transition: NodeJS.Timeout | undefined;
  const put = (file: string, bytes: string | Buffer) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes); };
  const json = (file: string, value: unknown) => put(file, JSON.stringify(value));
  const record = (path: string, bytes: string | Buffer) => ({ path, size: Buffer.byteLength(bytes), sha256: digest(bytes) });
  const saveManifest = () => json(join(packageRoot, 'hotfix-manifest.json'), manifest);
  const options = () => ({ appRoot, packageRoot, healthEndpoint: endpoint, timeoutMs: 800 });
  function application() {
    const app = express();
    app.use(createHotfixActivationMiddleware({ status: () => ({ phase, deploymentId: runtimeId }), isAcceptingNewWork: () => phase === 'active' }, '/api'));
    app.use((_req, res, next) => {
      if (legacy) for (const name of ['X-Nantong-Hotfix-Activation', 'X-Nantong-Hotfix-Deployment', 'X-Nantong-Hotfix-Accepting']) res.removeHeader(name);
      next();
    });
    app.get('/api/access/session', (_req, res) => res.json({ identity: null, role: 'guest', capabilities: {} }));
    app.get('/api/feishu-card-callback/health', (_req, res) => res.json({ enabled: true, ready }));
    return app;
  }
  async function listen(next: Server, protocol = 'http') {
    server = next;
    await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
    endpoint = `${protocol}://127.0.0.1:${(server.address() as AddressInfo).port}/api/access/session`;
  }
  const close = () => new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  beforeEach(async () => {
    oldEnv = process.env; process.env = { ...oldEnv }; delete process.env.HTTPS_CERT_PATH; delete process.env.HTTPS_CA_PATH;
    parent = realpathSync(tmpdir()); folder = mkdtempSync(join(parent, 'nt-final-activation-')); owner = randomUUID();
    put(join(folder, '.test-owner'), owner); appRoot = join(folder, 'app'); packageRoot = join(folder, 'payload');
    const identity = JSON.stringify({ schemaVersion: 1, activationProtocol: 'maintenance-commit-v1', deploymentId });
    const runtime = [record('dist/server/main.js', '// synthetic main'), record('dist/server/hotfix-runtime-identity.json', identity),
      record('dist/server/common/hotfix-release-proof.js', compiledProof), record('dist/server/runtime-env.js', '// synthetic environment; TLS paths supplied by the test only')];
    for (const item of runtime) {
      const bytes = item.path.endsWith('/main.js') ? '// synthetic main' : item.path.endsWith('/hotfix-runtime-identity.json') ? identity : item.path.endsWith('/hotfix-release-proof.js') ? compiledProof : '// synthetic environment; TLS paths supplied by the test only';
      put(join(appRoot, item.path), bytes); put(join(packageRoot, item.path), bytes);
    }
    const verifier = readFileSync(join(sourceRoot, 'scripts/verify-hotfix-activation.cjs'));
    put(join(appRoot, 'scripts/verify-hotfix-activation.cjs'), verifier); put(join(packageRoot, 'release-root/scripts/verify-hotfix-activation.cjs'), verifier);
    const client = [record('dist/client/index.html', '<script src="main.js"></script>'), record('dist/client/main.js', '// synthetic client')];
    for (const item of client) put(join(appRoot, item.path), item.path.endsWith('.html') ? '<script src="main.js"></script>' : '// synthetic client');
    const release = { targetPath: 'scripts/verify-hotfix-activation.cjs', size: verifier.length, sha256: digest(verifier) };
    const fixedHash = 'c'.repeat(64);
    const receipt = { schemaVersion: 2, receiptType: 'nantong-hotfix-installed-release', deploymentId, appRoot,
      releaseToolFingerprint: fixedHash, installerSha256: fixedHash, recoveryLauncherSha256: fixedHash, dependencyVerifierSha256: fixedHash, clientVerifierSha256: fixedHash,
      dependencyProofAlgorithm: 'sha256-package-lock-production-closure-v1', dependencyLockPhysicalTreeFingerprint: fixedHash, dependencyInstalledPhysicalTreeFingerprint: fixedHash,
      dependencyPackageCount: 1, dependencyFileCount: 1, dependencyBytes: 1, buildFingerprint: fixedHash, runtimeClosureFingerprint: fixedHash,
      activeClientProofAlgorithm: 'sha256-active-client-closure-v2', activeClientAssetFingerprint: fixedHash, activeClientChunkCount: 1, activeClientAssetCount: 2,
      runtimeFiles: runtime, activeClientFiles: client, releaseFiles: [release] };
    json(join(appRoot, '.hotfix-installed-release.json'), { ...receipt, receiptChecksum: receiptChecksum(receipt) });
    const journal = { schemaVersion: 1, transactionId: randomUUID(), deploymentId, appRoot, intent: 'deploy', phase: 'finalized',
      releaseFiles: [{ targetPath: release.targetPath, baselineExisted: false, baselineSha256: '', candidateSha256: release.sha256 }] };
    json(join(appRoot, '.hotfix-transaction.json'), { ...journal, transactionChecksum: journalChecksum(journal) });
    json(join(appRoot, 'app.pid'), { schemaVersion: 1, pid: process.pid, startTime: new Date().toISOString(), appRoot, mainFile: join(appRoot, 'dist/server/main.js') });
    manifest = { schemaVersion: 6, releaseMode: 'complete-runtime-atomic-switch', packageId: deploymentId, buildNodeVersion: process.versions.node, buildNodeSha256: nodeSha256,
      buildFingerprint: fixedHash, runtimeClosureFingerprint: fixedHash, activeClientAssetFingerprint: fixedHash,
      payloadFiles: runtime, releaseFiles: [{ ...release, path: 'release-root/' + release.targetPath }] };
    saveManifest(); phase = 'active'; runtimeId = deploymentId; legacy = false; ready = true;
    expect(inspectHotfixReleaseProof(appRoot).mode).toBe('installed');
    await listen(createServer(application()));
  });
  afterEach(async () => {
    if (transition) clearTimeout(transition); transition = undefined;
    try { await close(); } finally {
      process.env = oldEnv;
      const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
      if (!same(dirname(folder), parent) || !/^nt-final-activation-[A-Za-z0-9]+$/.test(basename(folder)) || !same(realpathSync(folder), folder) ||
          lstatSync(folder).isSymbolicLink() || readFileSync(join(folder, '.test-owner'), 'utf8') !== owner) throw Error('Unowned fixture');
      const check = (directory: string) => { for (const name of readdirSync(directory)) { const file = join(directory, name), stat = lstatSync(file);
        if (stat.isSymbolicLink() || !same(realpathSync(file), file)) throw Error('Unsafe fixture');
        if (stat.isDirectory()) check(file); else if (!stat.isFile() || stat.nlink !== 1) throw Error('Unsafe entry');
      } }; check(folder); rmSync(folder, { recursive: true });
    }
  });
  it('binds current metadata, real HTTP headers and WS health to the same deployment', async () => {
    await expect(verifyHotfixActivation(options())).resolves.toMatchObject({ deploymentId, phase: 'active', pid: process.pid });
  });
  it('does not accept an old process with a successful session body but missing activation headers', async () => {
    legacy = true; await expect(verifyHotfixActivation(options())).rejects.toThrow('HOTFIX_ACTIVATION_WRONG_PROCESS');
  });
  it('does not accept a different deployment serving the correct health URLs', async () => {
    runtimeId = deploymentId.replace('000006', '000007'); await expect(verifyHotfixActivation(options())).rejects.toThrow('HOTFIX_ACTIVATION_WRONG_PROCESS');
  });
  it('waits for initialization rather than treating committed runtime health as final activation', async () => {
    phase = 'initializing'; transition = setTimeout(() => { phase = 'active'; }, 20);
    await expect(verifyHotfixActivation(options())).resolves.toMatchObject({ phase: 'active' });
  });
  it('rejects a failed gate immediately', async () => {
    phase = 'failed'; await expect(verifyHotfixActivation(options())).rejects.toThrow('HOTFIX_ACTIVATION_FAILED');
  });
  it('requires a finalized transaction, not merely a receipt or healthy endpoint', async () => {
    const file = join(appRoot, '.hotfix-transaction.json'), value = JSON.parse(readFileSync(file, 'utf8'));
    value.phase = 'committed'; value.transactionChecksum = journalChecksum(value); json(file, value);
    await expect(verifyHotfixActivation(options())).rejects.toThrow('HOTFIX_ACTIVATION_NOT_FINALIZED');
  });
  it('rejects changed policy module bytes before importing them', async () => {
    put(join(packageRoot, 'dist/server/common/hotfix-release-proof.js'), 'throw Error("must not load changed code")');
    await expect(verifyHotfixActivation(options())).rejects.toThrow('HOTFIX_ACTIVATION_FILE_MISMATCH');
  });
  it('rejects a verifier not bound to the trusted payload manifest', async () => {
    manifest.releaseFiles[0].sha256 = 'a'.repeat(64); saveManifest();
    await expect(verifyHotfixActivation(options())).rejects.toThrow('HOTFIX_ACTIVATION_FILE_MISMATCH');
  });
  it('does not accept HTTP200 when an enabled WS transport is not ready', async () => {
    ready = false; await expect(verifyHotfixActivation({ ...options(), timeoutMs: 150 })).rejects.toThrow('HOTFIX_ACTIVATION_TIMEOUT');
  });
  it('runs the actual Node verifier CLI without blocking the server it must check', async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
      const child = spawn(process.execPath, [join(packageRoot, 'release-root/scripts/verify-hotfix-activation.cjs'), '--app-root', appRoot, '--package-root', packageRoot,
        '--health-endpoint', endpoint, '--timeout-ms', '1500'], { windowsHide: true, timeout: 5_000 });
      let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
      child.on('error', fail); child.on('close', code => done({ code, stdout, stderr }));
    });
    expect(result.stderr).toBe(''); expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ deploymentId, phase: 'active', pid: process.pid });
  });
  it('verifies a self-signed local HTTPS peer using the configured certificate instead of disabling TLS verification', async () => {
    const pair = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, days: 1, algorithm: 'sha256' });
    put(join(appRoot, 'synthetic-cert.pem'), pair.cert); process.env.HTTPS_CERT_PATH = join(appRoot, 'synthetic-cert.pem');
    await close(); await listen(createHttpsServer({ key: pair.private, cert: pair.cert }, application()) as Server, 'https');
    await expect(verifyHotfixActivation(options())).resolves.toMatchObject({ deploymentId, phase: 'active' });
  });
});
