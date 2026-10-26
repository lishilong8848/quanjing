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
  const api = {
    getTodayAttendanceSnapshot: (force = false) =>
      new Promise((resolve, reject) => reads.push({ force, resolve, reject })),
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
    transpileModule(source, {
      compilerOptions: { module: ModuleKind.CommonJS },
    }).outputText,
  )((name: string) => (name === 'react' ? react : api), exported, globalThis);
  let value: any;
  return {
    reads,
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
});
