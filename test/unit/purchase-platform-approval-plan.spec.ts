import { planPlatformApproval, type PlatformApprovalBatchSnapshot, type PlatformApprovalExistingAction, type PlatformApprovalRequest } from '../../server/modules/purchase-inventory/purchase-platform-approval-plan';
import type { PurchasePlatformIdentityProof } from '../../server/modules/purchase-inventory/purchase-platform-identity-proof';

const identity: PurchasePlatformIdentityProof = Object.freeze({ source: 'platform', actorAccountId: 'person-a', actorAuthorizationVersion: 2, actorDisplayName: '合成人员', subjectAccountId: 'person-a', subjectAuthorizationVersion: 2, subjectDisplayName: '合成人员', sessionFamilyFingerprint: 'x'.repeat(43), expiresAt: 10000 });
const baseRecord = { recordId: 'recItem1', status: '未开始（待审批）', building: 'C楼', specialty: '电气' };
const baseBatch = (): PlatformApprovalBatchSnapshot => ({ approvalBatchId: 'purchase-batch-123', state: 'active', revision: 1,
  items: [{ executionRecordId: 'recItem1', status: 'pending', authorityTarget: { building: 'C楼', specialty: '电气' } }, { executionRecordId: 'recItem2', status: 'pending' }] });
const request = (changes: Partial<PlatformApprovalRequest> = {}): PlatformApprovalRequest => ({ requestId: 'request_id_1234567890', recordId: 'recItem1', choice: 'comprehensive', rejectionReason: '', ...changes });
const auth = jest.fn(() => true);
beforeEach(() => auth.mockClear());
function plan(changes: Partial<Parameters<typeof planPlatformApproval>[0]> = {}) {
  return planPlatformApproval({ batch: baseBatch(), actions: [], record: baseRecord, request: request(), identity, lifecycleReady: false, ...changes }, auth);
}
describe('isolated platform approval ledger planner', () => {
  it('creates a single-record legacy claim with actual account provenance and no fabricated card identity', () => {
    const result = plan();
    expect(result).toMatchObject({ kind: 'claim', recordId: 'recItem1', expectedRevision: 1, action: { source: 'platform', recordIds: ['recItem1'], actorAccountId: 'person-a', subjectAccountId: 'person-a' } });
    if (result.kind !== 'claim') throw new Error('unexpected replay');
    expect(result.action).not.toHaveProperty('messageId'); expect(result.action).not.toHaveProperty('actorOpenId');
    expect(auth).toHaveBeenCalledWith(identity, baseRecord, 'new');
  });
  it('preserves both identities for administrator impersonation without passing subject Feishu identity as the actor', () => {
    const delegated: PurchasePlatformIdentityProof = { ...identity, source: 'impersonation', actorAccountId: 'admin', actorAuthorizationVersion: 4, actorDisplayName: '合成管理员' };
    const result = plan({ identity: delegated });
    expect(result).toMatchObject({ kind: 'claim', action: { actorAccountId: 'admin', actorAuthorizationVersion: 4, actorDisplayName: '合成管理员', subjectAccountId: 'person-a', subjectAuthorizationVersion: 2, subjectDisplayName: '合成人员' } });
  });
  it('keeps lifecycle closed unless explicitly ready and never changes legacy selection semantics', () => {
    expect(() => plan({ batch: { ...baseBatch(), flowVersion: 'lifecycle_v1' } })).toThrow();
    expect(plan({ batch: { ...baseBatch(), flowVersion: 'lifecycle_v1' }, lifecycleReady: true })).toMatchObject({ kind: 'claim', recordId: 'recItem1' });
  });
  it('requires a real reason for rejection, no reason for approval, and blocks H-building self purchase', () => {
    expect(() => plan({ request: request({ choice: 'reject', rejectionReason: '' }) })).toThrow();
    expect(() => plan({ request: request({ rejectionReason: 'not applicable' }) })).toThrow();
    expect(plan({ request: request({ choice: 'reject', rejectionReason: '信息不完整' }) })).toMatchObject({ kind: 'claim', action: { choice: 'reject', rejectionReason: '信息不完整' } });
    const batch = { ...baseBatch(), items: [{ executionRecordId: 'recItem1', status: 'pending' }] };
    expect(() => plan({ batch, record: { ...baseRecord, building: 'H楼' }, request: request({ choice: 'building_self' }) })).toThrow();
  });
  it('rejects unavailable/async authorization, non-pending status, changing scope and duplicate items', () => {
    expect(() => planPlatformApproval({ batch: baseBatch(), actions: [], record: baseRecord, request: request(), identity, lifecycleReady: false }, () => false)).toThrow();
    expect(() => planPlatformApproval({ batch: baseBatch(), actions: [], record: baseRecord, request: request(), identity, lifecycleReady: false }, async () => true)).toThrow();
    expect(() => plan({ record: { ...baseRecord, status: '审批通过（待下单）' } })).toThrow();
    expect(() => plan({ record: { ...baseRecord, building: 'A楼' } })).toThrow();
    expect(() => plan({ batch: { ...baseBatch(), items: [...baseBatch().items, baseBatch().items[0]!] } })).toThrow();
    expect(() => plan({ identity: { ...identity, actorAccountId: 'invalid account' } })).toThrow();
    expect(() => plan({ identity: { ...identity, actorAccountId: 'different-actor' } })).toThrow();
  });
  it('replays only an exact previously recorded request and rechecks authority without requiring a pending stage', () => {
    const first = plan(); if (first.kind !== 'claim') throw new Error('missing claim');
    const existing: PlatformApprovalExistingAction = { ...first.action, status: 'completed' };
    const replay = plan({ actions: [existing], record: { ...baseRecord, status: '审批通过（待下单）' } });
    expect(replay).toMatchObject({ kind: 'replay' }); expect(auth).toHaveBeenLastCalledWith(identity, expect.anything(), 'replay');
    expect(() => plan({ actions: [existing], request: request({ choice: 'reject', rejectionReason: '信息不完整' }) })).toThrow();
    expect(() => plan({ actions: [{ ...existing, source: 'card' }] })).toThrow();
  });
  it('blocks an active card action and an ambiguous batch instead of overwriting it', () => {
    expect(() => plan({ actions: [{ eventId: 'card-event', source: 'card', approvalBatchId: 'purchase-batch-123', status: 'pending', recordIds: ['recItem1'] }] })).toThrow();
    expect(() => plan({ batch: { ...baseBatch(), state: 'reject_editing' } })).toThrow();
  });
  it('permits only one of two opposing submissions inside a simulated common ledger transaction', async () => {
    let batch = baseBatch(); const actions: PlatformApprovalExistingAction[] = [];
    let tail: Promise<void> = Promise.resolve();
    const transact = (next: PlatformApprovalRequest) => {
      const work = tail.then(() => {
        const result = plan({ batch, actions, request: next });
        if (result.kind === 'claim') {
          actions.push(result.action);
          batch = { ...batch, revision: batch.revision + 1, state: 'processing', items: batch.items.map(item => item.executionRecordId === result.recordId ? { ...item, status: 'processing' } : item) };
        }
        return result;
      });
      tail = work.then(() => undefined, () => undefined); return work;
    };
    const results = await Promise.allSettled([transact(request()), transact(request({ requestId: 'other_request_987654321', choice: 'reject', rejectionReason: '信息不完整' }))]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(actions).toHaveLength(1); expect(actions[0]!.recordIds).toEqual(['recItem1']);
    expect(batch.items.find(item => item.executionRecordId === 'recItem2')?.status).toBe('pending');
  });
});
