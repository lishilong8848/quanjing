jest.mock('../../server/modules/purchase-inventory/purchase-manager-approval.config', () => ({
  isPurchaseManagerApprovalEnabled: () => true,
  readPurchaseManagerApprovers: () => [{ openId: 'ou_manager', name: '经理' }],
  readPurchaseManagerApprover: () => ({ openId: 'ou_manager', name: '经理' }),
}));
import { PurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
const savedEnv = { ...process.env };
beforeEach(() => { Object.assign(process.env, { FEISHU_APP_ID:'cli_test', FEISHU_CARD_READONLY_COPY_APP_ID:'cli_test', FEISHU_CARD_READONLY_COPY_ENABLED:'true', FEISHU_CARD_READONLY_COPY_NAME:'李世龙', FEISHU_CARD_READONLY_COPY_OPEN_ID:'ou_li', FEISHU_CARD_READONLY_COPY_ADDITIONAL_RECIPIENTS:'[{"name":"刘小杏","openId":"ou_liu"}]' }); });
afterEach(() => { process.env = { ...savedEnv }; });
const configuration = { canUseFeishuBusinessIdentity: () => true, isCurrentReadonlyCardRecipient: () => true,
  feishuPrincipal: () => ({ role:'admin', purchaseBuilding:null }), currentDutyRoutePeople: () => [{ openId:'ou_manager' }] };
const pendingRecord = (id: string) => ({ recordId:id, requesterOpenId:'ou_requester', status:'未开始（待审批）', building:'A楼' });

describe('purchase lifecycle batch registration', () => {
  it('preserves trusted lifecycle marker without changing legacy inputs', async () => {
    const store = { registerManagerApprovalBatch: jest.fn().mockResolvedValue({}) };
    const service = new PurchaseManagerApprovalService({ getExecutionRecordAsApp: async (id:string) => pendingRecord(id) } as never, store as never, undefined, undefined, undefined, configuration as never);
    const input = { approvalBatchId: 'purchase-application-123', requesterOpenId: 'ou_requester', recordIds: ['rec_one'] };
    await service.enqueueApprovalBatch(input);
    expect(store.registerManagerApprovalBatch).toHaveBeenNthCalledWith(1, expect.not.objectContaining({ flowVersion: expect.anything() }));
    await service.enqueueApprovalBatch({ ...input, flowVersion: 'lifecycle_v1' });
    expect(store.registerManagerApprovalBatch).toHaveBeenNthCalledWith(2, expect.objectContaining({ flowVersion: 'lifecycle_v1' }), expect.any(Date), expect.objectContaining({appId:'cli_test'}));
  });
  it('recovers from persisted marker, never from the current caller or timestamp', async () => {
    const store = { listManagerApprovalBatchIds: jest.fn().mockResolvedValue([]), registerManagerApprovalBatch: jest.fn().mockResolvedValue({}) };
    const gateway = { getExecutionRecordAsApp: jest.fn().mockImplementation(async (id:string) => pendingRecord(id)) };
    const ledger = { listCompletedTasksWithCreatedRecords: jest.fn().mockReturnValue([
      { task: { id: 'purchase-application-old', result: { created: [{ recordId: 'rec_old' }] } } },
      { flowVersion: 'lifecycle_v1', task: { id: 'purchase-application-new', result: { created: [{ recordId: 'rec_new' }] } } },
    ]) };
    const service = new PurchaseManagerApprovalService(gateway as never, store as never, ledger as never, undefined, undefined, configuration as never);
    const result = { processed: 0, failed: 0, manualReconciliation: 0, alerts: [], errors: [] };
    await (service as unknown as { reconcileCompletedApplicationBatches(r: unknown): Promise<void> }).reconcileCompletedApplicationBatches(result);
    expect(store.registerManagerApprovalBatch).toHaveBeenNthCalledWith(1, expect.not.objectContaining({ flowVersion: expect.anything() }));
    expect(store.registerManagerApprovalBatch).toHaveBeenNthCalledWith(2, expect.objectContaining({ flowVersion: 'lifecycle_v1' }), expect.any(Date), expect.objectContaining({appId:'cli_test'}));
    expect(result.failed).toBe(0);
  });
  it.each(['approval', 'receipt'] as const)('does not rebuild a known lifecycle batch with the legacy %s scanner', async stage => {
    const record = { recordId: 'rec_new', status: stage === 'approval' ? '未开始（待审批）' : '下单完成（待签收）',
      approvalBatchId: 'purchase-application-new', requestCode: 'CG-NEW', requesterOpenId: 'ou_requester', purchaserOpenId: 'ou_purchaser',
      purchaseMethod: '综合采购', actualQuantity: 1, actualAmount: 1, receiptConfirmed: false, createdAt: 1 };
    const gateway = { listExecutionRecordsAsApp: jest.fn().mockResolvedValue([record]) };
    const store = { registerManagerApprovalBatch: jest.fn(), recoverManagerReceiptBatchAndEnqueue: jest.fn(), findManagerApprovalBatch: jest.fn() };
    const ledger = { findByTaskId: jest.fn().mockReturnValue({ flowVersion: 'lifecycle_v1', task: { status: 'completed' } }) };
    const service = new PurchaseManagerApprovalService(gateway as never, store as never, ledger as never);
    const result = { processed: 0, failed: 0, manualReconciliation: 0, alerts: [], errors: [] };
    const internals = service as unknown as { reconcileBasePendingApprovalBatches(r: unknown, now: Date): Promise<void>; reconcileBasePendingReceiptBatches(r: unknown, now: Date): Promise<void> };
    if (stage === 'approval') await internals.reconcileBasePendingApprovalBatches(result, new Date());
    else await internals.reconcileBasePendingReceiptBatches(result, new Date());
    expect(store.registerManagerApprovalBatch).not.toHaveBeenCalled();
    expect(store.recoverManagerReceiptBatchAndEnqueue).not.toHaveBeenCalled();
    expect(result.failed).toBe(0);
  });
});
