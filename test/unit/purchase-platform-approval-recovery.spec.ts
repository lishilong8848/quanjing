// Business isolation tests run after release activation. Release gating is tested separately.
jest.mock('../../server/common/hotfix-runtime-activation', () => ({
  currentHotfixActivation: () => ({ isAcceptingNewWork: () => true }),
  runHotfixInitialization: (_owner: object, initialize: () => unknown) => initialize(),
  cancelHotfixInitialization: async () => {},
}));
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PurchasePlatformApprovalRuntime } from '../../server/modules/purchase-inventory/purchase-platform-approval-runtime';

describe('platform approval isolated recovery scheduler', () => {
  let dir: string, path: string, store: PurchaseWorkflowStore;
  const fingerprint = 'a'.repeat(64);
  const identity: any = { source:'platform',actorAccountId:'person',actorAuthorizationVersion:1,actorDisplayName:'合成人员',subjectAccountId:'person',subjectAuthorizationVersion:1,subjectDisplayName:'合成人员',sessionFamilyFingerprint:'x'.repeat(43),expiresAt:Date.now()+60_000 };
  const pending = () => ({recordId:'rec_synthetic',status:'未开始（待审批）',approvalCompleted:false,building:'C楼',specialty:'电气',purchaseMethod:'综合采购',requesterOpenId:'ou_requester',approvalBatchId:'',approvalActionId:''});
  beforeEach(async () => { dir=await mkdtemp(join(tmpdir(),'purchase-recovery-'));path=join(dir,'ledger.json');store=new PurchaseWorkflowStore(path);await store.onModuleInit();await store.recordReminder('fixture'); });
  afterEach(async () => { await store.onModuleDestroy();await rm(dir,{recursive:true,force:true}); });
  async function restart() { await store.onModuleDestroy();store=new PurchaseWorkflowStore(path);await store.onModuleInit(); }
  async function claim() { return store.claimPlatformLegacyApproval({record:pending(),requestId:'synthetic_request_123456789',decision:'rejected',identity,appId:'cli_test',sourceFingerprint:fingerprint},()=>true); }
  it('restarts and processes a queued task without a user status request',async()=>{
    const result=await claim();await restart();let current:any=pending();
    const source:any={sourceIdentity:()=>({appId:'cli_test',sourceFingerprint:fingerprint}),verifyMarker:jest.fn(async()=>{}),readSnapshot:jest.fn(async()=>({record:{...current},markerPresent:true})),writeDecision:jest.fn(async(_id:string,patch:any)=>{current={...current,status:patch['采购流程'],purchaseMethod:patch['1️⃣物品采购方式'],approvalActionId:patch['采购审批动作标识']};})};
    const runtime=new PurchasePlatformApprovalRuntime(store,source);await runtime.runRecoveryOnce();
    expect(source.writeDecision).toHaveBeenCalledTimes(1);
    expect((await store.leasePlatformLegacyApproval(result.entry.eventId))?.kind).toBe('done');
    await runtime.runRecoveryOnce();expect(source.writeDecision).toHaveBeenCalledTimes(1);
  });
  it('only reads back an uncertain dispatched write after restart',async()=>{
    const result=await claim();let current:any=pending();
    const source:any={sourceIdentity:()=>({appId:'cli_test',sourceFingerprint:fingerprint}),verifyMarker:jest.fn(async()=>{}),readSnapshot:jest.fn(async()=>({record:{...current},markerPresent:true})),writeDecision:jest.fn(async(_id:string,patch:any)=>{current={...current,status:patch['采购流程'],purchaseMethod:patch['1️⃣物品采购方式'],approvalActionId:patch['采购审批动作标识']};throw Error('synthetic response lost');})};
    await new PurchasePlatformApprovalRuntime(store,source).runRecoveryOnce();await restart();
    await new PurchasePlatformApprovalRuntime(store,source).runRecoveryOnce();
    expect(source.writeDecision).toHaveBeenCalledTimes(1);
    expect((await store.leasePlatformLegacyApproval(result.entry.eventId))?.kind).toBe('done');
  });
  it('recovers an expired lease that never reached the dispatch fence',async()=>{
    const result=await claim();const leased=await store.leasePlatformLegacyApproval(result.entry.eventId);expect(leased?.kind).toBe('dispatch');
    await restart();let current:any=pending();
    const source:any={sourceIdentity:()=>({appId:'cli_test',sourceFingerprint:fingerprint}),verifyMarker:jest.fn(async()=>{}),readSnapshot:jest.fn(async()=>({record:{...current},markerPresent:true})),writeDecision:jest.fn(async(_id:string,patch:any)=>{current={...current,status:patch['采购流程'],purchaseMethod:patch['1️⃣物品采购方式'],approvalActionId:patch['采购审批动作标识']};})};
    const runtime=new PurchasePlatformApprovalRuntime(store,source);
    await runtime.runRecoveryOnce();expect(source.writeDecision).not.toHaveBeenCalled();
    const clock=jest.spyOn(Date,'now').mockReturnValue(leased!.entry.leaseUntilMs!+1);
    try { await runtime.runRecoveryOnce();expect(source.writeDecision).toHaveBeenCalledTimes(1);expect((await store.leasePlatformLegacyApproval(result.entry.eventId))?.kind).toBe('done'); }
    finally { clock.mockRestore(); }
  });
  it('does not enable the scheduler by default',()=>{
    const runtime=new PurchasePlatformApprovalRuntime(store,{} as never);const start=jest.spyOn(runtime,'startRecovery');runtime.onApplicationBootstrap();expect(start).not.toHaveBeenCalled();runtime.onModuleDestroy();
  });
  it('starts automatically only when explicitly enabled and stops future scans',async()=>{
    jest.useFakeTimers();
    try {
      const runtime=new PurchasePlatformApprovalRuntime(store,{} as never,{enabled:true,intervalMs:1000});
      const scan=jest.spyOn(runtime,'runRecoveryOnce').mockResolvedValue();
      runtime.onApplicationBootstrap();await jest.advanceTimersByTimeAsync(0);expect(scan).toHaveBeenCalledTimes(1);
      runtime.onModuleDestroy();await jest.advanceTimersByTimeAsync(3000);expect(scan).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
  });
  it('does not revive an old timer when stopped and restarted during a scan',async()=>{
    jest.useFakeTimers();
    try {
      const runtime=new PurchasePlatformApprovalRuntime(store,{} as never);
      let finish!: () => void;
      const scan=jest.spyOn(runtime,'runRecoveryOnce').mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;})).mockResolvedValue();
      runtime.startRecovery(1000);await jest.advanceTimersByTimeAsync(0);expect(scan).toHaveBeenCalledTimes(1);
      runtime.stopRecovery();runtime.startRecovery(1000);await jest.advanceTimersByTimeAsync(0);expect(scan).toHaveBeenCalledTimes(2);
      finish();await Promise.resolve();await jest.advanceTimersByTimeAsync(1000);expect(scan).toHaveBeenCalledTimes(3);
      runtime.stopRecovery();
    } finally { jest.useRealTimers(); }
  });
  it('stops starting further jobs after the recovery run is stopped',async()=>{
    const ids=['platform_'+'a'.repeat(32),'platform_'+'b'.repeat(32)];
    const runtime=new PurchasePlatformApprovalRuntime({listRecoverablePlatformLegacyApprovals:async()=>ids} as never,{} as never);
    let active=true;
    const run=jest.spyOn((runtime as any).worker,'run').mockImplementation(async()=>{active=false;return 'completed';});
    await runtime.runRecoveryOnce(()=>active);
    expect(run).toHaveBeenCalledTimes(1);expect(run).toHaveBeenCalledWith(ids[0]);
  });
});
