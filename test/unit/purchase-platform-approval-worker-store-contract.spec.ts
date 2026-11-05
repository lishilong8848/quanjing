import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import type { PurchasePlatformIdentityProof } from '../../server/modules/purchase-inventory/purchase-platform-identity-proof';
import type { PlatformApprovalPersistedAction } from '../../server/modules/purchase-inventory/purchase-platform-approval-plan';
import { createPlatformApprovalCoordinator, type PlatformApprovalReadback } from '../../server/modules/purchase-inventory/purchase-platform-approval-coordinator';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

const crypto = require('node:crypto') as typeof import('node:crypto');
const now = new Date('2026-10-26T00:00:00Z'), actor = 'ou_manager';
const identity: PurchasePlatformIdentityProof = Object.freeze({ source: 'platform', actorAccountId: 'person', actorAuthorizationVersion: 1, actorDisplayName: '合成人员', subjectAccountId: 'person', subjectAuthorizationVersion: 1, subjectDisplayName: '合成人员', sessionFamilyFingerprint: 'x'.repeat(43), expiresAt: Date.parse('2027-01-01T00:00:00Z') });

describe('platform approval: real ledger worker contract (not registered)', () => {
  let directory: string, owner: string, path: string, store: PurchaseWorkflowStore;
  beforeEach(async () => {
    directory = mkdtempSync(join(realpathSync(tmpdir()), 'platform-approval-contract-')); owner = randomUUID();
    writeFileSync(join(directory, '.owner'), owner, { flag: 'wx' }); path = join(directory, 'ledger.json');
    store = new PurchaseWorkflowStore(path); await store.onModuleInit();
    for (const n of [1, 2]) {
      const batchId = `purchase-batch-${n}`, recordId = `recItem${n}`;
      await store.registerManagerApprovalBatch({ approvalBatchId: batchId, recipientOpenId: actor, requesterOpenId: 'ou_requester', recordIds: [recordId] }, now);
      const context = serializePurchaseManagerBatchApprovalCardContext({ version: 3, approvalBatchId: batchId, requesterOpenId: 'ou_requester', requesterName: '申请人', building: 'C楼', requestCode: 'TEST', expectedDeliveryAt: null, createdAt: null,
        items: [{ executionRecordId: recordId, title: '合成', specification: '/', quantity: '1', unit: '个', amount: '1', status: 'pending', choice: '', rejectionReason: '' }] });
      const task = (await store.takeNextManagerApprovalNotification(now))!;
      await store.markManagerApprovalBatchSendStarted(task.key, task.claimToken, context, now);
      await store.completeManagerApprovalBatchRequestAndRegisterCard(task.key, task.claimToken, { messageId: `om_card_${n}` }, now);
    }
  });
  afterEach(async () => {
    jest.restoreAllMocks(); await store.onModuleDestroy();
    if (dirname(resolve(directory)).toLowerCase() !== realpathSync(tmpdir()).toLowerCase() || !basename(directory).startsWith('platform-approval-contract-') || readFileSync(join(directory, '.owner'), 'utf8') !== owner) throw new Error('Synthetic fixture ownership mismatch');
    rmSync(directory, { recursive: true, force: false });
  });
  const claim = (n: number, requestId = `request_id_${n}_1234567890`) => store.claimPlatformApprovalItem({ approvalBatchId: `purchase-batch-${n}`,
    record: { recordId: `recItem${n}`, status: '未开始（待审批）', building: 'C楼', specialty: '电气' },
    request: { requestId, recordId: `recItem${n}`, choice: 'reject', rejectionReason: '合成驳回' }, identity, lifecycleReady: false }, () => true, now);

  it('uses server CSPRNG for distinct action IDs; retry and restart keep the original ID and trusted acceptance time', async () => {
    const random = jest.spyOn(crypto, 'randomBytes');
    const fixed = 1_795_000_000_000; jest.spyOn(Date, 'now').mockReturnValue(fixed);
    const first = await claim(1), second = await claim(2);
    expect(first.kind).toBe('claim'); expect(second.kind).toBe('claim');
    const a = first.action as PlatformApprovalPersistedAction, b = second.action as PlatformApprovalPersistedAction;
    expect(a.serverActionId).toMatch(/^pa_[A-Za-z0-9_-]{43}$/); expect(b.serverActionId).toMatch(/^pa_[A-Za-z0-9_-]{43}$/);
    expect(a.serverActionId).not.toBe(b.serverActionId); expect(random.mock.calls.filter(args => args[0] === 32)).toHaveLength(2);
    expect(a.serverActionId).not.toContain('request_id'); expect(a.acceptedAtMs).toBe(fixed);
    const replay = await claim(1); expect(replay.kind).toBe('replay');
    expect(replay.action).toMatchObject({ serverActionId: a.serverActionId, acceptedAtMs: a.acceptedAtMs });
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(path); await store.onModuleInit();
    const replayAfterRestart = await claim(1); expect(replayAfterRestart.kind).toBe('replay');
    expect(replayAfterRestart.action).toMatchObject({ serverActionId: a.serverActionId, acceptedAtMs: a.acceptedAtMs });
    expect(random.mock.calls.filter(args => args[0] === 32)).toHaveLength(2);
  });
  it('does not accept one request ID for two different records', async () => {
    const requestId = 'same_request_1234567890'; await claim(1, requestId);
    await expect(claim(2, requestId)).rejects.toThrow();
    expect((await store.findManagerApprovalBatch('purchase-batch-2'))!.items[0]!.status).toBe('pending');
  });
  it('rejects a server random-ID collision before persisting the second claim', async () => {
    jest.spyOn(crypto, 'randomBytes').mockImplementation(((size: number) => Buffer.alloc(size, 3)) as never);
    await claim(1); await expect(claim(2)).rejects.toThrow('标识冲突');
    expect((await store.findManagerApprovalBatch('purchase-batch-2'))!.items[0]!.status).toBe('pending');
  });
  it('serializes worker leases and fences an expired worker', async () => {
    const at = Date.now(), clock = jest.spyOn(Date, 'now').mockReturnValue(at);
    const accepted = await claim(1), eventId = accepted.action.eventId, port = store.platformApprovalWorkerPort();
    const [first, second] = await Promise.all([port.claimPending(eventId), port.claimPending(eventId)]);
    const job = first || second; expect([first, second].filter(Boolean)).toHaveLength(1); expect(job?.kind).toBe('dispatch');
    clock.mockReturnValue(at + 60_001); const next = await port.claimPending(eventId); expect(next?.kind).toBe('dispatch');
    await expect(port.beginDispatch(job!, undefined, 'a'.repeat(64))).rejects.toThrow();
    expect(await port.beginDispatch(next!, undefined, 'a'.repeat(64))).toBe(true);
  });
  it('persists a dispatch fence across restart and permits only reconciliation after a lease expires', async () => {
    const at = Date.now(), clock = jest.spyOn(Date, 'now').mockReturnValue(at);
    const accepted = await claim(1), eventId = accepted.action.eventId; let port = store.platformApprovalWorkerPort();
    const job = (await port.claimPending(eventId))!; expect(await port.beginDispatch(job, undefined, 'a'.repeat(64))).toBe(true);
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(path); await store.onModuleInit(); port = store.platformApprovalWorkerPort();
    expect(await port.claimPending(eventId)).toBeNull();
    clock.mockReturnValue(at + 60_001); const recovered = (await port.claimPending(eventId))!; expect(recovered.kind).toBe('reconcile');
    expect(await port.beginDispatch(recovered, undefined, 'a'.repeat(64))).toBe(false);
    await expect(port.recordConfirmed(recovered, { actionId: 'platform_client_supplied_id', resultHash: 'b'.repeat(64) })).rejects.toThrow();
    await port.markUnknown(recovered, 'remote_result_unverified');
    const again = (await port.claimPending(eventId))!; expect(again.kind).toBe('reconcile');
    expect(await port.beginDispatch(again, undefined, 'a'.repeat(64))).toBe(false);
  });
  it('fails closed after restart if an already-dispatched work ledger is missing', async () => {
    const accepted = await claim(1), action = accepted.action as PlatformApprovalPersistedAction, port = store.platformApprovalWorkerPort();
    const job = (await port.claimPending(action.eventId))!; await port.beginDispatch(job, undefined, 'a'.repeat(64));
    await store.onModuleDestroy();
    const raw = JSON.parse(readFileSync(path, 'utf8')); delete raw.platformApprovalWork; writeFileSync(path, JSON.stringify(raw));
    store = new PurchaseWorkflowStore(path); await store.onModuleInit();
    await expect(store.platformApprovalWorkerPort().claimPending(action.eventId)).rejects.toThrow();
  });
  it('atomically completes only the confirmed legacy item and queues card refresh once', async () => {
    const accepted = await claim(1), action = accepted.action as PlatformApprovalPersistedAction, port = store.platformApprovalWorkerPort();
    const job = (await port.claimPending(action.eventId))!; await port.beginDispatch(job, undefined, 'a'.repeat(64));
    await port.recordConfirmed(job, { actionId: action.serverActionId, resultHash: 'b'.repeat(64) });
    const original = readFileSync(path);
    const write = jest.spyOn(store as unknown as { writeLifecycleRaw: (...args: unknown[]) => Promise<void> }, 'writeLifecycleRaw').mockRejectedValueOnce(new Error('synthetic disk error'));
    await expect(port.completeAndRefresh(job)).rejects.toThrow('synthetic disk error'); write.mockRestore();
    expect(readFileSync(path).equals(original)).toBe(true);
    await port.completeAndRefresh(job); await port.completeAndRefresh(job);
    expect((await store.findManagerApprovalBatch('purchase-batch-1'))!.items[0]!.status).toBe('rejected');
    expect((await store.findManagerApprovalBatch('purchase-batch-2'))!.items[0]!.status).toBe('pending');
    expect((await store.listNotifications({ kind: 'manager_batch_approval_refresh' })).filter(item => item.recipientOpenId === actor)).toHaveLength(1);
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(path); await store.onModuleInit();
    const done = (await store.platformApprovalWorkerPort().claimPending(action.eventId))!; expect(done.kind).toBe('done');
    await store.platformApprovalWorkerPort().completeAndRefresh(done);
    expect((await store.listNotifications({ kind: 'manager_batch_approval_refresh' })).filter(item => item.recipientOpenId === actor)).toHaveLength(1);
  });
  it('queues only existing lifecycle replica refreshes in the same completion transaction', async () => {
    const previous = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = 'cli_test';
    try {
      const batchId = 'purchase-lifecycle-3', recordId = 'recItem3', replica = { appId: 'cli_test', batchId, recipientOpenId: actor };
      await store.registerManagerApprovalBatch({ approvalBatchId: batchId, recipientOpenId: actor, requesterOpenId: 'ou_requester', recordIds: [recordId], flowVersion: 'lifecycle_v1' }, now,
        { appId: 'cli_test', recipients: [{ openId: actor, fullView: false }], authorityTargets: [{ recordId, target: { building: 'C楼', specialty: '电气' } }], authorize: () => {} });
      const context = serializePurchaseManagerBatchApprovalCardContext({ version: 3, approvalBatchId: batchId, requesterOpenId: 'ou_requester', requesterName: '申请人', building: 'C楼', requestCode: 'TEST', expectedDeliveryAt: null, createdAt: null,
        items: [{ executionRecordId: recordId, title: '合成', specification: '/', quantity: '1', unit: '个', amount: '1', status: 'pending', choice: '', rejectionReason: '' }] });
      const task = (await store.takeNextManagerApprovalNotification(now))!;
      await store.markManagerApprovalBatchSendStarted(task.key, task.claimToken, context, now);
      await store.completeManagerApprovalBatchRequestAndRegisterCard(task.key, task.claimToken, { messageId: 'om_card_3' }, now);
      const before = (await store.getLifecycleOutbox(replica))!;
      const accepted = await store.claimPlatformApprovalItem({ approvalBatchId: batchId, record: { recordId, status: '未开始（待审批）', building: 'C楼', specialty: '电气' },
        request: { requestId: 'request_lifecycle_123456', recordId, choice: 'reject', rejectionReason: '合成驳回' }, identity, lifecycleReady: true }, () => true, now);
      const action = accepted.action as PlatformApprovalPersistedAction, port = store.platformApprovalWorkerPort(), job = (await port.claimPending(action.eventId))!;
      await port.beginDispatch(job, undefined, 'a'.repeat(64)); await port.recordConfirmed(job, { actionId: action.serverActionId, resultHash: 'b'.repeat(64) });
      await port.completeAndRefresh(job);
      expect((await store.getLifecycleOutbox(replica))!.desiredRevision).toBeGreaterThan(before.desiredRevision);
      const raw = JSON.parse(readFileSync(path, 'utf8')); expect(raw.lifecycleOutbox.filter((row: any) => row.replica.batchId === batchId)).toHaveLength(1);
      expect((await store.findManagerApprovalBatch(batchId))!.items[0]!.status).toBe('rejected');
    } finally { if (previous === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = previous; }
  });
  it('rejects wrong scope, stage or unauthorized access before claiming', async () => {
    const base = { approvalBatchId: 'purchase-batch-1', record: { recordId: 'recItem1', status: '未开始（待审批）', building: 'C楼', specialty: '电气' },
      request: { requestId: 'request_scope_123456789', recordId: 'recItem1', choice: 'reject' as const, rejectionReason: '合成驳回' }, identity, lifecycleReady: false };
    await expect(store.claimPlatformApprovalItem({ ...base, record: { ...base.record, status: '审批通过（待下单）' } }, () => true, now)).rejects.toThrow();
    await expect(store.claimPlatformApprovalItem(base, () => { throw new Error('scope denied'); }, now)).rejects.toThrow();
    expect((await store.findManagerApprovalBatch('purchase-batch-1'))!.items[0]!.status).toBe('pending');
  });
  it('keeps non-Feishu account audit and does not invent an actor Feishu ID', async () => {
    const accepted = await claim(1), action = accepted.action as PlatformApprovalPersistedAction, port = store.platformApprovalWorkerPort(), job = (await port.claimPending(action.eventId))!;
    await port.beginDispatch(job, undefined, 'a'.repeat(64)); await port.recordConfirmed(job, { actionId: action.serverActionId, resultHash: 'b'.repeat(64) }); await port.completeAndRefresh(job);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw.platformApprovalClaims[0]).toMatchObject({ actorAccountId: 'person', subjectAccountId: 'person', actorDisplayName: '合成人员' });
    expect(raw.platformApprovalClaims[0]).not.toHaveProperty('actorFeishuOpenId');
    expect((await store.findManagerApprovalBatch('purchase-batch-1'))!.items[0]!.actorOpenId).toBe('');
  });
  it('runs a real ledger and coordinator across lost write response without issuing a second write', async () => {
    const accepted = await claim(1), action = accepted.action as PlatformApprovalPersistedAction;
    let row: PlatformApprovalReadback = { recordId: 'recItem1', requestCode: 'TEST', status: '未开始（待审批）', itemName: '合成', building: 'C楼', specialty: '电气', requesterOpenId: 'ou_requester', requesterName: '申请人', purchaserOpenId: '', purchaserName: '', purchaseMethod: '综合采购', rejectionReason: '', requestedQuantity: 1, actualQuantity: null, actualAmount: null, approvalCompleted: false, warehouseConfirmed: false, purchaseCompleted: false, receiptConfirmed: false, signer: '', receiptTime: null, receiptPhotoTokens: [], invoiceTokens: [], approvalBatchId: 'purchase-batch-1' };
    const gateway = { readRecord: jest.fn(async () => structuredClone(row)), resolvePurchaser: jest.fn(), writeRecord: jest.fn(async (_id: string, fields: Record<string, unknown>) => {
      row = { ...row, status: String(fields['采购流程']), purchaseMethod: fields['1️⃣物品采购方式'] as PurchaseWorkflowRecord['purchaseMethod'], rejectionReason: String(fields['驳回原因']), approvalActionId: String(fields['采购审批动作标识']),
        approvalWorkflowStatus: String(fields['采购工作流状态']), platformApprovalTimeMs: Number(fields['采购审批时间']), platformCurrentApproverOpenIds: [] };
      throw new Error('synthetic response lost');
    }) };
    const coordinator = createPlatformApprovalCoordinator(store.platformApprovalWorkerPort(), gateway);
    expect(await coordinator.run(action.eventId)).toBe('manual_reconciliation');
    expect(await coordinator.run(action.eventId)).toBe('completed');
    expect(gateway.writeRecord).toHaveBeenCalledTimes(1); expect(row.approvalActionId).toBe(action.serverActionId);
    expect((await store.findManagerApprovalBatch('purchase-batch-1'))!.items[0]!.status).toBe('rejected');
  });
});
