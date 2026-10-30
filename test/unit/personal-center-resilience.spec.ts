const mockSlots: any[] = []; let mockCursor = 0; const mockEffects: (() => void)[] = [];
jest.mock('react', () => ({ ...jest.requireActual('react'),
  useState: (initial: any) => { const index = mockCursor++; if (!(index in mockSlots)) mockSlots[index] = typeof initial === 'function' ? initial() : initial; return [mockSlots[index], (value: any) => { mockSlots[index] = typeof value === 'function' ? value(mockSlots[index]) : value; }]; },
  useRef: (initial: any) => { const index = mockCursor++; if (!(index in mockSlots)) mockSlots[index] = { current: initial }; return mockSlots[index]; },
  useCallback: (callback: any, dependencies: any[]) => { const index = mockCursor++, old = mockSlots[index]; if (!old || dependencies.some((value, at) => value !== old.dependencies[at])) mockSlots[index] = { callback, dependencies }; return mockSlots[index].callback; },
  useEffect: (effect: any, dependencies: any[]) => { const index = mockCursor++, old = mockSlots[index]; if (!old || dependencies.some((value, at) => value !== old.dependencies[at])) { const next = { dependencies, cleanup: old?.cleanup }; mockSlots[index] = next; mockEffects.push(() => { next.cleanup?.(); next.cleanup = effect(); }); } },
}));
import { mergePersonalRecords, usePersonalCollection, usePersonalProfileResource } from '../../client/src/pages/PersonalCenter/use-personal-resource';
const row = (id: string, version = 1) => ({ id, version, createdAt: '2026-10-29T00:00:00Z', status: version > 1 ? 'cancelled' : 'pending' });
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function render<T>(callback: () => T) { mockCursor = 0; const result = callback(); mockEffects.splice(0).forEach(effect => effect()); return result; }
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function cleanup() { mockSlots.forEach(slot => slot?.cleanup?.()); mockSlots.length = 0; mockEffects.length = 0; }
describe('personal resource independence and snapshot ordering', () => {
  beforeEach(cleanup); afterEach(cleanup);
  it('shows a completed profile while history is still pending', async () => {
    const history = deferred<ReturnType<typeof row>[]>(), loadHistory = jest.fn(() => history.promise), loadProfile = jest.fn(async () => ({ displayName: '合成人员' }));
    const show = () => render(() => ({ profile: usePersonalProfileResource(loadProfile), history: usePersonalCollection(loadHistory) }));
    show(); await flush(); let result = show();
    expect(result.profile.value?.displayName).toBe('合成人员'); expect(result.profile.loading).toBe(false); expect(result.history.loading).toBe(true);
    history.resolve([]); await flush(); result = show(); expect(result.history.loading).toBe(false);
  });
  it('deduplicates reads and retains a new submit and a withdrawal when an older GET completes', async () => {
    const slow = deferred<ReturnType<typeof row>[]>(), load = jest.fn(() => slow.promise);
    const show = () => render(() => usePersonalCollection(load)); let state = show(); state.refresh(); state.refresh();
    state.upsert(row('withdrawn', 2)); state.upsert(row('new', 1));
    slow.resolve([row('withdrawn', 1)]); await flush(); state = show();
    expect(load).toHaveBeenCalledTimes(1); expect(state.items.find(item => item.id === 'withdrawn')?.status).toBe('cancelled'); expect(state.items.map(item => item.id)).toContain('new');
  });
  it('preserves successful records on failure and does not replace them with an error after a mutation', async () => {
    const slow = deferred<ReturnType<typeof row>[]>(), load = jest.fn(() => slow.promise);
    const show = () => render(() => usePersonalCollection(load)); let state = show(); state.upsert(row('new'));
    slow.reject(new Error('old read failed')); await flush(); state = show(); expect(state.items).toHaveLength(1); expect(state.error).toBe('');
    load.mockImplementationOnce(async () => { throw new Error('fresh read failed'); }); await state.refresh(); state = show(); expect(state.items).toHaveLength(1); expect(state.error).toBe('fresh read failed');
  });
  it('ignores old profile responses after a permission-version reload', async () => {
    const old = deferred<{ version: number }>(), next = deferred<{ version: number }>();
    const loadOld = () => old.promise, loadNext = () => next.promise;
    render(() => usePersonalProfileResource(loadOld)); render(() => usePersonalProfileResource(loadNext));
    next.resolve({ version: 2 }); await flush(); old.resolve({ version: 1 }); await flush();
    expect(render(() => usePersonalProfileResource(loadNext)).value?.version).toBe(2);
  });
  it('accepts the latest server effective-state annotation at the same record version', () => {
    const current = { ...row('a', 2), currentEffect: 'current' }, incoming = { ...row('a', 2), currentEffect: 'none' };
    expect(mergePersonalRecords([current], [incoming], new Set())[0].currentEffect).toBe('none');
  });
});
