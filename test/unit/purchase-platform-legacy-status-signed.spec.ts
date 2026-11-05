import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { migrateAuthorizationState, reprojectAuthorizationState } from '../../server/common/access/authorization-profile.configuration';
import { hashAccessPassword, UnifiedAccessService } from '../../server/common/access/unified-access.service';
import { createPurchasePlatformIdentityVerifier, type PurchasePlatformIdentityProof } from '../../server/modules/purchase-inventory/purchase-platform-identity-proof';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';
import type { PurchaseAuthorityTarget } from '../../server/modules/purchase-inventory/purchase-authority-target';

describe('旧采购审批状态查询：真实签名会话与临时账本', () => {
  const appId='cli_synthetic_status', first=`local-external-${'c'.repeat(64)}`, second=`local-external-${'d'.repeat(64)}`;
  const sourceFingerprint=createHash('sha256').update(JSON.stringify([appId,'synthetic_base','tbl_test'])).digest('hex');
  const record={recordId:'recStatus',status:'未开始（待审批）',approvalCompleted:false,building:'C楼',specialty:'电气',purchaseMethod:'综合采购' as const,requesterOpenId:'ou_requester',approvalBatchId:'',approvalActionId:''};
  let folder:string, marker:string, environment:NodeJS.ProcessEnv, access:UnifiedAccessService, config:AccessConfigurationService, configStore:stores.AccessConfigurationStore, ledger:PurchaseWorkflowStore;
  let employeeToken:string, otherToken:string, adminToken:string, verifier:ReturnType<typeof createPurchasePlatformIdentityVerifier>;
  beforeEach(async () => {
    environment=process.env; process.env={SystemRoot:environment.SystemRoot,TEMP:environment.TEMP,TMP:environment.TMP};
    folder=mkdtempSync(join(realpathSync(tmpdir()),'nt-status-test-')); marker=randomUUID(); writeFileSync(join(folder,'.owner'),marker,{flag:'wx'});
    process.env.ACCESS_CONFIGURATION_FILE=join(folder,'config.json'); process.env.LOCAL_ACCESS_SESSION_SECRET=Buffer.alloc(32,41).toString('base64'); process.env.LOCAL_ACCESS_CONTROL_ENABLED='true'; process.env.FEISHU_APP_ID=appId;
    const hash=hashAccessPassword('synthetic-only-status-password');
    const accounts:Record<string,stores.StoredAccount>={
      'local-admin-all':{id:'local-admin-all',kind:'local',name:'合成管理员',role:'admin',building:null,enabled:true,deleted:false,version:1,source:'default',passwordHash:hash},
      'local-admin-other':{id:'local-admin-other',kind:'local',name:'另一合成管理员',role:'admin',building:null,enabled:true,deleted:false,version:1,source:'configuration',passwordHash:hash},
      ...Object.fromEntries([first,second].map((id,i)=>[id,{id,kind:'local',name:`合成人员${i}`,role:'purchase_admin',building:null,enabled:true,deleted:false,version:1,source:'configuration',passwordHash:hash,loginMethod:'personnel-password',personnelActive:true,personnelAppId:appId}])) as Record<string,stores.StoredAccount>,
    };
    configStore=new stores.AccessConfigurationStore(process.env.ACCESS_CONFIGURATION_FILE); jest.spyOn(stores,'getAccessConfigurationStore').mockReturnValue(configStore); jest.spyOn(defaults,'defaultAccessAccounts').mockImplementation(()=>structuredClone(accounts));
    await configStore.mutate(0,`seed-${randomUUID()}`,'fixture-only',state=>{state.accounts=structuredClone(accounts);migrateAuthorizationState(state,accounts);});
    config=new AccessConfigurationService(); access=new UnifiedAccessService(config);
    employeeToken=access.issueTrustedSession(config.currentPrincipal(first,1)! as never,Date.now()).token;
    otherToken=access.issueTrustedSession(config.currentPrincipal(second,1)! as never,Date.now()).token;
    adminToken=access.issueTrustedSession(config.currentPrincipal('local-admin-all',1)! as never,Date.now()).token;
    verifier=createPurchasePlatformIdentityVerifier({readSignedSession:(token,now)=>access.readSessionIdentity(token,now),snapshot:()=>config.snapshot(),currentPrincipal:(id,version)=>config.currentPrincipal(id,version)});
    ledger=new PurchaseWorkflowStore(join(folder,'ledger.json')); await ledger.onModuleInit(); await ledger.recordReminder('synthetic-status-test');
  });
  afterEach(async () => {
    await ledger.onModuleDestroy(); jest.restoreAllMocks(); process.env=environment;
    if(dirname(resolve(folder)).toLowerCase()!==realpathSync(tmpdir()).toLowerCase() || !basename(folder).startsWith('nt-status-test-') || readFileSync(join(folder,'.owner'),'utf8')!==marker) throw new Error('Synthetic fixture ownership mismatch');
    rmSync(folder,{recursive:true,force:false});
  });
  const claimAuthorization=(identity:PurchasePlatformIdentityProof,row:typeof record,_mode:'new'|'replay',app:string,source:string)=>{if(app!==appId||source!==sourceFingerprint) throw Error('wrong source');verifier.assertCurrent(identity,'approve',row);return true as const;};
  const readAuthorization=(identity:PurchasePlatformIdentityProof,target:PurchaseAuthorityTarget,app:string)=>{if(app!==appId) throw Error('wrong app');verifier.assertCurrentPermissionForScope(identity,'approve',target);return true as const;};
  async function create(token:string) {
    return ledger.claimPlatformLegacyApproval({appId,sourceFingerprint,record,requestId:'request_status_123456',decision:'rejected',identity:verifier.verify(token)},claimAuthorization);
  }
  async function status(token:string,eventId:string,app=appId) {
    return ledger.getPlatformLegacyApprovalStatus({appId:app,eventId,identity:verifier.verify(token)},readAuthorization);
  }
  it('本人可查询且不暴露身份、卡片或敏感凭据；重启和并发读取不改变结果', async () => {
    const claim=await create(employeeToken), before=readFileSync(join(folder,'ledger.json'),'utf8');
    const results=await Promise.all(Array.from({length:5},()=>status(employeeToken,claim.entry.eventId)));
    expect(results).toEqual(Array(5).fill({recordId:record.recordId,decision:'rejected',status:'pending',acceptedAtMs:claim.entry.acceptedAtMs}));
    expect(readFileSync(join(folder,'ledger.json'),'utf8')).toBe(before);
    await ledger.onModuleDestroy(); ledger=new PurchaseWorkflowStore(join(folder,'ledger.json')); await ledger.onModuleInit();
    expect(await status(employeeToken,claim.entry.eventId)).toEqual(results[0]);
    const json=JSON.stringify(results); expect(json).not.toContain(employeeToken);expect(json).not.toContain('ou_requester');expect(json).not.toContain(first);expect(json).not.toContain(claim.entry.serverActionId);
  });
  it('其他账号、跨应用及不存在任务均不能读取', async () => {
    const claim=await create(employeeToken);
    await expect(status(otherToken,claim.entry.eventId)).rejects.toThrow();
    await expect(status(employeeToken,claim.entry.eventId,'cli_other')).rejects.toThrow();
    await expect(status(employeeToken,'platform_request_missing_1234')).rejects.toThrow();
  });
  it('代登录只允许原管理员与目标账号同一组合查询', async () => {
    const delegation=await access.startImpersonation(adminToken,{accountId:first,clientMutationId:`delegate-${randomUUID()}`},Date.now());
    const claim=await create(delegation.token);
    expect(await status(delegation.token,claim.entry.eventId)).toMatchObject({status:'pending'});
    await expect(status(employeeToken,claim.entry.eventId)).rejects.toThrow();
    const secondDelegation=await access.startImpersonation(adminToken,{accountId:second,clientMutationId:`delegate-${randomUUID()}`},Date.now());
    await expect(status(secondDelegation.token,claim.entry.eventId)).rejects.toThrow();
    const otherAdmin=access.issueTrustedSession(config.currentPrincipal('local-admin-other',1)! as never,Date.now()).token;
    const otherActor=await access.startImpersonation(otherAdmin,{accountId:first,clientMutationId:`delegate-${randomUUID()}`},Date.now());
    await expect(status(otherActor.token,claim.entry.eventId)).rejects.toThrow();
  });
  it('序列化伪造的证明不能通过当前会话校验', async () => {
    const claim=await create(employeeToken), forged=JSON.parse(JSON.stringify(verifier.verify(employeeToken)));
    await expect(ledger.getPlatformLegacyApprovalStatus({appId,eventId:claim.entry.eventId,identity:forged},readAuthorization)).rejects.toThrow();
  });
  it('停用或撤销权限后不可查，但查询失败不撤销已受理任务', async () => {
    const claim=await create(employeeToken), before=readFileSync(join(folder,'ledger.json'),'utf8');
    await configStore.mutate(configStore.read().revision,`disable-${randomUUID()}`,'fixture-only',state=>{state.accounts[first]!.enabled=false;state.accounts[first]!.version++;});
    await expect(status(employeeToken,claim.entry.eventId)).rejects.toThrow();
    expect(readFileSync(join(folder,'ledger.json'),'utf8')).toBe(before);
    expect((await ledger.leasePlatformLegacyApproval(claim.entry.eventId))?.kind).toBe('dispatch');
  });
  it('当前个人审批权限撤销后，即使重新登录也不能查询旧任务', async () => {
    const claim=await create(employeeToken), before=readFileSync(join(folder,'ledger.json'),'utf8');
    await configStore.mutate(configStore.read().revision,`revoke-${randomUUID()}`,'fixture-only',state=>{
      const account=state.accounts[first]!;
      account.authorizationOverrides!.rules.push({id:'deny-approval-now',module:'purchase',effect:'deny',actions:['approve'],buildings:['C楼'],specialties:['电气']});
      account.version++; reprojectAuthorizationState(state);
    });
    const refreshed=access.issueTrustedSession(config.currentPrincipal(first,2)! as never,Date.now()).token;
    await expect(status(refreshed,claim.entry.eventId)).rejects.toThrow();
    expect(readFileSync(join(folder,'ledger.json'),'utf8')).toBe(before);
  });
  it('受理后状态变化可查询，查询不要求仍处于待审批', async () => {
    const claim=await create(employeeToken), lease=(await ledger.leasePlatformLegacyApproval(claim.entry.eventId))!;
    await ledger.beginPlatformLegacyApprovalDispatch(claim.entry.eventId,lease.token,record as PurchaseWorkflowRecord,true);
    expect(await status(employeeToken,claim.entry.eventId)).toMatchObject({status:'running'});
    await ledger.confirmPlatformLegacyApproval(claim.entry.eventId,lease.token,{...record,status:'驳回申请',purchaseMethod:'驳回',approvalActionId:claim.entry.serverActionId} as PurchaseWorkflowRecord,true);
    await ledger.completePlatformLegacyApproval(claim.entry.eventId,lease.token);
    expect(await status(employeeToken,claim.entry.eventId)).toMatchObject({status:'completed'});
  });
  it('并发查询和完成只返回一致的前后状态，不会丢失已受理结果', async () => {
    const claim=await create(employeeToken), lease=(await ledger.leasePlatformLegacyApproval(claim.entry.eventId))!;
    await ledger.beginPlatformLegacyApprovalDispatch(claim.entry.eventId,lease.token,record as PurchaseWorkflowRecord,true);
    await ledger.confirmPlatformLegacyApproval(claim.entry.eventId,lease.token,{...record,status:'驳回申请',purchaseMethod:'驳回',approvalActionId:claim.entry.serverActionId} as PurchaseWorkflowRecord,true);
    const [before,,after]=await Promise.all([status(employeeToken,claim.entry.eventId),ledger.completePlatformLegacyApproval(claim.entry.eventId,lease.token),status(employeeToken,claim.entry.eventId)]);
    expect(['running','completed']).toContain(before.status); expect(['running','completed']).toContain(after.status);
    expect((await status(employeeToken,claim.entry.eventId)).status).toBe('completed');
  });
});

