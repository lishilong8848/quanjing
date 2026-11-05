import { createPlatformLegacyApprovalGateway } from '../../server/modules/purchase-inventory/purchase-platform-legacy-approval-gateway';
let mockActive=true;
jest.mock('../../server/common/hotfix-runtime-activation',()=>({currentHotfixActivation:()=>({isAcceptingNewWork:()=>mockActive})}));

describe('isolated legacy web approval gateway', () => {
  beforeEach(()=>{mockActive=true;});
  const source = { appId:'cli_fake', appToken:'fakebase', tableId:'tblfake' }, marker = '采购审批动作标识';
  const fieldRows = () => [
    { field_name:'1️⃣物品采购方式', field_id:'fldMethod', type:3 },
    { field_name:'采购流程', field_id:'fldStatus', type:3 },
    { field_name:marker, field_id:'fldMarker', type:1 },
    { field_name:'采购审批批次号', field_id:'fldBatch', type:1 },
  ];
  const raw = (extra: Record<string, unknown> = {}) => ({ record_id:'recFake', fields:{ '1️⃣物品采购方式':'综合采购', '采购流程':'未开始（待审批）', '采购审批批次号':null, ...extra } });
  function fixture() {
    const gateway = { getTenantAccessTokenAsApp:jest.fn(async () => 'fake-token'), updateExecutionRecordAsApp:jest.fn(async () => undefined) };
    const records = jest.fn(async () => ({ data:{ code:0, data:{ records:[raw({[marker]:''})] } } }));
    const http = { axiosRef:{ get:jest.fn(async () => ({ data:{ code:0, data:{ items:fieldRows(), has_more:false } } })), post:jest.fn(async (url:string) => url.includes('/auth/') ? ({data:{code:0,tenant_access_token:'fake-token'}}) : records()), put:jest.fn(async () => ({data:{code:0,data:{}}})) }, records }; 
    const adapter = createPlatformLegacyApprovalGateway(gateway as never, http as never, () => source, () => ({app_id:'cli_fake',app_secret:'synthetic'}));
    return { gateway, http, adapter };
  }
  it('checks field schema without creating fields or claiming write access', async () => {
    const {adapter,http,gateway} = fixture(); await adapter.verifyMarker(adapter.sourceFingerprint());
    expect(http.axiosRef.get).toHaveBeenCalledTimes(1); expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
    expect(http.axiosRef.get.mock.calls[0][1]).toMatchObject({ maxRedirects:0 });
  });
  it('fails on missing, duplicate, unsupported and denied field metadata', async () => {
    const {adapter,http} = fixture();
    for (const items of [fieldRows().slice(0,2), [...fieldRows(),fieldRows()[2]], fieldRows().map(row => row.field_name === marker ? {...row,type:3} : row)]) {
      http.axiosRef.get.mockResolvedValueOnce({data:{code:0,data:{items,has_more:false}}}); await expect(adapter.verifyMarker(adapter.sourceFingerprint())).rejects.toThrow();
    }
    http.axiosRef.get.mockResolvedValueOnce({data:{code:403,data:{}}}); await expect(adapter.verifyMarker(adapter.sourceFingerprint())).rejects.toThrow();
  });
  it('distinguishes a missing marker from explicit empty and rejects ambiguous types', async () => {
    const {adapter,http} = fixture();
    expect((await adapter.readSnapshot('recFake', adapter.sourceFingerprint())).markerPresent).toBe(true);
    http.records.mockResolvedValueOnce({data:{code:0,data:{records:[raw()]}}});
    await expect(adapter.readSnapshot('recFake', adapter.sourceFingerprint())).rejects.toThrow('权限不足');
    http.records.mockResolvedValueOnce({data:{code:0,data:{records:[raw({[marker]:{text:''}})]}}}); await expect(adapter.readSnapshot('recFake', adapter.sourceFingerprint())).rejects.toThrow();
    http.records.mockResolvedValueOnce({data:{code:0,data:{records:[{record_id:'recFake',fields:{[marker]:''}}]}}}); await expect(adapter.readSnapshot('recFake', adapter.sourceFingerprint())).rejects.toThrow();
  });
  it('accepts omitted empty cells only with verified fields and direct full access for the same app', async () => {
    const {adapter,http} = fixture();
    http.records.mockResolvedValue({data:{code:0,data:{records:[{record_id:'recFake',fields:{'1️⃣物品采购方式':'综合采购','采购流程':'未开始（待审批）'}}]}}});
    for (const member of [
      {member_type:'appid',member_id:'cli_other',perm:'full_access'},
      {member_type:'appid',member_id:'cli_fake',perm:'edit'},
      {member_type:'openid',member_id:'cli_fake',perm:'full_access'},
    ]) {
      http.axiosRef.get.mockResolvedValueOnce({data:{code:0,data:{items:fieldRows(),has_more:false}}});
      http.axiosRef.get.mockResolvedValueOnce({data:{code:0,data:{items:[member]}}} as never);
      await expect(adapter.readSnapshot('recFake',adapter.sourceFingerprint())).rejects.toThrow('权限不足');
    }
    http.axiosRef.get.mockResolvedValueOnce({data:{code:0,data:{items:fieldRows(),has_more:false}}});
    http.axiosRef.get.mockResolvedValueOnce({data:{code:0,data:{items:[{member_type:'appid',member_id:'cli_fake',perm:'full_access'}]}}} as never);
    const snapshot = await adapter.readSnapshot('recFake',adapter.sourceFingerprint());
    expect(snapshot.markerPresent).toBe(true);
    expect(snapshot.record.approvalBatchId || '').toBe('');
    expect(snapshot.record.approvalActionId || '').toBe('');
    expect(http.axiosRef.put).not.toHaveBeenCalled();
  });
  it('preserves the real batch identifier and fails on unavailable records', async () => {
    const {adapter,http} = fixture();
    http.records.mockResolvedValueOnce({data:{code:0,data:{records:[raw({[marker]:'','采购审批批次号':'purchase-batch-123'})]}}});
    expect((await adapter.readSnapshot('recFake', adapter.sourceFingerprint())).record.approvalBatchId).toBe('purchase-batch-123');
    http.records.mockResolvedValueOnce({data:{code:0,data:{records:[],forbidden_record_ids:['recFake']}}});
    await expect(adapter.readSnapshot('recFake', adapter.sourceFingerprint())).rejects.toThrow();
  });
  it('reads Feishu text segments without accepting links or arbitrary objects as approval markers', async () => {
    const {adapter,http} = fixture();
    http.records.mockResolvedValueOnce({data:{code:0,data:{records:[raw({[marker]:[{type:'text',text:'pa_verified'}],'采购审批批次号':[{type:'text',text:'purchase-'},{type:'text',text:'batch-123'}]})]}}});
    const result = await adapter.readSnapshot('recFake',adapter.sourceFingerprint());
    expect(result.record.approvalBatchId).toBe('purchase-batch-123');
    expect(result.record.approvalActionId).toBe('pa_verified');
    http.records.mockResolvedValueOnce({data:{code:0,data:{records:[raw({[marker]:[{type:'url',text:'pa_verified'}]})]}}});
    await expect(adapter.readSnapshot('recFake',adapter.sourceFingerprint())).rejects.toThrow();
    expect(http.axiosRef.put).not.toHaveBeenCalled();
  });
  it('writes only the original web fields and a server action marker with no reason, actor or purchaser', async () => {
    const {adapter,http} = fixture(), action = `pa_${'x'.repeat(43)}`;
    await adapter.writeDecision('recFake', {'1️⃣物品采购方式':'需求自采（楼内）','采购流程':'审批通过（待下单）',[marker]:action}, adapter.sourceFingerprint());
    await adapter.writeDecision('recFake', {'1️⃣物品采购方式':'驳回','采购流程':'驳回申请',[marker]:action}, adapter.sourceFingerprint());
    expect(http.axiosRef.put).toHaveBeenCalledTimes(2);
    await expect(adapter.writeDecision('recFake', {'1️⃣物品采购方式':'驳回','采购流程':'驳回申请',[marker]:action,'驳回原因':'伪造'}, adapter.sourceFingerprint())).rejects.toThrow();
    expect(http.axiosRef.put).toHaveBeenCalledTimes(2);
  });
  it('does not retry a write whose outcome is unknown', async () => {
    const {adapter,http} = fixture(); http.axiosRef.put.mockRejectedValueOnce(new Error('timeout'));
    await expect(adapter.writeDecision('recFake', {'1️⃣物品采购方式':'综合采购','采购流程':'审批通过（待下单）',[marker]:`pa_${'x'.repeat(43)}`}, adapter.sourceFingerprint())).rejects.toThrow();
    expect(http.axiosRef.put).toHaveBeenCalledTimes(1);
  });
  it('stops immediately before the remote write when maintenance begins while acquiring credentials',async()=>{
    const {adapter,http}=fixture();
    http.axiosRef.post.mockImplementationOnce(async()=>{mockActive=false;return {data:{code:0,tenant_access_token:'synthetic'}};});
    await expect(adapter.writeDecision('recFake',{'1️⃣物品采购方式':'综合采购','采购流程':'审批通过（待下单）',[marker]:`pa_${'x'.repeat(43)}`},adapter.sourceFingerprint())).rejects.toThrow('更新中');
    expect(http.axiosRef.put).not.toHaveBeenCalled();
  });
  it('binds metadata, reads and writes to the app, base and table frozen at acceptance', async () => {
    const {gateway,http} = fixture(); let current = {...source};
    const adapter = createPlatformLegacyApprovalGateway(gateway as never, http as never, () => current, () => ({app_id:'cli_fake',app_secret:'synthetic'}));
    const accepted = adapter.sourceFingerprint(), patch = {'1️⃣物品采购方式':'综合采购','采购流程':'审批通过（待下单）',[marker]:`pa_${'x'.repeat(43)}`};
    for (const changed of [{...source,appId:'cli_other'}, {...source,appToken:'otherbase'}, {...source,tableId:'tblother'}]) {
      current = changed;
      await expect(adapter.verifyMarker(accepted)).rejects.toThrow();
      await expect(adapter.readSnapshot('recFake', accepted)).rejects.toThrow();
      await expect(adapter.writeDecision('recFake', patch, accepted)).rejects.toThrow();
    }
    expect(http.axiosRef.put).not.toHaveBeenCalled();
    current = {...source}; http.axiosRef.post.mockImplementationOnce(async () => { current = {...source,tableId:'tblother'}; return {data:{code:0,tenant_access_token:'fake-token'}}; });
    await expect(adapter.readSnapshot('recFake', accepted)).rejects.toThrow();
    expect(http.records).not.toHaveBeenCalled();
  });
});
