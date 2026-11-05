import { PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import { createPlatformApprovalGateway } from '../../server/modules/purchase-inventory/purchase-platform-approval-gateway';
import { PURCHASE_MANAGER_APPROVAL_FIELDS as F } from '../../server/modules/purchase-inventory/purchase-manager-approval.fields';

function fixture(fields: Record<string,unknown>) {
  const post=jest.fn(async () => ({data:{code:0,data:{records:[{record_id:'rec_synthetic',fields}]}}}));
  const gateway=new PurchaseWorkflowGateway({axiosRef:{post}} as never);
  jest.spyOn(gateway as any,'config').mockReturnValue({appToken:'appSynthetic',executionTableId:'tblSynthetic'});
  jest.spyOn(gateway as any,'getTenantAccessToken').mockResolvedValue('synthetic-token');
  return {post,gateway,adapter:createPlatformApprovalGateway(gateway)};
}
const base=()=>({ '采购流程':'审批通过（待下单）', '申请楼栋':'C楼', '采购编码':'TEST', [F.state]:'已通过', [F.actionId]:`pa_${'x'.repeat(43)}`, [F.approvalTime]:1790000000000, [F.currentApprover]:[], [F.actualApprover]:[{id:'ou_real',name:'合成人员'}] });
afterEach(()=>jest.restoreAllMocks());

describe('one-record real gateway approval readback',()=>{
  it('maps status, time and actual/current users from the same app-authorized read',async()=>{
    const f=fixture(base()), value=await f.adapter.readRecord('rec_synthetic');
    expect(value).toMatchObject({recordId:'rec_synthetic',approvalWorkflowStatus:'已通过',approvalActionId:`pa_${'x'.repeat(43)}`,platformApprovalTimeMs:1790000000000,platformCurrentApproverOpenIds:[],platformActualApproverOpenIds:['ou_real']});
    expect(f.post).toHaveBeenCalledTimes(1); expect(f.post.mock.calls[0][1]).toEqual({record_ids:['rec_synthetic']});
  });
  it('preserves missing fields instead of treating them as verified empty values',async()=>{
    const fields=base(); delete fields[F.state]; delete fields[F.currentApprover]; delete fields[F.approvalTime]; delete fields[F.actualApprover];
    const value=await fixture(fields).adapter.readRecord('rec_synthetic');
    expect(Object.prototype.hasOwnProperty.call(value,'approvalWorkflowStatus')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(value,'platformApprovalTimeMs')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(value,'platformCurrentApproverOpenIds')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(value,'platformActualApproverOpenIds')).toBe(false);
  });
  it('recognizes explicitly empty user and time fields without inventing identities',async()=>{
    const value=await fixture({...base(),[F.approvalTime]:null,[F.currentApprover]:null,[F.actualApprover]:[]}).adapter.readRecord('rec_synthetic');
    expect(Object.prototype.hasOwnProperty.call(value,'platformApprovalTimeMs')).toBe(true); expect(value.platformApprovalTimeMs).toBeUndefined();
    expect(value.platformCurrentApproverOpenIds).toEqual([]); expect(value.platformActualApproverOpenIds).toEqual([]);
  });
  it.each([
    {[F.approvalTime]:'1790000000000'}, {[F.currentApprover]:{}}, {[F.actualApprover]:[{name:'没有身份'}]},
    {[F.actualApprover]:[{id:'ou_one',open_id:'ou_other'}]}, {[F.actualApprover]:[{id:'ou_one'},{id:'ou_one'}]},
  ])('rejects malformed or ambiguous evidence %#',async changes=>{
    await expect(fixture({...base(),...changes}).adapter.readRecord('rec_synthetic')).rejects.toThrow();
  });
  it('rejects absent, forbidden and duplicate record results',async()=>{
    for(const data of [{records:[],absent_record_ids:['rec_synthetic']},{records:[],forbidden_record_ids:['rec_synthetic']},{records:[{record_id:'rec_synthetic',fields:base()},{record_id:'rec_synthetic',fields:base()}]}]){
      const f=fixture(base()); f.post.mockResolvedValueOnce({data:{code:0,data}} as never);
      await expect(f.adapter.readRecord('rec_synthetic')).rejects.toThrow();
    }
  });
});
