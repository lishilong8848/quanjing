import { HotfixActivation } from '../../server/common/hotfix-activation';
import { startHotfixActivationMonitor } from '../../server/common/hotfix-activation-monitor';
import type { HotfixReleaseProof } from '../../server/common/hotfix-release-proof';

describe('activation monitor ownership', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { expect(jest.getTimerCount()).toBe(0); jest.useRealTimers(); });
  function setup(unmanaged = false) {
    let reads = 0;
    let proof: HotfixReleaseProof = unmanaged
      ? { mode: 'unmanaged', maintenance: false, canInitialize: true, canAcceptNewWork: true }
      : { mode: 'candidate-held', deploymentId: 'candidate', maintenance: true, canInitialize: false, canAcceptNewWork: false };
    const gate = new HotfixActivation({ inspect: () => { reads++; return proof; }, hasMaintenance: () => proof.maintenance });
    return { gate, reads: () => reads, set: (next: Partial<HotfixReleaseProof>) => { proof = { ...proof, ...next }; } };
  }
  it('starts the real registered job after commit and releases its polling resource at shutdown', async () => {
    const scope = setup(), entries: string[] = [], errors: string[] = [];
    await scope.gate.run({}, () => { entries.push('write'); });
    const monitor = await startHotfixActivationMonitor(scope.gate, reason => errors.push(reason));
    try {
      expect(entries).toEqual([]);
      scope.set({ mode: 'candidate-committed', canInitialize: true }); await jest.advanceTimersByTimeAsync(100);
      expect(entries).toEqual(['write']); expect(scope.gate.isAcceptingNewWork()).toBe(false);
      scope.set({ mode: 'installed', maintenance: false, canAcceptNewWork: true }); await jest.advanceTimersByTimeAsync(100);
      expect(scope.gate.isAcceptingNewWork()).toBe(true); expect(errors).toEqual([]);
    } finally { await monitor.stop(); }
    expect(scope.gate.status().phase).toBe('closed');
  });
  it('does not reparse full release metadata on every healthy idle tick', async () => {
    const scope = setup(true), monitor = await startHotfixActivationMonitor(scope.gate, () => { throw Error('unexpected failure'); });
    try {
      expect(scope.gate.isAcceptingNewWork()).toBe(true);
      const reads = scope.reads(); await jest.advanceTimersByTimeAsync(1_000); expect(scope.reads()).toBe(reads);
    } finally { await monitor.stop(); }
  });
  it('reports a latched initializer failure once and stops its timer without exposing private details', async () => {
    const scope = setup(), errors: string[] = [];
    await scope.gate.run({}, () => { throw Error('private upstream response'); });
    const monitor = await startHotfixActivationMonitor(scope.gate, reason => errors.push(reason));
    try {
      scope.set({ mode: 'candidate-committed', canInitialize: true }); await jest.advanceTimersByTimeAsync(500);
      expect(errors).toEqual(['HOTFIX_INITIALIZATION_FAILED']); expect(scope.gate.isAcceptingNewWork()).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    } finally { await monitor.stop(); }
  });
  it('cancels all held owners before later proof can start them', async () => {
    const scope = setup(), entries: string[] = [];
    await scope.gate.run({}, () => { entries.push('write'); });
    const monitor = await startHotfixActivationMonitor(scope.gate, () => undefined); await monitor.stop();
    scope.set({ mode: 'candidate-committed', canInitialize: true }); await jest.advanceTimersByTimeAsync(500);
    expect(entries).toEqual([]); expect(scope.gate.status().phase).toBe('closed');
  });

  it('does not create a new polling timer if shutdown arrives while initial activation is awaited', async () => {
    const scope = setup(true); let finish!: () => void;
    const work = new Promise<void>(done => { finish = done; });
    const startup = scope.gate.run({}, () => work);
    const result = startHotfixActivationMonitor(scope.gate, () => undefined).then(
      monitor => ({ monitor, error: undefined as Error | undefined }),
      error => ({ monitor: undefined, error: error as Error }),
    );
    const closing = scope.gate.close(); finish(); await Promise.all([startup, closing]);
    const outcome = await result; await outcome.monitor?.stop();
    expect(outcome.error?.message).toBe('HOTFIX_ACTIVATION_CLOSED');
    expect(jest.getTimerCount()).toBe(0);
  });
});
