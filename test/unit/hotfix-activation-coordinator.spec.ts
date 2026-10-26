import { HotfixActivation } from '../../server/common/hotfix-activation';
import type { HotfixReleaseProof } from '../../server/common/hotfix-release-proof';

function controlled(mode: HotfixReleaseProof['mode'] = 'candidate-held') {
  let proof: HotfixReleaseProof = {
    mode, deploymentId: 'candidate', transactionId: 'transaction', maintenance: mode !== 'unmanaged',
    canInitialize: mode === 'unmanaged', canAcceptNewWork: mode === 'unmanaged',
  };
  let marker = proof.maintenance, reads = 0;
  const gate = new HotfixActivation({ inspect: () => { reads++; return proof; }, hasMaintenance: () => marker });
  return { gate, reads: () => reads,
    set: (next: Partial<HotfixReleaseProof>) => { proof = { ...proof, ...next }; marker = proof.maintenance; },
    marker: (value: boolean) => { marker = value; } };
}
function pending() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('hotfix lifecycle activation coordinator', () => {
  it('keeps ordinary initialization awaited before opening the application', async () => {
    const { gate } = controlled('unmanaged'), work = pending(), entered: string[] = [];
    const startup = gate.run({}, async () => { entered.push('start'); await work.promise; entered.push('end'); });
    await Promise.resolve();
    expect(entered).toEqual(['start']);
    expect(gate.isAcceptingNewWork()).toBe(false);
    work.resolve(); await startup;
    gate.completeBootstrap(); await gate.refresh();
    expect(entered).toEqual(['start', 'end']);
    expect(gate.isAcceptingNewWork()).toBe(true);
    await gate.close();
  });

  it('registers protected initialization without executing it or blocking Nest bootstrap', async () => {
    const { gate } = controlled(), entered: string[] = [];
    await gate.run({}, () => { entered.push('write'); });
    gate.completeBootstrap(); await gate.refresh();
    expect(entered).toEqual([]);
    expect(gate.isAcceptingNewWork()).toBe(false);
    expect(gate.status().phase).toBe('waiting');
    await gate.close();
  });

  it('starts once after commitment but only opens new work after final proof and lock removal', async () => {
    const scope = controlled(), owner = {}, entered: string[] = [];
    await scope.gate.run(owner, () => { entered.push('write'); });
    scope.set({ mode: 'candidate-committed', canInitialize: true });
    await scope.gate.refresh();
    expect(entered).toEqual([]);
    scope.gate.completeBootstrap(); await scope.gate.refresh();
    await scope.gate.run(owner, () => { entered.push('duplicate'); });
    await scope.gate.refresh();
    expect(entered).toEqual(['write']);
    expect(scope.gate.isAcceptingNewWork()).toBe(false);
    scope.set({ mode: 'installed', maintenance: false, canAcceptNewWork: true });
    await scope.gate.refresh();
    expect(scope.gate.isAcceptingNewWork()).toBe(true);
    await scope.gate.close();
  });

  it('awaits a registered dependency when the parent initializer requests it without running either twice', async () => {
    const scope = controlled(), parent = {}, dependency = {}, entered: string[] = [];
    const initializeDependency = async () => { entered.push('dependency'); };
    await scope.gate.run(parent, async () => {
      entered.push('parent-start'); await scope.gate.run(dependency, initializeDependency); entered.push('parent-end');
    });
    await scope.gate.run(dependency, initializeDependency);
    scope.set({ mode: 'candidate-committed', canInitialize: true });
    scope.gate.completeBootstrap(); await scope.gate.refresh();
    expect(entered).toEqual(['parent-start', 'dependency', 'parent-end']);
    await scope.gate.close();
  });

  it('waits for in-progress initialization instead of starting a second copy on refresh', async () => {
    const scope = controlled(), work = pending(), entered: string[] = [];
    await scope.gate.run({}, async () => { entered.push('start'); await work.promise; });
    scope.set({ mode: 'candidate-committed', canInitialize: true });
    scope.gate.completeBootstrap();
    const first = scope.gate.refresh(), second = scope.gate.refresh();
    await Promise.resolve(); await Promise.resolve();
    expect(entered).toEqual(['start']);
    expect(scope.gate.isAcceptingNewWork()).toBe(false);
    work.resolve(); await Promise.all([first, second]);
    expect(entered).toEqual(['start']);
    await scope.gate.close();
  });

  it('cancels a deferred owner before it can create timers during shutdown', async () => {
    const scope = controlled(), owner = {}, entered: string[] = [];
    await scope.gate.run(owner, () => { entered.push('start'); });
    await scope.gate.cancel(owner);
    scope.set({ mode: 'candidate-committed', canInitialize: true });
    scope.gate.completeBootstrap(); await scope.gate.refresh();
    await scope.gate.run(owner, () => { entered.push('late'); });
    expect(entered).toEqual([]);
    await scope.gate.close();
  });

  it('waits for a running owner before its native destroy hook continues', async () => {
    const scope = controlled('unmanaged'), owner = {}, work = pending(), entered: string[] = [];
    const startup = scope.gate.run(owner, async () => { entered.push('start'); await work.promise; entered.push('finished'); });
    await Promise.resolve();
    const destroyed = scope.gate.cancel(owner).then(() => { entered.push('destroy'); });
    await Promise.resolve();
    expect(entered).toEqual(['start']);
    work.resolve(); await Promise.all([startup, destroyed]);
    expect(entered).toEqual(['start', 'finished', 'destroy']);
    await scope.gate.close();
  });

  it('retains initialization failure and never reports business readiness or executes later owners', async () => {
    const scope = controlled(), entered: string[] = [];
    await scope.gate.run({}, () => { throw new Error('private upstream detail'); });
    await scope.gate.run({}, () => { entered.push('later'); });
    scope.set({ mode: 'candidate-committed', canInitialize: true });
    scope.gate.completeBootstrap();
    await expect(scope.gate.refresh()).rejects.toThrow('HOTFIX_INITIALIZATION_FAILED');
    expect(entered).toEqual([]);
    expect(scope.gate.status()).toMatchObject({ phase: 'failed', reason: 'HOTFIX_INITIALIZATION_FAILED' });
    expect(JSON.stringify(scope.gate.status())).not.toContain('private upstream detail');
    expect(scope.gate.isAcceptingNewWork()).toBe(false);
    await scope.gate.close();
  });

  it('fails closed when the proof changes to a different deployment identity', async () => {
    const scope = controlled(), entered: string[] = [];
    await scope.gate.run({}, () => { entered.push('write'); });
    scope.set({ mode: 'installed', deploymentId: 'other-candidate', maintenance: false, canInitialize: true, canAcceptNewWork: true });
    scope.gate.completeBootstrap();
    await expect(scope.gate.refresh()).rejects.toThrow('HOTFIX_RUNTIME_IDENTITY_CHANGED');
    expect(entered).toEqual([]);
    expect(scope.gate.isAcceptingNewWork()).toBe(false);
    await scope.gate.close();
  });

  it('does not parse the whole receipt per request and requires fresh proof after observing a new marker', async () => {
    const scope = controlled('unmanaged');
    scope.gate.completeBootstrap(); await scope.gate.refresh();
    const reads = scope.reads();
    for (let i = 0; i < 100; i++) expect(scope.gate.isAcceptingNewWork()).toBe(true);
    expect(scope.reads()).toBe(reads);
    scope.marker(true); expect(scope.gate.isAcceptingNewWork()).toBe(false);
    scope.marker(false); expect(scope.gate.isAcceptingNewWork()).toBe(false);
    await scope.gate.refresh(); expect(scope.gate.isAcceptingNewWork()).toBe(true);
    await scope.gate.close();
  });

  it('closes without launching pending owners even if commitment arrives later', async () => {
    const scope = controlled(), entered: string[] = [];
    await scope.gate.run({}, () => { entered.push('write'); });
    await scope.gate.close();
    scope.set({ mode: 'candidate-committed', canInitialize: true });
    scope.gate.completeBootstrap(); await scope.gate.refresh();
    expect(entered).toEqual([]);
    expect(scope.gate.status().phase).toBe('closed');
    expect(scope.gate.isAcceptingNewWork()).toBe(false);
  });

  it('waits for the running initializer at close and does not start the next owner', async () => {
    const scope = controlled(), work = pending(), entered: string[] = [];
    await scope.gate.run({}, async () => { entered.push('start'); await work.promise; entered.push('end'); });
    await scope.gate.run({}, () => { entered.push('second'); });
    scope.set({ mode: 'candidate-committed', canInitialize: true }); scope.gate.completeBootstrap();
    const refresh = scope.gate.refresh();
    await Promise.resolve(); await Promise.resolve();
    let closed = false;
    const close = scope.gate.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    work.resolve(); await Promise.all([refresh, close]);
    expect(entered).toEqual(['start', 'end']);
    expect(scope.gate.status().phase).toBe('closed');
    expect(scope.gate.isAcceptingNewWork()).toBe(false);
  });

  it('rejects a damaged proof without running a protected initializer', async () => {
    const scope = controlled(), entered: string[] = [];
    await scope.gate.run({}, () => { entered.push('write'); });
    scope.set({ mode: 'invalid', canInitialize: false, canAcceptNewWork: false }); scope.gate.completeBootstrap();
    await expect(scope.gate.refresh()).rejects.toThrow('HOTFIX_INVALID_RELEASE_PROOF');
    expect(entered).toEqual([]);
    await scope.gate.close();
  });

  it('does not launch remaining owners after initialization permission is lost', async () => {
    const scope = controlled(), entered: string[] = [];
    await scope.gate.run({}, () => {
      entered.push('first'); scope.set({ mode: 'candidate-held', canInitialize: false });
    });
    await scope.gate.run({}, () => { entered.push('second'); });
    scope.set({ mode: 'candidate-committed', canInitialize: true }); scope.gate.completeBootstrap();
    await expect(scope.gate.refresh()).rejects.toThrow('HOTFIX_INITIALIZATION_PERMISSION_LOST');
    expect(entered).toEqual(['first']);
    await scope.gate.close();
  });

  it('does not automatically retry a failed initializer after later valid proof', async () => {
    const scope = controlled(); let attempts = 0;
    await scope.gate.run({}, () => { attempts++; throw new Error('fail'); });
    scope.set({ mode: 'candidate-committed', canInitialize: true }); scope.gate.completeBootstrap();
    await expect(scope.gate.refresh()).rejects.toThrow('HOTFIX_INITIALIZATION_FAILED');
    scope.set({ mode: 'installed', maintenance: false, canAcceptNewWork: true });
    await expect(scope.gate.refresh()).rejects.toThrow('HOTFIX_INITIALIZATION_FAILED');
    expect(attempts).toBe(1);
    await scope.gate.close();
  });

  it('refuses new lifecycle registration after close', async () => {
    const { gate } = controlled(); await gate.close();
    await expect(gate.run({}, () => { throw new Error('must not enter'); })).rejects.toThrow('HOTFIX_ACTIVATION_CLOSED');
  });

  it('rechecks a detected atomic proof replacement before initializing, without opening on invalid bytes', async () => {
    let reads = 0; const entered: string[] = [];
    const gate = new HotfixActivation({
      inspect: () => {
        reads++;
        if (reads === 2) return { mode: 'invalid', maintenance: true, canInitialize: false, canAcceptNewWork: false, reason: 'PROOF_CHANGED_DURING_READ' };
        return { mode: reads === 1 ? 'candidate-held' : 'candidate-committed', deploymentId: 'candidate',
          maintenance: true, canInitialize: reads > 1, canAcceptNewWork: false };
      }, hasMaintenance: () => true,
    });
    await gate.run({}, () => { entered.push('write'); }); gate.completeBootstrap();
    await gate.refresh();
    expect(entered).toEqual(['write']); expect(gate.isAcceptingNewWork()).toBe(false);
    await gate.close();
  });

  it('bounds atomic replacement retries and keeps a persistently unstable proof closed', async () => {
    let reads = 0; const entered: string[] = [];
    const gate = new HotfixActivation({
      inspect: () => ++reads === 1
        ? { mode: 'candidate-held', deploymentId: 'candidate', maintenance: true, canInitialize: false, canAcceptNewWork: false }
        : { mode: 'invalid', maintenance: true, canInitialize: false, canAcceptNewWork: false, reason: 'PROOF_CHANGED_DURING_READ' },
      hasMaintenance: () => true,
    });
    await gate.run({}, () => { entered.push('write'); }); gate.completeBootstrap();
    await expect(gate.refresh()).rejects.toThrow('HOTFIX_INVALID_RELEASE_PROOF');
    expect(reads).toBe(4); expect(entered).toEqual([]); expect(gate.isAcceptingNewWork()).toBe(false);
    await gate.close();
  });

  it('does not erase a latched maintenance error when an in-flight initializer finishes', async () => {
    let unreadable = false;
    const work = pending();
    const gate = new HotfixActivation({
      inspect: () => ({ mode: 'unmanaged', maintenance: false, canInitialize: true, canAcceptNewWork: true }),
      hasMaintenance: () => { if (unreadable) throw new Error('synthetic denied read'); return false; },
    });
    const startup = gate.run({}, () => work.promise); await Promise.resolve();
    gate.completeBootstrap(); const refresh = gate.refresh();
    unreadable = true; expect(gate.isAcceptingNewWork()).toBe(false); unreadable = false;
    work.resolve(); await startup;
    await expect(refresh).rejects.toThrow('HOTFIX_MAINTENANCE_UNREADABLE');
    expect(gate.status().phase).toBe('failed'); expect(gate.isAcceptingNewWork()).toBe(false);
    await gate.close();
  });
});
