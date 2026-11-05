jest.mock('../../server/common/feishu-card-copy/transport', () => ({ isReadonlyCopyCallback: () => false, observeCardCallbackResult: async () => {} }));
jest.mock('../../server/common/hotfix-runtime-activation', () => ({ currentHotfixActivation: () => ({ isAcceptingNewWork: () => true }) }));
import { ForbiddenException } from '@nestjs/common';
import { FeishuCardActionRouter } from '../../server/modules/purchase-inventory/feishu-card-action.router';
import { PurchaseWorkflowCallbackController } from '../../server/modules/purchase-inventory/purchase-workflow-callback.controller';

describe('purchase lifecycle page callback transports', () => {
  const original = { ...process.env };
  const value = { version: 5, workflowType: 'purchase_lifecycle_page', action: 'page', approvalBatchId: 'purchase-batch-123', flowVersion: 'lifecycle_v1', cardRevision: 3, page: 2 };
  const ws = () => ({ schema: '2.0', event_type: 'card.action.trigger', operator: { open_id: 'ou_manager' }, context: { open_message_id: 'om_message' }, action: { tag: 'button', value } });
  const http = () => ({ headers: {}, rawBody: Buffer.from(JSON.stringify({ schema: '2.0', header: { event_id: 'evt_http', event_type: 'card.action.trigger', token: 'synthetic-token' }, event: ws() })) });
  let manager: any;
  beforeEach(() => {
    process.env = { ...original, FEISHU_APP_ID: 'cli_synthetic', FEISHU_CARD_VERIFICATION_TOKEN: 'synthetic-token',
      PURCHASE_MANAGER_APPROVAL_CARD_ENABLED: 'true', PURCHASE_MANAGER_APPROVER_OPEN_ID: 'ou_manager', PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'false' };
    manager = { isEnabled: () => true, handleLifecyclePage: jest.fn().mockResolvedValue({ queued: true }), handleLifecycleOpen: jest.fn().mockResolvedValue({ queued: true }), handleLifecycleForm: jest.fn().mockResolvedValue({ claimed: true, card: { schema: '2.0', body: { elements: [] } } }), handleManagerBatchCardAction: jest.fn().mockResolvedValue({ schema: '2.0', body: { elements: [] } }), runAcceptedTasks: jest.fn().mockResolvedValue({}) };
  });
  afterEach(() => { process.env = { ...original }; });
  const router = () => new FeishuCardActionRouter({ isEnabled: () => false } as any, { isEnabled: () => false } as any,
    { isEnabled: () => false } as any, {} as any, manager, { isEnabled: () => false } as any, { isEnabled: () => false } as any);
  const controller = () => new PurchaseWorkflowCallbackController({} as any, manager);
  it('accepts v5 from WS and HTTP with a toast only and no synchronous card patch', async () => {
    expect(await router().handle(ws())).toEqual({ toast: { type: 'info', content: '正在切换页面' } });
    expect(await controller().handlePurchaseCardCallback(http() as any)).toEqual({ toast: { type: 'info', content: '正在切换页面' } });
    expect(manager.handleLifecyclePage).toHaveBeenCalledTimes(2);
    expect(manager.handleLifecyclePage.mock.calls[0][0]).toMatchObject({ kind: 'lifecycle_page_action', approvalBatchId: value.approvalBatchId, page: 2, lifecycle: { cardRevision: 3 } });
  });
  it('rejects authorization failures in both transports without producing a card', async () => {
    manager.handleLifecyclePage.mockRejectedValue(new ForbiddenException('无权访问'));
    expect(await router().handle(ws())).toMatchObject({ toast: { type: 'error' } });
    await expect(controller().handlePurchaseCardCallback(http() as any)).rejects.toThrow('无权访问');
    expect(manager.handleManagerBatchCardAction).not.toHaveBeenCalled();
  });
  it('keeps the original version 3 manager card route', async () => {
    const old = ws(); old.action.value = { version: 3, action: 'approve_pending_comprehensive', approvalBatchId: value.approvalBatchId } as any;
    expect(await router().handle(old)).toMatchObject({ toast: { type: 'info' }, card: { type: 'raw' } });
    const request = { headers: {}, rawBody: Buffer.from(JSON.stringify({ schema: '2.0', header: { event_id: 'evt_legacy', event_type: 'card.action.trigger', token: 'synthetic-token' }, event: old })) };
    expect(await controller().handlePurchaseCardCallback(request as any)).toMatchObject({ toast: { type: 'info' }, card: { type: 'raw' } });
    expect(manager.handleLifecyclePage).not.toHaveBeenCalled();
    expect(manager.handleManagerBatchCardAction).toHaveBeenCalledTimes(2);
  });
  it('routes lifecycle form submissions over both transports and starts accepted work once per claim', async () => {
    const form = ws(); form.action = { tag: 'button', name: `lcf1:${Buffer.alloc(32, 1).toString('base64url')}`, form_value: { rejection_reason: '测试' } } as any;
    const request = { headers: {}, rawBody: Buffer.from(JSON.stringify({ schema: '2.0', header: { event_id: 'evt_form', event_type: 'card.action.trigger', token: 'synthetic-token' }, event: form })) };
    expect(await router().handle(form)).toMatchObject({ toast: { type: 'info' }, card: { type: 'raw' } });
    expect(await controller().handlePurchaseCardCallback(request as any)).toMatchObject({ toast: { type: 'info' }, card: { type: 'raw' } });
    expect(manager.handleLifecycleForm).toHaveBeenCalledTimes(2);
    expect(manager.handleLifecycleForm.mock.calls[0][0]).toMatchObject({ kind: 'lifecycle_form_action', messageId: 'om_message', operatorOpenId: 'ou_manager' });
    expect(manager.runAcceptedTasks).toHaveBeenCalledTimes(2);
    manager.handleLifecycleForm.mockResolvedValueOnce({ claimed: false, card: { schema: '2.0', body: { elements: [] } } });
    expect(await router().handle(form)).toMatchObject({ toast: { type: 'warning' } });
    expect(manager.runAcceptedTasks).toHaveBeenCalledTimes(2);
  });
  it('does not return a processing card or run work when lifecycle form authorization is denied', async () => {
    manager.handleLifecycleForm.mockRejectedValue(new ForbiddenException('无权访问'));
    const form = ws(); form.action = { tag: 'button', name: `lcf1:${Buffer.alloc(32, 1).toString('base64url')}`, form_value: { rejection_reason: '测试' } } as any;
    const request = { headers: {}, rawBody: Buffer.from(JSON.stringify({ schema: '2.0', header: { event_id: 'evt_form_denied', event_type: 'card.action.trigger', token: 'synthetic-token' }, event: form })) };
    const result = await router().handle(form);
    expect(result).toMatchObject({ toast: { type: 'error' } });
    expect(result).not.toHaveProperty('card');
    await expect(controller().handlePurchaseCardCallback(request as any)).rejects.toThrow('无权访问');
    expect(manager.runAcceptedTasks).not.toHaveBeenCalled();
  });
  it.each([
    { version: 3, action: 'open_item_reject', approvalBatchId: value.approvalBatchId, executionRecordId: 'rec_one', flowVersion: 'lifecycle_v1', cardRevision: 3 },
    { version: 4, workflowType: 'purchase_batch_fulfillment', role: 'purchaser', action: 'open_order', approvalBatchId: value.approvalBatchId, executionRecordId: 'rec_one', flowVersion: 'lifecycle_v1', cardRevision: 3 },
    { version: 4, workflowType: 'purchase_batch_fulfillment', role: 'requester', action: 'open_receipt', approvalBatchId: value.approvalBatchId, executionRecordId: 'rec_one', flowVersion: 'lifecycle_v1', cardRevision: 3 },
  ])('queues lifecycle form navigation without returning a legacy card: $action', async action => {
    const event = ws(); event.action.value = action as any;
    const request = { headers: {}, rawBody: Buffer.from(JSON.stringify({ schema: '2.0', header: { event_id: 'evt_open', event_type: 'card.action.trigger', token: 'synthetic-token' }, event })) };
    const a = await router().handle(event), b = await controller().handlePurchaseCardCallback(request as any);
    expect(a).toMatchObject({ toast: { type: 'info' } }); expect(a).not.toHaveProperty('card');
    expect(b).toMatchObject({ toast: { type: 'info' } }); expect(b).not.toHaveProperty('card');
    expect(manager.handleLifecycleOpen).toHaveBeenCalledTimes(2);
    expect(manager.handleManagerBatchCardAction).not.toHaveBeenCalled();
  });
  it('starts accepted worker for a lifecycle individual approval in both transports', async () => {
    const event = ws(); event.action.value = { version: 3, action: 'approve_item_comprehensive', approvalBatchId: value.approvalBatchId,
      executionRecordId: 'rec_one', flowVersion: 'lifecycle_v1', cardRevision: 3 } as any;
    const request = { headers: {}, rawBody: Buffer.from(JSON.stringify({ schema: '2.0', header: { event_id: 'evt_approve', event_type: 'card.action.trigger', token: 'synthetic-token' }, event })) };
    expect(await router().handle(event)).toMatchObject({ toast: { type: 'info' } });
    expect(await controller().handlePurchaseCardCallback(request as any)).toMatchObject({ toast: { type: 'info' } });
    expect(manager.runAcceptedTasks).toHaveBeenCalledTimes(2);
  });
});
