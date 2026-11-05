import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';
import { buildPurchaseManagerApprovalPatch } from '../../server/modules/purchase-inventory/purchase-manager-approval.rules';
import { buildPurchasePlatformResolvedFields } from '../../server/modules/purchase-inventory/purchase-manager-approval.fields';
import { createPlatformApprovalGateway } from '../../server/modules/purchase-inventory/purchase-platform-approval-gateway';

const record = (): PurchaseWorkflowRecord => ({ recordId:'rec_synthetic', requestCode:'TEST', status:'未开始（待审批）', itemName:'合成物品', building:'C楼', specialty:'电气', requesterOpenId:'ou_requester', requesterName:'合成申请人', purchaserOpenId:'', purchaserName:'', purchaseMethod:'综合采购', requestedQuantity:1, actualQuantity:null, actualAmount:null, approvalCompleted:false, warehouseConfirmed:false, purchaseCompleted:false, receiptConfirmed:false, signer:'', receiptTime:null, receiptPhotoTokens:[], invoiceTokens:[] });
const user = { openId:'ou_selected', name:'合成采购人', positions:[], buildings:[] };
const actionId = `pa_${'x'.repeat(43)}`;
function patch(choice:'comprehensive'|'building_self'|'reject', actorFeishuOpenId?:string) {
  const decision = choice === 'reject' ? { choice, rejectionReason:'合成驳回原因' } as const : { choice, purchaser:user };
  return { ...buildPurchaseManagerApprovalPatch(record(), decision), ...buildPurchasePlatformResolvedFields({ choice, actorFeishuOpenId, eventId:actionId, approvalTime:new Date(1790000000000) }) };
}
function fixture() {
  const gateway = { getPlatformApprovalReadbackAsApp:jest.fn(async () => record()), updateManagerApprovalDecisionRecordAsApp:jest.fn(async () => undefined),
    resolvePurchaseAdminAsApp:jest.fn(async () => ({...user})), resolveBuildingSupervisorAsApp:jest.fn(async () => ({...user})) };
  return { gateway, adapter:createPlatformApprovalGateway(gateway as never) };
}

describe('isolated app-token platform approval gateway', () => {
  it('reads the exact requested record via the existing app-credential gateway', async () => {
    const f=fixture(); expect((await f.adapter.readRecord('rec_synthetic')).recordId).toBe('rec_synthetic');
    expect(f.gateway.getPlatformApprovalReadbackAsApp).toHaveBeenCalledWith('rec_synthetic');
    f.gateway.getPlatformApprovalReadbackAsApp.mockResolvedValueOnce({...record(),recordId:'rec_other'});
    await expect(f.adapter.readRecord('rec_synthetic')).rejects.toThrow();
    await expect(f.adapter.readRecord('bad')).rejects.toThrow(); expect(f.gateway.getPlatformApprovalReadbackAsApp).toHaveBeenCalledTimes(2);
  });
  it('uses the existing comprehensive and building-self routing with the original scope', async () => {
    const f=fixture(), row=record();
    expect(await f.adapter.resolvePurchaser(row,'comprehensive')).toEqual({openId:'ou_selected',name:'合成采购人'});
    expect(f.gateway.resolvePurchaseAdminAsApp).toHaveBeenCalledWith({building:'C楼',specialty:'电气'});
    expect(await f.adapter.resolvePurchaser(row,'building_self')).toEqual({openId:'ou_selected',name:'合成采购人'});
    expect(f.gateway.resolveBuildingSupervisorAsApp).toHaveBeenCalledWith('C楼','电气');
  });
  it('fails closed for invalid scope, absent or invalid purchaser and never guesses an identity', async () => {
    const f=fixture();
    await expect(f.adapter.resolvePurchaser({...record(),building:'C楼、A楼'},'building_self')).rejects.toThrow();
    await expect(f.adapter.resolvePurchaser({...record(),specialty:'未知'},'comprehensive')).rejects.toThrow();
    f.gateway.resolvePurchaseAdminAsApp.mockResolvedValueOnce({...user,openId:''});
    await expect(f.adapter.resolvePurchaser(record(),'comprehensive')).rejects.toThrow();
    f.gateway.resolveBuildingSupervisorAsApp.mockResolvedValueOnce({...user,name:'伪造\n人员'});
    await expect(f.adapter.resolvePurchaser(record(),'building_self')).rejects.toThrow();
    expect(f.gateway.updateManagerApprovalDecisionRecordAsApp).not.toHaveBeenCalled();
  });
  it.each(['comprehensive','building_self','reject'] as const)('writes the exact generated %s result without inventing a Feishu approver', async choice => {
    const f=fixture(), fields=patch(choice); await f.adapter.writeRecord('rec_synthetic',fields);
    expect(fields).not.toHaveProperty('采购实际审批人');
    expect(f.gateway.updateManagerApprovalDecisionRecordAsApp).toHaveBeenCalledWith('rec_synthetic',fields);
    expect(f.gateway.updateManagerApprovalDecisionRecordAsApp.mock.calls[0][1]).not.toBe(fields);
  });
  it('preserves an explicitly verified approver, and rejects extra or forged field shapes', async () => {
    const f=fixture(), fields=patch('comprehensive','ou_real_actor'); await f.adapter.writeRecord('rec_synthetic',fields);
    expect(f.gateway.updateManagerApprovalDecisionRecordAsApp.mock.calls[0][1]['采购实际审批人']).toEqual([{id:'ou_real_actor'}]);
    for(const bad of [{...fields,采购实际审批人:[{id:'bad'}]}, {...fields,采购人:[{id:'ou_selected',name:'伪造'}]}, {...fields,越权字段:'x'}, {...fields,采购审批动作标识:'client-event'}]) await expect(f.adapter.writeRecord('rec_synthetic',bad)).rejects.toThrow();
    expect(f.gateway.updateManagerApprovalDecisionRecordAsApp).toHaveBeenCalledTimes(1);
  });
  it('propagates a lost write response once without retrying or claiming success', async () => {
    const f=fixture(); f.gateway.updateManagerApprovalDecisionRecordAsApp.mockRejectedValueOnce(new Error('synthetic timeout'));
    await expect(f.adapter.writeRecord('rec_synthetic',patch('comprehensive'))).rejects.toThrow('synthetic timeout');
    expect(f.gateway.updateManagerApprovalDecisionRecordAsApp).toHaveBeenCalledTimes(1);
    expect(f.gateway.getPlatformApprovalReadbackAsApp).not.toHaveBeenCalled();
  });
});
