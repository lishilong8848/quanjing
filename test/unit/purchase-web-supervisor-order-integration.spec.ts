import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { PurchaseWorkflowRecord, PurchaseWorkflowUser } from '../../shared/purchase-workflow.interface';
import { businessAuthorizationSnapshot } from '../../shared/business-permissions';
import { PurchaseWorkflowService, type PurchaseWorkflowSession } from '../../server/modules/purchase-inventory/purchase-workflow.service';

const record = (changes: Partial<PurchaseWorkflowRecord> = {}): PurchaseWorkflowRecord => ({ recordId: 'recDelegate', requestCode: 'SYNTHETIC', status: '审批通过（待下单）', itemName: '合成物品', building: 'C楼', specialty: '电气', requesterOpenId: 'ou_requester', requesterName: '申请人', purchaserOpenId: 'ou_assigned', purchaserName: '原采购人', purchaseMethod: '综合采购', requestedQuantity: 1, actualQuantity: null, actualAmount: null, approvalCompleted: true, warehouseConfirmed: true, purchaseCompleted: false, receiptConfirmed: false, signer: '', receiptTime: null, receiptPhotoTokens: [], invoiceTokens: [], ...changes });
const principal = (): AccessPrincipal => ({ role: 'building_admin', purchaseBuilding: 'C楼', buildings: ['C楼'], accountId: 'local-person-actor', authorizationVersion: 3,
  permissionContext: { module: 'purchase', action: 'order' }, effectiveAuthorization: { mode: 'independent', baseline: { nativeRole: null, pages: [], rules: [
    { id: 'c-building-order', module: 'purchase', effect: 'allow', actions: ['read', 'order'], buildings: ['C楼'], specialties: ['电气'] },
  ] }, overrides: { rules: [], allowPages: [], denyPages: [] } } });
const actor: PurchaseWorkflowUser = { openId: 'ou_actor', name: '合成人员', positions: [], buildings: ['C楼'] };
const input = { actualQuantity: 2, actualAmount: 5, paymentAttachmentTokens: ['file_test'], note: '' };
const defaultAccount = () => ({ id: 'local-person-actor', kind: 'feishu', appId: 'cli_test', openId: 'ou_actor', enabled: true, deleted: false, permissionsRevoked: false, personnelActive: true, reactivationRequired: false, siteMember: true, external: false, personnelIdentity: 'synthetic-personnel-id' });

function fixture(initial = record()) {
  let live = structuredClone(initial), current: AccessPrincipal | undefined = principal(), accounts = [defaultAccount()];
  const gateway = {
    getExecutionRecord: jest.fn(async () => structuredClone(live)), resolveUser: jest.fn(async () => actor),
    updateExecutionRecord: jest.fn(async (_id: string, patch: Record<string, unknown>) => { live = { ...live, status: String(patch['采购流程']), actualQuantity: Number(patch['实际采购数量']), actualAmount: Number(patch['实际付款金额']) }; }),
    sendTextNotification: jest.fn(async () => undefined),
  };
  // Deliberately no approval, purchaser or supervisor roster: these are not web authority prerequisites.
  const access = { currentPrincipal: jest.fn(() => current && businessAuthorizationSnapshot(current)), currentDutyRoutePeople: jest.fn(() => null), snapshot: jest.fn(() => ({ appId: 'cli_test', revision: 1, accounts })) };
  const store = {
    findCommand: jest.fn(async () => undefined),
    claimCommand: jest.fn(async (entry: Record<string, unknown>, guard?: () => void) => { guard?.(); return { claimed: true, entry: { ...entry, completedAt: '', notificationWarnings: [] } }; }),
    recordCommand: jest.fn(async () => undefined), releaseCommandClaim: jest.fn(async () => undefined),
  };
  const service = new PurchaseWorkflowService(gateway as never, store as never, undefined, access as never);
  jest.spyOn(service, 'getDetail').mockResolvedValue({} as never);
  const session: PurchaseWorkflowSession = { accessToken: 'test', openId: actor.openId, userName: actor.name, accessRole: 'building_admin', purchaseBuilding: 'C楼', purchaseBuildings: ['C楼'], permissionPrincipal: businessAuthorizationSnapshot(principal()), authenticationMode: 'delegated-app' };
  return { service, gateway, store, session, getRecord: () => live, setRecord: (next: PurchaseWorkflowRecord) => { live = structuredClone(next); }, setPrincipal: (next: AccessPrincipal) => { current = next; }, setAccounts: (next: typeof accounts) => { accounts = next; }, revoke: () => { current = undefined; }, removeOrder: () => { current!.effectiveAuthorization!.baseline.rules[0]!.actions = ['read']; } };
}

const previousAppId = process.env.FEISHU_APP_ID;
beforeEach(() => { process.env.FEISHU_APP_ID = 'cli_test'; });
afterEach(() => { if (previousAppId === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = previousAppId; });

describe('platform procurement order is authorized by current per-record permissions', () => {
  it.each(['综合采购', '需求自采'] as const)('authorizes an unassigned person with current scoped order permission for %s and preserves purchaser', async method => {
    const f = fixture(record({ purchaseMethod: method })); await f.service.order('recDelegate', f.session, input);
    const patch = f.gateway.updateExecutionRecord.mock.calls[0]![1];
    expect(patch['采购人']).toBeUndefined(); expect(f.getRecord().purchaserOpenId).toBe('ou_assigned');
    expect(f.store.claimCommand.mock.calls[0]![0]).toMatchObject({ actorOpenId: 'ou_actor', recordId: 'recDelegate' });
    expect(f.gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });
  it('rejects cross-building, different specialty, inactive identity and the wrong stage', async () => {
    for (const variant of ['cross-building', 'specialty', 'inactive', 'not-ordering'] as const) {
      const f = fixture(variant === 'cross-building' ? record({ building: 'A楼' }) : variant === 'specialty' ? record({ specialty: '暖通' }) : variant === 'not-ordering' ? record({ status: '下单完成（待签收）' }) : record());
      if (variant === 'inactive') f.revoke();
      await expect(f.service.order('recDelegate', f.session, input)).rejects.toThrow();
      expect(f.gateway.updateExecutionRecord).not.toHaveBeenCalled();
    }
  });
  it('rejects the absence of the order action even within the building', async () => {
    const f = fixture(); f.removeOrder();
    await expect(f.service.order('recDelegate', f.session, input)).rejects.toThrow();
    expect(f.gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
  it('retains the originally assigned purchaser path', async () => {
    const f = fixture(); f.gateway.resolveUser.mockResolvedValue({ ...actor, openId: 'ou_assigned' });
    f.setAccounts([{ ...defaultAccount(), openId: 'ou_assigned' }]);
    await f.service.order('recDelegate', { ...f.session, openId: 'ou_assigned' }, input);
    expect(f.gateway.updateExecutionRecord).toHaveBeenCalledTimes(1); expect(f.getRecord().purchaserOpenId).toBe('ou_assigned');
  });
  it.each(['duplicate', 'inactive', 'impersonated'] as const)('does not fall back to original purchaser authority for %s platform identity', async problem => {
    const f = fixture(record({ purchaserOpenId: 'ou_actor' }));
    const account = defaultAccount();
    if (problem === 'duplicate') f.setAccounts([account, { ...account }]);
    if (problem === 'inactive') f.setAccounts([{ ...account, personnelActive: false }]);
    await expect(f.service.order('recDelegate', { ...f.session, platformSession: true, ...(problem === 'impersonated' ? { impersonated: true } : {}) }, input)).rejects.toThrow();
    expect(f.gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
  it.each(['stage', 'building', 'method'] as const)('rechecks %s after claim before writing', async change => {
    const f = fixture();
    f.store.claimCommand.mockImplementationOnce(async (entry, guard) => {
      guard?.();
      if (change === 'stage') f.setRecord(record({ status: '下单完成（待签收）' }));
      if (change === 'building') f.setRecord(record({ building: 'A楼' }));
      if (change === 'method') f.setRecord(record({ purchaseMethod: '需求自采' }));
      return { claimed: true, entry: { ...entry, completedAt: '', notificationWarnings: [] } };
    });
    await expect(f.service.order('recDelegate', f.session, input)).rejects.toThrow();
    expect(f.store.claimCommand).toHaveBeenCalled(); expect(f.gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
  it.each(['permission', 'identity', 'mapping'] as const)('finishes the already accepted order after %s changes', async change => {
    const f = fixture();
    f.store.claimCommand.mockImplementationOnce(async (entry, guard) => {
      guard?.();
      // The returned claim represents an already durably accepted command.
      const accepted = { claimed: true, entry: { ...entry, completedAt: '', notificationWarnings: [] } };
      if (change === 'permission') f.removeOrder();
      if (change === 'identity') f.revoke();
      if (change === 'mapping') f.setAccounts([{ ...defaultAccount(), personnelActive: false }]);
      return accepted;
    });
    await f.service.order('recDelegate', f.session, input);
    expect(f.gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });
  it('does not let a shared account impersonate a configured operator', async () => {
    const f = fixture(), shared = { ...principal(), accountId: 'local-building_admin-C' }; f.setPrincipal(shared);
    await expect(f.service.order('recDelegate', { ...f.session, permissionPrincipal: shared }, input)).rejects.toThrow();
    expect(f.gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
  it.each(['different-person', 'duplicate-account', 'inactive', 'wrong-app'] as const)('rejects %s identity mapping', async problem => {
    const f = fixture(), account = defaultAccount();
    if (problem === 'different-person') f.setAccounts([{ ...account, openId: 'ou_other' }]);
    if (problem === 'duplicate-account') f.setAccounts([account, { ...account }]);
    if (problem === 'inactive') f.setAccounts([{ ...account, personnelActive: false }]);
    if (problem === 'wrong-app') f.setAccounts([{ ...account, appId: 'cli_other' }]);
    await expect(f.service.order('recDelegate', f.session, input)).rejects.toThrow();
    expect(f.gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
  it('rejects a fabricated impersonation identity that lacks verified administrator-session proof', async () => {
    const f = fixture(), impersonated = { ...principal(), impersonation: { actorAccountId: 'admin', actorName: 'admin', targetName: 'person', expiresAt: Date.now() + 60_000 } };
    f.setPrincipal(impersonated);
    await expect(f.service.order('recDelegate', { ...f.session, impersonated: true, permissionPrincipal: impersonated }, input)).rejects.toThrow();
    expect(f.gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
  it('rejects a change of record building after claim even if the account is authorized in both', async () => {
    const f = fixture(), both = principal(); both.buildings = ['A楼', 'C楼']; both.effectiveAuthorization!.baseline.rules[0]!.buildings = ['A楼', 'C楼']; f.setPrincipal(both);
    f.store.claimCommand.mockImplementationOnce(async (entry, guard) => { guard?.(); f.setRecord(record({ building: 'A楼' })); return { claimed: true, entry: { ...entry, completedAt: '', notificationWarnings: [] } }; });
    await expect(f.service.order('recDelegate', { ...f.session, purchaseBuildings: ['A楼', 'C楼'], permissionPrincipal: both }, input)).rejects.toThrow();
    expect(f.gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
  it('rejects a change of assigned purchaser after claim', async () => {
    const f = fixture();
    f.store.claimCommand.mockImplementationOnce(async (entry, guard) => { guard?.(); f.setRecord(record({ purchaserOpenId: 'ou_other', purchaserName: '另一采购人' })); return { claimed: true, entry: { ...entry, completedAt: '', notificationWarnings: [] } }; });
    await expect(f.service.order('recDelegate', f.session, input)).rejects.toThrow(); expect(f.gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
});

describe('platform procurement receipt is authorized by current per-record permissions', () => {
  const receiptInput = { signer: '合成签收人', signerOpenId: 'ou_signer', receiptTime: 1, receiptPhotoTokens: ['photo_test'], invoiceTokens: [], note: '' };
  function receiptFixture() {
    const f = fixture(record({ status: '下单完成（待签收）' })), allowed = principal();
    allowed.effectiveAuthorization!.baseline.rules[0]!.actions = ['read', 'receive'];
    f.setPrincipal(allowed);
    return { ...f, session: { ...f.session, permissionPrincipal: businessAuthorizationSnapshot(allowed) } };
  }
  it.each(['duplicate', 'inactive', 'impersonated'] as const)('does not fall back to original requester authority for %s platform identity', async problem => {
    const f = receiptFixture();
    f.setRecord(record({ status: '下单完成（待签收）', requesterOpenId: 'ou_actor' }));
    const account = defaultAccount();
    if (problem === 'duplicate') f.setAccounts([account, { ...account }]);
    if (problem === 'inactive') f.setAccounts([{ ...account, personnelActive: false }]);
    await expect(f.service.receive('recDelegate', { ...f.session, platformSession: true, ...(problem === 'impersonated' ? { impersonated: true } : {}) }, receiptInput)).rejects.toThrow();
    expect(f.gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
  it('allows a permitted person who is neither purchaser nor requester and preserves the purchaser', async () => {
    const f = receiptFixture(); await f.service.receive('recDelegate', f.session, receiptInput);
    const patch = f.gateway.updateExecutionRecord.mock.calls[0]![1];
    expect(patch['采购人']).toBeUndefined(); expect(f.getRecord().purchaserOpenId).toBe('ou_assigned');
    expect(f.store.claimCommand.mock.calls[0]![0]).toMatchObject({ actorOpenId: 'ou_actor', action: 'receive' });
  });
  it.each(['stage', 'building'] as const)('rechecks %s after receipt claim', async change => {
    const f = receiptFixture();
    f.store.claimCommand.mockImplementationOnce(async (entry, guard) => {
      guard?.();
      if (change === 'stage') f.setRecord(record({ status: '到货已签收（待入库）' }));
      if (change === 'building') f.setRecord(record({ status: '下单完成（待签收）', building: 'A楼' }));
      return { claimed: true, entry: { ...entry, completedAt: '', notificationWarnings: [] } };
    });
    await expect(f.service.receive('recDelegate', f.session, receiptInput)).rejects.toThrow();
    expect(f.store.claimCommand).toHaveBeenCalled(); expect(f.gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
  it.each(['permission', 'identity', 'mapping'] as const)('finishes the already accepted receipt after %s changes', async change => {
    const f = receiptFixture();
    f.store.claimCommand.mockImplementationOnce(async (entry, guard) => {
      guard?.();
      const accepted = { claimed: true, entry: { ...entry, completedAt: '', notificationWarnings: [] } };
      if (change === 'permission') f.removeOrder();
      if (change === 'identity') f.revoke();
      if (change === 'mapping') f.setAccounts([{ ...defaultAccount(), personnelActive: false }]);
      return accepted;
    });
    await f.service.receive('recDelegate', f.session, receiptInput);
    expect(f.gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });
});
