import { PurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import * as permissions from '../../shared/business-permissions';
import type {
  PurchaseManagerApprovalBatchEntry,
  PurchaseManagerApprovalBatchItemEntry,
  PurchaseWorkflowNotificationEntry,
} from '../../server/modules/purchase-inventory/purchase-workflow.store';

const item = {
  executionRecordId: 'recStage',
  authorityTarget: { building: 'C楼', specialty: '电气' },
  choice: 'comprehensive',
} as PurchaseManagerApprovalBatchItemEntry;
const batch = {
  approvalBatchId: 'purchase-batch-stage',
  flowVersion: 'legacy',
  cardContext: 'current-stage-context',
  items: [item],
  stageCardTransition: {
    appId: 'cli_stage',
    archivedMessageIds: ['om_archived'],
    originalCardContext: 'original-stage-context',
  },
} as PurchaseManagerApprovalBatchEntry;

function fixture(allowed: boolean, onDuty = true) {
  const messages = [
    { messageId: 'om_archived', cardContext: batch.cardContext },
    { messageId: 'om_lifecycle_bound', cardContext: batch.cardContext, lifecycleBinding: {} },
    { messageId: 'om_unrelated', cardContext: 'another-batch' },
    { messageId: 'om_order', cardContext: batch.stageCardTransition!.originalCardContext },
  ].map(message => ({ ...message, sendOutcome: 'delivered' }));
  const store = { listNotifications: jest.fn().mockResolvedValue(messages) };
  const config = {
    canUseFeishuBusinessIdentity: () => true,
    feishuPrincipal: () => allowed ? { role: 'admin' } : { role: 'guest' },
    currentDutyRoutePeople: () => onDuty ? [{ openId: 'ou_actor' }] : [],
  };
  const manager = new PurchaseManagerApprovalService(
    {} as never, store as never, undefined, undefined, undefined, config as never,
  ) as unknown as {
    assertMigratedStageAction(batch: PurchaseManagerApprovalBatchEntry, item: PurchaseManagerApprovalBatchItemEntry | undefined, openId: string, action: 'approve' | 'order' | 'receive'): void;
    findPurchaseBatchCardMessageIds(batch: PurchaseManagerApprovalBatchEntry, kind: 'manager_batch_purchase_assigned', openId: string): Promise<string[]>;
    findDeliveredPurchaseBatchCardNotification(batch: PurchaseManagerApprovalBatchEntry, kind: 'manager_batch_purchase_assigned', openId: string): Promise<PurchaseWorkflowNotificationEntry>;
    purchaseBatchReceiptEventId(batch: PurchaseManagerApprovalBatchEntry): Promise<string | null>;
    renderScopedManagerApprovalBatch(batch: PurchaseManagerApprovalBatchEntry, openId: string): Record<string, unknown>;
  };
  return { manager, store };
}

describe('采购分阶段卡原消息和操作范围', () => {
  const previousApp = process.env.FEISHU_APP_ID;
  beforeEach(() => { process.env.FEISHU_APP_ID = 'cli_stage'; });
  afterEach(() => {
    if (previousApp === undefined) delete process.env.FEISHU_APP_ID;
    else process.env.FEISHU_APP_ID = previousApp;
  });

  it('refreshes the separately delivered stage card and ignores archived lifecycle receipts', async () => {
    const { manager } = fixture(true);
    await expect(manager.findPurchaseBatchCardMessageIds(batch, 'manager_batch_purchase_assigned', 'ou_actor'))
      .resolves.toEqual(['om_order']);
    await expect(manager.findDeliveredPurchaseBatchCardNotification(batch, 'manager_batch_purchase_assigned', 'ou_actor'))
      .resolves.toMatchObject({ messageId: 'om_order' });
  });

  it('separates a replacement receipt event from its archived event without duplicating an existing separate receipt', async () => {
    const { manager, store } = fixture(true);
    const eventId = `manager_batch_receipt_requested:${batch.approvalBatchId}`;
    store.listNotifications.mockResolvedValueOnce([]);
    await expect(manager.purchaseBatchReceiptEventId(batch)).resolves.toBe(eventId);
    const archived = { businessEventId: eventId, messageId: 'om_archived', cardContext: batch.cardContext };
    store.listNotifications.mockResolvedValueOnce([archived]);
    await expect(manager.purchaseBatchReceiptEventId(batch)).resolves.toBe(`${eventId}:stage-cards`);
    store.listNotifications.mockResolvedValueOnce([
      archived,
      { businessEventId: `${eventId}:stage-cards`, messageId: 'om_receipt', cardContext: batch.stageCardTransition!.originalCardContext },
    ]);
    await expect(manager.purchaseBatchReceiptEventId(batch)).resolves.toBeNull();
  });

  it.each(['approve', 'order', 'receive'] as const)('requires current record-level %s permission', action => {
    expect(() => fixture(true).manager.assertMigratedStageAction(batch, item, 'ou_actor', action)).not.toThrow();
    expect(() => fixture(false).manager.assertMigratedStageAction(batch, item, 'ou_actor', action)).toThrow('操作权限');
    expect(() => fixture(true).manager.assertMigratedStageAction(batch, undefined, 'ou_actor', action)).toThrow('操作权限');
  });

  it('keeps current approval duty but allows the scoped purchaser to order without a generic duty assignment', () => {
    const { manager } = fixture(true, false);
    expect(() => manager.assertMigratedStageAction(batch, item, 'ou_actor', 'approve')).toThrow('当前采购岗位');
    expect(() => manager.assertMigratedStageAction(batch, item, 'ou_actor', 'order')).not.toThrow();
    expect(() => manager.assertMigratedStageAction(batch, { ...item, choice: 'building_self' }, 'ou_actor', 'order')).not.toThrow();
  });

  it('renders a generic inert card for partial read scope or revoked manager duty', () => {
    const items = [
      { ...item, status: 'pending' as const },
      { ...item, status: 'pending' as const, executionRecordId: 'recRestricted', authorityTarget: { building: 'D楼', specialty: '电气' } },
    ];
    const view = { ...batch, items, state: 'active' as const, cardContext: serializePurchaseManagerBatchApprovalCardContext({
      version: 3, approvalBatchId: batch.approvalBatchId, requesterName: '不应泄露的申请人',
      requesterOpenId: 'ou_requester', building: 'C楼', requestCode: 'STAGE',
      expectedDeliveryAt: '2026-11-10', createdAt: '2026-11-09 14:00',
      items: items.map((row, index) => ({ executionRecordId: row.executionRecordId, title: `不应泄露的物品${index}`,
        specification: '/', quantity: '1', unit: '个', amount: '10', status: 'pending', choice: '', rejectionReason: '' })),
    }) } as PurchaseManagerApprovalBatchEntry;
    const render = (onDuty: boolean) => JSON.stringify(fixture(true, onDuty).manager.renderScopedManagerApprovalBatch(view, 'ou_actor'));
    expect(render(true)).toContain('不应泄露的物品1');
    const denied = render(false);
    expect(denied).toContain('审批范围已变化');
    expect(denied).not.toMatch(/不应泄露|callback/);

    const actual = permissions.canPerformBusinessAction;
    const rule = jest.spyOn(permissions, 'canPerformBusinessAction').mockImplementation((principal, request) =>
      !(request.action === 'read' && request.building === 'D楼') && actual(principal, request),
    );
    try {
      const partial = render(true);
      expect(partial).toContain('审批范围已变化');
      expect(partial).not.toMatch(/不应泄露|callback/);
      expect(() => fixture(true).manager.assertMigratedStageAction(view, items[1], 'ou_actor', 'approve')).toThrow('操作权限');
    } finally { rule.mockRestore(); }
  });
});
