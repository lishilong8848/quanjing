import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { UnifiedAccessService, hashAccessPassword } from '../../server/common/access/unified-access.service';
import { APPROVED_FEISHU_APP_ID } from '../../server/common/access/feishu-access-approved-grants';
import { PurchaseAccessPolicyService } from '../../server/modules/purchase-inventory/purchase-access-policy.service';
import { assertInventoryMovementScope, scopeInventoryItemsQuery } from '../../server/modules/inventory-management/inventory-access-policy';
import { queryInventoryItems } from '../../server/modules/inventory-management/inventory-management.mapper';
import { canEditPurchaseRecord } from '../../client/src/access/access-policy';
import { accessBuildings, canAccessBuilding } from '../../shared/building-access';
import { stocktakeBuildings } from '../../server/modules/inventory-management/inventory-stocktake.rules';
import { scopeToolsSnapshot } from '../../server/modules/operations-tools/operations-tools.mapper';
import { EquipmentLedgerService } from '../../server/modules/equipment-lifecycle/equipment-ledger.service';
import { buildInventoryManagementSnapshot } from '../../server/modules/inventory-management/inventory-management.mapper';
import { scopeInventoryDashboard } from '../../server/modules/inventory-management/inventory-access-policy';
import { PurchaseInventoryController } from '../../server/modules/purchase-inventory/purchase-inventory.controller';
import { PurchaseOnlineApprovalService } from '../../server/modules/purchase-inventory/purchase-online-approval.service';
import { PurchaseWorkflowService } from '../../server/modules/purchase-inventory/purchase-workflow.service';
import type { AccessPrincipal } from '../../shared/access-control.interface';

const scoped = (role: AccessPrincipal['role'] = 'building_admin') => ({ role, purchaseBuilding: 'A楼', buildings: ['A楼', 'B楼'] }) as AccessPrincipal;

describe('多楼栋授权持久化与签名', () => {
  const saved = { ...process.env };
  let directory: string, configuration: AccessConfigurationService, access: UnifiedAccessService, actor: AccessPrincipal;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'multi-building-config-'));
    process.env.ACCESS_CONFIGURATION_FILE = join(directory, 'config.json');
    process.env.FEISHU_APP_ID = APPROVED_FEISHU_APP_ID;
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    process.env.LOCAL_ADMIN_PASSWORD_HASH = hashAccessPassword('synthetic-multi-admin');
    configuration = new AccessConfigurationService(); access = new UnifiedAccessService(configuration);
    actor = configuration.localTargets().find(value => value.principal.role === 'admin')!.principal;
  });
  afterEach(() => { process.env = { ...saved }; rmSync(directory, { recursive: true, force: true }); });
  const mutation = () => ({ clientMutationId: 'multi-building-test-mutation', expectedRevision: 0, kind: 'feishu' as const,
    name: '多楼栋测试', openId: 'ou_multi_scope_test', role: 'purchase_applicant' as const, building: 'A楼' as const, buildings: ['A楼', 'B楼'], enabled: true });
  it('保存、重启、签名读取和续期保留所有楼栋，收窄后撤销旧会话', async () => {
    await configuration.saveAccount(mutation() as never, actor);
    const principal = configuration.feishuPrincipal('ou_multi_scope_test', APPROVED_FEISHU_APP_ID)!;
    expect(principal).toMatchObject({ buildings: ['A楼', 'B楼'] });
    expect(new AccessConfigurationService().feishuPrincipal('ou_multi_scope_test', APPROVED_FEISHU_APP_ID)).toEqual(principal);
    const session = access.issueTrustedSession(principal);
    expect(access.readSession(session.token).principal).toEqual(principal);
    expect(access.renew(session.token)?.principal).toEqual(principal);
    await configuration.saveAccount({ ...mutation(), id: principal.accountId, expectedRevision: 1, clientMutationId: 'multi-building-test-narrow', buildings: ['A楼'] } as never, actor);
    expect(access.readSession(session.token).principal.role).toBe('guest');
  });
  it.each([[], ['A楼', 'A楼'], ['A楼', '不存在'], ['A楼', '110站'], ['B楼', 'A楼']].map(buildings => [buildings]))('拒绝空、重复、非法和首楼栋不一致的范围 %j', async buildings => {
    await expect(configuration.saveAccount({ ...mutation(), buildings } as never, actor)).rejects.toThrow();
    expect(configuration.snapshot().revision).toBe(0);
  });
  it('旧单楼栋配置和会话保持兼容', async () => {
    const { buildings: _unused, ...old } = mutation();
    await configuration.saveAccount(old, actor);
    const principal = configuration.feishuPrincipal(old.openId, APPROVED_FEISHU_APP_ID)!;
    expect(access.readSession(access.issueTrustedSession(principal).token).principal).toEqual(principal);
  });
  it('签名有效但篡改范围、角色或额外字段的令牌也拒绝', async () => {
    await configuration.saveAccount(mutation() as never, actor);
    const principal = configuration.feishuPrincipal('ou_multi_scope_test', APPROVED_FEISHU_APP_ID)!;
    const token = access.issueTrustedSession(principal).token;
    const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
    for (const change of [{ buildings: ['A楼', 'C楼'] }, { buildings: [] }, { buildings: ['B楼', 'A楼'] }, { role: 'admin' }, { unauthorized: true }]) {
      const encoded = Buffer.from(JSON.stringify({ ...payload, ...change })).toString('base64url');
      const signature = createHmac('sha256', Buffer.from(process.env.LOCAL_ACCESS_SESSION_SECRET!, 'base64')).update(encoded).digest('base64url');
      expect(access.readSession(`${encoded}.${signature}`).principal.role).toBe('guest');
    }
  });
  it.each(['inventory_admin', 'building_admin', 'purchase_applicant'] as const)('角色 %s 支持多楼栋，全基地角色不接受楼栋集合', async role => {
    await configuration.saveAccount({ ...mutation(), role, buildings: ['A楼', 'H楼'] } as never, actor);
    const principal = configuration.feishuPrincipal('ou_multi_scope_test', APPROVED_FEISHU_APP_ID)!;
    expect(access.readSession(access.issueTrustedSession(principal).token).principal).toMatchObject({ role, buildings: ['A楼', 'H楼'] });
    await expect(configuration.saveAccount({ ...mutation(), id: principal.accountId, clientMutationId: 'multi-building-no-global-scope', expectedRevision: 1,
      role: 'admin', building: null } as never, actor)).rejects.toThrow();
  });
});

describe('多楼栋真实业务边界', () => {
  it('采购第二楼栋允许，第三楼栋拒绝；前端权限与后端一致', () => {
    const policy = new PurchaseAccessPolicyService({} as never), principal = scoped();
    expect(policy.assertRequestedBuilding(principal, 'B楼')).toBe('B楼');
    expect(() => policy.assertRequestedBuilding(principal, 'C楼')).toThrow();
    expect(canEditPurchaseRecord(principal, { building: 'B楼' } as never)).toBe(true);
    expect(canEditPurchaseRecord(principal, { building: 'C楼' } as never)).toBe(false);
  });
  it('在线审批绑定真实身份、名单及第二楼栋；未授权记录零受理零写入', async () => {
    const actor = { ...scoped(), accountId: 'synthetic-multi-approver', authorizationVersion: 1 };
    let building = 'B楼', status = '未开始（待审批）';
    const record = (recordId: string) => ({ recordId, requestCode: 'SYNTHETIC', status, building, specialty: '电气', purchaseMethod: '综合采购', approvalCompleted: false, requesterOpenId: 'ou_requester', purchaserOpenId: 'ou_purchaser' });
    const gateway = { getTenantAccessTokenAsApp: jest.fn(async () => 'synthetic-token'), getExecutionRecord: jest.fn(async (id: string) => record(id)), getExecutionRecordAsApp: jest.fn(async (id: string) => record(id)),
      resolveUser: jest.fn(async () => ({ openId: 'ou_synthetic_multi', name: '合成审批人员', positions: [], buildings: ['B楼'] })),
      updateExecutionRecordAsApp: jest.fn(async (_id: string, fields: Record<string, unknown>) => { status = String(fields['采购流程']); }) };
    const configuration = { snapshot: () => ({ accounts: [{ id: actor.accountId, enabled: true, deleted: false, openId: 'ou_synthetic_multi' }] }),
      currentPrincipal: (id: string, version: number) => id === actor.accountId && version === actor.authorizationVersion ? structuredClone(actor) : undefined,
      currentDutyRoutePeople: () => [{ openId: 'ou_synthetic_multi', name: '合成审批人员' }] };
    const workflow = new PurchaseWorkflowService(gateway as never, {} as never, undefined, configuration as never);
    const online = new PurchaseOnlineApprovalService(gateway as never, workflow), approve = jest.spyOn(online, 'acceptDecision');
    const controller = Object.assign(Object.create(PurchaseInventoryController.prototype), { workflowGateway: gateway, configuration, onlineApprovalService: online });
    const request = { accessPrincipal: actor };
    jest.useFakeTimers();
    try {
      const accepted = await controller.approveRecord(request, 'recSecondB', { decision: 'approved' });
      expect(approve).toHaveBeenCalledWith('recSecondB', { decision: 'approved' }, 'B楼', expect.objectContaining({ scope: { building: 'B楼', specialty: '电气' }, actorOpenId: 'ou_synthetic_multi' }));
      await jest.runAllTimersAsync();
      expect(online.getAuthorizedDecisionTaskStatus(accepted.taskId, actor)).toMatchObject({ task: { status: 'completed' } });
      expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledTimes(1);
      approve.mockClear(); gateway.updateExecutionRecordAsApp.mockClear(); building = 'C楼'; status = '未开始（待审批）';
      await expect(controller.approveRecord(request, 'recDeniedC', { decision: 'approved' })).rejects.toThrow();
      expect(approve).not.toHaveBeenCalled(); expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
    } finally { jest.clearAllTimers(); jest.useRealTimers(); }
  });
  it('库房第二楼栋及授权内调拨允许，未授权来源或目的地拒绝', () => {
    const principal = scoped('inventory_admin');
    expect(assertInventoryMovementScope(principal, { building: 'B楼', destinationBuilding: 'A楼' } as never)).toBeTruthy();
    expect(() => assertInventoryMovementScope(principal, { building: 'B楼', destinationBuilding: 'C楼' } as never)).toThrow();
    expect(() => assertInventoryMovementScope(principal, { building: 'C楼' } as never)).toThrow();
  });
  it('列表默认取授权并集，分页前过滤；显式第二楼栋不被改回第一楼栋', () => {
    const principal = scoped('inventory_admin');
    const items = ['A楼', 'B楼', 'C楼'].map((building, i) => ({ building, recordId: String(i), sku: String(i), name: '测试', primaryCategory: building, quantity: 1 }));
    const query = scopeInventoryItemsQuery(principal, { building: 'all', page: 1, pageSize: 1 } as never);
    const result = queryInventoryItems(items as never, query);
    expect(result.total).toBe(2);
    expect(result.categories).toEqual(['A楼', 'B楼']);
    const second = scopeInventoryItemsQuery(principal, { building: 'B楼' } as never);
    expect(queryInventoryItems(items as never, second).items.map(item => item.building)).toEqual(['B楼']);
    expect(() => scopeInventoryItemsQuery(principal, { building: 'C楼' } as never)).toThrow();
  });
  it('非法集合不得退化成全基地；盘点包含所有授权楼栋', () => {
    expect(accessBuildings({ ...scoped(), buildings: [] })).toEqual([]);
    expect(canAccessBuilding({ ...scoped(), buildings: ['C楼'] }, 'C楼')).toBe(false);
    expect(stocktakeBuildings(scoped('inventory_admin'))).toEqual(['A楼', 'B楼']);
  });
  it('工具和跨楼栋关联按完整集合筛选', () => {
    const snapshot = { tools: ['A楼', 'B楼', 'C楼'].map((building, i) => ({ id: String(i), building })),
      flows: [{ id: 'allowed', toolIds: ['0', '1'] }, { id: 'denied', toolIds: ['1', '2'] }], sources: {} };
    const result = scopeToolsSnapshot(scoped(), snapshot as never);
    expect(result.tools.map(tool => tool.building)).toEqual(['A楼', 'B楼']);
    expect(result.flows.map(flow => flow.id)).toEqual(['allowed']);
  });
  it('设备汇总、分页源和缓存标识均绑定楼栋集合', () => {
    const service = new EquipmentLedgerService({} as never, {} as never);
    const assets = ['A楼', 'B楼', 'C楼'].map((building, i) => ({ id: String(i), building, quantity: 1 }));
    const actor = { ...scoped(), accountId: 'synthetic-equipment-reader', authorizationVersion: 1 };
    const source = { assets, dashboard: { snapshotId: 'test' } };
    const result = (service as any).scope(source, actor);
    expect(result.assets.map((asset: any) => asset.building)).toEqual(['A楼', 'B楼']);
    expect(result.dashboard.snapshotId).toMatch(/^test:[a-f0-9]{64}$/);
    expect((service as any).scope(source, { ...actor }).dashboard.snapshotId).toBe(result.dashboard.snapshotId);
    for (const other of [{ ...actor, buildings: ['A楼'] }, { ...actor, buildings: ['A楼', 'C楼'] }, { ...actor, authorizationVersion: 2 }, { ...actor, accountId: 'another-reader' }]) {
      expect((service as any).scope(source, other).dashboard.snapshotId).not.toBe(result.dashboard.snapshotId);
    }
    expect(result.dashboard.overview).toBeTruthy();
  });
  it('库存并集在原始数据层重算，跨楼同SKU只计一次', () => {
    const records = ['A楼', 'B楼', 'C楼'].map((building, i) => ({ record_id: String(i), fields: { 楼栋: building, 物品类别号: 'SAME', 名称: '测试物料', 剩余库存: 1 } }));
    const snapshot = buildInventoryManagementSnapshot({ principal: scoped('inventory_admin'), inventory: records,
      catalog: [], inbound: [], outbound: [], borrow: [], prices: [], stocktakeSummaries: [], managers: [], sectionStatus: {}, generatedAt: 'test', sourceUrl: 'test' } as never);
    expect(snapshot.items.map(item => item.building)).toEqual(['A楼', 'B楼']);
    expect(snapshot.dashboard.summary.inventoryLines).toBe(2);
    expect(snapshot.dashboard.summary.distinctSkus).toBe(1);
    expect(scopeInventoryDashboard(scoped('inventory_admin'), snapshot.dashboard).summary.distinctSkus).toBe(1);
  });
});
