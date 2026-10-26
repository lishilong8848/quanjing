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
  it('在线审批绑定实际第二楼栋；未授权记录在进入审批服务前拒绝', async () => {
    const approve = jest.fn().mockResolvedValue({ success: true });
    const execution = jest.fn().mockResolvedValue({ building: 'B楼' });
    const controller = { workflowGateway: { getExecutionRecordAsApp: execution }, onlineApprovalService: { acceptDecision: approve } };
    const request = { accessPrincipal: scoped() };
    await PurchaseInventoryController.prototype.approveRecord.call(controller as never, request as never, 'record-B', { decision: 'approved' } as never);
    expect(approve).toHaveBeenCalledWith('record-B', { decision: 'approved' }, 'B楼');
    approve.mockClear(); execution.mockResolvedValue({ building: 'C楼' });
    await expect(PurchaseInventoryController.prototype.approveRecord.call(controller as never, request as never, 'record-C', { decision: 'approved' } as never)).rejects.toThrow();
    expect(approve).not.toHaveBeenCalled();
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
    const result = (service as any).scope({ assets, dashboard: { snapshotId: 'test' } }, scoped());
    expect(result.assets.map((asset: any) => asset.building)).toEqual(['A楼', 'B楼']);
    expect(result.dashboard.snapshotId).toContain('A楼,B楼');
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
