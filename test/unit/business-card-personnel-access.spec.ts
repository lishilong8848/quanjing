import { InventoryOutboundApprovalService } from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.service';
import { PurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
import { PurchaseBatchAttachmentController } from '../../server/modules/purchase-inventory/purchase-batch-attachment.controller';
import { FeishuCardActionRouter } from '../../server/modules/purchase-inventory/feishu-card-action.router';
import { PurchaseWorkflowCallbackController } from '../../server/modules/purchase-inventory/purchase-workflow-callback.controller';
import * as accessConfiguration from '../../server/common/access/access-configuration.service';
import { ThresholdAdjustmentService } from '../../server/modules/threshold-management/threshold-adjustment.service';
import { TodayOperationsAnomalyService } from '../../server/modules/bitable-sync/today-operations-anomaly.service';
import { currentHotfixActivation, closeHotfixActivation } from '../../server/common/hotfix-runtime-activation';

describe('采购和出库人员权限收回边界', () => {
  beforeAll(async () => {
    const gate = currentHotfixActivation();
    gate.completeBootstrap();
    await gate.refresh();
    expect(gate.isAcceptingNewWork()).toBe(true);
  });
  afterAll(async () => { await closeHotfixActivation(); });
  let originalApp: string | undefined;
  beforeEach(() => { originalApp = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = 'cli_synthetic_cards'; });
  afterEach(() => { if (originalApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = originalApp; jest.restoreAllMocks(); });
  it('阈值审批旧卡在读取台账和确认前拒绝已收回人员', async () => {
    const ledger = { get: jest.fn(), confirm: jest.fn() }, configuration = { canUseFeishuBusinessIdentity: jest.fn().mockReturnValue(false) };
    const service = Object.assign(Object.create(ThresholdAdjustmentService.prototype), { ledger, accessConfiguration: configuration }) as ThresholdAdjustmentService;
    await expect(service.handleCardAction({ event_type: 'card.action.trigger', operator: { open_id: 'ou_synthetic_revoked' }, context: { open_message_id: 'om_synthetic' }, action: { tag: 'button', value: { workflowType: 'threshold_adjustment', requestId: 'ta-12345678-1234-1234-1234-123456789abc', role: 'engineer', action: 'complete' } } })).rejects.toThrow('当前人员不可办理');
    expect(ledger.get).not.toHaveBeenCalled(); expect(ledger.confirm).not.toHaveBeenCalled();
  });
  it('今日航图旧卡的办理和表单视图均不能跳过业务权限', async () => {
    const store = { claimTerminal: jest.fn(), findByRecordId: jest.fn() }, gateway = { recipientOpenId: () => 'ou_synthetic_revoked', recipientName: () => '合成人员' }, configuration = { canUseFeishuBusinessIdentity: jest.fn().mockReturnValue(false) };
    const service = Reflect.construct(TodayOperationsAnomalyService, [{}, {}, {}, store, gateway, undefined, undefined, undefined, configuration]) as TodayOperationsAnomalyService;
    const input = { anomalyEventId: 'synthetic-event', recordId: 'rec_synthetic', eventId: 'synthetic-action', actorOpenId: 'ou_synthetic_revoked', messageId: 'om_synthetic' };
    await expect(service.acceptTerminalAction({ ...input, terminal: 'acknowledged' })).rejects.toThrow('当前人员不可办理');
    await expect(service.renderCardView({ ...input, view: 'resolution' })).rejects.toThrow('当前人员不可办理');
    expect(store.claimTerminal).not.toHaveBeenCalled(); expect(store.findByRecordId).not.toHaveBeenCalled();
  });
  it.each(['handleManagerCardAction', 'handleManagerBatchCardAction', 'handlePurchaseBatchFulfillmentCardAction'] as const)('%s 在读取、恢复或办理前拒绝收回权限人员', async (method) => {
    const store = { findManagerApprovalCard: jest.fn(), findManagerApprovalBatch: jest.fn(), claimManagerApprovalAction: jest.fn() }, gateway = { readExecutionRecord: jest.fn() };
    const configuration = { canUseFeishuBusinessIdentity: jest.fn().mockReturnValue(false) };
    const service = Reflect.construct(PurchaseManagerApprovalService, [gateway, store, undefined, undefined, undefined, configuration]) as PurchaseManagerApprovalService;
    jest.spyOn(service, 'isEnabled').mockReturnValue(true);
    await expect(service[method]({ operatorOpenId: 'ou_synthetic_revoked', eventId: 'synthetic-event', messageId: 'om_synthetic', executionRecordId: 'rec_synthetic', action: 'submit_reject', rejectionReason: '验收' } as never)).rejects.toThrow('当前人员不可办理');
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled(); expect(gateway.readExecutionRecord).not.toHaveBeenCalled();
  });
  it('出库旧卡在账本恢复和决议前拒绝', async () => {
    const store = { find: jest.fn(), claimDecision: jest.fn() }, gateway = { readOutboundRecord: jest.fn() }, configuration = { canUseFeishuBusinessIdentity: jest.fn().mockReturnValue(false) };
    const service = Reflect.construct(InventoryOutboundApprovalService, [store, gateway, undefined, undefined, undefined, configuration]) as InventoryOutboundApprovalService;
    await expect(service.handleCardAction({ event_type: 'card.action.trigger', operator: { open_id: 'ou_synthetic_revoked' }, context: { open_message_id: 'om_synthetic' }, action: { tag: 'button', value: { workflowType: 'inventory_outbound', action: 'approve', recordId: 'rec_synthetic', version: 1 } } })).rejects.toThrow('当前人员不可办理');
    expect(store.find).not.toHaveBeenCalled(); expect(store.claimDecision).not.toHaveBeenCalled(); expect(gateway.readOutboundRecord).not.toHaveBeenCalled();
  });
  it('采购附件签名票据不能绕过人员权限，包括页面和上传', async () => {
    const tickets = { verify: jest.fn().mockReturnValue({ actorOpenId: 'ou_synthetic_revoked', approvalBatchId: 'synthetic-batch', executionRecordId: 'rec_synthetic', purpose: 'receipt' }) }, store = { findManagerApprovalBatch: jest.fn() }, gateway = { uploadAttachment: jest.fn() }, manager = { runPendingTasks: jest.fn() }, configuration = { canUseFeishuBusinessIdentity: jest.fn().mockReturnValue(false) };
    const controller = Reflect.construct(PurchaseBatchAttachmentController, [tickets, gateway, store, manager, configuration]) as PurchaseBatchAttachmentController;
    await expect(controller.page('synthetic-ticket')).rejects.toThrow('当前人员不可办理');
    await expect(controller.upload('synthetic-ticket', {})).rejects.toThrow('当前人员不可办理');
    expect(store.findManagerApprovalBatch).not.toHaveBeenCalled(); expect(gateway.uploadAttachment).not.toHaveBeenCalled(); expect(manager.runPendingTasks).not.toHaveBeenCalled();
  });
  it('旧采购长连接和 HTTP 回调不能跳过状态检查，认证挑战保持可用', async () => {
    const keys = ['PURCHASE_WORKFLOW_APPROVER_OPEN_IDS', 'PURCHASE_WORKFLOW_PROGRAM_ENABLED', 'FEISHU_CARD_VERIFICATION_TOKEN', 'FEISHU_CARD_ENCRYPT_KEY', 'PURCHASE_MANAGER_APPROVAL_ENABLED'];
    const original = keys.map(key => process.env[key]);
    try {
      process.env.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS = 'ou_synthetic_revoked'; process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true'; process.env.FEISHU_CARD_VERIFICATION_TOKEN = 'synthetic-token'; process.env.FEISHU_CARD_ENCRYPT_KEY = ''; process.env.PURCHASE_MANAGER_APPROVAL_ENABLED = 'false';
      jest.spyOn(accessConfiguration, 'useConfiguredCardAuthorizationSnapshots').mockReturnValue(false);
      const store = { claimCardAction: jest.fn().mockResolvedValue({ claimed: true }) }, configuration = { canUseFeishuBusinessIdentity: jest.fn().mockReturnValue(false) }, disabled = { isEnabled: () => false };
      const router = Reflect.construct(FeishuCardActionRouter, [disabled, disabled, { isEnabled: () => true }, store, disabled, disabled, disabled, undefined, configuration]) as FeishuCardActionRouter;
      const event = { operator: { open_id: 'ou_synthetic_revoked' }, action: { tag: 'button', value: { version: 1, action: 'approve', executionRecordId: 'rec_synthetic' } } };
      expect(await router.handle({ ...event, schema: '2.0', event_type: 'card.action.trigger', event_id: 'synthetic-event' })).toMatchObject({ toast: { type: 'error', content: '当前人员不可办理' } });
      const controller = Reflect.construct(PurchaseWorkflowCallbackController, [store, undefined, undefined, configuration]) as PurchaseWorkflowCallbackController;
      const request = { headers: {}, rawBody: Buffer.from(JSON.stringify({ schema: '2.0', header: { event_id: 'synthetic-http', event_type: 'card.action.trigger', token: 'synthetic-token' }, event })) };
      await expect(Promise.resolve().then(() => controller.handlePurchaseCardCallback(request as never))).rejects.toThrow('当前人员不可办理');
      expect(controller.handlePurchaseCardCallback({ headers: {}, rawBody: Buffer.from(JSON.stringify({ type: 'url_verification', token: 'synthetic-token', challenge: 'synthetic-challenge' })) } as never)).toEqual({ challenge: 'synthetic-challenge' });
      expect(store.claimCardAction).not.toHaveBeenCalled();
    } finally { keys.forEach((key, index) => { if (original[index] === undefined) delete process.env[key]; else process.env[key] = original[index]; }); }
  });
});
