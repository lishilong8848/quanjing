import { FeishuCardActionHealthController } from '../../server/modules/purchase-inventory/feishu-card-action.consumer';
jest.mock('../../server/common/config/external-services.config',()=>({...jest.requireActual('../../server/common/config/external-services.config'),getFeishuCardActionConsumerProfile:()=>({enabled:true})}));
it('reports the actual processing/admission gates without exposing business or account data',()=>{
  let processing=true,admission=true;
  const health=new FeishuCardActionHealthController({isAnyEnabled:()=>true} as never,{isReady:()=>true} as never,{isProcessing:()=>processing,isReady:()=>admission});
  expect(health.health().purchaseLifecycle).toEqual({processing:true,newApplicationsReady:true});
  admission=false;expect(health.health().purchaseLifecycle).toEqual({processing:true,newApplicationsReady:false});
  processing=false;expect(health.health().purchaseLifecycle).toEqual({processing:false,newApplicationsReady:false});
  expect(Object.keys(health.health()).sort()).toEqual(['enabled','purchaseLifecycle','ready']);
});
