import { type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import { businessRequestPermission } from '../../shared/business-request-permission';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { InventoryManagementController } from '../../server/modules/inventory-management/inventory-management.controller';
import { PurchaseInventoryController } from '../../server/modules/purchase-inventory/purchase-inventory.controller';
import { PurchaseApplicationService } from '../../server/modules/purchase-inventory/purchase-application.service';
import type { PurchaseApplicationApplicant } from '../../shared/purchase-application.interface';

const person = (building = 'H楼', id = 'self'): PurchaseApplicationApplicant => ({
  recordId: `rec_${id}`, openId: `ou_${id}`, name: '合成领用人',
  employeeNo: id, position: '运维', building, specialty: '暖通',
});
const independent = (actions: ('read' | 'create')[] = ['create']): AccessPrincipal => ({
  role: 'guest', purchaseBuilding: null,
  effectiveAuthorization: { mode: 'independent',
    baseline: { nativeRole: null, pages: [], rules: [{ id: 'inventory-h',
      module: 'inventory', effect: 'allow', actions, buildings: ['H楼'], specialties: ['电气'] }] },
    overrides: { rules: [], allowPages: [], denyPages: [] },
  },
});

describe('inventory applicant search through the real guard and HTTP controller', () => {
  let app: INestApplication, url: string, actor: AccessPrincipal | undefined;
  const readDirectory = jest.fn<Promise<PurchaseApplicationApplicant[]>, [boolean]>();
  const resolveSelf = jest.fn();
  const directory = Object.assign(Object.create(PurchaseApplicationService.prototype), {
    readActiveApplicants: readDirectory,
    resolveCurrentApplicant: resolveSelf,
  }) as PurchaseApplicationService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [InventoryManagementController, PurchaseInventoryController],
    }).useMocker(token => token === PurchaseApplicationService ? directory : {}).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalGuards(new UnifiedAccessGuard(new Reflector(), {
      cookieName: 'inventory_test_session', isAccessControlEnabled: () => true,
      renew: () => actor ? { principal: structuredClone(actor), principalFingerprint: 'synthetic' } : null,
    } as never));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => {
    actor = independent(); readDirectory.mockReset(); readDirectory.mockResolvedValue([person()]);
    resolveSelf.mockReset(); resolveSelf.mockResolvedValue(person());
  });
  async function get(path = '/api/inventory-management/applicant-search?query=合成') {
    const response = await fetch(`${url}${path}`, { headers: { cookie: 'inventory_test_session=synthetic' } });
    return { status: response.status, body: await response.json() };
  }

  it('reproduces the purchase mismatch but permits the same inventory applicant without procurement rights', async () => {
    expect((await get('/api/purchase-inventory/applicant-search?query=合成')).status).toBe(403);
    expect(readDirectory).not.toHaveBeenCalled();
    const result = await get();
    expect(result).toEqual({ status: 200, body: [person()] });
    expect(readDirectory).toHaveBeenCalledWith(false);
  });
  it('supports the native followed inventory role with buildings and no legacy purchaseBuilding', async () => {
    actor = { role: 'inventory_admin', purchaseBuilding: null, buildings: ['H楼'],
      effectiveAuthorization: { mode: 'follow', baseline: { nativeRole: 'inventory_admin', pages: ['/inventory-management'], rules: [] },
        overrides: { rules: [], allowPages: [], denyPages: [] } } };
    expect(await get()).toEqual({ status: 200, body: [person()] });
  });
  it.each(['inventory_admin', 'building_admin', 'purchase_admin', 'supply_chain_admin', 'editor', 'admin'] as const)('preserves %s applicant selection', async role => {
    actor = { role, purchaseBuilding: null, buildings: ['H楼'] };
    readDirectory.mockResolvedValue([person('A楼', 'a'), person('B楼', 'b'), person()]);
    const result = await get();
    expect(result.status).toBe(200);
    expect(result.body.map((item: PurchaseApplicationApplicant) => item.building).sort()).toEqual(['A楼', 'B楼', 'H楼']);
  });
  it('allows identities from another building and profession without granting procurement permissions', async () => {
    readDirectory.mockResolvedValue([person('A楼', 'a'), person()]);
    const result = await get();
    expect(result.status).toBe(200); expect(result.body).toHaveLength(2);
    expect(result.body).toContainEqual(person('A楼', 'a'));
    expect(readDirectory).toHaveBeenCalledTimes(1);
    expect((await get('/api/purchase-inventory/applicant-search')).status).toBe(403);
  });
  it('uses canonical identity only for default self without a building clamp or guessed name', async () => {
    actor = { ...independent(), accountId: 'feishu-synthetic', displayName: '合成本人' };
    expect(await get('/api/inventory-management/applicant-search?self=true&query=他人&building=B楼')).toEqual({ status: 200, body: [person()] });
    expect(resolveSelf).toHaveBeenCalledWith(expect.objectContaining(actor!), '');
    expect(readDirectory).not.toHaveBeenCalled();
  });
  it.each(['anonymous', 'read-only', 'purchase-only', 'denied'] as const)('rejects %s without reading the directory', async mode => {
    if (mode === 'anonymous') actor = undefined;
    if (mode === 'read-only') actor = independent(['read']);
    if (mode === 'purchase-only') actor!.effectiveAuthorization!.baseline.rules[0].module = 'purchase';
    if (mode === 'denied') actor!.effectiveAuthorization!.overrides.rules.push({ id: 'deny-h', module: 'inventory',
      effect: 'deny', actions: ['create'], buildings: ['H楼'], specialties: null });
    expect((await get()).status).toBe(403);
    expect(readDirectory).not.toHaveBeenCalled();
  });
  it('keeps procurement and inventory operations independently classified', () => {
    expect(businessRequestPermission('/api/inventory-management/applicant-search', 'GET')).toEqual({ module: 'inventory', action: 'create' });
    expect(businessRequestPermission('/api/purchase-inventory/applicant-search', 'GET')).toEqual({ module: 'purchase', action: 'read' });
    expect(businessRequestPermission('/api/inventory-management/outbounds', 'POST')).toEqual({ module: 'inventory', action: 'create' });
  });
  it('surfaces a source failure as failure and allows a later retry', async () => {
    readDirectory.mockRejectedValueOnce(new Error('synthetic directory failure'));
    expect((await get()).status).toBe(500);
    expect(await get()).toEqual({ status: 200, body: [person()] });
  });
});
