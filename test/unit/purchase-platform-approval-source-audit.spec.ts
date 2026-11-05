import { createPlatformLegacyApprovalGateway } from '../../server/modules/purchase-inventory/purchase-platform-legacy-approval-gateway';
import { createPlatformApprovalGateway } from '../../server/modules/purchase-inventory/purchase-platform-approval-gateway';

describe('隔离审查：采购审批来源与空字段', () => {
  it('缺少字段访问证明时不将缺失批次视作显式空值', async () => {
    const source={appId:'cli_fake',appToken:'base_fake',tableId:'tbl_fake'};
    const gateway={getTenantAccessTokenAsApp:jest.fn(async()=>'synthetic'),updateExecutionRecordAsApp:jest.fn(async()=>{})};
    const rows=[{record_id:'recFake',fields:{'1️⃣物品采购方式':'综合采购','采购流程':'未开始（待审批）','采购审批动作标识':''}},{record_id:'recFake',fields:{'1️⃣物品采购方式':'综合采购','采购流程':'未开始（待审批）','采购审批动作标识':'','采购审批批次号':null}}];
    const http={axiosRef:{post:jest.fn(async(url:string)=>url.includes('/auth/') ? {data:{code:0,tenant_access_token:'synthetic'}} : {data:{code:0,data:{records:[rows.shift()]}}})}};
    const adapter=createPlatformLegacyApprovalGateway(gateway as never,http as never,()=>source,()=>({app_id:'cli_fake',app_secret:'synthetic'})), fingerprint=adapter.sourceFingerprint();
    await expect(adapter.readSnapshot('recFake',fingerprint)).rejects.toThrow();
    const explicitEmpty=await adapter.readSnapshot('recFake',fingerprint);
    expect(explicitEmpty.record.approvalBatchId).toBe('');
  });
  it('获取令牌期间切源不会向任何目标写入', async () => {
    let source={appId:'cli_fake',appToken:'base_one',tableId:'tbl_one'};
    const put=jest.fn();
    const gateway={getTenantAccessTokenAsApp:jest.fn(async()=> 'stale-token')};
    const post=jest.fn(async()=>{await Promise.resolve();source={...source,tableId:'tbl_other'};return {data:{code:0,tenant_access_token:'synthetic'}};});
    const adapter=createPlatformLegacyApprovalGateway(gateway as never,{axiosRef:{put,post}} as never,()=>source,()=>({app_id:'cli_fake',app_secret:'synthetic'})), fingerprint=adapter.sourceFingerprint();
    await expect(adapter.writeDecision('recFake',{'1️⃣物品采购方式':'驳回','采购流程':'驳回申请','采购审批动作标识':`pa_${'x'.repeat(43)}`},fingerprint)).rejects.toThrow();
    expect(put).not.toHaveBeenCalled();
    expect(gateway.getTenantAccessTokenAsApp).not.toHaveBeenCalled();
  });
  it('取令牌期间凭据改变时不会复用旧令牌或发出写入', async () => {
    const source={appId:'cli_fake',appToken:'base_one',tableId:'tbl_one'};
    let credentials={app_id:'cli_fake',app_secret:'synthetic-old'};
    const put=jest.fn(), shared={getTenantAccessTokenAsApp:jest.fn(async()=> 'old-cached-token')};
    const post=jest.fn(async()=>{credentials={...credentials,app_secret:'synthetic-new'};return {data:{code:0,tenant_access_token:'synthetic-token'}};});
    const adapter=createPlatformLegacyApprovalGateway(shared as never,{axiosRef:{put,post}} as never,()=>source,()=>credentials);
    await expect(adapter.writeDecision('recFake',{'1️⃣物品采购方式':'驳回','采购流程':'驳回申请','采购审批动作标识':`pa_${'x'.repeat(43)}`},adapter.sourceFingerprint())).rejects.toThrow();
    expect(shared.getTenantAccessTokenAsApp).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
  it('请求发出后切源只会写入已冻结的地址且结果需要核对', async () => {
    let source={appId:'cli_fake',appToken:'base_one',tableId:'tbl_one'};
    const put=jest.fn(async()=>{source={...source,tableId:'tbl_other'};return {data:{code:0,data:{}}};});
    const post=jest.fn(async()=>({data:{code:0,tenant_access_token:'synthetic'}}));
    const adapter=createPlatformLegacyApprovalGateway({getTenantAccessTokenAsApp:async()=> 'synthetic'} as never,{axiosRef:{put,post}} as never,()=>source,()=>({app_id:'cli_fake',app_secret:'synthetic'})), fingerprint=adapter.sourceFingerprint();
    await expect(adapter.writeDecision('recFake',{'1️⃣物品采购方式':'驳回','采购流程':'驳回申请','采购审批动作标识':`pa_${'x'.repeat(43)}`},fingerprint)).rejects.toThrow();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toContain('/apps/base_one/tables/tbl_one/records/recFake');
  });
  it('现有批次网关不能直接接受网页空原因的原语义 patch', async () => {
    const gateway={updateManagerApprovalDecisionRecordAsApp:jest.fn(async()=>{})};
    const adapter=createPlatformApprovalGateway(gateway as never);
    await expect(adapter.writeRecord('recFake',{'1️⃣物品采购方式':'驳回','采购流程':'驳回申请','采购审批动作标识':`pa_${'x'.repeat(43)}`})).rejects.toThrow();
    expect(gateway.updateManagerApprovalDecisionRecordAsApp).not.toHaveBeenCalled();
  });
});
jest.mock('../../server/common/hotfix-runtime-activation',()=>({currentHotfixActivation:()=>({isAcceptingNewWork:()=>true})}));
