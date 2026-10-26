import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryOutboundApprovalService as ActualInventoryOutboundApprovalService } from './inventory-outbound-approval.service';
import { withSyntheticBusinessIdentity } from '../../../test/unit/synthetic-business-identity.fixture';
const InventoryOutboundApprovalService = withSyntheticBusinessIdentity(ActualInventoryOutboundApprovalService, 5);
type InventoryOutboundApprovalService = ActualInventoryOutboundApprovalService;
import { InventoryOutboundApprovalStore } from './inventory-outbound-approval.store';
import { InventoryBatchCardService } from './inventory-batch-card.service';
import type {
  InventoryOutboundApprovalDecision,
  InventoryOutboundApprovalSnapshot,
} from './inventory-outbound-approval.types';

describe('InventoryOutboundApprovalService', () => {
  let directory: string;
  let store: InventoryOutboundApprovalStore;
  let gateway: ReturnType<typeof createGateway>;
  let finalizer: ReturnType<typeof createFinalizer>;
  let warehouseRoleDirectory: ReturnType<typeof createWarehouseRoleDirectory>;
  let service: InventoryOutboundApprovalService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'outbound-approval-service-'));
    store = new InventoryOutboundApprovalStore(join(directory, 'ledger.json'));
    gateway = createGateway();
    finalizer = createFinalizer();
    warehouseRoleDirectory = createWarehouseRoleDirectory();
    service = new InventoryOutboundApprovalService(
      store,
      gateway as never,
      finalizer as never,
      warehouseRoleDirectory as never,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it('delivers one actionable card for two batch outbounds and keeps decisions per record', async () => {
    const batchCard = new InventoryBatchCardService(gateway as never, join(directory, 'batch-cards.json'));
    service = new InventoryOutboundApprovalService(
      store, gateway as never, finalizer as never, warehouseRoleDirectory as never, batchCard,
    );
    const batchId = 'a'.repeat(32);
    const approvers = [{ openId: 'ou_approver_a', name: '审批人甲' }];
    await service.registerPending(snapshot({
      outboundNumber: `inventory_batch_outbound_${batchId}_1`, approvers,
    }));
    await service.registerPending(snapshot({
      recordId: 'rec_outbound_2', outboundNumber: `inventory_batch_outbound_${batchId}_2`, approvers,
    }));
    await service.runPending();
    await batchCard.flushPending();
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    const messageId = (await store.find('rec_outbound_1', 1))?.approvalCards[0].messageId;
    expect((await store.find('rec_outbound_2', 1))?.approvalCards[0].messageId).toBe(messageId);
    const card = await batchCard.render('outbound', batchId, 'ou_approver_a');
    expect(JSON.stringify(card)).toContain('rec_outbound_1');
    expect(JSON.stringify(card)).toContain('rec_outbound_2');
    const action = await service.handleCardAction(directActionPayload('approve', 'ou_approver_a', messageId!));
    expect(action.claimed).toBe(true);
    expect(JSON.stringify(action.card)).toContain('同步中');
    expect((await store.find('rec_outbound_2', 1))?.decision).toBeUndefined();
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
  });

  it('reserves the durable approval outbox before writing and confirming the pending Base state', async () => {
    const order: string[] = [];
    const register = jest
      .spyOn(store, 'registerPending')
      .mockImplementation(async (value) => {
        order.push('ledger');
        return new InventoryOutboundApprovalStore(
          join(directory, 'shadow.json'),
        ).registerPending(value);
      });
    gateway.writePendingApproval.mockImplementation(async () => {
      order.push('base');
    });
    const confirm = jest
      .spyOn(store, 'confirmPendingRegistration')
      .mockImplementation(async () => {
        order.push('ready');
        return (
          await new InventoryOutboundApprovalStore(
            join(directory, 'confirmed.json'),
          ).registerPending(snapshot())
        ).entry;
      });

    await service.registerPending(snapshot());

    expect(order).toEqual(['ledger', 'base', 'ready']);
    expect(gateway.writePendingApproval).toHaveBeenCalledWith(snapshot());
    expect(register).toHaveBeenCalledWith(snapshot());
    expect(confirm).toHaveBeenCalledWith('rec_outbound_1', 1);
  });

  it('resumes a durable registration after restart without consulting mutable stock or role data', async () => {
    gateway.writePendingApproval.mockRejectedValueOnce(
      new Error('readback timeout'),
    );
    await expect(service.registerPending(snapshot())).rejects.toThrow(
      'readback timeout',
    );
    const restarted = new InventoryOutboundApprovalService(
      new InventoryOutboundApprovalStore(join(directory, 'ledger.json')),
      gateway as never,
    );
    const factory = jest
      .fn()
      .mockRejectedValue(new Error('directory unavailable'));
    await expect(
      restarted.ensurePendingForRequest(
        { recordId: snapshot().recordId, fields: {} },
        snapshot(),
        factory,
      ),
    ).resolves.toMatchObject({
      snapshot: snapshot(),
      registration: { status: 'ready' },
    });
    expect(factory).not.toHaveBeenCalled();
    await restarted.runPending();
    await restarted.ensurePendingForRequest(
      pendingRecoveryRecord(snapshot()),
      snapshot(),
      factory,
    );
    await restarted.runPending();
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(2);
    expect(gateway.clearWorkflowError).toHaveBeenCalledWith(
      snapshot().recordId,
    );
  });

  it('restores the Base snapshot into an empty ledger without generating a replacement', async () => {
    const factory = jest.fn().mockRejectedValue(new Error('must not rebuild'));
    await expect(
      service.ensurePendingForRequest(
        pendingRecoveryRecord(snapshot()),
        snapshot(),
        factory,
      ),
    ).resolves.toMatchObject({
      snapshot: snapshot(),
      registration: { status: 'ready' },
    });
    expect(factory).not.toHaveBeenCalled();
    expect(gateway.writePendingApproval).not.toHaveBeenCalled();
  });

  it('rejects conflicting persisted Base snapshots instead of accepting request identity alone', async () => {
    await service.registerPending(snapshot());
    await expect(
      service.ensurePendingForRequest(
        pendingRecoveryRecord(snapshot({ availableStock: 99 })),
        snapshot(),
        jest.fn(),
      ),
    ).rejects.toThrow('审批快照冲突');
    expect(gateway.clearWorkflowError).not.toHaveBeenCalled();
  });

  it.each([
    { quantity: 2 },
    { sku: 'OTHER' },
    { building: 'A楼' as const },
    { applicantOpenId: 'ou_other' },
    { outboundNumber: 'another-request' },
    { reason: 'another reason' },
    { appliedAt: '2026-08-27T10:30:00+08:00' },
  ])(
    'rejects a changed request during registration recovery: %j',
    async (change) => {
      await service.registerPending(snapshot());
      gateway.writePendingApproval.mockClear();
      await expect(
        service.ensurePendingForRequest(
          { recordId: snapshot().recordId, fields: {} },
          snapshot(change),
          jest.fn(),
        ),
      ).rejects.toThrow('申请与已持久化审批快照不一致');
      expect(gateway.writePendingApproval).not.toHaveBeenCalled();
    },
  );

  it('keeps the winner snapshot when two independent services race to register the same request', async () => {
    const second = new InventoryOutboundApprovalService(
      new InventoryOutboundApprovalStore(join(directory, 'ledger.json')),
      gateway as never,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const losingFactory = jest.fn(async () => {
      started();
      await gate;
      return snapshot({
        availableStock: 0,
        approvers: [{ openId: 'ou_new', name: '新示例人员019' }],
      });
    });
    const late = second.ensurePendingForRequest(
      { recordId: snapshot().recordId, fields: {} },
      snapshot(),
      losingFactory,
    );
    await entered;
    await service.ensurePendingForRequest(
      { recordId: snapshot().recordId, fields: {} },
      snapshot(),
      async () => snapshot(),
    );
    release();
    expect((await late).snapshot).toEqual(snapshot());
    await service.runPending();
    await second.runPending();
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(2);
    expect(gateway.writePendingApproval).toHaveBeenCalledTimes(1);
  });

  it('keeps an unconfirmed registration durable and safely retries the same snapshot', async () => {
    gateway.writePendingApproval.mockRejectedValueOnce(
      new Error('pending semantic readback failed'),
    );

    await expect(service.registerPending(snapshot())).rejects.toThrow(
      'pending semantic readback failed',
    );
    await expect(store.find('rec_outbound_1', 1)).resolves.toMatchObject({
      registration: {
        status: 'pending_base',
        attemptCount: 1,
        lastError: 'pending semantic readback failed',
      },
    });
    await expect(
      store.claimWork({
        recordId: 'rec_outbound_1',
        version: 1,
        kind: 'approvalCardDelivery',
        recipientOpenId: 'ou_approver_a',
      }),
    ).resolves.toMatchObject({ claimed: false });

    await expect(service.registerPending(snapshot())).resolves.toMatchObject({
      entry: { registration: { status: 'ready', attemptCount: 2 } },
    });
    expect(gateway.writePendingApproval).toHaveBeenCalledTimes(2);
  });

  it('never rewrites pending Base state for an already decided duplicate or a conflicting snapshot', async () => {
    await registerAndDeliver(service);
    await service.handleCardAction(
      directActionPayload('approve', 'ou_approver_a', 'om_approver_a'),
    );
    jest.clearAllMocks();

    await expect(service.registerPending(snapshot())).resolves.toMatchObject({
      entry: { decision: { action: 'approve' } },
    });
    await expect(
      service.registerPending(snapshot({ itemName: '冲突物品' })),
    ).rejects.toThrow('审批快照冲突');
    expect(gateway.writePendingApproval).not.toHaveBeenCalled();
  });

  it('delivers approval cards once with their pre-persisted stable UUIDs', async () => {
    await service.registerPending(snapshot());

    const first = await service.runPending();
    const registered = await store.find('rec_outbound_1', 1);

    expect(first).toMatchObject({ processed: 2, failed: 0 });
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(2);
    expect(gateway.sendInteractiveCard.mock.calls).toEqual(
      expect.arrayContaining(
        registered!.approvalCards.map((delivery) => [
          delivery.recipientOpenId,
          expect.any(Object),
          delivery.deliveryUuid,
        ]),
      ),
    );
    expect(gateway.writeApprovalCardDeliveryLedger.mock.calls).toEqual([
      [
        expect.objectContaining({ recordId: 'rec_outbound_1', version: 1 }),
        [
          expect.objectContaining({
            recipientOpenId: 'ou_approver_a',
            messageId: 'om_approver_a',
          }),
        ],
      ],
      [
        expect.objectContaining({ recordId: 'rec_outbound_1', version: 1 }),
        [
          expect.objectContaining({
            recipientOpenId: 'ou_approver_a',
            messageId: 'om_approver_a',
          }),
          expect.objectContaining({
            recipientOpenId: 'ou_approver_b',
            messageId: 'om_approver_b',
          }),
        ],
      ],
    ]);

    await service.runPending();
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(2);
  });

  it('does not consume the run limit or report success when another instance owns the work claim', async () => {
    await service.registerPending(
      snapshot({
        approvers: [{ openId: 'ou_approver_a', name: '审批人甲' }],
      }),
    );
    const entry = (await store.find('rec_outbound_1', 1))!;
    const work = entry.approvalCards[0];
    const claim = jest.spyOn(store, 'claimWork').mockResolvedValueOnce({
      claimed: false,
      entry,
      work,
    });

    await expect(service.runPending(1)).resolves.toEqual({
      processed: 0,
      failed: 0,
    });
    expect(claim).toHaveBeenCalledTimes(1);

    claim.mockRestore();
    await expect(service.runPending(1)).resolves.toEqual({
      processed: 1,
      failed: 0,
    });
  });

  it('renews a work lease while a slow public call is still running', async () => {
    store = new InventoryOutboundApprovalStore(join(directory, 'slow.json'), {
      workLeaseMs: 1_000,
    });
    gateway = createGateway();
    service = new InventoryOutboundApprovalService(store, gateway as never);
    const renew = jest.spyOn(store, 'renewWorkClaim');
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    gateway.sendInteractiveCard.mockImplementationOnce(async () => {
      markStarted();
      await delay(2_200);
      return 'om_approver_a';
    });
    await service.registerPending(
      snapshot({
        approvers: [{ openId: 'ou_approver_a', name: '审批人甲' }],
      }),
    );

    const running = service.runPending(1);
    await started;
    await delay(1_500);
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(2);
    const competitor = new InventoryOutboundApprovalStore(
      join(directory, 'slow.json'),
      { workLeaseMs: 1_000 },
    );
    await expect(
      competitor.claimWork({
        recordId: 'rec_outbound_1',
        version: 1,
        kind: 'approvalCardDelivery',
        recipientOpenId: 'ou_approver_a',
      }),
    ).resolves.toMatchObject({ claimed: false });
    await expect(running).resolves.toEqual({ processed: 1, failed: 0 });
  });

  it('rotates a one-item run budget so approval-card backlog cannot starve decision sync', async () => {
    await service.registerPending(
      snapshot({
        approvers: [{ openId: 'ou_approver_a', name: '审批人甲' }],
      }),
    );
    await service.runPending(1);
    await service.handleCardAction(
      directActionPayload('approve', 'ou_approver_a', 'om_approver_a'),
    );
    await service.registerPending(
      snapshot({
        recordId: 'rec_outbound_2',
        outboundNumber: 'outbound-client-mutation-002',
        approvers: [{ openId: 'ou_approver_b', name: '审批人乙' }],
      }),
    );
    jest.clearAllMocks();

    await expect(service.runPending(1)).resolves.toEqual({
      processed: 1,
      failed: 0,
    });
    expect(finalizer.finalizeApprovedOutbound).toHaveBeenCalledTimes(1);
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
  });

  it('retries only an uncertain card delivery with the same UUID', async () => {
    gateway.sendInteractiveCard
      .mockRejectedValueOnce(new Error('network outcome unknown'))
      .mockResolvedValueOnce('om_approver_b')
      .mockResolvedValueOnce('om_approver_a');
    await service.registerPending(snapshot());

    await expect(service.runPending()).resolves.toMatchObject({ failed: 1 });
    const firstUuid = gateway.sendInteractiveCard.mock.calls[0][2];
    await expect(service.runPending()).resolves.toMatchObject({ failed: 0 });

    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(3);
    expect(gateway.sendInteractiveCard.mock.calls[2][2]).toBe(firstUuid);
  });

  it('retries with the same UUID when the card was sent but the Base delivery ledger write failed', async () => {
    gateway.sendInteractiveCard.mockResolvedValue('om_same_card');
    gateway.writeApprovalCardDeliveryLedger
      .mockRejectedValueOnce(new Error('delivery ledger readback failed'))
      .mockResolvedValueOnce(undefined);
    await service.registerPending(
      snapshot({
        approvers: [{ openId: 'ou_approver_a', name: '审批人甲' }],
      }),
    );

    await expect(service.runPending(1)).resolves.toEqual({
      processed: 0,
      failed: 1,
    });
    await expect(service.runPending(1)).resolves.toEqual({
      processed: 1,
      failed: 0,
    });

    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(2);
    expect(gateway.sendInteractiveCard.mock.calls[1][2]).toBe(
      gateway.sendInteractiveCard.mock.calls[0][2],
    );
    expect(gateway.writeApprovalCardDeliveryLedger).toHaveBeenCalledTimes(2);
    expect(gateway.writeApprovalCardDeliveryLedger.mock.calls[0][1]).toEqual(
      gateway.writeApprovalCardDeliveryLedger.mock.calls[1][1],
    );
    await expect(store.find('rec_outbound_1', 1)).resolves.toMatchObject({
      approvalCards: [
        { status: 'completed', messageId: 'om_same_card', attemptCount: 2 },
      ],
    });
  });

  it('persists result-notification delivery evidence before completing local work and retries with the same UUID', async () => {
    await registerAndDeliver(service);
    await service.handleCardAction(
      directActionPayload('approve', 'ou_approver_a', 'om_approver_a'),
    );
    jest.clearAllMocks();
    gateway.sendInteractiveCard.mockResolvedValue('om_result_applicant');
    gateway.writeApprovalResultDeliveryLedger
      .mockRejectedValueOnce(
        new Error('result delivery ledger readback failed'),
      )
      .mockResolvedValueOnce(undefined);

    await expect(service.runPending()).resolves.toMatchObject({ failed: 1 });
    const firstUuid = gateway.sendInteractiveCard.mock.calls[0][2];
    await expect(service.runPending()).resolves.toMatchObject({ failed: 0 });

    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(2);
    expect(gateway.sendInteractiveCard.mock.calls[1][2]).toBe(firstUuid);
    expect(gateway.writeApprovalResultDeliveryLedger).toHaveBeenCalledTimes(2);
    expect(gateway.writeApprovalResultDeliveryLedger.mock.calls[0][2]).toEqual(
      gateway.writeApprovalResultDeliveryLedger.mock.calls[1][2],
    );
    await expect(store.find('rec_outbound_1', 1)).resolves.toMatchObject({
      resultNotifications: [
        {
          recipientOpenId: 'ou_applicant',
          status: 'completed',
          messageId: 'om_result_applicant',
          attemptCount: 2,
        },
      ],
    });
  });

  it('notifies warehouse managers of the result without granting them approval cards', async () => {
    const value = snapshot({
      managerRecipients: [
        { openId: 'ou_warehouse_manager', name: '库房管理员' },
      ],
    } as Partial<InventoryOutboundApprovalSnapshot>);
    await service.registerPending(value);
    await service.runPending();

    expect(
      gateway.sendInteractiveCard.mock.calls.map((call) => call[0]),
    ).toEqual(expect.arrayContaining(['ou_approver_a', 'ou_approver_b']));
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalledWith(
      'ou_warehouse_manager',
      expect.anything(),
      expect.anything(),
    );

    await service.handleCardAction(
      directActionPayload('approve', 'ou_approver_a', 'om_approver_a'),
    );
    jest.clearAllMocks();
    await expect(service.runPending()).resolves.toMatchObject({ failed: 0 });

    expect(
      gateway.sendInteractiveCard.mock.calls.map((call) => call[0]),
    ).toEqual(expect.arrayContaining(['ou_applicant', 'ou_warehouse_manager']));
    await expect(
      store.find(value.recordId, value.version),
    ).resolves.toMatchObject({
      approvalCards: expect.not.arrayContaining([
        expect.objectContaining({
          recipientOpenId: 'ou_warehouse_manager',
        }),
      ]),
      resultNotifications: expect.arrayContaining([
        expect.objectContaining({
          recipientOpenId: 'ou_warehouse_manager',
          status: 'completed',
        }),
      ]),
    });
  });

  it('retries Base finalization after all durable side effects complete and does not repeat it in the same process', async () => {
    await registerAndDeliver(service);
    await service.handleCardAction(
      directActionPayload('approve', 'ou_approver_a', 'om_approver_a'),
    );
    gateway.writeFinalizationCompleted
      .mockRejectedValueOnce(new Error('finalization readback failed'))
      .mockResolvedValueOnce(undefined);

    await expect(service.runPending()).resolves.toMatchObject({ failed: 1 });
    await expect(service.runPending()).resolves.toMatchObject({ failed: 0 });
    await expect(service.runPending()).resolves.toMatchObject({ failed: 0 });

    expect(gateway.writeFinalizationCompleted).toHaveBeenCalledTimes(2);
    expect(gateway.writeFinalizationCompleted).toHaveBeenLastCalledWith(
      expect.objectContaining({ recordId: 'rec_outbound_1', version: 1 }),
    );
  });

  it('recovers a missing local entry from Base on demand before validating a card callback', async () => {
    const value = snapshot();
    const record = pendingRecoveryRecord(value);
    record.fields['出库审批投递台账'] = JSON.stringify({
      schemaVersion: 1,
      recordId: value.recordId,
      version: value.version,
      deliveries: [
        {
          recipientOpenId: 'ou_approver_a',
          recipientName: '审批人甲',
          deliveryUuid: deterministicUuid(
            `inventory-outbound-approval-card:${value.recordId}:${value.version}:ou_approver_a`,
          ),
          messageId: 'om_approver_a',
        },
      ],
    });
    gateway.readOutboundRecord.mockResolvedValue(record);

    await expect(
      service.handleCardAction(
        directActionPayload('open_reject', 'ou_approver_a', 'om_approver_a'),
      ),
    ).resolves.toMatchObject({ claimed: false });

    expect(gateway.readOutboundRecord).toHaveBeenCalledWith('rec_outbound_1');
    await expect(store.find('rec_outbound_1', 1)).resolves.toMatchObject({
      registration: { status: 'ready' },
      approvalCards: [
        {
          recipientOpenId: 'ou_approver_a',
          status: 'completed',
          messageId: 'om_approver_a',
        },
        { recipientOpenId: 'ou_approver_b', status: 'pending' },
      ],
    });
  });

  it('returns the durable terminal card for a delayed duplicate callback after local-ledger loss', async () => {
    const value = snapshot();
    gateway.readOutboundRecord.mockResolvedValue(
      finalizedRecoveryRecord(value),
    );

    await expect(
      service.handleCardAction(
        directActionPayload('approve', 'ou_approver_a', 'om_approver_a'),
      ),
    ).resolves.toMatchObject({ claimed: false });

    expect(gateway.readOutboundRecord).toHaveBeenCalledWith('rec_outbound_1');
    expect(gateway.writeDecision).not.toHaveBeenCalled();
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    await expect(store.find('rec_outbound_1', 1)).resolves.toMatchObject({
      decision: { action: 'approve', eventId: 'evt_finalized_approve' },
      resultNotifications: [
        { recipientOpenId: 'ou_applicant', status: 'completed' },
        { recipientOpenId: 'ou_approver_b', status: 'completed' },
      ],
    });
  });

  it('opens the rejection form without claiming a decision or calling external systems', async () => {
    await registerAndDeliver(service);
    jest.clearAllMocks();

    const result = await service.handleCardAction(
      directActionPayload('open_reject', 'ou_approver_a', 'om_approver_a'),
    );

    expect(result.claimed).toBe(false);
    expect(JSON.stringify(result.card)).toContain('填写驳回原因');
    expect((await store.find('rec_outbound_1', 1))?.decision).toBeUndefined();
    expect(gateway.writeDecision).not.toHaveBeenCalled();
    expect(gateway.patchInteractiveCard).not.toHaveBeenCalled();
  });

  it('returns from the rejection form without claiming or calling external systems', async () => {
    await registerAndDeliver(service);
    jest.clearAllMocks();
    const claimDecision = jest.spyOn(store, 'claimDecision');

    const result = await service.handleCardAction(
      directActionPayload(
        'return_to_approval',
        'ou_approver_a',
        'om_approver_a',
      ),
    );

    expect(result.claimed).toBe(false);
    expect(JSON.stringify(result.card)).toContain('物品出库待审批');
    expect(claimDecision).not.toHaveBeenCalled();
    expect(gateway.writeDecision).not.toHaveBeenCalled();
    expect(gateway.patchInteractiveCard).not.toHaveBeenCalled();
  });

  it('claims a bound decision from the persisted approver snapshot without re-reading the live role directory', async () => {
    await registerAndDeliver(service);
    warehouseRoleDirectory.resolveApprovers.mockRejectedValue(
      new Error('live warehouse role directory is unavailable'),
    );
    const claimDecision = jest.spyOn(store, 'claimDecision');

    await expect(
      service.handleCardAction(rejectionPayload('按审批快照驳回')),
    ).resolves.toMatchObject({ claimed: true });

    expect(warehouseRoleDirectory.resolveApprovers).not.toHaveBeenCalled();
    expect(claimDecision).toHaveBeenCalledTimes(1);
    expect((await store.find('rec_outbound_1', 1))?.decision).toMatchObject({
      action: 'reject',
      actorOpenId: 'ou_approver_a',
      reason: '按审批快照驳回',
    });
  });

  it('syncs a queued decision from the persisted approver snapshot without re-reading the live role directory', async () => {
    await registerAndDeliver(service);
    await service.handleCardAction(rejectionPayload('审批后角色已变化'));
    warehouseRoleDirectory.resolveApprovers.mockRejectedValue(
      new Error('live warehouse role directory is unavailable'),
    );
    jest.clearAllMocks();

    await expect(service.runPending()).resolves.toMatchObject({ failed: 0 });

    expect(warehouseRoleDirectory.resolveApprovers).not.toHaveBeenCalled();
    expect(gateway.writeDecision).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: 'rec_outbound_1', version: 1 }),
      expect.objectContaining({
        action: 'reject',
        actorOpenId: 'ou_approver_a',
        reason: '审批后角色已变化',
      }),
    );
  });

  it('atomically accepts approval locally and defers every external side effect', async () => {
    await registerAndDeliver(service);
    jest.clearAllMocks();

    const result = await service.handleCardAction(
      directActionPayload('approve', 'ou_approver_a', 'om_approver_a'),
    );

    expect(result.claimed).toBe(true);
    expect(JSON.stringify(result.card)).toContain('审批通过 · 同步中');
    expect((await store.find('rec_outbound_1', 1))?.decision).toMatchObject({
      action: 'approve',
      actorOpenId: 'ou_approver_a',
    });
    expect(gateway.writeDecision).not.toHaveBeenCalled();
    expect(gateway.patchInteractiveCard).not.toHaveBeenCalled();
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
  });

  it('syncs the decision before terminalizing every card and notifying the applicant', async () => {
    await registerAndDeliver(service);
    await service.handleCardAction(
      directActionPayload('approve', 'ou_approver_a', 'om_approver_a'),
    );
    jest.clearAllMocks();
    const order: string[] = [];
    gateway.writeDecision.mockImplementation(async () => {
      order.push('decision');
    });
    finalizer.finalizeApprovedOutbound.mockImplementation(async () => {
      order.push('confirm');
    });
    gateway.patchInteractiveCard.mockImplementation(async () => {
      order.push('patch');
    });
    gateway.sendInteractiveCard.mockImplementation(
      async (recipient: string) => {
        order.push(`notify:${recipient}`);
        return 'om_result_applicant';
      },
    );

    const run = await service.runPending();

    expect(run.failed).toBe(0);
    expect(order.slice(0, 2)).toEqual(['decision', 'confirm']);
    expect(order.filter((item) => item === 'patch')).toHaveLength(2);
    expect(order.at(-1)).toBe('notify:ou_applicant');
    expect(finalizer.finalizeApprovedOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: 'rec_outbound_1' }),
      expect.objectContaining({ action: 'approve' }),
    );
    expect(gateway.writeDecision).toHaveBeenCalledTimes(1);
    expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(2);
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(gateway.patchInteractiveCard.mock.calls[0][1]),
    ).not.toContain('callback');
  });

  it('does not patch cards or notify recipients until Base decision readback succeeds', async () => {
    await registerAndDeliver(service);
    await service.handleCardAction(
      directActionPayload('approve', 'ou_approver_a', 'om_approver_a'),
    );
    jest.clearAllMocks();
    finalizer.finalizeApprovedOutbound.mockRejectedValueOnce(
      new Error('real-time stock readback failed'),
    );

    await expect(service.runPending()).resolves.toMatchObject({ failed: 1 });
    expect(gateway.patchInteractiveCard).not.toHaveBeenCalled();
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();

    await expect(service.runPending()).resolves.toMatchObject({ failed: 0 });
    expect(finalizer.finalizeApprovedOutbound).toHaveBeenCalledTimes(2);
    expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(2);
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
  });

  it('requires a bound approver message before opening rejection or deciding', async () => {
    await registerAndDeliver(service);

    await expect(
      service.handleCardAction(
        directActionPayload('approve', 'ou_intruder', 'om_forged'),
      ),
    ).rejects.toThrow();
    await expect(
      service.handleCardAction(
        directActionPayload('open_reject', 'ou_approver_a', 'om_forged'),
      ),
    ).rejects.toThrow();
  });

  it('accepts a reasoned rejection and persists the same terminal result', async () => {
    await registerAndDeliver(service);

    const result = await service.handleCardAction(
      rejectionPayload('库存需保留应急使用'),
    );
    expect(result.claimed).toBe(true);
    expect(JSON.stringify(result.card)).toContain('库存需保留应急使用');

    await service.runPending();
    expect(gateway.writeDecision).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        action: 'reject',
        reason: '库存需保留应急使用',
      }),
    );
  });

  it('restores recoverable Base approvals and delegates unregistered routing records to the business recovery worker', async () => {
    gateway.listRecoveryRecords.mockResolvedValue([
      pendingRecoveryRecord(snapshot()),
      {
        recordId: 'rec_waiting_for_routing',
        fields: { 出库工作流状态: '待路由' },
      },
    ]);

    await expect(service.recoverFromBase()).resolves.toEqual({
      scanned: 2,
      restored: 2,
      skipped: 0,
      failed: 0,
    });
    await expect(store.find('rec_outbound_1', 1)).resolves.toMatchObject({
      registration: { status: 'ready' },
      approvalCards: [
        { recipientOpenId: 'ou_approver_a', status: 'pending' },
        { recipientOpenId: 'ou_approver_b', status: 'pending' },
      ],
    });
    expect(gateway.clearWorkflowError).toHaveBeenCalledWith('rec_outbound_1');
    expect(finalizer.recoverUnregisteredOutbound).toHaveBeenCalledWith(
      'rec_waiting_for_routing',
    );
    expect(gateway.writeWorkflowError).not.toHaveBeenCalled();
  });

  it('isolates a malformed recovery record, writes an actionable error, and continues restoring the remaining records', async () => {
    gateway.listRecoveryRecords.mockResolvedValue([
      {
        recordId: 'rec_invalid',
        fields: {
          程序出库状态: '待审批',
          出库工作流状态: '待审批',
        },
      },
      pendingRecoveryRecord(snapshot()),
    ]);

    await expect(service.recoverFromBase()).resolves.toEqual({
      scanned: 2,
      restored: 1,
      skipped: 0,
      failed: 1,
    });
    expect(gateway.writeWorkflowError).toHaveBeenCalledWith(
      'rec_invalid',
      expect.objectContaining({
        message: expect.stringContaining('缺少出库审批快照'),
      }),
    );
    await expect(store.find('rec_outbound_1', 1)).resolves.toBeDefined();
  });

  it('reroutes an unsafe historical approval once, invalidates the old card, and sends one new card', async () => {
    const currentRoleDirectory = {
      resolveApprovers: jest
        .fn()
        .mockResolvedValue([
          { openId: 'ou_current_responsible', name: '当前示例人员019' },
        ]),
      resolveNotificationRecipients: jest
        .fn()
        .mockResolvedValue([
          { openId: 'ou_current_manager', name: '当前管理人' },
        ]),
    };
    service = new InventoryOutboundApprovalService(
      store,
      gateway as never,
      finalizer as never,
      currentRoleDirectory as never,
    );
    const oldRecord = finalizedRecoveryRecord(snapshot());
    oldRecord.fields['出库审批收尾状态'] = '待收尾';
    oldRecord.fields['出库审批结果投递台账'] = '';
    gateway.listRecoveryRecords.mockResolvedValue([oldRecord]);
    gateway.sendInteractiveCard.mockResolvedValue('om_current_responsible');

    await expect(service.recoverFromBase()).resolves.toMatchObject({
      restored: 1,
      failed: 0,
    });
    await expect(service.recoverFromBase()).resolves.toMatchObject({
      restored: 1,
      failed: 0,
    });

    expect(gateway.writeReroutedPendingApproval).toHaveBeenCalledTimes(1);
    expect(gateway.writeReroutedPendingApproval).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1 }),
      expect.objectContaining({ eventId: 'evt_finalized_approve' }),
      expect.objectContaining({
        version: 2,
        approvers: [{ openId: 'ou_current_responsible', name: '当前示例人员019' }],
        managerRecipients: [
          { openId: 'ou_current_manager', name: '当前管理人' },
        ],
      }),
    );
    await service.runPending();
    await service.runPending();
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(gateway.patchInteractiveCard.mock.calls[0][1]),
    ).toContain('审批已失效');
    expect(gateway.writeFinalizationCompleted).not.toHaveBeenCalledWith(
      expect.objectContaining({ version: 1 }),
    );
    await expect(
      service.handleCardAction(
        directActionPayload('approve', 'ou_approver_a', 'om_approver_a'),
      ),
    ).resolves.toMatchObject({ claimed: false });

    const replacementApproval = directActionPayload(
      'approve',
      'ou_current_responsible',
      'om_current_responsible',
      2,
    );
    await expect(
      service.handleCardAction(replacementApproval),
    ).resolves.toMatchObject({ claimed: true });
    await service.runPending();
    await service.runPending();
    expect(finalizer.finalizeApprovedOutbound).toHaveBeenCalledTimes(1);
    expect(finalizer.finalizeApprovedOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2 }),
      expect.objectContaining({ actorOpenId: 'ou_current_responsible' }),
    );
    await expect(
      service.handleCardAction(replacementApproval),
    ).resolves.toMatchObject({ claimed: false });
    await service.runPending();
    expect(finalizer.finalizeApprovedOutbound).toHaveBeenCalledTimes(1);
  });

  it('reroutes and converges an approved historical record when warehouse manager notification recipients are empty', async () => {
    const currentRoleDirectory = {
      resolveApprovers: jest
        .fn()
        .mockResolvedValue([
          { openId: 'ou_current_responsible', name: '当前示例人员019' },
        ]),
      resolveNotificationRecipients: jest.fn().mockResolvedValue([]),
    };
    service = new InventoryOutboundApprovalService(
      store,
      gateway as never,
      finalizer as never,
      currentRoleDirectory as never,
    );
    const oldRecord = finalizedRecoveryRecord(snapshot());
    oldRecord.fields['出库审批收尾状态'] = '待收尾';
    oldRecord.fields['出库审批结果投递台账'] = '';
    gateway.listRecoveryRecords.mockResolvedValue([oldRecord]);
    gateway.sendInteractiveCard
      .mockResolvedValueOnce('om_current_responsible')
      .mockResolvedValue('om_result_applicant');

    await expect(service.recoverFromBase()).resolves.toMatchObject({
      restored: 1,
      failed: 0,
    });
    expect(gateway.writeReroutedPendingApproval).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1 }),
      expect.objectContaining({ eventId: 'evt_finalized_approve' }),
      expect.objectContaining({
        version: 2,
        approvers: [{ openId: 'ou_current_responsible', name: '当前示例人员019' }],
        managerRecipients: [],
      }),
    );

    await service.runPending();
    await service.runPending();
    await expect(
      service.handleCardAction(
        directActionPayload(
          'approve',
          'ou_current_responsible',
          'om_current_responsible',
          2,
        ),
      ),
    ).resolves.toMatchObject({ claimed: true });
    await service.runPending();
    await service.runPending();

    expect(finalizer.finalizeApprovedOutbound).toHaveBeenCalledTimes(1);
    expect(finalizer.finalizeApprovedOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, managerRecipients: [] }),
      expect.objectContaining({ actorOpenId: 'ou_current_responsible' }),
    );
  });
});

function createGateway() {
  let nextMessage = 0;
  return {
    writePendingApproval: jest.fn(
      async (_snapshot: InventoryOutboundApprovalSnapshot) => undefined,
    ),
    writeApprovalCardDeliveryLedger: jest.fn(
      async (
        _snapshot: InventoryOutboundApprovalSnapshot,
        _deliveries: Array<{
          recipientOpenId: string;
          recipientName: string;
          deliveryUuid: string;
          messageId: string;
        }>,
      ) => undefined,
    ),
    writeApprovalResultDeliveryLedger: jest.fn(
      async (
        _snapshot: InventoryOutboundApprovalSnapshot,
        _decision: InventoryOutboundApprovalDecision,
        _deliveries: Array<{
          recipientOpenId: string;
          recipientName: string;
          deliveryUuid: string;
          messageId: string;
        }>,
      ) => undefined,
    ),
    sendInteractiveCard: jest.fn(
      async (
        _recipient: string,
        _card: Record<string, unknown>,
        _uuid: string,
      ) => {
        nextMessage += 1;
        if (nextMessage === 1) return 'om_approver_a';
        if (nextMessage === 2) return 'om_approver_b';
        return `om_result_${nextMessage}`;
      },
    ),
    patchInteractiveCard: jest.fn(
      async (_messageId: string, _card: Record<string, unknown>) => undefined,
    ),
    writeDecision: jest.fn(
      async (
        _snapshot: InventoryOutboundApprovalSnapshot,
        _decision: InventoryOutboundApprovalDecision,
      ) => undefined,
    ),
    writeReroutedPendingApproval: jest.fn(async () => undefined),
    writeFinalizationCompleted: jest.fn(
      async (_snapshot: InventoryOutboundApprovalSnapshot) => undefined,
    ),
    readOutboundRecord: jest.fn(async (_recordId: string) => {
      throw new Error('unexpected outbound record read');
    }),
    listRecoveryRecords: jest.fn(async () => []),
    writeWorkflowError: jest.fn(async () => undefined),
    clearWorkflowError: jest.fn(async () => undefined),
  };
}

function createFinalizer() {
  return {
    recoverUnregisteredOutbound: jest.fn(
      async (_recordId: string) => undefined,
    ),
    finalizeApprovedOutbound: jest.fn(
      async (
        _snapshot: InventoryOutboundApprovalSnapshot,
        _decision: InventoryOutboundApprovalDecision,
      ) => undefined,
    ),
  };
}

function createWarehouseRoleDirectory() {
  return {
    resolveApprovers: jest.fn(async () => [
      { openId: 'ou_approver_a', name: '审批人甲' },
      { openId: 'ou_approver_b', name: '审批人乙' },
    ]),
    resolveNotificationRecipients: jest.fn(async () => [
      { openId: 'ou_warehouse_manager', name: '库房管理员' },
    ]),
  };
}

async function registerAndDeliver(
  service: InventoryOutboundApprovalService,
): Promise<void> {
  await service.registerPending(snapshot());
  await service.runPending();
}

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
    specification: '0.6*0.8米1吨',
    brand: '正峰',
    quantity: 1,
    unit: '台',
    availableStock: 3,
    building: 'H楼',
    location: 'H-2F-226储存间01-0F',
    reason: '现场使用',
    appliedAt: '2026-08-26T10:30:00+08:00',
    approvers: [
      { openId: 'ou_approver_a', name: '审批人甲' },
      { openId: 'ou_approver_b', name: '审批人乙' },
    ],
    ...overrides,
  };
}

function pendingRecoveryRecord(value: InventoryOutboundApprovalSnapshot) {
  return {
    recordId: value.recordId,
    fields: {
      程序出库状态: '待审批',
      出库工作流状态: '待审批',
      出库当前审批人: value.approvers.map((approver) => ({
        id: approver.openId,
        name: approver.name,
      })),
      出库审批策略版本: value.policyVersion,
      出库审批快照: JSON.stringify({ schemaVersion: 1, snapshot: value }),
      出库审批投递台账: '',
      出库工作流错误: '旧恢复错误',
    },
  };
}

function finalizedRecoveryRecord(value: InventoryOutboundApprovalSnapshot) {
  const approvalDelivery = {
    recipientOpenId: 'ou_approver_a',
    recipientName: '审批人甲',
    deliveryUuid: deterministicUuid(
      `inventory-outbound-approval-card:${value.recordId}:${value.version}:ou_approver_a`,
    ),
    messageId: 'om_approver_a',
  };
  const resultDeliveries = [
    { openId: value.applicantOpenId, name: value.applicantName },
    { openId: 'ou_approver_b', name: '审批人乙' },
  ].map((recipient) => ({
    recipientOpenId: recipient.openId,
    recipientName: recipient.name,
    deliveryUuid: deterministicUuid(
      `inventory-outbound-approval-result:${value.recordId}:${value.version}:approve:${recipient.openId}`,
    ),
    messageId: `om_result_${recipient.openId}`,
  }));
  return {
    recordId: value.recordId,
    fields: {
      程序出库状态: '待库房确认',
      出库工作流状态: '已通过',
      出库当前审批人: [],
      出库实际审批人: [{ id: 'ou_approver_a', name: '审批人甲' }],
      出库审批时间: Date.parse('2026-08-26T08:05:06.789Z'),
      出库审批策略版本: value.policyVersion,
      出库审批动作标识: 'evt_finalized_approve',
      出库驳回原因: '',
      出库审批快照: JSON.stringify({ schemaVersion: 1, snapshot: value }),
      出库审批投递台账: JSON.stringify({
        schemaVersion: 1,
        recordId: value.recordId,
        version: value.version,
        deliveries: [approvalDelivery],
      }),
      出库审批收尾状态: '已完成',
      出库审批结果投递台账: JSON.stringify({
        schemaVersion: 1,
        recordId: value.recordId,
        version: value.version,
        decisionEventId: 'evt_finalized_approve',
        decisionAction: 'approve',
        deliveries: resultDeliveries,
      }),
    },
  };
}

function directActionPayload(
  action: 'approve' | 'open_reject' | 'return_to_approval',
  actorOpenId: string,
  messageId: string,
  version = 1,
) {
  return {
    event_type: 'card.action.trigger',
    operator: { open_id: actorOpenId },
    context: { open_message_id: messageId },
    action: {
      tag: 'button',
      value: {
        workflowType: 'inventory_outbound',
        action,
        recordId: 'rec_outbound_1',
        version,
      },
    },
  };
}

function rejectionPayload(reason: string) {
  return {
    event_type: 'card.action.trigger',
    operator: { open_id: 'ou_approver_a' },
    context: { open_message_id: 'om_approver_a' },
    action: {
      tag: 'button',
      name: 'inventory_outbound_reject_submit:rec_outbound_1:1',
      form_value: { inventory_outbound_rejection_reason: reason },
    },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deterministicUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
