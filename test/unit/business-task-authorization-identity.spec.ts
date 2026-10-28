import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import { businessAuthorizationIdentityKey, businessAuthorizationSnapshot, businessPermissionScopeKey, canPerformBusinessAction, type BusinessAction, type BusinessModule } from '../../shared/business-permissions';
import { InventoryInboundTaskService } from '../../server/modules/inventory-management/inventory-inbound-task.service';
import { InventoryStocktakeBulkService } from '../../server/modules/inventory-management/inventory-stocktake-bulk.service';
import { InventoryStocktakeService } from '../../server/modules/inventory-management/inventory-stocktake.service';
import { RiskInspectionService } from '../../server/modules/risk-inspection/risk-inspection.service';
import { resolvePurchaseWorkflowReadSession } from '../../server/modules/purchase-inventory/purchase-workflow-session';
import * as externalConfiguration from '../../server/common/config/external-services.config';

function actor(module: BusinessModule, action: BusinessAction): AccessPrincipal {
  return {
    role: 'guest', purchaseBuilding: null, accountId: 'synthetic-task-owner', authorizationVersion: 7,
    permissionContext: { module, action }, permissionRequirements: [{ module, action }],
    effectiveAuthorization: { mode: 'independent', baseline: { nativeRole: null, pages: [], rules: [
      { id: 'synthetic-grant', module, actions: [action], effect: 'allow', buildings: ['A楼'], specialties: ['电气'] },
    ] }, overrides: { rules: [], allowPages: [], denyPages: [] } },
  };
}
function observing(principal: AccessPrincipal): AccessPrincipal {
  return { ...businessAuthorizationSnapshot(principal), permissionContext: { module: principal.permissionContext!.module, action: 'read' },
    permissionRequirements: [{ module: principal.permissionContext!.module, action: 'read' }] };
}
function changedPolicy(principal: AccessPrincipal): AccessPrincipal {
  const result = businessAuthorizationSnapshot(principal);
  result.effectiveAuthorization!.overrides.rules = [{ ...result.effectiveAuthorization!.baseline.rules[0], id: 'synthetic-revoke', effect: 'deny' }];
  return result;
}

describe('accepted business task ownership is separate from endpoint action context', () => {
  it('uses one identity across write/read endpoints while retaining distinct action cache keys and their existing layout', () => {
    const accepted = actor('inventory', 'create'), status = observing(accepted);
    expect(businessAuthorizationIdentityKey(status)).toBe(businessAuthorizationIdentityKey(accepted));
    expect(businessPermissionScopeKey(status)).not.toBe(businessPermissionScopeKey(accepted));
    expect(businessPermissionScopeKey(accepted)).toBe(JSON.stringify([
      accepted.accountId, accepted.authorizationVersion, accepted.role, accepted.purchaseBuilding,
      accepted.buildings, accepted.specialties, accepted.personalRules, accepted.effectiveAuthorization,
      accepted.permissionContext, accepted.permissionRequirements,
    ]));
    expect(canPerformBusinessAction(status, { module: 'inventory', action: 'read', building: 'A楼', specialty: '电气' })).toBe(false);
  });
  it('does not collapse different accounts, authorization versions, scope, rules or layered policies', () => {
    const original = actor('inventory', 'create');
    const variants: AccessPrincipal[] = [
      { ...original, accountId: 'another-owner' }, { ...original, authorizationVersion: 8 },
      { ...original, buildings: ['B楼'] }, { ...original, specialties: ['暖通'] },
      { ...original, personalRules: [{ id: 'legacy-deny', module: 'inventory', actions: ['create'], effect: 'deny', buildings: null, specialties: null }] },
      changedPolicy(original),
    ];
    for (const value of variants) expect(businessAuthorizationIdentityKey(value)).not.toBe(businessAuthorizationIdentityKey(original));
  });
  it('retains managed account/version/profile in native purchase read sessions as well as scoped sessions', async () => {
    const principal: AccessPrincipal = { role: 'editor', purchaseBuilding: null, accountId: 'local-editor-all', authorizationVersion: 3,
      permissionContext: { module: 'purchase', action: 'read' },
      effectiveAuthorization: { mode: 'independent', baseline: { nativeRole: 'editor', pages: ['/purchase-inventory-management'], rules: [] }, overrides: { rules: [], allowPages: [], denyPages: [] } } };
    const readEnv = jest.spyOn(externalConfiguration, 'readEnv').mockReturnValue('ou_synthetic_operator');
    try {
      const session = await resolvePurchaseWorkflowReadSession({ principal, getTenantAccessToken: async () => 'synthetic-token' });
      expect(session.permissionPrincipal).toEqual(businessAuthorizationSnapshot(principal));
      const other = await resolvePurchaseWorkflowReadSession({ principal: { ...principal, accountId: 'another-managed-editor', authorizationVersion: 4 }, getTenantAccessToken: async () => 'synthetic-token' });
      expect(businessPermissionScopeKey(session.permissionPrincipal!)).not.toBe(businessPermissionScopeKey(other.permissionPrincipal!));
    } finally {
      readEnv.mockRestore();
    }
  });
  it.each(['manual', 'purchase'] as const)('lets a %s inbound owner without list-read query its accepted task', async kind => {
    const principal = actor('inventory', kind === 'manual' ? 'create' : 'confirm');
    const entry = { kind, principal, request: { type: 'inbound', mode: 'existing', building: 'A楼', catalogRecordId: 'recSynthetic' },
      task: { id: 'inbound-synthetic-task', kind, status: 'running', message: '合成处理中' } };
    const service = new InventoryInboundTaskService({ findInboundByTaskId: jest.fn().mockResolvedValue(entry) } as never,
      {} as never, {} as never, {} as never, {} as never);
    await expect(service.getTaskStatus(entry.task.id, observing(principal))).resolves.toMatchObject({ success: true, task: { status: 'running' } });
  });
  it('rejects a different or revoked inbound owner before any pending task is scheduled', async () => {
    const principal = actor('inventory', 'create');
    const entry = { kind: 'manual', principal, request: { building: 'A楼' }, task: { id: 'inbound-synthetic-task', status: 'pending' } };
    const service = new InventoryInboundTaskService({ findInboundByTaskId: jest.fn().mockResolvedValue(entry) } as never,
      {} as never, {} as never, {} as never, {} as never);
    const schedule = jest.spyOn(service as never as { scheduleTask(id: string): void }, 'scheduleTask').mockImplementation(() => {});
    for (const current of [ { ...observing(principal), accountId: 'other-owner' }, { ...observing(principal), authorizationVersion: 8 }, changedPolicy(observing(principal)),
      { role: 'inventory_admin', purchaseBuilding: 'A楼', accountId: principal.accountId, authorizationVersion: 8 } as AccessPrincipal ]) {
      await expect(service.getTaskStatus(entry.task.id, current)).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(schedule).not.toHaveBeenCalled();
  });
  it('uses the original confirm scope for a confirm-only bulk owner and rejects different/revoked ownership', () => {
    const principal = actor('stocktake', 'confirm');
    const job = { id: 'synthetic-bulk-job', month: '2026-10', building: 'A楼', status: 'success', principal, request: null, count: 1 };
    const state = { bulkJobs: [job], sheets: [{ month: job.month, building: job.building, status: 'open', version: 1, lines: [], review: { status: 'open', version: 1, lines: [] } }] };
    const store = { read: jest.fn(() => state) };
    const sheets = new InventoryStocktakeService(store as never, {} as never, {} as never);
    const get = jest.spyOn(sheets, 'get');
    const service = new InventoryStocktakeBulkService(store as never, sheets);
    expect(() => sheets.get(job.month, 'A楼', observing(principal), 'review')).toThrow(ForbiddenException);
    get.mockClear();
    expect(service.status(job.month, 'A楼', job.id, observing(principal))).toMatchObject({ id: job.id, status: 'success' });
    expect(get.mock.calls[0][2].permissionContext).toEqual({ module: 'stocktake', action: 'confirm' });
    for (const current of [{ ...observing(principal), accountId: 'other-owner' }, { ...observing(principal), authorizationVersion: 8 }, changedPolicy(observing(principal))]) {
      get.mockClear();
      expect(() => service.status(job.month, 'A楼', job.id, current)).toThrow(NotFoundException);
      expect(get).not.toHaveBeenCalled();
    }
  });
  it('does not permit an accepted bulk status request to substitute another building', () => {
    const principal = actor('stocktake', 'confirm');
    const service = new InventoryStocktakeBulkService({ read: () => ({ bulkJobs: [{ id: 'synthetic-bulk-job', month: '2026-10', building: 'A楼', principal }] }) } as never,
      {} as never);
    expect(() => service.status('2026-10', 'B楼', 'synthetic-bulk-job', observing(principal))).toThrow(NotFoundException);
  });
  it('lets an update-only quality owner observe its own task but not another owner or an old policy version', () => {
    const principal = actor('quality', 'update');
    const task = { id: 'synthetic-quality-task', recordId: 'recSynthetic', clientMutationId: 'synthetic-mutation', supplemental: '合成跟进', principal, status: 'success', message: '已同步' };
    const service = new RiskInspectionService({} as never, { get: jest.fn(() => task) } as never);
    expect(service.getAliMonthlyQualitySupplementalTask(task.id, observing(principal))).toMatchObject({ taskId: task.id, syncStatus: 'success' });
    for (const current of [{ ...observing(principal), accountId: 'other-owner' }, { ...observing(principal), authorizationVersion: 8 }, changedPolicy(observing(principal))]) {
      expect(() => service.getAliMonthlyQualitySupplementalTask(task.id, current)).toThrow(NotFoundException);
    }
  });
});
