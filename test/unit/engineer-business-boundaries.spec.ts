import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import { businessAuthorizationSnapshot, businessPermissionScopeKey, type PersonalPermissionRule } from '../../shared/business-permissions';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { ProfessionalScoped } from '../../server/common/access/unified-access.decorators';
import { assertProfessionalBitableRecord, filterProfessionalRecords } from '../../server/common/access/professional-record-scope';
import { businessRequestPermission } from '../../server/common/access/business-request-permission';
import { resolvePurchaseWorkflowSession } from '../../server/modules/purchase-inventory/purchase-workflow-session';
import { resolveAllowedActions, buildOrderPatch } from '../../server/modules/purchase-inventory/purchase-workflow.rules';
import { ContractEditService } from '../../server/modules/contract-management/contract-edit.service';
import { canOrderPurchaseRecord, professionalPageCapabilities } from '../../client/src/access/access-policy';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryStocktakeStore } from '../../server/modules/inventory-management/inventory-stocktake.store';
import { InventoryStocktakeBulkService } from '../../server/modules/inventory-management/inventory-stocktake-bulk.service';

const extra: PersonalPermissionRule = { id: 'a-read', module: 'inventory', effect: 'allow', actions: ['read'], buildings: ['A楼'], specialties: ['电气'] };
const actor: AccessPrincipal = { role: 'professional_engineer', purchaseBuilding: 'B楼', buildings: ['B楼'], specialties: ['电气'], accountId: `feishu-${'a'.repeat(64)}`, authorizationVersion: 3, personalRules: [extra] };
const record = (building: string, specialty = '电气') => ({ record_id: `${building}-${specialty}`, fields: { 楼栋: building, 专业: specialty } });

describe('工程师实际业务边界', () => {
  it('只读返回默认和额外范围，额外范围不允许写入', () => {
    const reader = { ...actor, permissionContext: { module: 'inventory' as const, action: 'read' as const } };
    const writer = { ...actor, permissionContext: { module: 'inventory' as const, action: 'update' as const } };
    expect(filterProfessionalRecords(reader, [record('A楼'), record('B楼'), record('C楼'), record('B楼', '暖通')], item => item.fields.专业)).toHaveLength(2);
    expect(() => assertProfessionalBitableRecord(writer, record('A楼'))).toThrow(ForbiddenException);
    expect(() => assertProfessionalBitableRecord(writer, record('B楼'))).not.toThrow();
  });
  it('操作、导出和强制刷新按真实请求分别鉴权，未知模块不能放行', () => {
    class Probe { run() {} }
    ProfessionalScoped()(Probe.prototype, 'run', Object.getOwnPropertyDescriptor(Probe.prototype, 'run'));
    const deny: PersonalPermissionRule = { id: 'no-update', effect: 'deny', module: 'inventory', actions: ['update', 'delete', 'export', 'refresh'], buildings: null, specialties: null };
    const principal = { ...actor, personalRules: [extra, deny] };
    const guard = new UnifiedAccessGuard(new Reflector(), { cookieName: 'fixture', isAccessControlEnabled: () => true, renew: () => ({ principal, principalFingerprint: 'fixture' }) } as never);
    const allow = (path: string, method: string, query = {}) => guard.canActivate({ getClass: () => Probe, getHandler: () => Probe.prototype.run, switchToHttp: () => ({ getRequest: () => ({ method, originalUrl: path, url: path, query, headers: {}, protocol: 'http' }), getResponse: () => ({ cookie: jest.fn() }) }) } as never);
    expect(allow('/api/inventory-management/items', 'GET')).toBe(true);
    expect(allow('/api/inventory-management/items', 'PATCH')).toBe(false);
    expect(allow('/api/inventory-management/export', 'GET')).toBe(false);
    expect(allow('/api/inventory-management/items', 'GET', { force: 'true' })).toBe(false);
    expect(allow('/api/unmanaged', 'POST')).toBe(false);
    expect(allow('/api/access/configuration/accounts', 'POST')).toBe(false);
    expect(businessRequestPermission('/api/purchase-inventory/workflows/r/order', 'POST')).toEqual({ module: 'purchase', action: 'order' });
  });
  it('合同使用真实楼栋设备字段，未知或跨楼不能读取', () => {
    const principal = { ...actor, permissionContext: { module: 'contracts' as const, action: 'read' as const } };
    expect(() => assertProfessionalBitableRecord(principal, { record_id: 'r', fields: { 专业类别: '电气', 对应楼栋设备: 'B楼低压配电设备' } })).not.toThrow();
    for (const building of ['', 'A楼设备', 'B楼、F楼设备']) expect(() => assertProfessionalBitableRecord(principal, { record_id: 'r', fields: { 专业类别: '电气', 对应楼栋设备: building } })).toThrow();
  });
  it('合同修改前后都要在范围内，修改归属不能越权', async () => {
    const service = Object.create(ContractEditService.prototype);
    service.gateway = { getRecord: jest.fn().mockResolvedValue(record('B楼')) };
    await service.authorize('recContract', { ...actor, permissionContext: { module: 'contracts', action: 'update' } });
    service.gateway.getRecord.mockResolvedValue(record('A楼'));
    await expect(service.authorize('recContract', { ...actor, permissionContext: { module: 'contracts', action: 'update' } })).rejects.toThrow();
  });
  it('采购会话保留工程师范围，工作流和界面均尊重单独禁用下单', async () => {
    const principal: AccessPrincipal = { ...actor, permissionContext: { module: 'purchase', action: 'order' }, personalRules: [{ id: 'order-deny', effect: 'deny', module: 'purchase', actions: ['order'], buildings: ['B楼'], specialties: ['电气'] }] };
    const session = await resolvePurchaseWorkflowSession({ principal, professionalOpenId: 'ou_fixture', getTenantAccessToken: async () => 'synthetic' });
    expect(session.accessRole).toBe('professional_engineer');
    expect(session.permissionPrincipal).toEqual(businessAuthorizationSnapshot(principal));
    const purchase = { building: 'B楼', specialty: '电气', status: '审批通过（待下单）', purchaseMethod: '综合采购' };
    const user = { openId: 'ou_fixture', name: '', positions: [], buildings: ['B楼'], accessRole: session.accessRole, permissionPrincipal: session.permissionPrincipal };
    expect(resolveAllowedActions(purchase as never, user)).not.toContain('order');
    expect(() => buildOrderPatch(purchase as never, user, {} as never)).toThrow('个人授权');
    expect(canOrderPurchaseRecord(principal, { stage: 'executing', executionRecordId: 'r', purchaseCompleted: false, building: 'B楼', specialty: '电气' } as never)).toBe(false);
  });
  it('任务范围键绑定规则、楼栋和版本，不受读写请求上下文差异影响', () => {
    const snapshot = businessAuthorizationSnapshot({ ...actor, permissionContext: { module: 'inventory', action: 'create' } });
    expect(businessPermissionScopeKey(snapshot)).toBe(businessPermissionScopeKey({ ...actor, permissionContext: { module: 'inventory', action: 'read' } }));
    expect(businessPermissionScopeKey(snapshot)).not.toBe(businessPermissionScopeKey({ ...actor, authorizationVersion: 4 }));
    expect(businessPermissionScopeKey(snapshot)).not.toBe(businessPermissionScopeKey({ ...actor, personalRules: [] }));
    expect(professionalPageCapabilities('/inventory-management', { ...actor, personalRules: [{ id: 'read-only', effect: 'deny', module: 'inventory', actions: ['create', 'update', 'confirm', 'delete', 'refresh'], buildings: null, specialties: null }] })).toMatchObject({ canEdit: false, canDelete: false, canForceRefresh: false });
  });
  it('真实批量台账重载后保留个人规则，并拒绝不同授权版本读取旧任务', () => {
    const root = mkdtempSync(join(tmpdir(), 'nt-engineer-bulk-'));
    try {
      const path = join(root, 'ledger.json');
      const sheets = { get: jest.fn(), reviewFingerprint: () => 'a'.repeat(64), assertReviewRequest: jest.fn() };
      const service = new InventoryStocktakeBulkService(new InventoryStocktakeStore(path), sheets as never);
      const request = { clientMutationId: 'engineer-bulk-fixture', month: '2026-10', building: 'B楼', scope: 'review', expectedVersion: 1, confirmer: null, lines: [{ recordId: 'inventoryFixture', expectedVersion: 1, actualQuantity: 2, confirmer: null, note: '' }] };
      service.request(request as never, actor, 'fixture');
      const reloaded = new InventoryStocktakeStore(path);
      expect(reloaded.read().bulkJobs![0].principal).toEqual(businessAuthorizationSnapshot(actor));
      const resumed = new InventoryStocktakeBulkService(reloaded, sheets as never);
      expect(resumed.status('2026-10', 'B楼', request.clientMutationId, actor).status).toBe('queued');
      expect(() => resumed.status('2026-10', 'B楼', request.clientMutationId, { ...actor, authorizationVersion: 4 })).toThrow();
      expect(() => resumed.status('2026-10', 'B楼', request.clientMutationId, { ...actor, personalRules: [] })).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
