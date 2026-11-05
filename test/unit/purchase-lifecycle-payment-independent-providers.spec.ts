import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { migrateAuthorizationState } from '../../server/common/access/authorization-profile.configuration';
import { UnifiedAccessService } from '../../server/common/access/unified-access.service';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import { PurchaseLifecycleGatewayRecordSource } from '../../server/modules/purchase-inventory/purchase-lifecycle-gateway-record-source';
import { PurchaseLifecycleServerAuthorizer } from '../../server/modules/purchase-inventory/purchase-lifecycle-delivery-authorizer';
import { LifecyclePaymentPerFileGatewayAdapter } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-upload-gateway';
import { LifecyclePaymentPerFileStoreAdapter } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-per-file-store-adapter';
import { LifecyclePaymentUploadStoreAdapter } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-upload-store-adapter';
import { LIFECYCLE_PAYMENT_PER_FILE_STORE, LIFECYCLE_PAYMENT_UPLOAD_GATEWAY, LIFECYCLE_PAYMENT_UPLOAD_READINESS, LIFECYCLE_PAYMENT_UPLOAD_STORE, LifecyclePaymentUploadIsolatedController, LifecyclePaymentUploadIsolatedService, LifecyclePaymentUploadSessionAccess, LifecyclePaymentUploadSessionGuard } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-upload-isolated';
import { PURCHASE_LIFECYCLE_PAYMENT_AUTHORIZER, PURCHASE_LIFECYCLE_PAYMENT_CONTROLLERS, PURCHASE_LIFECYCLE_PAYMENT_PROVIDERS, PURCHASE_LIFECYCLE_PAYMENT_RECORD_SOURCE, PURCHASE_LIFECYCLE_PROCESSING_PORT } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment.providers';

jest.mock('../../server/common/config/external-services.config',()=>({...jest.requireActual('../../server/common/config/external-services.config'),readEnv:(key:string,aliases:string[]=[])=>[key,...aliases].map(name=>process.env[name]||'').find(Boolean)||''}));

describe('payment providers with actual Nest DI and signed session guard',()=>{
  const appId='cli_payment_di',openId='ou_payment_owner',csrf='a'.repeat(43),selector={approvalBatchId:'purchase-application-di',executionRecordId:'rec_di',generation:1};
  let folder:string,environment:NodeJS.ProcessEnv,store:PurchaseWorkflowStore,configuration:AccessConfigurationService,session:UnifiedAccessService,token:string,modules:TestingModule[];
  const http={axiosRef:{get:jest.fn(),post:jest.fn(),put:jest.fn()}},gateway={getExecutionRecordAsApp:jest.fn(),getLifecycleExecutionRecordsAsApp:jest.fn(),prepareManagerComparisonBatchEvidence:jest.fn()};
  beforeEach(async()=>{
    environment=process.env;process.env={SystemRoot:environment.SystemRoot,TEMP:environment.TEMP,TMP:environment.TMP};modules=[];
    folder=await mkdtemp(join(tmpdir(),'nt-payment-di-'));
    Object.assign(process.env,{FEISHU_APP_ID:appId,FEISHU_PURCHASE_INVENTORY_APP_TOKEN:'synthetic_base',FEISHU_PURCHASE_EXECUTION_TABLE_ID:'tbl_synthetic',PUBLIC_BASE_URL:'https://www.sm.sjhl.online:3001',LOCAL_ACCESS_CONTROL_ENABLED:'true',LOCAL_ACCESS_SESSION_SECRET:Buffer.alloc(32,51).toString('base64'),ACCESS_CONFIGURATION_FILE:join(folder,'access.json')});
    const hash=createHash('sha256').update(appId+'\0'+openId).digest('hex'),id=`feishu-${hash}`;
    const accounts:Record<string,stores.StoredAccount>={[id]:{id,kind:'feishu',name:'合成付款人',role:'purchase_admin',building:null,enabled:true,deleted:false,version:1,source:'configuration',appId,openId,identityHash:hash}};
    const configStore=new stores.AccessConfigurationStore(process.env.ACCESS_CONFIGURATION_FILE!);
    jest.spyOn(stores,'getAccessConfigurationStore').mockReturnValue(configStore);jest.spyOn(defaults,'defaultAccessAccounts').mockImplementation(()=>structuredClone(accounts));
    await configStore.mutate(0,`seed-${randomUUID()}`,'test',state=>{state.accounts=structuredClone(accounts);migrateAuthorizationState(state,accounts);});
    configuration=new AccessConfigurationService();session=new UnifiedAccessService(configuration);
    token=session.issueTrustedSession(configuration.currentPrincipal(id,1)! as never,Date.now()).token;
    store=new PurchaseWorkflowStore(join(folder,'ledger.json'));
    for(const fn of [...Object.values(http.axiosRef),...Object.values(gateway)])fn.mockReset().mockImplementation(()=>{throw Error('No outbound call allowed in DI test');});
  });
  afterEach(async()=>{for(const module of modules.reverse())await module.close();await store?.onModuleDestroy();jest.restoreAllMocks();process.env=environment;await rm(folder,{recursive:true,force:true});});
  async function boot(processing?:{isProcessing():unknown}) {
    const module=await Test.createTestingModule({controllers:PURCHASE_LIFECYCLE_PAYMENT_CONTROLLERS,providers:[
      {provide:PurchaseWorkflowStore,useValue:store},{provide:PurchaseWorkflowGateway,useValue:gateway},{provide:HttpService,useValue:http},
      {provide:AccessConfigurationService,useValue:configuration},{provide:UnifiedAccessService,useValue:session},
      ...(processing?[{provide:PURCHASE_LIFECYCLE_PROCESSING_PORT,useValue:processing}]:[]),...PURCHASE_LIFECYCLE_PAYMENT_PROVIDERS,
    ]}).compile();modules.push(module);await module.init();return module;
  }
  const request=()=>({headers:{origin:'https://www.sm.sjhl.online:3001','sec-fetch-site':'same-origin','x-suda-csrf-token':csrf,cookie:`${session.cookieName}=${encodeURIComponent(token)}; __Host-suda-csrf-token=${csrf}`}});
  const context=(method:Function,req:any)=>({getHandler:()=>method,switchToHttp:()=>({getRequest:()=>req})}) as never;
  it('constructs real adapters without external I/O and leaves new uploads closed when the runtime port is missing',async()=>{
    const module=await boot();
    expect(module.get(PURCHASE_LIFECYCLE_PAYMENT_RECORD_SOURCE)).toBeInstanceOf(PurchaseLifecycleGatewayRecordSource);
    expect(module.get(PURCHASE_LIFECYCLE_PAYMENT_AUTHORIZER)).toBeInstanceOf(PurchaseLifecycleServerAuthorizer);
    expect(module.get(LIFECYCLE_PAYMENT_UPLOAD_STORE)).toBeInstanceOf(LifecyclePaymentUploadStoreAdapter);
    expect(module.get(LIFECYCLE_PAYMENT_PER_FILE_STORE)).toBeInstanceOf(LifecyclePaymentPerFileStoreAdapter);
    expect(module.get(LIFECYCLE_PAYMENT_UPLOAD_GATEWAY)).toBeInstanceOf(LifecyclePaymentPerFileGatewayAdapter);
    expect(module.get(LIFECYCLE_PAYMENT_UPLOAD_READINESS).isReady()).toBe(false);
    const access=jest.spyOn(module.get(LifecyclePaymentUploadSessionAccess),'resolve');
    expect(()=>module.get(LifecyclePaymentUploadSessionGuard).canActivate(context(LifecyclePaymentUploadIsolatedController.prototype.upload,request()))).toThrow('尚未接入');
    expect(access).not.toHaveBeenCalled();for(const fn of [...Object.values(http.axiosRef),...Object.values(gateway)])expect(fn).not.toHaveBeenCalled();
  });
  it('selects real recovery handler metadata and verifies the actual signed session while admission is closed',async()=>{
    const module=await boot(),guard=module.get(LifecyclePaymentUploadSessionGuard),controller=module.get(LifecyclePaymentUploadIsolatedController);
    const status=jest.spyOn(store,'lifecyclePaymentUploadStatus').mockImplementation(async identity=>{identity.assertCurrent();return {state:'not_found'};});
    const cancel=jest.spyOn(store,'cancelUnsentLifecyclePaymentUpload').mockImplementation(async identity=>{identity.assertCurrent();return {state:'cancelled'};});
    const req:any=request();expect(guard.canActivate(context(LifecyclePaymentUploadIsolatedController.prototype.status,req))).toBe(true);
    expect(req.lifecyclePaymentIdentity.openId).toBe(openId);
    expect(await controller.status(req,{...selector,requestId:randomUUID()})).toEqual({state:'not_found'});expect(status).toHaveBeenCalledTimes(1);
    expect(guard.canActivate(context(LifecyclePaymentUploadIsolatedController.prototype.cancel,req))).toBe(true);
    expect(await controller.cancel(req,{...selector,requestId:randomUUID()})).toEqual({state:'cancelled'});expect(cancel).toHaveBeenCalledTimes(1);
    const bad=request();bad.headers.cookie=`${session.cookieName}=invalid; __Host-suda-csrf-token=${csrf}`;
    expect(()=>guard.canActivate(context(LifecyclePaymentUploadIsolatedController.prototype.status,bad))).toThrow();
    expect(()=>guard.canActivate(context(LifecyclePaymentUploadIsolatedController.prototype.upload,{...req,url:'/status'}))).toThrow('尚未接入');
  });
  it('tracks the actual processing port, rejecting false, errors and asynchronous lookalikes',async()=>{
    let active:any=true;const module=await boot({isProcessing:()=>{if(active==='throw')throw Error('not ready');return active;}});
    const readiness=module.get(LIFECYCLE_PAYMENT_UPLOAD_READINESS),service=module.get(LifecyclePaymentUploadIsolatedService);
    expect(readiness.isReady()).toBe(true);expect(()=>service.assertAvailable()).not.toThrow();
    for(const value of [false,'true','throw',Promise.resolve(true),Promise.reject(Error('ignored rejection'))]){active=value;expect(readiness.isReady()).toBe(false);expect(()=>service.assertAvailable()).toThrow();}
    expect(()=>service.assertRecoveryAvailable()).not.toThrow();
  });
});
