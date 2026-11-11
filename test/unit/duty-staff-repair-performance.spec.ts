import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const source = readFileSync(join(__dirname, '../../client/src/pages/DutyStaffRepair/index.tsx'), 'utf8');
const deferred = () => {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
function bind(name: string, end: string, scope: Record<string, unknown>) {
  const start = source.indexOf(`  const ${name} =`);
  const code = source.slice(start, source.indexOf(end, start));
  const output = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(scope), `${output}\nreturn ${name};`)(...Object.values(scope));
}
function fixture(canRefresh = true) {
  const scope = {
    canRefreshRef: { current: canRefresh }, mounted: { current: true }, scanVersion: { current: 0 },
    scanRequest: { current: null }, forceScanQueued: { current: false }, activeScanIsForced: { current: false },
    scanDutyProgramModifiedIssues: jest.fn(), setRefreshing: jest.fn(), setLoading: jest.fn(),
    setError: jest.fn(), setScanData: jest.fn(), logger: { error: jest.fn() },
  };
  return { scope, load: bind('loadData', '\n  useEffect(', scope) };
}
describe('duty repair background scanning', () => {
  it('merges concurrent scans and rejects a response from before a completed mutation', async () => {
    const { scope, load } = fixture();
    const first = deferred(), second = deferred();
    scope.scanDutyProgramModifiedIssues.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const pending = load(true, true);
    expect(load(true, true)).toBe(pending);
    await tick();
    scope.scanVersion.current++;
    expect(load(true, true)).toBe(pending);
    first.resolve({ candidates: ['old'] });
    await tick();
    expect(scope.setScanData).not.toHaveBeenCalled();
    expect(scope.scanDutyProgramModifiedIssues).toHaveBeenCalledTimes(2);
    second.resolve({ candidates: ['new'] });
    await pending;
    expect(scope.setScanData).toHaveBeenCalledWith({ candidates: ['new'] });
  });

  it('queues one fresh read behind an older ordinary scan', async () => {
    const { scope, load } = fixture();
    const first = deferred();
    scope.scanDutyProgramModifiedIssues.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ candidates: [] });
    const pending = load();
    await tick();
    load(true, true); load(true, true);
    first.resolve({ candidates: ['outdated'] });
    await pending;
    expect(scope.scanDutyProgramModifiedIssues.mock.calls).toEqual([[500, false], [500, true]]);
    expect(scope.setScanData).toHaveBeenCalledTimes(1);
  });

  it('reconciles mutations with an ordinary read when refresh permission is absent', async () => {
    const { scope, load } = fixture(false);
    const first = deferred();
    scope.scanDutyProgramModifiedIssues.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ candidates: [] });
    const pending = load(); await tick();
    scope.scanVersion.current++;
    first.resolve({ candidates: ['outdated'] });
    await pending;
    expect(scope.scanDutyProgramModifiedIssues.mock.calls).toEqual([[500, false], [500, false]]);
    expect(scope.setScanData).toHaveBeenCalledTimes(1);
  });

  it('retains displayed data on failure and ignores unmounted responses', async () => {
    const { scope, load } = fixture();
    scope.scanDutyProgramModifiedIssues.mockRejectedValueOnce(new Error('offline'));
    await load(true, true);
    expect(scope.setScanData).not.toHaveBeenCalled();
    expect(scope.setError).toHaveBeenCalledWith(expect.stringContaining('已保留'));
    const next = deferred();
    scope.scanDutyProgramModifiedIssues.mockReturnValueOnce(next.promise);
    const pending = load(true, true); await tick(); scope.mounted.current = false;
    next.resolve({ candidates: [] }); await pending;
    expect(scope.setScanData).not.toHaveBeenCalled();
  });

  it('does not retain revoked force-refresh authority for a queued scan', async () => {
    const { scope, load } = fixture();
    const first = deferred();
    scope.scanDutyProgramModifiedIssues.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ candidates: [] });
    const pending = load(); await tick();
    load(true, true);
    scope.canRefreshRef.current = false;
    first.resolve({ candidates: ['old'] }); await pending;
    expect(scope.scanDutyProgramModifiedIssues.mock.calls).toEqual([[500, false], [500, false]]);
  });

  it('releases completed records before rescan and prevents same-record duplicate submissions', async () => {
    const first = deferred(), second = deferred(), refresh = deferred();
    const scope = {
      canUpdate: true, bulkLock: { current: false }, repairLocks: { current: new Set<string>() }, mounted: { current: true },
      setRepairingIds: jest.fn(), repairDutyProgramModifiedIssues: jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
      refreshAfterRepair: jest.fn(() => refresh.promise), logger: { error: jest.fn() }, toast: { success: jest.fn(), error: jest.fn() },
    };
    const repair = bind('handleRepairOne', '\n  const handleRepairAll', scope);
    const pending = repair('recA');
    await repair('recA');
    expect(scope.repairDutyProgramModifiedIssues).toHaveBeenCalledTimes(1);
    first.resolve({ failed: 0, repaired: 1, message: 'done' }); await pending;
    expect(scope.repairLocks.current.has('recA')).toBe(false);
    expect(scope.refreshAfterRepair).toHaveBeenCalledWith(['recA']);
    const next = repair('recB');
    expect(scope.repairDutyProgramModifiedIssues).toHaveBeenCalledTimes(2);
    second.resolve({ failed: 0, repaired: 1, message: 'done' }); await next;
  });
});
