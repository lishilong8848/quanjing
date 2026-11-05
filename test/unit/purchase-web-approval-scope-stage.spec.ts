import { ForbiddenException } from '@nestjs/common';
jest.mock('../../server/common/hotfix-runtime-activation',()=>({currentHotfixActivation:()=>({isAcceptingNewWork:()=>true}),runHotfixInitialization:(_owner:object,start:()=>unknown)=>start(),cancelHotfixInitialization:async()=>{}}));
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { PurchaseWorkflowRecord, PurchaseWorkflowUser } from '../../shared/purchase-workflow.interface';
import { businessAuthorizationSnapshot } from '../../shared/business-permissions';
import { PurchaseWorkflowService, type PurchaseWorkflowSession } from '../../server/modules/purchase-inventory/purchase-workflow.service';
import { PurchaseOnlineApprovalService } from '../../server/modules/purchase-inventory/purchase-online-approval.service';
import * as configuration from '../../server/common/config/external-services.config';
import { createPurchasePlatformIdentityVerifier } from '../../server/modules/purchase-inventory/purchase-platform-identity-proof';
import { PurchasePlatformApprovalRuntime } from '../../server/modules/purchase-inventory/purchase-platform-approval-runtime';

const principal: AccessPrincipal = { role: 'guest', purchaseBuilding: null, accountId: 'person-c', authorizationVersion: 3,
  permissionContext: { module: 'purchase', action: 'approve' },
  effectiveAuthorization: { mode: 'independent', baseline: { nativeRole: null, pages: [], rules: [
    { id: 'purchase-c', module: 'purchase', effect: 'allow', actions: ['approve', 'order'], buildings: ['C楼'], specialties: ['电气'] },
  ] }, overrides: { rules: [], allowPages: [], denyPages: [] } } };
const item = (changes: Partial<PurchaseWorkflowRecord> = {}): PurchaseWorkflowRecord => ({ recordId: 'recFake', requestCode: 'FAKE', status: '未开始（待审批）', itemName: '合成物品', building: 'C楼', specialty: '电气', requesterOpenId: 'ou_requester', requesterName: '申请人', purchaserOpenId: 'ou_purchaser', purchaserName: '采购人', purchaseMethod: '综合采购', requestedQuantity: 1, actualQuantity: null, actualAmount: null, approvalCompleted: false, warehouseConfirmed: false, purchaseCompleted: false, receiptConfirmed: false, signer: '', receiptTime: null, receiptPhotoTokens: [], invoiceTokens: [], ...changes });
const actor: PurchaseWorkflowUser = { openId: 'ou_actor', name: '合成主管', positions: [], buildings: ['C楼'] };

describe('web procurement approval stage, personal range and real duty', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.spyOn(configuration, 'readEnv').mockImplementation(name => name === 'FEISHU_APP_ID' ? 'cli_scope_test' : name === 'PURCHASE_MANAGER_APPROVAL_CARD_ENABLED' ? 'true' : ''); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });
  function fixture(initial: PurchaseWorkflowRecord, roster = ['ou_actor']) {
    let current = initial;
    const gateway = {
      getExecutionRecord: jest.fn(async () => structuredClone(current)),
      getExecutionRecordAsApp: jest.fn(async () => structuredClone(current)),
      resolveUser: jest.fn(async () => actor),
      updateExecutionRecordAsApp: jest.fn(async () => { current = { ...current, status: '审批通过（待下单）', approvalCompleted: true }; }),
    };
    const access = { currentPrincipal: jest.fn(() => businessAuthorizationSnapshot(principal)), currentDutyRoutePeople: jest.fn(() => roster.map(openId => ({ openId }))) };
    const workflow = new PurchaseWorkflowService(gateway as never, {} as never, undefined, access as never);
    const verifier=createPurchasePlatformIdentityVerifier({readSignedSession:()=>({principal,principalFingerprint:'x'.repeat(43),expiresAt:Date.now()+60_000}),snapshot:()=>({appId:'cli_scope_test',accounts:[{id:'person-c',kind:'feishu',name:'合成主管',role:'guest',building:null,enabled:true,deleted:false,version:3,source:'configuration',appId:'cli_scope_test',openId:'ou_actor'}]}),currentPrincipal:()=>principal});
    const proof=verifier.verify('synthetic-session');
    const claim=jest.fn(async(input:any,authorize:any)=>{authorize(input.identity,input.record,'new',input.appId,input.sourceFingerprint);return {kind:'claim',entry:{eventId:'platform_scope_test'}};});
    const source={sourceIdentity:()=>({appId:'cli_scope_test',sourceFingerprint:'a'.repeat(64)}),verifyMarker:async()=>{},readSnapshot:async()=>({record:current,markerPresent:true}),writeDecision:jest.fn()};
    const runtime=new PurchasePlatformApprovalRuntime({claimPlatformLegacyApproval:claim,leasePlatformLegacyApproval:async()=>null} as never,source);
    const online = new PurchaseOnlineApprovalService(gateway as never, workflow,runtime);
    const session: PurchaseWorkflowSession = { accessToken: 'test', openId: 'ou_actor', userName: '合成主管', accessRole: 'guest', permissionPrincipal: businessAuthorizationSnapshot(principal), authenticationMode: 'delegated-app',platformProof:proof,
      assertPlatformProof:(action,row)=>verifier.assertCurrent(proof,action,row),assertPlatformPermission:(action,scope)=>verifier.assertCurrentPermissionForScope(proof,action,scope) };
    return { online, gateway, session, claim };
  }
  it('accepts a C building pending record with current approval permission even outside the card roster', async () => {
    const f = fixture(item(), []); const task = await f.online.acceptAuthorizedDecision('recFake', { decision: 'approved' }, f.session);
    await jest.runAllTimersAsync();
    expect(task.pending).toBe(true);expect(f.claim).toHaveBeenCalledTimes(1);
    expect(f.gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
  });
  it.each([
    ['already awaiting order', item({ status: '审批通过（待下单）', approvalCompleted: true }), ['ou_actor']],
    ['different building', item({ building: 'H楼' }), ['ou_actor']],
  ] as const)('rejects %s without any write', async (_name, record, roster) => {
    const f = fixture(record, [...roster]);
    await expect(f.online.acceptAuthorizedDecision('recFake', { decision: 'approved' }, f.session)).rejects.toBeInstanceOf(ForbiddenException);
    await jest.runAllTimersAsync(); expect(f.gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
  });
});
