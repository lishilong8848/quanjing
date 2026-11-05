import { PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import { lifecyclePaymentUploadSourceFingerprint } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-upload-gateway';
let appId='cli_source',secret='synthetic-secret',base='synthetic_base',table='tbl_synthetic';
jest.mock('../../server/common/config/external-services.config',()=>({...jest.requireActual('../../server/common/config/external-services.config'),
 readEnv:(key:string)=>({FEISHU_APP_ID:appId,FEISHU_PURCHASE_INVENTORY_APP_TOKEN:base,FEISHU_PURCHASE_EXECUTION_TABLE_ID:table}[key]||''),
 getFeishuAuthPayload:()=>({app_id:appId,app_secret:secret})}));
describe('manager gateway frozen source and app-bound token cache',()=>{
 let gateway:PurchaseWorkflowGateway,http:{axiosRef:{get:jest.Mock;put:jest.Mock;post:jest.Mock}};
 beforeEach(()=>{appId='cli_source';secret='synthetic-secret';base='synthetic_base';table='tbl_synthetic';http={axiosRef:{get:jest.fn(async()=>({data:{code:0,data:{record:{record_id:'rec_one',fields:{}}}}})),put:jest.fn(async()=>({data:{code:0}})),post:jest.fn(async()=>({data:{code:0,tenant_access_token:'synthetic-token',expire:7200}}))}};gateway=new PurchaseWorkflowGateway(http as never);});
 afterEach(()=>jest.restoreAllMocks());
 const guard=()=>{const fingerprint=lifecyclePaymentUploadSourceFingerprint();return async()=>{if(lifecyclePaymentUploadSourceFingerprint()!==fingerprint)throw Error('source changed');};};
 it.each(['read','write'])('blocks %s if Base changes while awaiting the tenant token',async method=>{
   const check=guard();http.axiosRef.post.mockImplementationOnce(async()=>{base='other_base';return {data:{code:0,tenant_access_token:'synthetic-token',expire:7200}};});
   await expect(method==='read'?gateway.getManagerApprovalDecisionRecordAsApp('rec_one',check):gateway.updateManagerApprovalDecisionRecordAsApp('rec_one',{'采购流程':'test'},check)).rejects.toThrow('source changed');
   expect(http.axiosRef.get).not.toHaveBeenCalled();expect(http.axiosRef.put).not.toHaveBeenCalled();
 });
 it('checks immediately after field resolution before the actual put',async()=>{
   const check=guard();jest.spyOn(gateway as any,'resolveExecutionFieldNames').mockImplementation(async()=>{table='tbl_other';return {'采购流程':'test'};});
   await expect(gateway.updateManagerApprovalDecisionRecordAsApp('rec_one',{'采购流程':'test'},check)).rejects.toThrow('source changed');expect(http.axiosRef.put).not.toHaveBeenCalled();
 });
 it('does not reuse a tenant token after the actual app or secret changes',async()=>{
   http.axiosRef.post.mockImplementation(async(_url:string,credentials:{app_id:string;app_secret:string})=>({data:{code:0,tenant_access_token:`token_${credentials.app_id}_${credentials.app_secret}`,expire:7200}}));
   expect(await gateway.getTenantAccessTokenAsApp()).toBe('token_cli_source_synthetic-secret');
   expect(await gateway.getTenantAccessTokenAsApp()).toBe('token_cli_source_synthetic-secret');expect(http.axiosRef.post).toHaveBeenCalledTimes(1);
   secret='rotated';expect(await gateway.getTenantAccessTokenAsApp()).toBe('token_cli_source_rotated');
   appId='cli_other';expect(await gateway.getTenantAccessTokenAsApp()).toBe('token_cli_other_rotated');expect(http.axiosRef.post).toHaveBeenCalledTimes(3);
 });
 it('does not share an old-app pending token or clear the new-app request on old completion',async()=>{
   let resolveOld!:(value:unknown)=>void,resolveNew!:(value:unknown)=>void;
   http.axiosRef.post.mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;})).mockImplementationOnce(()=>new Promise(resolve=>{resolveNew=resolve;}));
   const old=gateway.getTenantAccessTokenAsApp();const oldOutcome=old.then(()=>false,()=>true);
   appId='cli_other';const first=gateway.getTenantAccessTokenAsApp();
   resolveOld({data:{code:0,tenant_access_token:'old-token',expire:7200}});expect(await oldOutcome).toBe(true);
   const second=gateway.getTenantAccessTokenAsApp();expect(http.axiosRef.post).toHaveBeenCalledTimes(2);
   resolveNew({data:{code:0,tenant_access_token:'new-token',expire:7200}});
   expect(await Promise.all([first,second])).toEqual(['new-token','new-token']);expect(await gateway.getTenantAccessTokenAsApp()).toBe('new-token');
 });
});
