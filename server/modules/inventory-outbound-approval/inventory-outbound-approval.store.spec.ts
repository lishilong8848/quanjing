import { ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InventoryOutboundApprovalStore,
  type InventoryOutboundApprovalStoreOptions,
} from './inventory-outbound-approval.store';
import type {
  InventoryOutboundApprovalDecisionInput,
  InventoryOutboundApprovalSnapshot,
  InventoryOutboundApprovalWorkRef,
} from './inventory-outbound-approval.types';
import type { InventoryOutboundApprovalRecoveryResult } from './inventory-outbound-approval.recovery';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe('InventoryOutboundApprovalStore', () => {
  let directory: string;
  let ledgerPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'inventory-outbound-approval-'));
    ledgerPath = join(directory, 'approval-ledger.json');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it('binds one batch approval message to separate records and keeps each decision isolated', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    const batchId = 'a'.repeat(32);
    const first = snapshot({
      outboundNumber: `inventory_batch_outbound_${batchId}_1`,
      approvers: [{ openId: 'ou_approver_a', name: '审批人甲' }],
    });
    const second = snapshot({
      recordId: 'rec_outbound_2',
      outboundNumber: `inventory_batch_outbound_${batchId}_2`,
      approvers: [{ openId: 'ou_approver_a', name: '审批人甲' }],
    });
    for (const value of [first, second]) {
      await store.registerPending(value);
      await store.confirmPendingRegistration(value.recordId, value.version);
      const ref = approvalCardRef('ou_approver_a', value.recordId);
      const claim = await store.claimWork(ref);
      if (!claim.claimed) throw new Error('expected approval claim');
      await store.completeWork({ ...workCommand(ref, claim), messageId: 'om_batch_shared' });
    }
    const restarted = new InventoryOutboundApprovalStore(ledgerPath);
    expect((await restarted.listEntries()).map((entry) => entry.approvalCards[0].messageId)).toEqual([
      'om_batch_shared', 'om_batch_shared',
    ]);
    const claimed = await restarted.claimDecision(decision({ messageId: 'om_batch_shared' }));
    expect(claimed.claimed).toBe(true);
    expect((await restarted.find(second.recordId, 1))?.decision).toBeUndefined();
  });

  it('reads a missing, blank, and legacy empty ledger without inventing records', async () => {
    const missing = new InventoryOutboundApprovalStore(ledgerPath);
    await expect(missing.listEntries()).resolves.toEqual([]);

    writeFileSync(ledgerPath, '', 'utf8');
    await expect(
      new InventoryOutboundApprovalStore(ledgerPath).listEntries(),
    ).resolves.toEqual([]);

    writeFileSync(
      ledgerPath,
      `${JSON.stringify({
        version: 0,
        updatedAt: '2026-08-26T00:00:00.000Z',
        entries: [],
      })}\n`,
      'utf8',
    );
    const legacy = new InventoryOutboundApprovalStore(ledgerPath);
    await expect(legacy.listEntries()).resolves.toEqual([]);
    await legacy.registerPending(snapshot());
    expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).version).toBe(1);
  });

  it('preserves the first snapshot for explicit request retries without weakening strict recovery', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    const first = await store.registerPending(snapshot());
    const changed = snapshot({
      availableStock: 0,
      itemName: '更新的展示名',
      location: '新库位',
      approvers: [{ openId: 'ou_new', name: '新人' }],
      managerRecipients: [],
    });
    const resumed = await store.registerPending(changed, {
      reuseExistingRequest: true,
    });
    expect(resumed.created).toBe(false);
    expect(resumed.entry).toEqual(first.entry);
    await expect(store.registerPending(changed)).rejects.toThrow(
      '审批快照冲突',
    );
    await expect(
      store.registerPending(snapshot({ quantity: 99 }), {
        reuseExistingRequest: true,
      }),
    ).rejects.toThrow('申请与已持久化审批快照不一致');
    await expect(
      store.restoreFromBase({
        kind: 'pending',
        snapshot: changed,
        deliveries: [],
      }),
    ).rejects.toThrow('审批快照冲突');
  });

  it('fails closed and preserves a corrupted durable ledger', async () => {
    writeFileSync(ledgerPath, '{not-valid-json', 'utf8');
    const store = new InventoryOutboundApprovalStore(ledgerPath);

    await expect(store.listEntries()).rejects.toThrow('审批账本不可用');
    await expect(store.registerPending(snapshot())).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(readFileSync(ledgerPath, 'utf8')).toBe('{not-valid-json');
  });

  it('fails closed when a v1 ledger omits its snapshot fingerprint', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    await store.registerPending(snapshot());
    mutateLedger(ledgerPath, (state) => {
      delete state.entries[0].snapshotFingerprint;
    });
    const tampered = readFileSync(ledgerPath, 'utf8');
    const restarted = new InventoryOutboundApprovalStore(ledgerPath);

    await expect(restarted.find('rec_outbound_1', 1)).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(
      restarted.claimWork(approvalCardRef('ou_approver_a')),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(readFileSync(ledgerPath, 'utf8')).toBe(tampered);
  });

  it('fails closed when a v1 ledger omits its Base registration gate', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    await store.registerPending(snapshot());
    mutateLedger(ledgerPath, (state) => {
      delete state.entries[0].registration;
    });
    const tampered = readFileSync(ledgerPath, 'utf8');

    await expect(
      new InventoryOutboundApprovalStore(ledgerPath).listEntries(),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(readFileSync(ledgerPath, 'utf8')).toBe(tampered);
  });

  it('migrates an unproven legacy v0 registration as pending and blocks card delivery', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    await store.registerPending(snapshot());
    mutateLedger(ledgerPath, (state) => {
      state.version = 0;
      delete state.entries[0].snapshotFingerprint;
      delete state.entries[0].registration;
      state.entries[0].approvalCards[0].status = 'cancelled';
      state.entries[0].approvalCards[0].completedAt =
        '2026-08-26T00:00:01.000Z';
    });

    const restarted = new InventoryOutboundApprovalStore(ledgerPath);
    await expect(restarted.find('rec_outbound_1', 1)).resolves.toMatchObject({
      snapshotFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      registration: { status: 'pending_base' },
    });
    await expect(
      restarted.claimWork(approvalCardRef('ou_approver_a')),
    ).resolves.toMatchObject({ claimed: false });
    expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).version).toBe(1);
  });

  it('migrates a legacy v0 registration as ready only when card-delivery evidence proves the old Base gate passed', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    await store.registerPending(snapshot());
    await store.confirmPendingRegistration('rec_outbound_1', 1);
    const ref = approvalCardRef('ou_approver_a');
    const claim = await store.claimWork(ref);
    if (!claim.claimed) throw new Error('expected approval card claim');
    await store.completeWork({
      ...workCommand(ref, claim),
      messageId: 'om_approval_a',
    });
    mutateLedger(ledgerPath, (state) => {
      state.version = 0;
      delete state.entries[0].snapshotFingerprint;
      delete state.entries[0].registration;
    });

    const restarted = new InventoryOutboundApprovalStore(ledgerPath);
    await expect(restarted.find('rec_outbound_1', 1)).resolves.toMatchObject({
      registration: { status: 'ready' },
    });
  });

  it('atomically reserves registration and hard-gates approval cards until pending Base readback is confirmed', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    const registered = await store.registerPending(snapshot());

    expect(registered.entry.registration).toEqual({
      status: 'pending_base',
      attemptCount: 0,
    });
    await expect(
      store.claimWork(approvalCardRef('ou_approver_a')),
    ).resolves.toMatchObject({ claimed: false });

    await expect(
      store.failPendingRegistration(
        'rec_outbound_1',
        1,
        'pending semantic readback failed',
      ),
    ).resolves.toMatchObject({
      registration: {
        status: 'pending_base',
        attemptCount: 1,
        lastError: 'pending semantic readback failed',
      },
    });
    await expect(store.registerPending(snapshot())).resolves.toMatchObject({
      created: false,
      entry: { registration: { status: 'pending_base', attemptCount: 1 } },
    });
    await expect(
      store.confirmPendingRegistration('rec_outbound_1', 1),
    ).resolves.toMatchObject({
      registration: { status: 'ready', attemptCount: 2 },
    });
    await expect(
      store.claimWork(approvalCardRef('ou_approver_a')),
    ).resolves.toMatchObject({ claimed: true });
  });

  it('serializes approval-card delivery claims for one record across store instances', async () => {
    const firstStore = new InventoryOutboundApprovalStore(ledgerPath);
    const secondStore = new InventoryOutboundApprovalStore(ledgerPath);
    await firstStore.registerPending(snapshot());
    await firstStore.confirmPendingRegistration('rec_outbound_1', 1);

    const [first, second] = await Promise.all([
      firstStore.claimWork(approvalCardRef('ou_approver_a')),
      secondStore.claimWork(approvalCardRef('ou_approver_b')),
    ]);

    expect([first, second].filter((claim) => claim.claimed)).toHaveLength(1);
    const winner = first.claimed
      ? {
          store: firstStore,
          ref: approvalCardRef('ou_approver_a'),
          claim: first,
        }
      : {
          store: secondStore,
          ref: approvalCardRef('ou_approver_b'),
          claim: second,
        };
    const loser = first.claimed
      ? { store: secondStore, ref: approvalCardRef('ou_approver_b') }
      : { store: firstStore, ref: approvalCardRef('ou_approver_a') };
    await winner.store.completeWork({
      ...workCommand(winner.ref, winner.claim),
      messageId: first.claimed ? 'om_approval_a' : 'om_approval_b',
    });

    await expect(loser.store.claimWork(loser.ref)).resolves.toMatchObject({
      claimed: true,
    });
  });

  it('registers an immutable snapshot idempotently and rejects changed content for the same record version', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    const input = snapshot();
    const first = await store.registerPending(input);

    input.itemName = '篡改物品';
    input.approvers[0].name = '篡改审批人';
    first.entry.snapshot.reason = '篡改原因';
    first.entry.approvalCards[0].deliveryUuid = '篡改 UUID';

    const durable = await store.find('rec_outbound_1', 1);
    expect(durable?.snapshot).toMatchObject({
      itemName: '地磅秤',
      reason: '现场领用',
      approvers: expect.arrayContaining([
        { openId: 'ou_approver_a', name: '审批人甲' },
      ]),
    });
    expect(durable?.approvalCards[0].deliveryUuid).toMatch(UUID_PATTERN);

    const duplicate = await store.registerPending(snapshot());
    expect(duplicate.created).toBe(false);
    expect(duplicate.entry).toEqual(durable);

    await expect(
      store.registerPending(snapshot({ itemName: '另一件物品' })),
    ).rejects.toThrow('审批快照冲突');
  });

  it('persists the stable outbound business number as part of the immutable snapshot fingerprint', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    const value = snapshot({
      outboundNumber: 'outbound-client-mutation-001',
    });

    const registered = await store.registerPending(value);
    expect(registered.entry.snapshot.outboundNumber).toBe(
      'outbound-client-mutation-001',
    );
    await expect(
      store.registerPending({
        ...value,
        outboundNumber: 'outbound-client-mutation-002',
      }),
    ).rejects.toThrow();
  });

  it('pre-persists one stable card UUID per approver and records the send result across restart', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    const registered = await store.registerPending(snapshot());
    await store.confirmPendingRegistration('rec_outbound_1', 1);
    const delivery = registered.entry.approvalCards[0];

    expect(delivery).toMatchObject({
      recipientOpenId: 'ou_approver_a',
      status: 'pending',
      attemptCount: 0,
    });
    expect(delivery.deliveryUuid).toMatch(UUID_PATTERN);

    const ref = approvalCardRef('ou_approver_a');
    const claimed = await store.claimWork(ref);
    expect(claimed).toMatchObject({
      claimed: true,
      work: { status: 'running', attemptCount: 1 },
    });
    await store.completeWork({
      ...workCommand(ref, claimed),
      messageId: 'om_approval_a',
    });

    const restarted = new InventoryOutboundApprovalStore(ledgerPath);
    const persisted = await restarted.find('rec_outbound_1', 1);
    expect(persisted?.approvalCards[0]).toMatchObject({
      deliveryUuid: delivery.deliveryUuid,
      messageId: 'om_approval_a',
      status: 'completed',
      attemptCount: 1,
    });
  });

  it('keeps an expired in-flight card delivery recoverable after a decision and patches the eventual message', async () => {
    let now = new Date('2026-08-26T00:00:00.000Z');
    const options: InventoryOutboundApprovalStoreOptions = {
      now: () => now,
      workLeaseMs: 100,
      lockRetryDelayMs: 1,
    };
    const decidingStore = new InventoryOutboundApprovalStore(
      ledgerPath,
      options,
    );
    const recoveryStore = new InventoryOutboundApprovalStore(
      ledgerPath,
      options,
    );
    const registered = await decidingStore.registerPending(snapshot());
    await decidingStore.confirmPendingRegistration('rec_outbound_1', 1);
    const unknownDeliveryUuid = registered.entry.approvalCards.find(
      (card) => card.recipientOpenId === 'ou_approver_b',
    )?.deliveryUuid;

    const actorRef = approvalCardRef('ou_approver_a');
    const actorClaim = await decidingStore.claimWork(actorRef);
    await decidingStore.completeWork({
      ...workCommand(actorRef, actorClaim),
      messageId: 'om_approval_a',
    });

    const unknownRef = approvalCardRef('ou_approver_b');
    const unknownClaim = await decidingStore.claimWork(unknownRef);
    expect(unknownClaim.claimed).toBe(true);
    now = new Date('2026-08-26T00:00:00.101Z');
    await decidingStore.claimDecision(decision());

    const recovered = await recoveryStore.claimWork(unknownRef);
    expect(recovered.claimed).toBe(true);
    await recoveryStore.completeWork({
      ...workCommand(unknownRef, recovered),
      messageId: 'om_approval_b_after_unknown_send',
    });

    const durable = await new InventoryOutboundApprovalStore(
      ledgerPath,
      options,
    ).find('rec_outbound_1', 1);
    expect(
      durable?.approvalCards.find(
        (card) => card.recipientOpenId === 'ou_approver_b',
      ),
    ).toMatchObject({
      deliveryUuid: unknownDeliveryUuid,
      messageId: 'om_approval_b_after_unknown_send',
      status: 'completed',
      attemptCount: 2,
    });
    expect(
      durable?.cardPatches.find(
        (patch) => patch.recipientOpenId === 'ou_approver_b',
      ),
    ).toMatchObject({
      messageId: 'om_approval_b_after_unknown_send',
      status: 'pending',
    });
  });

  it('suppresses a replacement result notification while an unknown approval card delivery can still recover', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    const registered = await store.registerPending(snapshot());
    await store.confirmPendingRegistration('rec_outbound_1', 1);
    const actorRef = approvalCardRef('ou_approver_a');
    const actorClaim = await store.claimWork(actorRef);
    if (!actorClaim.claimed) throw new Error('expected actor card claim');
    await store.completeWork({
      ...actorRef,
      leaseToken: actorClaim.leaseToken,
      messageId: 'om_approval_a',
    });

    const unknownRef = approvalCardRef('ou_approver_b');
    const unknownDelivery = registered.entry.approvalCards.find(
      (card) => card.recipientOpenId === 'ou_approver_b',
    );
    const unknownClaim = await store.claimWork(unknownRef);
    if (!unknownClaim.claimed) throw new Error('expected unknown card claim');
    await store.claimDecision(decision());
    const failed = await store.failWork({
      ...unknownRef,
      leaseToken: unknownClaim.leaseToken,
      error: 'send result unknown',
    });

    expect(
      failed.resultNotifications.filter(
        (notification) => notification.recipientOpenId === 'ou_approver_b',
      ),
    ).toEqual([]);
    await expect(
      store.claimWork(resultNotificationRef('ou_approver_b')),
    ).rejects.toThrow();

    const retry = await store.claimWork(unknownRef);
    if (!retry.claimed) throw new Error('expected unknown card retry');
    expect(retry.work).toMatchObject({
      deliveryUuid: unknownDelivery?.deliveryUuid,
      attemptCount: 2,
    });
    await store.completeWork({
      ...unknownRef,
      leaseToken: retry.leaseToken,
      messageId: 'om_approval_b_recovered',
    });

    const durable = await store.find('rec_outbound_1', 1);
    expect(
      durable?.cardPatches.filter(
        (patch) => patch.recipientOpenId === 'ou_approver_b',
      ),
    ).toEqual([
      expect.objectContaining({
        messageId: 'om_approval_b_recovered',
        status: 'pending',
      }),
    ]);
    expect(
      durable?.resultNotifications.filter(
        (notification) => notification.recipientOpenId === 'ou_approver_b',
      ),
    ).toEqual([]);
  });

  it.each(['pending', 'error'] as const)(
    'cancels but retains a legacy %s replacement notification while the original card delivery is recoverable',
    async (notificationStatus) => {
      const store = new InventoryOutboundApprovalStore(ledgerPath);
      await store.registerPending(snapshot());
      await store.confirmPendingRegistration('rec_outbound_1', 1);
      const actorRef = approvalCardRef('ou_approver_a');
      const actorClaim = await store.claimWork(actorRef);
      if (!actorClaim.claimed) throw new Error('expected actor card claim');
      await store.completeWork({
        ...actorRef,
        leaseToken: actorClaim.leaseToken,
        messageId: 'om_approval_a',
      });
      const unknownRef = approvalCardRef('ou_approver_b');
      const unknownClaim = await store.claimWork(unknownRef);
      if (!unknownClaim.claimed) throw new Error('expected unknown card claim');
      await store.claimDecision(decision());
      mutateLedger(ledgerPath, (state) => {
        state.entries[0].resultNotifications.push(
          legacyResultNotification(notificationStatus),
        );
      });

      const restarted = new InventoryOutboundApprovalStore(ledgerPath);
      const recovered = await restarted.find('rec_outbound_1', 1);
      expect(
        recovered?.resultNotifications.find(
          (notification) => notification.recipientOpenId === 'ou_approver_b',
        ),
      ).toMatchObject({
        status: 'cancelled',
        completedAt: expect.any(String),
      });
      await expect(
        restarted.claimWork(resultNotificationRef('ou_approver_b')),
      ).resolves.toMatchObject({ claimed: false });
    },
  );

  it('keeps a completed legacy replacement notification as the only result and never adds a later card patch', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    await store.registerPending(snapshot());
    await store.confirmPendingRegistration('rec_outbound_1', 1);
    const actorRef = approvalCardRef('ou_approver_a');
    const actorClaim = await store.claimWork(actorRef);
    if (!actorClaim.claimed) throw new Error('expected actor card claim');
    await store.completeWork({
      ...actorRef,
      leaseToken: actorClaim.leaseToken,
      messageId: 'om_approval_a',
    });
    const unknownRef = approvalCardRef('ou_approver_b');
    const unknownClaim = await store.claimWork(unknownRef);
    if (!unknownClaim.claimed) throw new Error('expected unknown card claim');
    await store.claimDecision(decision());
    mutateLedger(ledgerPath, (state) => {
      const card = state.entries[0].approvalCards.find(
        (candidate) => candidate.recipientOpenId === 'ou_approver_b',
      );
      if (!card) throw new Error('expected unknown approval card');
      delete card.owner;
      delete card.completedAt;
      card.status = 'error';
      card.lastError = 'legacy send result unknown';
      card.nextAttemptAt = '2026-08-26T00:00:00.000Z';
      state.entries[0].resultNotifications.push(
        legacyResultNotification('completed'),
      );
    });

    const restarted = new InventoryOutboundApprovalStore(ledgerPath);
    const retry = await restarted.claimWork(unknownRef);
    if (!retry.claimed) throw new Error('expected unknown card retry');
    await restarted.completeWork({
      ...unknownRef,
      leaseToken: retry.leaseToken,
      messageId: 'om_approval_b_recovered_after_notification',
    });

    const durable = await restarted.find('rec_outbound_1', 1);
    expect(
      durable?.resultNotifications.find(
        (notification) => notification.recipientOpenId === 'ou_approver_b',
      ),
    ).toMatchObject({
      status: 'completed',
      messageId: 'om_result_approver_b_legacy',
    });
    expect(
      durable?.cardPatches.filter(
        (patch) => patch.recipientOpenId === 'ou_approver_b',
      ),
    ).toEqual([]);
  });

  it('fails closed when a persisted card patch targets an unrelated recipient', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    await seedDelivered(store, snapshot());
    await store.claimDecision(decision());
    mutateLedger(ledgerPath, (state) => {
      state.entries[0].cardPatches[0].recipientOpenId = 'ou_unrelated';
    });
    const tampered = readFileSync(ledgerPath, 'utf8');
    const restarted = new InventoryOutboundApprovalStore(ledgerPath);

    await expect(restarted.find('rec_outbound_1', 1)).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(restarted.claimWork(baseSyncRef())).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(readFileSync(ledgerPath, 'utf8')).toBe(tampered);
  });

  it('fails closed when a persisted card patch is rebound to an unrelated message', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    await seedDelivered(store, snapshot());
    await store.claimDecision(decision());
    mutateLedger(ledgerPath, (state) => {
      state.entries[0].cardPatches[0].messageId = 'om_unrelated';
    });
    const tampered = readFileSync(ledgerPath, 'utf8');
    const restarted = new InventoryOutboundApprovalStore(ledgerPath);

    await expect(restarted.find('rec_outbound_1', 1)).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(restarted.claimWork(baseSyncRef())).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(readFileSync(ledgerPath, 'utf8')).toBe(tampered);
  });

  it('fails closed when a persisted result notification targets an unrelated recipient', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    await seedDelivered(store, snapshot());
    await store.claimDecision(decision());
    mutateLedger(ledgerPath, (state) => {
      state.entries[0].resultNotifications[0].recipientOpenId = 'ou_unrelated';
    });
    const tampered = readFileSync(ledgerPath, 'utf8');
    const restarted = new InventoryOutboundApprovalStore(ledgerPath);

    await expect(restarted.find('rec_outbound_1', 1)).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(restarted.claimWork(baseSyncRef())).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(readFileSync(ledgerPath, 'utf8')).toBe(tampered);
  });

  it('fails closed when a persisted result notification has a different stable delivery UUID', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    await seedDelivered(store, snapshot());
    await store.claimDecision(decision());
    mutateLedger(ledgerPath, (state) => {
      state.entries[0].resultNotifications[0].deliveryUuid = stableTestUuid(
        'tampered-inventory-outbound-approval-result',
      );
    });
    const tampered = readFileSync(ledgerPath, 'utf8');
    const restarted = new InventoryOutboundApprovalStore(ledgerPath);

    await expect(restarted.find('rec_outbound_1', 1)).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(restarted.claimWork(baseSyncRef())).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(readFileSync(ledgerPath, 'utf8')).toBe(tampered);
  });

  it('binds a decision to record, version, actor, actor-owned message, and event', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    await seedDelivered(store, snapshot());

    await expect(
      store.claimDecision(decision({ recordId: 'rec_missing' })),
    ).rejects.toThrow('审批记录不存在');
    await expect(store.claimDecision(decision({ version: 2 }))).rejects.toThrow(
      '审批记录不存在',
    );
    await expect(
      store.claimDecision(
        decision({
          actorOpenId: 'ou_not_approver',
          messageId: 'om_approval_a',
        }),
      ),
    ).rejects.toThrow('不在审批人快照');
    await expect(
      store.claimDecision(
        decision({
          actorOpenId: 'ou_approver_a',
          messageId: 'om_approval_b',
        }),
      ),
    ).rejects.toThrow('不属于当前审批人');

    const accepted = await store.claimDecision(decision());
    expect(accepted).toMatchObject({
      claimed: true,
      idempotent: false,
      decision: {
        action: 'approve',
        actorOpenId: 'ou_approver_a',
        actorName: '审批人甲',
        messageId: 'om_approval_a',
        eventId: 'evt_approve_1',
      },
    });
  });

  it('returns the same decision for an exact duplicate event and rejects a competing action', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    await seedDelivered(store, snapshot());
    const input = decision();
    const first = await store.claimDecision(input);
    const duplicate = await store.claimDecision(input);

    expect(first.claimed).toBe(true);
    expect(duplicate).toMatchObject({
      claimed: false,
      idempotent: true,
      decision: first.decision,
    });
    await expect(
      store.claimDecision(
        decision({
          eventId: 'evt_reject_after_approve',
          action: 'reject',
          reason: '库存用途不符合要求',
        }),
      ),
    ).rejects.toThrow('已经完成审批');
  });

  it('does not treat a new event id as an idempotent replay of an existing decision', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    await seedDelivered(store, snapshot());
    await store.claimDecision(decision());

    await expect(
      store.claimDecision(decision({ eventId: 'evt_same_payload_new_event' })),
    ).rejects.toThrow();
  });

  it('allows only one decision across two store instances', async () => {
    const firstStore = new InventoryOutboundApprovalStore(ledgerPath);
    const secondStore = new InventoryOutboundApprovalStore(ledgerPath);
    await seedDelivered(firstStore, snapshot());

    const [approve, reject] = await Promise.allSettled([
      firstStore.claimDecision(decision()),
      secondStore.claimDecision(
        decision({
          eventId: 'evt_reject_1',
          actorOpenId: 'ou_approver_b',
          messageId: 'om_approval_b',
          action: 'reject',
          reason: '申请用途信息不足',
        }),
      ),
    ]);

    expect(
      [approve, reject].filter(
        (result) => result.status === 'fulfilled' && result.value.claimed,
      ),
    ).toHaveLength(1);
    expect(
      [approve, reject].filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });

  it('rejects a reused event id on another record', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    await seedDelivered(store, snapshot());
    await store.claimDecision(decision());
    await seedDelivered(
      store,
      snapshot({ recordId: 'rec_outbound_2', version: 1 }),
      'rec_outbound_2',
    );

    await expect(
      store.claimDecision(
        decision({
          recordId: 'rec_outbound_2',
          messageId: 'om_approval_approver_a_rec_outbound_2',
          eventId: 'evt_approve_1',
        }),
      ),
    ).rejects.toThrow('事件标识已被其他审批载荷占用');
  });

  it('enforces a trimmed rejection reason of 2 to 500 Unicode characters', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    await seedDelivered(store, snapshot());
    await expect(
      store.claimDecision(
        decision({ action: 'reject', reason: '拒', eventId: 'evt_short' }),
      ),
    ).rejects.toThrow('2–500');
    await expect(
      store.claimDecision(
        decision({
          action: 'reject',
          reason: '拒'.repeat(501),
          eventId: 'evt_long',
        }),
      ),
    ).rejects.toThrow('2–500');

    await expect(
      store.claimDecision(
        decision({
          action: 'reject',
          reason: '  拒绝  ',
          eventId: 'evt_valid_reject',
        }),
      ),
    ).resolves.toMatchObject({
      claimed: true,
      decision: { action: 'reject', reason: '拒绝' },
    });

    const second = new InventoryOutboundApprovalStore(
      join(directory, 'approval-ledger-500.json'),
    );
    await seedDelivered(
      second,
      snapshot({ recordId: 'rec_outbound_500' }),
      'rec_outbound_500',
    );
    await expect(
      second.claimDecision(
        decision({
          recordId: 'rec_outbound_500',
          messageId: 'om_approval_approver_a_rec_outbound_500',
          action: 'reject',
          reason: '拒'.repeat(500),
          eventId: 'evt_500',
        }),
      ),
    ).resolves.toMatchObject({ claimed: true });
  });

  it('normalizes multiline rejection reasons and counts emoji by Unicode code point', async () => {
    const multilineRecordId = 'rec_multiline';
    const multiline = new InventoryOutboundApprovalStore(
      join(directory, 'approval-ledger-multiline.json'),
    );
    await seedDelivered(
      multiline,
      snapshot({ recordId: multilineRecordId }),
      multilineRecordId,
    );
    await expect(
      multiline.claimDecision(
        decision({
          recordId: multilineRecordId,
          messageId: 'om_approval_approver_a_rec_multiline',
          action: 'reject',
          reason: '  第一行\r\n第二行\r第三行  ',
          eventId: 'evt_multiline',
        }),
      ),
    ).resolves.toMatchObject({
      claimed: true,
      decision: { reason: '第一行\n第二行\n第三行' },
    });

    const emoji500RecordId = 'rec_emoji_500';
    const emoji500 = new InventoryOutboundApprovalStore(
      join(directory, 'approval-ledger-emoji-500.json'),
    );
    await seedDelivered(
      emoji500,
      snapshot({ recordId: emoji500RecordId }),
      emoji500RecordId,
    );
    await expect(
      emoji500.claimDecision(
        decision({
          recordId: emoji500RecordId,
          messageId: 'om_approval_approver_a_rec_emoji_500',
          action: 'reject',
          reason: '😀'.repeat(500),
          eventId: 'evt_emoji_500',
        }),
      ),
    ).resolves.toMatchObject({ claimed: true });

    const emoji501RecordId = 'rec_emoji_501';
    const emoji501 = new InventoryOutboundApprovalStore(
      join(directory, 'approval-ledger-emoji-501.json'),
    );
    await seedDelivered(
      emoji501,
      snapshot({ recordId: emoji501RecordId }),
      emoji501RecordId,
    );
    await expect(
      emoji501.claimDecision(
        decision({
          recordId: emoji501RecordId,
          messageId: 'om_approval_approver_a_rec_emoji_501',
          action: 'reject',
          reason: '😀'.repeat(501),
          eventId: 'evt_emoji_501',
        }),
      ),
    ).rejects.toThrow('2–500');

    const tabRecordId = 'rec_tab_reason';
    const tabReason = new InventoryOutboundApprovalStore(
      join(directory, 'approval-ledger-tab-reason.json'),
    );
    await seedDelivered(
      tabReason,
      snapshot({ recordId: tabRecordId }),
      tabRecordId,
    );
    await expect(
      tabReason.claimDecision(
        decision({
          recordId: tabRecordId,
          messageId: 'om_approval_approver_a_rec_tab_reason',
          action: 'reject',
          reason: '\t有效原因\t',
          eventId: 'evt_tab_reason',
        }),
      ),
    ).rejects.toThrow('驳回原因无效');
  });

  it('creates independent pending Base sync, card patch, and deduplicated result notification steps', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    await seedDelivered(store, snapshot());
    const claimed = await store.claimDecision(decision());

    expect(claimed.entry.baseSync).toMatchObject({
      status: 'pending',
      attemptCount: 0,
    });
    expect(claimed.entry.cardPatches).toEqual([
      expect.objectContaining({
        recipientOpenId: 'ou_approver_a',
        messageId: 'om_approval_a',
        status: 'pending',
      }),
      expect.objectContaining({
        recipientOpenId: 'ou_approver_b',
        messageId: 'om_approval_b',
        status: 'pending',
      }),
    ]);
    expect(claimed.entry.resultNotifications).toEqual([
      expect.objectContaining({
        recipientOpenId: 'ou_applicant',
        status: 'pending',
        deliveryUuid: expect.stringMatching(UUID_PATTERN),
      }),
    ]);
  });

  it('persists independent running, error, and completed states so retries touch only the failed step', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    await seedDelivered(store, snapshot());
    await store.claimDecision(decision());

    const baseClaim = await store.claimWork(baseSyncRef());
    expect(baseClaim).toMatchObject({
      claimed: true,
      work: { status: 'running', attemptCount: 1 },
    });
    const patchClaim = await store.claimWork(cardPatchRef('ou_approver_a'));
    expect(patchClaim).toMatchObject({
      claimed: true,
      work: { status: 'running' },
    });
    const notificationClaim = await store.claimWork(
      resultNotificationRef('ou_applicant'),
    );
    expect(notificationClaim).toMatchObject({
      claimed: true,
      work: { status: 'running' },
    });

    await store.failWork({
      ...workCommand(baseSyncRef(), baseClaim),
      error: 'Base timeout',
      nextAttemptAt: '2026-08-26T00:00:00.000Z',
    });
    await store.completeWork(
      workCommand(cardPatchRef('ou_approver_a'), patchClaim),
    );
    await store.completeWork({
      ...workCommand(resultNotificationRef('ou_applicant'), notificationClaim),
      messageId: 'om_result_applicant',
    });

    const afterPartial = await store.find('rec_outbound_1', 1);
    expect(afterPartial?.baseSync).toMatchObject({
      status: 'error',
      lastError: 'Base timeout',
      attemptCount: 1,
    });
    expect(afterPartial?.cardPatches[0].status).toBe('completed');
    expect(afterPartial?.resultNotifications[0]).toMatchObject({
      status: 'completed',
      messageId: 'om_result_applicant',
    });

    const retryClaim = await store.claimWork(baseSyncRef());
    expect(retryClaim).toMatchObject({
      claimed: true,
      work: { status: 'running', attemptCount: 2 },
    });
    await store.completeWork(workCommand(baseSyncRef(), retryClaim));
    expect((await store.find('rec_outbound_1', 1))?.cardPatches[0].status).toBe(
      'completed',
    );
  });

  it('recovers an expired work lease and rejects the stale owner', async () => {
    let now = new Date('2026-08-26T00:00:00.000Z');
    const options: InventoryOutboundApprovalStoreOptions = {
      now: () => now,
      workLeaseMs: 100,
      lockRetryDelayMs: 1,
    };
    const firstStore = new InventoryOutboundApprovalStore(ledgerPath, options);
    const secondStore = new InventoryOutboundApprovalStore(ledgerPath, options);
    await seedDelivered(firstStore, snapshot());
    await firstStore.claimDecision(decision());
    const staleClaim = await firstStore.claimWork(baseSyncRef());
    expect(staleClaim.claimed).toBe(true);
    now = new Date('2026-08-26T00:00:00.101Z');

    expect((await secondStore.claimWork(baseSyncRef())).claimed).toBe(true);
    await expect(
      firstStore.completeWork(workCommand(baseSyncRef(), staleClaim)),
    ).rejects.toThrow('lease 所有权已变更');
  });

  it('persists a fresh lease token for every claim and rejects a stale executor token', async () => {
    let now = new Date('2026-08-26T00:00:00.000Z');
    const options: InventoryOutboundApprovalStoreOptions = {
      now: () => now,
      workLeaseMs: 100,
      lockRetryDelayMs: 1,
    };
    const firstStore = new InventoryOutboundApprovalStore(ledgerPath, options);
    const secondStore = new InventoryOutboundApprovalStore(ledgerPath, options);
    await seedDelivered(firstStore, snapshot());
    await firstStore.claimDecision(decision());

    const firstClaim = await firstStore.claimWork(baseSyncRef());
    const firstToken = leaseTokenOf(firstClaim);
    expect(firstToken).toMatch(UUID_PATTERN);
    expect(readBaseSyncLeaseToken(ledgerPath)).toBe(firstToken);

    now = new Date('2026-08-26T00:00:00.101Z');
    const secondClaim = await secondStore.claimWork(baseSyncRef());
    const secondToken = leaseTokenOf(secondClaim);
    expect(secondToken).toMatch(UUID_PATTERN);
    expect(secondToken).not.toBe(firstToken);
    expect(readBaseSyncLeaseToken(ledgerPath)).toBe(secondToken);

    await expect(
      firstStore.completeWork({ ...baseSyncRef(), leaseToken: firstToken }),
    ).rejects.toThrow('lease');
    await expect(
      secondStore.completeWork({ ...baseSyncRef(), leaseToken: secondToken }),
    ).resolves.toMatchObject({
      baseSync: { status: 'completed' },
    });
  });

  it('requires the current lease token for complete, fail, renew, and abandon', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    await seedDelivered(store, snapshot());
    await store.claimDecision(decision());
    const claim = await store.claimWork(baseSyncRef());
    const leaseToken = leaseTokenOf(claim);
    const stale = '00000000-0000-4000-8000-000000000000';

    await expect(
      store.completeWork({ ...baseSyncRef(), leaseToken: stale }),
    ).rejects.toThrow('lease');
    await expect(
      store.failWork({
        ...baseSyncRef(),
        leaseToken: stale,
        error: 'temporary failure',
      }),
    ).rejects.toThrow('lease');
    await expect(
      store.renewWorkClaim({ ...baseSyncRef(), leaseToken: stale }),
    ).rejects.toThrow('lease');
    await expect(
      store.abandonWorkClaim({ ...baseSyncRef(), leaseToken: stale }),
    ).rejects.toThrow('lease');

    await expect(
      store.renewWorkClaim({ ...baseSyncRef(), leaseToken }),
    ).resolves.toMatchObject({ baseSync: { status: 'running' } });
    await expect(
      store.abandonWorkClaim({ ...baseSyncRef(), leaseToken }),
    ).resolves.toBe(true);
  });

  it('keeps a claim retryable when persisting its completion fails', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath, {
      lockTimeoutMs: 20,
      lockRetryDelayMs: 1,
    });
    await seedDelivered(store, snapshot());
    await store.claimDecision(decision());
    const claim = await store.claimWork(baseSyncRef());
    const command = { ...baseSyncRef(), leaseToken: leaseTokenOf(claim) };
    const originalRenameSync = fs.renameSync;
    const renameSpy = jest
      .spyOn(fs, 'renameSync')
      .mockImplementation((source, destination) => {
        if (
          String(source).endsWith('.tmp') &&
          String(destination) === ledgerPath
        ) {
          throw Object.assign(new Error('resource busy or locked'), {
            code: 'EBUSY',
          });
        }
        return originalRenameSync(source, destination);
      });

    await expect(store.completeWork(command)).rejects.toThrow(
      ServiceUnavailableException,
    );
    renameSpy.mockRestore();
    await expect(store.completeWork(command)).resolves.toMatchObject({
      baseSync: { status: 'completed' },
    });
  });

  it('recovers a work lease whose recorded process owner is dead', async () => {
    const firstStore = new InventoryOutboundApprovalStore(ledgerPath);
    const secondStore = new InventoryOutboundApprovalStore(ledgerPath);
    await seedDelivered(firstStore, snapshot());
    await firstStore.claimDecision(decision());
    await firstStore.claimWork(baseSyncRef());
    mutateLedger(ledgerPath, (state) => {
      const owner = state.entries[0].baseSync?.owner;
      if (!owner) throw new Error('expected Base sync owner');
      owner.pid = 2_147_483_647;
      owner.processStartedAtMs = 0;
    });

    expect((await secondStore.claimWork(baseSyncRef())).claimed).toBe(true);
  });

  it('renews and explicitly releases only the current store work lease', async () => {
    let now = new Date('2026-08-26T00:00:00.000Z');
    const options: InventoryOutboundApprovalStoreOptions = {
      now: () => now,
      workLeaseMs: 100,
    };
    const owner = new InventoryOutboundApprovalStore(ledgerPath, options);
    const other = new InventoryOutboundApprovalStore(ledgerPath, options);
    await seedDelivered(owner, snapshot());
    await owner.claimDecision(decision());
    const claim = await owner.claimWork(baseSyncRef());
    const command = workCommand(baseSyncRef(), claim);
    now = new Date('2026-08-26T00:00:00.050Z');
    await owner.renewWorkClaim(command);
    now = new Date('2026-08-26T00:00:00.120Z');

    expect((await other.claimWork(baseSyncRef())).claimed).toBe(false);
    await expect(other.abandonWorkClaim(command)).rejects.toThrow('lease');
    await expect(owner.abandonWorkClaim(command)).resolves.toBe(true);
    expect((await other.claimWork(baseSyncRef())).claimed).toBe(true);
  });

  it('recovers stale ledger and recovery locks without leaving artifacts', async () => {
    const lockPath = `${ledgerPath}.lock`;
    const recoveryPath = `${lockPath}.recovery`;
    writeFileSync(lockPath, 'orphaned-lock', 'utf8');
    writeFileSync(recoveryPath, 'orphaned-recovery', 'utf8');
    const staleAt = new Date(Date.now() - 60_000);
    utimesSync(lockPath, staleAt, staleAt);
    utimesSync(recoveryPath, staleAt, staleAt);
    const store = new InventoryOutboundApprovalStore(ledgerPath, {
      lockTimeoutMs: 200,
      lockRetryDelayMs: 1,
      staleLockMs: 10,
    });

    await expect(store.registerPending(snapshot())).resolves.toMatchObject({
      created: true,
    });
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(recoveryPath)).toBe(false);
  });

  it('retries transient Windows EPERM rename and EBUSY unlink failures', async () => {
    const lockPath = `${ledgerPath}.lock`;
    const originalRenameSync = fs.renameSync;
    const originalUnlinkSync = fs.unlinkSync;
    let renameAttempts = 0;
    let unlinkAttempts = 0;
    jest.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (
        String(source).endsWith('.tmp') &&
        String(destination) === ledgerPath &&
        renameAttempts++ === 0
      ) {
        throw Object.assign(new Error('operation not permitted'), {
          code: 'EPERM',
        });
      }
      return originalRenameSync(source, destination);
    });
    jest.spyOn(fs, 'unlinkSync').mockImplementation((path) => {
      if (String(path) === lockPath && unlinkAttempts++ === 0) {
        throw Object.assign(new Error('resource busy or locked'), {
          code: 'EBUSY',
        });
      }
      return originalUnlinkSync(path);
    });

    const store = new InventoryOutboundApprovalStore(ledgerPath, {
      lockRetryDelayMs: 1,
    });
    await expect(store.registerPending(snapshot())).resolves.toMatchObject({
      created: true,
    });
    await expect(store.listEntries()).resolves.toHaveLength(1);
    expect(renameAttempts).toBeGreaterThanOrEqual(2);
    expect(unlinkAttempts).toBeGreaterThanOrEqual(2);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('retries a transient Windows rename while quarantining a stale ledger lock', async () => {
    const lockPath = `${ledgerPath}.lock`;
    writeStaleFile(lockPath, 'orphaned-lock');
    const originalRenameSync = fs.renameSync;
    let quarantineRenameAttempts = 0;
    jest.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (
        String(source) === lockPath &&
        String(destination).endsWith('.stale') &&
        quarantineRenameAttempts++ === 0
      ) {
        throw Object.assign(new Error('operation not permitted'), {
          code: 'EPERM',
        });
      }
      return originalRenameSync(source, destination);
    });

    const store = windowsRecoveryStore(ledgerPath);
    await expect(store.registerPending(snapshot())).resolves.toMatchObject({
      created: true,
    });
    await expect(store.listEntries()).resolves.toHaveLength(1);
    expect(quarantineRenameAttempts).toBeGreaterThanOrEqual(2);
  });

  it('retries a transient Windows rename while quarantining a stale recovery guard', async () => {
    const lockPath = `${ledgerPath}.lock`;
    const recoveryPath = `${lockPath}.recovery`;
    writeStaleFile(lockPath, 'orphaned-lock');
    writeStaleFile(recoveryPath, 'orphaned-recovery');
    const originalRenameSync = fs.renameSync;
    let quarantineRenameAttempts = 0;
    jest.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (
        String(source) === recoveryPath &&
        String(destination).endsWith('.stale') &&
        quarantineRenameAttempts++ === 0
      ) {
        throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      }
      return originalRenameSync(source, destination);
    });

    const store = windowsRecoveryStore(ledgerPath);
    await expect(store.registerPending(snapshot())).resolves.toMatchObject({
      created: true,
    });
    await expect(store.listEntries()).resolves.toHaveLength(1);
    expect(quarantineRenameAttempts).toBeGreaterThanOrEqual(2);
  });

  it('retries a transient Windows unlink while removing a stale lock quarantine', async () => {
    const lockPath = `${ledgerPath}.lock`;
    writeStaleFile(lockPath, 'orphaned-lock');
    const originalUnlinkSync = fs.unlinkSync;
    let quarantineUnlinkAttempts = 0;
    jest.spyOn(fs, 'unlinkSync').mockImplementation((path) => {
      if (
        String(path).startsWith(`${lockPath}.`) &&
        String(path).endsWith('.stale') &&
        quarantineUnlinkAttempts++ === 0
      ) {
        throw Object.assign(new Error('resource busy or locked'), {
          code: 'EBUSY',
        });
      }
      return originalUnlinkSync(path);
    });

    const store = windowsRecoveryStore(ledgerPath);
    await expect(store.registerPending(snapshot())).resolves.toMatchObject({
      created: true,
    });
    await expect(store.listEntries()).resolves.toHaveLength(1);
    expect(quarantineUnlinkAttempts).toBeGreaterThanOrEqual(2);
  });

  it('retries a transient Windows unlink while releasing a recovery guard', async () => {
    const lockPath = `${ledgerPath}.lock`;
    const recoveryPath = `${lockPath}.recovery`;
    writeStaleFile(lockPath, 'orphaned-lock');
    const originalUnlinkSync = fs.unlinkSync;
    let guardUnlinkAttempts = 0;
    jest.spyOn(fs, 'unlinkSync').mockImplementation((path) => {
      if (String(path) === recoveryPath && guardUnlinkAttempts++ === 0) {
        throw Object.assign(new Error('operation not permitted'), {
          code: 'EPERM',
        });
      }
      return originalUnlinkSync(path);
    });

    const store = windowsRecoveryStore(ledgerPath);
    await expect(store.registerPending(snapshot())).resolves.toMatchObject({
      created: true,
    });
    await expect(store.listEntries()).resolves.toHaveLength(1);
    expect(guardUnlinkAttempts).toBeGreaterThanOrEqual(2);
  });

  it('never evicts an active or protected record while enforcing retention and capacity', async () => {
    let now = new Date('2026-08-26T00:00:00.000Z');
    const options: InventoryOutboundApprovalStoreOptions = {
      now: () => now,
      retentionTtlMs: 100,
      maxEntries: 1,
    };
    const store = new InventoryOutboundApprovalStore(ledgerPath, options);
    const terminalSnapshot = snapshot({
      applicantOpenId: 'ou_approver_a',
      applicantName: '审批人甲',
      approvers: [{ openId: 'ou_approver_a', name: '审批人甲' }],
    });
    await seedDelivered(store, terminalSnapshot);
    await store.claimDecision(decision());
    await completeStep(store, baseSyncRef());
    await completeStep(store, cardPatchRef('ou_approver_a'));
    now = new Date('2026-08-26T00:00:00.101Z');

    await expect(store.find('rec_outbound_1', 1)).resolves.toBeDefined();
    await expect(
      store.registerPending(
        snapshot({ recordId: 'rec_outbound_2', version: 1 }),
      ),
    ).resolves.toMatchObject({ created: true });
    await expect(store.find('rec_outbound_1', 1)).resolves.toBeUndefined();

    await expect(
      store.registerPending(
        snapshot({ recordId: 'rec_outbound_3', version: 1 }),
      ),
    ).rejects.toThrow('容量已满');
    await expect(store.find('rec_outbound_2', 1)).resolves.toBeDefined();
  });

  it('restores a pending Base approval with partial card delivery evidence and resumes only missing cards', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    const value = snapshot();
    const recovery: Extract<
      InventoryOutboundApprovalRecoveryResult,
      { kind: 'pending' }
    > = {
      kind: 'pending',
      snapshot: value,
      deliveries: [recoveredDelivery(value, 'ou_approver_a', 'om_recovered_a')],
    };

    await expect(store.restoreFromBase(recovery)).resolves.toMatchObject({
      created: true,
      entry: {
        registration: { status: 'ready' },
        approvalCards: [
          {
            recipientOpenId: 'ou_approver_a',
            status: 'completed',
            messageId: 'om_recovered_a',
          },
          { recipientOpenId: 'ou_approver_b', status: 'pending' },
        ],
      },
    });
    await expect(store.restoreFromBase(recovery)).resolves.toMatchObject({
      created: false,
    });
    await expect(
      store.claimWork(approvalCardRef('ou_approver_a')),
    ).resolves.toMatchObject({ claimed: false });
    await expect(
      store.claimWork(approvalCardRef('ou_approver_b')),
    ).resolves.toMatchObject({ claimed: true });
  });

  it('restores a decided Base approval without sending new actionable cards', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    const value = snapshot();
    const recovery: Extract<
      InventoryOutboundApprovalRecoveryResult,
      { kind: 'decided' }
    > = {
      kind: 'decided',
      snapshot: value,
      deliveries: [recoveredDelivery(value, 'ou_approver_a', 'om_recovered_a')],
      resultDeliveries: [],
      decision: {
        action: 'approve',
        actorOpenId: 'ou_approver_a',
        actorName: '审批人甲',
        messageId: 'om_recovered_a',
        eventId: 'evt_recovered_approve',
        decidedAt: '2026-08-26T00:01:00.000Z',
        reason: '',
      },
    };

    const restored = await store.restoreFromBase(recovery);
    expect(restored).toMatchObject({
      created: true,
      entry: {
        decision: recovery.decision,
        baseSync: { status: 'completed' },
        approvalCards: [
          {
            recipientOpenId: 'ou_approver_a',
            status: 'completed',
            messageId: 'om_recovered_a',
          },
          { recipientOpenId: 'ou_approver_b', status: 'cancelled' },
        ],
        cardPatches: [{ recipientOpenId: 'ou_approver_a', status: 'pending' }],
      },
    });
    expect(
      restored.entry.resultNotifications.map((work) => work.recipientOpenId),
    ).toEqual(['ou_applicant', 'ou_approver_b']);
    await expect(
      store.claimWork(approvalCardRef('ou_approver_b')),
    ).resolves.toMatchObject({ claimed: false });
    await expect(store.claimWork(baseSyncRef())).resolves.toMatchObject({
      claimed: false,
    });
    await expect(store.restoreFromBase(recovery)).resolves.toMatchObject({
      created: false,
      entry: { decision: recovery.decision },
    });
  });

  it('keeps an approved pending-confirmation recovery in the durable baseSync retry queue', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    const value = snapshot();
    const recovery: Extract<
      InventoryOutboundApprovalRecoveryResult,
      { kind: 'decided' }
    > = {
      kind: 'decided',
      snapshot: value,
      deliveries: [recoveredDelivery(value, 'ou_approver_a', 'om_recovered_a')],
      resultDeliveries: [],
      decision: {
        action: 'approve',
        actorOpenId: 'ou_approver_a',
        actorName: '审批人甲',
        messageId: 'om_recovered_a',
        eventId: 'evt_recovered_approve',
        decidedAt: '2026-08-26T00:01:00.000Z',
        reason: '',
      },
      requiresBusinessFinalization: true,
    };

    await expect(store.restoreFromBase(recovery)).resolves.toMatchObject({
      entry: { baseSync: { status: 'pending' } },
    });
    await expect(store.claimWork(baseSyncRef())).resolves.toMatchObject({
      claimed: true,
    });
  });

  it('keeps the ledger readable after repeating an approved pending-confirmation recovery', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    const value = snapshot();
    const recovery: Extract<
      InventoryOutboundApprovalRecoveryResult,
      { kind: 'decided' }
    > = {
      kind: 'decided',
      snapshot: value,
      deliveries: [recoveredDelivery(value, 'ou_approver_a', 'om_recovered_a')],
      resultDeliveries: [],
      decision: {
        action: 'approve',
        actorOpenId: 'ou_approver_a',
        actorName: '审批人甲',
        messageId: 'om_recovered_a',
        eventId: 'evt_recovered_approve',
        decidedAt: '2026-08-26T00:01:00.000Z',
        reason: '',
      },
      requiresBusinessFinalization: true,
    };

    await store.restoreFromBase(recovery);
    await store.restoreFromBase(recovery);

    await expect(store.listEntries()).resolves.toHaveLength(1);
    await expect(
      store.registerPending(
        snapshot({ recordId: 'rec_outbound_2', outboundNumber: 'outbound-2' }),
      ),
    ).resolves.toMatchObject({ created: true });
  });

  it('reads an existing pending baseSync with blank retry timestamps without discarding the ledger', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    const value = snapshot();
    await store.restoreFromBase({
      kind: 'decided',
      snapshot: value,
      deliveries: [recoveredDelivery(value, 'ou_approver_a', 'om_recovered_a')],
      resultDeliveries: [],
      decision: {
        action: 'approve',
        actorOpenId: 'ou_approver_a',
        actorName: '审批人甲',
        messageId: 'om_recovered_a',
        eventId: 'evt_recovered_approve',
        decidedAt: '2026-08-26T00:01:00.000Z',
        reason: '',
      },
      requiresBusinessFinalization: true,
    });
    mutateLedger(ledgerPath, (state) => {
      state.entries[0].baseSync.nextAttemptAt = '';
      state.entries[0].baseSync.completedAt = '';
    });

    await expect(
      new InventoryOutboundApprovalStore(ledgerPath).listEntries(),
    ).resolves.toMatchObject([{ baseSync: { status: 'pending' } }]);
  });

  it('atomically supersedes an unsafe historical decision with exactly one new approval version', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    const value = snapshot();
    const recovery: Extract<
      InventoryOutboundApprovalRecoveryResult,
      { kind: 'decided' }
    > = {
      kind: 'decided',
      snapshot: value,
      deliveries: [recoveredDelivery(value, 'ou_approver_a', 'om_recovered_a')],
      resultDeliveries: [],
      decision: {
        action: 'approve',
        actorOpenId: 'ou_approver_a',
        actorName: '旧审批人',
        messageId: 'om_recovered_a',
        eventId: 'evt_unsafe_historical',
        decidedAt: '2026-08-26T00:01:00.000Z',
        reason: '',
      },
      requiresBusinessFinalization: true,
    };
    await store.restoreFromBase(recovery);
    const replacement = snapshot({
      version: 2,
      policyVersion: 'inventory-outbound-responsible-v2',
      approvers: [{ openId: 'ou_current', name: '当前示例人员019' }],
    });

    await expect(
      store.supersedeApprovedDecision(
        value.recordId,
        value.version,
        replacement,
      ),
    ).resolves.toMatchObject({ created: true });
    await expect(
      store.supersedeApprovedDecision(
        value.recordId,
        value.version,
        replacement,
      ),
    ).resolves.toMatchObject({ created: false });

    const entries = await store.listEntries();
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.snapshot.version === 1)).toMatchObject(
      {
        baseSync: {
          status: 'cancelled',
          lastError: expect.stringContaining('版本 2'),
        },
        cardPatches: [{ status: 'pending', messageId: 'om_recovered_a' }],
      },
    );
    expect(entries.find((entry) => entry.snapshot.version === 2)).toMatchObject(
      {
        registration: { status: 'pending_base' },
        approvalCards: [{ recipientOpenId: 'ou_current', status: 'pending' }],
      },
    );
    await expect(store.claimDecision(decision())).rejects.toThrow(
      '审批版本已失效',
    );
    await expect(store.claimWork(baseSyncRef())).rejects.toThrow(
      '审批版本已失效',
    );
  });

  it('extends a complete v1 to v2 chain from its approved tail to v3 idempotently', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    const v1 = snapshot();
    await store.restoreFromBase({
      kind: 'decided',
      snapshot: v1,
      deliveries: [recoveredDelivery(v1, 'ou_approver_a', 'om_recovered_a')],
      resultDeliveries: [],
      decision: {
        action: 'approve',
        actorOpenId: 'ou_approver_a',
        actorName: '审批人甲',
        messageId: 'om_recovered_a',
        eventId: 'evt_v1_approved',
        decidedAt: '2026-08-26T00:01:00.000Z',
        reason: '',
      },
      requiresBusinessFinalization: true,
    });
    const v2 = snapshot({
      version: 2,
      policyVersion: 'inventory-outbound-responsible-v2',
      approvers: [{ openId: 'ou_responsible_v2', name: '二版示例人员019' }],
    });
    await store.supersedeApprovedDecision(v1.recordId, 1, v2);
    await store.restoreFromBase({
      kind: 'decided',
      snapshot: v2,
      deliveries: [
        recoveredDelivery(v2, 'ou_responsible_v2', 'om_responsible_v2'),
      ],
      resultDeliveries: [],
      decision: {
        action: 'approve',
        actorOpenId: 'ou_responsible_v2',
        actorName: '二版示例人员019',
        messageId: 'om_responsible_v2',
        eventId: 'evt_v2_approved',
        decidedAt: '2026-08-27T00:01:00.000Z',
        reason: '',
      },
      requiresBusinessFinalization: true,
    });
    const v3 = snapshot({
      version: 3,
      policyVersion: 'inventory-outbound-responsible-v3',
      approvers: [{ openId: 'ou_responsible_v3', name: '三版示例人员019' }],
    });

    await expect(
      store.supersedeApprovedDecision(v2.recordId, 2, v3),
    ).resolves.toMatchObject({ created: true });
    await expect(
      store.supersedeApprovedDecision(v2.recordId, 2, v3),
    ).resolves.toMatchObject({ created: false });

    const entries = await store.listEntries();
    expect(entries.map((entry) => entry.snapshot.version)).toEqual([1, 2, 3]);
    expect(entries[0].baseSync?.lastError).toContain('版本 2');
    expect(entries[1].baseSync?.lastError).toContain('版本 3');
    expect(entries[2]).toMatchObject({
      registration: { status: 'pending_base' },
      approvalCards: [
        { recipientOpenId: 'ou_responsible_v3', status: 'pending' },
      ],
    });
  });

  it('rejects a different v2 snapshot forked from superseded v1', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    const v1 = snapshot();
    await store.restoreFromBase({
      kind: 'decided',
      snapshot: v1,
      deliveries: [recoveredDelivery(v1, 'ou_approver_a', 'om_recovered_a')],
      resultDeliveries: [],
      decision: {
        action: 'approve',
        actorOpenId: 'ou_approver_a',
        actorName: '审批人甲',
        messageId: 'om_recovered_a',
        eventId: 'evt_v1_approved',
        decidedAt: '2026-08-26T00:01:00.000Z',
        reason: '',
      },
      requiresBusinessFinalization: true,
    });
    const v2 = snapshot({
      version: 2,
      policyVersion: 'inventory-outbound-responsible-v2',
      approvers: [{ openId: 'ou_responsible_v2', name: '二版示例人员019' }],
    });
    await store.supersedeApprovedDecision(v1.recordId, 1, v2);

    await expect(
      store.supersedeApprovedDecision(
        v1.recordId,
        1,
        snapshot({
          version: 2,
          policyVersion: 'inventory-outbound-responsible-v2',
          approvers: [{ openId: 'ou_forked', name: '错误分支示例人员019' }],
        }),
      ),
    ).rejects.toThrow('替代审批快照与已持久化版本冲突');
    await expect(store.listEntries()).resolves.toHaveLength(2);
  });

  it('restores completed result-notification delivery evidence without resending it', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    const value = snapshot();
    const recoveredDecision = {
      action: 'approve' as const,
      actorOpenId: 'ou_approver_a',
      actorName: '审批人甲',
      messageId: 'om_recovered_a',
      eventId: 'evt_recovered_approve',
      decidedAt: '2026-08-26T00:01:00.000Z',
      reason: '',
    };
    const recovery: Extract<
      InventoryOutboundApprovalRecoveryResult,
      { kind: 'decided' }
    > = {
      kind: 'decided',
      snapshot: value,
      deliveries: [recoveredDelivery(value, 'ou_approver_a', 'om_recovered_a')],
      resultDeliveries: [
        recoveredResultDelivery(
          value,
          recoveredDecision.action,
          'ou_applicant',
          value.applicantName,
          'om_result_applicant',
        ),
      ],
      decision: recoveredDecision,
    };

    await expect(store.restoreFromBase(recovery)).resolves.toMatchObject({
      entry: {
        resultNotifications: [
          {
            recipientOpenId: 'ou_applicant',
            status: 'completed',
            messageId: 'om_result_applicant',
          },
          { recipientOpenId: 'ou_approver_b', status: 'pending' },
        ],
      },
    });
    await expect(
      store.claimWork(resultNotificationRef('ou_applicant')),
    ).resolves.toMatchObject({ claimed: false });
  });

  it('serializes result-notification claims across processes so Base delivery ledgers cannot overwrite each other', async () => {
    const first = new InventoryOutboundApprovalStore(ledgerPath);
    const second = new InventoryOutboundApprovalStore(ledgerPath);
    const value = snapshot();
    await first.restoreFromBase({
      kind: 'decided',
      snapshot: value,
      deliveries: [recoveredDelivery(value, 'ou_approver_a', 'om_recovered_a')],
      resultDeliveries: [],
      decision: {
        action: 'approve',
        actorOpenId: 'ou_approver_a',
        actorName: '审批人甲',
        messageId: 'om_recovered_a',
        eventId: 'evt_recovered_approve',
        decidedAt: '2026-08-26T00:01:00.000Z',
        reason: '',
      },
    });

    const applicantClaim = await first.claimWork(
      resultNotificationRef('ou_applicant'),
    );
    expect(applicantClaim).toMatchObject({ claimed: true });
    await expect(
      second.claimWork(resultNotificationRef('ou_approver_b')),
    ).resolves.toMatchObject({ claimed: false });
    if (!applicantClaim.claimed) throw new Error('expected applicant claim');
    await first.completeWork({
      ...resultNotificationRef('ou_applicant'),
      leaseToken: applicantClaim.leaseToken,
      messageId: 'om_result_applicant',
    });
    await expect(
      second.claimWork(resultNotificationRef('ou_approver_b')),
    ).resolves.toMatchObject({ claimed: true });
  });

  it('fails closed when Base recovery conflicts with the durable snapshot', async () => {
    const store = new InventoryOutboundApprovalStore(ledgerPath);
    const value = snapshot();
    await store.restoreFromBase({
      kind: 'pending',
      snapshot: value,
      deliveries: [],
    });

    await expect(
      store.restoreFromBase({
        kind: 'pending',
        snapshot: snapshot({ itemName: '冲突物品' }),
        deliveries: [],
      }),
    ).rejects.toThrow('审批快照冲突');
    await expect(
      store.find(value.recordId, value.version),
    ).resolves.toMatchObject({ snapshot: { itemName: '地磅秤' } });
  });
});

function snapshot(
  overrides: Partial<InventoryOutboundApprovalSnapshot> = {},
): InventoryOutboundApprovalSnapshot {
  return {
    recordId: 'rec_outbound_1',
    outboundNumber: 'outbound-client-mutation-001',
    version: 1,
    policyVersion: 'warehouse-manager-v1',
    applicantOpenId: 'ou_applicant',
    applicantName: '申请人',
    itemName: '地磅秤',
    sku: 'B1056',
    specification: '0.6×0.8米1吨',
    brand: '正峰',
    quantity: 1,
    unit: '台',
    availableStock: 1,
    building: 'H楼',
    location: 'H-2F-226储存间01-0F',
    reason: '现场领用',
    appliedAt: '2026-08-26T00:00:00.000Z',
    approvers: [
      { openId: 'ou_approver_a', name: '审批人甲' },
      { openId: 'ou_approver_b', name: '审批人乙' },
    ],
    ...overrides,
  };
}

function recoveredDelivery(
  value: InventoryOutboundApprovalSnapshot,
  recipientOpenId: string,
  messageId: string,
) {
  const approver = value.approvers.find(
    (candidate) => candidate.openId === recipientOpenId,
  );
  if (!approver) throw new Error('missing approver');
  return {
    recipientOpenId,
    recipientName: approver.name,
    deliveryUuid: deterministicUuid(
      `inventory-outbound-approval-card:${value.recordId}:${value.version}:${recipientOpenId}`,
    ),
    messageId,
  };
}

function recoveredResultDelivery(
  value: InventoryOutboundApprovalSnapshot,
  action: 'approve' | 'reject',
  recipientOpenId: string,
  recipientName: string,
  messageId: string,
) {
  return {
    recipientOpenId,
    recipientName,
    deliveryUuid: deterministicUuid(
      `inventory-outbound-approval-result:${value.recordId}:${value.version}:${action}:${recipientOpenId}`,
    ),
    messageId,
  };
}

function deterministicUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function decision(
  overrides: Partial<InventoryOutboundApprovalDecisionInput> = {},
): InventoryOutboundApprovalDecisionInput {
  return {
    recordId: 'rec_outbound_1',
    version: 1,
    actorOpenId: 'ou_approver_a',
    messageId: 'om_approval_a',
    eventId: 'evt_approve_1',
    action: 'approve',
    ...overrides,
  };
}

function approvalCardRef(
  recipientOpenId: string,
  recordId = 'rec_outbound_1',
): InventoryOutboundApprovalWorkRef {
  return {
    recordId,
    version: 1,
    kind: 'approvalCardDelivery',
    recipientOpenId,
  };
}

function baseSyncRef(
  recordId = 'rec_outbound_1',
): InventoryOutboundApprovalWorkRef {
  return { recordId, version: 1, kind: 'baseSync' };
}

function cardPatchRef(
  recipientOpenId: string,
  recordId = 'rec_outbound_1',
): InventoryOutboundApprovalWorkRef {
  return { recordId, version: 1, kind: 'cardPatch', recipientOpenId };
}

function resultNotificationRef(
  recipientOpenId: string,
  recordId = 'rec_outbound_1',
): InventoryOutboundApprovalWorkRef {
  return {
    recordId,
    version: 1,
    kind: 'resultNotification',
    recipientOpenId,
  };
}

async function seedDelivered(
  store: InventoryOutboundApprovalStore,
  value: InventoryOutboundApprovalSnapshot,
  recordId = value.recordId,
): Promise<void> {
  await store.registerPending(value);
  await store.confirmPendingRegistration(value.recordId, value.version);
  for (const [index, approver] of value.approvers.entries()) {
    const ref = approvalCardRef(approver.openId, recordId);
    const claim = await store.claimWork(ref);
    if (!claim.claimed) throw new Error('expected approval card claim');
    await store.completeWork({
      ...workCommand(ref, claim),
      messageId:
        recordId === 'rec_outbound_1'
          ? approver.openId === 'ou_approver_a'
            ? 'om_approval_a'
            : approver.openId === 'ou_approver_b'
              ? 'om_approval_b'
              : `om_approval_${index + 1}`
          : `om_approval_${approver.openId.replace(/^ou_/u, '')}_${recordId}`,
    });
  }
}

async function completeStep(
  store: InventoryOutboundApprovalStore,
  ref: InventoryOutboundApprovalWorkRef,
): Promise<void> {
  const claim = await store.claimWork(ref);
  if (!claim.claimed) throw new Error(`expected ${ref.kind} claim`);
  await store.completeWork(workCommand(ref, claim));
}

function leaseTokenOf(value: unknown): string {
  if (!value || typeof value !== 'object' || !('leaseToken' in value)) {
    return '';
  }
  return typeof value.leaseToken === 'string' ? value.leaseToken : '';
}

function workCommand(
  ref: InventoryOutboundApprovalWorkRef,
  claim: unknown,
): InventoryOutboundApprovalWorkRef & { leaseToken: string } {
  return { ...ref, leaseToken: leaseTokenOf(claim) };
}

function readBaseSyncLeaseToken(path: string): string {
  const state = JSON.parse(readFileSync(path, 'utf8')) as {
    entries?: Array<{ baseSync?: { owner?: { token?: unknown } } }>;
  };
  const token = state.entries?.[0]?.baseSync?.owner?.token;
  return typeof token === 'string' ? token : '';
}

function writeStaleFile(path: string, contents: string): void {
  writeFileSync(path, contents, 'utf8');
  const staleAt = new Date(Date.now() - 60_000);
  utimesSync(path, staleAt, staleAt);
}

function windowsRecoveryStore(path: string): InventoryOutboundApprovalStore {
  return new InventoryOutboundApprovalStore(path, {
    lockTimeoutMs: 200,
    lockRetryDelayMs: 1,
    staleLockMs: 10,
  });
}

interface MutableLedgerState {
  version: number;
  entries: Array<{
    snapshotFingerprint?: string;
    registration?: {
      status: string;
      attemptCount: number;
      lastAttemptAt?: string;
      lastError?: string;
      confirmedAt?: string;
    };
    approvalCards: Array<{
      recipientOpenId: string;
      status: string;
      attemptCount: number;
      owner?: unknown;
      completedAt?: string;
      lastError?: string;
      nextAttemptAt?: string;
    }>;
    baseSync?: {
      owner?: { pid: number; processStartedAtMs: number };
    };
    cardPatches: Array<{
      recipientOpenId: string;
      messageId: string;
    }>;
    resultNotifications: MutableResultNotification[];
  }>;
}

interface MutableResultNotification {
  id: string;
  kind: 'resultNotification';
  status: 'pending' | 'error' | 'completed';
  attemptCount: number;
  recipientOpenId: string;
  recipientName: string;
  deliveryUuid: string;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  lastError?: string;
  completedAt?: string;
  messageId?: string;
}

function legacyResultNotification(
  status: MutableResultNotification['status'],
): MutableResultNotification {
  const completed = status === 'completed';
  const failed = status === 'error';
  return {
    id: 'result-notification:ou_approver_b',
    kind: 'resultNotification',
    status,
    attemptCount: completed || failed ? 1 : 0,
    recipientOpenId: 'ou_approver_b',
    recipientName: '审批人乙',
    deliveryUuid: stableTestUuid(
      'inventory-outbound-approval-result:rec_outbound_1:1:approve:ou_approver_b',
    ),
    ...(completed
      ? {
          lastAttemptAt: '2026-08-26T00:00:00.000Z',
          completedAt: '2026-08-26T00:00:01.000Z',
          messageId: 'om_result_approver_b_legacy',
        }
      : {}),
    ...(failed
      ? {
          lastAttemptAt: '2026-08-26T00:00:00.000Z',
          nextAttemptAt: '2026-08-26T00:00:01.000Z',
          lastError: 'legacy notification send result unknown',
        }
      : {}),
  };
}

function stableTestUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mutateLedger(
  path: string,
  mutate: (state: MutableLedgerState) => void,
): void {
  const state = JSON.parse(readFileSync(path, 'utf8')) as MutableLedgerState;
  mutate(state);
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
