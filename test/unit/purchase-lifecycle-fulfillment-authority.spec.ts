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
  it('honors the verified staged order without duty but rejects scope, permission, identity and purchaser changes', () => {
    process.env.FEISHU_APP_ID = 'cli_test';
    let active = true, allowed = true;
    const config = { canUseFeishuBusinessIdentity: () => active, feishuPrincipal: () => ({ role: allowed ? 'admin' : 'guest' }),
      currentDutyRoutePeople: () => null };
    const service = new PurchaseWorkflowService({} as never, {} as never, undefined, config as never) as unknown as {
      assertLifecycleFulfillmentAuthority(action: 'order', record: object, session: object): void;
    };
    const authority = { batchId: 'purchase-application-abc', recordId: 'rec_one', actorOpenId: 'ou_buyer', choice: 'building_self', building: 'B楼', specialty: '暖通' };
    const session = (stageCards: boolean) => ({ openId: 'ou_buyer', acceptedFulfillment: { proof: {
      appId: 'cli_test', lifecycleAuthority: { ...authority, ...(stageCards ? { stageCards: true } : {}) },
    } } });
    const record = { recordId: 'rec_one', approvalBatchId: authority.batchId, building: 'B楼', specialty: '暖通', purchaserOpenId: 'ou_buyer' };
    const authorize = (current = record, migrated = true) => service.assertLifecycleFulfillmentAuthority('order', current, session(migrated));
    expect(() => authorize()).not.toThrow();
    expect(() => authorize(record, false)).toThrow('下单职责');
    expect(() => authorize({ ...record, purchaserOpenId: 'ou_other' })).toThrow('下单职责');
    expect(() => authorize({ ...record, specialty: '电气' })).toThrow('专业');
    allowed = false;
    expect(() => authorize()).toThrow('履约权限');
    allowed = true; active = false;
    expect(() => authorize()).toThrow('当前人员不可办理');
  });
});
