import type { ReactElement, ReactNode } from 'react';
const mockSlots: any[] = [];
let mockCursor = 0;
let mockAccess: any;
const mockEffects: (() => void)[] = [];
function mockMemo(factory: () => unknown, dependencies: unknown[]) {
  const slot = mockCursor++, previous = mockSlots[slot];
  if (!previous || dependencies.some((value, at) => !Object.is(value, previous.dependencies[at]))) mockSlots[slot] = { dependencies, value: factory() };
  return mockSlots[slot].value;
}
jest.mock('react', () => ({ ...jest.requireActual('react'),
  useState: (initial: unknown) => { const slot = mockCursor++; if (!(slot in mockSlots)) mockSlots[slot] = typeof initial === 'function' ? initial() : initial; return [mockSlots[slot], (next: any) => { mockSlots[slot] = typeof next === 'function' ? next(mockSlots[slot]) : next; }]; },
  useRef: (initial: unknown) => { const slot = mockCursor++; if (!(slot in mockSlots)) mockSlots[slot] = { current: initial }; return mockSlots[slot]; },
  useId: () => `synthetic-id-${mockCursor++}`,
  useMemo: mockMemo, useCallback: (callback: unknown, dependencies: unknown[]) => mockMemo(() => callback, dependencies),
  useEffect: (effect: () => any, dependencies: unknown[]) => { const slot = mockCursor++, previous = mockSlots[slot]; if (!previous || dependencies.some((value, at) => !Object.is(value, previous.dependencies[at]))) { const next = { dependencies, cleanup: previous?.cleanup }; mockSlots[slot] = next; mockEffects.push(() => { next.cleanup?.(); next.cleanup = effect(); }); } },
}));
jest.mock('../../client/src/access/AccessProvider', () => ({ useAccess: () => mockAccess }));
jest.mock('../../client/src/api', () => ({
  getPurchaseApplicationOptions: jest.fn(() => new Promise(() => undefined)),
  searchPurchaseApplicationApplicants: jest.fn(() => new Promise(() => undefined)),
  getPurchaseApplicationSubmissionTaskStatus: jest.fn(), searchPurchaseApplicationCatalog: jest.fn(), submitPurchaseApplications: jest.fn(),
}));
jest.mock('sonner', () => ({ toast: { success: jest.fn(), info: jest.fn(), warning: jest.fn(), error: jest.fn() } }));
import { isValidElement } from 'react';
import { PurchaseApplicationDialog } from '../../client/src/pages/PurchaseInventoryManagement/PurchaseApplicationDialog';
import { getPurchaseApplicationOptions } from '../../client/src/api';
import { purchaseUiPrincipalKey } from '../../client/src/pages/PurchaseInventoryManagement/purchase-ui-principal';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
function nodes(node: ReactNode): ReactElement<any>[] { return Array.isArray(node) ? node.flatMap(nodes) : isValidElement<any>(node) ? [node, ...nodes(node.props.children)] : []; }
function words(node: ReactNode): string { return typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(words).join('') : isValidElement<any>(node) ? words(node.props.children) : ''; }
const props = { open: true, onOpenChange: jest.fn(), onSubmissionStarted: jest.fn(), onSubmissionSettled: jest.fn() };
function render() { mockCursor = 0; const tree = PurchaseApplicationDialog(props); mockEffects.splice(0).forEach(effect => effect()); return tree; }
const selectedCount = () => words(render()).match(/已选 (\d+) 张图片 · 附件 (\d+)\/5/)?.[2];
function chooseFiles() {
  render();
  const input = nodes(render()).find(node => node.type === 'input' && node.props.type === 'file')!;
  input.props.onChange({ target: { files: [new File(['synthetic-one'], 'comparison-one.png', { type: 'image/png' }), new File(['synthetic-two'], 'comparison-two.png', { type: 'image/png' })], value: 'synthetic' } });
  expect(selectedCount()).toBe('2');
}

describe('purchase application attachments survive same-identity session refresh', () => {
  beforeEach(() => {
    mockSlots.length = 0; mockEffects.length = 0; mockCursor = 0; jest.clearAllMocks(); jest.useFakeTimers();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { getItem: () => null, setItem: jest.fn(), removeItem: jest.fn() }, setTimeout, clearTimeout } });
    mockAccess = { role: 'admin', purchaseBuilding: null, accountId: 'local-synthetic-admin', displayName: '合成人员', authorizationVersion: 3,
      principalFingerprint: 'synthetic-session', buildings: ['H楼'], specialties: ['电气'], personalRules: [],
      effectiveAuthorization: { mode: 'independent', baseline: { nativeRole: 'admin', pages: [], rules: [] }, overrides: { rules: [], allowPages: [], denyPages: [] } },
      isLoading: false, expiresAt: Date.now() + 60_000, requestLogin: jest.fn() };
  });
  afterEach(() => { mockSlots.forEach(slot => slot?.cleanup?.()); jest.useRealTimers(); if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window'); });
  it('preserves selected file objects and avoids reloading options on context replacement or expiry-only renewal', () => {
    chooseFiles(); const originalKey = purchaseUiPrincipalKey(mockAccess), reads = (getPurchaseApplicationOptions as jest.Mock).mock.calls.length;
    mockAccess = { ...mockAccess, expiresAt: mockAccess.expiresAt + 60_000, buildings: [...mockAccess.buildings], specialties: [...mockAccess.specialties], personalRules: [], effectiveAuthorization: structuredClone(mockAccess.effectiveAuthorization), requestLogin: jest.fn() };
    expect(purchaseUiPrincipalKey(mockAccess)).toBe(originalKey);
    render(); expect(selectedCount()).toBe('2'); expect(words(render())).toContain('comparison-one.png'); expect(words(render())).toContain('comparison-two.png');
    expect(getPurchaseApplicationOptions).toHaveBeenCalledTimes(reads);
  });
  it.each(['account', 'fingerprint', 'version', 'building', 'specialty', 'policy', 'display-name'] as const)('still discards sensitive attachments after a real %s change', change => {
    chooseFiles();
    const next = { ...mockAccess, effectiveAuthorization: structuredClone(mockAccess.effectiveAuthorization) };
    if (change === 'account') next.accountId = 'local-synthetic-other';
    if (change === 'fingerprint') next.principalFingerprint = 'synthetic-other-session';
    if (change === 'version') next.authorizationVersion += 1;
    if (change === 'building') next.buildings = ['B楼'];
    if (change === 'specialty') next.specialties = ['暖通'];
    if (change === 'policy') next.effectiveAuthorization.overrides.denyPages = ['/purchase-inventory-management'];
    if (change === 'display-name') next.displayName = '合成另一个人';
    mockAccess = next; render(); expect(selectedCount()).toBe('0');
  });
});
