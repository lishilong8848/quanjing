import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { migrateAuthorizationState } from '../../server/common/access/authorization-profile.configuration';
import { hashAccessPassword, UnifiedAccessService } from '../../server/common/access/unified-access.service';
import { PurchasePlatformSessionBinding } from '../../server/modules/purchase-inventory/purchase-platform-session-binding';
import { createPurchasePlatformIdentityVerifier } from '../../server/modules/purchase-inventory/purchase-platform-identity-proof';
import { resolvePurchaseWorkflowSession } from '../../server/modules/purchase-inventory/purchase-workflow-session';
import { PurchaseWorkflowService } from '../../server/modules/purchase-inventory/purchase-workflow.service';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

/** Real signed sessions with a synthetic app, local configuration and local ledger. */
describe('platform procurement: native account and trusted delegation', () => {
  const appId='cli_native_test', personId=`local-external-${'a'.repeat(64)}`;
  let directory:string, marker:string, savedEnv:NodeJS.ProcessEnv, configStore:stores.AccessConfigurationStore, config:AccessConfigurationService, access:UnifiedAccessService, binding:PurchasePlatformSessionBinding, ledger:PurchaseWorkflowStore, personToken:string, adminToken:string;
  beforeEach(async()=>{
    savedEnv=process.env; process.env={SystemRoot:savedEnv.SystemRoot,TEMP:savedEnv.TEMP,TMP:savedEnv.TMP};
    directory=mkdtempSync(join(realpathSync(tmpdir()),'native-identity-test-'));marker=randomUUID();writeFileSync(join(directory,'.owner'),marker,{flag:'wx'});
    process.env.ACCESS_CONFIGURATION_FILE=join(directory,'config.json');process.env.FEISHU_APP_ID=appId;process.env.LOCAL_ACCESS_SESSION_SECRET=Buffer.alloc(32,37).toString('base64');process.env.LOCAL_ACCESS_CONTROL_ENABLED='true';
    const hash=hashAccessPassword('synthetic-only-native-test');
    const accounts:Record<string,stores.StoredAccount>={
      'local-admin-all':{id:'local-admin-all',kind:'local',name:'合成管理员',role:'admin',building:null,enabled:true,deleted:false,version:1,source:'default',passwordHash:hash},
      [personId]:{id:personId,kind:'local',name:'合成姓名人员',role:'purchase_admin',building:null,enabled:true,deleted:false,version:1,source:'configuration',passwordHash:hash,loginMethod:'personnel-password',personnelActive:true,personnelAppId:appId,personalRules:[{id:'deny-a-order',module:'purchase',effect:'deny',actions:['order'],buildings:['A楼'],specialties:null}]},
    };
    configStore=new stores.AccessConfigurationStore(process.env.ACCESS_CONFIGURATION_FILE);jest.spyOn(stores,'getAccessConfigurationStore').mockReturnValue(configStore);jest.spyOn(defaults,'defaultAccessAccounts').mockImplementation(()=>structuredClone(accounts));
    await configStore.mutate(0,`seed-${randomUUID()}`,'fixture-only',state=>{state.accounts=structuredClone(accounts);migrateAuthorizationState(state,accounts);});
    config=new AccessConfigurationService();access=new UnifiedAccessService(config);binding=new PurchasePlatformSessionBinding(access,config);
    personToken=access.issueTrustedSession(config.currentPrincipal(personId,1)! as never,Date.now()).token;
    adminToken=access.issueTrustedSession(config.currentPrincipal('local-admin-all',1)! as never,Date.now()).token;
    ledger=new PurchaseWorkflowStore(join(directory,'ledger.json'));await ledger.onModuleInit();
  });
  afterEach(async()=>{
    await ledger.onModuleDestroy();jest.restoreAllMocks();process.env=savedEnv;
    if(dirname(resolve(directory)).toLowerCase()!==realpathSync(tmpdir()).toLowerCase()||!basename(directory).startsWith('native-identity-test-')||readFileSync(join(directory,'.owner'),'utf8')!==marker)throw Error('Synthetic fixture ownership mismatch');
    rmSync(directory,{recursive:true,force:false});
  });
  function request(token:string){const identity=access.readSessionIdentity(token,Date.now());return {headers:{cookie:`${access.cookieName}=${encodeURIComponent(token)}`},accessPrincipal:{...identity.principal,permissionContext:{module:'purchase',action:'order'}},accessPrincipalFingerprint:identity.principalFingerprint} as never;}
  async function session(token:string){const req:any=request(token), platformIdentity=binding.bind(req);return resolvePurchaseWorkflowSession({principal:req.accessPrincipal,platformIdentity,getTenantAccessToken:async()=>'synthetic-token'});}
  const target={status:'审批通过（待下单）',building:'C楼',specialty:'电气'};
  const record=():PurchaseWorkflowRecord=>({recordId:'recNative',requestCode:'TEST',itemName:'合成物品',...target,requesterOpenId:'ou_requester',requesterName:'申请人',purchaserOpenId:'ou_assigned',purchaserName:'原采购人',purchaseMethod:'综合采购',requestedQuantity:1,actualQuantity:null,actualAmount:null,approvalCompleted:true,warehouseConfirmed:true,purchaseCompleted:false,receiptConfirmed:false,signer:'',receiptTime:null,receiptPhotoTokens:[],invoiceTokens:[]});

  it('无签名证明的姓名账号请求必须拒绝',async()=>{
    const principal=config.currentPrincipal(personId,1)!;
    await expect(resolvePurchaseWorkflowSession({principal,getTenantAccessToken:async()=>'synthetic-token'})).rejects.toThrow();
  });
  it('真实签名的姓名账号可携带可信证明，不虚构飞书身份，仍遵守楼栋权限',async()=>{
    const value=await session(personToken);
    expect(value).toMatchObject({openId:'',platformProof:{actorAccountId:personId,subjectAccountId:personId}});
    expect(()=>value.assertPlatformProof!('order',target)).not.toThrow();
    expect(()=>value.assertPlatformProof!('order',{...target,building:'A楼'})).toThrow();
    expect(JSON.stringify(value.platformProof)).not.toContain(personToken);
  });
  it('真实代登录证明分别保存管理员与目标账号，退出代登录后不能发起新操作',async()=>{
    const delegated=await access.startImpersonation(adminToken,{accountId:personId,clientMutationId:`delegate-${randomUUID()}`},Date.now());
    const value=await session(delegated.token);
    expect(value.platformProof).toMatchObject({source:'impersonation',actorAccountId:'local-admin-all',subjectAccountId:personId});
    expect(()=>value.assertPlatformProof!('order',target)).not.toThrow();
    await access.stopImpersonation(delegated.token,adminToken,`stop-${randomUUID()}`,Date.now());
    expect(()=>value.assertPlatformProof!('order',target)).toThrow();
  });
  it('篡改 cookie 或将证明复制后重放均被拒绝',async()=>{
    const req:any=request(personToken);req.headers.cookie=`${access.cookieName}=${encodeURIComponent(`${personToken}x`)}`;
    expect(()=>binding.bind(req)).toThrow();
    const verifier=createPurchasePlatformIdentityVerifier({readSignedSession:(token,now)=>access.readSessionIdentity(token,now),snapshot:()=>config.snapshot(),currentPrincipal:(id,version)=>config.currentPrincipal(id,version)});
    const proof=verifier.verify(personToken), copied=JSON.parse(JSON.stringify(proof));
    expect(()=>verifier.assertCurrent(proof,'order',target)).not.toThrow();
    expect(()=>verifier.assertCurrent(copied,'order',target)).toThrow();
  });
  it('签名会话过期后不能再生成操作证明',()=>{
    const req=request(personToken), expiry=access.readSessionIdentity(personToken,Date.now()).expiresAt!;
    const clock=jest.spyOn(Date,'now').mockReturnValue(expiry+1);
    try{expect(()=>binding.bind(req)).toThrow();}finally{clock.mockRestore();}
  });
  it('领取任务之前账号被停用时拒绝新操作，不写采购记录',async()=>{
    const value=await session(personToken);
    const gateway={getExecutionRecord:jest.fn(async()=>{await configStore.mutate(configStore.read().revision,`disable-${randomUUID()}`,'fixture-only',state=>{state.accounts[personId]!.enabled=false;state.accounts[personId]!.version++;});return record();}),updateExecutionRecord:jest.fn(async()=>{})};
    const workflow=new PurchaseWorkflowService(gateway as never,ledger,undefined,config);
    try{await expect(workflow.order('recNative',value,{actualQuantity:1,actualAmount:5,paymentAttachmentTokens:[],note:''})).rejects.toThrow();
      expect(await ledger.findCommand('order:recNative')).toBeNull();expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();
    }finally{workflow.onModuleDestroy();}
  });
  it('代登录受理后账本区分真实管理员和授权对象',async()=>{
    const delegated=await access.startImpersonation(adminToken,{accountId:personId,clientMutationId:`delegate-${randomUUID()}`},Date.now()), value=await session(delegated.token);let live=record();
    const gateway={getExecutionRecord:jest.fn(async()=>structuredClone(live)),resolveUser:jest.fn(async()=>{throw Error('不得借用飞书身份');}),updateExecutionRecord:jest.fn(async(_id:string,patch:Record<string,unknown>)=>{live={...live,status:String(patch['采购流程']),actualQuantity:Number(patch['实际采购数量']),actualAmount:Number(patch['实际付款金额']),purchaseCompleted:true};})};
    const workflow=new PurchaseWorkflowService(gateway as never,ledger,undefined,config);
    try{await workflow.order('recNative',value,{actualQuantity:1,actualAmount:5,paymentAttachmentTokens:[],note:''});
      const entry=await ledger.findCommand('order:recNative');expect(entry).toMatchObject({actorOpenId:'',platformIdentity:{source:'impersonation',actorAccountId:'local-admin-all',subjectAccountId:personId}});
      expect(entry?.completedAt).toBeTruthy();expect(readFileSync(join(directory,'ledger.json'),'utf8')).not.toContain(delegated.token);
    }finally{workflow.onModuleDestroy();}
  });
  it('原子受理后权限被撤销，已受理下单继续收尾且账本保留真实账号',async()=>{
    const value=await session(personToken);let live=record();
    const gateway={getExecutionRecord:jest.fn(async()=>structuredClone(live)),resolveUser:jest.fn(async()=>{throw Error('不得借用飞书身份');}),updateExecutionRecord:jest.fn(async(_id:string,patch:Record<string,unknown>)=>{
      await configStore.mutate(configStore.read().revision,`disable-${randomUUID()}`,'fixture-only',state=>{state.accounts[personId]!.enabled=false;state.accounts[personId]!.version++;});
      live={...live,status:String(patch['采购流程']),actualQuantity:Number(patch['实际采购数量']),actualAmount:Number(patch['实际付款金额']),purchaseCompleted:true};
    })};
    const workflow=new PurchaseWorkflowService(gateway as never,ledger,undefined,config);
    try{
      await expect(workflow.order('recNative',value,{actualQuantity:1,actualAmount:5,paymentAttachmentTokens:[],note:''})).resolves.toMatchObject({idempotent:false});
      const entry=await ledger.findCommand('order:recNative');expect(entry).toMatchObject({actorOpenId:'',platformIdentity:{actorAccountId:personId,subjectAccountId:personId}});expect(entry?.completedAt).toBeTruthy();
      expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);expect(gateway.resolveUser).not.toHaveBeenCalled();
      expect(readFileSync(join(directory,'ledger.json'),'utf8')).not.toContain(personToken);
    }finally{workflow.onModuleDestroy();}
  });
  it('无飞书绑定姓名账号下单后真实通知消费者仍发送给原申请人和采购人，不借用身份',async()=>{
    const value=await session(personToken);let live=record();
    const gateway={getExecutionRecord:jest.fn(async()=>structuredClone(live)),resolveUser:jest.fn(async()=>{throw Error('不得借用飞书身份');}),updateExecutionRecord:jest.fn(async(_id:string,patch:Record<string,unknown>)=>{live={...live,status:String(patch['采购流程']),actualQuantity:Number(patch['实际采购数量']),actualAmount:Number(patch['实际付款金额']),purchaseCompleted:true};}),sendIdempotentTextNotification:jest.fn(async(id:string)=>`om_notice_${id}`)};
    const workflow=new PurchaseWorkflowService(gateway as never,ledger,undefined,config);jest.spyOn(workflow,'isEnabled').mockReturnValue(true);
    try {
      await workflow.order('recNative',value,{actualQuantity:1,actualAmount:5,paymentAttachmentTokens:[],note:''});
      const pending=await ledger.listNotifications({recordId:'recNative',kind:'purchase_order_completed'});
      expect(pending.map(row=>row.recipientOpenId).sort()).toEqual(['ou_assigned','ou_requester']);
      const now=new Date(Date.now()+60_000),result={processed:0,failed:0,errors:[]};
      for(let i=0;i<2;i++){const notification=await ledger.takeNextNotification(now,undefined,['purchase_order_completed']);expect(notification).not.toBeNull();expect(await (workflow as any).processNotification(notification,now,result)).toBe(true);}
      expect(gateway.sendIdempotentTextNotification.mock.calls.map(call=>call[0]).sort()).toEqual(['ou_assigned','ou_requester']);
      expect(await ledger.takeNextNotification(now,undefined,['purchase_order_completed'])).toBeNull();
      await workflow.order('recNative',value,{actualQuantity:1,actualAmount:5,paymentAttachmentTokens:[],note:''});
      expect(gateway.sendIdempotentTextNotification).toHaveBeenCalledTimes(2);expect(gateway.resolveUser).not.toHaveBeenCalled();
      expect((await ledger.findCommand('order:recNative'))!).toMatchObject({actorOpenId:'',platformIdentity:{actorAccountId:personId}});
    } finally {workflow.onModuleDestroy();}
  });
});
