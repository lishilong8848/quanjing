import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PurchaseLifecycleDeliveryService, type PurchaseLifecycleDeliveryGrant } from '../../server/modules/purchase-inventory/purchase-lifecycle-delivery.service';
import { PurchaseLifecycleGatewayRecordSource } from '../../server/modules/purchase-inventory/purchase-lifecycle-gateway-record-source';
import { PurchaseLifecycleServerAuthorizer } from '../../server/modules/purchase-inventory/purchase-lifecycle-delivery-authorizer';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

describe('purchase lifecycle delivery worker', () => {
  let directory: string, store: PurchaseWorkflowStore, now: number;
  let previousAppId: string | undefined;
  const identity = { appId: 'cli_test_app', batchId: 'purchase-application-worker', recipientOpenId: 'ou_manager' };
  const allow = (batch: { approvalBatchId: string }) => { if (batch.approvalBatchId !== identity.batchId) throw new Error('denied'); };
  let grant: PurchaseLifecycleDeliveryGrant;
  const authorizer = { prepare: jest.fn() };
  const transport = { sendLifecycleCard: jest.fn(), updateLifecycleCard: jest.fn() };

  beforeEach(async () => {
    previousAppId = process.env.FEISHU_APP_ID;
    process.env.FEISHU_APP_ID = identity.appId;
    directory = await mkdtemp(join(tmpdir(), 'purchase-lifecycle-worker-'));
    store = new PurchaseWorkflowStore(join(directory, 'ledger.json'));
    await store.onModuleInit();
    await store.registerManagerApprovalBatch({ approvalBatchId: identity.batchId, recipientOpenId: identity.recipientOpenId, requesterOpenId: 'ou_requester', recordIds: ['rec_one'], flowVersion: 'lifecycle_v1' }, new Date(), {
      appId: identity.appId, recipients: [{ openId: identity.recipientOpenId, fullView: false }], authorityTargets: [{ recordId: 'rec_one', target: { building: 'A楼' } }], authorize: () => {},
    });
    now = Date.UTC(2026, 0, 1);
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    grant = {
      assertCurrent: jest.fn(),
      verifyLatest: jest.fn(async () => {}),
      authorizeBatch: jest.fn(batch => allow(batch)),
      authorizationFingerprint: jest.fn(() => 'a'.repeat(64)),
      project: jest.fn(() => ({
        items: [{ recordId: 'rec_one', status: '未开始（待审批）', stages: [
          { stage: 'application' as const, fields: [{ label: '申请', value: '授权内容' }] },
          { stage: 'ordering' as const, fields: [{ label: '报价', value: '隐藏金额' }] },
        ] }],
        viewer: { kind: 'participant' as const, grants: [{ recordId: 'rec_one', visibleStages: ['application' as const], allowedActions: [] }] },
      })),
    };
    authorizer.prepare.mockReset().mockResolvedValue(grant);
    transport.sendLifecycleCard.mockReset().mockImplementation(async (_recipient, _card, uuid) => ({ source: 'feishu_message_readback', uuid, messageId: 'om_first', sentAtMs: now }));
    transport.updateLifecycleCard.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => { await store.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); jest.restoreAllMocks(); if (previousAppId === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = previousAppId; });

  it('sends the authorized projection once and updates the same message without automatic copies', async () => {
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    expect(await worker.run()).toMatchObject({ delivered: 1, needsReconciliation: 0 });
    expect(transport.sendLifecycleCard).toHaveBeenCalledTimes(1);
    const [recipient, card] = transport.sendLifecycleCard.mock.calls[0];
    expect(recipient).toBe(identity.recipientOpenId);
    expect(JSON.stringify(card)).toContain('授权内容');
    expect(JSON.stringify(card)).not.toContain('隐藏金额');
    expect((await store.getLifecycleOutbox(identity))?.replica).toMatchObject({ state: 'delivered', messageId: 'om_first', appliedRevision: 1 });
    await store.enqueueLifecycleRefresh(identity, 2, allow);
    now += 1000;
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    expect(transport.sendLifecycleCard).toHaveBeenCalledTimes(1);
    expect(transport.updateLifecycleCard).toHaveBeenCalledWith('om_first', expect.any(Object), identity.appId);
    expect((await store.getLifecycleOutbox(identity))?.replica.appliedRevision).toBe(2);
  });

  it('does not send when authorization fails or grants contain no visible records', async () => {
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    authorizer.prepare.mockRejectedValueOnce(new Error('inactive'));
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    expect(await worker.run()).toMatchObject({ rejectedBeforeDispatch: 1 });
    expect(transport.sendLifecycleCard).not.toHaveBeenCalled();
    grant.project = () => ({ items: [], viewer: { kind: 'participant', grants: [] } });
    now = (await store.getLifecycleOutbox(identity))!.nextAttemptAtMs + 1;
    expect(await worker.run()).toMatchObject({ rejectedBeforeDispatch: 1 });
    expect(transport.sendLifecycleCard).not.toHaveBeenCalled();
    expect((await store.getLifecycleOutbox(identity))?.replica.state).toBe('unattempted');
  });

  it('rejects an accidentally asynchronous authorization check before fencing or sending', async () => {
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    grant.assertCurrent = (() => Promise.resolve()) as unknown as () => void;
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    expect(await worker.run()).toMatchObject({ rejectedBeforeDispatch: 1 });
    expect((await store.getLifecycleOutbox(identity))?.replica.state).toBe('unattempted');
    expect(transport.sendLifecycleCard).not.toHaveBeenCalled();
  });

  it('keeps send or update uncertainty fenced and never automatically resends', async () => {
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    transport.sendLifecycleCard.mockRejectedValueOnce(new Error('timeout'));
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    expect(await worker.run()).toMatchObject({ needsReconciliation: 1 });
    expect((await store.getLifecycleOutbox(identity))?.replica.state).toBe('send_unknown');
    expect(await worker.run()).toMatchObject({ scanned: 0 });
    expect(transport.sendLifecycleCard).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed update fenced without resending the original card', async () => {
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    await worker.run();
    await store.enqueueLifecycleRefresh(identity, 2, allow);
    transport.updateLifecycleCard.mockRejectedValueOnce(new Error('unknown'));
    expect(await worker.run()).toMatchObject({ needsReconciliation: 1 });
    expect((await store.getLifecycleOutbox(identity))?.replica.state).toBe('update_unknown');
    expect(await worker.run()).toMatchObject({ scanned: 0 });
    expect(transport.sendLifecycleCard).toHaveBeenCalledTimes(1);
    expect(transport.updateLifecycleCard).toHaveBeenCalledTimes(1);
  });

  it('only one concurrent worker can send the same recipient card', async () => {
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    let release!: () => void, notify!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { notify = resolve; });
    transport.sendLifecycleCard.mockImplementationOnce(async (_recipient, _card, uuid) => {
      notify(); await waiting;
      return { source: 'feishu_message_readback', uuid, messageId: 'om_first', sentAtMs: now };
    });
    const first = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now).run();
    await started;
    const second = await new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now).run();
    expect(second).toMatchObject({ scanned: 0 });
    release();
    expect(await first).toMatchObject({ delivered: 1 });
    expect(transport.sendLifecycleCard).toHaveBeenCalledTimes(1);
  });

  it('never sends a stale projection when a newer revision is queued before the claim', async () => {
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    authorizer.prepare.mockImplementationOnce(async () => { await store.enqueueLifecycleRefresh(identity, 2, allow); return grant; });
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    expect(await worker.run()).toMatchObject({ rejectedBeforeDispatch: 1 });
    expect(transport.sendLifecycleCard).not.toHaveBeenCalled();
    expect((await store.getLifecycleOutbox(identity))?.replica.state).toBe('unattempted');
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    expect((await store.getLifecycleOutbox(identity))?.replica.appliedRevision).toBe(2);
  });

  it('creates a single new generation only after expiration and keeps the previous receipt', async () => {
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    await worker.run();
    const original = (await store.getLifecycleOutbox(identity))!.replica.uuid;
    await store.enqueueLifecycleRefresh(identity, 2, allow);
    now += 14 * 86400000 + 1;
    transport.sendLifecycleCard.mockImplementationOnce(async (_recipient, _card, uuid) => ({ source: 'feishu_message_readback', uuid, messageId: 'om_second', sentAtMs: now }));
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    const after = (await store.getLifecycleOutbox(identity))!;
    expect(after.replica).toMatchObject({ generation: 2, messageId: 'om_second', predecessorMessageId: 'om_first' });
    expect(after.replica.uuid).not.toBe(original);
    expect(after.history).toHaveLength(1);
    expect(transport.updateLifecycleCard).not.toHaveBeenCalled();
    expect(JSON.stringify(transport.sendLifecycleCard.mock.calls[1][1])).toContain('采购全流程 · 延续卡');
  });
  it('binds payment uploads to each delivered generation and refuses dispatch when upload readiness disappears', async () => {
    grant.project=()=>({items:[{recordId:'rec_one',status:'审批通过（待下单）',stages:[{stage:'ordering',fields:[]}]}],viewer:{kind:'participant',grants:[{recordId:'rec_one',visibleStages:['ordering'],allowedActions:['order']}]}});
    let ready=true;
    const worker=new PurchaseLifecycleDeliveryService(store,authorizer,transport,()=>now,()=> 'https://www.sm.sjhl.online:3001',undefined,()=>ready);
    expect(await worker.run()).toMatchObject({delivered:1});
    const upload=(card:any)=>card.body.elements.find((button:any)=>button.text?.content==='上传付款附件').behaviors[0].default_url;
    expect(new URL(upload(transport.sendLifecycleCard.mock.calls[0][1])).searchParams.get('generation')).toBe('1');
    now+=14*86400000+1;transport.sendLifecycleCard.mockImplementationOnce(async(_recipient,_card,uuid)=>({source:'feishu_message_readback',uuid,messageId:'om_payment_next',sentAtMs:now}));
    expect(await worker.run()).toMatchObject({delivered:1});
    expect(new URL(upload(transport.sendLifecycleCard.mock.calls[1][1])).searchParams.get('generation')).toBe('2');
    await store.enqueueLifecycleRefresh(identity,3,allow);
    (grant.verifyLatest as jest.Mock).mockImplementationOnce(async()=>{ready=false;});
    expect(await worker.run()).toMatchObject({rejectedBeforeDispatch:1});
    expect(transport.sendLifecycleCard).toHaveBeenCalledTimes(2);expect(transport.updateLifecycleCard).not.toHaveBeenCalled();
  });

  it('renews an idle expired card only when the current authorized projection still has a pending action', async () => {
    const actionProject = () => ({ items: [{ recordId: 'rec_one', status: '未开始（待审批）', stages: [{ stage: 'application' as const, fields: [] }] }],
      viewer: { kind: 'participant' as const, grants: [{ recordId: 'rec_one', visibleStages: ['application' as const], allowedActions: ['approve' as const] }] } });
    grant.project = actionProject;
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    now += 14 * 86400000 + 1;
    transport.sendLifecycleCard.mockImplementationOnce(async (_recipient, _card, uuid) => ({ source: 'feishu_message_readback', uuid, messageId: 'om_second', sentAtMs: now }));
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    expect((await store.getLifecycleOutbox(identity))?.replica).toMatchObject({ generation: 2, messageId: 'om_second' });
    expect(transport.sendLifecycleCard).toHaveBeenCalledTimes(2);
  });

  it('uses the real temporary ledger to bind an authorized reject form to its delivered revision', async () => {
    grant.project = () => ({ items: [{ recordId: 'rec_one', status: '未开始（待审批）', stages: [{ stage: 'application', fields: [] }] }],
      viewer: { kind: 'participant', grants: [{ recordId: 'rec_one', visibleStages: ['application'], allowedActions: ['approve'] }] }, formPresentations: { rec_one: { reject: {} } } });
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    await store.queueLifecycleFormView(identity, 'om_first', 1, 'evt-open-reject', { kind: 'reject', recordId: 'rec_one' }, () => {});
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    expect(transport.updateLifecycleCard).toHaveBeenCalledTimes(1);
    const card = JSON.stringify(transport.updateLifecycleCard.mock.calls[0][1]);
    const token = card.match(/lcf1:([A-Za-z0-9_-]{43})/)?.[1];
    expect(token).toBeTruthy();
    expect(await store.lookupLifecycleFormCredential(token!, { appId: identity.appId, actorOpenId: identity.recipientOpenId, messageId: 'om_first' }, now)).toMatchObject({
      action: 'submit_item_reject', role: 'manager', approvalBatchId: identity.batchId, executionRecordId: 'rec_one', cardRevision: 2 });
    const entry = await store.getLifecycleOutbox(identity);
    expect(entry?.replica).toMatchObject({ state: 'delivered', messageId: 'om_first', appliedRevision: 2 });
    expect(entry?.appliedView).toEqual({ kind: 'reject', recordId: 'rec_one' });
    await expect(store.lookupLifecycleFormCredential(token!, { appId: identity.appId, actorOpenId: 'ou_other', messageId: 'om_first' }, now)).rejects.toThrow();
    grant.project = () => ({ items: [{ recordId: 'rec_one', status: '驳回申请', stages: [{ stage: 'application', fields: [{ label: '结果', value: '已驳回' }] }] }],
      viewer: { kind: 'participant', grants: [{ recordId: 'rec_one', visibleStages: ['application'], allowedActions: [] }] }, formPresentations: {} });
    await store.enqueueLifecycleRefresh(identity, 3, allow);
    expect(await worker.run()).toMatchObject({ pageReplanned: 1, delivered: 0 });
    expect((await store.getLifecycleOutbox(identity))?.desiredView).toEqual({ kind: 'list' });
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    expect(JSON.stringify(transport.updateLifecycleCard.mock.calls[1][1])).toContain('已驳回');
    expect(JSON.stringify(transport.updateLifecycleCard.mock.calls[1][1])).not.toContain('purchase_lifecycle_form');
  });

  it('uses the real ledger to continue as a list if a queued form crosses the card expiry boundary', async () => {
    grant.project = () => ({ items: [{ recordId: 'rec_one', status: '未开始（待审批）', stages: [{ stage: 'application', fields: [] }] }],
      viewer: { kind: 'participant', grants: [{ recordId: 'rec_one', visibleStages: ['application'], allowedActions: ['approve'] }] }, formPresentations: { rec_one: { reject: {} } } });
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    now += 14 * 86400000 - 1;
    await store.queueLifecycleFormView(identity, 'om_first', 1, 'evt-expiring-form', { kind: 'reject', recordId: 'rec_one' }, () => {});
    now += 2;
    transport.sendLifecycleCard.mockImplementationOnce(async (_recipient, _card, uuid) => ({ source: 'feishu_message_readback', uuid, messageId: 'om_next', sentAtMs: now }));
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    const card = JSON.stringify(transport.sendLifecycleCard.mock.calls[1][1]);
    expect(card).toContain('请在延续卡重新打开表单');
    expect(card).not.toContain('purchase_lifecycle_form');
    expect((await store.getLifecycleOutbox(identity))?.replica).toMatchObject({ generation: 2, state: 'delivered', messageId: 'om_next' });
  });

  it('never renews an idle card without a currently authorized actionable duty', async () => {
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    now += 14 * 86400000 + 1;
    expect(await worker.run()).toMatchObject({ delivered: 0 });
    expect(transport.sendLifecycleCard).toHaveBeenCalledTimes(1);
    authorizer.prepare.mockRejectedValue(new Error('revoked'));
    expect(await worker.run()).toMatchObject({ delivered: 0 });
    expect(transport.sendLifecycleCard).toHaveBeenCalledTimes(1);
  });

  it('binds renewed attachment links to the new generation without sending internal tokens', async () => {
    grant.project = () => ({ items: [{ recordId: 'rec_one', status: '未开始（待审批）', stages: [{ stage: 'application', fields: [], attachments: [{ purpose: 'comparison', index: 0 }] }] }],
      viewer: { kind: 'participant', grants: [{ recordId: 'rec_one', visibleStages: ['application'], allowedActions: [] }] } });
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now, () => 'https://portal.example/');
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    expect(JSON.stringify(transport.sendLifecycleCard.mock.calls[0][1])).toContain('generation=1');
    await store.enqueueLifecycleRefresh(identity, 2, allow);
    now += 14 * 86400000 + 1;
    transport.sendLifecycleCard.mockImplementationOnce(async (_recipient, _card, uuid) => ({ source: 'feishu_message_readback', uuid, messageId: 'om_second', sentAtMs: now }));
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    const card = JSON.stringify(transport.sendLifecycleCard.mock.calls[1][1]);
    expect(card).toContain('generation=2');
    expect(card).not.toContain('file_token');
  });

  it('replans to a continuation if the old card expires during source readback', async () => {
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    await worker.run();
    await store.enqueueLifecycleRefresh(identity, 2, allow);
    now += 14 * 86400000 - 1;
    (grant.verifyLatest as jest.Mock).mockImplementationOnce(async () => { now += 2; });
    expect(await worker.run()).toMatchObject({ rejectedBeforeDispatch: 1, delivered: 0 });
    expect(transport.updateLifecycleCard).not.toHaveBeenCalled();
    expect((await store.getLifecycleOutbox(identity))?.replica).toMatchObject({ state: 'delivered', messageId: 'om_first' });
    transport.sendLifecycleCard.mockImplementationOnce(async (_recipient, _card, uuid) => ({ source: 'feishu_message_readback', uuid, messageId: 'om_second', sentAtMs: now }));
    now = (await store.getLifecycleOutbox(identity))!.nextAttemptAtMs + 1;
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    expect((await store.getLifecycleOutbox(identity))?.replica.messageId).toBe('om_second');
  });

  it('sends no message when access is revoked after fencing', async () => {
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    (grant.assertCurrent as jest.Mock).mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('revoked'); });
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    expect(await worker.run()).toMatchObject({ rejectedBeforeDispatch: 1 });
    expect(transport.sendLifecycleCard).not.toHaveBeenCalled();
    expect((await store.getLifecycleOutbox(identity))?.replica.state).toBe('unattempted');
  });

  it('rechecks the synchronous authorization fingerprint before any message is dispatched', async () => {
    (grant.authorizationFingerprint as jest.Mock).mockReturnValueOnce('a'.repeat(64)).mockReturnValueOnce('b'.repeat(64));
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    expect(await worker.run()).toMatchObject({ rejectedBeforeDispatch: 1, delivered: 0 });
    expect(transport.sendLifecycleCard).not.toHaveBeenCalled();
    expect((await store.getLifecycleOutbox(identity))?.replica.state).toBe('unattempted');
  });

  it('aborts the prepared fence without sending when remote readback differs', async () => {
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    (grant.verifyLatest as jest.Mock).mockRejectedValueOnce(new Error('source changed'));
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    expect(await worker.run()).toMatchObject({ rejectedBeforeDispatch: 1, delivered: 0 });
    expect(transport.sendLifecycleCard).not.toHaveBeenCalled();
    expect((await store.getLifecycleOutbox(identity))?.replica.state).toBe('unattempted');
    expect(await worker.run()).toMatchObject({ scanned: 0 });
    now = (await store.getLifecycleOutbox(identity))!.nextAttemptAtMs + 1;
    expect(await worker.run()).toMatchObject({ delivered: 1 });
  });

  it('aborts safely if the batch authorization changed before dispatch marking', async () => {
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    (grant.authorizeBatch as jest.Mock).mockImplementationOnce(batch => allow(batch)).mockImplementationOnce(() => { throw new Error('batch changed'); });
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    expect(await worker.run()).toMatchObject({ rejectedBeforeDispatch: 1, delivered: 0 });
    expect(transport.sendLifecycleCard).not.toHaveBeenCalled();
    expect((await store.getLifecycleOutbox(identity))?.replica.state).toBe('unattempted');
  });

  it('renders an explicitly authorized observer projection without actionable buttons', async () => {
    await store.enqueueLifecycleRefresh(identity, 1, allow);
    grant.project = () => ({
      items: [{ recordId: 'rec_one', status: '未开始（待审批）', stages: [
        { stage: 'application', fields: [{ label: '明细', value: '全流程内容' }] },
        { stage: 'ordering', fields: [{ label: '报价', value: '观察者可见' }] },
      ] }],
      viewer: { kind: 'observer' },
      resolveManagerCallback: () => { throw new Error('observer must never resolve actions'); },
    });
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    const card = JSON.stringify(transport.sendLifecycleCard.mock.calls[0][1]);
    expect(card).toContain('只读抄送');
    expect(card).toContain('观察者可见');
    expect(card).not.toContain('"tag":"button"');
  });

  it('binds interactive callbacks to the outbox revision that was fenced', async () => {
    await store.enqueueLifecycleRefresh(identity, 7, allow);
    grant.project = () => ({
      items: [{ recordId: 'rec_one', status: '未开始（待审批）', stages: [{ stage: 'application', fields: [] }] }],
      viewer: { kind: 'participant', grants: [{ recordId: 'rec_one', visibleStages: ['application'], allowedActions: ['approve'] }] },
      batchApprovalProof: { pendingRecordIds: ['rec_one'], authorizedPendingRecordIds: ['rec_one'], building: 'H楼' },
      resolveManagerCallback: (action, recordId) => ({ version: 3, action, approvalBatchId: identity.batchId, ...(recordId ? { executionRecordId: recordId } : {}) }),
    });
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    const card = transport.sendLifecycleCard.mock.calls[0][1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('"flowVersion":"lifecycle_v1"');
    expect(serialized).toContain('"cardRevision":7');
    expect((await store.getLifecycleOutbox(identity))?.replica.appliedRevision).toBe(7);
  });

  it('updates a requested page in the same message and safely replans to page one after content shrinks', async () => {
    const largeFields = Array.from({ length: 18 }, (_, i) => ({ label: `字段${i}`, value: '甲'.repeat(1900) }));
    grant.project = () => ({
      items: [{ recordId: 'rec_one', status: '未开始（待审批）', stages: [{ stage: 'application', fields: largeFields }] }],
      viewer: { kind: 'participant', grants: [{ recordId: 'rec_one', visibleStages: ['application'], allowedActions: [] }] },
    });
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    const initial = JSON.stringify(transport.sendLifecycleCard.mock.calls[0][1]);
    expect(initial).toContain('第 1/');
    expect(initial).toContain('purchase_lifecycle_page');
    const savedProof = await store.getLifecycleOutbox(identity);
    expect(savedProof?.appliedTotalPages).toBeGreaterThan(1);
    expect(savedProof?.appliedAuthorizationFingerprint).toBe('a'.repeat(64));
    await store.queueLifecyclePage(identity, 'om_first', 1, 'event-next-page-01', 2, (_batch, _replica, _page, proof) => {
      expect(proof).toEqual({ totalPages: savedProof!.appliedTotalPages, authorizationFingerprint: 'a'.repeat(64) });
    });
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    expect(JSON.stringify(transport.updateLifecycleCard.mock.calls[0][1])).toContain('第 2/');
    expect((await store.getLifecycleOutbox(identity))).toMatchObject({ desiredPage: 2, appliedPage: 2 });
    grant.project = () => ({
      items: [{ recordId: 'rec_one', status: '未开始（待审批）', stages: [{ stage: 'application', fields: [{ label: '物品', value: '缩短' }] }] }],
      viewer: { kind: 'participant', grants: [{ recordId: 'rec_one', visibleStages: ['application'], allowedActions: [] }] },
    });
    await store.enqueueLifecycleRefresh(identity, 3, allow);
    expect(await worker.run()).toMatchObject({ pageReplanned: 1, delivered: 0 });
    expect(transport.updateLifecycleCard).toHaveBeenCalledTimes(1);
    const replanned = (await store.getLifecycleOutbox(identity))!;
    expect(replanned.desiredPage).toBe(1);
    expect(replanned.desiredRevision).toBeGreaterThan(replanned.replica.appliedRevision);
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    expect(transport.sendLifecycleCard).toHaveBeenCalledTimes(1);
    expect(transport.updateLifecycleCard).toHaveBeenCalledTimes(2);
    expect((await store.getLifecycleOutbox(identity))?.appliedPage).toBe(1);
  });

  it('navigates only the selected recipient message and leaves the observer copy intact', async () => {
    const observerIdentity = { ...identity, recipientOpenId: 'ou_observer' };
    await store.enqueueLifecycleRefresh(observerIdentity, 1, allow);
    const fields = Array.from({ length: 18 }, (_, i) => ({ label: `字段${i}`, value: '甲'.repeat(1900) }));
    const project = () => ({ items: [{ recordId: 'rec_one', status: '未开始（待审批）', stages: [{ stage: 'application' as const, fields }] }],
      viewer: { kind: 'participant' as const, grants: [{ recordId: 'rec_one', visibleStages: ['application' as const], allowedActions: [] }] } });
    grant.project = project;
    authorizer.prepare.mockImplementation(async (who: typeof identity) => who.recipientOpenId === observerIdentity.recipientOpenId
      ? { ...grant, project: () => ({ ...project(), viewer: { kind: 'observer' } }) } : grant);
    transport.sendLifecycleCard.mockImplementation(async (recipient, _card, uuid) => ({ source: 'feishu_message_readback', uuid, messageId: recipient === identity.recipientOpenId ? 'om_first' : 'om_observer', sentAtMs: now }));
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    expect(await worker.run()).toMatchObject({ delivered: 2 });
    await store.queueLifecyclePage(identity, 'om_first', 1, 'event-next-page-02', 2, () => {});
    expect(await worker.run()).toMatchObject({ delivered: 1 });
    expect(transport.updateLifecycleCard).toHaveBeenCalledTimes(1);
    expect(transport.updateLifecycleCard.mock.calls[0][0]).toBe('om_first');
    expect((await store.getLifecycleOutbox(observerIdentity))).toMatchObject({ appliedPage: 1, replica: { messageId: 'om_observer', appliedRevision: 1 } });
  });

  it('defers a pre-dispatch failure so another recipient can progress without a duplicate send', async () => {
    const other = { ...identity, recipientOpenId: 'ou_other' };
    await store.enqueueLifecycleRefresh(other, 1, allow);
    authorizer.prepare.mockImplementation(async (who: typeof identity) => {
      if (who.recipientOpenId === identity.recipientOpenId) throw new Error('source unavailable');
      return grant;
    });
    const worker = new PurchaseLifecycleDeliveryService(store, authorizer, transport, () => now);
    expect(await worker.run(1)).toMatchObject({ rejectedBeforeDispatch: 1, delivered: 0 });
    expect((await store.getLifecycleOutbox(identity))).toMatchObject({ retryReason: 'source', failureCount: 1 });
    expect(await worker.run(1)).toMatchObject({ delivered: 1 });
    expect(transport.sendLifecycleCard).toHaveBeenCalledTimes(1);
    expect(transport.sendLifecycleCard.mock.calls[0][0]).toBe(other.recipientOpenId);
    expect(await worker.run(1)).toMatchObject({ scanned: 0 });
  });

  it('integrates current permission, direct source reread and a real outbox with a fake gateway', async () => {
    const record = { recordId: 'rec_one', status: '未开始（待审批）', building: 'A楼', requestCode: 'CG1', itemName: '物品',
      requesterOpenId: 'ou_requester', requesterName: '申请人', purchaserOpenId: '', purchaserName: '', purchaseMethod: '综合采购',
      requestedQuantity: 1, actualQuantity: null, actualAmount: null, receiptPhotoTokens: [], invoiceTokens: [] } as PurchaseWorkflowRecord;
    const recordGateway = { getLifecycleExecutionRecordsAsApp: jest.fn(async () => [structuredClone(record)]), prepareManagerComparisonBatchEvidence: jest.fn() };
    const source = new PurchaseLifecycleGatewayRecordSource(store, recordGateway, () => identity.appId, () => now);
    const access = { snapshot: () => ({ revision: 1, appId: identity.appId }), feishuPrincipal: () => ({ role: 'admin', purchaseBuilding: null }),
      currentDutyRoutePeople: (kind: string) => kind === 'purchase_manager' ? [{ openId: identity.recipientOpenId }] : [],
      isCurrentReadonlyCardRecipient: () => false } as any;
    const realAuthorizer = new PurchaseLifecycleServerAuthorizer(access, source, () => ({ FEISHU_APP_ID: identity.appId }), () => identity.appId);
    const worker = new PurchaseLifecycleDeliveryService(store, realAuthorizer, transport, () => now);
    expect(await worker.run()).toMatchObject({ delivered: 1, needsReconciliation: 0 });
    expect(recordGateway.getLifecycleExecutionRecordsAsApp).toHaveBeenCalledTimes(2);
    expect(transport.sendLifecycleCard).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(transport.sendLifecycleCard.mock.calls[0][1])).toContain('物品');
  });
});
