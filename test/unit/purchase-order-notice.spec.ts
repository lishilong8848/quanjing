const mockManagerApprovalEnabled = jest.fn(() => true);
jest.mock('../../server/modules/purchase-inventory/purchase-manager-approval.config', () => ({
  isPurchaseManagerApprovalEnabled: () => mockManagerApprovalEnabled(),
  readPurchaseManagerApprovers: () => [{ openId: 'ou_ma', name: '合成甲' }, { openId: 'ou_mei', name: '合成乙' }, { openId: 'ou_ma', name: '重复配置' }],
}));

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { PurchaseWorkflowService, type PurchaseWorkflowTaskRunResult } from '../../server/modules/purchase-inventory/purchase-workflow.service';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

describe('durable purchase order completion notices', () => {
  const saved = { ...process.env };
  const session = { accessToken: 'synthetic-token', openId: 'ou_buyer', userName: '合成采购人', accessRole: 'admin' as const, authenticationMode: 'delegated-app' as const };
  const input = { actualQuantity: 2, actualAmount: 300, paymentAttachmentTokens: [], note: '' };
  let directory: string;
  let store: PurchaseWorkflowStore;
  let service: PurchaseWorkflowService;
  let current: PurchaseWorkflowRecord;
  let gateway: ReturnType<typeof createGateway>;
  let warnings: jest.SpyInstance;
  function createGateway() {
    return {
      getExecutionRecord: jest.fn(async () => ({ ...current })),
      getExecutionRecordAsApp: jest.fn(async () => ({ ...current })),
      resolveUser: jest.fn(async () => ({ openId: 'ou_buyer', name: '合成采购人', positions: ['综合管理'], buildings: [] })),
      getTenantAccessTokenAsApp: jest.fn(async () => 'synthetic-token'),
      updateExecutionRecord: jest.fn(async () => {
        current = { ...current, status: '下单完成（待签收）', purchaseCompleted: true, actualQuantity: 2, actualAmount: 300 };
      }),
      sendTextNotification: jest.fn(),
      sendIdempotentTextNotification: jest.fn(async (recipient: string, _text: string, _uuid: string) => `om_${recipient}`),
    };
  }
  beforeEach(async () => {
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mockManagerApprovalEnabled.mockReturnValue(true);
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    directory = await mkdtemp(join(tmpdir(), 'purchase-order-notice-'));
    store = new PurchaseWorkflowStore(join(directory, 'ledger.json'));
    current = {
      recordId: 'rec_order_notice', requestCode: 'CG-SYNTHETIC', status: '审批通过（待下单）', itemName: '合成物料', building: 'H楼',
      requesterOpenId: 'ou_requester', requesterName: '合成申请人', purchaserOpenId: 'ou_buyer', purchaserName: '合成采购人',
      purchaseMethod: '综合采购', requestedQuantity: 2, actualQuantity: null, actualAmount: null, paymentAttachmentTokens: [],
      approvalCompleted: true, warehouseConfirmed: false, purchaseCompleted: false, receiptConfirmed: false, signer: '', signerOpenId: '',
      receiptTime: null, receiptPhotoTokens: [], invoiceTokens: [],
    };
    gateway = createGateway();
    service = new PurchaseWorkflowService(gateway as never, store);
    const unrelatedRecovery = service as unknown as {
      recoverMissingWarehouseInboundNotifications(): Promise<number>;
      recoverMissingCompletionNotifications(): Promise<number>;
    };
    jest.spyOn(unrelatedRecovery, 'recoverMissingWarehouseInboundNotifications').mockResolvedValue(0);
    jest.spyOn(unrelatedRecovery, 'recoverMissingCompletionNotifications').mockResolvedValue(0);
  });
  afterEach(async () => {
    service.onModuleDestroy();
    await waitForRecovery();
    await store.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
    process.env = { ...saved };
    jest.restoreAllMocks();
  });
  async function waitForRecovery() {
    await (service as unknown as { orderNoticeRecovery: Promise<void> | null }).orderNoticeRecovery;
  }
  async function drain(now = new Date()) {
    const result: PurchaseWorkflowTaskRunResult = { processed: 0, failed: 0, recoveredApprovalRequests: 0,
      recoveredWarehouseInboundNotifications: 0, recoveredCompletionNotifications: 0, errors: [] };
    const worker = service as unknown as { processAvailableTasks(limit: number, now: Date, result: PurchaseWorkflowTaskRunResult, enabled: boolean): Promise<number> };
    await worker.processAvailableTasks(20, now, result, false);
    return result;
  }

  it('persists recipients before the external write and atomically queues one notice per distinct recipient', async () => {
    const originalWrite = gateway.updateExecutionRecord.getMockImplementation()!;
    gateway.updateExecutionRecord.mockImplementation(async () => {
      expect((await store.findCommand('order:rec_order_notice'))?.orderNotice?.recipientOpenIds)
        .toEqual(['ou_requester', 'ou_buyer', 'ou_ma', 'ou_mei']);
      expect(await store.listNotifications({ kind: 'purchase_order_completed' })).toHaveLength(0);
      await originalWrite();
    });
    await service.order(current.recordId, session, input);
    const notices = await store.listNotifications({ kind: 'purchase_order_completed' });
    expect(notices).toHaveLength(4);
    expect(new Set(notices.map(row => row.deliveryUuid)).size).toBe(4);
    expect(gateway.sendTextNotification).not.toHaveBeenCalled();
    expect(gateway.sendIdempotentTextNotification).not.toHaveBeenCalled();
    expect(current.requesterOpenId).toBe('ou_requester');
    expect(current.signerOpenId).toBe('');
  });

  it('coalesces duplicate website orders and delivers each observer exactly once even with the legacy worker disabled', async () => {
    await Promise.all([service.order(current.recordId, session, input), service.order(current.recordId, session, { ...input })]);
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
    expect(await drain()).toMatchObject({ processed: 4, failed: 0 });
    await service.order(current.recordId, session, input);
    await drain();
    expect(gateway.sendIdempotentTextNotification).toHaveBeenCalledTimes(4);
    expect(gateway.sendIdempotentTextNotification.mock.calls.map(([recipient]) => recipient).sort())
      .toEqual(['ou_buyer', 'ou_ma', 'ou_mei', 'ou_requester']);
  });

  it('retries only the failed recipient with the same stable UUID after an unknown delivery result', async () => {
    await service.order(current.recordId, session, input);
    let failed = false;
    gateway.sendIdempotentTextNotification.mockImplementation(async (recipient, _text, _uuid) => {
      if (recipient === 'ou_mei' && !failed) { failed = true; throw Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' }); }
      return `om_${recipient}`;
    });
    const now = new Date();
    expect(await drain(now)).toMatchObject({ processed: 3, failed: 1 });
    expect(await drain(new Date(now.getTime() + 120_000))).toMatchObject({ processed: 1, failed: 0 });
    const calls = gateway.sendIdempotentTextNotification.mock.calls;
    expect(calls).toHaveLength(5);
    const retries = calls.filter(([recipient]) => recipient === 'ou_mei');
    expect(retries[0]![2]).toBe(retries[1]![2]);
  });

  it('recovers the same durable notice intent after a timed-out Base write without rewriting or re-resolving recipients', async () => {
    gateway.updateExecutionRecord.mockImplementation(async () => {
      current = { ...current, status: '下单完成（待签收）', purchaseCompleted: true, actualQuantity: 2, actualAmount: 300 };
      throw Object.assign(new Error('synthetic unknown write'), { code: 'ECONNRESET' });
    });
    await expect(service.order(current.recordId, session, input)).rejects.toThrow();
    expect(await store.listNotifications({ kind: 'purchase_order_completed' })).toHaveLength(0);
    const restarted = new PurchaseWorkflowService(gateway as never, store);
    await expect(restarted.order(current.recordId, session, input)).resolves.toMatchObject({ idempotent: true });
    expect(await store.listNotifications({ kind: 'purchase_order_completed' })).toHaveLength(4);
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });

  it('adds manager observers on the card entry without changing its original recipient or signer fields', async () => {
    await service.orderFromCard(current.recordId, 'ou_buyer', input);
    const notices = await store.listNotifications({ kind: 'purchase_order_completed' });
    expect(notices.map(row => row.recipientOpenId).sort()).toEqual(['ou_ma', 'ou_mei']);
    expect(current.requesterOpenId).toBe('ou_requester');
    expect(current.signerOpenId).toBe('');
  });

  it.each([
    ['both disabled', false, false, []],
    ['legacy only', true, false, ['ou_buyer', 'ou_requester']],
    ['manager only', false, true, ['ou_buyer', 'ou_ma', 'ou_mei', 'ou_requester']],
  ] as const)('preserves the notification switches: %s', async (_label, legacyEnabled, managerEnabled, recipients) => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = String(legacyEnabled);
    mockManagerApprovalEnabled.mockReturnValue(managerEnabled);
    await service.order(current.recordId, session, input);
    expect((await store.listNotifications({ kind: 'purchase_order_completed' })).map(row => row.recipientOpenId).sort()).toEqual(recipients);
    if (!legacyEnabled && !managerEnabled) expect((await store.findCommand('order:rec_order_notice'))?.orderNotice).toBeUndefined();
    expect(gateway.sendTextNotification).not.toHaveBeenCalled();
  });

  it('still delivers a previously accepted outbox after both switches are turned off', async () => {
    await service.order(current.recordId, session, input);
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    mockManagerApprovalEnabled.mockReturnValue(false);
    expect(await drain()).toMatchObject({ processed: 4, failed: 0 });
  });

  async function leaveUnknownOrder() {
    gateway.updateExecutionRecord.mockImplementation(async () => {
      current = { ...current, status: '下单完成（待签收）', purchaseCompleted: true, actualQuantity: 2, actualAmount: 300 };
      throw Object.assign(new Error('synthetic unknown write'), { code: 'ECONNRESET' });
    });
    await expect(service.order(current.recordId, session, input)).rejects.toThrow();
    return (await store.findCommand('order:rec_order_notice'))!;
  }

  it('recovers an unknown website write through the worker alone after the existing claim timeout', async () => {
    const pending = await leaveUnknownOrder();
    await service.runPendingTasks(4, new Date(Date.parse(pending.startedAt) + 1000));
    await waitForRecovery();
    expect(gateway.getExecutionRecordAsApp).not.toHaveBeenCalled();
    const now = new Date(Date.parse(pending.startedAt) + 60_001);
    expect(await service.runPendingTasks(4, now)).toMatchObject({ processed: 0, failed: 0 });
    await waitForRecovery();
    expect(await service.runPendingTasks(4, new Date(now.getTime() + 1000))).toMatchObject({ processed: 4, failed: 0 });
    await waitForRecovery();
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
    expect(gateway.getExecutionRecordAsApp).toHaveBeenCalledTimes(1);
    expect(gateway.sendIdempotentTextNotification).toHaveBeenCalledTimes(4);
  });

  it('does not send a recovered notice when the actual order result differs from the durable intent', async () => {
    const pending = await leaveUnknownOrder();
    current.actualAmount = 301;
    expect(await service.runPendingTasks(4, new Date(Date.parse(pending.startedAt) + 60_001)))
      .toMatchObject({ processed: 0, failed: 0 });
    await waitForRecovery();
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('采购执行结果与原下单通知意图不一致'));
    expect(await store.listNotifications({ kind: 'purchase_order_completed' })).toHaveLength(0);
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
    expect(gateway.sendIdempotentTextNotification).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not complete a replacement claim during the app read (same payload: %s)', async samePayload => {
    const pending = await leaveUnknownOrder();
    const now = new Date(Date.parse(pending.startedAt) + 60_001);
    gateway.getExecutionRecordAsApp.mockImplementation(async () => {
      await store.releaseCommandClaim(pending.key, pending.fingerprint);
      await store.claimCommand({ ...pending,
        fingerprint: samePayload ? pending.fingerprint : 'different-command-fingerprint',
        expectedResultFingerprint: samePayload ? pending.expectedResultFingerprint : 'different-result-fingerprint',
        startedAt: now.toISOString(), orderNotice: { recipientOpenIds: ['ou_replacement'], text: 'replacement intent' },
      });
      return { ...current };
    });
    await service.runPendingTasks(4, now);
    await waitForRecovery();
    expect(await store.listNotifications({ kind: 'purchase_order_completed' })).toHaveLength(0);
    expect((await store.findCommand(pending.key))?.completedAt).toBe('');
    expect((await store.findCommand(pending.key))?.orderNotice?.recipientOpenIds).toEqual(['ou_replacement']);
    expect(gateway.sendIdempotentTextNotification).not.toHaveBeenCalled();
  });

  it('does not scan old commands without notice intent or bypass deferred card fulfillment', async () => {
    const pending = await leaveUnknownOrder();
    await store.releaseCommandClaim(pending.key, pending.fingerprint);
    await store.claimCommand({ ...pending, orderNotice: { ...pending.orderNotice!, deferUntilFulfillment: true } });
    const { orderNotice: _notice, ...withoutNotice } = pending;
    await store.claimCommand({ ...withoutNotice, key: 'order:rec_historical', recordId: 'rec_historical' });
    await service.runPendingTasks(4, new Date(Date.parse(pending.startedAt) + 60_001));
    await waitForRecovery();
    expect(gateway.getExecutionRecordAsApp).not.toHaveBeenCalled();
    expect(gateway.sendIdempotentTextNotification).not.toHaveBeenCalled();
  });
});

describe('idempotent order text gateway', () => {
  const uuid = 'order_notice_synthetic_1';
  function createGateway(body: unknown) {
    const axiosRef = { post: jest.fn(async () => ({ status: 200, data: body })) };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);
    jest.spyOn(gateway as unknown as { getTenantAccessToken(): Promise<string> }, 'getTenantAccessToken').mockResolvedValue('synthetic-token');
    return { gateway, axiosRef };
  }
  it('sends only a read-only text payload with the persisted UUID and requires a message receipt', async () => {
    const { gateway, axiosRef } = createGateway({ code: 0, data: { message_id: 'om_order_notice' } });
    await expect(gateway.sendIdempotentTextNotification('ou_mei', '合成采购已下单', uuid)).resolves.toBe('om_order_notice');
    expect(axiosRef.post).toHaveBeenCalledWith(expect.any(String), {
      receive_id: 'ou_mei', msg_type: 'text', content: JSON.stringify({ text: '合成采购已下单' }), uuid,
    }, expect.any(Object));
  });
  it('treats missing message_id as unknown rather than declaring a delivery complete', async () => {
    const { gateway } = createGateway({ code: 0, data: {} });
    await expect(gateway.sendIdempotentTextNotification('ou_mei', '合成采购已下单', uuid)).rejects.toThrow('message_id');
  });
  it('rejects invalid identifiers without contacting Feishu', async () => {
    const { gateway, axiosRef } = createGateway({ code: 0 });
    await expect(gateway.sendIdempotentTextNotification('invalid', '合成采购已下单', uuid)).rejects.toThrow();
    await expect(gateway.sendIdempotentTextNotification('ou_mei', '合成采购已下单', '')).rejects.toThrow();
    expect(axiosRef.post).not.toHaveBeenCalled();
  });
});
