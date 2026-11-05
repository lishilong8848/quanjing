import { createPlatformApprovalCoordinator, type PlatformApprovalReadback, type PlatformApprovalWorkerGateway, type PlatformApprovalWorkerJob, type PlatformApprovalWorkerStore } from '../../server/modules/purchase-inventory/purchase-platform-approval-coordinator';
import type { PlatformApprovalPersistedAction } from '../../server/modules/purchase-inventory/purchase-platform-approval-plan';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

const eventId = 'platform_request_id_1234567890', serverActionId = `pa_${Buffer.alloc(32, 7).toString('base64url')}`, batchId = 'purchase-batch-123';
const action = (changes: Partial<PlatformApprovalPersistedAction> = {}): PlatformApprovalPersistedAction => ({ source: 'platform', eventId, serverActionId, acceptedAtMs: 2000, approvalBatchId: batchId, status: 'pending', fingerprint: 'a'.repeat(64), recordIds: ['recFake'], choice: 'comprehensive', rejectionReason: '', actorAccountId: 'admin', actorAuthorizationVersion: 7, actorDisplayName: '合成管理员', subjectAccountId: 'person', subjectAuthorizationVersion: 3, subjectDisplayName: '合成人员', identitySource: 'impersonation', authorityTarget: { building: 'C楼', specialty: '电气' }, sessionFamilyFingerprint: 'b'.repeat(43), sessionExpiresAt: 1000, ...changes });
const record = (): PurchaseWorkflowRecord => ({ recordId: 'recFake', requestCode: 'TEST', status: '未开始（待审批）', itemName: '合成物品', building: 'C楼', specialty: '电气', requesterOpenId: 'ou_requester', requesterName: '申请人', purchaserOpenId: '', purchaserName: '', purchaseMethod: '综合采购', rejectionReason: '', requestedQuantity: 1, actualQuantity: null, actualAmount: null, approvalCompleted: false, warehouseConfirmed: false, purchaseCompleted: false, receiptConfirmed: false, signer: '', receiptTime: null, receiptPhotoTokens: [], invoiceTokens: [], approvalBatchId: batchId });

function fixture(initial = action()) {
  let phase: 'pending' | 'dispatching' | 'manual' | 'confirmed' | 'completed' = 'pending';
  let current: PlatformApprovalReadback = record(), frozenPurchaser: { openId: string; name: string } | undefined, outboxCount = 0;
  const snapshot = (): PlatformApprovalWorkerJob => ({ action: structuredClone(initial), leaseToken: 'synthetic_lease_123', kind: phase === 'pending' ? 'dispatch' : phase === 'confirmed' ? 'complete' : phase === 'completed' ? 'done' : 'reconcile',
    batch: { approvalBatchId: batchId, flowVersion: 'legacy', requesterOpenId: 'ou_requester', itemRecordId: 'recFake', itemStatus: phase === 'completed' ? initial.choice === 'reject' ? 'rejected' : 'approved' : 'processing', itemEventId: eventId },
    ...(frozenPurchaser ? { frozenPurchaser: structuredClone(frozenPurchaser) } : {}) });
  const store: jest.Mocked<PlatformApprovalWorkerStore> = {
    claimPending: jest.fn(async () => snapshot()),
    beginDispatch: jest.fn(async (_job, purchaser) => { if (phase !== 'pending') return false; phase = 'dispatching'; frozenPurchaser = purchaser && structuredClone(purchaser); return true; }),
    deferBeforeDispatch: jest.fn(async () => { if (phase !== 'pending') throw new Error('cannot defer dispatched'); }),
    markUnknown: jest.fn(async () => { if (phase === 'pending' || phase === 'dispatching' || phase === 'manual') phase = 'manual'; }),
    recordConfirmed: jest.fn(async () => { if (phase !== 'dispatching' && phase !== 'manual') throw new Error('invalid confirmation'); phase = 'confirmed'; }),
    completeAndRefresh: jest.fn(async () => { if (phase !== 'confirmed') throw new Error('not confirmed'); phase = 'completed'; outboxCount++; }),
  };
  const gateway: jest.Mocked<PlatformApprovalWorkerGateway> = {
    readRecord: jest.fn(async () => structuredClone(current)), resolvePurchaser: jest.fn(async () => ({ openId: 'ou_purchaser', name: '合成采购人' })),
    writeRecord: jest.fn(async (_id, fields) => {
      const purchasers = fields['采购人'] as Array<{ id: string }> | undefined;
      current = { ...current, status: String(fields['采购流程']), purchaseMethod: fields['1️⃣物品采购方式'] as PurchaseWorkflowRecord['purchaseMethod'], rejectionReason: String(fields['驳回原因']),
        purchaserOpenId: purchasers?.[0]?.id || '', warehouseConfirmed: fields['库房确认'] === true, approvalActionId: String(fields['采购审批动作标识']),
        approvalWorkflowStatus: String(fields['采购工作流状态']), platformApprovalTimeMs: Number(fields['采购审批时间']),
        platformCurrentApproverOpenIds: ((fields['采购当前审批人'] as Array<{ id: string }>) || []).map(user => user.id),
        ...(fields['采购实际审批人'] ? { platformActualApproverOpenIds: (fields['采购实际审批人'] as Array<{ id: string }>).map(user => user.id) } : {}) };
    }),
  };
  return { store, gateway, coordinator: createPlatformApprovalCoordinator(store, gateway), getPhase: () => phase, getRecord: () => current, setRecord: (next: PlatformApprovalReadback) => { current = structuredClone(next); }, outboxCount: () => outboxCount };
}

describe('isolated platform approval worker orchestration', () => {
  it('fences before one write, uses trusted purchaser, omits Feishu actor for name account/impersonation, and atomically queues refresh', async () => {
    const f = fixture(); expect(await f.coordinator.run(eventId)).toBe('completed');
    const patch = f.gateway.writeRecord.mock.calls[0]![1];
    expect(patch['采购人']).toEqual([{ id: 'ou_purchaser' }]); expect(patch).not.toHaveProperty('采购实际审批人');
    expect(patch['采购审批动作标识']).toBe(serverActionId); expect(patch['采购审批动作标识']).not.toBe(eventId);
    expect(patch['采购审批时间']).toBe(2000);
    expect(f.store.beginDispatch.mock.invocationCallOrder[0]).toBeLessThan(f.gateway.writeRecord.mock.invocationCallOrder[0]!);
    expect(f.outboxCount()).toBe(1); expect(await f.coordinator.run(eventId)).toBe('completed'); expect(f.gateway.writeRecord).toHaveBeenCalledTimes(1); expect(f.outboxCount()).toBe(1);
  });
  it('uses the actual Feishu actor only when the durable claim has verified that identity', async () => {
    const f = fixture(action({ actorFeishuOpenId: 'ou_real_actor' })); await f.coordinator.run(eventId);
    expect(f.gateway.writeRecord.mock.calls[0]![1]['采购实际审批人']).toEqual([{ id: 'ou_real_actor' }]);
  });
  it('handles one rejected item without resolving any purchaser', async () => {
    const f = fixture(action({ choice: 'reject', rejectionReason: '信息不完整' })); expect(await f.coordinator.run(eventId)).toBe('completed');
    expect(f.gateway.resolvePurchaser).not.toHaveBeenCalled(); expect(f.gateway.writeRecord.mock.calls[0]![1]).toMatchObject({ 采购流程: '驳回申请', 驳回原因: '信息不完整' });
  });
  it('only one parallel worker can cross the durable fence and perform the write', async () => {
    const f = fixture(); const results = await Promise.all([f.coordinator.run(eventId), f.coordinator.run(eventId)]);
    expect(results.sort()).toEqual(['busy', 'completed']); expect(f.gateway.writeRecord).toHaveBeenCalledTimes(1); expect(f.outboxCount()).toBe(1);
  });
  it('can retry a pre-fence read failure without creating a dispatch', async () => {
    const f = fixture(); f.gateway.readRecord.mockRejectedValueOnce(new Error('transient'));
    expect(await f.coordinator.run(eventId)).toBe('busy'); expect(f.store.deferBeforeDispatch).toHaveBeenCalled(); expect(f.store.beginDispatch).not.toHaveBeenCalled();
    expect(await f.coordinator.run(eventId)).toBe('completed'); expect(f.gateway.writeRecord).toHaveBeenCalledTimes(1);
  });
  it('never resends after a write succeeded but its response was lost; recovery verifies its exact action marker', async () => {
    const f = fixture(), write = f.gateway.writeRecord.getMockImplementation()!;
    f.gateway.writeRecord.mockImplementationOnce(async (...args) => { await write(...args); throw new Error('response lost'); });
    expect(await f.coordinator.run(eventId)).toBe('manual_reconciliation'); expect(f.getPhase()).toBe('manual');
    expect(await f.coordinator.run(eventId)).toBe('completed'); expect(f.gateway.writeRecord).toHaveBeenCalledTimes(1); expect(f.outboxCount()).toBe(1);
  });
  it('does not treat another action with a similar state as proof of this action', async () => {
    const f = fixture(); f.setRecord({ ...record(), status: '审批通过（待下单）', warehouseConfirmed: true, purchaserOpenId: 'ou_purchaser', approvalActionId: 'other_action' });
    expect(await f.coordinator.run(eventId)).toBe('manual_reconciliation'); expect(f.gateway.writeRecord).not.toHaveBeenCalled();
  });
  it('never accepts a client-known request ID as the remote completion marker', async () => {
    const f = fixture(action({ choice: 'reject', rejectionReason: '信息不完整' }));
    await f.store.markUnknown({} as PlatformApprovalWorkerJob, 'synthetic');
    f.setRecord({ ...record(), status: '驳回申请', purchaseMethod: '驳回', rejectionReason: '信息不完整', approvalActionId: eventId });
    expect(await f.coordinator.run(eventId)).toBe('manual_reconciliation');
    expect(f.store.recordConfirmed).not.toHaveBeenCalled(); expect(f.gateway.writeRecord).not.toHaveBeenCalled();
  });
  it('does not confirm a partially applied result when workflow status is still pending', async () => {
    const f = fixture(action({ choice: 'reject', rejectionReason: '信息不完整' }));
    await f.store.markUnknown({} as PlatformApprovalWorkerJob, 'synthetic');
    f.setRecord({ ...record(), status: '驳回申请', purchaseMethod: '驳回', rejectionReason: '信息不完整', approvalActionId: serverActionId, approvalWorkflowStatus: '待经理审批' });
    expect(await f.coordinator.run(eventId)).toBe('manual_reconciliation');
    expect(f.store.recordConfirmed).not.toHaveBeenCalled(); expect(f.store.completeAndRefresh).not.toHaveBeenCalled();
  });
  it.each(['missing-status', 'wrong-time', 'missing-time', 'missing-current', 'nonempty-current'] as const)('rejects incomplete readback: %s', async failure => {
    const f = fixture(action({ choice: 'reject', rejectionReason: '信息不完整' }));
    await f.store.markUnknown({} as PlatformApprovalWorkerJob, 'synthetic');
    const row: PlatformApprovalReadback = { ...record(), status: '驳回申请', purchaseMethod: '驳回', rejectionReason: '信息不完整', approvalActionId: serverActionId,
      approvalWorkflowStatus: '已驳回', platformApprovalTimeMs: 2000, platformCurrentApproverOpenIds: [] };
    if (failure === 'missing-status') delete row.approvalWorkflowStatus;
    if (failure === 'wrong-time') row.platformApprovalTimeMs = 2001;
    if (failure === 'missing-time') delete row.platformApprovalTimeMs;
    if (failure === 'missing-current') delete row.platformCurrentApproverOpenIds;
    if (failure === 'nonempty-current') row.platformCurrentApproverOpenIds = ['ou_other'];
    f.setRecord(row); expect(await f.coordinator.run(eventId)).toBe('manual_reconciliation');
    expect(f.store.recordConfirmed).not.toHaveBeenCalled();
  });
  it.each([undefined, [], ['ou_other']] as Array<string[] | undefined>)('requires the exact actual Feishu actor when that field was written', async actualApprovers => {
    const f = fixture(action({ choice: 'reject', rejectionReason: '信息不完整', actorFeishuOpenId: 'ou_real_actor' }));
    await f.store.markUnknown({} as PlatformApprovalWorkerJob, 'synthetic');
    f.setRecord({ ...record(), status: '驳回申请', purchaseMethod: '驳回', rejectionReason: '信息不完整', approvalActionId: serverActionId,
      approvalWorkflowStatus: '已驳回', platformApprovalTimeMs: 2000, platformCurrentApproverOpenIds: [], platformActualApproverOpenIds: actualApprovers });
    expect(await f.coordinator.run(eventId)).toBe('manual_reconciliation'); expect(f.store.recordConfirmed).not.toHaveBeenCalled();
  });
  it('does not require an unwritten actual-approver field for a native name account', async () => {
    const f = fixture(action({ choice: 'reject', rejectionReason: '信息不完整' }));
    await f.store.markUnknown({} as PlatformApprovalWorkerJob, 'synthetic');
    f.setRecord({ ...record(), status: '驳回申请', purchaseMethod: '驳回', rejectionReason: '信息不完整', approvalActionId: serverActionId,
      approvalWorkflowStatus: '已驳回', platformApprovalTimeMs: 2000, platformCurrentApproverOpenIds: [] });
    expect(await f.coordinator.run(eventId)).toBe('completed');
  });
  it('rejects a malformed server action identifier before any remote read or write', async () => {
    const f = fixture(), job = (await f.store.claimPending(eventId))!;
    f.store.claimPending.mockResolvedValueOnce({ ...job, action: { ...job.action, serverActionId: 'pa_predictable' } });
    await expect(f.coordinator.run(eventId)).rejects.toThrow();
    expect(f.gateway.readRecord).not.toHaveBeenCalled(); expect(f.gateway.writeRecord).not.toHaveBeenCalled();
  });
  it('stops if the record changes after the fence before the write', async () => {
    const f = fixture(); f.gateway.readRecord.mockResolvedValueOnce(record()).mockResolvedValueOnce({ ...record(), building: 'A楼' });
    expect(await f.coordinator.run(eventId)).toBe('manual_reconciliation'); expect(f.gateway.writeRecord).not.toHaveBeenCalled();
    expect(await f.coordinator.run(eventId)).toBe('manual_reconciliation'); expect(f.gateway.writeRecord).not.toHaveBeenCalled();
  });
  it('does not resend when the process loses the record after the durable fence', async () => {
    const f = fixture(); f.gateway.readRecord.mockResolvedValueOnce(record()).mockRejectedValueOnce(new Error('read interrupted'));
    expect(await f.coordinator.run(eventId)).toBe('manual_reconciliation');
    expect(f.store.beginDispatch).toHaveBeenCalledTimes(1); expect(f.gateway.writeRecord).not.toHaveBeenCalled();
    expect(await f.coordinator.run(eventId)).toBe('manual_reconciliation');
    expect(f.store.beginDispatch).toHaveBeenCalledTimes(1); expect(f.gateway.writeRecord).not.toHaveBeenCalled();
  });
  it('does not downgrade confirmed results when finalizing or card refresh fails; retry only finishes the transaction', async () => {
    const f = fixture(), complete = f.store.completeAndRefresh.getMockImplementation()!;
    f.store.completeAndRefresh.mockRejectedValueOnce(new Error('transient store error'));
    await expect(f.coordinator.run(eventId)).rejects.toThrow();
    expect(f.getPhase()).toBe('confirmed'); expect(f.store.markUnknown).not.toHaveBeenCalled(); expect(f.gateway.writeRecord).toHaveBeenCalledTimes(1);
    f.store.completeAndRefresh.mockImplementation(complete); expect(await f.coordinator.run(eventId)).toBe('completed');
    expect(f.gateway.writeRecord).toHaveBeenCalledTimes(1); expect(f.outboxCount()).toBe(1);
  });
});
