import { buildPlatformLegacyApprovalPatch, confirmPlatformLegacyApprovalResult, type PlatformLegacyApprovalClaim } from '../../server/modules/purchase-inventory/purchase-platform-legacy-approval-policy';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

describe('隔离网页审批策略对真实批次的保留',()=>{
  const claim:PlatformLegacyApprovalClaim={recordId:'recSynthetic',eventId:'platform_request_123456789',serverActionId:`pa_${'x'.repeat(43)}`,decision:'approved',originalPurchaseMethod:'需求自采（楼内）',originalBatchId:'batch-original',originalRequesterOpenId:'ou_requester',authorityTarget:{building:'C楼'}};
  const before={recordId:'recSynthetic',status:'未开始（待审批）',approvalCompleted:false,purchaseMethod:'需求自采（楼内）',approvalBatchId:'batch-original',approvalActionId:'',requesterOpenId:'ou_requester',building:'C楼'} as PurchaseWorkflowRecord;
  it('保留批次和原采购方式，不写采购人、库房或驳回原因',()=>{
    expect(buildPlatformLegacyApprovalPatch(claim,before,true)).toEqual({'1️⃣物品采购方式':'需求自采（楼内）','采购流程':'审批通过（待下单）','采购审批动作标识':claim.serverActionId});
  });
  it('批次发生变化或缺失时，在发送前拒绝且回执不确认',()=>{
    for(const approvalBatchId of ['',undefined,'batch-other']) {
      expect(()=>buildPlatformLegacyApprovalPatch(claim,{...before,approvalBatchId},true)).toThrow();
      expect(confirmPlatformLegacyApprovalResult(claim,{...before,approvalBatchId,status:'审批通过（待下单）',approvalActionId:claim.serverActionId},true)).toBe(false);
    }
  });
  it('驳回无须理由且不覆盖记录已有原因',()=>{
    const patch=buildPlatformLegacyApprovalPatch({...claim,decision:'rejected'},before,true);
    expect(patch).toEqual({'1️⃣物品采购方式':'驳回','采购流程':'驳回申请','采购审批动作标识':claim.serverActionId});
    expect(patch).not.toHaveProperty('驳回原因');expect(patch).not.toHaveProperty('采购审批批次号');
  });
  // Full acceptance: purchase-platform-web-batch-legacy.spec.ts runs the real ledger,
  // decision worker, competing batch-card claim and original-message refresh consumer.
});
