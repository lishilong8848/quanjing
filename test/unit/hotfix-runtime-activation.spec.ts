import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { cancelHotfixInitialization, closeHotfixActivation, currentHotfixActivation, runHotfixInitialization } from '../../server/common/hotfix-runtime-activation';

const { journalChecksum } = require('../../scripts/hotfix-receipt-relay.cjs') as { journalChecksum: (value: Record<string, unknown>) => string };
const candidate = 'nantong-safe-full-runtime-hotfix-20261016-000002';

describe('process lifecycle binding to real local release proof', () => {
  let root: string, parent: string, owner: string, originalCwd: string;
  const transactionId = randomUUID();
  function transaction(phase: string) {
    const journal = { schemaVersion: 1, transactionId, deploymentId: candidate, appRoot: root, intent: 'deploy', phase,
      releaseFiles: [{ targetPath: 'package.json', baselineExisted: true, baselineSha256: 'a'.repeat(64), candidateSha256: 'b'.repeat(64) }] };
    writeFileSync(join(root, '.hotfix-transaction.json'), JSON.stringify({ ...journal, transactionChecksum: journalChecksum(journal) }));
  }
  function protectedRuntime() {
    mkdirSync(join(root, 'dist/server'), { recursive: true });
    writeFileSync(join(root, 'dist/server/hotfix-runtime-identity.json'), JSON.stringify({ schemaVersion: 1, activationProtocol: 'maintenance-commit-v1', deploymentId: candidate }));
    transaction('candidate-started');
    writeFileSync(join(root, '.maintenance.lock'), JSON.stringify({ schemaVersion: 1, pid: process.pid,
      processStartTime: new Date().toISOString(), transactionId, deploymentId: candidate, appRoot: root }));
  }
  beforeEach(() => {
    originalCwd = process.cwd(); parent = realpathSync(tmpdir()); root = mkdtempSync(join(parent, 'nt-release-binding-'));
    owner = randomUUID(); writeFileSync(join(root, '.test-owner'), owner, { flag: 'wx' }); process.chdir(root);
  });
  afterEach(async () => {
    try { await closeHotfixActivation(); }
    finally {
      process.chdir(originalCwd);
      const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
      if (!same(dirname(root), parent) || !/^nt-release-binding-[A-Za-z0-9]+$/.test(basename(root)) ||
          !same(realpathSync(root), root) || lstatSync(root).isSymbolicLink() || readFileSync(join(root, '.test-owner'), 'utf8') !== owner) throw Error('Unowned fixture');
      const check = (directory: string) => { for (const name of readdirSync(directory)) {
        const file = join(directory, name), stats = lstatSync(file);
        if (stats.isSymbolicLink() || !same(realpathSync(file), file)) throw Error('Unsafe fixture');
        if (stats.isDirectory()) check(file); else if (!stats.isFile() || stats.nlink !== 1) throw Error('Unsafe entry');
      } };
      check(root); rmSync(root, { recursive: true });
    }
  });

  it('binds native owners and main bootstrap to the same gate', async () => {
    const entered: string[] = [], service = {};
    protectedRuntime();
    const gate = currentHotfixActivation();
    expect(currentHotfixActivation()).toBe(gate);
    await runHotfixInitialization(service, () => { entered.push('write'); });
    expect(entered).toEqual([]);
    gate.completeBootstrap(); await gate.refresh();
    expect(entered).toEqual([]);
    transaction('committed'); await gate.refresh();
    expect(entered).toEqual(['write']);
    expect(gate.isAcceptingNewWork()).toBe(false);
    await runHotfixInitialization(service, () => { entered.push('duplicate'); });
    expect(entered).toEqual(['write']);
  });

  it('leaves an unmanaged native initialization synchronous with its awaited work', async () => {
    const entered: string[] = [], service = {};
    await runHotfixInitialization(service, async () => { entered.push('start'); await Promise.resolve(); entered.push('done'); });
    const gate = currentHotfixActivation(); gate.completeBootstrap(); await gate.refresh();
    expect(entered).toEqual(['start', 'done']); expect(gate.isAcceptingNewWork()).toBe(true);
  });

  it('cancels the real deferred owner before native cleanup proceeds', async () => {
    const entered: string[] = [], service = {}; protectedRuntime();
    await runHotfixInitialization(service, () => { entered.push('write'); });
    await cancelHotfixInitialization(service);
    transaction('committed'); const gate = currentHotfixActivation(); gate.completeBootstrap(); await gate.refresh();
    expect(entered).toEqual([]);
  });

  it('closes the same root gate and will not resurrect its registered owners', async () => {
    const entered: string[] = [], service = {}; protectedRuntime();
    const gate = currentHotfixActivation();
    await runHotfixInitialization(service, () => { entered.push('write'); });
    await closeHotfixActivation(); transaction('committed'); gate.completeBootstrap(); await gate.refresh();
    expect(gate.status().phase).toBe('closed'); expect(entered).toEqual([]);
  });
});
