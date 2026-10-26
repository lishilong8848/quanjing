import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HttpService } from '@nestjs/axios';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { UnifiedAccessService, hashAccessPassword } from '../../server/common/access/unified-access.service';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import { PurchaseWorkflowService } from '../../server/modules/purchase-inventory/purchase-workflow.service';
import { InventoryWarehouseRoleDirectory } from '../../server/modules/inventory-outbound-approval/inventory-warehouse-role-directory';
import type { CardRoleCode } from '../../shared/access-configuration.interface';

describe('managed card recipients and delivered authorization', () => {
  const saved = { ...process.env };
  let path: string, config: AccessConfigurationService, store: PurchaseWorkflowStore;
  beforeEach(() => {
    path = mkdtempSync(join(tmpdir(), 'vnet-card-configuration-'));
    process.env.ACCESS_CONFIGURATION_FILE = join(path, 'configuration.json');
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    process.env.LOCAL_ADMIN_PASSWORD_HASH = hashAccessPassword('card-synthetic-admin');
    process.env.FEISHU_APP_ID = 'cli_card_fixture';
    process.env.FEISHU_ACCESS_APPROVED_GRANTS_ENABLED = 'false';
    config = new AccessConfigurationService();
    store = new PurchaseWorkflowStore(join(path, 'ledger.json'));
  });
  afterEach(async () => { await store.onModuleDestroy(); process.env = { ...saved }; rmSync(path, { recursive: true, force: true }); });
  async function save(code: CardRoleCode, building: 'A楼' | null, ids: string[]) {
    const actor = new UnifiedAccessService(config).issueTrustedSession(config.localTargets().find(item => item.principal.role === 'admin')!.principal).principal;
    await config.saveCardRule({ clientMutationId: `card-${code}-mutation`, expectedRevision: config.snapshot().revision, code, building, members: ids.map(openId => ({ openId, name: `人员${openId.slice(-1)}` })) }, actor);
  }
  it('uses configured purchasing and warehouse people without an external read', async () => {
    await save('purchase_executor', null, ['ou_executor']);
    await save('building_executor', 'A楼', ['ou_supervisor']);
    await save('warehouse_responsible', 'A楼', ['ou_responsible']);
    await save('warehouse_notify', 'A楼', []);
    const http = new HttpService();
    const gateway = new PurchaseWorkflowGateway(http);
    expect(await gateway.resolvePurchaseAdminAsApp()).toMatchObject({ openId: 'ou_executor' });
    expect(await gateway.resolveBuildingSupervisorAsApp('A楼')).toMatchObject({ openId: 'ou_supervisor' });
    const directory = new InventoryWarehouseRoleDirectory(http, async () => { throw new Error('must not read source'); });
    expect(await directory.resolveApprovers('A楼')).toMatchObject([{ openId: 'ou_responsible' }]);
    expect(await directory.resolveNotificationRecipients('A楼')).toEqual([]);
  });
  it('keeps an existing approval recipient snapshot when configuration changes', async () => {
    await store.enqueueNotifications([{ businessEventId: 'approval-requested:rec_old', recordId: 'rec_old', recipientOpenId: 'ou_original', kind: 'approval_requested' }]);
    await save('purchase_approvers', null, ['ou_new']);
    const gateway = { resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([{ openId: 'ou_new', name: '新审批人', positions: [], buildings: [] }]) };
    await new PurchaseWorkflowService(gateway as never, store).enqueueApprovalRequests('rec_old');
    expect((await store.listNotifications({ recordId: 'rec_old', kind: 'approval_requested' })).map(item => item.recipientOpenId)).toEqual(['ou_original']);
    expect(gateway.resolveConfiguredApproversAsApp).not.toHaveBeenCalled();
    const actor = new UnifiedAccessService(config).issueTrustedSession(config.localTargets().find(item => item.principal.role === 'admin')!.principal).principal;
    await config.saveCardRule({ clientMutationId: 'restore-approvers-mutation', expectedRevision: config.snapshot().revision, code: 'purchase_approvers', building: null, members: [{ openId: 'ou_new', name: '新审批人' }], restoreDefault: true }, actor);
    await new PurchaseWorkflowService(gateway as never, store).enqueueApprovalRequests('rec_old');
    expect((await store.listNotifications({ recordId: 'rec_old', kind: 'approval_requested' })).map(item => item.recipientOpenId)).toEqual(['ou_original']);
    expect(gateway.resolveConfiguredApproversAsApp).not.toHaveBeenCalled();
  });
  it('atomically refuses forged recipients and message IDs, accepts only the delivered card and replays once', async () => {
    await store.enqueueNotifications([{ businessEventId: 'approval-requested:rec_old', recordId: 'rec_old', recipientOpenId: 'ou_original', kind: 'approval_requested' }]);
    const sent = (await store.takeNextNotification())!;
    await store.completeNotification(sent.key, sent.claimToken, { messageId: 'om_delivered_original' });
    const input = { eventId: 'card-configuration-event', recordId: 'rec_old', action: 'approve' as const, actorOpenId: 'ou_original', deliveryMessageId: 'om_delivered_original' };
    await expect(store.claimCardAction({ ...input, actorOpenId: 'ou_new' })).rejects.toThrow('已送达授权不匹配');
    await expect(store.claimCardAction({ ...input, deliveryMessageId: 'om_wrong' })).rejects.toThrow('已送达授权不匹配');
    await save('purchase_approvers', null, ['ou_new']);
    await expect(store.claimCardAction(input)).resolves.toMatchObject({ claimed: true });
    await expect(store.claimCardAction(input)).resolves.toMatchObject({ claimed: false });
  });
});
