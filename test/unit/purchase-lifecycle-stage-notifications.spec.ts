import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PurchaseWorkflowService } from '../../server/modules/purchase-inventory/purchase-workflow.service';
import { PurchaseLifecycleServerAuthorizer } from '../../server/modules/purchase-inventory/purchase-lifecycle-delivery-authorizer';
import * as externalConfig from '../../server/common/config/external-services.config';

describe('lifecycle stage notifications', () => {
  let folder: string, store: PurchaseWorkflowStore, previousAppId: string | undefined;
  const appId = 'cli_test_app', batchId = 'purchase-stage-notify', recordId = 'rec_one';
  beforeEach(async () => {
    previousAppId = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = appId;
    folder = await mkdtemp(join(tmpdir(), 'purchase-stage-notify-'));
    store = new PurchaseWorkflowStore(join(folder, 'ledger.json')); await store.onModuleInit();
    await store.registerManagerApprovalBatch({ approvalBatchId: batchId, recipientOpenId: 'ou_manager', requesterOpenId: 'ou_requester', recordIds: [recordId], flowVersion: 'lifecycle_v1' }, undefined, { appId, recipients: [{ openId: 'ou_manager', fullView: false }], authorityTargets: [{ recordId, target: { building: 'H楼' } }], authorize: () => {} });
  });
  afterEach(async () => { jest.restoreAllMocks(); await store.onModuleDestroy(); await rm(folder, { recursive: true, force: true }); if (previousAppId === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = previousAppId; });

  function grant(action: 'inbound' | 'none' = 'inbound') {
    return { assertCurrent: jest.fn(), verifyLatest: jest.fn().mockResolvedValue(undefined), authorizeBatch: jest.fn(), project: jest.fn(() => ({
      items: [{ recordId, status: '到货已签收（待入库）', stages: [{ stage: 'inbound', fields: [{ label: '物品', value: '测试' }] }] }],
      viewer: { kind: 'participant', grants: [{ recordId, visibleStages: ['inbound'], allowedActions: action === 'inbound' ? ['inbound'] : [] }] },
    })) };
  }

  it('enrolls authorized warehouse, waits for a confirmed replica and never sends the old card', async () => {
    const gateway = { sendInteractiveCard: jest.fn(), sendIdempotentTextNotification: jest.fn() };
    const service = new PurchaseWorkflowService(gateway as never, store, undefined, {} as never);
    const prepared = grant(); jest.spyOn(PurchaseLifecycleServerAuthorizer.prototype, 'prepare').mockResolvedValue(prepared as never);
    await store.enqueueNotifications([{ businessEventId: 'warehouse-inbound-test', recordId, recipientOpenId: 'ou_warehouse', kind: 'warehouse_inbound' }]);
    const now = new Date(Date.now() + 1000);
    const task = await store.takeNextNotification(now, 60000, ['warehouse_inbound']);
    await (service as any).processLifecycleStageNotification(task, now);
    const identity = { appId, batchId, recipientOpenId: 'ou_warehouse' };
    const entry = (await store.getLifecycleOutbox(identity))!;
    expect(entry.replica.state).toBe('unattempted');
    expect((await store.getNotification(task!.key))?.status).toBe('pending');
    const delivery = await store.beginLifecycleDelivery(identity, now.getTime(), entry.desiredRevision, entry.desiredPage, () => {});
    await store.markLifecycleDeliveryDispatched(identity, delivery.entry.attemptToken, () => {});
    await store.completeLifecycleDelivery(identity, delivery.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: delivery.entry.replica.uuid, messageId: 'om_warehouse', sentAtMs: now.getTime() } });
    const again = await store.takeNextNotification(new Date(now.getTime() + 6000), 60000, ['warehouse_inbound']);
    await (service as any).processLifecycleStageNotification(again, new Date(now.getTime() + 6000));
    expect(await store.getNotification(task!.key)).toMatchObject({ status: 'completed', messageId: 'om_warehouse', lifecycleBinding: { messageId: 'om_warehouse' } });
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(gateway.sendIdempotentTextNotification).not.toHaveBeenCalled();
  });

  it('denies warehouse enrollment when the live grant lacks the inbound action', async () => {
    const service = new PurchaseWorkflowService({} as never, store, undefined, {} as never);
    jest.spyOn(PurchaseLifecycleServerAuthorizer.prototype, 'prepare').mockResolvedValue(grant('none') as never);
    await store.enqueueNotifications([{ businessEventId: 'warehouse-inbound-denied', recordId, recipientOpenId: 'ou_warehouse', kind: 'warehouse_inbound' }]);
    const task = await store.takeNextNotification(new Date(Date.now() + 1000), 60000, ['warehouse_inbound']);
    await expect((service as any).processLifecycleStageNotification(task, new Date())).rejects.toThrow('入库职责');
    expect(await store.getLifecycleOutbox({ appId, batchId, recipientOpenId: 'ou_warehouse' })).toBeNull();
  });

  it('uses the effective configured app identity for the source and authorizer', async () => {
    const originalRead = externalConfig.readEnv;
    jest.spyOn(externalConfig, 'readEnv').mockImplementation((name, aliases) => name === 'FEISHU_APP_ID' ? appId : originalRead(name, aliases));
    process.env.FEISHU_APP_ID = 'cli_stale_process_value';
    const service = new PurchaseWorkflowService({} as never, store, undefined, {} as never);
    jest.spyOn(PurchaseLifecycleServerAuthorizer.prototype, 'prepare').mockImplementation(async function (this: any) {
      expect(this.source.currentAppId()).toBe(appId);
      expect(this.env().FEISHU_APP_ID).toBe(appId);
      return grant() as never;
    });
    await store.enqueueNotifications([{ businessEventId: 'warehouse-inbound-effective-app', recordId, recipientOpenId: 'ou_warehouse', kind: 'warehouse_inbound' }]);
    const task = await store.takeNextNotification(new Date(Date.now() + 1000), 60000, ['warehouse_inbound']);
    await (service as any).processLifecycleStageNotification(task, new Date());
    expect((await store.getLifecycleOutbox({ appId, batchId, recipientOpenId: 'ou_warehouse' }))?.replica.state).toBe('unattempted');
  });

  it('binds the existing manager card to order completion and never sends the old text', async () => {
    const gateway = { sendInteractiveCard: jest.fn(), sendIdempotentTextNotification: jest.fn() };
    const service = new PurchaseWorkflowService(gateway as never, store, undefined, {} as never);
    jest.spyOn(PurchaseLifecycleServerAuthorizer.prototype, 'prepare').mockResolvedValue(grant('none') as never);
    const identity = { appId, batchId, recipientOpenId: 'ou_manager' }, now = new Date(Date.now() + 1000);
    const entry = (await store.getLifecycleOutbox(identity))!;
    const delivery = await store.beginLifecycleDelivery(identity, now.getTime(), entry.desiredRevision, entry.desiredPage, () => {});
    await store.markLifecycleDeliveryDispatched(identity, delivery.entry.attemptToken, () => {});
    await store.completeLifecycleDelivery(identity, delivery.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: delivery.entry.replica.uuid, messageId: 'om_manager', sentAtMs: now.getTime() } });
    await store.enqueueNotifications([{ businessEventId: 'purchase-order-completed-test', recordId, recipientOpenId: 'ou_manager', kind: 'purchase_order_completed', cardContext: JSON.stringify({ version: 1, text: '下单成功' }) }]);
    const task = await store.takeNextNotification(new Date(now.getTime() + 1000), 60000, ['purchase_order_completed']);
    await (service as any).processLifecycleStageNotification(task, now);
    expect((await store.getNotification(task!.key))?.status).toBe('pending');
    const updated = (await store.getLifecycleOutbox(identity))!;
    expect(updated.desiredRevision).toBe(2);
    const refresh = await store.beginLifecycleDelivery(identity, now.getTime() + 1000, 2, 1, () => {});
    await store.markLifecycleDeliveryDispatched(identity, refresh.entry.attemptToken, () => {});
    await store.completeLifecycleDelivery(identity, refresh.entry.attemptToken, { kind: 'update', messageId: 'om_manager', revision: 2 });
    const retry = await store.takeNextNotification(new Date(now.getTime() + 6000), 60000, ['purchase_order_completed']);
    await (service as any).processLifecycleStageNotification(retry, new Date(now.getTime() + 6000));
    expect(await store.getNotification(task!.key)).toMatchObject({ status: 'completed', messageId: 'om_manager', lifecycleBinding: { messageId: 'om_manager' } });
    expect(gateway.sendIdempotentTextNotification).not.toHaveBeenCalled();
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
  });
});
