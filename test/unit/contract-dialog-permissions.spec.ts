import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { BusinessAction } from '../../shared/business-permissions';
import type { ContractCreateOptionsResponse, ContractEditOptionsResponse, ContractManagementItem } from '../../shared/contract-management.interface';
import type { ContractCreateDraft } from '../../client/src/pages/ContractManagement/contract-creation.logic';
import type { ContractEditDraft } from '../../client/src/pages/ContractManagement/contract-edit.logic';

const mockSlots: unknown[] = [];
let mockCursor = 0;
let mockPrincipal: AccessPrincipal;
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: (initial: unknown) => {
    const slot = mockCursor++;
    if (!(slot in mockSlots)) mockSlots[slot] = typeof initial === 'function' ? initial() : initial;
    return [mockSlots[slot], (value: unknown) => { mockSlots[slot] = typeof value === 'function' ? value(mockSlots[slot]) : value; }];
  },
  useRef: (initial: unknown) => { const slot = mockCursor++; if (!(slot in mockSlots)) mockSlots[slot] = { current: initial }; return mockSlots[slot]; },
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
}));
jest.mock('@/access/AccessProvider', () => ({ useAccess: () => mockPrincipal }));
jest.mock('@/api', () => ({
  getContractCreateOptions: jest.fn(), createContract: jest.fn(), getContractEditOptions: jest.fn(), updateContractInformation: jest.fn(),
  getContractPaymentFollowUpOptions: jest.fn(), createContractPaymentPlan: jest.fn(), adjustContractPaymentPlan: jest.fn(), confirmContractPaymentPlan: jest.fn(),
  getContractExpiryDispositionTaskStatus: jest.fn(), updateContractExpiryDisposition: jest.fn(),
  getContractAttachmentManifest: jest.fn(), getContractAttachmentDownloadUrl: (id: string) => `/download/${id}`,
  getContractAttachmentInlineUrl: (id: string) => `/download/${id}?disposition=inline`, getContractAttachmentPageUrl: (id: string, page: number) => `/preview/${id}/${page}`,
  getContractWorkflowStatus: jest.fn(), runContractWorkflow: jest.fn(), runContractWorkflowSelfTest: jest.fn(),
}));

import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { ContractCreationDialog, contractCreationPermissionScope } from '../../client/src/pages/ContractManagement/ContractCreationDialog';
import { contractEditPermissionScope } from '../../client/src/pages/ContractManagement/ContractEditDialog';
import { ContractAttachmentViewer } from '../../client/src/pages/ContractManagement/ContractAttachmentViewer';
import { ContractWorkflowPanel, canRunAllContractNotifications } from '../../client/src/pages/ContractManagement/ContractWorkflowPanel';
import { canUseContractAction, contractPaymentPermissions } from '../../client/src/pages/ContractManagement/contract-permissions';
import { availablePaymentActions } from '../../client/src/pages/ContractManagement/contract-payment-follow-up.logic';
import { assertGlobalBusinessOperation } from '../../server/common/access/global-business-operation';
import { getContractCreateOptions } from '@/api';

function principal(actions: BusinessAction[], global = false): AccessPrincipal {
  return { role: 'guest', purchaseBuilding: null, effectiveAuthorization: { mode: 'independent',
    baseline: { nativeRole: null, pages: [], rules: [{ id: 'synthetic-contract-rule', module: 'contracts', effect: 'allow', actions, buildings: global ? null : ['B楼'], specialties: global ? null : ['电气'] }] },
    overrides: { rules: [], allowPages: [], denyPages: [] },
  } };
}
function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function label(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(label).join('');
  if (isValidElement<Record<string, any>>(node)) return label(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
const scope = { specialty: '电气', buildings: ['B楼'] };
const contract = { recordId: 'recSynthetic', code: 'SYNTHETIC', name: '合成合同', ...scope,
  attachments: [{ accessId: 'synthetic-attachment', name: '合成附件.pdf', previewStatus: 'ready', pageCount: 1 }] } as ContractManagementItem;
const fields = [{ fieldId: 'scope-specialty', name: '专业类别' }, { fieldId: 'scope-buildings', name: '对应楼栋设备' }];

describe('contract dialogs use action and actual scope, including an independent guest base', () => {
  beforeEach(() => { mockSlots.length = 0; mockCursor = 0; mockPrincipal = principal(['read']); jest.clearAllMocks(); });
  it('allows a create-only profile to begin creation and blocks read-only from loading create options', async () => {
    const props = { open: true, onOpenChange: jest.fn(), onCreated: jest.fn() };
    let step = elements(ContractCreationDialog(props)).find(node => typeof node.type === 'function' && node.type.name === 'ContractKindStep')!;
    expect(step.props.canCreate).toBe(false);
    await step.props.onChoose('execution');
    expect(getContractCreateOptions).not.toHaveBeenCalled();
    mockPrincipal = principal(['create']); mockSlots.length = 0; mockCursor = 0;
    step = elements(ContractCreationDialog(props)).find(node => typeof node.type === 'function' && node.type.name === 'ContractKindStep')!;
    expect(step.props.canCreate).toBe(true); expect(step.props.canCreateFramework).toBe(false);
  });
  it('maps current field IDs from metadata and does not widen a draft with multiple or unknown buildings', () => {
    const draft = { fields: { 'scope-specialty': '电气', 'scope-buildings': 'B楼 UPS设备' } } as unknown as ContractCreateDraft;
    const options = { fields } as ContractCreateOptionsResponse;
    expect(contractCreationPermissionScope(draft, options)).toEqual(scope);
    expect(canUseContractAction(principal(['create']), 'create', contractCreationPermissionScope(draft, options))).toBe(true);
    draft.fields['scope-buildings'] = 'B楼、C楼';
    expect(canUseContractAction(principal(['create']), 'create', contractCreationPermissionScope(draft, options))).toBe(false);
    draft.fields['scope-buildings'] = '未维护';
    expect(canUseContractAction(principal(['create']), 'create', contractCreationPermissionScope(draft, options))).toBe(false);
    expect(contractCreationPermissionScope(null, options)).toBeNull();
  });
  it('editing preserves unchanged scope and checks the proposed new building/specialty', () => {
    const draft = { fields: {} } as ContractEditDraft;
    const options = { fields } as ContractEditOptionsResponse;
    expect(contractEditPermissionScope(contract, draft, options)).toEqual(scope);
    draft.fields['scope-buildings'] = 'C楼';
    expect(canUseContractAction(principal(['update']), 'update', contractEditPermissionScope(contract, draft, options))).toBe(false);
    expect(canUseContractAction(principal(['read']), 'update', contract)).toBe(false);
  });
  it('combines exact payment actions with paid-plan state and fails closed for missing contract scope', () => {
    const pending = availablePaymentActions([{ status: '未付款' }] as never);
    expect(contractPaymentPermissions(principal(['confirm']), pending, scope)).toEqual({ create: false, adjust: false, confirm: true, noPaymentRequired: false });
    const paid = availablePaymentActions([{ status: '已付款' }] as never);
    expect(contractPaymentPermissions(principal(['confirm']), paid, scope).confirm).toBe(false);
    expect(Object.values(contractPaymentPermissions(principal(['create', 'update', 'confirm']), pending, null)).every(value => value === false)).toBe(true);
    expect(contractPaymentPermissions(principal(['update']), availablePaymentActions([]), scope).noPaymentRequired).toBe(true);
  });
  it('keeps read-only watermarked preview available while removing original download links', () => {
    const tree = elements(ContractAttachmentViewer({ contract, open: true, onOpenChange: jest.fn() }));
    expect(tree.some(node => node.type === 'img' && String(node.props.src).startsWith('/preview/'))).toBe(true);
    expect(tree.some(node => node.type === 'a' && String(node.props.href).startsWith('/download/'))).toBe(false);
    mockPrincipal = principal(['export']); mockSlots.length = 0; mockCursor = 0;
    const downloadOnly = elements(ContractAttachmentViewer({ contract, open: true, onOpenChange: jest.fn() }));
    expect(downloadOnly.some(node => node.type === 'a' && String(node.props.href).startsWith('/download/'))).toBe(true);
    expect(downloadOnly.some(node => node.type === 'img')).toBe(false);
  });
  it('global workflow affordance matches backend all-scope notify and never treats read/refresh as notify', () => {
    for (const [value, expected] of [[principal(['notify']), false], [principal(['notify'], true), true], [principal(['read', 'refresh'], true), false]] as const) {
      expect(canRunAllContractNotifications(value)).toBe(expected);
      if (expected) expect(() => assertGlobalBusinessOperation(value, { module: 'contracts', action: 'notify' })).not.toThrow();
      else expect(() => assertGlobalBusinessOperation(value, { module: 'contracts', action: 'notify' })).toThrow();
    }
    const buttons = elements(ContractWorkflowPanel({ open: true, onClose: jest.fn() })).filter(node => node.type === 'button');
    expect(buttons.find(node => label(node).includes('只读自检'))?.props.disabled).toBe(true);
  });
});
