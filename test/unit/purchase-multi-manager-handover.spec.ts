import { mkdtemp, readFile, writeFile, rm, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PurchaseWorkflowStore, managerBatchDeliveries, type PurchaseManagerApprovalBatchEntry } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { serializePurchaseManagerBatchApprovalCardContext, type PurchaseManagerBatchApprovalCardInput } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import { PURCHASE_MANAGER_LEGACY_INVALID_CARD_POLICY_VERSION } from '../../server/modules/purchase-inventory/purchase-manager-approval.fields';
import { PurchasePersonnelHandoverAdapter } from '../../server/modules/purchase-inventory/purchase-personnel-handover.adapter';
import type { HandoverContext } from '../../shared/personnel-handover.interface';

const card: PurchaseManagerBatchApprovalCardInput = {
  version: 3, approvalBatchId: 'synthetic-multi-manager-handover', requesterName: '合成申请人', requesterOpenId: 'ou_requester', building: 'C楼', requestCode: 'SYNTHETIC', expectedDeliveryAt: null, createdAt: null,
  items: ['recSyntheticOne', 'recSyntheticTwo'].map(executionRecordId => ({ executionRecordId, title: '合成物料', specification: '/', quantity: '1', unit: '个', amount: '1', status: 'pending', choice: '', rejectionReason: '' })),
};
const context = serializePurchaseManagerBatchApprovalCardContext(card);
const managers = [{ openId: 'ou_first', name: '合成首位' }, { openId: 'ou_second', name: '合成第二位' }];
const handoverInput = (revision: number, sourceOpenId = 'ou_second') => ({
  approvalBatchId: card.approvalBatchId, expectedRevision: revision, mutationId: `handover-${'a'.repeat(64)}`,
  dutyRecordId: 'recDutySynthetic', sourcePersonRecordId: 'recPersonOld', sourceOpenId,
  target: { personRecordId: 'recPersonNew', openId: 'ou_new', name: '合成接任' },
});

describe('multi-manager handover and delivery recovery', () => {
  let directory: string, file: string, temporaryRoot: string, store: PurchaseWorkflowStore;
  beforeEach(async () => {
    temporaryRoot = await realpath(tmpdir());
    directory = await mkdtemp(join(temporaryRoot, 'nt-multi-handover-'));
    file = join(directory, 'ledger.json');
    store = new PurchaseWorkflowStore(file); await store.onModuleInit();
  });
  afterEach(async () => {
    await store.onModuleDestroy();
    if (resolve(dirname(directory)).toLowerCase() !== resolve(temporaryRoot).toLowerCase() || !basename(directory).startsWith('nt-multi-handover-') || (await lstat(directory)).isSymbolicLink()) throw new Error('Synthetic test directory ownership changed');
    await rm(directory, { recursive: true, force: true });
  });
  async function register(people = managers) {
    await store.registerManagerApprovalBatch({ approvalBatchId: card.approvalBatchId, recipientOpenId: people[0].openId, managers: people, requesterOpenId: card.requesterOpenId, recordIds: card.items.map(item => item.executionRecordId) });
  }
  async function sendNext() {
    const task = await store.takeNextManagerApprovalNotification(new Date(Date.now() + 60_000));
    if (!task) throw new Error('Missing synthetic send task');
    await store.markManagerApprovalBatchSendStarted(task.key, task.claimToken, task.cardContext || context);
    await store.completeManagerApprovalBatchRequestAndRegisterCard(task.key, task.claimToken, { messageId: `om_${task.recipientOpenId}` });
    return task;
  }
  async function batch(): Promise<PurchaseManagerApprovalBatchEntry> {
    const value = await store.findManagerApprovalBatch(card.approvalBatchId);
    if (!value) throw new Error('Synthetic batch disappeared');
    return value;
  }
  async function completeHandover(now = new Date()) {
    const job = await store.takeNextPersonnelHandover(now);
    if (!job) throw new Error('Missing synthetic handover task');
    await store.updatePersonnelHandoverProgress(job.mutationId, job.claimToken, 'patch');
    for (const recordId of job.pendingRecordIds) await store.updatePersonnelHandoverProgress(job.mutationId, job.claimToken, 'record', recordId);
    await store.completePersonnelHandover(job.mutationId, job.claimToken);
    return job;
  }

  it.each(['ou_first', 'ou_second'])('replaces only %s and preserves the other delivered card and draft through restart', async sourceOpenId => {
    await register(); await sendNext(); await sendNext();
    const other = sourceOpenId === 'ou_first' ? 'ou_second' : 'ou_first';
    await store.openManagerApprovalBatchRejectEditor({ approvalBatchId: card.approvalBatchId, actorOpenId: other, messageId: `om_${other}`, executionRecordId: card.items[0].executionRecordId });
    const before = await batch(), oldOther = managerBatchDeliveries(before).find(item => item.recipientOpenId === other);
    const input = handoverInput(before.revision, sourceOpenId);
    await store.acceptManagerBatchHandover(input);
    expect(managerBatchDeliveries(await batch()).find(item => item.recipientOpenId === other)).toEqual(oldOther);
    expect(managerBatchDeliveries(await batch()).map(item => item.recipientOpenId)).not.toContain(sourceOpenId);
    expect((await batch()).items).toEqual(before.items);
    await expect(store.openManagerApprovalBatchRejectEditor({ approvalBatchId: card.approvalBatchId, actorOpenId: other, messageId: `om_${other}`, executionRecordId: card.items[1].executionRecordId })).rejects.toThrow('正在同步');
    await expect(store.claimManagerApprovalBatchPendingApproval({ eventId: 'synthetic-old-click', approvalBatchId: card.approvalBatchId, actorOpenId: sourceOpenId, messageId: `om_${sourceOpenId}`, choice: 'comprehensive' })).rejects.toThrow();
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(file); await store.onModuleInit();
    await completeHandover();
    await expect(store.openManagerApprovalBatchRejectEditor({ approvalBatchId: card.approvalBatchId, actorOpenId: other, messageId: `om_${other}`, executionRecordId: card.items[0].executionRecordId })).resolves.toMatchObject({ batch: { recipientOpenId: other } });
    await sendNext();
    const deliveryJob = await store.takeNextPersonnelHandoverDelivery(new Date(Date.now() + 60_000));
    expect(deliveryJob?.notification.recipientOpenId).toBe('ou_new');
    for (const id of card.items.map(item => item.executionRecordId)) await store.recordPersonnelHandoverDeliveryRecord(input.mutationId, deliveryJob!.job.deliveryClaimToken!, id);
    await store.settlePersonnelHandoverDelivery(input.mutationId, deliveryJob!.job.deliveryClaimToken!, 'om_ou_new');
    expect((await store.listPersonnelHandovers())[0].deliveryConfirmedAt).toBeTruthy();
    expect(managerBatchDeliveries(await batch()).find(item => item.recipientOpenId === other)).toEqual(oldOther);
    expect(await store.findManagerApprovalBatchCard(`om_${sourceOpenId}`, sourceOpenId)).toBeNull();
    expect(await store.findManagerApprovalBatchCard('om_ou_new', 'ou_new')).not.toBeNull();
  });

  it('migrates a legacy single-recipient ledger without retaining the old actor mapping', async () => {
    await register([managers[0]]); await sendNext();
    await store.onModuleDestroy();
    const ledger = JSON.parse(await readFile(file, 'utf8'));
    delete ledger.managerApprovalBatches[0].managerDeliveries;
    await writeFile(file, JSON.stringify(ledger));
    store = new PurchaseWorkflowStore(file); await store.onModuleInit();
    await register(managers);
    expect(managerBatchDeliveries(await batch())).toHaveLength(1);
    await expect(store.bindUnknownManagerApprovalBatchDeliveryFromCallback({ approvalBatchId: card.approvalBatchId, actorOpenId: 'ou_second', messageId: 'om_ou_first' })).rejects.toThrow();
    await store.acceptManagerBatchHandover(handoverInput((await batch()).revision, 'ou_first'));
    expect(await batch()).toMatchObject({ recipientOpenId: 'ou_new', messageId: '', state: 'awaiting_delivery' });
    await completeHandover(); await sendNext();
    expect(await store.findManagerApprovalBatchCard('om_ou_first', 'ou_first')).toBeNull();
    expect(managerBatchDeliveries(await batch())).toHaveLength(1);
    expect(await store.findManagerApprovalBatchCard('om_ou_new', 'ou_new')).not.toBeNull();
  });

  it('rejects an already-authorized target without changing either original delivery', async () => {
    await register(); await sendNext(); await sendNext();
    const before = await readFile(file, 'utf8');
    const input = handoverInput((await batch()).revision);
    await expect(store.acceptManagerBatchHandover({ ...input, target: { ...input.target, openId: 'ou_first' } })).rejects.toThrow('已持有');
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('retries the same failed handover without losing the unaffected recipient', async () => {
    await register(); await sendNext(); await sendNext();
    await store.acceptManagerBatchHandover(handoverInput((await batch()).revision));
    const claimed = (await store.takeNextPersonnelHandover())!;
    await store.updatePersonnelHandoverProgress(claimed.mutationId, claimed.claimToken, 'patch');
    await store.failPersonnelHandover(claimed.mutationId, claimed.claimToken);
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(file); await store.onModuleInit();
    await completeHandover(new Date(Date.now() + 31_000));
    await sendNext();
    expect(managerBatchDeliveries(await batch()).map(item => item.recipientOpenId)).toEqual(['ou_first', 'ou_new']);
    expect((await store.listNotifications({ kind: 'manager_batch_approval_requested', recipientOpenId: 'ou_new' }))).toHaveLength(1);
  });

  it('recovers the unsent second delivery while the first card remains active and unchanged', async () => {
    await register(); await sendNext();
    const before = managerBatchDeliveries(await batch())[0];
    const task = (await store.takeNextManagerApprovalNotification())!;
    await store.markManagerApprovalBatchSendStarted(task.key, task.claimToken, context);
    await store.recordManagerCardRejectedSend(task.key, task.claimToken, new Error('HTTP 400 synthetic schema v2 no longer support'), null);
    const result = await store.requeueLegacyIncompatibleManagerApprovalBatchDelivery(card.approvalBatchId, { approvalPolicyVersion: PURCHASE_MANAGER_LEGACY_INVALID_CARD_POLICY_VERSION, externalError: 'HTTP 400' }, new Date(), 'ou_second');
    expect(result.requeued).toBe(true);
    expect(result.notification?.recipientOpenId).toBe('ou_second');
    expect(managerBatchDeliveries(await batch())[0]).toEqual(before);
    await sendNext();
    expect(await store.findManagerApprovalBatchCard('om_ou_second', 'ou_second')).not.toBeNull();
  });

  it('includes the second recipient in the real handover adapter preview', async () => {
    await register(); await sendNext(); await sendNext();
    const person = (recordId: string, openId: string, marker: string, active: boolean) => ({ id: `local-external-${marker.repeat(64)}`, recordId, openId, name: '合成人员', active, type: 'employee' as const, position: '综合管理', systemPosition: '', buildings: ['C楼' as const], specialties: [], permissionTags: [], dutyRecordIds: ['recDutySynthetic'] });
    const input: HandoverContext = { from: person('recPersonOld', 'ou_second', 'a', false), to: person('recPersonNew', 'ou_new', 'b', true), directoryVersion: 'synthetic-v1', duties: [{ recordId: 'recDutySynthetic', name: '合成采购职责', kind: 'purchase_manager', personnelIds: [`local-external-${'a'.repeat(64)}`], buildings: null, specialties: null, enabled: true, startsAt: 0, endsAt: null, parentDutyIds: [], version: 1 }] };
    const adapter = new PurchasePersonnelHandoverAdapter(store, { canUseFeishuBusinessIdentity: () => true } as never, { isEnabled: () => true } as never);
    expect(await adapter.listPending(input)).toEqual([expect.objectContaining({ recipients: [{ name: '合成人员', openId: 'ou_second' }], phase: 'approval' })]);
  });

  it('requires a recipient when more than one failed delivery matches recovery evidence', async () => {
    await register();
    for (let index = 0; index < 2; index++) {
      const task = (await store.takeNextManagerApprovalNotification())!;
      await store.markManagerApprovalBatchSendStarted(task.key, task.claimToken, context);
      await store.recordManagerCardRejectedSend(task.key, task.claimToken, new Error('HTTP 400 synthetic schema failure'), null);
    }
    const before = await readFile(file, 'utf8');
    const evidence = { approvalPolicyVersion: PURCHASE_MANAGER_LEGACY_INVALID_CARD_POLICY_VERSION, externalError: 'HTTP 400' };
    await expect(store.requeueLegacyIncompatibleManagerApprovalBatchDelivery(card.approvalBatchId, evidence)).rejects.toThrow('指定接收人');
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await store.requeueLegacyIncompatibleManagerApprovalBatchDelivery(card.approvalBatchId, evidence, new Date(), 'ou_second')).requeued).toBe(true);
    const notices = await store.listNotifications({ kind: 'manager_batch_approval_requested' });
    expect(notices.find(entry => entry.recipientOpenId === 'ou_first')?.status).toBe('failed');
    expect(notices.find(entry => entry.recipientOpenId === 'ou_second')?.status).toBe('pending');
  });
});
