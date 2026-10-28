import type { ReactElement, ReactNode } from 'react';
import type { PurchaseApplicationApplicant } from '../../shared/purchase-application.interface';

const mockSlots: any[] = [];
const mockEffects = new Map<number, () => void>();
let mockCursor = 0;
let mockDirty = false;
let mockEffectsEnabled = false;
let mockStateWrites = 0;
let mockPrincipal: any = { role: 'admin', purchaseBuilding: null };
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: (initial: unknown) => {
    const index = mockCursor++;
    if (!(index in mockSlots)) mockSlots[index] = typeof initial === 'function' ? initial() : initial;
    return [mockSlots[index], (next: any) => {
      mockStateWrites++;
      const value = typeof next === 'function' ? next(mockSlots[index]) : next;
      if (!Object.is(value, mockSlots[index])) { mockSlots[index] = value; mockDirty = true; }
    }];
  },
  useRef: (initial: unknown) => { const index = mockCursor++; return mockSlots[index] ??= { current: initial }; },
  useMemo: (factory: () => unknown, dependencies: unknown[]) => {
    const index = mockCursor++, previous = mockSlots[index];
    if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) mockSlots[index] = { value: factory(), dependencies };
    return mockSlots[index].value;
  },
  useCallback: (callback: unknown, dependencies: unknown[]) => {
    const index = mockCursor++, previous = mockSlots[index];
    if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) mockSlots[index] = { value: callback, dependencies };
    return mockSlots[index].value;
  },
  useEffect: (factory: () => void | (() => void), dependencies: unknown[]) => {
    const index = mockCursor++, previous = mockSlots[index];
    if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
      const state = { dependencies, cleanup: previous?.cleanup }; mockSlots[index] = state;
      if (mockEffectsEnabled) mockEffects.set(index, () => { state.cleanup?.(); state.cleanup = factory() || undefined; });
    }
  },
}));
jest.mock('@/access/AccessProvider', () => ({ useAccess: () => mockPrincipal }), { virtual: true });
jest.mock('@/api', () => ({ searchInventoryApplicants: jest.fn(), searchPurchaseApplicationApplicants: jest.fn() }), { virtual: true });
jest.mock('sonner', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));
jest.mock('lucide-react', () => Object.fromEntries(['ArrowDownToLine', 'ArrowUpFromLine', 'CalendarClock', 'CheckCircle2', 'History', 'Loader2', 'MapPin', 'PackageSearch', 'Search', 'UserRound'].map(name => [name, 'i'])));
jest.mock('@/components/ui/badge', () => ({ Badge: 'span' }), { virtual: true });
jest.mock('@/components/ui/button', () => ({ Button: 'button' }), { virtual: true });
jest.mock('@/components/ui/dialog', () => ({ Dialog: 'div', DialogContent: 'div', DialogDescription: 'p', DialogFooter: 'div', DialogHeader: 'div', DialogTitle: 'h2' }), { virtual: true });
jest.mock('@/components/ui/input', () => ({ Input: 'input' }), { virtual: true });
jest.mock('@/components/ui/label', () => ({ Label: 'label' }), { virtual: true });
jest.mock('@/components/ui/native-select', () => ({ NativeSelect: 'select', NativeSelectOption: 'option' }), { virtual: true });
jest.mock('@/components/ui/textarea', () => ({ Textarea: 'textarea' }), { virtual: true });
jest.mock('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }), { virtual: true });
jest.mock('../../client/src/pages/InventoryManagement/WarehouseStorageLocationField', () => ({ WarehouseStorageLocationField: 'div' }));

import { isValidElement } from 'react';
import { InventoryMovementCreateDialog } from '../../client/src/pages/InventoryManagement/InventoryMovementCreateDialog';
import { searchInventoryApplicants, searchPurchaseApplicationApplicants } from '@/api';

function nodes(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<any>(node) ? [node, ...nodes(node.props.children)] : [];
}
function words(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(words).join('');
  return isValidElement<any>(node) ? words(node.props.children) : '';
}
function person(name = '合成申请人'): PurchaseApplicationApplicant {
  return { recordId: `rec-${name}`, openId: `ou-${name}`, name, building: 'H楼', specialty: '电气', position: '运维值班员', employeeNo: 'SYNTHETIC' };
}
function pending<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

// Node-only hook harness exercises real handlers/effects; layout and focus need browser acceptance.
function mountPicker(label = '物品申请人', selected: PurchaseApplicationApplicant | null = null, defaultToSelf = false) {
  const dialog = InventoryMovementCreateDialog({ type: 'borrow', open: true, onOpenChange: jest.fn(), onCreated: jest.fn() });
  const pickerNode = nodes(dialog).find(node => typeof node.type === 'function' && node.type.name === 'EmployeePicker')!;
  expect(pickerNode).toBeDefined();
  const Component = pickerNode.type as (props: any) => ReactElement;
  mockSlots.length = 0; mockCursor = 0; mockEffects.clear(); mockEffectsEnabled = true;
  const props = { label, required: true, value: selected, defaultToSelf, onChange: jest.fn((value: PurchaseApplicationApplicant | null) => { props.value = value; }) };
  let tree: ReactElement;
  function draw() {
    let iterations = 0;
    do {
      if (++iterations > 10) throw new Error('Hook harness failed to settle');
      mockDirty = false; mockCursor = 0; tree = Component(props);
      const effects = [...mockEffects.values()]; mockEffects.clear(); effects.forEach(effect => effect());
    } while (mockDirty || mockEffects.size);
    return tree;
  }
  draw();
  return {
    draw,
    text: () => words(draw()),
    input: () => nodes(draw()).find(node => node.type === 'input')!,
    change(value: string) { nodes(draw()).find(node => node.type === 'input')!.props.onChange({ target: { value } }); draw(); },
    click(label: string) { const button = nodes(draw()).find(node => node.type === 'button' && words(node.props.children).includes(label))!; expect(button).toBeDefined(); button.props.onClick(); draw(); },
    onChange: props.onChange,
    unmount() { for (const slot of mockSlots) slot?.cleanup?.(); mockEffects.clear(); },
  };
}

describe('inventory applicant picker recovery and request isolation', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  beforeEach(() => {
    mockSlots.length = 0; mockCursor = 0; mockEffects.clear(); mockEffectsEnabled = false; mockStateWrites = 0;
    mockPrincipal = { role: 'admin', purchaseBuilding: null };
    jest.clearAllMocks(); jest.useFakeTimers();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout, clearTimeout } });
  });
  afterEach(() => {
    for (const slot of mockSlots) slot?.cleanup?.();
    jest.clearAllTimers(); jest.useRealTimers();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  });

  it.each(['物品申请人', '经办人'])('searches %s through inventory permissions, shows loading during debounce, and selects stable identity', async label => {
    const applicant = person(); (searchInventoryApplicants as jest.Mock).mockResolvedValue([applicant]);
    const picker = mountPicker(label); picker.change('合成');
    expect(picker.input().props.value).toBe('合成');
    expect(picker.text()).toContain('正在搜索'); expect(picker.text()).not.toContain('没有匹配');
    expect(searchInventoryApplicants).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(250); picker.draw();
    expect(searchInventoryApplicants).toHaveBeenCalledWith({ query: '合成', limit: 20 });
    expect(searchPurchaseApplicationApplicants).not.toHaveBeenCalled();
    picker.click(applicant.name);
    expect(picker.onChange).toHaveBeenLastCalledWith(applicant); expect(picker.input().props.value).toBe(applicant.name);
    expect(picker.text()).not.toContain('正在搜索'); expect(jest.getTimerCount()).toBe(0);
  });

  it('preserves query and useful failure, keeps failure distinct from empty results, and retries current query once', async () => {
    (searchInventoryApplicants as jest.Mock).mockRejectedValueOnce({ response: { data: { message: '当前账号无出库权限，请联系管理员' } } }).mockResolvedValueOnce([person()]);
    const picker = mountPicker(); picker.change('合成'); await jest.advanceTimersByTimeAsync(250); picker.draw();
    expect(picker.input().props.value).toBe('合成'); expect(picker.text()).toContain('当前账号无出库权限');
    expect(picker.text()).not.toContain('没有匹配'); expect(picker.text()).not.toContain('正在搜索');
    picker.click('重新搜索'); expect(picker.text()).toContain('正在搜索');
    await jest.advanceTimersByTimeAsync(250); picker.draw();
    expect(searchInventoryApplicants).toHaveBeenCalledTimes(2); expect(picker.text()).toContain('合成申请人');
    expect(picker.text()).not.toContain('当前账号无出库权限');
  });

  it('shows empty results only after a successful empty response and debounces continuous input', async () => {
    (searchInventoryApplicants as jest.Mock).mockResolvedValue([]);
    const picker = mountPicker(); picker.change('合'); await jest.advanceTimersByTimeAsync(100); picker.change('合成');
    await jest.advanceTimersByTimeAsync(249); expect(searchInventoryApplicants).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1); picker.draw();
    expect(searchInventoryApplicants).toHaveBeenCalledTimes(1); expect(picker.text()).toContain('没有匹配的在职人员');
  });

  it.each(['resolve', 'reject'] as const)('ignores late %s from the previous query', async settle => {
    const old = pending<PurchaseApplicationApplicant[]>(), current = pending<PurchaseApplicationApplicant[]>();
    (searchInventoryApplicants as jest.Mock).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const picker = mountPicker(); picker.change('旧姓名'); await jest.advanceTimersByTimeAsync(250);
    picker.change('新姓名'); await jest.advanceTimersByTimeAsync(250);
    current.resolve([person('新姓名')]); await Promise.resolve(); picker.draw();
    if (settle === 'resolve') old.resolve([person('旧姓名')]); else old.reject(new Error('旧搜索失败'));
    await Promise.resolve(); picker.draw();
    expect(picker.text()).toContain('新姓名'); expect(picker.text()).not.toContain('旧姓名'); expect(picker.text()).not.toContain('旧搜索失败');
  });

  it('clears stale errors when typing again and does not reuse a failed query on retry', async () => {
    (searchInventoryApplicants as jest.Mock).mockRejectedValueOnce(new Error('读取超时')).mockResolvedValueOnce([person('新姓名')]);
    const picker = mountPicker(); picker.change('旧姓名'); await jest.advanceTimersByTimeAsync(250); picker.draw();
    expect(picker.text()).toContain('读取超时'); picker.change('新姓名'); expect(picker.text()).not.toContain('读取超时');
    await jest.advanceTimersByTimeAsync(250); picker.draw();
    expect(searchInventoryApplicants).toHaveBeenLastCalledWith({ query: '新姓名', limit: 20 }); expect(picker.text()).toContain('新姓名');
  });

  it('retains a restored selected applicant without searching and cancels a pending debounce on unmount', () => {
    const applicant = person(), restored = mountPicker('物品申请人', applicant);
    expect(restored.input().props.value).toBe(applicant.name); expect(searchInventoryApplicants).not.toHaveBeenCalled(); restored.unmount();
    mockSlots.length = 0; mockCursor = 0; mockEffectsEnabled = false;
    const picker = mountPicker(); picker.change('合成'); expect(jest.getTimerCount()).toBe(1); picker.unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ignores an inflight failure after clearing input or unmounting', async () => {
    const request = pending<PurchaseApplicationApplicant[]>(); (searchInventoryApplicants as jest.Mock).mockReturnValue(request.promise);
    const picker = mountPicker(); picker.change('合成'); await jest.advanceTimersByTimeAsync(250); picker.change('');
    picker.unmount(); const writes = mockStateWrites; request.reject(new Error('late failure')); await Promise.resolve();
    expect(mockStateWrites).toBe(writes); expect(picker.onChange).toHaveBeenLastCalledWith(null);
  });

  it('defaults to canonical authenticated identity once, then lets the user clear or choose another person', async () => {
    const self = person('真实本人'); (searchInventoryApplicants as jest.Mock).mockResolvedValue([self]);
    const picker = mountPicker('物品申请人', null, true);
    expect(searchInventoryApplicants).toHaveBeenCalledWith({ self: true, limit: 1 });
    await Promise.resolve(); picker.draw();
    expect(picker.onChange).toHaveBeenLastCalledWith(self); expect(picker.input().props.value).toBe(self.name);
    picker.change(''); await Promise.resolve(); picker.draw();
    expect(picker.input().props.value).toBe(''); expect(searchInventoryApplicants).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)('never replaces manual typing with a late self %s', async settle => {
    const self = pending<PurchaseApplicationApplicant[]>(); (searchInventoryApplicants as jest.Mock).mockReturnValueOnce(self.promise).mockResolvedValueOnce([person('手选人员')]);
    const picker = mountPicker('物品申请人', null, true); picker.change('手选');
    await jest.advanceTimersByTimeAsync(250); picker.draw(); picker.click('手选人员');
    if (settle === 'resolve') self.resolve([person('真实本人')]); else self.reject(new Error('本人查询迟到失败'));
    await Promise.resolve(); await Promise.resolve(); picker.draw();
    expect(picker.input().props.value).toBe('手选人员'); expect(picker.onChange).toHaveBeenLastCalledWith(person('手选人员'));
    expect(picker.text()).not.toContain('本人查询迟到失败');
  });

  it('keeps an unavailable default editable and retries only the canonical self request when input remains empty', async () => {
    (searchInventoryApplicants as jest.Mock).mockRejectedValueOnce(new Error('当前申请人加载超时')).mockResolvedValueOnce([person('真实本人')]);
    const picker = mountPicker('物品申请人', null, true);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); picker.draw();
    expect(picker.input().props.value).toBe(''); expect(picker.text()).toContain('当前申请人加载超时');
    expect(picker.text()).not.toContain('没有匹配的在职人员'); picker.click('重新搜索');
    await Promise.resolve(); await Promise.resolve(); picker.draw();
    expect(searchInventoryApplicants).toHaveBeenCalledTimes(2); expect(searchInventoryApplicants).toHaveBeenLastCalledWith({ self: true, limit: 1 });
    expect(picker.input().props.value).toBe('真实本人');
  });

  it('does not guess a default when self resolution returns no stable identity', async () => {
    (searchInventoryApplicants as jest.Mock).mockResolvedValue([]);
    const picker = mountPicker('物品申请人', null, true);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); picker.draw();
    expect(picker.onChange).not.toHaveBeenCalled(); expect(picker.text()).toContain('未匹配到当前申请人，请输入姓名选择');
  });

  it('invalidates an inflight self request on unmount', async () => {
    const self = pending<PurchaseApplicationApplicant[]>(); (searchInventoryApplicants as jest.Mock).mockReturnValue(self.promise);
    const picker = mountPicker('物品申请人', null, true); picker.unmount(); const writes = mockStateWrites;
    self.resolve([person()]); await Promise.resolve(); await Promise.resolve();
    expect(picker.onChange).not.toHaveBeenCalled(); expect(mockStateWrites).toBe(writes);
  });

  it('enables self default only for a new outbound personal authenticated account, never shared, restored, borrow or operator', () => {
    function pickers(type: 'outbound' | 'borrow', initialOutboundDraft?: any) {
      mockSlots.length = 0; mockCursor = 0; mockEffects.clear(); mockEffectsEnabled = false;
      const tree = InventoryMovementCreateDialog({ type, open: true, onOpenChange: jest.fn(), onCreated: jest.fn(), initialOutboundDraft });
      return nodes(tree).filter(node => typeof node.type === 'function' && node.type.name === 'EmployeePicker');
    }
    mockPrincipal = { role: 'guest', accountId: 'feishu-synthetic', purchaseBuilding: null, principalFingerprint: 'synthetic-fingerprint', expiresAt: Date.now() + 1000 };
    expect(pickers('outbound')[0].props.defaultToSelf).toBe(true);
    expect(pickers('outbound', { applicant: person() })[0].props.defaultToSelf).toBe(false);
    expect(pickers('borrow').every(node => !node.props.defaultToSelf)).toBe(true);
    mockPrincipal = { ...mockPrincipal, expiresAt: null, principalFingerprint: null };
    expect(pickers('outbound')[0].props.defaultToSelf).toBe(false);
    mockPrincipal = { role: 'inventory_admin', accountId: 'shared-warehouse', purchaseBuilding: 'H楼' };
    expect(pickers('outbound')[0].props.defaultToSelf).toBe(false);
  });
});
