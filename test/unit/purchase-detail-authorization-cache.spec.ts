import { PurchaseWorkflowService } from '../../server/modules/purchase-inventory/purchase-workflow.service';
import { businessAuthorizationSnapshot } from '../../shared/business-permissions';
describe('purchase detail cache authorization boundary',()=>{
 it('separates self and impersonation and does not retain actions after a configuration revision',async()=>{
  const saved=process.env.FEISHU_APP_ID;process.env.FEISHU_APP_ID='cli_test';
  try {
   const principal:any={role:'building_admin',purchaseBuilding:'C楼',buildings:['C楼'],accountId:'person_one',authorizationVersion:1,permissionContext:{module:'purchase',action:'read'},effectiveAuthorization:{mode:'independent',baseline:{nativeRole:null,pages:[],rules:[{id:'order',module:'purchase',effect:'allow',actions:['read','order'],buildings:['C楼'],specialties:null}]},overrides:{rules:[],allowPages:[],denyPages:[]}}};
   let revision=1, enabled=true;const row:any={id:'person_one',kind:'feishu',appId:'cli_test',openId:'ou_actor',enabled:true,deleted:false};
   const config:any={snapshot:()=>({appId:'cli_test',revision,accounts:[row]}),currentPrincipal:()=>enabled?principal:undefined,currentDutyRoutePeople:()=>null};
   const gateway:any={getExecutionRecord:jest.fn(async()=>({recordId:'rec_one',status:'审批通过（待下单）',building:'C楼',specialty:'电气',purchaseMethod:'综合采购',requesterOpenId:'ou_other',purchaserOpenId:'ou_other',receiptPhotoTokens:[],invoiceTokens:[]})),resolveUser:jest.fn(async()=>({openId:'ou_actor',name:'人员',positions:[],buildings:['C楼']}))};
   const service:any=new PurchaseWorkflowService(gateway,{} as never,undefined,config);
   const session:any={accessToken:'token',openId:'ou_actor',accessRole:'building_admin',purchaseBuilding:'C楼',purchaseBuildings:['C楼'],permissionPrincipal:businessAuthorizationSnapshot(principal),authenticationMode:'delegated-app'};
   expect((await service.getDetail('rec_one',session)).allowedActions).toContain('order');
   const ownKey=service.detailCacheKey('rec_one',session), impKey=service.detailCacheKey('rec_one',{...session,impersonated:true});expect(ownKey).not.toBe(impKey);
   enabled=false;revision++;expect((await service.getDetail('rec_one',session)).allowedActions).not.toContain('order');expect(gateway.getExecutionRecord).toHaveBeenCalledTimes(2);
   enabled=true; let proofActive=true;
   const proofSession={...session,platformSession:true,platformProof:{actorAccountId:'person_one',actorDisplayName:'人员',actorFeishuOpenId:'ou_actor'},assertPlatformProof:()=>{if(!proofActive)throw new Error('expired');}};
   expect((await service.getDetail('rec_one',proofSession)).allowedActions).toContain('order');
   proofActive=false;expect((await service.getDetail('rec_one',proofSession)).allowedActions).not.toContain('order');
   expect(gateway.getExecutionRecord).toHaveBeenCalledTimes(4);
  } finally {if(saved===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=saved;}
 });
});


