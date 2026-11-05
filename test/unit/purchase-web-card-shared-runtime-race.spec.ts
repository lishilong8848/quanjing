// Business isolation tests run after release activation. Release gating is tested separately.
jest.mock('../../server/common/hotfix-runtime-activation', () => ({
  currentHotfixActivation: () => ({ isAcceptingNewWork: () => true }),
  runHotfixInitialization: (_owner: object, initialize: () => unknown) => initialize(),
  cancelHotfixInitialization: async () => {},
}));
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PurchaseOnlineApprovalService } from '../../server/modules/purchase-inventory/purchase-online-approval.service';
import { PurchasePlatformApprovalRuntime } from '../../server/modules/purchase-inventory/purchase-platform-approval-runtime';
import { serializePurchaseManagerApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-approval-card';
import * as config from '../../server/common/config/external-services.config';

it('a card claim during the platform source read prevents the stale platform write in the registered runtime', async () => {
  const folder=await mkdtemp(join(tmpdir(),'purchase-shared-race-'));
  const store=new PurchaseWorkflowStore(join(folder,'ledger.json'));
  const env=jest.spyOn(config,'readEnv').mockImplementation(key=>key==='FEISHU_APP_ID'?'cli_test':'');
  try {
    await store.onModuleInit(); const now=new Date(Date.now()+60_000);
    const cardContext=serializePurchaseManagerApprovalCardContext({executionRecordId:'recFake',requester:'合成申请人',building:'C楼',title:'合成物品',quantity:1});
    await store.enqueueNotification({businessEventId:'synthetic-race',recordId:'recFake',recipientOpenId:'ou_manager',kind:'manager_approval_requested',cardContext});
    const notice=(await store.takeNextManagerApprovalNotification(now))!;
    await store.markManagerApprovalSendStarted(notice.key,notice.claimToken,cardContext,now);
    await store.completeManagerApprovalRequestAndRegisterCard(notice.key,notice.claimToken,{messageId:'om_original'},now);
    let began!:()=>void, release!:()=>void;
    const started=new Promise<void>(resolve=>{began=resolve;}); const permit=new Promise<void>(resolve=>{release=resolve;});
    const source={sourceIdentity:()=>({appId:'cli_test',sourceFingerprint:'a'.repeat(64)}),verifyMarker:async()=>{},
      readSnapshot:async()=>{began();await permit;return {markerPresent:true,record:{recordId:'recFake',status:'未开始（待审批）',building:'C楼',specialty:'电气',purchaseMethod:'综合采购',requesterOpenId:'ou_requester',approvalCompleted:false,approvalBatchId:'',approvalActionId:''}};},writeDecision:jest.fn()};
    const oldWriter={updateExecutionRecordAsApp:jest.fn()};
    const service=new PurchaseOnlineApprovalService(oldWriter as never,undefined,new PurchasePlatformApprovalRuntime(store,source as never));
    const authorize=jest.fn();
    const pending=service.acceptAuthorizedDecision('recFake',{decision:'rejected'},{platformProof:{source:'platform',actorAccountId:'person',actorAuthorizationVersion:1,actorDisplayName:'合成人员',subjectAccountId:'person',subjectAuthorizationVersion:1,subjectDisplayName:'合成人员',sessionFamilyFingerprint:'x'.repeat(43),expiresAt:Date.now()+60_000},assertPlatformProof:authorize,assertPlatformPermission:authorize} as never);
    await started;
    expect((await store.claimManagerApprovalAction({recordId:'recFake',messageId:'om_original',actorOpenId:'ou_manager',eventId:'card-first',choice:'comprehensive',rejectionReason:''},now)).claimed).toBe(true);
    release();await expect(pending).rejects.toThrow('已有审批任务');
    expect(authorize).toHaveBeenCalled();expect(source.writeDecision).not.toHaveBeenCalled();expect(oldWriter.updateExecutionRecordAsApp).not.toHaveBeenCalled();
  } finally {env.mockRestore();await store.onModuleDestroy();await rm(folder,{recursive:true,force:true});}
});
