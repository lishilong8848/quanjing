import type { AccessPrincipal } from '../../shared/access-control.interface';
import { canCheckPurchaseWorkflowActions, verifiedPurchaseWorkflowActions } from '../../client/src/pages/PurchaseInventoryManagement/purchase-workflow-action.logic';

function actor(building: string, action: 'order' | 'read' | 'approve' | 'create' | 'receive'): AccessPrincipal {
  return { role: 'guest', purchaseBuilding: null, accountId: 'synthetic-user', authorizationVersion: 1,
    effectiveAuthorization: { mode: 'independent', baseline: { nativeRole: null, pages: [], rules: [{ id: 'scope', module: 'purchase', actions: [action], effect: 'allow', buildings: [building], specialties: ['电气'] }] }, overrides: { rules: [], allowPages: [], denyPages: [] } } };
}
const detail = { record: { recordId: 'rec-test', building: 'C楼', specialty: '电气' }, allowedActions: ['order' as const] };

describe('purchase detail actions use current server confirmation', () => {
  it('uses the current server detail rather than a stale cached list stage, while preserving pending-sync protection', () => {
    const staleListItem={executionRecordId:'rec-test',stage:'completed',pendingSync:false};
    expect(canCheckPurchaseWorkflowActions(staleListItem)).toBe(true);
    expect(verifiedPurchaseWorkflowActions(actor('C楼','order'),detail,'rec-test','session-1','session-1',false,canCheckPurchaseWorkflowActions(staleListItem))).toEqual(['order']);
    expect(canCheckPurchaseWorkflowActions({...staleListItem,pendingSync:true})).toBe(false);
    expect(canCheckPurchaseWorkflowActions({...staleListItem,executionRecordId:null})).toBe(false);
    expect(canCheckPurchaseWorkflowActions(null)).toBe(false);
  });
  it('allows the authorized C-building user only when the server offers the current order action', () => {
    expect(verifiedPurchaseWorkflowActions(actor('C楼', 'order'), detail, 'rec-test', 'session-1', 'session-1', false, true)).toEqual(['order']);
    expect(verifiedPurchaseWorkflowActions(actor('A楼', 'order'), detail, 'rec-test', 'session-1', 'session-1', false, true)).toEqual([]);
    expect(verifiedPurchaseWorkflowActions(actor('C楼', 'read'), detail, 'rec-test', 'session-1', 'session-1', false, true)).toEqual([]);
    expect(verifiedPurchaseWorkflowActions(actor('C楼', 'order'), { ...detail, allowedActions: [] }, 'rec-test', 'session-1', 'session-1', false, true)).toEqual([]);
  });
  it('never treats preview, failed or stale detail, a different record or pending refresh as authority', () => {
    const user = actor('C楼', 'order');
    for (const [recordId, verified, current, loading, canOperate] of [
      ['rec-test', '', 'session-1', false, true], ['rec-test', 'session-1', 'session-2', false, true],
      ['rec-other', 'session-1', 'session-1', false, true], ['rec-test', 'session-1', 'session-1', true, true],
      ['rec-test', 'session-1', 'session-1', false, false],
    ] as const) expect(verifiedPurchaseWorkflowActions(user, detail, recordId, verified, current, loading, canOperate)).toEqual([]);
    expect(verifiedPurchaseWorkflowActions(user, null, 'rec-test', 'session-1', 'session-1', false, true)).toEqual([]);
  });
  it.each([['approve', 'approve'], ['start', 'create'], ['receive', 'receive']] as const)('requires current server and scope authorization for %s', (offered, permission) => {
    const stageDetail = { ...detail, allowedActions: [offered] };
    expect(verifiedPurchaseWorkflowActions(actor('C楼', permission), stageDetail, 'rec-test', 'session-1', 'session-1', false, true)).toEqual([offered]);
    expect(verifiedPurchaseWorkflowActions(actor('A楼', permission), stageDetail, 'rec-test', 'session-1', 'session-1', false, true)).toEqual([]);
    expect(verifiedPurchaseWorkflowActions(actor('C楼', 'read'), stageDetail, 'rec-test', 'session-1', 'session-1', false, true)).toEqual([]);
    expect(verifiedPurchaseWorkflowActions(actor('C楼', permission), { ...stageDetail, allowedActions: [] }, 'rec-test', 'session-1', 'session-1', false, true)).toEqual([]);
  });
});
