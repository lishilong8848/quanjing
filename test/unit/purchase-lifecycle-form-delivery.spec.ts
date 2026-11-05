import { PurchaseLifecycleDeliveryService } from '../../server/modules/purchase-inventory/purchase-lifecycle-delivery.service';

describe('purchase lifecycle prepared form delivery', () => {
  const now = Date.UTC(2026, 10, 4);
  const identity = { appId: 'cli_test', batchId: 'purchase-batch-test', recipientOpenId: 'ou_person' };
  const batch: any = { approvalBatchId: identity.batchId };
  const desiredView = { kind: 'order' as const, recordId: 'rec_one' };
  const binding = { action: 'submit_order', approvalBatchId: identity.batchId, executionRecordId: 'rec_one', role: 'purchaser', flowVersion: 'lifecycle_v1', cardRevision: 2 };
  const outbox: any = { replica: { ...identity, state: 'update_unknown', pendingRevision: 2, messageId: 'om_current', sentAtMs: now, generation: 1 }, attemptToken: 'attempt', pendingPage: 1, pendingView: desiredView };
  let store: any, grant: any, transport: any;
  beforeEach(() => {
    grant = { assertCurrent: jest.fn(), verifyLatest: jest.fn().mockResolvedValue(undefined), authorizeBatch: jest.fn(), authorizationFingerprint: jest.fn(() => 'a'.repeat(64)),
      project: jest.fn(() => ({ items: [{ recordId: 'rec_one', status: '审批通过（待下单）', stages: [{ stage: 'ordering', fields: [] }] }],
        viewer: { kind: 'participant', grants: [{ recordId: 'rec_one', visibleStages: ['ordering'], allowedActions: ['order'] }] },
        formPresentations: { rec_one: { order: { actualQuantity: 7, actualAmount: 11 } } } })) };
    store = { listExpiredPreparedLifecycleDeliveries: jest.fn().mockResolvedValue([]), listExpiredLifecycleContinuations: jest.fn().mockResolvedValue([]),
      listPendingLifecycleDeliveries: jest.fn().mockResolvedValue([{ identity, desiredRevision: 2, desiredPage: 1, desiredView, status: 'ready' }]),
      beginLifecycleDelivery: jest.fn(async (_id, _now, _rev, _page, authorize) => { authorize(batch); return { action: 'update', entry: structuredClone(outbox) }; }),
      issuePreparedLifecycleForm: jest.fn(async (_id, _attempt, _binding, authorize) => { authorize(batch); return Buffer.alloc(32, 1).toString('base64url'); }),
      markLifecycleDeliveryDispatched: jest.fn(async (_id, _token, authorize) => { authorize(batch); return outbox; }),
      completeLifecycleDelivery: jest.fn().mockResolvedValue(outbox), abortPreparedLifecycleDelivery: jest.fn().mockResolvedValue(outbox),
      deferLifecycleDelivery: jest.fn().mockResolvedValue(outbox), getLifecycleOutbox: jest.fn().mockResolvedValue({ replica: { state: 'delivered' } }),
      resetLifecycleDesiredViewToList: jest.fn(async (_id, _rev, _page, _view, authorize) => { authorize(batch); return outbox; }) };
    transport = { updateLifecycleCard: jest.fn().mockResolvedValue(undefined), sendLifecycleCard: jest.fn() };
  });
  const make = () => new PurchaseLifecycleDeliveryService(store, { prepare: async () => grant }, transport, () => now, () => 'https://portal.example/');
  it('fences the prepared authorized form and patches only the already delivered message', async () => {
    expect(await make().run()).toMatchObject({ delivered: 1 });
    expect(store.issuePreparedLifecycleForm).toHaveBeenCalledWith(identity, 'attempt', binding, expect.any(Function));
    expect(store.issuePreparedLifecycleForm.mock.invocationCallOrder[0]).toBeLessThan(store.markLifecycleDeliveryDispatched.mock.invocationCallOrder[0]);
    expect(store.markLifecycleDeliveryDispatched.mock.invocationCallOrder[0]).toBeLessThan(transport.updateLifecycleCard.mock.invocationCallOrder[0]);
    expect(transport.updateLifecycleCard.mock.calls[0][0]).toBe('om_current');
    const card = JSON.stringify(transport.updateLifecycleCard.mock.calls[0][1]);
    expect(card).toContain('purchase_lifecycle_form'); expect(card).toContain('actual_quantity'); expect(card).toContain('提交下单结果');
    expect(card).toContain('返回采购列表');
    expect(transport.sendLifecycleCard).not.toHaveBeenCalled();
  });
  it('never lets display data replace the server-issued binding or credential', async () => {
    const original = grant.project();
    original.formPresentations.rec_one.order.token = 'fake-client-token';
    original.formPresentations.rec_one.order.binding = { action: 'submit_receipt' };
    grant.project.mockReturnValue(original);
    expect(await make().run()).toMatchObject({ delivered: 1 });
    const card = JSON.stringify(transport.updateLifecycleCard.mock.calls[0][1]);
    expect(card).not.toContain('fake-client-token');
    expect(card).toContain(`lcf1:${Buffer.alloc(32, 1).toString('base64url')}`);
    expect(store.issuePreparedLifecycleForm).toHaveBeenCalledWith(identity, 'attempt', binding, expect.any(Function));
  });
  it('shows receipt image actions only when server readiness is explicitly true',async()=>{
    const view={kind:'receipt',recordId:'rec_one'};
    store.listPendingLifecycleDeliveries.mockResolvedValue([{identity,desiredRevision:2,desiredPage:1,desiredView:view,status:'ready'}]);
    store.getLifecycleOutbox.mockResolvedValue({replica:{state:'delivered',messageId:'om_current'}});
    store.getLifecycleReceiptPreparation=jest.fn(async(_identity:any,_message:any,authorize:any)=>{authorize(batch,{executionRecordId:'rec_one'});return null;});
    store.beginLifecycleDelivery.mockImplementation(async (_id:any,_now:any,_rev:any,_page:any,authorize:any)=>{authorize(batch);return {action:'update',entry:{...structuredClone(outbox),pendingView:view}};});
    grant.project.mockReturnValue({items:[{recordId:'rec_one',status:'下单完成（待签收）',stages:[{stage:'receipt',fields:[]}]}],
      viewer:{kind:'participant',grants:[{recordId:'rec_one',visibleStages:['receipt'],allowedActions:['receive']}]},
      formPresentations:{rec_one:{receipt:{signerOpenId:'ou_person',purchaseMethod:'需求自采',receiptPhotoCount:0,invoiceCount:0}}}});
    expect(await make().run()).toMatchObject({delivered:1});
    expect(JSON.stringify(transport.updateLifecycleCard.mock.calls[0][1])).not.toContain('prepare_receipt_photo');
    const ready=new PurchaseLifecycleDeliveryService(store,{prepare:async()=>grant},transport,()=>now,()=> 'https://portal.example/',()=>true);
    expect(await ready.run()).toMatchObject({delivered:1});
    const card=JSON.stringify(transport.updateLifecycleCard.mock.calls[1][1]);expect(card).toContain('prepare_receipt_photo');expect(card).toContain('prepare_invoice');
  });
  it.each(['pending','ready','failed'] as const)('renders only the authorized recipient receipt feedback for %s',async state=>{
    const view={kind:'receipt',recordId:'rec_one'};
    store.listPendingLifecycleDeliveries.mockResolvedValue([{identity,desiredRevision:2,desiredPage:1,desiredView:view,status:'ready'}]);
    store.beginLifecycleDelivery.mockImplementation(async (_id:any,_now:any,_rev:any,_page:any,authorize:any)=>{authorize(batch);return {action:'update',entry:{...structuredClone(outbox),pendingView:view}};});
    grant.project.mockReturnValue({items:[{recordId:'rec_one',status:'下单完成（待签收）',stages:[{stage:'receipt',fields:[]}]}],viewer:{kind:'participant',grants:[{recordId:'rec_one',visibleStages:['receipt'],allowedActions:['receive']}]},formPresentations:{rec_one:{receipt:{signerOpenId:'ou_person',purchaseMethod:'需求自采'}}}});
    store.getLifecycleOutbox.mockResolvedValue({replica:{state:'delivered',messageId:'om_current'}});
    const feedback={taskId:'task_1',executionRecordId:'rec_one',recipientOpenId:'ou_person',cardMessageId:'om_current',materialType:'receipt_photo',state,...(state==='ready'?{intentId:'intent_1',intentExpiresAtMs:now+60000}:{})};
    store.getLifecycleReceiptPreparation=jest.fn(async(_identity:any,_message:any,authorize:any)=>{authorize(batch,{executionRecordId:'rec_one'});return feedback;});
    const worker=new PurchaseLifecycleDeliveryService(store,{prepare:async()=>grant},transport,()=>now,()=> 'https://portal.example/',()=>true);
    expect(await worker.run()).toMatchObject({delivered:1});const card=JSON.stringify(transport.updateLifecycleCard.mock.calls[0][1]);
    expect(card).toContain(state==='ready'?'请在当前私聊发送签收照片图片':state==='pending'?'正在核验签收照片上传权限':'上传权限核验失败');
    if(state!=='ready')expect(card).not.toContain('请在当前私聊发送签收照片图片');
    expect(store.getLifecycleReceiptPreparation).toHaveBeenCalledTimes(2);
    expect(store.markLifecycleDeliveryDispatched).toHaveBeenCalledWith(identity,'attempt',expect.any(Function),feedback);
  });
  it('does not dispatch stale or expired ready feedback',async()=>{
    const view={kind:'receipt',recordId:'rec_one'};
    store.listPendingLifecycleDeliveries.mockResolvedValue([{identity,desiredRevision:2,desiredPage:1,desiredView:view,status:'ready'}]);
    store.beginLifecycleDelivery.mockImplementation(async (_id:any,_now:any,_rev:any,_page:any,authorize:any)=>{authorize(batch);return {action:'update',entry:{...structuredClone(outbox),pendingView:view}};});
    grant.project.mockReturnValue({items:[{recordId:'rec_one',status:'下单完成（待签收）',stages:[{stage:'receipt',fields:[]}]}],viewer:{kind:'participant',grants:[{recordId:'rec_one',visibleStages:['receipt'],allowedActions:['receive']}]},formPresentations:{rec_one:{receipt:{signerOpenId:'ou_person',purchaseMethod:'需求自采'}}}});
    store.getLifecycleOutbox.mockResolvedValue({replica:{state:'delivered',messageId:'om_current'}});
    const feedback={taskId:'task_1',executionRecordId:'rec_one',recipientOpenId:'ou_person',cardMessageId:'om_current',materialType:'receipt_photo',state:'ready',intentId:'intent_1',intentExpiresAtMs:now+60000};
    store.getLifecycleReceiptPreparation=jest.fn().mockResolvedValueOnce(feedback).mockResolvedValueOnce({...feedback,state:'failed'});
    const worker=new PurchaseLifecycleDeliveryService(store,{prepare:async()=>grant},transport,()=>now,()=> 'https://portal.example/',()=>true);
    expect(await worker.run()).toMatchObject({rejectedBeforeDispatch:1});expect(store.abortPreparedLifecycleDelivery).toHaveBeenCalled();expect(transport.updateLifecycleCard).not.toHaveBeenCalled();
  });
  it('rejects revoked actions and changed authorization without sending', async () => {
    const permitted = grant.project();
    grant.project.mockImplementation(() => ({ items: [{ recordId: 'rec_one', status: '审批通过（待下单）', stages: [{ stage: 'ordering', fields: [] }] }],
      viewer: { kind: 'participant', grants: [{ recordId: 'rec_one', visibleStages: ['ordering'], allowedActions: [] }] }, formPresentations: { rec_one: { order: {} } } }));
    expect(await make().run()).toMatchObject({ pageReplanned: 1 });
    expect(store.resetLifecycleDesiredViewToList).toHaveBeenCalledTimes(1);
    expect(store.issuePreparedLifecycleForm).not.toHaveBeenCalled();
    expect(transport.updateLifecycleCard).not.toHaveBeenCalled();
    grant.project.mockReturnValue(permitted);
    grant.authorizationFingerprint.mockReturnValueOnce('a'.repeat(64)).mockReturnValueOnce('b'.repeat(64));
    expect(await make().run()).toMatchObject({ rejectedBeforeDispatch: 1 });
    expect(store.abortPreparedLifecycleDelivery).toHaveBeenCalled();
    expect(transport.updateLifecycleCard).not.toHaveBeenCalled();
  });
  it('does not send a form to an unconfirmed new continuation message', async () => {
    store.beginLifecycleDelivery.mockImplementationOnce(async (_id: any, _now: any, _rev: any, _page: any, authorize: any) => {
      authorize(batch); return { action: 'send', entry: { ...structuredClone(outbox), replica: { ...outbox.replica, state: 'send_unknown' } } };
    });
    expect(await make().run()).toMatchObject({ rejectedBeforeDispatch: 1 });
    expect(store.issuePreparedLifecycleForm).not.toHaveBeenCalled();
    expect(transport.sendLifecycleCard).not.toHaveBeenCalled();
  });
  it('sends a list continuation when the locked store safely downgrades an expiring form view', async () => {
    store.beginLifecycleDelivery.mockImplementationOnce(async (_id: any, _now: any, _rev: any, _page: any, authorize: any) => {
      authorize(batch); return { action: 'send', entry: { ...structuredClone(outbox), pendingView: { kind: 'list' },
        replica: { ...outbox.replica, state: 'send_unknown', generation: 2, messageId: '', uuid: 'renewal-uuid' } } };
    });
    transport.sendLifecycleCard.mockResolvedValueOnce({ source: 'feishu_message_readback', uuid: 'renewal-uuid', messageId: 'om_new', sentAtMs: now });
    expect(await make().run()).toMatchObject({ delivered: 1 });
    expect(store.issuePreparedLifecycleForm).not.toHaveBeenCalled();
    const card = JSON.stringify(transport.sendLifecycleCard.mock.calls[0][1]);
    expect(card).toContain('采购全流程 · 延续卡');
    expect(card).toContain('请在延续卡重新打开表单');
    expect(card).not.toContain('purchase_lifecycle_form');
  });
});
