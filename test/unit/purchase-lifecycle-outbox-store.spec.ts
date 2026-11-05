import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';

describe('purchase lifecycle durable outbox', () => {
  let directory: string, file: string, store: PurchaseWorkflowStore;
  let previousAppId: string | undefined;
  const identity = { appId: 'cli_test_app', batchId: 'purchase-application-outbox', recipientOpenId: 'ou_manager' };
  const targets = (...recordIds: string[]) => recordIds.map(recordId => ({ recordId, target: { building: 'H楼' as const } }));
  const now = Date.now() - 1000;
  const allow = (batch: { approvalBatchId: string }) => { if (batch.approvalBatchId !== identity.batchId) throw new Error('not authorized'); };
  beforeEach(async () => {
    previousAppId = process.env.FEISHU_APP_ID;
    process.env.FEISHU_APP_ID = identity.appId;
    directory = await mkdtemp(join(tmpdir(), 'purchase-lifecycle-outbox-'));
    file = join(directory, 'ledger.json');
    store = new PurchaseWorkflowStore(file);
    await store.onModuleInit();
    await store.registerManagerApprovalBatch({ approvalBatchId: identity.batchId, recipientOpenId: identity.recipientOpenId, requesterOpenId: 'ou_requester', recordIds: ['rec_one'], flowVersion: 'lifecycle_v1' }, undefined, { appId: identity.appId, recipients: [{ openId: identity.recipientOpenId, fullView: false }], authorityTargets: targets('rec_one'), authorize: () => {} });
  });
  afterEach(async () => { await store.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); if (previousAppId === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = previousAppId; });

  it('keeps original legacy fields, and merges multiple roles by recipient', async () => {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    raw.futureUnrecognized = { value: 'preserve' };
    await writeFile(file, JSON.stringify(raw));
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    await store.enqueueLifecycleRefresh({ ...identity }, 2, allow);
    const updated = JSON.parse(await readFile(file, 'utf8'));
    expect(updated.futureUnrecognized).toEqual(raw.futureUnrecognized);
    expect(updated.notifications).toEqual(raw.notifications);
    expect(updated.managerApprovalBatches).toEqual(raw.managerApprovalBatches);
    expect(updated.lifecycleOutbox).toHaveLength(1);
    expect(updated.lifecycleOutbox[0].desiredRevision).toBe(2);
  });

  it('serializes concurrent claims and preserves unknown outcome across restart', async () => {
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    const results = await Promise.all([store.beginLifecycleDelivery(identity, now, 1, 1, allow), store.beginLifecycleDelivery(identity, now, 1, 1, allow)]);
    expect(results.map(row => row.action).sort()).toEqual(['reconcile', 'send']);
    await store.onModuleDestroy();
    store = new PurchaseWorkflowStore(file);
    await store.onModuleInit();
    expect((await store.beginLifecycleDelivery(identity, now + 1, 1, 1, allow)).action).toBe('reconcile');
  });

  it('fences stale receipts and preserves a newer queued revision during in-flight delivery', async () => {
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    const first = await store.beginLifecycleDelivery(identity, now, 1, 1, allow);
    await store.enqueueLifecycleRefresh(identity, 3, allow);
    const receipt = { source: 'feishu_message_readback' as const, uuid: first.entry.replica.uuid, messageId: 'om_first', sentAtMs: now };
    await expect(store.completeLifecycleDelivery(identity, 'wrong', { kind: 'send', receipt })).rejects.toThrow();
    await store.markLifecycleDeliveryDispatched(identity, first.entry.attemptToken, allow);
    await store.completeLifecycleDelivery(identity, first.entry.attemptToken, { kind: 'send', receipt });
    const update = await store.beginLifecycleDelivery(identity, now + 1, 3, 1, allow);
    expect(update.action).toBe('update');
    expect(update.entry.replica).toMatchObject({ messageId: 'om_first', pendingRevision: 3 });
    await store.markLifecycleDeliveryDispatched(identity, update.entry.attemptToken, allow);
    await expect(store.completeLifecycleDelivery(identity, update.entry.attemptToken, { kind: 'update', messageId: 'om_other', revision: 3 })).rejects.toThrow();
    await store.completeLifecycleDelivery(identity, update.entry.attemptToken, { kind: 'update', messageId: 'om_first', revision: 3 });
    expect((await store.beginLifecycleDelivery(identity, now + 2, 3, 1, allow)).action).toBe('none');
  });

  it('resumes only after expiry with new UUID and preserves predecessor history', async () => {
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    const first = await store.beginLifecycleDelivery(identity, now, 1, 1, allow);
    await store.markLifecycleDeliveryDispatched(identity, first.entry.attemptToken, allow);
    await store.completeLifecycleDelivery(identity, first.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: first.entry.replica.uuid, messageId: 'om_first', sentAtMs: now } });
    await store.enqueueLifecycleRefresh(identity, 2, allow);
    const next = await store.beginLifecycleDelivery(identity, now + 14 * 86400000 + 1, 2, 1, allow);
    expect(next.action).toBe('send');
    expect(next.entry.replica).toMatchObject({ generation: 2, predecessorMessageId: 'om_first', state: 'send_unknown' });
    expect(next.entry.replica.uuid).not.toBe(first.entry.replica.uuid);
    expect(next.entry.history).toEqual([{ generation: 1, messageId: 'om_first', sentAtMs: now, appliedRevision: 1 }]);
    expect((await store.beginLifecycleDelivery(identity, now + 14 * 86400000 + 2, 2, 1, allow)).action).toBe('reconcile');
  });

  it('queues an idle expired copy once only after current authorization, and survives restart', async () => {
    const initial = await store.beginLifecycleDelivery(identity, now, 1, 1, allow);
    await store.markLifecycleDeliveryDispatched(identity, initial.entry.attemptToken, allow);
    await store.completeLifecycleDelivery(identity, initial.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: initial.entry.replica.uuid, messageId: 'om_idle', sentAtMs: now } });
    const expired = now + 14 * 86400000 + 1;
    expect(await store.listExpiredLifecycleContinuations(10, expired - 1)).toHaveLength(0);
    const [candidate] = await store.listExpiredLifecycleContinuations(10, expired);
    const expected = { generation: candidate!.generation, messageId: candidate!.messageId, sentAtMs: candidate!.sentAtMs, revision: candidate!.revision };
    const before = await readFile(file, 'utf8');
    await expect(store.queueExpiredLifecycleContinuation(identity, expected, expired, () => { throw new Error('permission revoked'); })).rejects.toThrow('permission revoked');
    expect(await readFile(file, 'utf8')).toBe(before);
    const results = await Promise.allSettled([store.queueExpiredLifecycleContinuation(identity, expected, expired, () => {}), store.queueExpiredLifecycleContinuation(identity, expected, expired, () => {})]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(file); await store.onModuleInit();
    expect((await store.getLifecycleOutbox(identity))?.desiredRevision).toBe(2);
    expect(await store.listExpiredLifecycleContinuations(10, expired)).toHaveLength(0);
    const continuation = await store.beginLifecycleDelivery(identity, expired, 2, 1, allow);
    expect(continuation.action).toBe('send');
    expect((await store.listExpiredLifecycleContinuations(10, expired)).length).toBe(0);
  });

  it('recovers only expired prepared attempts with a token fence, never a dispatched unknown', async () => {
    const prepared = await store.beginLifecycleDelivery(identity, now, 1, 1, allow);
    expect(await store.listExpiredPreparedLifecycleDeliveries(10, now + 119999)).toHaveLength(0);
    await expect(store.recoverExpiredPreparedLifecycleDelivery(identity, prepared.entry.attemptToken, now + 119999)).rejects.toThrow();
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(file); await store.onModuleInit();
    expect(await store.listExpiredPreparedLifecycleDeliveries(10, now + 120000)).toHaveLength(1);
    const race = await Promise.allSettled([store.recoverExpiredPreparedLifecycleDelivery(identity, prepared.entry.attemptToken, now + 120000), store.markLifecycleDeliveryDispatched(identity, prepared.entry.attemptToken, allow)]);
    expect(race.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const state = await store.getLifecycleOutbox(identity);
    if (state!.dispatchPhase === 'dispatch_started') {
      await expect(store.recoverExpiredPreparedLifecycleDelivery(identity, prepared.entry.attemptToken, now + 999999)).rejects.toThrow();
      expect((await store.getLifecycleOutbox(identity))?.replica.state).toBe('send_unknown');
    } else {
      await expect(store.markLifecycleDeliveryDispatched(identity, prepared.entry.attemptToken, allow)).rejects.toThrow();
      const next = await store.beginLifecycleDelivery(identity, now + 120001, 1, 1, allow);
      await store.markLifecycleDeliveryDispatched(identity, next.entry.attemptToken, allow);
      await expect(store.recoverExpiredPreparedLifecycleDelivery(identity, next.entry.attemptToken, now + 999999)).rejects.toThrow();
      expect((await store.getLifecycleOutbox(identity))?.replica.state).toBe('send_unknown');
    }
  });

  it('refuses unauthorized or corrupted data without writing anything', async () => {
    const before = await readFile(file, 'utf8');
    await expect(store.enqueueLifecycleRefresh(identity, 1, () => { throw new Error('denied'); })).rejects.toThrow('denied');
    expect(await readFile(file, 'utf8')).toBe(before);
    const raw = JSON.parse(before);
    raw.lifecycleOutbox = [{ replica: { ...identity }, desiredRevision: 1, attemptToken: '', history: [] }];
    await writeFile(file, JSON.stringify(raw));
    const corrupt = await readFile(file, 'utf8');
    await expect(store.enqueueLifecycleRefresh(identity, 1, allow)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(corrupt);
  });

  it('rejects async or non-void authorization without a write or unhandled rejection', async () => {
    const before = await readFile(file, 'utf8');
    await expect(store.enqueueLifecycleRefresh(identity, 1, async () => { throw new Error('revoked asynchronously'); })).rejects.toThrow('锁内同步完成');
    await expect(store.enqueueLifecycleRefresh(identity, 1, () => false)).rejects.toThrow('锁内同步完成');
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('preserves lifecycle outbox across other store writes and rejects legacy version switching', async () => {
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    const before = await store.getLifecycleOutbox(identity);
    await store.registerManagerApprovalBatch({ approvalBatchId: 'purchase-application-other', recipientOpenId: 'ou_another', requesterOpenId: 'ou_requester', recordIds: ['rec_two'] });
    expect(await store.getLifecycleOutbox(identity)).toEqual(before);
    const legacyIdentity = { ...identity, batchId: 'purchase-application-other', recipientOpenId: 'ou_another' };
    await expect(store.enqueueLifecycleRefresh(legacyIdentity, 1, () => {})).rejects.toThrow('原有采购批次不能切换全流程卡片');
    await expect(store.registerManagerApprovalBatch({ approvalBatchId: 'purchase-application-other', recipientOpenId: 'ou_another', requesterOpenId: 'ou_requester', recordIds: ['rec_two'], flowVersion: 'lifecycle_v1' })).rejects.toThrow();
    expect((await store.findManagerApprovalBatch('purchase-application-other'))?.flowVersion).toBeUndefined();
  });

  it('fails closed on invalid lifecycle batch instead of dropping it', async () => {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    raw.managerApprovalBatches[0].items = [];
    await writeFile(file, JSON.stringify(raw));
    const before = await readFile(file, 'utf8');
    await expect(store.enqueueLifecycleRefresh(identity, 1, allow)).rejects.toThrow('采购全流程批次账本损坏');
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('refuses to enqueue before the purchase batch ledger is initialized', async () => {
    const emptyStore = new PurchaseWorkflowStore(join(directory, 'empty-ledger.json'));
    await emptyStore.onModuleInit();
    try {
      expect(await emptyStore.getLifecycleOutbox(identity)).toBeNull();
      await expect(emptyStore.enqueueLifecycleRefresh(identity, 1, allow)).rejects.toThrow('采购批次账本尚未建立');
    } finally { await emptyStore.onModuleDestroy(); }
  });

  it('atomically deduplicates authorized initial managers and readonly observers', async () => {
    const input = { approvalBatchId: 'purchase-application-initial', recipientOpenId: 'ou_manager2', requesterOpenId: 'ou_requester', recordIds: ['rec_second'], flowVersion: 'lifecycle_v1' as const,
      managers: [{ openId: 'ou_manager2', name: '经理' }, { openId: 'ou_observer1', name: '兼任经理' }] };
    const seen: string[] = [];
    const registration = { appId: identity.appId, recipients: [{ openId: 'ou_manager2', fullView: false }, { openId: 'ou_observer1', fullView: false }, { openId: 'ou_observer1', fullView: true }, { openId: 'ou_observer2', fullView: true }], authorityTargets: targets('rec_second'), authorize: (person: { openId: string }) => { seen.push(person.openId); } };
    const created = await store.registerManagerApprovalBatch(input, undefined, registration);
    expect(created.created).toBe(true);
    expect(seen.sort()).toEqual(['ou_manager2', 'ou_observer1', 'ou_observer2']);
    expect((await store.getLifecycleOutbox({ ...identity, batchId: input.approvalBatchId, recipientOpenId: 'ou_observer1' }))?.fullView).toBe(true);
    expect((await store.getLifecycleOutbox({ ...identity, batchId: input.approvalBatchId, recipientOpenId: 'ou_manager2' }))?.fullView).toBeUndefined();
    const bytes = await readFile(file, 'utf8');
    expect((await store.registerManagerApprovalBatch(input, undefined, registration)).created).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(bytes);
    await expect(store.registerManagerApprovalBatch(input, undefined, { ...registration, recipients: registration.recipients.filter(person => person.openId !== 'ou_observer2') })).rejects.toThrow('快照冲突');
    expect(await readFile(file, 'utf8')).toBe(bytes);
  });

  it('rejects missing, forged or async initial authorization without creating a batch or message', async () => {
    const input = { approvalBatchId: 'purchase-application-denied', recipientOpenId: 'ou_newmanager', requesterOpenId: 'ou_requester', recordIds: ['rec_denied'], flowVersion: 'lifecycle_v1' as const };
    const before = await readFile(file, 'utf8');
    await expect(store.registerManagerApprovalBatch(input)).rejects.toThrow();
    await expect(store.registerManagerApprovalBatch(input, undefined, { appId: identity.appId, recipients: [{ openId: 'ou_newmanager', fullView: false }, { openId: 'ou_intruder', fullView: false }], authorityTargets: targets('rec_denied'), authorize: () => {} })).rejects.toThrow();
    await expect(store.registerManagerApprovalBatch(input, undefined, { appId: identity.appId, recipients: [{ openId: 'ou_newmanager', fullView: false }, { openId: 'ou_intruder', fullView: true }], authorityTargets: targets('rec_denied'), authorize: person => { if (person.openId === 'ou_intruder') throw new Error('observer not authorized'); } })).rejects.toThrow('observer not authorized');
    await expect(store.registerManagerApprovalBatch(input, undefined, { appId: identity.appId, recipients: [{ openId: 'ou_newmanager', fullView: false }], authorityTargets: targets('rec_denied'), authorize: async () => { throw new Error('denied'); } })).rejects.toThrow('锁内同步完成');
    await expect(store.registerManagerApprovalBatch(input, undefined, { appId: identity.appId, recipients: [{ openId: 'ou_newmanager', fullView: false }], authorityTargets: [], authorize: () => {} })).rejects.toThrow('范围不完整');
    await expect(store.registerManagerApprovalBatch(input, undefined, { appId: identity.appId, recipients: [{ openId: 'ou_newmanager', fullView: false }], authorityTargets: targets('rec_other'), authorize: () => {} })).rejects.toThrow('范围冲突');
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await store.findManagerApprovalBatch(input.approvalBatchId)).toBeNull();
  });

  it('lists ready and uncertain deliveries separately without returning card contents', async () => {
    const other = { ...identity, recipientOpenId: 'ou_other' };
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    await store.enqueueLifecycleRefresh(other, 1, allow);
    const pending = await store.beginLifecycleDelivery(identity, now, 1, 1, allow);
    expect(await store.listPendingLifecycleDeliveries(1)).toEqual([{ identity: other, desiredRevision: 1, desiredPage: 1, desiredView: { kind: 'list' }, status: 'ready' }]);
    expect(await store.listPendingLifecycleDeliveries(100, 'needs_reconciliation')).toEqual([{ identity, desiredRevision: 1, desiredPage: 1, desiredView: { kind: 'list' }, status: 'needs_reconciliation' }]);
    await store.markLifecycleDeliveryDispatched(identity, pending.entry.attemptToken, allow);
    await store.completeLifecycleDelivery(identity, pending.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: pending.entry.replica.uuid, messageId: 'om_first', sentAtMs: now } });
    expect(await store.listPendingLifecycleDeliveries(100, 'needs_reconciliation')).toEqual([]);
    expect(await store.listPendingLifecycleDeliveries(100)).toEqual([{ identity: other, desiredRevision: 1, desiredPage: 1, desiredView: { kind: 'list' }, status: 'ready' }]);
    await expect(store.listPendingLifecycleDeliveries(101)).rejects.toThrow();
  });

  it('binds manager claims to the currently delivered lifecycle card under the claim lock', async () => {
    const previousApp = process.env.FEISHU_APP_ID;
    process.env.FEISHU_APP_ID = identity.appId;
    try {
      const context = serializePurchaseManagerBatchApprovalCardContext({ version: 3, approvalBatchId: identity.batchId, requesterOpenId: 'ou_requester', requesterName: '申请人', building: 'H楼', requestCode: 'CG-TEST', expectedDeliveryAt: '2026-01-10', createdAt: '2026-01-01', items: [{ executionRecordId: 'rec_one', title: '测试', specification: '/', quantity: '1', unit: '个', amount: '1', status: 'pending', choice: '', rejectionReason: '' }] });
      const deliveryTime = new Date(Date.now() + 1000);
      const notification = await store.takeNextManagerApprovalNotification(deliveryTime);
      await store.markManagerApprovalBatchSendStarted(notification!.key, notification!.claimToken, context, deliveryTime);
      await store.completeManagerApprovalBatchRequestAndRegisterCard(notification!.key, notification!.claimToken, { messageId: 'om_first' }, deliveryTime);
      await store.enqueueLifecycleRefresh(identity, 1, allow);
      const attempt = await store.beginLifecycleDelivery(identity, now, 1, 1, allow);
      await store.markLifecycleDeliveryDispatched(identity, attempt.entry.attemptToken, allow);
      await store.completeLifecycleDelivery(identity, attempt.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: attempt.entry.replica.uuid, messageId: 'om_first', sentAtMs: now } });
      const callback = { approvalBatchId: identity.batchId, actorOpenId: identity.recipientOpenId, messageId: 'om_first', lifecycle: { appId: identity.appId, cardRevision: 1 }, eventId: 'evt_1', choice: 'comprehensive' as const };
      await expect(store.claimManagerApprovalBatchPendingApproval({ ...callback, lifecycle: undefined }, new Date(now), () => {})).rejects.toThrow();
      await expect(store.claimManagerApprovalBatchPendingApproval({ ...callback, lifecycle: { appId: identity.appId, cardRevision: 2 } }, new Date(now), () => {})).rejects.toThrow();
      await expect(store.claimManagerApprovalBatchPendingApproval({ ...callback, messageId: 'om_other' }, new Date(now), () => {})).rejects.toThrow();
      await expect(store.claimManagerApprovalBatchPendingApproval(callback, new Date(now))).rejects.toThrow('缺少当前职责校验');
      await expect(store.claimManagerApprovalBatchPendingApproval(callback, new Date(now), () => { throw new Error('revoked'); })).rejects.toThrow('revoked');
      expect((await store.claimManagerApprovalBatchPendingApproval(callback, new Date(now), () => {})).claimed).toBe(true);
      expect((await store.claimManagerApprovalBatchPendingApproval(callback, new Date(now), () => {})).claimed).toBe(false);
      const action = await store.takeNextManagerApprovalBatchAction(new Date(now + 1));
      await expect(store.completeManagerApprovalBatchActionRecord(action!.key, action!.claimToken, 'rec_one', { purchaserOpenId: 'ou_buyer', purchaserName: '采购员', authorityTarget: { building: 'A楼' } }, new Date(now + 2))).rejects.toThrow('楼栋或专业已变化');
      await store.completeManagerApprovalBatchActionRecord(action!.key, action!.claimToken, 'rec_one', { purchaserOpenId: 'ou_buyer', purchaserName: '采购员', authorityTarget: { building: 'H楼' } }, new Date(now + 2));
      expect((await store.getLifecycleOutbox(identity))?.desiredRevision).toBe(2);
      const closed = JSON.parse(await readFile(file, 'utf8'));
      expect(closed.lifecycleOutbox[0].desiredRevision).toBe(2);
      expect(closed.managerApprovalBatches[0].items[0].status).toBe('approved');
      await expect(store.completeManagerApprovalBatchActionRecord(action!.key, action!.claimToken, 'rec_one', { purchaserOpenId: 'ou_buyer', purchaserName: '采购员', authorityTarget: { building: 'H楼' } }, new Date(now + 3))).rejects.toThrow();
      expect((await store.getLifecycleOutbox(identity))?.desiredRevision).toBe(2);
    } finally {
      if (previousApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = previousApp;
    }
  });

  it('binds the claimed manager stage only after the lifecycle replica is confirmed', async () => {
    const context = serializePurchaseManagerBatchApprovalCardContext({ version: 3, approvalBatchId: identity.batchId, requesterOpenId: 'ou_requester', requesterName: '申请人', building: 'H楼', requestCode: 'CG-TEST', expectedDeliveryAt: '2026-01-10', createdAt: '2026-01-01', items: [{ executionRecordId: 'rec_one', title: '测试', specification: '/', quantity: '1', unit: '个', amount: '1', status: 'pending', choice: '', rejectionReason: '' }] });
    const task = await store.takeNextManagerApprovalNotification(new Date(Date.now() + 1000));
    const enrolled = await store.enrollLifecycleRecipientFromNotification(task!.key, task!.claimToken, () => {});
    expect(enrolled.replica.recipientOpenId).toBe(identity.recipientOpenId);
    const attempt = await store.beginLifecycleDelivery(identity, now, enrolled.desiredRevision, 1, allow);
    await expect(store.completeLifecycleStageNotification(task!.key, task!.claimToken, 1, context, () => {})).rejects.toThrow('尚未确认送达');
    await store.markLifecycleDeliveryDispatched(identity, attempt.entry.attemptToken, allow);
    await store.completeLifecycleDelivery(identity, attempt.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: attempt.entry.replica.uuid, messageId: 'om_first', sentAtMs: now } });
    const before = await readFile(file, 'utf8');
    await expect(store.completeLifecycleStageNotification(task!.key, task!.claimToken, 1, context, () => { throw new Error('revoked'); })).rejects.toThrow('revoked');
    expect(await readFile(file, 'utf8')).toBe(before);
    const completed = await store.completeLifecycleStageNotification(task!.key, task!.claimToken, 1, context, () => {});
    expect(completed).toMatchObject({ status: 'completed', sendOutcome: 'delivered', messageId: 'om_first', deliveryUuid: task!.deliveryUuid,
      lifecycleBinding: { appId: identity.appId, deliveryUuid: attempt.entry.replica.uuid, messageId: 'om_first', revision: 1 } });
    expect(completed.deliveryAudit).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'lifecycle_replica_bound', deliveryUuid: attempt.entry.replica.uuid, messageId: 'om_first' })]));
    expect((await store.findManagerApprovalBatch(identity.batchId))?.messageId).toBe('om_first');
    const bytes = await readFile(file, 'utf8');
    await store.completeLifecycleStageNotification(task!.key, task!.claimToken, 1, context, () => {});
    expect(await readFile(file, 'utf8')).toBe(bytes);
    const corrupted = JSON.parse(bytes);
    corrupted.notifications.find((row: any) => row.key === task!.key).lifecycleBinding.deliveryUuid = 'forged';
    await writeFile(file, JSON.stringify(corrupted));
    const corruptedBytes = await readFile(file, 'utf8');
    await expect(store.getNotification(task!.key)).rejects.toThrow('副本凭据映射损坏');
    expect(await readFile(file, 'utf8')).toBe(corruptedBytes);
  });

  it('replays a completed stage receipt after a 14-day continuation and restart without sending again', async () => {
    const context = serializePurchaseManagerBatchApprovalCardContext({ version: 3, approvalBatchId: identity.batchId, requesterOpenId: 'ou_requester', requesterName: '申请人', building: 'H楼', requestCode: 'CG-TEST', expectedDeliveryAt: '2026-01-10', createdAt: '2026-01-01', items: [{ executionRecordId: 'rec_one', title: '测试', specification: '/', quantity: '1', unit: '个', amount: '1', status: 'pending', choice: '', rejectionReason: '' }] });
    const task = await store.takeNextManagerApprovalNotification(new Date(Date.now() + 1000));
    await store.enrollLifecycleRecipientFromNotification(task!.key, task!.claimToken, () => {});
    const initial = await store.beginLifecycleDelivery(identity, now, 1, 1, allow);
    await store.markLifecycleDeliveryDispatched(identity, initial.entry.attemptToken, allow);
    await store.completeLifecycleDelivery(identity, initial.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: initial.entry.replica.uuid, messageId: 'om_old', sentAtMs: now } });
    const original = await store.completeLifecycleStageNotification(task!.key, task!.claimToken, 1, context, () => {});
    await store.enqueueLifecycleRefresh(identity, 2, allow);
    const continuation = await store.beginLifecycleDelivery(identity, now + 14 * 86400000 + 1, 2, 1, allow);
    expect(continuation.action).toBe('send');
    await store.markLifecycleDeliveryDispatched(identity, continuation.entry.attemptToken, allow);
    await store.completeLifecycleDelivery(identity, continuation.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: continuation.entry.replica.uuid, messageId: 'om_next', sentAtMs: now + 14 * 86400000 + 1 } });
    await store.onModuleDestroy();
    store = new PurchaseWorkflowStore(file);
    await store.onModuleInit();
    const before = await readFile(file, 'utf8');
    expect(await store.completeLifecycleStageNotification(task!.key, task!.claimToken, 1, context, () => {})).toEqual(original);
    expect(await readFile(file, 'utf8')).toBe(before);
    const corrupted = JSON.parse(before);
    corrupted.lifecycleOutbox[0].history[0].messageId = 'om_wrong';
    await writeFile(file, JSON.stringify(corrupted));
    const invalidBytes = await readFile(file, 'utf8');
    await expect(store.completeLifecycleStageNotification(task!.key, task!.claimToken, 1, context, () => {})).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(invalidBytes);
  });

  it('refuses lifecycle enrollment when original notification send outcome is missing', async () => {
    const task = await store.takeNextManagerApprovalNotification(new Date(Date.now() + 1000));
    const raw = JSON.parse(await readFile(file, 'utf8'));
    delete raw.notifications.find((row: any) => row.key === task!.key).sendOutcome;
    await writeFile(file, JSON.stringify(raw));
    const before = await readFile(file, 'utf8');
    await expect(store.enrollLifecycleRecipientFromNotification(task!.key, task!.claimToken, () => {})).rejects.toThrow('发送结果需要核对');
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('binds each stage event to its own durable revision without repeated increments', async () => {
    const initial = await store.beginLifecycleDelivery(identity, now, 1, 1, allow);
    await store.markLifecycleDeliveryDispatched(identity, initial.entry.attemptToken, allow);
    await store.completeLifecycleDelivery(identity, initial.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: initial.entry.replica.uuid, messageId: 'om_manager', sentAtMs: now } });
    await store.enqueueNotifications(['one', 'two'].map(suffix => ({ businessEventId: `purchase-order-stage-${suffix}`, recordId: 'rec_one', recipientOpenId: identity.recipientOpenId, kind: 'purchase_order_completed' as const, cardContext: JSON.stringify({ version: 1, text: '下单成功' }) })));
    const time = new Date(Date.now() + 1000);
    const first = await store.takeNextNotification(time, 60000, ['purchase_order_completed']);
    const firstEnrollment = await store.enrollLifecycleRecipientFromNotification(first!.key, first!.claimToken, () => {});
    expect(firstEnrollment.stageTargetRevision).toBe(2);
    const bytes = await readFile(file, 'utf8');
    expect((await store.enrollLifecycleRecipientFromNotification(first!.key, first!.claimToken, () => {})).stageTargetRevision).toBe(2);
    expect(await readFile(file, 'utf8')).toBe(bytes);
    const second = await store.takeNextNotification(time, 60000, ['purchase_order_completed']);
    const secondEnrollment = await store.enrollLifecycleRecipientFromNotification(second!.key, second!.claimToken, () => {});
    expect(secondEnrollment.stageTargetRevision).toBe(3);
    await expect(store.completeLifecycleStageNotification(first!.key, first!.claimToken, 2, undefined, () => {})).rejects.toThrow('尚未确认送达');
    const refresh = await store.beginLifecycleDelivery(identity, now + 1, 3, 1, allow);
    await store.markLifecycleDeliveryDispatched(identity, refresh.entry.attemptToken, allow);
    await store.completeLifecycleDelivery(identity, refresh.entry.attemptToken, { kind: 'update', messageId: 'om_manager', revision: 3 });
    await store.completeLifecycleStageNotification(first!.key, first!.claimToken, 2, undefined, () => {});
    await store.completeLifecycleStageNotification(second!.key, second!.claimToken, 3, undefined, () => {});
    expect((await store.getNotification(first!.key))?.lifecycleBinding?.revision).toBe(3);
    expect((await store.getNotification(second!.key))?.lifecycleBinding?.revision).toBe(3);
  });

  it('refreshes only existing recipients for each lifecycle stage and binds once after delivery', async () => {
    const context = serializePurchaseManagerBatchApprovalCardContext({ version: 3, approvalBatchId: identity.batchId, requesterOpenId: 'ou_requester', requesterName: '申请人', building: 'H楼', requestCode: 'CG-TEST', expectedDeliveryAt: '2026-01-10', createdAt: '2026-01-01', items: [{ executionRecordId: 'rec_one', title: '测试', specification: '/', quantity: '1', unit: '个', amount: '1', status: 'pending', choice: '', rejectionReason: '' }] });
    const time = new Date(Date.now() + 1000);
    const managerTask = await store.takeNextManagerApprovalNotification(time);
    await store.enrollLifecycleRecipientFromNotification(managerTask!.key, managerTask!.claimToken, () => {});
    const initial = await store.beginLifecycleDelivery(identity, now, 1, 1, allow);
    await store.markLifecycleDeliveryDispatched(identity, initial.entry.attemptToken, allow);
    await store.completeLifecycleDelivery(identity, initial.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: initial.entry.replica.uuid, messageId: 'om_manager', sentAtMs: now } });
    await store.completeLifecycleStageNotification(managerTask!.key, managerTask!.claimToken, 1, context, () => {});
    const kinds = ['manager_batch_approval_refresh', 'manager_batch_purchase_refresh', 'manager_batch_receipt_refresh'] as const;
    await store.enqueueNotifications([...kinds.map(kind => ({ businessEventId: `test-${kind}`, recordId: 'rec_one', recipientOpenId: identity.recipientOpenId, kind, cardContext: context })), { businessEventId: 'test-intruder', recordId: 'rec_one', recipientOpenId: 'ou_intruder', kind: 'manager_batch_purchase_refresh' as const, cardContext: context }]);
    for (const [index, kind] of kinds.entries()) {
      const task = await store.takeNextManagerApprovalNotification(time);
      expect(task?.kind).toBe(kind);
      const entry = await store.enrollLifecycleRecipientFromNotification(task!.key, task!.claimToken, () => {});
      expect(entry.stageTargetRevision).toBe(index + 2);
      expect((await store.enrollLifecycleRecipientFromNotification(task!.key, task!.claimToken, () => {})).stageTargetRevision).toBe(index + 2);
      await expect(store.completeLifecycleStageNotification(task!.key, task!.claimToken, entry.stageTargetRevision, undefined, () => {})).rejects.toThrow('尚未确认送达');
      const update = await store.beginLifecycleDelivery(identity, now + index + 1, entry.stageTargetRevision, 1, allow);
      await store.markLifecycleDeliveryDispatched(identity, update.entry.attemptToken, allow);
      await store.completeLifecycleDelivery(identity, update.entry.attemptToken, { kind: 'update', messageId: 'om_manager', revision: entry.stageTargetRevision });
      expect((await store.completeLifecycleStageNotification(task!.key, task!.claimToken, entry.stageTargetRevision, undefined, () => {})).messageId).toBe('om_manager');
    }
    const intruder = await store.takeNextManagerApprovalNotification(time);
    const before = await readFile(file, 'utf8');
    await expect(store.enrollLifecycleRecipientFromNotification(intruder!.key, intruder!.claimToken, () => {})).rejects.toThrow('人员不匹配');
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await store.getLifecycleOutbox({ ...identity, recipientOpenId: 'ou_intruder' })).toBeNull();
  });

  it('claims only the requested lifecycle item with record-level authorization', async () => {
    const batchId = 'purchase-lifecycle-two-items', local = { ...identity, batchId };
    await store.registerManagerApprovalBatch({ approvalBatchId: batchId, recipientOpenId: local.recipientOpenId, requesterOpenId: 'ou_requester', recordIds: ['rec_a', 'rec_b'], flowVersion: 'lifecycle_v1' }, undefined, { appId: local.appId, recipients: [{ openId: local.recipientOpenId, fullView: false }], authorityTargets: targets('rec_a', 'rec_b'), authorize: () => {} });
    const context = serializePurchaseManagerBatchApprovalCardContext({ version: 3, approvalBatchId: batchId, requesterOpenId: 'ou_requester', requesterName: '申请人', building: 'H楼', requestCode: 'CG-TWO', expectedDeliveryAt: '2026-01-10', createdAt: '2026-01-01', items: ['rec_a','rec_b'].map(executionRecordId => ({ executionRecordId, title: executionRecordId, specification: '/', quantity: '1', unit: '个', amount: '1', status: 'pending' as const, choice: '' as const, rejectionReason: '' })) });
    const firstTask = await store.takeNextManagerApprovalNotification(new Date(Date.now() + 1000));
    expect(firstTask?.recordId).toBe('rec_one');
    await store.failNotification(firstTask!.key, firstTask!.claimToken, new Error('fixture skip'));
    const task = await store.takeNextManagerApprovalNotification(new Date(Date.now() + 1000));
    await store.enrollLifecycleRecipientFromNotification(task!.key, task!.claimToken, () => {});
    const attempt = await store.beginLifecycleDelivery(local, now, 1, 1, () => {});
    await store.markLifecycleDeliveryDispatched(local, attempt.entry.attemptToken, () => {});
    await store.completeLifecycleDelivery(local, attempt.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: attempt.entry.replica.uuid, messageId: 'om_two', sentAtMs: now } });
    await store.completeLifecycleStageNotification(task!.key, task!.claimToken, 1, context, () => {});
    const callback = { approvalBatchId: batchId, actorOpenId: local.recipientOpenId, messageId: 'om_two', lifecycle: { appId: local.appId, cardRevision: 1 }, eventId: 'evt_single', executionRecordId: 'rec_a', choice: 'comprehensive' as const };
    await expect(store.claimManagerApprovalBatchItemApproval(callback, new Date(now), (_batch, item) => { if (item.executionRecordId === 'rec_a') throw new Error('scope denied'); })).rejects.toThrow('scope denied');
    const claimed = await store.claimManagerApprovalBatchItemApproval(callback, new Date(now), (_batch, item) => { expect(item.executionRecordId).toBe('rec_a'); });
    expect(claimed.claimed).toBe(true);
    expect(claimed.entry?.recordIds).toEqual(['rec_a']);
    expect(claimed.batch.items.find(item => item.executionRecordId === 'rec_b')?.status).toBe('pending');
    await expect(store.claimManagerApprovalBatchItemApproval({ ...callback, executionRecordId: 'rec_b' }, new Date(now), () => {})).rejects.toThrow('事件与已有任务冲突');
    const action = await store.takeNextManagerApprovalBatchAction(new Date(now + 1));
    await store.completeManagerApprovalBatchActionRecord(action!.key, action!.claimToken, 'rec_a', { purchaserOpenId: 'ou_buyer', purchaserName: '采购员', authorityTarget: { building: 'H楼' } }, new Date(now + 2));
    expect((await store.findManagerApprovalBatch(batchId))?.items.find(item => item.executionRecordId === 'rec_b')?.status).toBe('pending');
    await expect(store.claimManagerApprovalBatchItemApproval({ ...callback, eventId: 'evt_second', executionRecordId: 'rec_b' }, new Date(now + 3), () => {})).rejects.toThrow('版本已变化');
    const refresh = await store.beginLifecycleDelivery(local, now + 4, 2, 1, () => {});
    await store.markLifecycleDeliveryDispatched(local, refresh.entry.attemptToken, () => {});
    await store.completeLifecycleDelivery(local, refresh.entry.attemptToken, { kind: 'update', messageId: 'om_two', revision: 2 });
    const second = await store.claimManagerApprovalBatchItemApproval({ ...callback, lifecycle: { appId: local.appId, cardRevision: 2 }, eventId: 'evt_second', executionRecordId: 'rec_b' }, new Date(now + 5), () => {});
    expect(second.entry?.recordIds).toEqual(['rec_b']);
    const secondAction = await store.takeNextManagerApprovalBatchAction(new Date(now + 6));
    await store.completeManagerApprovalBatchActionRecord(secondAction!.key, secondAction!.claimToken, 'rec_b', { purchaserOpenId: 'ou_buyer', purchaserName: '采购员', authorityTarget: { building: 'H楼' } }, new Date(now + 7));
    let buyerTask = await store.takeNextManagerApprovalNotification(new Date(Date.now() + 1000));
    for (let i = 0; buyerTask && buyerTask.kind !== 'manager_batch_purchase_assigned' && i < 10; i++) {
      await store.rescheduleNotification(buyerTask.key, buyerTask.claimToken, new Error('fixture deferred'), new Date('2099-01-01'));
      buyerTask = await store.takeNextManagerApprovalNotification(new Date(Date.now() + 1000));
    }
    expect(buyerTask?.recipientOpenId).toBe('ou_buyer');
    const beforeEnroll = await readFile(file, 'utf8');
    await expect(store.enrollLifecycleRecipientFromNotification(buyerTask!.key, buyerTask!.claimToken, () => { throw new Error('buyer scope revoked'); })).rejects.toThrow('buyer scope revoked');
    expect(await readFile(file, 'utf8')).toBe(beforeEnroll);
    const buyer = await store.enrollLifecycleRecipientFromNotification(buyerTask!.key, buyerTask!.claimToken, (_batch, task) => { expect(task.recipientOpenId).toBe('ou_buyer'); });
    expect(buyer.replica.recipientOpenId).toBe('ou_buyer');
    expect(buyer.replica.state).toBe('unattempted');
    const stable = await readFile(file, 'utf8');
    await store.enrollLifecycleRecipientFromNotification(buyerTask!.key, buyerTask!.claimToken, () => {});
    expect(await readFile(file, 'utf8')).toBe(stable);
    const buyerIdentity = { ...local, recipientOpenId: 'ou_buyer' };
    const buyerAttempt = await store.beginLifecycleDelivery(buyerIdentity, now + 8, buyer.desiredRevision, 1, () => {});
    await store.markLifecycleDeliveryDispatched(buyerIdentity, buyerAttempt.entry.attemptToken, () => {});
    await store.completeLifecycleDelivery(buyerIdentity, buyerAttempt.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: buyerAttempt.entry.replica.uuid, messageId: 'om_buyer', sentAtMs: now + 8 } });
    const boundBuyerTask = await store.completeLifecycleStageNotification(buyerTask!.key, buyerTask!.claimToken, buyer.desiredRevision, undefined, () => {});
    expect(boundBuyerTask.lifecycleBinding?.messageId).toBe('om_buyer');
    const buyerCallback = { approvalBatchId: batchId, actorOpenId: 'ou_buyer', messageId: 'om_buyer', role: 'purchaser' as const, lifecycle: { appId: local.appId, cardRevision: buyer.desiredRevision } };
    await expect(store.getPurchaseBatchForFulfillmentCard(buyerCallback)).rejects.toThrow('缺少当前职责校验');
    expect((await store.getPurchaseBatchForFulfillmentCard(buyerCallback, () => {})).batch.approvalBatchId).toBe(batchId);
  });

  it('does not dispatch a stale rendered revision after a concurrent state change', async () => {
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    const renderedRevision = (await store.listPendingLifecycleDeliveries(1))[0]!.desiredRevision;
    await store.enqueueLifecycleRefresh(identity, 2, allow);
    const before = await readFile(file, 'utf8');
    await expect(store.beginLifecycleDelivery(identity, now, renderedRevision, 1, allow)).rejects.toThrow('页码已变化');
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await store.beginLifecycleDelivery(identity, now, 2, 1, allow)).action).toBe('send');
  });

  it('can abort only prepared attempts; dispatched attempts stay fenced after restart', async () => {
    const prepared = await store.beginLifecycleDelivery(identity, now, 1, 1, allow);
    expect(prepared.entry.dispatchPhase).toBe('prepared');
    const before = await readFile(file, 'utf8');
    await expect(store.markLifecycleDeliveryDispatched(identity, prepared.entry.attemptToken, async () => { throw new Error('revoked'); })).rejects.toThrow('锁内同步完成');
    expect(await readFile(file, 'utf8')).toBe(before);
    await expect(store.abortPreparedLifecycleDelivery(identity, 'bad-token')).rejects.toThrow();
    const reset = await store.abortPreparedLifecycleDelivery(identity, prepared.entry.attemptToken);
    expect(reset.replica.state).toBe('unattempted');
    const next = await store.beginLifecycleDelivery(identity, now + 1, 1, 1, allow);
    expect(next.entry.replica.uuid).toBe(prepared.entry.replica.uuid);
    await store.markLifecycleDeliveryDispatched(identity, next.entry.attemptToken, allow);
    await expect(store.abortPreparedLifecycleDelivery(identity, next.entry.attemptToken)).rejects.toThrow('必须先核对');
    await store.onModuleDestroy();
    store = new PurchaseWorkflowStore(file);
    await store.onModuleInit();
    expect((await store.getLifecycleOutbox(identity))?.dispatchPhase).toBe('dispatch_started');
    expect((await store.beginLifecycleDelivery(identity, now + 2, 1, 1, allow)).action).toBe('reconcile');
  });

  it('allows exactly one of pre-dispatch cancellation and dispatch in a race', async () => {
    const prepared = await store.beginLifecycleDelivery(identity, now, 1, 1, allow);
    const outcomes = await Promise.allSettled([
      store.markLifecycleDeliveryDispatched(identity, prepared.entry.attemptToken, allow),
      store.abortPreparedLifecycleDelivery(identity, prepared.entry.attemptToken),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
  });

  it('persists fair bounded backoff across 100+ recipients, restart and concurrent deferrals', async () => {
    for (let index = 0; index < 110; index++) {
      await store.enqueueLifecycleRefresh({ ...identity, recipientOpenId: `ou_test_${index.toString().padStart(3, '0')}` }, 1, allow);
    }
    const first = await store.listPendingLifecycleDeliveries(50, 'ready', now);
    expect(first).toHaveLength(50);
    await Promise.all(first.map(entry => store.deferLifecycleDelivery(entry.identity, entry.desiredRevision, entry.desiredPage, 'source', now)));
    const second = await store.listPendingLifecycleDeliveries(50, 'ready', now);
    expect(second).toHaveLength(50);
    expect(second.some(entry => first.some(prior => prior.identity.recipientOpenId === entry.identity.recipientOpenId))).toBe(false);
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(file); await store.onModuleInit();
    const afterRestart = await store.listPendingLifecycleDeliveries(100, 'ready', now);
    expect(afterRestart).toHaveLength(61);
    const firstDeferred = await store.getLifecycleOutbox(first[0]!.identity);
    expect(firstDeferred).toMatchObject({ failureCount: 1, retryReason: 'source', nextAttemptAtMs: now + 5000 });
    await store.deferLifecycleDelivery(first[0]!.identity, 1, 1, 'authorization', now + 5000);
    expect(await store.getLifecycleOutbox(first[0]!.identity)).toMatchObject({ failureCount: 2, retryReason: 'authorization', nextAttemptAtMs: now + 65000 });
    await expect(store.beginLifecycleDelivery(first[0]!.identity, now + 6000, 1, 1, allow)).rejects.toThrow('尚未到重试时间');
    const unknown = await store.beginLifecycleDelivery(second[0]!.identity, now, 1, 1, allow);
    await store.markLifecycleDeliveryDispatched(second[0]!.identity, unknown.entry.attemptToken, allow);
    const bytes = await readFile(file, 'utf8');
    await expect(store.deferLifecycleDelivery(second[0]!.identity, 1, 1, 'source', now)).rejects.toThrow('不能安排重试');
    expect(await readFile(file, 'utf8')).toBe(bytes);
    expect((await store.listPendingLifecycleDeliveries(100, 'needs_reconciliation', now)).some(entry => entry.identity.recipientOpenId === second[0]!.identity.recipientOpenId)).toBe(true);
  }, 30000);

  it('serializes pagination and business updates through the same revision fence', async () => {
    const first = await store.beginLifecycleDelivery(identity, now, 1, 1, allow);
    await store.markLifecycleDeliveryDispatched(identity, first.entry.attemptToken, allow);
    const pageProof = { totalPages: 3, authorizationFingerprint: 'a'.repeat(64) };
    await store.completeLifecycleDelivery(identity, first.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: first.entry.replica.uuid, messageId: 'om_first', sentAtMs: now }, pageProof });
    const invalidBefore = await readFile(file, 'utf8');
    await expect(store.queueLifecyclePage(identity, 'om_first', 1, 'evt_bad_page', 3, () => { throw new Error('page not authorized'); })).rejects.toThrow('page not authorized');
    expect(await readFile(file, 'utf8')).toBe(invalidBefore);
    const next = await store.queueLifecyclePage(identity, 'om_first', 1, 'evt_page_2', 2, (_batch, _replica, page) => { expect(page).toBe(2); });
    expect(next).toMatchObject({ queued: true, entry: { desiredRevision: 2, desiredPage: 2, appliedPage: 1 } });
    const afterPage = await readFile(file, 'utf8');
    expect((await store.queueLifecyclePage(identity, 'om_first', 1, 'evt_page_2', 2, () => {})).queued).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(afterPage);
    await expect(store.queueLifecyclePage(identity, 'om_first', 1, 'evt_page_2', 3, () => {})).rejects.toThrow('事件内容冲突');
    await expect(store.beginLifecycleDelivery(identity, now + 1, 2, 1, allow)).rejects.toThrow('页码已变化');
    const pageDelivery = await store.beginLifecycleDelivery(identity, now + 1, 2, 2, allow);
    expect(pageDelivery.entry.pendingPage).toBe(2);
    await store.markLifecycleDeliveryDispatched(identity, pageDelivery.entry.attemptToken, allow);
    await store.enqueueLifecycleRefresh(identity, 3, allow);
    await expect(store.resetLifecycleDesiredPageToFirst(identity, 3, 2, () => {})).rejects.toThrow('发送状态已变化');
    await store.completeLifecycleDelivery(identity, pageDelivery.entry.attemptToken, { kind: 'update', messageId: 'om_first', revision: 2, pageProof });
    expect(await store.getLifecycleOutbox(identity)).toMatchObject({ desiredRevision: 3, desiredPage: 2, appliedPage: 2, replica: { appliedRevision: 2 } });
    await expect(store.queueLifecyclePage(identity, 'om_first', 2, 'evt_stale', 1, () => {})).rejects.toThrow('版本已变化');
    const pendingBusinessRefresh = await store.beginLifecycleDelivery(identity, now + 2, 3, 2, allow);
    expect(pendingBusinessRefresh.action).toBe('update');
    expect(pendingBusinessRefresh.entry.pendingPage).toBe(2);
  });

  it('resets a no-longer-valid page by authorization and CAS without performing a network update', async () => {
    const first = await store.beginLifecycleDelivery(identity, now, 1, 1, allow);
    await store.markLifecycleDeliveryDispatched(identity, first.entry.attemptToken, allow);
    await store.completeLifecycleDelivery(identity, first.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: first.entry.replica.uuid, messageId: 'om_first', sentAtMs: now }, pageProof: { totalPages: 2, authorizationFingerprint: 'a'.repeat(64) } });
    await store.queueLifecyclePage(identity, 'om_first', 1, 'evt_page_2', 2, () => {});
    const before = await readFile(file, 'utf8');
    await expect(store.resetLifecycleDesiredPageToFirst(identity, 2, 2, () => { throw new Error('page remains valid'); })).rejects.toThrow('page remains valid');
    await expect(store.resetLifecycleDesiredPageToFirst(identity, 1, 2, () => {})).rejects.toThrow('页码或发送状态已变化');
    expect(await readFile(file, 'utf8')).toBe(before);
    const reset = await store.resetLifecycleDesiredPageToFirst(identity, 2, 2, () => {});
    expect(reset).toMatchObject({ desiredRevision: 3, desiredPage: 1, appliedPage: 1, replica: { state: 'delivered', messageId: 'om_first' } });
  });

  it('commits the inbound resolution and refresh revision together and does not repeat it', async () => {
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    const resolution = { businessEventId: 'inventory-inbound-completed-resolution:rec_one', recordId: 'rec_one', recipientOpenId: 'system', kind: 'inventory_inbound_completed_resolution' as const };
    await store.enqueueNotifications([resolution]);
    const first = await store.takeNextNotification(new Date(Date.now() + 1000), 60000, ['inventory_inbound_completed_resolution']);
    await store.completeInboundCompletedResolutionAndEnqueueNotifications(first!.key, first!.claimToken, []);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    expect(raw.lifecycleOutbox[0].desiredRevision).toBe(2);
    expect(raw.notifications.find((row: any) => row.key === first!.key).status).toBe('completed');
    await store.onModuleDestroy();
    store = new PurchaseWorkflowStore(file);
    await store.onModuleInit();
    expect((await store.getLifecycleOutbox(identity))?.desiredRevision).toBe(2);
    await store.enqueueNotifications([{ ...resolution, businessEventId: 'inventory-inbound-completed-resolution:retry-rec_one' }]);
    const retry = await store.takeNextNotification(new Date(Date.now() + 1000), 60000, ['inventory_inbound_completed_resolution']);
    await store.completeInboundCompletedResolutionAndEnqueueNotifications(retry!.key, retry!.claimToken, []);
    expect((await store.getLifecycleOutbox(identity))?.desiredRevision).toBe(2);
  });
});
