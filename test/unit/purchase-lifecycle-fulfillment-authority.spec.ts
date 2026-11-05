import { PurchaseWorkflowService } from '../../server/modules/purchase-inventory/purchase-workflow.service';

describe('lifecycle fulfillment write authority',()=>{
  const saved=process.env.FEISHU_APP_ID;
  afterEach(()=>{if(saved===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=saved;});
  it('rejects a moved batch, changed range, missing duty and revoked principal before a write',()=>{
    process.env.FEISHU_APP_ID='cli_test'; let members: any=[{openId:'ou_buyer'}], enabled=true;
    const config:any={canUseFeishuBusinessIdentity:()=>enabled,feishuPrincipal:()=>({role:'admin'}),currentDutyRoutePeople:()=>members};
    const service:any=new PurchaseWorkflowService({} as never,{} as never,undefined,config);
    const session:any={openId:'ou_buyer',acceptedFulfillment:{proof:{appId:'cli_test',lifecycleAuthority:{batchId:'purchase-application-abc',recordId:'rec_one',actorOpenId:'ou_buyer',choice:'comprehensive',building:'H楼'}}}};
    const record:any={recordId:'rec_one',approvalBatchId:'purchase-application-abc',building:'H楼',purchaserOpenId:'ou_buyer'};
    expect(()=>service.assertLifecycleFulfillmentAuthority('order',record,session)).not.toThrow();
    expect(()=>service.assertLifecycleFulfillmentAuthority('order',{...record,approvalBatchId:'purchase-application-other'},session)).toThrow();
    expect(()=>service.assertLifecycleFulfillmentAuthority('order',{...record,building:'A楼'},session)).toThrow();
    members=null; expect(()=>service.assertLifecycleFulfillmentAuthority('order',record,session)).toThrow();
    members=[{openId:'ou_buyer'}];enabled=false;expect(()=>service.assertLifecycleFulfillmentAuthority('order',record,session)).toThrow();
  });
  it('requires the current requester on receipt',()=>{
    process.env.FEISHU_APP_ID='cli_test';
    const config:any={canUseFeishuBusinessIdentity:()=>true,feishuPrincipal:()=>({role:'admin'}),currentDutyRoutePeople:()=>[]};
    const service:any=new PurchaseWorkflowService({} as never,{} as never,undefined,config);
    const session:any={openId:'ou_requester',acceptedFulfillment:{proof:{appId:'cli_test',lifecycleAuthority:{batchId:'purchase-application-abc',recordId:'rec_one',actorOpenId:'ou_requester',choice:'comprehensive',building:'H楼'}}}};
    const record:any={recordId:'rec_one',approvalBatchId:'purchase-application-abc',building:'H楼',requesterOpenId:'ou_requester'};
    expect(()=>service.assertLifecycleFulfillmentAuthority('receive',record,session)).not.toThrow();
    expect(()=>service.assertLifecycleFulfillmentAuthority('receive',{...record,requesterOpenId:'ou_other'},session)).toThrow();
  });
});
