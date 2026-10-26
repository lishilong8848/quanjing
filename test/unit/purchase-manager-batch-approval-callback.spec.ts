import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { purchaseBatchFulfillmentSubmitName } from '../../server/modules/purchase-inventory/purchase-batch-fulfillment-card';
import {
  parsePurchaseLongConnectionCardAction,
  type PurchaseCardCallbackConfig,
} from '../../server/modules/purchase-inventory/purchase-workflow-callback';

const config: PurchaseCardCallbackConfig = {
  verificationToken: 'long_connection',
  encryptKey: '',
  legacyApproverOpenIds: [],
  managerApproverOpenId: 'ou_manager_01',
};

function event(action: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    event_id: 'evt_batch_01',
    operator: { open_id: 'ou_manager_01' },
    action,
    context: { open_message_id: 'om_batch_card_01' },
  };
}

function fulfillmentEvent(
  action: Record<string, unknown>,
  operatorOpenId = 'ou_purchase_admin',
): Record<string, unknown> {
  return {
    ...event(action),
    token: 'c-fulfillment-update-01',
    operator: { open_id: operatorOpenId },
    context: { open_message_id: 'om_purchase_batch_01' },
  };
}

describe('purchase manager batch approval callback', () => {
  it('authorizes either configured manager and rejects unrelated operators', () => {
    const payload = event({ tag: 'button', value: { version: 3, action: 'approve_pending_comprehensive', approvalBatchId: 'purchase-application-task-1' } });
    const multiple = { ...config, managerApproverOpenIds: ['ou_manager_01', 'ou_manager_02'] };
    expect(parsePurchaseLongConnectionCardAction({ ...payload, operator: { open_id: 'ou_manager_02' } }, multiple)).toMatchObject({ operatorOpenId: 'ou_manager_02', kind: 'manager_batch_action' });
    expect(() => parsePurchaseLongConnectionCardAction({ ...payload, operator: { open_id: 'ou_other' } }, multiple)).toThrow();
    expect(() => parsePurchaseLongConnectionCardAction(payload, { ...multiple, managerApproverOpenIds: ['invalid'] })).toThrow(BadRequestException);
  });

  it.each([
    ['approve_pending_comprehensive', undefined],
    ['approve_pending_building_self', undefined],
    ['cancel_item_reject', undefined],
    ['open_item_reject', 'rec-2'],
  ] as const)('parses Version 3 action %s', (action, executionRecordId) => {
    expect(
      parsePurchaseLongConnectionCardAction(
        event({
          tag: 'button',
          value: {
            version: 3,
            action,
            approvalBatchId: 'purchase-application-task-1',
            ...(executionRecordId ? { executionRecordId } : {}),
          },
        }),
        config,
      ),
    ).toMatchObject({
      kind: 'manager_batch_action',
      operatorOpenId: 'ou_manager_01',
      messageId: 'om_batch_card_01',
      action,
      approvalBatchId: 'purchase-application-task-1',
      ...(executionRecordId ? { executionRecordId } : {}),
    });
  });

  it('parses the fixed item reject form without trusting a record id', () => {
    expect(
      parsePurchaseLongConnectionCardAction(
        event({
          tag: 'button',
          name: 'purchase_batch_item_reject_submit',
          form_value: { rejection_reason: '  规格不符  ' },
        }),
        config,
      ),
    ).toMatchObject({
      kind: 'manager_batch_action',
      action: 'submit_item_reject',
      rejectionReason: '规格不符',
    });
  });

  it('rejects extra keys and a forged record id on reject submit', () => {
    expect(() =>
      parsePurchaseLongConnectionCardAction(
        event({
          tag: 'button',
          value: {
            version: 3,
            action: 'approve_pending_comprehensive',
            approvalBatchId: 'purchase-application-task-1',
            unexpected: true,
          },
        }),
        config,
      ),
    ).toThrow(BadRequestException);

    expect(() =>
      parsePurchaseLongConnectionCardAction(
        event({
          tag: 'button',
          name: 'purchase_batch_item_reject_submit',
          form_value: {
            rejection_reason: '规格不符',
            executionRecordId: 'rec-forged',
          },
        }),
        config,
      ),
    ).toThrow(BadRequestException);
  });

  it('parses purchaser and requester actions without requiring manager identity', () => {
    expect(
      parsePurchaseLongConnectionCardAction(
        fulfillmentEvent({
          tag: 'button',
          value: {
            version: 4,
            workflowType: 'purchase_batch_fulfillment',
            role: 'purchaser',
            action: 'open_order',
            approvalBatchId: 'purchase-application-task-1',
            executionRecordId: 'rec-1',
          },
        }),
        config,
      ),
    ).toMatchObject({
      kind: 'purchase_batch_fulfillment_action',
      operatorOpenId: 'ou_purchase_admin',
      action: 'open_order',
      updateToken: 'c-fulfillment-update-01',
      approvalBatchId: 'purchase-application-task-1',
      executionRecordId: 'rec-1',
    });

    expect(
      parsePurchaseLongConnectionCardAction(
        fulfillmentEvent(
          {
            tag: 'button',
            name: 'purchase_batch_receipt_submit:purchase-application-task-1:rec-1',
            form_value: {
              signer_open_id: 'ou_receipt_signer',
              receipt_time: '2026-09-08 21:14',
              receipt_note: '数量与外观无误',
            },
          },
          'ou_requester',
        ),
        config,
      ),
    ).toMatchObject({
      kind: 'purchase_batch_fulfillment_action',
      operatorOpenId: 'ou_requester',
      action: 'submit_receipt',
      signerOpenId: 'ou_receipt_signer',
      receiptTime: Date.parse('2026-09-08T21:14'),
      note: '数量与外观无误',
    });

    const fieldSuffix = createHash('sha256')
      .update('rec-1')
      .digest('hex')
      .slice(0, 16);
    expect(
      parsePurchaseLongConnectionCardAction(
        fulfillmentEvent(
          {
            tag: 'button',
            name: 'purchase_batch_receipt_submit:purchase-application-task-1:rec-1',
            form_value: {
              [`signer_open_id_${fieldSuffix}`]: 'ou_receipt_signer',
              [`receipt_time_${fieldSuffix}`]: '2026-09-08 21:14',
              [`receipt_note_${fieldSuffix}`]: '数量与外观无误',
            },
          },
          'ou_requester',
        ),
        config,
      ),
    ).toMatchObject({
      action: 'submit_receipt',
      executionRecordId: 'rec-1',
      signerOpenId: 'ou_receipt_signer',
      note: '数量与外观无误',
    });
    expect(
      parsePurchaseLongConnectionCardAction(
        fulfillmentEvent(
          {
            tag: 'button',
            name: 'purchase_batch_receipt_submit:purchase-application-task-1:rec-1',
            form_value: {
              [`signer_open_id_${fieldSuffix}`]: 'ou_receipt_signer',
              [`receipt_time_${fieldSuffix}`]: '2026-09-08 21:14',
            },
          },
          'ou_requester',
        ),
        config,
      ),
    ).toMatchObject({ action: 'submit_receipt', note: '' });

    expect(() =>
      parsePurchaseLongConnectionCardAction(
        fulfillmentEvent(
          {
            tag: 'button',
            name: 'purchase_batch_receipt_submit:purchase-application-task-1:rec-1',
            form_value: {
              signer_open_id: 'forged-user-name',
              receipt_time: '2026-09-08 21:14',
              receipt_note: '',
            },
          },
          'ou_requester',
        ),
        config,
      ),
    ).toThrow(BadRequestException);
  });

  it('parses the compact production receipt submit name', () => {
    const approvalBatchId =
      'purchase-application-6c2b09a7-b6d2-4290-b854-655f58f86144';
    const executionRecordId = 'recvvQzdiU7DOl';
    const fieldSuffix = createHash('sha256')
      .update(executionRecordId)
      .digest('hex')
      .slice(0, 16);
    const name = purchaseBatchFulfillmentSubmitName(
      'submit_receipt',
      approvalBatchId,
      executionRecordId,
    );

    expect(name.length).toBeLessThanOrEqual(100);
    expect(
      parsePurchaseLongConnectionCardAction(
        fulfillmentEvent(
          {
            tag: 'button',
            name,
            form_value: {
              [`signer_open_id_${fieldSuffix}`]: 'ou_receipt_signer',
              [`receipt_time_${fieldSuffix}`]: '2026-09-21 17:50',
              [`receipt_note_${fieldSuffix}`]: '数量与外观无误',
            },
          },
          'ou_requester',
        ),
        config,
      ),
    ).toMatchObject({
      kind: 'purchase_batch_fulfillment_action',
      action: 'submit_receipt',
      approvalBatchId,
      executionRecordId,
      signerOpenId: 'ou_receipt_signer',
      note: '数量与外观无误',
    });
  });

  it('includes the signer in a receipt fallback event id when upstream event_id is absent', () => {
    const receiptPayload = (signerOpenId: string) => {
      const payload = fulfillmentEvent(
        {
          tag: 'button',
          name: 'purchase_batch_receipt_submit:purchase-application-task-1:rec-1',
          form_value: {
            signer_open_id: signerOpenId,
            receipt_time: '2026-09-08 21:14',
            receipt_note: '数量与外观无误',
          },
        },
        'ou_requester',
      );
      delete payload.event_id;
      return payload;
    };

    const first = parsePurchaseLongConnectionCardAction(
      receiptPayload('ou_receipt_signer_1'),
      config,
    );
    const second = parsePurchaseLongConnectionCardAction(
      receiptPayload('ou_receipt_signer_2'),
      config,
    );

    expect(first.eventId).not.toBe(second.eventId);
  });

  it('rejects a malformed fulfillment navigation update token', () => {
    const payload = fulfillmentEvent({
      tag: 'button',
      value: {
        version: 4,
        workflowType: 'purchase_batch_fulfillment',
        role: 'requester',
        action: 'open_receipt',
        approvalBatchId: 'purchase-application-task-1',
        executionRecordId: 'rec-1',
      },
    });
    payload.token = 'invalid\nsecret';
    expect(() =>
      parsePurchaseLongConnectionCardAction(payload, config),
    ).toThrow('卡片更新票据格式无效');
  });

  it.each(['prepare_receipt_photo', 'prepare_invoice'] as const)(
    'parses the %s material upload intent action',
    (action) => {
      expect(
        parsePurchaseLongConnectionCardAction(
          fulfillmentEvent({
            tag: 'button',
            value: {
              version: 4,
              workflowType: 'purchase_batch_fulfillment',
              role: 'requester',
              action,
              approvalBatchId: 'purchase-application-task-1',
              executionRecordId: 'rec-1',
            },
          }),
          config,
        ),
      ).toMatchObject({
        kind: 'purchase_batch_fulfillment_action',
        action,
        approvalBatchId: 'purchase-application-task-1',
        executionRecordId: 'rec-1',
      });
    },
  );

  it('parses and validates the purchaser order form', () => {
    expect(
      parsePurchaseLongConnectionCardAction(
        fulfillmentEvent({
          tag: 'button',
          name: 'purchase_batch_order_submit:purchase-application-task-1:rec-1',
          form_value: {
            actual_quantity: '60',
            actual_amount: '828.46',
            order_note: '已下单',
          },
        }),
        config,
      ),
    ).toMatchObject({
      kind: 'purchase_batch_fulfillment_action',
      action: 'submit_order',
      actualQuantity: 60,
      actualAmount: 828.46,
      note: '已下单',
    });

    expect(() =>
      parsePurchaseLongConnectionCardAction(
        fulfillmentEvent({
          tag: 'button',
          name: 'purchase_batch_order_submit:purchase-application-task-1:rec-1',
          form_value: {
            actual_quantity: '0',
            actual_amount: '828.46',
            order_note: '',
          },
        }),
        config,
      ),
    ).toThrow(BadRequestException);

    expect(() =>
      parsePurchaseLongConnectionCardAction(
        fulfillmentEvent({
          tag: 'button',
          name: 'purchase_batch_order_submit:purchase-application-task-1:rec-1',
          form_value: {
            actual_quantity: '60',
            actual_amount: '   ',
            order_note: '',
          },
        }),
        config,
      ),
    ).toThrow(BadRequestException);
  });
});
