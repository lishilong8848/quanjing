import { BadRequestException } from '@nestjs/common';
import { FeishuCardActionRouter as ActualFeishuCardActionRouter } from './feishu-card-action.router';
import { withSyntheticBusinessIdentity } from '../../../test/unit/synthetic-business-identity.fixture';
import { currentHotfixActivation } from '../../common/hotfix-runtime-activation';
const FeishuCardActionRouter = withSyntheticBusinessIdentity(ActualFeishuCardActionRouter, 8);
type FeishuCardActionRouter = ActualFeishuCardActionRouter;

const originalEnv = { ...process.env };

function resolvedCard(type: string) {
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: type } },
    body: { elements: [] },
  };
}

function rawCardUpdate(type: string) {
  return { type: 'raw', data: resolvedCard(type) };
}

function overtimePayload(action: 'approve' | 'reject' = 'approve') {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    event_id: 'evt_overtime_ws_01',
    operator: { open_id: 'ou_overtime_approver' },
    context: { open_message_id: 'om_overtime_ws_01' },
    action: {
      tag: 'button',
      value: { version: 1, action, recordId: 'rec_overtime_ws_01' },
    },
  };
}

function leavePayload(action: 'approve' | 'reject' = 'approve') {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    event_id: 'evt_leave_ws_01',
    operator: { open_id: 'ou_leave_approver' },
    context: { open_message_id: 'om_leave_ws_01' },
    action: {
      tag: 'button',
      value: {
        version: 1,
        workflowType: 'leave',
        action,
        recordId: 'rec_leave_ws_01',
        applicationKey: 'leave:rec_leave_ws_01',
        stageKey: 'supervisor',
        stageVersion: 1,
      },
    },
  };
}

function leaveSubstituteFormPayload() {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    event_id: 'evt_leave_form_ws_01',
    operator: { open_id: 'ou_leave_approver' },
    context: { open_message_id: 'om_leave_form_ws_01' },
    action: {
      tag: 'button',
      name: 'leave_approve_submit:rec_leave_ws_01:1',
      form_value: {
        leave_substitute_person_record_id: 'rec_leave_substitute',
      },
    },
  };
}

function leaveLongWhiteNoSubstitutePayload() {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    event_id: 'evt_leave_long_white_ws_01',
    operator: { open_id: 'ou_leave_approver' },
    context: { open_message_id: 'om_leave_long_white_ws_01' },
    action: {
      tag: 'button',
      name: 'leave_substitute_decision_submit:rec_leave_ws_01:supervisor:1',
      form_value: {
        leave_substitute_requirement: 'not_required',
      },
    },
  };
}

function leaveRequiredSubstituteDecisionFormPayload() {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    event_id: 'evt_leave_required_decision_ws_01',
    operator: { open_id: 'ou_leave_approver' },
    context: { open_message_id: 'om_leave_long_white_ws_01' },
    action: {
      tag: 'button',
      name: 'leave_substitute_decision_submit:rec_leave_ws_01:supervisor:1',
      form_value: {
        leave_substitute_requirement: 'required',
      },
    },
  };
}

function leaveSubstituteDecisionPayload(option: 'required' | 'not_required') {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    operator: { open_id: 'ou_leave_approver' },
    context: { open_message_id: 'om_leave_long_white_ws_01' },
    action: {
      tag: 'select_static',
      option,
      value: {
        version: 1,
        workflowType: 'leave',
        action: 'select_substitute_requirement',
        recordId: 'rec_leave_ws_01',
        applicationKey: 'leave:rec_leave_ws_01',
        stageKey: 'supervisor',
        stageVersion: 1,
      },
    },
  };
}

function leaveRejectFormPayload() {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    operator: { open_id: 'ou_leave_approver' },
    context: { open_message_id: 'om_leave_reject_ws_01' },
    action: {
      tag: 'button',
      name: 'leave_reject_submit:rec_leave_ws_01:supervisor:1',
      form_value: { leave_rejection_reason: '当日保障力量不足' },
    },
  };
}

function leaveSubstituteUpdatePayload() {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    operator: { open_id: 'ou_leave_approver' },
    context: { open_message_id: 'om_leave_adjustment_1' },
    action: {
      tag: 'button',
      name: 'leave_substitute_update_submit:rec_leave_ws_01:2',
      form_value: {
        leave_substitute_person_record_id: 'rec_leave_substitute_new',
      },
    },
  };
}

function purchaseLegacyPayload() {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    event_id: 'evt_purchase_ws_01',
    operator: { open_id: 'ou_purchase_approver' },
    action: {
      tag: 'button',
      value: {
        version: 1,
        action: 'approve',
        executionRecordId: 'rec_purchase_ws_01',
      },
    },
  };
}

function purchaseManagerPayload() {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    event_id: 'evt_manager_ws_01',
    operator: { open_id: 'ou_purchase_manager' },
    context: { open_message_id: 'om_manager_ws_01' },
    action: {
      tag: 'button',
      value: {
        version: 2,
        action: 'open_reject',
        executionRecordId: 'rec_manager_ws_01',
      },
    },
  };
}

function purchaseManagerBatchPayload() {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    event_id: 'evt_manager_batch_ws_01',
    operator: { open_id: 'ou_purchase_manager' },
    context: { open_message_id: 'om_manager_batch_ws_01' },
    action: {
      tag: 'button',
      value: {
        version: 3,
        action: 'approve_pending_comprehensive',
        approvalBatchId: 'purchase-application-task-1',
      },
    },
  };
}

function purchaseManagerBatchRejectFormPayload() {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    event_id: 'evt_manager_batch_reject_ws_01',
    operator: { open_id: 'ou_purchase_manager' },
    context: { open_message_id: 'om_manager_batch_ws_01' },
    action: {
      tag: 'button',
      name: 'purchase_batch_item_reject_submit',
      form_value: { rejection_reason: '测试驳回' },
    },
  };
}

function purchaseBatchReceiptOpenPayload() {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    event_id: 'evt_purchase_receipt_open_ws_01',
    token: 'c-receipt-ws-01',
    operator: { open_id: 'ou_purchase_requester' },
    context: { open_message_id: 'om_purchase_receipt_ws_01' },
    action: {
      tag: 'button',
      value: {
        version: 4,
        workflowType: 'purchase_batch_fulfillment',
        role: 'requester',
        action: 'open_receipt',
        approvalBatchId: 'purchase-application-task-1',
        executionRecordId: 'rec_purchase_receipt_01',
      },
    },
  };
}

function purchaseBatchReceiptSubmitPayload() {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    event_id: 'evt_purchase_receipt_submit_ws_01',
    operator: { open_id: 'ou_purchase_requester' },
    context: { open_message_id: 'om_purchase_receipt_ws_01' },
    action: {
      tag: 'button',
      name: 'purchase_batch_receipt_submit:purchase-application-task-1:rec_purchase_receipt_01',
      form_value: {
        signer_open_id: 'ou_receipt_signer',
        receipt_time: '2026-09-14 14:50',
        receipt_note: '数量与外观无误',
      },
    },
  };
}

function inventoryOutboundPayload(
  action: 'approve' | 'open_reject' | 'return_to_approval' = 'approve',
) {
  return {
    event_type: 'card.action.trigger',
    operator: { open_id: 'ou_inventory_approver' },
    context: { open_message_id: 'om_inventory_outbound_01' },
    action: {
      tag: 'button',
      value: {
        workflowType: 'inventory_outbound',
        action,
        recordId: 'rec_inventory_outbound_01',
        version: 1,
      },
    },
  };
}

function inventoryOutboundRejectPayload() {
  return {
    event_type: 'card.action.trigger',
    operator: { open_id: 'ou_inventory_approver' },
    context: { open_message_id: 'om_inventory_outbound_01' },
    action: {
      tag: 'button',
      name: 'inventory_outbound_reject_submit:rec_inventory_outbound_01:1',
      form_value: {
        inventory_outbound_rejection_reason: '库存需保留应急使用',
      },
    },
  };
}

describe('FeishuCardActionRouter', () => {
  let overtime: {
    isEnabled: jest.Mock;
    acceptApprovalAction: jest.Mock;
    runPendingTasks: jest.Mock;
  };
  let leave: {
    isEnabled: jest.Mock;
    acceptApprovalAction: jest.Mock;
    acceptSubstituteUpdateAction: jest.Mock;
    renderApprovalCardView: jest.Mock;
    patchApprovalCardView: jest.Mock;
    runPendingTasks: jest.Mock;
  };
  let purchaseWorkflow: { isEnabled: jest.Mock; acceptApprovalCardAction: jest.Mock };
  let purchaseStore: { claimCardAction: jest.Mock };
  let manager: {
    isEnabled: jest.Mock;
    handleManagerCardAction: jest.Mock;
    handleManagerBatchCardAction: jest.Mock;
    handlePurchaseBatchFulfillmentCardAction: jest.Mock;
    handlePurchaseReceiptImageMessage: jest.Mock;
    patchPurchaseBatchFulfillmentCardView: jest.Mock;
    runPendingTasks: jest.Mock;
    runAcceptedTasks: jest.Mock;
  };
  let anomaly: {
    isEnabled: jest.Mock;
    renderCardView: jest.Mock;
    patchCardView: jest.Mock;
    acceptTerminalAction: jest.Mock;
    runPendingTasks: jest.Mock;
  };
  let inventoryOutbound: {
    isEnabled: jest.Mock;
    handleCardAction: jest.Mock;
    runPending: jest.Mock;
  };

  beforeEach(async () => {
    const activation = currentHotfixActivation(); activation.completeBootstrap(); await activation.refresh();
    process.env = {
      ...originalEnv,
      PURCHASE_WORKFLOW_APPROVER_OPEN_IDS: 'ou_purchase_approver',
      PURCHASE_MANAGER_APPROVER_OPEN_ID: 'ou_purchase_manager',
    };
    overtime = {
      isEnabled: jest.fn(() => true),
      acceptApprovalAction: jest.fn().mockResolvedValue({
        claimed: true,
        card: resolvedCard('overtime-resolved'),
      }),
      runPendingTasks: jest.fn().mockResolvedValue({ processed: 1, failed: 0 }),
    };
    leave = {
      isEnabled: jest.fn(() => true),
      acceptApprovalAction: jest.fn().mockResolvedValue({
        claimed: true,
        card: resolvedCard('leave-resolved'),
      }),
      acceptSubstituteUpdateAction: jest.fn().mockResolvedValue({
        claimed: true,
        card: resolvedCard('leave-substitute-updated'),
      }),
      renderApprovalCardView: jest
        .fn()
        .mockResolvedValue(resolvedCard('leave-substitute-decision')),
      patchApprovalCardView: jest.fn().mockResolvedValue(undefined),
      runPendingTasks: jest.fn().mockResolvedValue({ processed: 1, failed: 0 }),
    };
    purchaseWorkflow = { isEnabled: jest.fn(() => true), acceptApprovalCardAction: jest.fn(input => purchaseStore.claimCardAction(input)) };
    purchaseStore = {
      claimCardAction: jest.fn().mockResolvedValue({ claimed: true }),
    };
    manager = {
      isEnabled: jest.fn(() => true),
      handleManagerCardAction: jest
        .fn()
        .mockResolvedValue(resolvedCard('manager-card')),
      handleManagerBatchCardAction: jest
        .fn()
        .mockResolvedValue(resolvedCard('manager-batch-card')),
      handlePurchaseBatchFulfillmentCardAction: jest.fn().mockResolvedValue({
        claimed: false,
        card: resolvedCard('purchase-receipt-form'),
      }),
      handlePurchaseReceiptImageMessage: jest.fn().mockResolvedValue({
        accepted: true,
        enqueued: true,
      }),
      patchPurchaseBatchFulfillmentCardView: jest
        .fn()
        .mockResolvedValue(undefined),
      runPendingTasks: jest.fn().mockResolvedValue({ processed: 1, failed: 0 }),
      runAcceptedTasks: jest.fn().mockResolvedValue({ processed: 1, failed: 0 }),
    };
    anomaly = {
      isEnabled: jest.fn(() => true),
      renderCardView: jest.fn().mockResolvedValue(resolvedCard('anomaly-form')),
      patchCardView: jest.fn().mockResolvedValue(undefined),
      acceptTerminalAction: jest.fn().mockResolvedValue({
        claimed: true,
        card: resolvedCard('anomaly-syncing'),
      }),
      runPendingTasks: jest.fn().mockResolvedValue({ processed: 1, failed: 0 }),
    };
    inventoryOutbound = {
      isEnabled: jest.fn(() => true),
      handleCardAction: jest.fn().mockResolvedValue({
        claimed: true,
        card: resolvedCard('inventory-outbound-syncing'),
      }),
      runPending: jest.fn().mockResolvedValue({ processed: 1, failed: 0 }),
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.useRealTimers();
  });

  function createRouter(threshold?: { isEnabled: jest.Mock; handleCardAction: jest.Mock }) {
    return new FeishuCardActionRouter(
      overtime as never,
      leave as never,
      purchaseWorkflow as never,
      purchaseStore as never,
      manager as never,
      anomaly as never,
      inventoryOutbound as never,
      threshold as never,
    );
  }

  it.each(['leave', 'substitute', 'overtime', 'inventory', 'purchase-approval', 'purchase-single', 'purchase-order', 'purchase-receipt', 'threshold', 'anomaly'])(
    'keeps one %s action running after the callback deadline and wakes its worker',
    async (workflow) => {
      jest.useFakeTimers();
      const threshold = { isEnabled: jest.fn(() => true), handleCardAction: jest.fn() };
      let payload: Record<string, unknown>;
      let accept: jest.Mock;
      let worker: jest.Mock | undefined;
      switch (workflow) {
        case 'leave':
          payload = leavePayload(); accept = leave.acceptApprovalAction; worker = leave.runPendingTasks; break;
        case 'substitute':
          payload = leaveSubstituteUpdatePayload(); accept = leave.acceptSubstituteUpdateAction; worker = leave.runPendingTasks; break;
        case 'overtime':
          payload = overtimePayload(); accept = overtime.acceptApprovalAction; worker = overtime.runPendingTasks; break;
        case 'inventory':
          payload = inventoryOutboundPayload('approve'); accept = inventoryOutbound.handleCardAction; worker = inventoryOutbound.runPending; break;
        case 'purchase-approval':
          payload = purchaseManagerBatchPayload(); accept = manager.handleManagerBatchCardAction; worker = manager.runAcceptedTasks; break;
        case 'purchase-single':
          payload = { ...purchaseManagerPayload(), action: { tag: 'button', value: { version: 2, action: 'choose_comprehensive', executionRecordId: 'rec_manager_ws_01' } } };
          accept = manager.handleManagerCardAction; worker = manager.runAcceptedTasks; break;
        case 'anomaly':
          payload = { event_type: 'card.action.trigger', event_id: 'evt_anomaly', operator: { open_id: 'ou_anomaly_operator' }, context: { open_message_id: 'om_anomaly' }, action: { tag: 'button', name: `today_operations_resolve_submit:${'e'.repeat(64)}:recAnomaly1`, form_value: { today_operations_treatment_measure: '已恢复' } } };
          accept = anomaly.acceptTerminalAction; worker = anomaly.runPendingTasks; break;
        case 'purchase-order':
          payload = {
            ...purchaseBatchReceiptSubmitPayload(),
            action: { tag: 'button', name: 'purchase_batch_order_submit:purchase-application-task-1:rec_purchase_receipt_01', form_value: { actual_quantity: '3', actual_amount: '838.35', order_note: '' } },
          };
          accept = manager.handlePurchaseBatchFulfillmentCardAction; worker = manager.runAcceptedTasks; break;
        case 'purchase-receipt':
          payload = purchaseBatchReceiptSubmitPayload(); accept = manager.handlePurchaseBatchFulfillmentCardAction; worker = manager.runAcceptedTasks; break;
        default:
          payload = { event_type: 'card.action.trigger', event_id: 'evt_threshold', operator: { open_id: 'ou_threshold' }, context: { open_message_id: 'om_threshold' }, action: { tag: 'button', value: { workflowType: 'threshold_adjustment', requestId: 'ta-00000000-0000-0000-0000-000000000001', role: 'building', action: 'approve' } } };
          accept = threshold.handleCardAction;
      }
      let finish!: (value: unknown) => void;
      accept.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
      const router = createRouter(threshold);
      const first = router.handle(payload);
      await jest.advanceTimersByTimeAsync(2501);
      await expect(first).resolves.toMatchObject({ toast: { type: 'warning', content: expect.stringContaining('请勿重复点击') } });
      expect(worker?.mock.calls.length || 0).toBe(0);

      const replay = router.handle({ ...payload, event_id: 'evt_second_click' });
      const card = resolvedCard('durably-accepted');
      finish(workflow === 'purchase-approval' || workflow === 'purchase-single' ? card : { claimed: true, card });
      await expect(replay).resolves.toMatchObject({ card: { type: 'raw', data: card } });
      expect(accept).toHaveBeenCalledTimes(1);
      if (worker) expect(worker).toHaveBeenCalledTimes(1);
    },
  );

  it('isolates simultaneous actors, messages and decisions while sharing only identical in-flight requests', async () => {
    let finish!: (value: unknown) => void;
    leave.acceptApprovalAction.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const router = createRouter();
    const payload = leavePayload();
    const first = router.handle(payload);
    const replay = router.handle({ ...payload, event_id: 'retry_same_action' });
    await Promise.resolve();
    expect(leave.acceptApprovalAction).toHaveBeenCalledTimes(1);
    finish({ claimed: true, card: resolvedCard('accepted') });
    await Promise.all([first, replay]);
    leave.acceptApprovalAction.mockResolvedValue({ claimed: false, card: resolvedCard('replayed') });
    await router.handle({ ...payload, operator: { open_id: 'ou_other_actor' } });
    await router.handle({ ...payload, context: { open_message_id: 'om_other_card' } });
    await router.handle(leavePayload('reject'));
    await router.handle(payload);
    expect(leave.acceptApprovalAction).toHaveBeenCalledTimes(5);
    expect(leave.runPendingTasks).toHaveBeenCalledTimes(1);
  });

  it('observes a late rejection, releases the in-flight request and allows a fresh retry', async () => {
    jest.useFakeTimers();
    let fail!: (error: Error) => void;
    leave.acceptApprovalAction.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const router = createRouter();
    const first = router.handle(leavePayload());
    await jest.advanceTimersByTimeAsync(2501);
    await expect(first).resolves.toMatchObject({ toast: { type: 'warning' } });
    fail(new Error('synthetic durable claim failed'));
    await jest.advanceTimersByTimeAsync(0);
    await expect(router.handle(leavePayload())).resolves.toMatchObject({ card: rawCardUpdate('leave-resolved') });
    expect(leave.acceptApprovalAction).toHaveBeenCalledTimes(2);
    expect(leave.runPendingTasks).toHaveBeenCalledTimes(1);
  });

  it('connects when any supported card workflow is enabled', () => {
    const router = createRouter();
    overtime.isEnabled.mockReturnValue(false);
    leave.isEnabled.mockReturnValue(false);
    purchaseWorkflow.isEnabled.mockReturnValue(false);

    expect(router.isAnyEnabled()).toBe(true);

    manager.isEnabled.mockReturnValue(false);
    anomaly.isEnabled.mockReturnValue(false);
    expect(router.isAnyEnabled()).toBe(true);

    inventoryOutbound.isEnabled.mockReturnValue(false);
    expect(router.isAnyEnabled()).toBe(false);
  });

  it('routes inventory outbound approval before generic record-id workflows', async () => {
    const payload = inventoryOutboundPayload('approve');

    await expect(createRouter().handle(payload)).resolves.toEqual({
      toast: { type: 'info', content: '审批操作已受理' },
      card: rawCardUpdate('inventory-outbound-syncing'),
    });
    expect(inventoryOutbound.handleCardAction).toHaveBeenCalledWith(payload);
    expect(inventoryOutbound.runPending).toHaveBeenCalledTimes(1);
    expect(overtime.acceptApprovalAction).not.toHaveBeenCalled();
    expect(purchaseStore.claimCardAction).not.toHaveBeenCalled();
  });

  it('routes the inventory outbound rejection form before generic purchase forms', async () => {
    const payload = inventoryOutboundRejectPayload();

    await expect(createRouter().handle(payload)).resolves.toEqual({
      toast: { type: 'info', content: '审批操作已受理' },
      card: rawCardUpdate('inventory-outbound-syncing'),
    });
    expect(inventoryOutbound.handleCardAction).toHaveBeenCalledWith(payload);
    expect(purchaseStore.claimCardAction).not.toHaveBeenCalled();
  });

  it('changes inventory outbound card view without scheduling background work', async () => {
    inventoryOutbound.handleCardAction.mockResolvedValueOnce({
      claimed: false,
      card: resolvedCard('inventory-outbound-approval'),
      toast: '已返回审批',
    });

    await expect(
      createRouter().handle(inventoryOutboundPayload('return_to_approval')),
    ).resolves.toEqual({
      toast: { type: 'info', content: '已返回审批' },
      card: rawCardUpdate('inventory-outbound-approval'),
    });
    expect(inventoryOutbound.runPending).not.toHaveBeenCalled();
  });

  it('routes the anomaly resolution form before generic purchase forms', async () => {
    const anomalyId = 'a'.repeat(64);
    const payload = {
      event_type: 'card.action.trigger',
      event_id: 'evt_anomaly_resolve',
      operator: { open_id: 'ou_anomaly_operator' },
      context: { open_message_id: 'om_anomaly_message' },
      action: {
        tag: 'button',
        name: `today_operations_resolve_submit:${anomalyId}:recAnomaly1`,
        form_value: {
          today_operations_treatment_measure: '已检查并恢复数据采集',
        },
      },
    };

    await expect(createRouter().handle(payload)).resolves.toEqual({
      toast: { type: 'info', content: '处理结果已受理' },
      card: rawCardUpdate('anomaly-syncing'),
    });
    expect(anomaly.acceptTerminalAction).toHaveBeenCalledWith(
      expect.objectContaining({
        anomalyEventId: anomalyId,
        terminal: 'resolved',
        treatmentMeasure: '已检查并恢复数据采集',
      }),
    );
    expect(purchaseStore.claimCardAction).not.toHaveBeenCalled();
  });

  it('patches the current anomaly message when opening the treatment form', async () => {
    const anomalyEventId = 'e'.repeat(64);
    const messageId = 'om_anomaly_message';
    const payload = {
      event_type: 'card.action.trigger',
      event_id: 'evt_anomaly_open',
      operator: { open_id: 'ou_anomaly_operator' },
      context: { open_message_id: messageId },
      action: {
        tag: 'button',
        value: {
          workflowType: 'today_operations_anomaly',
          version: 1,
          action: 'open_resolution',
          anomalyEventId,
          recordId: 'recAnomaly1',
        },
      },
    };

    await expect(createRouter().handle(payload)).resolves.toEqual({
      toast: { type: 'info', content: '请填写处理措施' },
      card: rawCardUpdate('anomaly-form'),
    });
    expect(anomaly.renderCardView).toHaveBeenCalledWith(
      expect.objectContaining({ anomalyEventId, messageId }),
    );
    expect(anomaly.patchCardView).toHaveBeenCalledWith(
      messageId,
      resolvedCard('anomaly-form'),
    );
  });

  it('routes overtime approval without touching purchase workflows', async () => {
    await expect(createRouter().handle(overtimePayload())).resolves.toEqual({
      toast: { type: 'info', content: '审批操作已受理' },
      card: rawCardUpdate('overtime-resolved'),
    });
    expect(overtime.acceptApprovalAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actorOpenId: 'ou_overtime_approver',
        messageId: 'om_overtime_ws_01',
        recordId: 'rec_overtime_ws_01',
        action: 'approve',
        eventId: expect.stringMatching(/^ws_[a-f0-9]{64}$/u),
      }),
    );
    expect(purchaseStore.claimCardAction).not.toHaveBeenCalled();
    expect(manager.handleManagerCardAction).not.toHaveBeenCalled();
  });

  it('routes a leave card by its explicit workflow type before legacy record identifiers', async () => {
    await expect(createRouter().handle(leavePayload())).resolves.toEqual({
      toast: { type: 'info', content: '审批操作已受理' },
      card: rawCardUpdate('leave-resolved'),
    });
    expect(leave.acceptApprovalAction).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: 'rec_leave_ws_01',
        actorOpenId: 'ou_leave_approver',
        messageId: 'om_leave_ws_01',
        stageKey: 'supervisor',
        stageVersion: 1,
        action: 'approve',
        eventId: expect.stringMatching(/^ws_leave_[a-f0-9]{64}$/u),
      }),
    );
    expect(overtime.acceptApprovalAction).not.toHaveBeenCalled();
  });

  it('routes a leave personnel-selector form before generic purchase forms', async () => {
    await expect(
      createRouter().handle(leaveSubstituteFormPayload()),
    ).resolves.toEqual({
      toast: { type: 'info', content: '审批操作已受理' },
      card: rawCardUpdate('leave-resolved'),
    });
    expect(leave.acceptApprovalAction).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: 'rec_leave_ws_01',
        actorOpenId: 'ou_leave_approver',
        messageId: 'om_leave_form_ws_01',
        stageKey: 'supervisor',
        stageVersion: 1,
        action: 'approve',
        substitutePersonRecordId: 'rec_leave_substitute',
        eventId: expect.stringMatching(/^ws_leave_[a-f0-9]{64}$/u),
      }),
    );
    expect(purchaseStore.claimCardAction).not.toHaveBeenCalled();
    expect(manager.handleManagerCardAction).not.toHaveBeenCalled();
    expect(leave.runPendingTasks).toHaveBeenCalledTimes(1);
  });

  it('passes a long-white no-substitute decision through to the workflow', async () => {
    await expect(
      createRouter().handle(leaveLongWhiteNoSubstitutePayload()),
    ).resolves.toEqual({
      toast: { type: 'info', content: '审批操作已受理' },
      card: rawCardUpdate('leave-resolved'),
    });
    expect(leave.acceptApprovalAction).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: 'rec_leave_ws_01',
        actorOpenId: 'ou_leave_approver',
        messageId: 'om_leave_long_white_ws_01',
        stageKey: 'supervisor',
        stageVersion: 1,
        action: 'approve',
        substituteRequired: false,
      }),
    );
  });

  it('opens the substitute selectors after submitting a required decision', async () => {
    const payload = leaveRequiredSubstituteDecisionFormPayload();
    await expect(
      createRouter().handle(payload),
    ).resolves.toEqual({
      toast: { type: 'info', content: '请完成替班安排' },
    });
    expect(leave.renderApprovalCardView).toHaveBeenCalledWith({
      recordId: 'rec_leave_ws_01',
      stageKey: 'supervisor',
      stageVersion: 1,
      actorOpenId: 'ou_leave_approver',
      messageId: payload.context.open_message_id,
      view: 'substitute_required',
    });
    expect(leave.patchApprovalCardView).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: payload.context.open_message_id, view: 'substitute_required' }),
      resolvedCard('leave-substitute-decision'),
    );
    expect(leave.acceptApprovalAction).not.toHaveBeenCalled();
    expect(leave.runPendingTasks).not.toHaveBeenCalled();
  });

  it.each([
    ['required', 'substitute_required'],
    ['not_required', 'substitute_not_required'],
  ] as const)(
    'rebuilds the leave card immediately after choosing %s',
    async (option, view) => {
      const payload = leaveSubstituteDecisionPayload(option);
      await expect(
        createRouter().handle(payload),
      ).resolves.toEqual({
        toast: {
          type: 'info',
          content: option === 'required' ? '请完成替班安排' : '已选择无需替班',
        },
      });
      expect(leave.renderApprovalCardView).toHaveBeenCalledWith({
        recordId: 'rec_leave_ws_01',
        stageKey: 'supervisor',
        stageVersion: 1,
        actorOpenId: 'ou_leave_approver',
        messageId: payload.context.open_message_id,
        view,
      });
      expect(leave.patchApprovalCardView).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: payload.context.open_message_id, view }),
        resolvedCard('leave-substitute-decision'),
      );
      expect(leave.acceptApprovalAction).not.toHaveBeenCalled();
      expect(leave.runPendingTasks).not.toHaveBeenCalled();
    },
  );

  it('routes a leave rejection form with its required reason', async () => {
    await expect(
      createRouter().handle(leaveRejectFormPayload()),
    ).resolves.toEqual({
      toast: { type: 'info', content: '审批操作已受理' },
      card: rawCardUpdate('leave-resolved'),
    });
    expect(leave.acceptApprovalAction).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: 'rec_leave_ws_01',
        actorOpenId: 'ou_leave_approver',
        stageKey: 'supervisor',
        stageVersion: 1,
        action: 'reject',
        rejectionReason: '当日保障力量不足',
      }),
    );
  });

  it('routes a versioned leave substitute adjustment before generic forms', async () => {
    await expect(
      createRouter().handle(leaveSubstituteUpdatePayload()),
    ).resolves.toEqual({
      toast: { type: 'info', content: '审批操作已受理' },
      card: rawCardUpdate('leave-substitute-updated'),
    });
    expect(leave.acceptSubstituteUpdateAction).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: 'rec_leave_ws_01',
        actorOpenId: 'ou_leave_approver',
        messageId: 'om_leave_adjustment_1',
        expectedRevision: 2,
        substitutePersonRecordId: 'rec_leave_substitute_new',
        eventId: expect.stringMatching(/^ws_leave_[a-f0-9]{64}$/u),
      }),
    );
    expect(leave.acceptApprovalAction).not.toHaveBeenCalled();
    expect(purchaseStore.claimCardAction).not.toHaveBeenCalled();
    expect(leave.runPendingTasks).toHaveBeenCalledTimes(1);
  });

  it('returns a safe concrete reason when a substitute adjustment is rejected', async () => {
    leave.acceptSubstituteUpdateAction.mockRejectedValue(
      new BadRequestException('该替班人员当前不可用，请重新选择'),
    );

    await expect(
      createRouter().handle(leaveSubstituteUpdatePayload()),
    ).resolves.toEqual({
      toast: { type: 'error', content: '该替班人员当前不可用，请重新选择' },
    });
    expect(leave.runPendingTasks).not.toHaveBeenCalled();
  });

  it('routes legacy purchase approval with the existing approver allowlist', async () => {
    await expect(
      createRouter().handle(purchaseLegacyPayload()),
    ).resolves.toEqual({
      toast: { type: 'info', content: '审批操作已受理' },
    });
    expect(purchaseStore.claimCardAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actorOpenId: 'ou_purchase_approver',
        recordId: 'rec_purchase_ws_01',
        action: 'approve',
        eventId: expect.stringMatching(/^ws_[a-f0-9]{64}$/u),
      }),
    );
    expect(overtime.acceptApprovalAction).not.toHaveBeenCalled();
  });

  it('returns the manager card update unchanged', async () => {
    await expect(
      createRouter().handle(purchaseManagerPayload()),
    ).resolves.toEqual({
      toast: { type: 'info', content: '审批操作已受理' },
      card: rawCardUpdate('manager-card'),
    });
    expect(manager.handleManagerCardAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'manager_action',
        action: 'open_reject',
        operatorOpenId: 'ou_purchase_manager',
        messageId: 'om_manager_ws_01',
        executionRecordId: 'rec_manager_ws_01',
      }),
    );
  });

  it('routes one version 3 purchase batch action and starts durable processing', async () => {
    await expect(
      createRouter().handle(purchaseManagerBatchPayload()),
    ).resolves.toEqual({
      toast: { type: 'info', content: '审批操作已受理' },
      card: rawCardUpdate('manager-batch-card'),
    });
    expect(manager.handleManagerBatchCardAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'manager_batch_action',
        action: 'approve_pending_comprehensive',
        approvalBatchId: 'purchase-application-task-1',
        operatorOpenId: 'ou_purchase_manager',
        messageId: 'om_manager_batch_ws_01',
      }),
    );
    expect(manager.runAcceptedTasks).toHaveBeenCalledTimes(1);
    expect(manager.runPendingTasks).not.toHaveBeenCalled();
    expect(manager.handleManagerCardAction).not.toHaveBeenCalled();
  });

  it('routes the real purchase batch rejection form before reading a button value', async () => {
    await expect(
      createRouter().handle(purchaseManagerBatchRejectFormPayload()),
    ).resolves.toEqual({
      toast: { type: 'info', content: '审批操作已受理' },
      card: rawCardUpdate('manager-batch-card'),
    });
    expect(manager.handleManagerBatchCardAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'manager_batch_action',
        action: 'submit_item_reject',
        operatorOpenId: 'ou_purchase_manager',
        messageId: 'om_manager_batch_ws_01',
        rejectionReason: '测试驳回',
      }),
    );
    expect(manager.runAcceptedTasks).toHaveBeenCalledTimes(1);
    expect(manager.runPendingTasks).not.toHaveBeenCalled();
  });

  it('returns the claimed approval card while the fast worker is still syncing', async () => {
    let finish!: (value: unknown) => void;
    manager.runAcceptedTasks.mockImplementationOnce(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    try {
      await expect(createRouter().handle(purchaseManagerBatchPayload())).resolves.toEqual({
        toast: { type: 'info', content: '审批操作已受理' },
        card: rawCardUpdate('manager-batch-card'),
      });
      expect(manager.runAcceptedTasks).toHaveBeenCalledTimes(1);
      expect(manager.runPendingTasks).not.toHaveBeenCalled();
    } finally {
      finish?.({ processed: 1, failed: 0 });
    }
  });

  it('acknowledges receipt navigation before patching the editor with the callback token', async () => {
    await expect(
      createRouter().handle(purchaseBatchReceiptOpenPayload()),
    ).resolves.toEqual({
      toast: { type: 'info', content: '请填写签收信息' },
    });

    expect(
      manager.handlePurchaseBatchFulfillmentCardAction,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'purchase_batch_fulfillment_action',
        action: 'open_receipt',
        operatorOpenId: 'ou_purchase_requester',
        messageId: 'om_purchase_receipt_ws_01',
        approvalBatchId: 'purchase-application-task-1',
        executionRecordId: 'rec_purchase_receipt_01',
      }),
    );
    expect(manager.runPendingTasks).not.toHaveBeenCalled();
    expect(
      manager.patchPurchaseBatchFulfillmentCardView,
    ).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(manager.patchPurchaseBatchFulfillmentCardView).toHaveBeenCalledWith(
      'om_purchase_receipt_ws_01',
      resolvedCard('purchase-receipt-form'),
      'c-receipt-ws-01',
    );
  });

  it('returns the syncing card immediately for a claimed receipt submission', async () => {
    manager.handlePurchaseBatchFulfillmentCardAction.mockResolvedValueOnce({
      claimed: true,
      card: resolvedCard('purchase-receipt-syncing'),
    });

    await expect(
      createRouter().handle(purchaseBatchReceiptSubmitPayload()),
    ).resolves.toEqual({
      toast: { type: 'info', content: '操作已受理，正在后台同步' },
      card: rawCardUpdate('purchase-receipt-syncing'),
    });

    expect(
      manager.patchPurchaseBatchFulfillmentCardView,
    ).not.toHaveBeenCalled();
    expect(manager.runAcceptedTasks).toHaveBeenCalledTimes(1);
  });

  it('routes a requester image message into the receipt attachment worker', async () => {
    const payload = {
      schema: '2.0',
      event_type: 'im.message.receive_v1',
      event_id: 'evt_receipt_image_01',
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_purchase_requester' },
      },
      message: {
        message_id: 'om_receipt_image_01',
        chat_id: 'oc_requester_direct',
        chat_type: 'p2p',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_v3_receipt_01' }),
      },
    };

    await expect(
      createRouter().handleMessage(payload),
    ).resolves.toBeUndefined();
    expect(manager.handlePurchaseReceiptImageMessage).toHaveBeenCalledWith(
      payload,
    );
    expect(manager.runPendingTasks).toHaveBeenCalledTimes(1);
  });

  it('rejects ambiguous business identifiers before calling a workflow', async () => {
    const payload = overtimePayload();
    Object.assign((payload.action as { value: object }).value, {
      executionRecordId: 'rec_purchase_ws_01',
    });

    await expect(createRouter().handle(payload)).resolves.toEqual({
      toast: { type: 'error', content: '审批处理失败，请稍后重试' },
    });
    expect(overtime.acceptApprovalAction).not.toHaveBeenCalled();
    expect(purchaseStore.claimCardAction).not.toHaveBeenCalled();
  });

  it('returns before the three-second callback deadline when a claim stalls', async () => {
    jest.useFakeTimers();
    overtime.acceptApprovalAction.mockReturnValue(new Promise(() => undefined));
    const response = createRouter().handle(overtimePayload());

    await jest.advanceTimersByTimeAsync(2_999);

    await expect(response).resolves.toEqual({
      toast: { type: 'warning', content: '处理时间较长，请勿重复点击，稍后查看卡片状态' },
    });
  });

  it('does not accept a disabled workflow even when its payload is valid', async () => {
    purchaseWorkflow.isEnabled.mockReturnValue(false);

    await expect(
      createRouter().handle(purchaseLegacyPayload()),
    ).resolves.toEqual({
      toast: { type: 'error', content: '审批处理失败，请稍后重试' },
    });
    expect(purchaseStore.claimCardAction).not.toHaveBeenCalled();
  });
});
