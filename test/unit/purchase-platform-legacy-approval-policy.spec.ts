import { buildPlatformLegacyApprovalPatch, confirmPlatformLegacyApprovalResult, type PlatformLegacyApprovalClaim } from '../../server/modules/purchase-inventory/purchase-platform-legacy-approval-policy';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

const claim: PlatformLegacyApprovalClaim = {
  recordId: 'rec123', eventId: 'platform_request123', serverActionId: `pa_${'A'.repeat(43)}`,
  decision: 'approved', originalPurchaseMethod: '综合采购', originalBatchId: '',
  originalRequesterOpenId: 'ou_requester', authorityTarget: { building: 'C楼' },
};
const record = {
  recordId: 'rec123', status: '未开始（待审批）', approvalCompleted: false,
  purchaseMethod: '综合采购', requesterOpenId: 'ou_requester', building: 'C楼',
} as PurchaseWorkflowRecord;

describe('isolated legacy platform approval semantics', () => {
  it.each(['综合采购', '需求自采', '需求自采（楼内）'] as const)('approval preserves %s and does not rewrite unrelated fields', (method) => {
    const result = buildPlatformLegacyApprovalPatch({ ...claim, originalPurchaseMethod: method }, { ...record, purchaseMethod: method }, true);
    expect(result).toEqual({ '1️⃣物品采购方式': method, '采购流程': '审批通过（待下单）', '采购审批动作标识': claim.serverActionId });
  });
  it('rejects without inventing a reason or changing purchaser or warehouse', () => {
    expect(buildPlatformLegacyApprovalPatch({ ...claim, decision: 'rejected' }, record, true)).toEqual({
      '1️⃣物品采购方式': '驳回', '采购流程': '驳回申请', '采购审批动作标识': claim.serverActionId,
    });
  });
  it.each([
    { recordId: 'recOther' }, { building: 'A楼' }, { requesterOpenId: 'ou_other' },
    { approvalBatchId: 'batchOther' }, { status: '审批通过（待下单）' },
    { approvalCompleted: true }, { approvalActionId: 'other' }, { purchaseMethod: '需求自采' },
    { specialty: '不明确的专业' },
  ])('fails closed on changed record: %o', (change) => {
    expect(() => buildPlatformLegacyApprovalPatch(claim, { ...record, ...change } as PurchaseWorkflowRecord, true)).toThrow();
  });
  it('requires schema evidence and a server action marker', () => {
    expect(() => buildPlatformLegacyApprovalPatch(claim, record, false)).toThrow();
    expect(() => buildPlatformLegacyApprovalPatch({ ...claim, serverActionId: 'request-id' }, record, true)).toThrow();
  });
  it('only confirms matching marker, target, status and method, with explicit marker presence', () => {
    const done = { ...record, status: '审批通过（待下单）', approvalActionId: claim.serverActionId };
    expect(confirmPlatformLegacyApprovalResult(claim, done, true)).toBe(true);
    expect(confirmPlatformLegacyApprovalResult(claim, done, false)).toBe(false);
    expect(confirmPlatformLegacyApprovalResult(claim, { ...done, approvalActionId: `pa_${'B'.repeat(43)}` }, true)).toBe(false);
    expect(confirmPlatformLegacyApprovalResult(claim, { ...done, purchaseMethod: '需求自采' }, true)).toBe(false);
    expect(confirmPlatformLegacyApprovalResult(claim, { ...done, building: 'A楼' }, true)).toBe(false);
  });
  it('confirms rejection without requiring Feishu actor identity or a reason', () => {
    const rejected = { ...claim, decision: 'rejected' as const };
    expect(confirmPlatformLegacyApprovalResult(rejected, { ...record, status: '驳回申请', purchaseMethod: '驳回', approvalActionId: claim.serverActionId }, true)).toBe(true);
  });
});
