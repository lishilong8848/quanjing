import { PurchaseOnlineApprovalService } from '../../server/modules/purchase-inventory/purchase-online-approval.service';
import { buildPurchaseManagerApprovalPatch } from '../../server/modules/purchase-inventory/purchase-manager-approval.rules';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

const pending = { recordId: 'recLegacy', status: '未开始（待审批）', purchaseMethod: '综合采购', approvalCompleted: false, rejectionReason: '', building: 'C楼' } as PurchaseWorkflowRecord;
describe('legacy platform approval cannot silently reuse manager-card semantics', () => {
  it('the legacy platform rejects with no reason and writes only its original two fields', async () => {
    const gateway = { getExecutionRecordAsApp: jest.fn(async () => pending), updateExecutionRecordAsApp: jest.fn(async () => undefined) };
    const service = new PurchaseOnlineApprovalService(gateway as never);
    await service.decide('recLegacy', { decision: 'rejected' });
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith('recLegacy', { '1️⃣物品采购方式': '驳回', 采购流程: '驳回申请' });
  });
  it('the manager-card patch cannot represent that platform rejection without inventing a reason', () => {
    expect(() => buildPurchaseManagerApprovalPatch(pending, { choice: 'reject', rejectionReason: '' })).toThrow('驳回原因');
  });
  it('the legacy batch card context cannot encode a rejected item without a reason', () => {
    expect(() => serializePurchaseManagerBatchApprovalCardContext({ version: 3, approvalBatchId: 'purchase-batch-123', requesterOpenId: 'ou_requester', requesterName: '申请人', building: 'C楼', requestCode: 'TEST', expectedDeliveryAt: null, createdAt: null,
      items: [{ executionRecordId: 'recLegacy', title: '合成', specification: '/', quantity: '1', unit: '个', amount: '1', status: 'rejected', choice: 'reject', rejectionReason: '' }] })).toThrow();
  });
  // Full acceptance lives in purchase-platform-legacy-ledger-acceptance.spec.ts:
  // actual no-batch web/card competition, frozen identity, worker and original-card
  // notification consumer assert a reason-free rejection without a fabricated actor.
  // purchase-platform-web-batch-legacy.spec.ts also checks batch-item isolation.
});
