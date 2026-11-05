import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import type { PurchasePlatformIdentityProof } from '../../server/modules/purchase-inventory/purchase-platform-identity-proof';
import { createPurchasePlatformIdentityVerifier } from '../../server/modules/purchase-inventory/purchase-platform-identity-proof';
import type { AccessPrincipal } from '../../shared/access-control.interface';

const now = new Date('2026-10-26T00:00:00Z'), batchId = 'purchase-batch-123', person = { openId: 'ou_manager', name: '经理' };
const record = { recordId: 'recItem1', status: '未开始（待审批）', building: 'C楼', specialty: '电气' };
const proof: PurchasePlatformIdentityProof = Object.freeze({ source: 'platform', actorAccountId: 'person', actorAuthorizationVersion: 1, actorDisplayName: '合成人员', subjectAccountId: 'person', subjectAuthorizationVersion: 1, subjectDisplayName: '合成人员', sessionFamilyFingerprint: 'x'.repeat(43), expiresAt: Date.parse('2027-01-01T00:00:00Z') });
const context = serializePurchaseManagerBatchApprovalCardContext({ version: 3, approvalBatchId: batchId, requesterOpenId: 'ou_requester', requesterName: '申请人', building: 'C楼', requestCode: 'CG-TEST', expectedDeliveryAt: null, createdAt: null,
  items: ['recItem1', 'recItem2'].map(executionRecordId => ({ executionRecordId, title: '合成', specification: '/', quantity: '1', unit: '个', amount: '1', status: 'pending', choice: '', rejectionReason: '' })) });

describe('isolated same-ledger platform and card approval claims', () => {
  let directory: string, path: string, store: PurchaseWorkflowStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'platform-approval-store-')); path = join(directory, 'ledger.json');
    store = new PurchaseWorkflowStore(path); await store.onModuleInit();
    await store.registerManagerApprovalBatch({ approvalBatchId: batchId, recipientOpenId: person.openId, requesterOpenId: 'ou_requester', recordIds: ['recItem1', 'recItem2'] }, now);
    const delivery = (await store.takeNextManagerApprovalNotification(now))!;
    await store.markManagerApprovalBatchSendStarted(delivery.key, delivery.claimToken, context, now);
    await store.completeManagerApprovalBatchRequestAndRegisterCard(delivery.key, delivery.claimToken, { messageId: 'om_card' }, now);
  });
  afterEach(async () => { await store.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); });
  const platform = (requestId = 'request_id_1234567890') => store.claimPlatformApprovalItem({ approvalBatchId: batchId, record,
    request: { requestId, recordId: record.recordId, choice: 'reject', rejectionReason: '合成驳回' }, identity: proof, lifecycleReady: false }, () => true, now);
  const card = () => store.claimManagerApprovalBatchPendingApproval({ approvalBatchId: batchId, eventId: 'card-event', actorOpenId: person.openId, messageId: 'om_card', choice: 'comprehensive' }, now);

  it('atomically chooses one of simultaneous platform rejection and card approval', async () => {
    const outcomes = await Promise.allSettled([platform(), card()]);
    const platformWon = outcomes[0].status === 'fulfilled' && outcomes[0].value.kind === 'claim';
    const cardWon = outcomes[1].status === 'fulfilled' && outcomes[1].value.claimed;
    expect(Number(platformWon) + Number(cardWon)).toBe(1);
    const batch = (await store.findManagerApprovalBatch(batchId))!;
    expect(batch.items[0]!.status).toBe('processing');
    if (platformWon) expect(batch.items[1]!.status).toBe('pending');
  });
  it('platform-first reserves only its own item, survives restart and does not invent a card action', async () => {
    const claimed = await platform(); expect(claimed.kind).toBe('claim');
    expect((await card()).claimed).toBe(false);
    expect(await store.takeNextManagerApprovalBatchAction(now)).toBeNull();
    await store.recordReminder('synthetic-independent-write');
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(path); await store.onModuleInit();
    const batch = (await store.findManagerApprovalBatch(batchId))!;
    expect(batch.items.map(item => item.status)).toEqual(['processing', 'pending']);
    const replay = await platform(); expect(replay.kind).toBe('replay');
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    expect(persisted.platformApprovalClaims).toHaveLength(1);
    expect(persisted.platformApprovalClaims[0]).toMatchObject({ source: 'platform', actorAccountId: 'person', recordIds: ['recItem1'] });
    expect(persisted.platformApprovalClaims[0]).not.toHaveProperty('messageId');
  });
  it('card-first blocks platform approval without changing the card or accepting a conflicting choice', async () => {
    expect((await card()).claimed).toBe(true); await expect(platform()).rejects.toThrow();
    const batch = (await store.findManagerApprovalBatch(batchId))!;
    expect(batch.items.map(item => item.choice)).toEqual(['comprehensive', 'comprehensive']);
  });
  it('rejects revoked authorization before a claim, retaining the old card state', async () => {
    await expect(store.claimPlatformApprovalItem({ approvalBatchId: batchId, record, request: { requestId: 'request_id_1234567890', recordId: record.recordId, choice: 'reject', rejectionReason: '合成驳回' }, identity: proof, lifecycleReady: false }, () => { throw new Error('revoked'); }, now)).rejects.toThrow();
    expect((await store.findManagerApprovalBatch(batchId))!.items.map(item => item.status)).toEqual(['pending', 'pending']);
  });
  it('rechecks the verified session and permission inside the real ledger lock before mutating', async () => {
    let alive = true;
    const principal: AccessPrincipal = { accountId: 'person', authorizationVersion: 1, role: 'guest', purchaseBuilding: null,
      effectiveAuthorization: { mode: 'independent', baseline: { nativeRole: null, pages: [], rules: [{ id: 'purchase', module: 'purchase', effect: 'allow', actions: ['approve'], buildings: ['C楼'], specialties: ['电气'] }] }, overrides: { rules: [], allowPages: [], denyPages: [] } } };
    const verifier = createPurchasePlatformIdentityVerifier({
      readSignedSession: () => alive ? { principal, principalFingerprint: 'x'.repeat(43), expiresAt: now.getTime() + 10000 } : { principal: { role: 'guest', purchaseBuilding: null }, principalFingerprint: null, expiresAt: null },
      snapshot: () => ({ appId: 'cli_test', accounts: [{ id: 'person', kind: 'local', name: '合成', role: 'guest', building: null, enabled: true, deleted: false, version: 1, source: 'configuration', loginMethod: 'personnel-password', personnelActive: true, personnelAppId: 'cli_test' }] }),
      currentPrincipal: () => alive ? principal : undefined,
    }, () => now.getTime());
    const verified = verifier.verify('synthetic-session'); alive = false;
    await expect(store.claimPlatformApprovalItem({ approvalBatchId: batchId, record, request: { requestId: 'request_id_1234567890', recordId: record.recordId, choice: 'reject', rejectionReason: '合成驳回' }, identity: verified, lifecycleReady: false }, (identity, row) => { verifier.assertCurrent(identity, 'approve', row); return true; }, now)).rejects.toThrow();
    expect((await store.findManagerApprovalBatch(batchId))!.items.map(item => item.status)).toEqual(['pending', 'pending']);
  });
  it('fails closed if a persisted platform claim is corrupted', async () => {
    await platform(); await store.onModuleDestroy();
    const ledger = JSON.parse(await readFile(path, 'utf8')); ledger.platformApprovalClaims[0].subjectAccountId = '';
    await writeFile(path, JSON.stringify(ledger)); store = new PurchaseWorkflowStore(path); await store.onModuleInit();
    await expect(store.findManagerApprovalBatch(batchId)).rejects.toThrow();
  });
  it('keeps the other item and unknown raw ledger fields byte-for-byte equivalent when one item finishes', async () => {
    const ledger = JSON.parse(await readFile(path, 'utf8'));
    ledger.futureUnrecognized = { preserved: 'exact' };
    ledger.managerApprovalBatches[0].items[1].futureItemField = { preserved: 'other item' };
    const untouched = structuredClone(ledger.managerApprovalBatches[0].items[1]);
    await writeFile(path, JSON.stringify(ledger));
    const accepted = await platform(), action = accepted.action as import('../../server/modules/purchase-inventory/purchase-platform-approval-plan').PlatformApprovalPersistedAction;
    const port = store.platformApprovalWorkerPort(), job = (await port.claimPending(action.eventId))!;
    await port.beginDispatch(job, undefined, 'a'.repeat(64)); await port.recordConfirmed(job, { actionId: action.serverActionId, resultHash: 'b'.repeat(64) });
    await port.completeAndRefresh(job);
    const after = JSON.parse(await readFile(path, 'utf8'));
    expect(after.futureUnrecognized).toEqual({ preserved: 'exact' }); expect(after.managerApprovalBatches[0].items[1]).toEqual(untouched);
    // The next requested item is not blocked by a completed platform claim.
    const next = await store.claimPlatformApprovalItem({ approvalBatchId: batchId, record: { ...record, recordId: 'recItem2' },
      request: { requestId: 'request_second_123456789', recordId: 'recItem2', choice: 'reject', rejectionReason: '合成驳回' }, identity: proof, lifecycleReady: false }, () => true, now);
    expect(next.kind).toBe('claim');
  });
  it('rejects the same record appearing in another legacy batch without claiming either', async () => {
    await store.onModuleDestroy(); const ledger = JSON.parse(await readFile(path, 'utf8'));
    const duplicate = structuredClone(ledger.managerApprovalBatches[0]); duplicate.approvalBatchId = 'purchase-batch-other';
    ledger.managerApprovalBatches.push(duplicate); await writeFile(path, JSON.stringify(ledger));
    store = new PurchaseWorkflowStore(path); await store.onModuleInit();
    await expect(platform()).rejects.toThrow();
    expect((await store.findManagerApprovalBatch(batchId))!.items.map(item => item.status)).toEqual(['pending', 'pending']);
  });
});
