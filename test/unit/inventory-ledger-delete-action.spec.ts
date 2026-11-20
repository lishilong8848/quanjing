import type { InventoryLedgerDeletionRequest, InventoryLedgerDeletionTask } from '../../shared/inventory-ledger-deletion.interface';
import React from 'react';
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { InventoryLedgerDeleteAction } from '../../client/src/pages/InventoryManagement/InventoryLedgerDeleteAction';
import {
  createLedgerDeletePolling,
  ledgerDeleteRequestMode,
  ledgerDeleteTaskMessage,
  validLedgerDeleteTask,
  type LedgerDeleteJournal,
} from '../../client/src/pages/InventoryManagement/inventory-ledger-delete-polling';

let mockPrincipal = { role: 'admin', purchaseBuilding: null, accountId: 'account-admin' };
jest.mock('@/access/AccessProvider', () => ({ useAccess: () => mockPrincipal }), { virtual: true });
jest.mock('@/components/ui/button', () => ({ Button: 'button' }), { virtual: true });
jest.mock('@/components/ui/dialog', () => Object.fromEntries(['Dialog', 'DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription', 'DialogFooter'].map(name => [name, name])), { virtual: true });
jest.mock('lucide-react', () => ({ Trash2: 'span', Loader2: 'span' }));
jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({ axiosForBackend: jest.fn() }));
jest.mock('../../client/src/pages/InventoryManagement/stocktake-draft-journal', () => ({ stocktakeDraftJournalIdentity: (principal: { accountId: string }) => principal.accountId }));
jest.mock('../../client/src/pages/InventoryManagement/inventory-stocktake.logic', () => ({ stocktakeError: (error: Error) => error.message }));

const request: InventoryLedgerDeletionRequest = {
  clientMutationId: 'delete-original-0001', recordId: 'rec_inventory', building: 'H楼',
  expected: { sku: 'B2031', quantity: 0, location: 'H-2F-226' },
};
const task = (status: InventoryLedgerDeletionTask['status'] = 'pending'): InventoryLedgerDeletionTask => ({
  clientMutationId: request.clientMutationId, recordId: request.recordId, status,
  message: '正在处理', updatedAt: new Date().toISOString(),
});

// Execute the real component's handlers/effects in Node. This is deliberately
// not a DOM/focus/layout assertion; final browser acceptance checks those.
function mountDeleteAction() {
  const states: unknown[] = [], refs: { current: unknown }[] = [];
  const effects: { deps?: React.DependencyList; cleanup?: () => void }[] = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0;
  let pendingEffects: (() => void)[] = [], tree: React.ReactElement;
  jest.spyOn(React, 'useState').mockImplementation(((initial: unknown) => {
    const index = stateIndex++;
    if (!(index in states)) states[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [states[index], (next: unknown) => { states[index] = typeof next === 'function' ? (next as (value: unknown) => unknown)(states[index]) : next; }];
  }) as typeof React.useState);
  jest.spyOn(React, 'useRef').mockImplementation(((initial: unknown) => {
    const index = refIndex++; if (!refs[index]) refs[index] = { current: initial }; return refs[index];
  }) as typeof React.useRef);
  jest.spyOn(React, 'useEffect').mockImplementation((effect, deps) => {
    const index = effectIndex++, previous = effects[index];
    if (!previous || !deps || !previous.deps || deps.some((value, i) => !Object.is(value, previous.deps![i]))) {
      pendingEffects.push(() => {
        previous?.cleanup?.(); const cleanup = effect(); effects[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
      });
    }
  });
  const onDeleted = jest.fn();
  function render(runEffects = true) {
    stateIndex = 0; refIndex = 0; effectIndex = 0; pendingEffects = [];
    tree = InventoryLedgerDeleteAction({ item: { recordId: request.recordId, building: 'H楼', sku: 'B2031', name: '遮阳伞', quantity: 0, unit: '套', location: request.expected.location } as any, onDeleted });
    if (runEffects) pendingEffects.forEach(effect => effect());
    return tree;
  }
  function nodes(value: unknown): React.ReactElement[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!React.isValidElement(value)) return [];
    return [value, ...nodes((value.props as { children?: unknown }).children)];
  }
  function button(text: string) {
    const node = nodes(tree).find(value => value.type === 'button' && nodes(value).some(entry => {
      const child = (entry.props as { children?: unknown }).children;
      return child === text || Array.isArray(child) && child.includes(text);
    }));
    if (!node) throw new Error(`No button ${text}`);
    return node.props as { onClick(): void };
  }
  render();
  return {
    render, onDeleted, flushEffects() { pendingEffects.forEach(effect => effect()); },
    open() { const node = nodes(tree).find(value => (value.props as any)['aria-label'] === '删除台账 遮阳伞')!; (node.props as any).onClick(); render(); },
    click(text: string) { button(text).onClick(); render(); },
    unmount() { effects.forEach(effect => effect.cleanup?.()); },
  };
}

describe('台账删除组件真实回调与生命周期', () => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let values: Map<string, string>;
  const network = axiosForBackend as jest.Mock;
  function saveInitial(value: LedgerDeleteJournal) {
    let hash = 2166136261;
    for (const letter of mockPrincipal.accountId) hash = Math.imul(hash ^ letter.charCodeAt(0), 16777619);
    values.set(`inventory-ledger-delete:v1:${(hash >>> 0).toString(16)}:${request.recordId}`, JSON.stringify(value));
  }
  beforeEach(() => {
    jest.useFakeTimers(); network.mockReset(); mockPrincipal = { role: 'admin', purchaseBuilding: null, accountId: 'account-admin' }; values = new Map();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value) } });
  });
  afterEach(() => {
    jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks();
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('closing aborts an issued POST without claiming to cancel deletion, and reopening reads the same original request', async () => {
    const post = deferred<any>(); network.mockImplementation((config: any) => config.method === 'POST' ? post.promise : Promise.resolve({ data: task('completed') }));
    const ui = mountDeleteAction(); ui.open(); ui.click('确认删除');
    const submitted = network.mock.calls[0][0]; expect(submitted.method).toBe('POST');
    ui.click('关闭'); expect(submitted.signal.aborted).toBe(true);
    post.resolve({ data: { ...task('completed'), clientMutationId: submitted.data.clientMutationId } }); await settle();
    expect(ui.onDeleted).not.toHaveBeenCalled();
    network.mockImplementation((config: any) => Promise.resolve({ data: { ...task('completed'), clientMutationId: submitted.data.clientMutationId } }));
    ui.open(); await settle(); ui.render();
    expect(network.mock.calls[1][0].method).toBe('GET');
    expect(network.mock.calls[1][0].url).toContain(submitted.data.clientMutationId);
    expect(ui.onDeleted).toHaveBeenCalledWith(request.recordId); ui.unmount();
  });

  it('manual reconciliation replaces the old component chain and close clears its timer', async () => {
    saveInitial(journal('pending', task()));
    const old = deferred<any>(), newer = deferred<any>(); network.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
    const ui = mountDeleteAction(); ui.open(); expect(network).toHaveBeenCalledTimes(1);
    ui.click('核对结果'); expect(network.mock.calls[0][0].signal.aborted).toBe(true);
    old.resolve({ data: task('completed') }); await settle(); expect(ui.onDeleted).not.toHaveBeenCalled();
    newer.resolve({ data: task() }); await settle(); ui.render(); expect(jest.getTimerCount()).toBe(1);
    ui.click('关闭'); expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(60_000); expect(network).toHaveBeenCalledTimes(2); ui.unmount();
  });

  it('account switch aborts the old row read and cannot apply its completion to the new account', async () => {
    saveInitial(journal('pending', task())); const old = deferred<any>(); network.mockReturnValue(old.promise);
    const ui = mountDeleteAction(); ui.open();
    mockPrincipal = { ...mockPrincipal, accountId: 'account-other' }; ui.render();
    expect(network.mock.calls[0][0].signal.aborted).toBe(true);
    old.resolve({ data: task('completed') }); await settle();
    expect(ui.onDeleted).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0); ui.unmount();
  });

  it('ignores the old response in the render-to-effect identity-change window', async () => {
    saveInitial(journal('pending', task())); const old = deferred<any>(); network.mockReturnValue(old.promise);
    const ui = mountDeleteAction(); ui.open();
    const before = [...values.entries()];
    mockPrincipal = { ...mockPrincipal, accountId: 'account-other' }; ui.render(false);
    old.resolve({ data: task('completed') }); await settle();
    expect(ui.onDeleted).not.toHaveBeenCalled(); expect([...values.entries()]).toEqual(before);
    ui.flushEffects(); expect(network).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0); ui.unmount();
  });

  it('cannot continue an old POST or write its receipt into the new account before effect cleanup', async () => {
    const post = deferred<any>(); network.mockReturnValue(post.promise);
    const ui = mountDeleteAction(); ui.open(); ui.click('确认删除');
    const submitted = network.mock.calls[0][0]; const before = [...values.entries()];
    mockPrincipal = { ...mockPrincipal, accountId: 'account-other' }; ui.render(false);
    post.resolve({ data: { ...task('completed'), clientMutationId: submitted.data.clientMutationId } }); await settle();
    expect(ui.onDeleted).not.toHaveBeenCalled(); expect([...values.entries()]).toEqual(before);
    expect(network).toHaveBeenCalledTimes(1); ui.flushEffects(); ui.unmount();
  });

  it('a lost POST result is reconciled with the original identifier rather than a second delete request', async () => {
    const read = deferred<any>(); network.mockImplementation((config: any) => config.method === 'POST' ? Promise.reject(new Error('timeout')) : read.promise);
    const ui = mountDeleteAction(); ui.open(); ui.click('确认删除'); await settle();
    expect(network).toHaveBeenCalledTimes(2);
    const submitted = network.mock.calls[0][0], checked = network.mock.calls[1][0];
    expect(checked.method).toBe('GET'); expect(checked.url).toContain(submitted.data.clientMutationId);
    expect(JSON.parse([...values.values()][0]).request.clientMutationId).toBe(submitted.data.clientMutationId);
    ui.click('关闭'); expect(checked.signal.aborted).toBe(true);
    read.resolve({ data: { ...task('completed'), clientMutationId: submitted.data.clientMutationId } }); await settle();
    expect(ui.onDeleted).not.toHaveBeenCalled(); ui.unmount();
  });

  it('a safe failed task retries the existing identifier and an uncertain task only reads', async () => {
    const failed = { ...task('failed'), retryable: true, definitelyNotDeleted: true };
    saveInitial(journal('failed', failed)); network.mockImplementation(() => Promise.resolve({ data: failed }));
    const ui = mountDeleteAction(); ui.open(); await settle(); ui.render(); ui.click('安全重试删除'); await settle();
    expect(network.mock.calls.find(([config]) => config.method === 'POST')![0].data.clientMutationId).toBe(request.clientMutationId); ui.unmount();
    jest.restoreAllMocks(); network.mockReset();
    const uncertain = { ...task('uncertain'), retryable: false, definitelyNotDeleted: false };
    saveInitial(journal('uncertain', uncertain)); network.mockImplementation(() => Promise.resolve({ data: uncertain }));
    const next = mountDeleteAction(); next.open(); await settle(); next.render(); next.click('核对原申请结果'); await settle();
    expect(network.mock.calls.every(([config]) => config.method === 'GET')).toBe(true); next.unmount();
  });
});
const journal = (status: LedgerDeleteJournal['status'], result?: InventoryLedgerDeletionTask): LedgerDeleteJournal => ({ request, status, ...(result ? { task: result } : {}) });
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('台账删除轮询和原申请安全重试', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('keeps the old operation for unknown/uncertain results and legacy failed journals', () => {
    expect(ledgerDeleteRequestMode(null)).toBe('new');
    expect(ledgerDeleteRequestMode(journal('submitting'))).toBe('retry');
    expect(ledgerDeleteRequestMode(journal('pending'))).toBe('retry');
    expect(ledgerDeleteRequestMode(journal('uncertain', task('uncertain')))).toBe('inspect');
    expect(ledgerDeleteRequestMode(journal('failed'))).toBe('inspect');
    expect(ledgerDeleteRequestMode(journal('completed'))).toBe('completed');
  });

  it('allows the same original identifier for a confirmed safe retry, and a new confirmation only for a definite terminal rejection', () => {
    expect(ledgerDeleteRequestMode(journal('failed', { ...task('failed'), retryable: true, definitelyNotDeleted: true }))).toBe('retry');
    expect(ledgerDeleteRequestMode(journal('failed', { ...task('failed'), retryable: false, definitelyNotDeleted: true }))).toBe('new');
    expect(ledgerDeleteRequestMode(journal('failed', { ...task('failed'), retryable: true, definitelyNotDeleted: false }))).toBe('inspect');
    expect(ledgerDeleteRequestMode(journal('failed', { ...task('failed'), definitelyNotDeleted: true }))).toBe('inspect');
    expect(ledgerDeleteRequestMode(journal('failed', { ...task('failed'), clientMutationId: 'another-operation', retryable: false, definitelyNotDeleted: true }))).toBe('inspect');
  });

  it('binds readbacks to the original operation and row', () => {
    expect(validLedgerDeleteTask(task(), request)).toBe(true);
    expect(validLedgerDeleteTask({ ...task(), recordId: 'rec_other' }, request)).toBe(false);
    expect(validLedgerDeleteTask({ ...task(), clientMutationId: 'delete-other' }, request)).toBe(false);
    expect(validLedgerDeleteTask({ ...task(), status: 'unknown' }, request)).toBe(false);
  });

  it('explains the current read stage and bounded automatic retries', () => {
    expect(ledgerDeleteTaskMessage({ ...task(), stage: 'reading-catalog', retryCount: 1, nextAttemptAt: new Date().toISOString() })).toBe('核对物品类别 · 正在处理 · 将自动重试（1/2）');
    expect(ledgerDeleteTaskMessage({ ...task(), stage: 'reading-catalog', message: '核对物品类别，稍后自动重试（1/2）', retryCount: 1, nextAttemptAt: new Date().toISOString() })).toBe('核对物品类别，稍后自动重试（1/2）');
    expect(ledgerDeleteTaskMessage({ ...task('failed'), stage: 'checking-latest', message: '库存已变化' })).toBe('核对最新库存 · 库存已变化');
  });

  it('replaces an in-flight chain and ignores the late response even if transport ignores abort', async () => {
    const old = deferred<InventoryLedgerDeletionTask>(), newer = deferred<InventoryLedgerDeletionTask>();
    const read = jest.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise), done = jest.fn(), error = jest.fn();
    const polling = createLedgerDeletePolling({ read, task: done, error });
    polling.start(request); const oldSignal = read.mock.calls[0][1] as AbortSignal;
    polling.start(request); expect(oldSignal.aborted).toBe(true);
    old.resolve(task('completed')); await settle(); expect(done).not.toHaveBeenCalled();
    newer.resolve(task('completed')); await settle(); expect(done).toHaveBeenCalledTimes(1);
    await jest.runAllTimersAsync(); expect(read).toHaveBeenCalledTimes(2); expect(error).not.toHaveBeenCalled();
  });

  it('cancels the sole next timer on close/unmount or account switch', async () => {
    const read = jest.fn().mockResolvedValue(task()), done = jest.fn(), error = jest.fn();
    const polling = createLedgerDeletePolling({ read, task: done, error });
    polling.start(request); await settle(); expect(jest.getTimerCount()).toBe(1);
    polling.stop(); expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(60_000); expect(read).toHaveBeenCalledTimes(1);
    polling.start(request); await settle(); expect(jest.getTimerCount()).toBe(1);
    polling.start(request); await settle(); expect(jest.getTimerCount()).toBe(1);
    polling.stop();
  });

  it('does not surface cancellation errors or let a stale account response schedule another read', async () => {
    const old = deferred<InventoryLedgerDeletionTask>();
    const read = jest.fn().mockReturnValue(old.promise), done = jest.fn(), error = jest.fn();
    const polling = createLedgerDeletePolling({ read, task: done, error });
    polling.start(request); polling.stop(); old.reject(new Error('cancelled')); await settle();
    expect(done).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
  });

  it('stops on failed/completed results and never performs an automatic delete request', async () => {
    const read = jest.fn().mockResolvedValue(task('failed')), done = jest.fn(), error = jest.fn();
    const polling = createLedgerDeletePolling({ read, task: done, error });
    polling.start(request); await settle(); await jest.runAllTimersAsync();
    expect(read).toHaveBeenCalledTimes(1); expect(done).toHaveBeenCalledWith(request, expect.objectContaining({ status: 'failed' }));
    expect(jest.getTimerCount()).toBe(0); expect(error).not.toHaveBeenCalled();
  });

  it('limits a persistent pending/uncertain result to one bounded polling chain', async () => {
    const read = jest.fn().mockResolvedValue(task('uncertain')), waiting = jest.fn(), error = jest.fn();
    const polling = createLedgerDeletePolling({ read, task: jest.fn(), error, waiting });
    polling.start(request); await settle(); await jest.runAllTimersAsync();
    expect(read).toHaveBeenCalledTimes(61); expect(jest.getTimerCount()).toBe(0);
    expect(waiting).toHaveBeenCalledTimes(1); expect(error).not.toHaveBeenCalled();
    expect(read.mock.calls.every(([value]) => value.clientMutationId === request.clientMutationId)).toBe(true);
  });

  it('rejects a mismatched task and stops instead of updating the selected record', async () => {
    const read = jest.fn().mockResolvedValue({ ...task('completed'), recordId: 'rec_someone_else' }), done = jest.fn(), error = jest.fn();
    const polling = createLedgerDeletePolling({ read, task: done, error });
    polling.start(request); await settle();
    expect(done).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: '删除状态返回异常' }));
    expect(jest.getTimerCount()).toBe(0);
  });
});
