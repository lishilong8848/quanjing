import type { ReactElement, ReactNode } from 'react';

type Slot = { value?: any; dependencies?: readonly unknown[]; cleanup?: () => void };
const mockSlots: Slot[] = [];
let mockCursor = 0;
let mockEffects: Array<() => void> = [];
let mockAccess: any;
const mockGetDetail = jest.fn();
const mockSubmit = jest.fn();
const mockSubmitReceipt = jest.fn();
const mockReceiptStatus = jest.fn();
const mockReceiptSettled = jest.fn();
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: (initial: unknown) => {
    const index = mockCursor++;
    if (!mockSlots[index]) mockSlots[index] = { value: typeof initial === 'function' ? initial() : initial };
    return [mockSlots[index].value, (next: any) => { mockSlots[index].value = typeof next === 'function' ? next(mockSlots[index].value) : next; }];
  },
  useRef: (initial: unknown) => {
    const index = mockCursor++;
    if (!mockSlots[index]) mockSlots[index] = { value: { current: initial } };
    return mockSlots[index].value;
  },
  useMemo: (factory: () => unknown, dependencies: readonly unknown[]) => {
    const index = mockCursor++, previous = mockSlots[index];
    if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies?.[i]))) mockSlots[index] = { value: factory(), dependencies };
    return mockSlots[index].value;
  },
  useCallback: (callback: unknown, dependencies: readonly unknown[]) => {
    const index = mockCursor++, previous = mockSlots[index];
    if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies?.[i]))) mockSlots[index] = { value: callback, dependencies };
    return mockSlots[index].value;
  },
  useEffect: (effect: () => void | (() => void), dependencies: readonly unknown[]) => {
    const index = mockCursor++, previous = mockSlots[index];
    if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies?.[i]))) {
      mockEffects.push(() => { previous?.cleanup?.(); const cleanup = effect(); mockSlots[index] = { dependencies, ...(typeof cleanup === 'function' ? { cleanup } : {}) }; });
    }
  },
}));
jest.mock('../../client/src/access/AccessProvider', () => ({ useAccess: () => mockAccess }));
jest.mock('../../client/src/api', () => ({ getPurchaseWorkflowDetail: (...args: unknown[]) => mockGetDetail(...args), submitPurchaseOnlineApproval: (...args: unknown[]) => mockSubmit(...args), getPurchaseOnlineApprovalTaskStatus: jest.fn(), submitPurchaseWorkflowReceipt: (...args: unknown[]) => mockSubmitReceipt(...args), getPurchaseWorkflowReceiptTaskStatus: (...args: unknown[]) => mockReceiptStatus(...args) }));
jest.mock('sonner', () => ({ toast: { success: jest.fn(), warning: jest.fn(), error: jest.fn() } }));

import { isValidElement } from 'react';
import { PurchaseOnlineApprovalDialog } from '../../client/src/pages/PurchaseInventoryManagement/PurchaseOnlineApprovalDialog';
import { PurchaseWorkflowDialog } from '../../client/src/pages/PurchaseInventoryManagement/PurchaseWorkflowDialog';

const nodes = (node: ReactNode): ReactElement<any>[] => Array.isArray(node) ? node.flatMap(nodes) : isValidElement<any>(node) ? [node, ...nodes(node.props.children)] : [];
const words = (node: ReactNode): string => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(words).join('') : isValidElement<any>(node) ? words(node.props.children) : '';
const button = (tree: ReactNode, label: string) => nodes(tree).find(node => typeof node.props.onClick === 'function' && words(node.props.children).includes(label));
const flushEffects = () => { const work = mockEffects; mockEffects = []; work.forEach(run => run()); };
const flushPromises = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const deferred = () => { let resolve!: (value: any) => void, reject!: (reason: Error) => void; const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const item = (id: string) => ({ recordId: id, executionRecordId: id, stage: 'approval', building: 'C楼', specialty: '电气', purchaseCompleted: false, title: id, quantity: 1, requestCode: id });
const detail = (id: string, allowed = ['approve']) => ({ record: { recordId: id, building: 'C楼', specialty: '电气' }, allowedActions: allowed });
function render(current: any) {
  mockCursor = 0;
  return PurchaseOnlineApprovalDialog({ item: current, onOpenChange: jest.fn(), onOptimisticDecision: jest.fn(), onTaskSettled: jest.fn() });
}
const workflowDetail = (id: string, allowed = ['order']) => ({ record: { recordId: id, building: 'C楼', specialty: '电气', actualQuantity: null, actualAmount: null, note: '', receiptTime: 0, purchaserName: '合成采购人' }, allowedActions: allowed, timeline: [], programEnabled: true });
function renderWorkflow(id: string, preview: any = null) {
  mockCursor = 0;
  return PurchaseWorkflowDialog({ open: true, recordId: id, item: preview, canOperate: true, onOpenChange: jest.fn(), onUpdated: jest.fn(), onOrderAccepted: jest.fn(), onOrderTaskSettled: jest.fn(), onReceiptAccepted: jest.fn(), onReceiptTaskSettled: mockReceiptSettled });
}
const orderForm = (tree: ReactNode) => nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'OrderForm');

describe('purchase approval stale request isolation', () => {
  beforeEach(() => { mockSlots.length = 0; mockEffects = []; mockCursor = 0; mockGetDetail.mockReset(); mockSubmit.mockReset(); mockAccess = { role: 'admin', accountId: 'user-a', authorizationVersion: 1, purchaseBuilding: null }; });
  it('rejects an old record response arriving after the current record has been verified', async () => {
    const old = deferred(), current = deferred(); mockGetDetail.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    let tree = render(item('rec-a')); flushEffects(); expect(button(tree, '确认通过')?.props.disabled).toBe(true);
    tree = render(item('rec-b')); flushEffects(); expect(button(tree, '确认通过')?.props.disabled).toBe(true);
    current.resolve(detail('rec-b')); await flushPromises(); tree = render(item('rec-b')); flushEffects(); expect(button(tree, '确认通过')?.props.disabled).toBe(false);
    old.resolve(detail('rec-a')); await flushPromises(); tree = render(item('rec-b')); flushEffects(); expect(button(tree, '确认通过')?.props.disabled).toBe(false);
    expect(mockSubmit).not.toHaveBeenCalled();
  });
  it('does not invent an approval role when the record has no target', () => {
    mockGetDetail.mockReturnValueOnce(deferred().promise);
    const tree = render(item('rec-a')); flushEffects();
    const target = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'ApprovalMeta' && node.props.label === '当前审批节点');
    expect(target?.props.value).toBe('待确认');
  });
  it('does not re-enable the same record from an old login or after permission is revoked', async () => {
    const old = deferred(), current = deferred(); mockGetDetail.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    render(item('rec-a')); flushEffects();
    mockAccess = { ...mockAccess, accountId: 'user-b', authorizationVersion: 2 };
    let tree = render(item('rec-a')); flushEffects(); old.resolve(detail('rec-a')); await flushPromises();
    tree = render(item('rec-a')); flushEffects(); expect(button(tree, '确认通过')?.props.disabled).toBe(true);
    current.resolve(detail('rec-a', [])); await flushPromises(); tree = render(item('rec-a')); flushEffects();
    expect(button(tree, '确认通过')?.props.disabled).toBe(true);
    expect(words(tree)).toContain('当前账号在此节点没有审批权限'); expect(mockSubmit).not.toHaveBeenCalled();
  });
  it('requires a new successful check after failure and explicit retry', async () => {
    mockGetDetail.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(detail('rec-a'));
    render(item('rec-a')); flushEffects(); await flushPromises(); let tree = render(item('rec-a')); flushEffects();
    expect(button(tree, '确认通过')?.props.disabled).toBe(true);
    const retry = button(tree, '重新加载'); expect(retry).toBeDefined(); retry!.props.onClick();
    tree = render(item('rec-a')); flushEffects(); expect(button(tree, '确认通过')?.props.disabled).toBe(true);
    await flushPromises(); tree = render(item('rec-a')); flushEffects(); expect(button(tree, '确认通过')?.props.disabled).toBe(false);
    expect(mockSubmit).not.toHaveBeenCalled();
  });
  it('keeps stale workflow responses and old-session permissions from showing an order form', async () => {
    const old = deferred(), current = deferred(); mockGetDetail.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    renderWorkflow('rec-a'); flushEffects();
    mockAccess = { ...mockAccess, accountId: 'user-b', authorizationVersion: 2 };
    let tree = renderWorkflow('rec-b'); flushEffects();
    old.resolve(workflowDetail('rec-a')); await flushPromises(); tree = renderWorkflow('rec-b'); flushEffects();
    expect(orderForm(tree)).toBeUndefined();
    current.resolve(workflowDetail('rec-b', [])); await flushPromises(); tree = renderWorkflow('rec-b'); flushEffects();
    expect(orderForm(tree)).toBeUndefined();
    expect(mockSubmit).not.toHaveBeenCalled();
  });
  it('shows an order form only after current server detail succeeds, not after a failed request', async () => {
    mockGetDetail.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(workflowDetail('rec-a'));
    const preview = { ...item('rec-a'), stage: 'executing', actualQuantity: null, actualAmount: null };
    renderWorkflow('rec-a', preview); flushEffects(); await flushPromises(); let tree = renderWorkflow('rec-a', preview); flushEffects();
    expect(orderForm(tree)).toBeUndefined();
    const retry = button(tree, '重新加载'); expect(retry).toBeDefined(); retry!.props.onClick();
    tree = renderWorkflow('rec-a', preview); flushEffects(); expect(orderForm(tree)).toBeUndefined();
    await flushPromises(); tree = renderWorkflow('rec-a', preview); flushEffects();
    expect(orderForm(tree)).toBeDefined(); expect(words(tree)).toContain('合成采购人');
    expect(mockSubmit).not.toHaveBeenCalled();
  });
  it('immediately hides an order on permission change and does not trust a conflicting preview', async () => {
    mockGetDetail.mockResolvedValueOnce(workflowDetail('rec-a')).mockResolvedValueOnce(workflowDetail('rec-a', []));
    const preview = { ...item('rec-a'), stage: 'executing', actualQuantity: null, actualAmount: null };
    renderWorkflow('rec-a', preview); flushEffects(); await flushPromises(); let tree = renderWorkflow('rec-a', preview); flushEffects();
    expect(orderForm(tree)).toBeDefined();
    mockAccess = { role: 'guest', accountId: 'user-a', authorizationVersion: 2, purchaseBuilding: null,
      effectiveAuthorization: { mode: 'independent', baseline: { nativeRole: null, pages: [], rules: [] }, overrides: { rules: [], allowPages: [], denyPages: [] } } };
    tree = renderWorkflow('rec-a', preview); expect(orderForm(tree)).toBeUndefined(); flushEffects();
    await flushPromises(); tree = renderWorkflow('rec-a', preview); flushEffects(); expect(orderForm(tree)).toBeUndefined();
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});

describe('independent receipt submissions', () => {
  const originalWindow = global.window;
  const form = (tree: ReactNode) => nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'ReceiptForm');
  async function prepare(id: string) {
    renderWorkflow(id); flushEffects(); await flushPromises();
    let tree = renderWorkflow(id); flushEffects();
    const current = form(tree); expect(current).toBeDefined();
    current!.props.onSignerSelect({ name: '合成签收人', openId: 'ou_fixture' });
    tree = renderWorkflow(id); flushEffects();
    return form(tree)!;
  }
  beforeEach(() => {
    jest.useFakeTimers();
    global.window = { setTimeout, clearTimeout } as never;
    mockSlots.length = 0; mockEffects = []; mockCursor = 0;
    mockAccess = { role: 'admin', accountId: 'user-a', authorizationVersion: 1, purchaseBuilding: null };
    mockGetDetail.mockReset().mockImplementation(async (id: string) => workflowDetail(id, ['receive']));
    mockSubmitReceipt.mockReset(); mockReceiptStatus.mockReset(); mockReceiptSettled.mockReset().mockResolvedValue(true);
  });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); global.window = originalWindow; });
  it('allows another record while the first is awaiting acceptance and does not unlock that record when the first finishes', async () => {
    const first = deferred(), second = deferred();
    mockSubmitReceipt.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    (await prepare('rec-a')).props.onSubmit(); jest.runOnlyPendingTimers();
    (await prepare('rec-b')).props.onSubmit(); jest.runOnlyPendingTimers();
    expect(mockSubmitReceipt.mock.calls.map(args => args[0])).toEqual(['rec-a', 'rec-b']);
    mockReceiptStatus.mockResolvedValue({ success: true, task: { status: 'completed', message: '完成', notificationWarnings: [] } });
    first.resolve({ taskId: 'task-a', pending: true, message: '已受理' });
    for (let i = 0; i < 5; i++) await flushPromises();
    (await prepare('rec-b')).props.onSubmit(); jest.runOnlyPendingTimers();
    expect(mockSubmitReceipt).toHaveBeenCalledTimes(2);
    expect(mockReceiptSettled).toHaveBeenCalledWith('rec-a', 'completed');
  });
  it('keeps the same record locked while its accepted background task is still pending', async () => {
    const status = deferred();
    mockSubmitReceipt.mockResolvedValue({ taskId: 'task-a', pending: true, message: '已受理' });
    mockReceiptStatus.mockReturnValue(status.promise);
    (await prepare('rec-a')).props.onSubmit(); jest.runOnlyPendingTimers(); await flushPromises();
    (await prepare('rec-a')).props.onSubmit(); jest.runOnlyPendingTimers();
    expect(mockSubmitReceipt).toHaveBeenCalledTimes(1);
  });
  it('discards an accepted response after switching login identity', async () => {
    const acceptance = deferred(); mockSubmitReceipt.mockReturnValue(acceptance.promise);
    (await prepare('rec-a')).props.onSubmit(); jest.runOnlyPendingTimers();
    mockAccess = { ...mockAccess, accountId: 'user-b' }; renderWorkflow('rec-a'); flushEffects();
    acceptance.resolve({ taskId: 'task-a', pending: true, message: '已受理' }); await flushPromises();
    expect(mockReceiptStatus).not.toHaveBeenCalled(); expect(mockReceiptSettled).not.toHaveBeenCalled();
  });
  it('requires verified current permissions before exposing receipt submission', async () => {
    mockGetDetail.mockReturnValue(deferred().promise);
    const tree = renderWorkflow('rec-a'); flushEffects();
    expect(form(tree)).toBeUndefined(); expect(mockSubmitReceipt).not.toHaveBeenCalled();
  });
});
