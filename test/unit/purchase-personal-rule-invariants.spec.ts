import { PurchaseAccessPolicyService } from '../../server/modules/purchase-inventory/purchase-access-policy.service';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { PurchaseInventoryRequestItem, PurchaseInventoryResponse } from '../../shared/purchase-inventory.interface';

const rules = (actions: ('read' | 'update' | 'delete')[] = ['read', 'update', 'delete']): AccessPrincipal['personalRules'] => [
  { id: 'synthetic-purchase-B', module: 'purchase', effect: 'allow', actions, buildings: ['B楼'], specialties: ['电气'] },
];
function setup(stage: PurchaseInventoryRequestItem['stage'] = 'approval', completed = false) {
  const item = { recordId: 'recRoute', submissionRecordId: 'recSubmission', executionRecordId: 'recExecution', building: 'B楼', specialty: '电气', stage, purchaseCompleted: completed } as PurchaseInventoryRequestItem;
  const getDashboard = jest.fn(async () => ({ requests: [item], sectionStatus: {} } as PurchaseInventoryResponse));
  return { item, getDashboard, policy: new PurchaseAccessPolicyService({ getDashboard } as never) };
}
const request = { submissionRecordId: 'recSubmission', executionRecordId: 'recExecution', fields: { notes: 'synthetic edit' } };
const targets = { records: [{ submissionRecordId: 'recSubmission', executionRecordId: 'recExecution' }] };
const applicant: AccessPrincipal = { role: 'purchase_applicant', purchaseBuilding: 'A楼', personalRules: rules() };

describe('personal purchase scope cannot override business invariants', () => {
  it.each(['editor', 'building_admin', 'purchase_admin', 'purchase_applicant', 'professional_admin'] as const)('%s cannot edit status through a personal rule', async role => {
    const { policy, getDashboard } = setup();
    await expect(policy.prepareUpdate({ ...applicant, role, specialties: ['电气'] }, 'recRoute', { ...request, fields: { status: 'stocked' } })).rejects.toThrow();
    expect(getDashboard).not.toHaveBeenCalled();
  });
  it('retains the admin status override with matching typed record identities', async () => {
    const { policy } = setup();
    await expect(policy.prepareUpdate({ role: 'admin', purchaseBuilding: null }, 'recRoute', { ...request, fields: { status: 'stocked' } })).resolves.toBeDefined();
    await expect(policy.prepareUpdate({ role: 'admin', purchaseBuilding: null }, 'recRoute', { ...request, executionRecordId: 'recAnother', fields: { status: 'stocked' } })).rejects.toThrow();
  });
  it.each([{ building: 'B楼' }, { requesterOpenId: 'ou_another' }])('cannot replace applicant ownership fields %j', async fields => {
    await expect(setup().policy.prepareUpdate(applicant, 'recRoute', { ...request, fields })).rejects.toThrow();
  });
  it.each([['executing', false], ['approval', true], ['stocked', false]] as const)('applicant cannot edit/delete stage %s completed %s', async (stage, completed) => {
    const { policy } = setup(stage, completed);
    await expect(policy.prepareUpdate(applicant, 'recRoute', request)).rejects.toThrow();
    await expect(policy.authorizeDelete(applicant, targets)).rejects.toThrow();
  });
  it('honors an explicit cross-building allow only for an eligible applicant record', async () => {
    await expect(setup().policy.prepareUpdate(applicant, 'recRoute', request)).resolves.toBe(request);
    await expect(setup().policy.authorizeDelete(applicant, targets)).resolves.toBe(targets);
    const readOnly = { ...applicant, personalRules: rules(['read']) };
    await expect(setup().policy.prepareUpdate(readOnly, 'recRoute', request)).rejects.toThrow();
    await expect(setup().policy.authorizeDelete(readOnly, targets)).rejects.toThrow();
  });
  it('keeps editor deletion limited to stocked records even with explicit delete allow', async () => {
    const editor: AccessPrincipal = { ...applicant, role: 'editor' };
    await expect(setup('approval').policy.authorizeDelete(editor, targets)).rejects.toThrow();
    await expect(setup('stocked').policy.authorizeDelete(editor, targets)).resolves.toBe(targets);
  });
  it('honors an overlapping deny and rejects mismatched typed identities', async () => {
    const denied: AccessPrincipal = { ...applicant, personalRules: [...rules()!, { id: 'synthetic-deny-B', module: 'purchase', effect: 'deny', actions: ['update', 'delete'], buildings: ['B楼'], specialties: ['电气'] }] };
    await expect(setup().policy.prepareUpdate(denied, 'recRoute', request)).rejects.toThrow();
    await expect(setup().policy.authorizeDelete(denied, targets)).rejects.toThrow();
    await expect(setup().policy.prepareUpdate(applicant, 'recRoute', { ...request, executionRecordId: 'recAnother' })).rejects.toThrow();
  });
  it('applies effective authorization to scope but keeps applicant business constraints', async () => {
    const principal: AccessPrincipal = { role: 'purchase_applicant', purchaseBuilding: 'A楼', effectiveAuthorization: {
      mode: 'independent', baseline: { nativeRole: null, pages: ['/purchase-inventory-management'], rules: rules()! },
      overrides: { rules: [], allowPages: [], denyPages: [] },
    } };
    await expect(setup().policy.prepareUpdate(principal, 'recRoute', request)).resolves.toBe(request);
    await expect(setup('stocked').policy.prepareUpdate(principal, 'recRoute', request)).rejects.toThrow();
    await expect(setup().policy.prepareUpdate(principal, 'recRoute', { ...request, fields: { requesterOpenId: 'ou_another' } })).rejects.toThrow();
    await expect(setup().policy.prepareUpdate(principal, 'recRoute', { ...request, fields: { status: 'stocked' } })).rejects.toThrow();
    principal.effectiveAuthorization!.baseline.rules = [];
    await expect(setup().policy.prepareUpdate(principal, 'recRoute', request)).rejects.toThrow();
  });
});
