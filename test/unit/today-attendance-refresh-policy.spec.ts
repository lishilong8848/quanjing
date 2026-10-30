import { readFileSync } from 'node:fs';
import { ModuleKind, transpileModule } from 'typescript';

// Execute the real hook with a small effect host; no external calls or DOM writes.
function hookHost(initialEnabled = true) {
  let enabled = initialEnabled;
  const slots: any[] = [];
  let cursor = 0;
  let dirty = true;
  let effects: Array<() => void> = [];
  const listeners = new Map<string, () => void>();
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    'document',
  );
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      visibilityState: 'visible',
      addEventListener: (event: string, fn: () => void) =>
        listeners.set(event, fn),
      removeEventListener: (event: string) => listeners.delete(event),
    },
  });
  const react = {
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [
        slots[index],
        (value: any) => {
          slots[index] =
            typeof value === 'function' ? value(slots[index]) : value;
          dirty = true;
        },
      ];
    },
    useRef(initial: any) {
      const index = cursor++;
      return (slots[index] ||= { current: initial });
    },
    useCallback(fn: any, deps: any[]) {
      const index = cursor++;
      if (!slots[index] || deps.some((dep, i) => dep !== slots[index].deps[i]))
        slots[index] = { fn, deps };
      return slots[index].fn;
    },
    useEffect(fn: () => any, deps: any[]) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[index] = { deps, cleanup: fn() };
        });
      }
    },
  };
  const reads: Array<{
    force: boolean;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }> = [];
  const manualRequests: Array<{ request: any; resolve: (value: any) => void; reject: (error: unknown) => void }> = [];
  const api = {
    getTodayAttendanceSnapshot: (force = false) =>
      new Promise((resolve, reject) => reads.push({ force, resolve, reject })),
    retryTodayAttendance: (request: any) => new Promise((resolve, reject) => manualRequests.push({ request, resolve, reject })),
  };
  const source = readFileSync(
    'client/src/components/attendance/use-today-attendance.ts',
    'utf8',
  );
  const exported: any = {};
  new Function(
    'require',
    'exports',
    'window',
    'crypto',
    transpileModule(source, {
      compilerOptions: { module: ModuleKind.CommonJS },
    }).outputText,
  )((name: string) => (name === 'react' ? react : api), exported, globalThis, { randomUUID: () => '00000000-0000-4000-8000-000000000001' });
  let value: any;
  return {
    reads,
    manualRequests,
    setEnabled(next: boolean) { enabled = next; dirty = true; },
    get value() {
      return value;
    },
    async flush() {
      for (let i = 0; i < 8; i++) {
        if (dirty) {
          dirty = false;
          cursor = 0;
          effects = [];
          value = exported.useTodayAttendanceSnapshot(enabled);
          effects.forEach((effect) => effect());
        }
        await Promise.resolve();
      }
    },
    visible() {
      listeners.get('visibilitychange')?.();
    },
    close() {
      slots.forEach((slot) => slot?.cleanup?.());
      if (originalDocument)
        Object.defineProperty(globalThis, 'document', originalDocument);
      else delete (globalThis as any).document;
    },
  };
}

describe('attendance authorized refresh and guest isolation policy', () => {
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date('2026-10-08T10:00:00+08:00')),
  );
  afterEach(() => jest.useRealTimers());

  it('never reads or refreshes attendance while disabled for guests', async () => {
    const host = hookHost(false);
    try {
      await host.flush();
      host.value.retry();
      host.value.manualSync();
      host.visible();
      jest.advanceTimersByTime(24 * 60 * 60_000);
      await host.flush();
      expect(host.reads).toHaveLength(0);
      expect(host.value.snapshot).toBeNull();
      expect(host.value.state).toBe('idle');
      expect(host.value.manualSyncState).toBe('idle');
    } finally { host.close(); }
  });

  it('clears attendance on guest downgrade and rejects the old in-flight response', async () => {
    const host = hookHost();
    try {
      await host.flush();
      expect(host.reads).toHaveLength(1);
      host.setEnabled(false);
      await host.flush();
      host.reads[0].resolve({ sourceStatus: 'fresh', entries: [{ name: 'Private fixture' }], date: '2026-10-08' });
      await host.flush();
      expect(host.value.snapshot).toBeNull();
      expect(host.value.state).toBe('idle');
      host.setEnabled(true);
      await host.flush();
      expect(host.reads).toHaveLength(2);
      host.reads[1].resolve({ sourceStatus: 'fresh', entries: [], date: '2026-10-08' });
      await host.flush();
      expect(host.value.state).toBe('ready');
    } finally { host.close(); }
  });

  it('continues low-frequency recovery after five temporary failures', async () => {
    const host = hookHost();
    try {
      await host.flush();
      for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
        const count = host.reads.length;
        host.reads[count - 1].reject(new Error('temporary outage'));
        await host.flush();
        jest.advanceTimersByTime(delay);
        await host.flush();
        expect(host.reads).toHaveLength(count + 1);
        expect(host.reads[count].force).toBe(false);
      }
      host.reads[5].resolve({
        sourceStatus: 'fresh',
        entries: [],
        date: '2026-10-08',
      });
      await host.flush();
      expect(host.value.state).toBe('ready');
    } finally {
      host.close();
    }
  });

  it('keeps authorized visibility and shift-boundary reads without forced refresh', async () => {
    const host = hookHost();
    try {
      await host.flush();
      expect(host.reads[0].force).toBe(false);
      host.reads[0].resolve({
        sourceStatus: 'fresh',
        entries: [],
        date: '2026-10-08',
      });
      await host.flush();
      jest.setSystemTime(new Date('2026-10-08T10:02:00+08:00'));
      host.visible();
      await host.flush();
      expect(host.reads[1].force).toBe(false);
      host.reads[1].resolve({
        sourceStatus: 'fresh',
        entries: [],
        date: '2026-10-08',
      });
      await host.flush();
      jest.advanceTimersByTime((8 * 60 + 33) * 60_000);
      await host.flush();
      expect(host.reads[2].force).toBe(false);
    } finally {
      host.close();
    }
  });

  it('discards an in-flight old-phase result and rereads without privileged parameters', async () => {
    const host = hookHost();
    try {
      await host.flush();
      jest.setSystemTime(new Date('2026-10-08T18:35:00+08:00'));
      host.reads[0].resolve({
        sourceStatus: 'fresh',
        entries: [],
        date: '2026-10-08',
      });
      await host.flush();
      expect(host.value.snapshot).toBeNull();
      expect(host.reads).toHaveLength(2);
      expect(host.reads[1].force).toBe(false);
    } finally {
      host.close();
    }
  });

  it('recovers an old-phase failed read without forcing a privileged request', async () => {
    const host = hookHost();
    try {
      await host.flush();
      jest.setSystemTime(new Date('2026-10-08T18:35:00+08:00'));
      host.reads[0].reject(new Error('read failed'));
      await host.flush();
      expect(host.value.snapshot).toBeNull();
      expect(host.reads).toHaveLength(2);
      expect(host.reads[1].force).toBe(false);
    } finally {
      host.close();
    }
  });

  const executionId = '11111111-1111-4111-8111-111111111111';
  const oldExecutionId = '22222222-2222-4222-8222-222222222222';
  const completeSnapshot = (completedAt = '2026-10-08T01:30:00.000Z', actualExecutionId = oldExecutionId) => ({
    date: '2026-10-08', displayScope: 'today', sourceStatus: 'fresh', entries: [{ name: '合成人员', status: 'anomaly' }],
    summary: { expected: 62, normal: 58, anomaly: 4, excluded: 0 }, checkedTasks: ['morning-off-duty-check'],
    runStatus: { state: 'completed', task: 'morning-off-duty-check', executionId: actualExecutionId, scheduledAt: '2026-10-08 09:30', lastAttemptAt: completedAt, completedAt },
  });
  const accepted = { date: '2026-10-08', task: 'morning-off-duty-check', state: 'running', executionId };

  it('keeps a 143-second manual run pending past the waiting budget, then completes despite external archive work', async () => {
    const host = hookHost();
    try {
      await host.flush(); host.reads[0].resolve(completeSnapshot()); await host.flush();
      host.value.manualSync(); await host.flush(); host.manualRequests[0].resolve(accepted); await host.flush();
      expect(host.value.manualSyncState).toBe('accepted');
      jest.advanceTimersByTime(120_000); await host.flush();
      expect(host.value.manualSyncState).toBe('pending'); expect(host.value.snapshot.summary.expected).toBe(62);
      host.value.manualSync(); expect(host.manualRequests).toHaveLength(1);
      jest.setSystemTime(new Date('2026-10-08T10:02:23+08:00'));
      const finished = completeSnapshot('2026-10-08T02:02:23.000Z', executionId);
      host.reads[host.reads.length - 1].resolve({ ...finished, runStatus: { ...finished.runStatus, archiveSyncState: 'syncing', correctionSyncState: 'syncing' } });
      await host.flush(); expect(host.value.manualSyncState).toBe('success'); expect(host.value.manualSyncError).toBeNull(); expect(host.manualRequests).toHaveLength(1);
    } finally { host.close(); }
  });
  it('does not treat a retained pre-request completed snapshot as this new manual run', async () => {
    const host = hookHost();
    try {
      await host.flush(); host.reads[0].resolve(completeSnapshot()); await host.flush();
      host.value.manualSync(); await host.flush(); host.manualRequests[0].resolve(accepted); await host.flush();
      host.reads[host.reads.length - 1].resolve(completeSnapshot()); await host.flush();
      expect(host.value.manualSyncState).toBe('accepted');
      jest.advanceTimersByTime(2_000); await host.flush();
      host.reads[host.reads.length - 1].resolve(completeSnapshot('2026-10-08T02:00:02.000Z', executionId)); await host.flush();
      expect(host.value.manualSyncState).toBe('success');
    } finally { host.close(); }
  });
  it('does not mark a new manual run failed because an older failure was cached', async () => {
    const host = hookHost();
    try {
      await host.flush(); host.reads[0].resolve(completeSnapshot()); await host.flush();
      host.value.manualSync(); await host.flush(); host.manualRequests[0].resolve(accepted); await host.flush();
      const old = completeSnapshot(); host.reads[host.reads.length - 1].resolve({ ...old, sourceStatus: 'failed', runStatus: { ...old.runStatus, state: 'failed', failureScope: 'core', failureReason: '上次失败' } }); await host.flush();
      expect(host.value.manualSyncState).toBe('accepted'); expect(host.value.manualSyncError).toBeNull();
    } finally { host.close(); }
  });
  it('retains current attendance results when status reading fails during a manual run', async () => {
    const host = hookHost();
    try {
      await host.flush(); host.reads[0].resolve(completeSnapshot()); await host.flush();
      host.value.manualSync(); await host.flush(); host.manualRequests[0].resolve(accepted); await host.flush();
      host.reads[host.reads.length - 1].reject(new Error('read unavailable')); await host.flush();
      expect(host.value.snapshot.summary.expected).toBe(62); expect(host.value.state).toBe('stale'); expect(host.value.manualSyncState).toBe('accepted');
    } finally { host.close(); }
  });

  it('confirms a ten-second result in the same display minute using the execution identity', async () => {
    jest.setSystemTime(new Date('2026-10-08T10:00:20+08:00'));
    const host = hookHost();
    try {
      await host.flush(); host.reads[0].resolve(completeSnapshot('2026-10-08 10:00')); await host.flush();
      host.value.manualSync(); await host.flush(); host.manualRequests[0].resolve(accepted); await host.flush();
      jest.advanceTimersByTime(10_000); await host.flush();
      host.reads[host.reads.length - 1].resolve(completeSnapshot('2026-10-08 10:00', executionId)); await host.flush();
      expect(host.value.manualSyncState).toBe('success'); expect(host.manualRequests).toHaveLength(1);
    } finally { host.close(); }
  });

  it('rejects a cached result from another execution in that exact same display minute', async () => {
    const host = hookHost();
    try {
      await host.flush(); host.reads[0].resolve(completeSnapshot('2026-10-08 10:00')); await host.flush();
      host.value.manualSync(); await host.flush(); host.manualRequests[0].resolve(accepted); await host.flush();
      host.reads[host.reads.length - 1].resolve(completeSnapshot('2026-10-08 10:00')); await host.flush();
      expect(host.value.manualSyncState).toBe('accepted');
      jest.advanceTimersByTime(2_000); await host.flush();
      host.reads[host.reads.length - 1].resolve(completeSnapshot('2026-10-08 10:00', executionId)); await host.flush();
      expect(host.value.manualSyncState).toBe('success');
    } finally { host.close(); }
  });

  it('observes the returned existing execution when this request joins another running task', async () => {
    const host = hookHost();
    const joinedExecutionId = '33333333-3333-4333-8333-333333333333';
    try {
      await host.flush(); host.reads[0].resolve(completeSnapshot()); await host.flush();
      host.value.manualSync(); await host.flush();
      host.manualRequests[0].resolve({ ...accepted, accepted: false, inProgress: true, executionId: joinedExecutionId }); await host.flush();
      expect(host.manualRequests[0].request.clientMutationId).not.toBe(joinedExecutionId);
      host.reads[host.reads.length - 1].resolve(completeSnapshot('2026-10-08 09:59', joinedExecutionId)); await host.flush();
      expect(host.value.manualSyncState).toBe('success'); expect(host.manualRequests).toHaveLength(1);
    } finally { host.close(); }
  });

  it.each(['2026-10-08 09:50', 'unparseable display time'])('does not depend on browser clock or parsing the display timestamp %s', async (displayTime) => {
    const host = hookHost();
    try {
      await host.flush(); host.reads[0].resolve(completeSnapshot()); await host.flush();
      host.value.manualSync(); await host.flush(); host.manualRequests[0].resolve(accepted); await host.flush();
      host.reads[host.reads.length - 1].resolve(completeSnapshot(displayTime, executionId)); await host.flush();
      expect(host.value.manualSyncState).toBe('success');
    } finally { host.close(); }
  });

  it('keeps an unidentifiable legacy response pending without automatically submitting again', async () => {
    const host = hookHost();
    try {
      await host.flush(); host.reads[0].resolve(completeSnapshot()); await host.flush();
      host.value.manualSync(); await host.flush(); host.manualRequests[0].resolve({ ...accepted, executionId: undefined, state: 'completed' }); await host.flush();
      expect(host.value.manualSyncState).toBe('pending');
      host.reads[host.reads.length - 1].resolve(completeSnapshot('2026-10-08 10:00', executionId)); await host.flush();
      host.value.manualSync(); expect(host.manualRequests).toHaveLength(1);
      jest.advanceTimersByTime(15_000); await host.flush();
      expect(host.value.manualSyncState).toBe('pending'); expect(host.reads.length).toBeGreaterThan(2);
    } finally { host.close(); }
  });

  it('waits for the matching snapshot even when the accepted response is already completed', async () => {
    const host = hookHost();
    try {
      await host.flush(); host.reads[0].resolve(completeSnapshot()); await host.flush();
      host.value.manualSync(); await host.flush(); host.manualRequests[0].resolve({ ...accepted, state: 'completed' }); await host.flush();
      expect(host.value.manualSyncState).toBe('accepted');
      host.reads[host.reads.length - 1].resolve(completeSnapshot()); await host.flush();
      expect(host.value.manualSyncState).toBe('accepted');
      jest.advanceTimersByTime(2_000); await host.flush();
      host.reads[host.reads.length - 1].resolve(completeSnapshot('2026-10-08 10:00', executionId)); await host.flush();
      expect(host.value.manualSyncState).toBe('success');
    } finally { host.close(); }
  });

  it.each(['date', 'task'])('rejects a terminal snapshot with a mismatched %s even if its execution ID matches', async (mismatch) => {
    const host = hookHost();
    try {
      await host.flush(); host.reads[0].resolve(completeSnapshot()); await host.flush();
      host.value.manualSync(); await host.flush(); host.manualRequests[0].resolve(accepted); await host.flush();
      const result = completeSnapshot('2026-10-08 10:00', executionId);
      host.reads[host.reads.length - 1].resolve(mismatch === 'date'
        ? { ...result, date: '2026-10-07' }
        : { ...result, runStatus: { ...result.runStatus, task: 'evening-off-duty-check' } });
      await host.flush(); expect(host.value.manualSyncState).toBe('accepted');
    } finally { host.close(); }
  });
});
