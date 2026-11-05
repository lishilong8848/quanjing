jest.mock('../../server/common/config/external-services.config', () => ({ ...jest.requireActual('../../server/common/config/external-services.config'), readEnv: (key: string) => key === 'FEISHU_APP_ID' ? 'cli_test_app' : key === 'PUBLIC_BASE_URL' ? 'https://www.sm.sjhl.online:3001' : '' }));
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { LifecyclePaymentUploadStoreAdapter } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-upload-store-adapter';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import type { LifecyclePaymentUploadIdentity, LifecyclePaymentUploadSelector } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-upload-isolated';

describe('lifecycle payment upload using actual ledger transactions', () => {
  const appId = 'cli_test_app', batchId = 'purchase-application-payment', recordId = 'rec_one', manager = 'ou_manager', buyer = 'ou_buyer';
  const now = Date.now(), requestId = randomUUID();
  const selector: LifecyclePaymentUploadSelector = { approvalBatchId: batchId, executionRecordId: recordId, generation: 1 };
  const request = { requestId, files: [{ sha256: 'a'.repeat(64), size: 123, name: '付款.png' }] };
  let folder: string, file: string, store: PurchaseWorkflowStore, adapter: LifecyclePaymentUploadStoreAdapter, makeAdapter: () => LifecyclePaymentUploadStoreAdapter, previous: string | undefined;
  let allowed: boolean, current: boolean, remoteBatchId: string, grantAction: boolean;
  const identity: LifecyclePaymentUploadIdentity = { uploadSourceFingerprint: 'a'.repeat(64), appId, openId: buyer, accountId: 'account_buyer', authorizationVersion: 1, kind: 'feishu', origin: 'https://www.sm.sjhl.online:3001', assertCurrent: () => { if (!current) throw new Error('session revoked'); } };

  beforeEach(async () => {
    previous = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = appId;
    allowed = true; current = true; remoteBatchId = batchId; grantAction = true;
    folder = await mkdtemp(join(tmpdir(), 'purchase-payment-store-')); file = join(folder, 'ledger.json');
    store = new PurchaseWorkflowStore(file); await store.onModuleInit();
    await store.registerManagerApprovalBatch({ approvalBatchId: batchId, recipientOpenId: manager, requesterOpenId: 'ou_requester', recordIds: [recordId], flowVersion: 'lifecycle_v1' }, now, { appId, recipients: [{ openId: manager, fullView: false }], authorityTargets: [{ recordId, target: { building: 'H楼' } }], authorize: () => {} });
    await store.bindLifecycleReceiptImageSource(appId,identity.uploadSourceFingerprint!);
    const context = serializePurchaseManagerBatchApprovalCardContext({ version: 3, approvalBatchId: batchId, requesterOpenId: 'ou_requester', requesterName: '申请人', building: 'H楼', requestCode: 'CG-TEST', expectedDeliveryAt: '2026-01-10', createdAt: '2026-01-01', items: [{ executionRecordId: recordId, title: '测试', specification: '/', quantity: '1', unit: '个', amount: '1', status: 'pending', choice: '', rejectionReason: '' }] });
    const initial = await store.takeNextManagerApprovalNotification(now + 1000);
    await store.markManagerApprovalBatchSendStarted(initial!.key, initial!.claimToken, context, now + 1000);
    await store.completeManagerApprovalBatchRequestAndRegisterCard(initial!.key, initial!.claimToken, { messageId: 'om_manager' }, now + 1000);
    const managerIdentity = { appId, batchId, recipientOpenId: manager };
    const first = await store.beginLifecycleDelivery(managerIdentity, now + 1000, 1, 1, () => {});
    await store.markLifecycleDeliveryDispatched(managerIdentity, first.entry.attemptToken, () => {});
    await store.completeLifecycleDelivery(managerIdentity, first.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: first.entry.replica.uuid, messageId: 'om_manager', sentAtMs: now - 1000 } });
    await store.claimManagerApprovalBatchPendingApproval({ approvalBatchId: batchId, actorOpenId: manager, messageId: 'om_manager', eventId: 'approve', choice: 'comprehensive', lifecycle: { appId, cardRevision: 1 } }, now + 2000, () => {});
    const action = await store.takeNextManagerApprovalBatchAction(now + 2000);
    await store.completeManagerApprovalBatchActionRecord(action!.key, action!.claimToken, recordId, { purchaserOpenId: buyer, purchaserName: '采购员', authorityTarget: { building: 'H楼' } }, now + 2001);
    let task = await store.takeNextManagerApprovalNotification(now + 3000);
    while (task && task.kind !== 'manager_batch_purchase_assigned') { await store.failNotification(task.key, task.claimToken, new Error('fixture'), now + 3000); task = await store.takeNextManagerApprovalNotification(now + 3000); }
    if (!task) throw new Error('purchase notification missing');
    const enrolled = await store.enrollLifecycleRecipientFromNotification(task.key, task.claimToken, () => {});
    const buyerIdentity = { appId, batchId, recipientOpenId: buyer }, state = (await store.getLifecycleOutbox(buyerIdentity))!;
    const send = await store.beginLifecycleDelivery(buyerIdentity, now + 3000, state.desiredRevision, state.desiredPage, () => {});
    await store.markLifecycleDeliveryDispatched(buyerIdentity, send.entry.attemptToken, () => {});
    await store.completeLifecycleDelivery(buyerIdentity, send.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: send.entry.replica.uuid, messageId: 'om_buyer', sentAtMs: now - 500 } });
    await store.completeLifecycleStageNotification(task.key, task.claimToken, enrolled.stageTargetRevision, undefined, () => {}, now + 3001);
    const authorizer = { prepare: async () => ({ assertCurrent: () => { if (!allowed) throw new Error('permission revoked'); }, verifyLatest: async () => { if (!allowed) throw new Error('permission revoked'); }, authorizeBatch: () => {}, project: () => ({ items: [{ recordId, status: '审批通过（待下单）', stages: [{ stage: 'ordering', fields: [] }] }], viewer: { kind: 'participant', grants: [{ recordId, visibleStages: ['ordering'], allowedActions: grantAction ? ['order'] : [] }] } }) }) };
    const reader = { getExecutionRecordAsApp: async () => ({ recordId, approvalBatchId: remoteBatchId, purchaserOpenId: buyer, building: 'H楼', specialty: '', status: '审批通过（待下单）' }) };
    makeAdapter = () => new LifecyclePaymentUploadStoreAdapter(store, authorizer as never, reader as never);
    adapter = makeAdapter();
  });
  afterEach(async () => { jest.restoreAllMocks(); await store.onModuleDestroy(); await rm(folder, { recursive: true, force: true }); if (previous === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = previous; });

  it('commits evidence, attachment and refresh atomically while preserving unknown raw fields', async () => {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    raw.futureRoot = { preserved: true }; raw.managerApprovalBatches[0].futureBatch = 'keep'; raw.managerApprovalBatches[0].items[0].futureItem = 'keep'; raw.lifecycleOutbox[0].futureReplica = 'keep';
    await writeFile(file, JSON.stringify(raw));
    const reserved = await adapter.reserve(identity, selector, request); expect(reserved.kind).toBe('new');
    const attempt = randomUUID(), dispatch = await adapter.begin(identity, selector, request, reserved.entry, attempt);
    const uploaded = await adapter.recordConfirmed(dispatch, attempt, ['file_token']);
    await adapter.commit(identity, selector, request, uploaded);
    const result = JSON.parse(await readFile(file, 'utf8'));
    expect(result.futureRoot).toEqual({ preserved: true }); expect(result.managerApprovalBatches[0].futureBatch).toBe('keep');
    expect(result.managerApprovalBatches[0].items[0].futureItem).toBe('keep'); expect(result.lifecycleOutbox[0].futureReplica).toBe('keep');
    expect(result.managerApprovalBatches[0].items[0].paymentAttachmentTokens).toEqual(['file_token']);
    expect(result.lifecyclePaymentUploads[0].entry.status).toBe('committed');
    expect(result.lifecycleOutbox.every((row: { desiredRevision: number }) => row.desiredRevision > 0)).toBe(true);
  });

  it('serializes dispatch and does not reupload after crash/restart', async () => {
    const reserved = await adapter.reserve(identity, selector, request);
    const races = await Promise.allSettled([adapter.begin(identity, selector, request, reserved.entry, randomUUID()), adapter.begin(identity, selector, request, reserved.entry, randomUUID())]);
    expect(races.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(file); await store.onModuleInit(); adapter = makeAdapter();
    const data = JSON.parse(await readFile(file, 'utf8')); expect(data.lifecyclePaymentUploads[0].entry.status).toBe('dispatching');
    expect((await adapter.reserve(identity, selector, request)).kind).toBe('manual_reconciliation');
    await expect(store.recordConfirmedLifecyclePaymentUpload(data.lifecyclePaymentUploads[0].entry, randomUUID(), ['file_token'])).rejects.toThrow();
  });

  it('fails closed on moved records, revoked identity or missing purchase action without ledger writes', async () => {
    const before = await readFile(file, 'utf8'); remoteBatchId = 'purchase-application-other';
    await expect(adapter.reserve(identity, selector, request)).rejects.toThrow(); remoteBatchId = batchId;
    grantAction = false; await expect(adapter.reserve(identity, selector, request)).rejects.toThrow(); grantAction = true;
    current = false; await expect(adapter.reserve(identity, selector, request)).rejects.toThrow(); current = true;
    allowed = false; await expect(adapter.reserve(identity, selector, request)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('does not consume evidence on write failure or permission loss and can commit later', async () => {
    const reserved = await adapter.reserve(identity, selector, request), attempt = randomUUID();
    const dispatch = await adapter.begin(identity, selector, request, reserved.entry, attempt), uploaded = await adapter.recordConfirmed(dispatch, attempt, ['file_token']);
    const before = await readFile(file, 'utf8');
    allowed = false; await expect(adapter.commit(identity, selector, request, uploaded)).rejects.toThrow(); allowed = true;
    expect(await readFile(file, 'utf8')).toBe(before);
    const spy = jest.spyOn(store as unknown as { writeLifecycleRaw: (...args: unknown[]) => Promise<void> }, 'writeLifecycleRaw').mockRejectedValueOnce(new Error('disk failure'));
    await expect(adapter.commit(identity, selector, request, uploaded)).rejects.toThrow('disk failure'); spy.mockRestore();
    expect(await readFile(file, 'utf8')).toBe(before);
    await adapter.commit(identity, selector, request, uploaded);
    expect(JSON.parse(await readFile(file, 'utf8')).lifecyclePaymentUploads[0].entry.status).toBe('committed');
  });

  it('rejects same request ID with different bytes and different IDs with the same record content', async () => {
    await adapter.reserve(identity, selector, request);
    await expect(adapter.reserve(identity, selector, { ...request, files: [{ ...request.files[0]!, sha256: 'b'.repeat(64) }] })).rejects.toThrow();
    await expect(adapter.reserve(identity, selector, { ...request, requestId: randomUUID() })).rejects.toThrow();
  });

  it('never lets the legacy image receiver choose between an old and a lifecycle intent for one user', async () => {
    await store.registerManagerApprovalBatch({ approvalBatchId: 'purchase-application-legacy', recipientOpenId: manager, requesterOpenId: 'ou_requester', recordIds: ['rec_legacy'] }, now);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const live = raw.managerApprovalBatches.find((batch: { approvalBatchId: string }) => batch.approvalBatchId === batchId);
    const legacy = raw.managerApprovalBatches.find((batch: { approvalBatchId: string }) => batch.approvalBatchId === 'purchase-application-legacy');
    live.pendingReceiptUpload = { executionRecordId: recordId, materialType: 'receipt_photo', actorOpenId: 'ou_requester', messageId: 'om_live', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(), lifecycle: { appId, cardRevision: 1 } };
    legacy.pendingReceiptUpload = { executionRecordId: 'rec_legacy', materialType: 'receipt_photo', actorOpenId: 'ou_requester', messageId: 'om_legacy', createdAt: new Date(now + 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString() };
    await writeFile(file, JSON.stringify(raw));
    const before = await readFile(file, 'utf8');
    const message = { eventId: 'evt_img', actorOpenId: 'ou_requester', messageId: 'om_image', chatId: 'oc_chat', imageKey: 'img_key' };
    await expect(store.acceptPurchaseReceiptImageMessage(message, now + 2000)).rejects.toThrow('安全图片入口');
    expect(await readFile(file, 'utf8')).toBe(before);
    delete live.pendingReceiptUpload; await writeFile(file, JSON.stringify(raw));
    const accepted = await store.acceptPurchaseReceiptImageMessage(message, now + 2000);
    expect(accepted).toMatchObject({ accepted: true, enqueued: true, notification: { recordId: 'rec_legacy' } });
  });

  it('seals a missing request so a delayed original cannot start', async () => {
    expect(await store.lifecyclePaymentUploadStatus(identity, selector, request.requestId)).toEqual({ state: 'not_found' });
    expect(await store.cancelUnsentLifecyclePaymentUpload(identity, selector, request.requestId)).toEqual({ state: 'cancelled' });
    expect(await store.lifecyclePaymentUploadStatus(identity, selector, request.requestId)).toEqual({ state: 'cancelled' });
    await expect(adapter.reserve(identity, selector, request)).rejects.toThrow('已取消');
    const other = { ...request, requestId: randomUUID() };
    expect((await adapter.reserve(identity, selector, other)).kind).toBe('new');
  });

  it('cancels a prepared request atomically and allows a distinct new request', async () => {
    const reserved = await adapter.reserve(identity, selector, request);
    expect(await store.lifecyclePaymentUploadStatus(identity, selector, request.requestId)).toEqual({ state: 'prepared' });
    expect(await store.cancelUnsentLifecyclePaymentUpload(identity, selector, request.requestId)).toEqual({ state: 'cancelled' });
    await expect(adapter.begin(identity, selector, request, reserved.entry, randomUUID())).rejects.toThrow();
    expect((await adapter.reserve(identity, selector, { ...request, requestId: randomUUID() })).kind).toBe('new');
  });

  it('never permits automatic cancellation after dispatch, including an unknown result', async () => {
    const reserved = await adapter.reserve(identity, selector, request), attempt = randomUUID();
    const dispatch = await adapter.begin(identity, selector, request, reserved.entry, attempt);
    expect(await store.lifecyclePaymentUploadStatus(identity, selector, request.requestId)).toEqual({ state: 'dispatching' });
    await expect(store.cancelUnsentLifecyclePaymentUpload(identity, selector, request.requestId)).rejects.toThrow('不能自动取消');
    await adapter.markUncertain(dispatch, attempt);
    expect(await store.lifecyclePaymentUploadStatus(identity, selector, request.requestId)).toEqual({ state: 'manual_reconciliation' });
    await expect(store.cancelUnsentLifecyclePaymentUpload(identity, selector, request.requestId)).rejects.toThrow('不能自动取消');
  });

  it('reports uploaded/completed without requiring the card to remain at its prior revision', async () => {
    const reserved = await adapter.reserve(identity, selector, request), attempt = randomUUID();
    const dispatch = await adapter.begin(identity, selector, request, reserved.entry, attempt), uploaded = await adapter.recordConfirmed(dispatch, attempt, ['file_token']);
    expect(await store.lifecyclePaymentUploadStatus(identity, selector, request.requestId)).toEqual({ state: 'uploaded' });
    await adapter.commit(identity, selector, request, uploaded);
    expect(await store.lifecyclePaymentUploadStatus(identity, selector, request.requestId)).toEqual({ state: 'completed' });
    await expect(store.cancelUnsentLifecyclePaymentUpload(identity, selector, request.requestId)).rejects.toThrow('不能自动取消');
    await expect(store.lifecyclePaymentUploadStatus({ ...identity, openId: 'ou_other' }, selector, request.requestId)).rejects.toThrow();
  });

  it('serializes cancellation against dispatch so exactly one outcome can win', async () => {
    const reserved = await adapter.reserve(identity, selector, request);
    const [start, cancel] = await Promise.allSettled([adapter.begin(identity, selector, request, reserved.entry, randomUUID()), store.cancelUnsentLifecyclePaymentUpload(identity, selector, request.requestId)]);
    expect([start, cancel].filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const state = (await store.lifecyclePaymentUploadStatus(identity, selector, request.requestId)).state;
    expect(['dispatching', 'cancelled']).toContain(state);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    expect(raw.lifecyclePaymentBlocks?.length || 0).toBe(state === 'cancelled' ? 1 : 0);
  });
});
