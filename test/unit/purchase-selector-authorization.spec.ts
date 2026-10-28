import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { BusinessAction, PersonalPermissionRule } from '../../shared/business-permissions';
import { PurchaseAccessPolicyService } from '../../server/modules/purchase-inventory/purchase-access-policy.service';
import { PurchaseInventoryController } from '../../server/modules/purchase-inventory/purchase-inventory.controller';

function profile(actions: BusinessAction[], action: BusinessAction = 'read'): AccessPrincipal {
  const rule: PersonalPermissionRule = { id: 'synthetic-B-electric', module: 'purchase', effect: 'allow', actions, buildings: ['B楼'], specialties: ['电气'] };
  return { role: 'purchase_applicant', purchaseBuilding: 'A楼', permissionContext: { module: 'purchase', action }, effectiveAuthorization: {
    mode: 'independent', baseline: { nativeRole: null, pages: ['/purchase-inventory-management'], rules: [rule] },
    overrides: { rules: [], allowPages: [], denyPages: [] },
  } };
}
function fixture() {
  const records = [
    { recordId: 'recBE', building: 'B楼', specialty: '电气', name: '合成B电气' },
    { recordId: 'recBW', building: 'B楼', specialty: '暖通', name: '合成B暖通' },
    { recordId: 'recCE', building: 'C楼', specialty: '电气', name: '合成C电气' },
    { recordId: 'recAE', building: 'A楼', specialty: '电气', name: '合成A电气' },
  ];
  const application = {
    getOptions: jest.fn(() => ({ buildings: ['A楼', 'B楼', 'C楼'], specialties: ['电气', '暖通'], purchaseMethods: ['综合采购'], primaryCategories: ['公共分类'] })),
    searchCatalog: jest.fn(async () => records), searchApplicants: jest.fn(async () => records),
    resolveCurrentApplicant: jest.fn(async () => ({ ...records[0], openId: 'ou_self' })),
    findAcceptedApplication: jest.fn(() => null), acceptApplications: jest.fn(() => ({ pending: true })),
  };
  const policy = new PurchaseAccessPolicyService({} as never);
  const controller = new PurchaseInventoryController({} as never, policy, {} as never, {} as never, {} as never, application as never, {} as never, {} as never, {} as never, {} as never);
  const req = (principal: AccessPrincipal) => ({ accessPrincipal: principal, accessPrincipalFingerprint: 'A'.repeat(43) }) as never;
  return { application, policy, controller, req };
}

describe('purchase selectors use effective authorization without granting record access', () => {
  it('keeps selector action create/export and does not inherit the old A-building role', () => {
    const { policy } = fixture();
    for (const action of ['create', 'export'] as const) {
      const principal = profile([action], action);
      expect(policy.assertRequestedBuilding(principal, 'B楼')).toBe('B楼');
      expect(() => policy.assertRequestedBuilding(principal, 'A楼')).toThrow();
      expect(() => policy.assertRequestedBuilding(principal, 'B楼', { module: 'purchase', action: 'read' })).toThrow();
    }
  });
  it('returns only creatable building/specialty options while static common enums stay unchanged', () => {
    const { controller, req } = fixture();
    const options = controller.getApplicationOptions(req(profile(['create'])));
    expect(options.buildings).toEqual(['B楼']); expect(options.specialties).toEqual(['电气']);
    expect(options.primaryCategories).toEqual(['公共分类']);
    expect(controller.getApplicationOptions(req(profile(['read']))).buildings).toEqual([]);
  });
  it('catalog and applicant records are filtered by their actual specialty as well as building', async () => {
    const { controller, req, application } = fixture();
    const request = req(profile(['read']));
    expect((await controller.searchCatalog(request, 'B楼')).map(item => item.recordId)).toEqual(['recBE']);
    expect((await controller.searchApplicants(request, 'B楼')).map(item => item.recordId)).toEqual(['recBE']);
    expect(application.searchCatalog).toHaveBeenCalledWith(expect.objectContaining({ building: 'B楼' }), false);
    await expect(controller.searchCatalog(request, 'C楼')).rejects.toThrow();
  });
  it('does not downgrade an export-context catalog lookup to read', async () => {
    const { controller, req } = fixture();
    expect((await controller.searchCatalog(req(profile(['export'], 'export')), 'B楼')).map(item => item.recordId)).toEqual(['recBE']);
    await expect(controller.searchCatalog(req(profile(['read'], 'export')), 'B楼')).rejects.toThrow();
  });
  it('checks actual create specialty before acceptance and retains requester binding', async () => {
    const { controller, req, application } = fixture();
    const principal = profile(['create']);
    const submit = (specialty: string, who = principal) => controller.submitApplications(req(who), JSON.stringify({ shared: { building: 'B楼', specialty }, items: [] }), [], 'purchase-scope-synthetic-001', 'a'.repeat(64));
    await expect(submit('暖通')).rejects.toThrow();
    expect(application.acceptApplications).not.toHaveBeenCalled();
    await expect(submit('电气')).resolves.toEqual({ pending: true });
    application.acceptApplications.mockClear();
    await expect(submit('电气', { ...principal, accountId: 'feishu-synthetic', displayName: '当前本人' })).rejects.toThrow();
    expect(application.acceptApplications).not.toHaveBeenCalled();
  });
  it('an override deny removes the last usable specialty; empty independent policy grants nothing', () => {
    const { policy } = fixture();
    const principal = profile(['read']);
    principal.effectiveAuthorization!.overrides.rules = [{ id: 'synthetic-deny', module: 'purchase', effect: 'deny', actions: ['read'], buildings: ['B楼'], specialties: ['电气'] }];
    expect(() => policy.assertRequestedBuilding(principal, 'B楼')).toThrow();
    principal.effectiveAuthorization!.baseline.rules = [];
    principal.effectiveAuthorization!.overrides.rules = [];
    expect(() => policy.assertRequestedBuilding(principal, 'A楼')).toThrow();
  });
});
