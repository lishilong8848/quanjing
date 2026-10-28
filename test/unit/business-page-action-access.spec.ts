import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { BusinessAction, BusinessModule, PersonalPermissionRule } from '../../shared/business-permissions';
import type { StocktakeLine, StocktakeSheet } from '../../shared/inventory-stocktake.interface';
import { canUsePageAction } from '../../client/src/pages/business-action-access';
import { canUseInventoryAction } from '../../client/src/pages/InventoryManagement/inventory-action-access';
import { canUseStocktakeAction, canUseStocktakeLines, canUndoStocktakeBatch } from '../../client/src/pages/InventoryManagement/stocktake-action-access';

function rule(module: BusinessModule, actions: BusinessAction[], patch: Partial<PersonalPermissionRule> = {}): PersonalPermissionRule {
  return { id: `${module}-${actions.join('-')}`, module, actions, effect: 'allow', buildings: null, specialties: null, ...patch };
}
function profile(rules: PersonalPermissionRule[], overrides: PersonalPermissionRule[] = []): AccessPrincipal {
  return { role: 'guest', purchaseBuilding: null, effectiveAuthorization: { mode: 'independent', baseline: { nativeRole: null, pages: [], rules }, overrides: { rules: overrides, allowPages: [], denyPages: [] } } };
}

describe('business page action inputs', () => {
  it('preserves the existing legacy gate when no profile exists', () => {
    const old: AccessPrincipal = { role: 'editor', purchaseBuilding: null };
    expect(canUsePageAction(old, 'construction', 'create', false)).toBe(false);
    expect(canUsePageAction(old, 'construction', 'create', true)).toBe(true);
  });
  it('permits a guest-base create grant without implicitly permitting update, delete or export', () => {
    const user = profile([rule('construction', ['read', 'create'])]);
    expect(canUsePageAction(user, 'construction', 'create', false)).toBe(true);
    for (const action of ['update', 'delete', 'export'] as const) expect(canUsePageAction(user, 'construction', action, true)).toBe(false);
  });
  it('keeps training and certification permissions independent', () => {
    const user = profile([rule('training', ['read', 'refresh'])]);
    expect(canUsePageAction(user, 'training', 'refresh', false)).toBe(true);
    expect(canUsePageAction(user, 'certification', 'read', true)).toBe(false);
    expect(canUsePageAction(user, 'certification', 'notify', true)).toBe(false);
  });
  it('does not use an unrelated schedule action to permit leave, overtime or profile reads', () => {
    const user = profile([rule('schedule_assignments', ['read', 'update'])]);
    for (const module of ['leave_requests', 'overtime_requests'] as const) expect(canUsePageAction(user, module, 'create', true)).toBe(false);
    expect(canUsePageAction(user, 'personnel_profile', 'read', true)).toBe(false);
    expect(canUsePageAction(user, 'organization_profile', 'read', true)).toBe(false);
  });
  it('honors a personal deny above a native editor baseline', () => {
    const user = profile([], [rule('construction', ['update'], { effect: 'deny' })]);
    user.effectiveAuthorization!.baseline.nativeRole = 'editor';
    expect(canUsePageAction(user, 'construction', 'update', true)).toBe(false);
  });
});

describe('inventory and stocktake record actions', () => {
  const scoped = (module: 'inventory' | 'stocktake', actions: BusinessAction[]) => rule(module, actions, { buildings: ['A楼'], specialties: ['电气'] });
  const aElectrical = { building: 'A楼', specialty: '电气' };
  it('does not turn inventory create into stocktake access', () => {
    const user = profile([scoped('inventory', ['read', 'create'])]);
    expect(canUseInventoryAction(user, 'create', aElectrical)).toBe(true);
    expect(canUseStocktakeAction(user, 'read')).toBe(false);
  });
  it('separates confirmation from create, update and delete', () => {
    const user = profile([scoped('inventory', ['read', 'confirm'])]);
    expect(canUseInventoryAction(user, 'confirm', aElectrical)).toBe(true);
    for (const action of ['create', 'update', 'delete'] as const) expect(canUseInventoryAction(user, action, aElectrical)).toBe(false);
  });
  it('rejects a different building, specialty, or unavailable specialty', () => {
    const user = profile([scoped('inventory', ['confirm'])]);
    expect(canUseInventoryAction(user, 'confirm', { ...aElectrical, building: 'B楼' })).toBe(false);
    expect(canUseInventoryAction(user, 'confirm', { ...aElectrical, specialty: '暖通' })).toBe(false);
    expect(canUseInventoryAction(user, 'confirm', { building: 'A楼' })).toBe(false);
  });
  it('checks all rows in a stocktake batch and does not treat an empty batch as permission', () => {
    const user = profile([scoped('stocktake', ['confirm'])]);
    const row = (building: string) => ({ inventory: { building, specialty: '电气' } }) as unknown as StocktakeLine;
    expect(canUseStocktakeLines(user, 'confirm', [row('A楼')])).toBe(true);
    expect(canUseStocktakeLines(user, 'confirm', [row('A楼'), row('B楼')])).toBe(false);
    expect(canUseStocktakeLines(profile([]), 'confirm', [])).toBe(false);
  });
  it('keeps stocktake draft and final confirmation independent', () => {
    const user = profile([scoped('stocktake', ['update'])]);
    const row = { inventory: aElectrical } as unknown as StocktakeLine;
    expect(canUseStocktakeLines(user, 'update', [row])).toBe(true);
    expect(canUseStocktakeLines(user, 'confirm', [row])).toBe(false);
  });
  it('checks only the identified last batch when other visible rows have different delete scopes', () => {
    const user = profile([scoped('stocktake', ['delete'])]);
    const sheet = { latestBulk: { recordIds: ['a'], count: 1 }, lines: [{ inventory: { recordId: 'a', ...aElectrical } }, { inventory: { recordId: 'b', building: 'A楼', specialty: '暖通' } }] } as unknown as StocktakeSheet;
    expect(canUndoStocktakeBatch(user, sheet)).toBe(true);
    sheet.latestBulk!.recordIds = ['b'];
    expect(canUndoStocktakeBatch(user, sheet)).toBe(false);
  });
  it('fails closed for missing or inconsistent batch IDs', () => {
    const user = profile([scoped('stocktake', ['delete'])]);
    const sheet = { latestBulk: { recordIds: ['missing'], count: 1 }, lines: [] } as unknown as StocktakeSheet;
    expect(canUndoStocktakeBatch(user, sheet)).toBe(false);
    sheet.latestBulk!.recordIds = ['a', 'a'];
    expect(canUndoStocktakeBatch(user, sheet)).toBe(false);
  });
});
