import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { PurchaseWorkflowRecord, PurchaseWorkflowUser } from '../../shared/purchase-workflow.interface';
import { businessAuthorizationSnapshot } from '../../shared/business-permissions';
import { buildApprovalPatch, buildOrderPatch, buildReceiptPatch, buildStartPatch, resolveAllowedActions } from '../../server/modules/purchase-inventory/purchase-workflow.rules';
import { PurchaseWorkflowService, type PurchaseWorkflowSession } from '../../server/modules/purchase-inventory/purchase-workflow.service';
import { PurchaseOnlineApprovalService } from '../../server/modules/purchase-inventory/purchase-online-approval.service';
import { resolvePurchaseWorkflowReadSession, resolvePurchaseWorkflowSession } from '../../server/modules/purchase-inventory/purchase-workflow-session';
import * as configuration from '../../server/common/config/external-services.config';

const profile = (): AccessPrincipal => ({ role: 'guest', purchaseBuilding: null, accountId: 'synthetic-person', authorizationVersion: 2,
  permissionContext: { module: 'purchase', action: 'approve' },
  effectiveAuthorization: { mode: 'independent', baseline: { nativeRole: null, pages: [], rules: [{ id: 'synthetic-purchase', module: 'purchase', effect: 'allow', actions: ['approve', 'create', 'order', 'receive'], buildings: ['A楼'], specialties: ['电气'] }] }, overrides: { rules: [], allowPages: [], denyPages: [] } } });
const record = (overrides: Partial<PurchaseWorkflowRecord> = {}): PurchaseWorkflowRecord => ({ recordId: 'recSynthetic', requestCode: 'SYNTHETIC', status: '未开始（待审批）', itemName: '合成物品', building: 'A楼', specialty: '电气', requesterOpenId: 'ou_requester', requesterName: '合成申请人', purchaserOpenId: 'ou_purchaser', purchaserName: '合成采购人', purchaseMethod: '综合采购', requestedQuantity: 1, actualQuantity: null, actualAmount: null, approvalCompleted: false, warehouseConfirmed: false, purchaseCompleted: false, receiptConfirmed: false, signer: '', receiptTime: null, receiptPhotoTokens: [], invoiceTokens: [], ...overrides });
const person = (): PurchaseWorkflowUser => ({ openId: 'ou_person', name: '合成人员', positions: [], buildings: ['A楼'], accessRole: 'guest', permissionPrincipal: profile() });
const order = { actualQuantity: 1, actualAmount: 1, paymentAttachmentTokens: [], note: '' };
const receipt = { signer: '合成申请人', signerOpenId: 'ou_requester', receiptTime: 1, receiptPhotoTokens: ['synthetic-photo'], invoiceTokens: [], note: '' };

describe('purchase business duties remain independent of role templates', () => {
  it.each(['guest', 'professional_admin', 'building_admin', 'purchase_admin', 'supply_chain_admin'] as const)('does not turn %s or its explicit permissions into another person\'s duty', role => {
    const actor = { ...person(), accessRole: role };
    for (const status of ['未开始（待审批）', '审批通过（待库房确认）', '审批通过（待下单）', '下单完成（待签收）']) expect(resolveAllowedActions(record({ status }), actor)).toEqual([]);
    expect(() => buildApprovalPatch(record(), actor, { decision: 'approved', purchaseMethod: '综合采购', comment: '' })).toThrow('无权审批');
    expect(() => buildStartPatch(record({ status: '审批通过（待库房确认）' }), actor, { ...person(), openId: 'ou_purchaser' })).toThrow('无权确认库房');
    expect(() => buildOrderPatch(record({ status: '审批通过（待下单）' }), actor, order)).toThrow('无权提交下单');
    expect(() => buildReceiptPatch(record({ status: '下单完成（待签收）' }), actor, receipt)).toThrow('无权确认到货');
  });
  it('requires record assignment for order/receipt and actual same-building supervision for start', () => {
    const actor = person();
    expect(resolveAllowedActions(record({ status: '审批通过（待下单）', purchaserOpenId: actor.openId }), actor)).toEqual(['order']);
    expect(resolveAllowedActions(record({ status: '下单完成（待签收）', requesterOpenId: actor.openId }), actor)).toEqual(['receive']);
    expect(resolveAllowedActions(record({ status: '审批通过（待库房确认）', purchaseMethod: '需求自采' }), { ...actor, positions: ['楼栋主管'] })).toEqual(['start']);
    expect(resolveAllowedActions(record({ status: '审批通过（待库房确认）', purchaseMethod: '需求自采', building: 'B楼' }), { ...actor, positions: ['楼栋主管'] })).toEqual([]);
  });
  it('does not accept an organization title as an approval roster entry', () => {
    const manager = { ...person(), positions: ['设施运维经理'] };
    expect(resolveAllowedActions(record(), manager)).toEqual([]);
    expect(resolveAllowedActions(record(), { ...manager, approvalDuty: false })).toEqual([]);
    expect(resolveAllowedActions(record(), { ...manager, approvalDuty: true })).toEqual(['approve']);
  });
  it('retains the fixed system administrator correction path and original shared applicant boundaries', () => {
    const admin = { ...person(), accessRole: 'admin' as const, permissionPrincipal: undefined };
    expect(resolveAllowedActions(record(), admin)).toEqual(['approve']);
    expect(resolveAllowedActions(record({ status: '审批通过（待下单）' }), admin)).toEqual(['order']);
    const applicant = { ...person(), accessRole: 'purchase_applicant' as const, permissionPrincipal: undefined };
    expect(resolveAllowedActions(record({ status: '审批通过（待下单）', purchaseMethod: '需求自采' }), applicant)).toEqual(['order']);
    expect(resolveAllowedActions(record({ status: '审批通过（待下单）', purchaseMethod: '综合采购' }), applicant)).toEqual([]);
    expect(resolveAllowedActions(record({ status: '下单完成（待签收）' }), applicant)).toEqual(['receive']);
  });
});

describe('actual online approval service rechecks current identity, roster and scope before the write', () => {
  let managerEnabled: boolean;
  beforeEach(() => {
    managerEnabled = true;
    jest.useFakeTimers();
    jest.spyOn(configuration, 'readEnv').mockImplementation(name => name === 'PURCHASE_MANAGER_APPROVAL_CARD_ENABLED' ? String(managerEnabled) : '');
  });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });
  function setup() {
    let current = profile();
    let managerIds = ['ou_person'], legacyIds = ['ou_legacy'];
    let live = record();
    const gateway = {
      getExecutionRecord: jest.fn(async () => structuredClone(live)),
      getExecutionRecordAsApp: jest.fn(async () => structuredClone(live)),
      resolveUser: jest.fn(async () => person()),
      updateExecutionRecordAsApp: jest.fn(async (_id: string, fields: Record<string, unknown>) => { live = { ...live, status: String(fields['采购流程']), purchaseMethod: fields['1️⃣物品采购方式'] as PurchaseWorkflowRecord['purchaseMethod'] }; }),
      updateExecutionRecord: jest.fn(),
    };
    const access = {
      currentPrincipal: jest.fn((id: string, version: number) => id === current.accountId && version === current.authorizationVersion ? businessAuthorizationSnapshot(current) : undefined),
      currentDutyRoutePeople: jest.fn((kind: string) => (kind === 'purchase_manager' ? managerIds : legacyIds).map(openId => ({ openId, name: '合成名单成员' }))),
    };
    const store = { findCommand: jest.fn(async () => undefined), claimCommand: jest.fn(async (_input: unknown, guard?: () => void) => { guard?.(); return { claimed: true, entry: {} }; }) };
    const workflow = new PurchaseWorkflowService(gateway as never, store as never, undefined, access as never);
    const online = new PurchaseOnlineApprovalService(gateway as never, workflow);
    const session: PurchaseWorkflowSession = { accessToken: 'synthetic-token', openId: 'ou_person', userName: '合成人员', accessRole: 'guest', permissionPrincipal: businessAuthorizationSnapshot(current), authenticationMode: 'delegated-app' };
    return { gateway, store, access, workflow, online, session, revoke: () => { current = { ...current, authorizationVersion: 3 }; }, removeManager: () => { managerIds = []; }, setLegacy: () => { legacyIds = ['ou_person']; }, moveRecord: () => { live = { ...live, building: 'B楼' }; } };
  }
  it('rejects a fully permitted person outside the current roster, including an old organization manager title', async () => {
    const x = setup(); x.removeManager(); x.gateway.resolveUser.mockResolvedValue({ ...person(), positions: ['设施运维经理'] });
    await expect(x.online.acceptAuthorizedDecision('recSynthetic', { decision: 'approved' }, x.session)).rejects.toBeInstanceOf(ForbiddenException);
    await jest.runAllTimersAsync(); expect(x.gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
  });
  it('chooses the actual enabled manager chain or legacy approver chain, rather than merging both lists', async () => {
    const x = setup(); managerEnabled = false;
    await expect(x.workflow.prepareWebApprovalAuthority('recSynthetic', x.session)).rejects.toBeInstanceOf(ForbiddenException);
    x.setLegacy(); const accepted = await x.workflow.prepareWebApprovalAuthority('recSynthetic', x.session);
    expect(accepted.approvalDutyKind).toBe('purchase_approver');
    managerEnabled = true; x.removeManager();
    expect(() => x.workflow.assertWebApprovalAuthority(accepted, record())).toThrow(ForbiddenException);
  });
  it('also rechecks the real workflow approval command inside its existing claim guard', async () => {
    const x = setup(); jest.spyOn(x.workflow, 'isEnabled').mockReturnValue(true);
    x.store.claimCommand.mockImplementationOnce(async (_input, guard) => { x.removeManager(); guard!(); return { claimed: true, entry: {} }; });
    await expect(x.workflow.approve('recSynthetic', x.session, { decision: 'approved', purchaseMethod: '综合采购', comment: '' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(x.store.claimCommand).toHaveBeenCalledTimes(1);
    expect(x.gateway.updateExecutionRecord).not.toHaveBeenCalled();
  });
  it.each(['version', 'roster', 'scope'] as const)('rechecks %s after acceptance and current-record read, before the first external write', async reason => {
    const x = setup();
    const accepted = await x.online.acceptAuthorizedDecision('recSynthetic', { decision: 'approved' }, x.session);
    x.gateway.getExecutionRecordAsApp.mockImplementationOnce(async () => {
      if (reason === 'version') x.revoke();
      if (reason === 'roster') x.removeManager();
      if (reason === 'scope') return record({ building: 'B楼' });
      return record();
    });
    await jest.runAllTimersAsync();
    expect(x.online.getAuthorizedDecisionTaskStatus(accepted.taskId, x.session.permissionPrincipal!)).toMatchObject({ task: { status: 'failed' } });
    expect(x.gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
  });
  it('writes once, returns the same successful task on replay, and binds status to owner/version/full policy', async () => {
    const x = setup();
    const accepted = await x.online.acceptAuthorizedDecision('recSynthetic', { decision: 'approved' }, x.session);
    await jest.runAllTimersAsync();
    const read = { ...x.session.permissionPrincipal!, permissionContext: { module: 'purchase' as const, action: 'read' as const } };
    expect(x.online.getAuthorizedDecisionTaskStatus(accepted.taskId, read)).toMatchObject({ task: { status: 'completed' } });
    expect((await x.online.acceptAuthorizedDecision('recSynthetic', { decision: 'approved' }, x.session)).taskId).toBe(accepted.taskId);
    expect(x.gateway.updateExecutionRecordAsApp).toHaveBeenCalledTimes(1);
    for (const denied of [{ ...read, accountId: 'another-person' }, { ...read, authorizationVersion: 3 }]) expect(() => x.online.getAuthorizedDecisionTaskStatus(accepted.taskId, denied)).toThrow(ForbiddenException);
  });
  it('reconciles an unknown write response by reading the applied result without repeating the write', async () => {
    const x = setup();
    const write = x.gateway.updateExecutionRecordAsApp.getMockImplementation()!;
    x.gateway.updateExecutionRecordAsApp.mockImplementationOnce(async (...args) => { await write(...args); throw new Error('synthetic response lost'); });
    const accepted = await x.online.acceptAuthorizedDecision('recSynthetic', { decision: 'approved' }, x.session);
    await jest.runAllTimersAsync();
    expect(x.online.getAuthorizedDecisionTaskStatus(accepted.taskId, x.session.permissionPrincipal!)).toMatchObject({ task: { status: 'completed', result: { idempotent: true } } });
    expect(x.gateway.updateExecutionRecordAsApp).toHaveBeenCalledTimes(1);
  });
});

describe('personal procurement identities cannot borrow a configured operator', () => {
  afterEach(() => jest.restoreAllMocks());
  it('rejects an unbound personal writer despite explicit approval/order/receipt grants; read-only has no acting identity', async () => {
    jest.spyOn(configuration, 'readEnv').mockReturnValue('ou_someone_else');
    const input = { principal: { ...profile(), accountId: `local-external-${'a'.repeat(64)}` }, getTenantAccessToken: jest.fn(async () => 'synthetic-token') };
    await expect(resolvePurchaseWorkflowSession(input)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(input.getTenantAccessToken).not.toHaveBeenCalled();
    const read = await resolvePurchaseWorkflowReadSession(input);
    expect(read.openId).toBe(''); expect(read.permissionPrincipal?.accountId).toBe(input.principal.accountId);
  });
  it('uses a bound personal identity and retains only the original fixed shared-entry delegation', async () => {
    const env = jest.spyOn(configuration, 'readEnv').mockImplementation(name => name === 'PURCHASE_WORKFLOW_EDITOR_OPERATOR_OPEN_ID' ? 'ou_shared_editor' : 'ou_someone_else');
    const personal = { principal: profile(), professionalOpenId: 'ou_actual_person', getTenantAccessToken: async () => 'synthetic-token' };
    expect((await resolvePurchaseWorkflowSession(personal)).openId).toBe('ou_actual_person');
    expect(env).not.toHaveBeenCalled();
    expect((await resolvePurchaseWorkflowSession({ ...personal, professionalOpenId: undefined, principal: { ...profile(), accountId: 'local-editor-all' } })).openId).toBe('ou_shared_editor');
  });
});
