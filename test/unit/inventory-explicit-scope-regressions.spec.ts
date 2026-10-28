import { ForbiddenException } from '@nestjs/common';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { BusinessAction, BusinessModule } from '../../shared/business-permissions';
import type { InventoryMovementCreateRequest, InventoryOutboundMovementCreateRequest, InventorySourceKey } from '../../shared/inventory-management.interface';
import { buildInventoryManagementSnapshot, queryInventoryItems, queryInventoryMovements } from '../../server/modules/inventory-management/inventory-management.mapper';
import { assertInventoryMovementScope, scopeInventoryDashboard, scopeInventoryItemsQuery, scopeInventoryMovementsQuery, scopeStorageLocationQuery } from '../../server/modules/inventory-management/inventory-access-policy';
import { InventoryMovementCommandService } from '../../server/modules/inventory-management/inventory-movement-command.service';
import { InventoryOutboundWorkflowService } from '../../server/modules/inventory-management/inventory-outbound-workflow.service';

function principal(action: BusinessAction = 'read', module: BusinessModule = 'inventory'): AccessPrincipal {
  return { role: 'inventory_admin', purchaseBuilding: 'A楼', accountId: 'synthetic-inventory-account', authorizationVersion: 1,
    permissionContext: { module: 'inventory', action }, permissionRequirements: [{ module: 'inventory', action }],
    effectiveAuthorization: { mode: 'independent', baseline: { nativeRole: 'inventory_admin', pages: ['/inventory-management'], rules: [] },
      overrides: { rules: [{ id: 'grant-b-electrical', module, actions: [action], effect: 'allow', buildings: ['B楼'], specialties: ['电气'] }], allowPages: [], denyPages: [] } } };
}
const raw = (id: string, fields: Record<string, unknown>) => ({ record_id: id, fields });
const catalog = (building = 'B楼', specialty = '电气') => raw('recCatalog', { 物品类别号: 'SYNTHETIC', 楼栋: building, 专业: specialty, 名称: '合成物品', 计数单位: '个' });
function snapshot(actor: AccessPrincipal) {
  const rows = [ ['a', 'A楼', '电气'], ['b', 'B楼', '电气'], ['heat', 'B楼', '暖通'], ['unknown', 'B楼', ''], ['c', 'C楼', '电气'] ];
  const sourceKeys: InventorySourceKey[] = ['inventory', 'inbound', 'outbound', 'borrow', 'catalog', 'prices', 'stocktake', 'managers'];
  return buildInventoryManagementSnapshot({ principal: actor, generatedAt: '2026-10-27T00:00:00Z', sourceUrl: '',
    inventory: rows.map(([id, building]) => raw(`inventory-${id}`, { 物品类别号: id, 楼栋: building, 剩余库存: 2, 最小库存量: 3, ...(id === 'b' ? { 专业: '暖通' } : {}) })),
    catalog: rows.map(([id, building, specialty]) => raw(`catalog-${id}`, { 物品类别号: id, 楼栋: building, 专业: specialty, 名称: `合成-${id}` })),
    inbound: rows.map(([id, building]) => raw(`inbound-${id}`, { 物品类别号: id, 楼栋: building, 入库数量: 1, 入库日期: '2026-10-26T00:00:00Z' })),
    outbound: [], borrow: [], prices: [], stocktakeSummaries: [], managers: [],
    sectionStatus: Object.fromEntries(sourceKeys.map(key => [key, { configured: true, count: rows.length }])) as never,
  });
}

describe('inventory mapping and query policy do not reapply a raw-role building clamp', () => {
  it('maps authoritative catalog specialty before filtering, and keeps the explicit B-building grant in dashboard and paged reads', () => {
    const actor = principal(), result = snapshot(actor);
    expect(result.items.map(item => [item.recordId, item.specialty])).toEqual([['inventory-a', '电气'], ['inventory-b', '电气']]);
    expect(result.dashboard.buildings.map(item => item.building)).toEqual(['A楼', 'B楼']);
    expect(result.dashboard.summary.inventoryLines).toBe(2);
    expect(scopeInventoryDashboard(actor, result.dashboard)).toBe(result.dashboard);
    const items = queryInventoryItems(result.items, scopeInventoryItemsQuery(actor, { building: 'B楼' }));
    expect(items.items.map(item => item.recordId)).toEqual(['inventory-b']);
    const movements = queryInventoryMovements(result.movements, scopeInventoryMovementsQuery(actor, { type: 'inbound', building: 'B楼' }));
    expect(movements.items.map(item => item.recordId)).toEqual(['inbound-b']);
    expect(movements.items[0].specialty).toBe('电气');
  });
  it('does not borrow another module grant, and preserves the old role-only query behavior', () => {
    const actor = principal('read', 'purchase');
    expect(snapshot(actor).items.map(item => item.recordId)).toEqual(['inventory-a']);
    expect(scopeInventoryItemsQuery(actor, { building: 'B楼' }).building).toBe('A楼');
    const legacy: AccessPrincipal = { role: 'inventory_admin', purchaseBuilding: 'A楼' };
    expect(snapshot(legacy).items.map(item => item.recordId)).toEqual(['inventory-a']);
    expect(scopeInventoryMovementsQuery(legacy, { type: 'inbound', building: 'B楼' }).building).toBe('A楼');
    expect(() => assertInventoryMovementScope(legacy, { type: 'outbound', building: 'B楼' } as InventoryMovementCreateRequest)).toThrow(ForbiddenException);
  });
  it('keeps individual denial and every fixed request requirement above an explicit extra-building allowance', () => {
    const denied = principal();
    denied.effectiveAuthorization!.overrides.rules.push({ ...denied.effectiveAuthorization!.overrides.rules[0], id: 'deny-b', effect: 'deny' });
    expect(snapshot(denied).items.map(item => item.recordId)).toEqual(['inventory-a']);
    const force = principal();
    force.permissionRequirements = [{ module: 'inventory', action: 'read' }, { module: 'inventory', action: 'refresh' }];
    expect(snapshot(force).items.map(item => item.recordId)).toEqual(['inventory-a']);
  });
  it('retains an independent handover source grant outside the original native-role building', () => {
    const actor = principal(); actor.effectiveAuthorization!.overrides.rules = [];
    actor.effectiveAuthorization!.baseline.grantSnapshots = [{ baseline: { nativeRole: null, pages: [], rules: [{ id: 'transferred-b', module: 'inventory', actions: ['read'], effect: 'allow', buildings: ['B楼'], specialties: ['电气'] }] }, overrides: { rules: [], allowPages: [], denyPages: [] }, scope: { building: null } }];
    expect(snapshot(actor).items.map(item => item.recordId)).toEqual(['inventory-a', 'inventory-b']);
  });
  it('validates storage-location queries by actual permitted building instead of rewriting B to A', () => {
    expect(scopeStorageLocationQuery(principal(), { building: 'B楼' }).building).toBe('B楼');
    expect(() => scopeStorageLocationQuery(principal(), { building: 'C楼' })).toThrow(ForbiddenException);
  });
});

describe('inventory writes retain record authority after removing the secondary legacy clamp', () => {
  it('allows an explicitly granted B operation while checking both ends of a transfer against the current catalog specialty', async () => {
    const actor = principal('create');
    const gateway = { getRecord: jest.fn(async () => catalog()), createRecord: jest.fn(), updateRecord: jest.fn() };
    const service = new InventoryMovementCommandService({} as never, gateway as never);
    Object.assign(service, { resolveSource: async () => ({ appToken: 'synthetic' }), resolveCoreTables: () => ({ catalogTableId: 'synthetic-catalog' }) });
    const request: InventoryMovementCreateRequest = { type: 'borrow', building: 'B楼', destinationBuilding: 'A楼', catalogRecordId: 'recCatalog', sku: 'SYNTHETIC', quantity: 1, occurredAt: '2026-10-27T00:00:00.000Z' };
    expect(assertInventoryMovementScope(actor, request)).toBe(request);
    await expect(service.assertProfessionalRequest(actor, request)).resolves.toBeUndefined();
    await expect(service.createMovement({ ...request, destinationBuilding: 'C楼' }, actor)).rejects.toBeInstanceOf(ForbiddenException);
    gateway.getRecord.mockResolvedValue(catalog('B楼', '暖通'));
    await expect(service.assertProfessionalRequest(actor, request)).rejects.toBeInstanceOf(ForbiddenException);
    expect(gateway.createRecord).not.toHaveBeenCalled(); expect(gateway.updateRecord).not.toHaveBeenCalled();
  });
  it('accepts B outbound only after real service catalog/request checks, and rejects wrong action or mismatched requested building before reservation', async () => {
    const actor = principal('create');
    const gateway = { getRecord: jest.fn(async () => catalog()), createRecord: jest.fn() };
    const ledger = { reserve: jest.fn(async (entry: Record<string, any>) => ({ created: false, entry: { ...entry, task: { ...entry.task, status: 'running' } } })) };
    const service = new InventoryOutboundWorkflowService({} as never, gateway as never, {} as never, {} as never, {} as never, undefined, ledger as never);
    Object.assign(service, { resolveConfig: async () => ({ appToken: 'synthetic', catalogTableId: 'synthetic-catalog' }) });
    const request: InventoryOutboundMovementCreateRequest = { type: 'outbound', clientMutationId: 'synthetic-outbound-1', building: 'B楼', catalogRecordId: 'recCatalog', sku: 'SYNTHETIC', quantity: 1, occurredAt: '2026-10-27T00:00:00.000Z', applicantOpenId: 'ou_synthetic_applicant', reason: '合成测试' };
    await expect(service.acceptPending(request, actor, 'synthetic-session-fingerprint')).resolves.toMatchObject({ accepted: true, status: 'running' });
    ledger.reserve.mockClear();
    await expect(service.acceptPending({ ...request, building: 'C楼' }, actor, 'synthetic-session-fingerprint')).rejects.toBeInstanceOf(ForbiddenException);
    const readOnlyExtra = principal('read'); readOnlyExtra.permissionContext = { module: 'inventory', action: 'create' }; readOnlyExtra.permissionRequirements = [{ module: 'inventory', action: 'create' }];
    await expect(service.acceptPending(request, readOnlyExtra, 'synthetic-session-fingerprint')).rejects.toBeInstanceOf(ForbiddenException);
    gateway.getRecord.mockResolvedValue(catalog('B楼', '暖通'));
    await expect(service.acceptPending(request, actor, 'synthetic-session-fingerprint')).rejects.toBeInstanceOf(ForbiddenException);
    expect(ledger.reserve).not.toHaveBeenCalled(); expect(gateway.createRecord).not.toHaveBeenCalled();
  });
});
