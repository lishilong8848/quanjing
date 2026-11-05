import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import type { PurchaseLifecycleFormBinding } from '../../server/modules/purchase-inventory/purchase-lifecycle-form';

describe('purchase lifecycle form credentials', () => {
  const appId = 'cli_test_app', batchId = 'purchase-application-token', actorOpenId = 'ou_manager', messageId = 'om_test';
  const identity = { appId, actorOpenId, messageId };
  const replica = { appId, batchId, recipientOpenId: actorOpenId };
  const binding: PurchaseLifecycleFormBinding = { action: 'submit_item_reject', role: 'manager', approvalBatchId: batchId, executionRecordId: 'rec_one', flowVersion: 'lifecycle_v1', cardRevision: 1 };
  const now = Date.now();
  let directory: string, file: string, store: PurchaseWorkflowStore, previous: string | undefined;
  beforeEach(async () => {
    previous = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = appId;
    directory = await mkdtemp(join(tmpdir(), 'purchase-lifecycle-form-')); file = join(directory, 'ledger.json');
    store = new PurchaseWorkflowStore(file); await store.onModuleInit();
    await store.registerManagerApprovalBatch({ approvalBatchId: batchId, recipientOpenId: actorOpenId, requesterOpenId: 'ou_requester', recordIds: ['rec_one'], flowVersion: 'lifecycle_v1' }, undefined, { appId, recipients: [{ openId: actorOpenId, fullView: false }], authorityTargets: [{ recordId: 'rec_one', target: { building: 'H楼' } }], authorize: () => {} });
    const context = serializePurchaseManagerBatchApprovalCardContext({ version: 3, approvalBatchId: batchId, requesterOpenId: 'ou_requester', requesterName: '申请人', building: 'H楼', requestCode: 'CG-TEST', expectedDeliveryAt: '2026-01-10', createdAt: '2026-01-01', items: [{ executionRecordId: 'rec_one', title: '测试', specification: '/', quantity: '1', unit: '个', amount: '1', status: 'pending', choice: '', rejectionReason: '' }] });
    const notification = await store.takeNextManagerApprovalNotification(new Date(now + 1000));
    await store.markManagerApprovalBatchSendStarted(notification!.key, notification!.claimToken, context, new Date(now + 1000));
    await store.completeManagerApprovalBatchRequestAndRegisterCard(notification!.key, notification!.claimToken, { messageId }, new Date(now + 1000));
    const attempt = await store.beginLifecycleDelivery(replica, now, 1, 1, () => {});
    await store.markLifecycleDeliveryDispatched(replica, attempt.entry.attemptToken, () => {});
    await store.completeLifecycleDelivery(replica, attempt.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: attempt.entry.replica.uuid, messageId, sentAtMs: now } });
  });
  afterEach(async () => { await store.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); if (previous === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = previous; });

  it('persists only hashes and binds lookup to identity and expiry across restart', async () => {
    const token = await store.issueLifecycleFormCredential(identity, binding, () => {}, now);
    const bytes = await readFile(file, 'utf8'); expect(bytes).not.toContain(token);
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(file); await store.onModuleInit();
    expect(await store.lookupLifecycleFormCredential(token, identity, now + 1)).toEqual(binding);
    await expect(store.lookupLifecycleFormCredential(token, { ...identity, actorOpenId: 'ou_other' }, now + 1)).rejects.toThrow();
    await expect(store.lookupLifecycleFormCredential(token, { ...identity, messageId: 'om_other' }, now + 1)).rejects.toThrow();
    await expect(store.lookupLifecycleFormCredential(token, identity, now + 3600000)).rejects.toThrow();
    await expect(store.issueLifecycleFormCredential(identity, binding, () => { throw new Error('revoked'); }, now)).rejects.toThrow('revoked');
  });

  it('consumes in the same ledger write as the business claim and prevents a second event', async () => {
    const token = await store.issueLifecycleFormCredential(identity, binding, () => {}, now);
    const claim = { approvalBatchId: batchId, actorOpenId, messageId, executionRecordId: 'rec_one', eventId: 'event_1', rejectionReason: '原因', lifecycle: { appId, cardRevision: 1, formToken: token } };
    expect((await store.claimManagerApprovalBatchItemReject(claim, now + 1, () => {})).claimed).toBe(true);
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    expect(persisted.lifecycleFormCredentials[0].consumedByEventId).toBe('event_1');
    expect(persisted.managerApprovalBatchActions).toHaveLength(1);
    await expect(store.claimManagerApprovalBatchItemReject({ ...claim, eventId: 'event_2' }, now + 2, () => {})).rejects.toThrow();
    expect(JSON.parse(await readFile(file, 'utf8')).managerApprovalBatchActions).toHaveLength(1);
  });

  it('does not consume a credential if the atomic ledger write fails', async () => {
    const token = await store.issueLifecycleFormCredential(identity, binding, () => {}, now);
    const claim = { approvalBatchId: batchId, actorOpenId, messageId, executionRecordId: 'rec_one', eventId: 'event_retry', rejectionReason: '原因', lifecycle: { appId, cardRevision: 1, formToken: token } };
    const before = await readFile(file, 'utf8');
    const spy = jest.spyOn(store as unknown as { write: (value: unknown) => Promise<void> }, 'write').mockRejectedValueOnce(new Error('disk failure'));
    await expect(store.claimManagerApprovalBatchItemReject(claim, now + 1, () => {})).rejects.toThrow('disk failure');
    spy.mockRestore();
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await store.claimManagerApprovalBatchItemReject(claim, now + 2, () => {})).claimed).toBe(true);
  });

  it('serializes two distinct submissions and rejects stale roles, message and revision', async () => {
    const token = await store.issueLifecycleFormCredential(identity, binding, () => {}, now);
    const claim = { approvalBatchId: batchId, actorOpenId, messageId, executionRecordId: 'rec_one', rejectionReason: '原因', lifecycle: { appId, cardRevision: 1, formToken: token } };
    await expect(store.claimManagerApprovalBatchItemReject({ ...claim, messageId: 'om_other', eventId: 'forged_message' }, now + 1, () => {})).rejects.toThrow();
    await expect(store.claimManagerApprovalBatchItemReject({ ...claim, lifecycle: { ...claim.lifecycle, cardRevision: 2 }, eventId: 'stale_revision' }, now + 1, () => {})).rejects.toThrow();
    await expect(store.claimManagerApprovalBatchItemReject({ ...claim, executionRecordId: 'rec_other', eventId: 'other_record' }, now + 1, () => {})).rejects.toThrow();
    const race = await Promise.allSettled(['one', 'two'].map(eventId => store.claimManagerApprovalBatchItemReject({ ...claim, eventId }, now + 2, () => {})));
    expect(race.filter(result => result.status === 'fulfilled' && result.value.claimed)).toHaveLength(1);
    expect(JSON.parse(await readFile(file, 'utf8')).managerApprovalBatchActions).toHaveLength(1);
  });
});
